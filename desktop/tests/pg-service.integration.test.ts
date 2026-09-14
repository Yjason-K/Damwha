import * as fs from "fs";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processExists, psInfo, spawnPostmaster, stopOrphanPostmaster } from "../src/services/pg-handle";
import { pgBinaries, pgLayout, pgToolEnv } from "../src/services/pg-layout";
import { parseMarker } from "../src/services/pg-pairing";
import { parsePostmasterPid } from "../src/services/pg-pidfile";
import { embeddedPostgresSpec, type EmbeddedPostgresDeps } from "../src/services/pg-service";
import { runTool } from "../src/services/tool-runner";
import type { LaunchContext, LaunchResult, ServiceSpec } from "../src/services/types";

const BUNDLE = path.join(__dirname, "..", "build", "postgres");
const HAVE_BUNDLE = fs.existsSync(path.join(BUNDLE, "bin", "postgres"));

/**
 * Task 1의 실제 번들로 initdb·기동·판정표 2·종료·고아 인수를 돈다. 번들이 없으면(웹 흐름만 쓰는 체크아웃) 건너뛴다 —
 * 그때 이 테스트는 아무것도 증명하지 않으므로, packaged 검증(Task 13)이 같은 경로를 다시 밟는다.
 */
describe.skipIf(!HAVE_BUNDLE)("embedded postgres against the real bundle", () => {
  let ud: string;
  const started: LaunchResult[] = [];

  beforeAll(() => {
    // /tmp를 쓴다 — os.tmpdir()의 /var/folders/… 경로에 소켓 경로를 더하면 한도에 가깝다.
    ud = fs.mkdtempSync("/tmp/dwpgi-");
  });

  afterAll(async () => {
    for (const r of started) if (r.handle?.alive()) await r.handle.stop(10_000);
    fs.rmSync(ud, { recursive: true, force: true });
  });

  function deps(): EmbeddedPostgresDeps {
    const layout = pgLayout(ud);
    const binaries = pgBinaries(BUNDLE);
    return {
      binaries,
      layout,
      runTool,
      psInfo,
      stopOrphan: (pid) => stopOrphanPostmaster(pid, 30_000, 10_000),
      spawnPostmaster: (logFile) => spawnPostmaster({ binaries, layout, logFile, immediateGraceMs: 10_000 }),
      log: () => undefined,
    };
  }

  function ctx(): LaunchContext {
    return {
      repoRoot: "/r",
      userData: ud,
      packaged: false,
      env: {},
      bins: { uv: null },
      searchDirs: [],
      logFile: (id) => path.join(ud, "logs", `${id}.log`),
      signal: new AbortController().signal,
    };
  }

  async function bringUp(spec: ServiceSpec, c: LaunchContext): Promise<LaunchResult> {
    const r = await spec.launch(c);
    started.push(r);
    const until = Date.now() + 60_000;
    for (;;) {
      const ready = await spec.readiness(r, c);
      if (ready.kind === "ready") return r;
      if (ready.kind === "failed") throw new Error(ready.detail);
      if (Date.now() > until) throw new Error("준비 시간 초과");
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  const psql = (sql: string) =>
    runTool(pgBinaries(BUNDLE).psql, ["-X", "-A", "-t", "-h", pgLayout(ud).runDir, "-U", "damwha", "-d", "damwha", "-c", sql], { env: pgToolEnv(), deadlineMs: 15_000 });

  it("creates a socket-only cluster with the damwha database and marks the pair", async () => {
    const spec = embeddedPostgresSpec(deps());
    const r = await bringUp(spec, ctx());
    const layout = pgLayout(ud);
    // PostgreSQL 16에는 lc_collate 설정이 없다(2026-09-14 Task 3 실측) — 데이터베이스의 콜레이션은 pg_database에 있다.
    const q = await psql("SELECT current_setting('listen_addresses'), (SELECT datcollate FROM pg_database WHERE datname = current_database()), current_database()");
    expect(q.stdout.trim()).toBe("|C|damwha");
    expect((fs.statSync(layout.runDir).mode & 0o777).toString(8)).toBe("700");
    const marker = parseMarker(fs.readFileSync(layout.marker, "utf8"));
    expect(marker?.databaseOid).toBeGreaterThan(0);
    const out = await spec.stop(r, { graceMs: 5 });
    expect(out).toEqual({ stopped: true, leaked: [] });
    expect(fs.existsSync(layout.socketFile)).toBe(false);
  }, 120_000);

  it("opens the same cluster on the next launch without initdb", async () => {
    const layout = pgLayout(ud);
    const before = fs.readFileSync(layout.marker, "utf8");
    const spec = embeddedPostgresSpec(deps());
    const r = await bringUp(spec, ctx());
    expect(fs.readFileSync(layout.marker, "utf8")).toBe(before);
    await spec.stop(r, { graceMs: 5 });
  }, 120_000);

  it("takes over a postmaster left behind by a run that never stopped it", async () => {
    const layout = pgLayout(ud);
    const first = await bringUp(embeddedPostgresSpec(deps()), ctx());
    const orphanPid = first.handle!.pid!;
    // 앱이 죽었다고 치고, 새 어댑터가 같은 클러스터를 연다.
    const spec = embeddedPostgresSpec(deps());
    const second = await bringUp(spec, ctx());
    expect(processExists(orphanPid)).toBe(false);
    expect(parsePostmasterPid(fs.readFileSync(path.join(layout.pgdata, "postmaster.pid"), "utf8"))?.pid).toBe(second.handle!.pid);
    await spec.stop(second, { graceMs: 5 });
  }, 180_000);
});
