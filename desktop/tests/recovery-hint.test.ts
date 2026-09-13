import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAUSES, CAUSE_IDS, causeIn, type CauseId } from "../src/causes";
import { DEGRADED_HINT, HINTS, hintForDetail, recoveryHint } from "../src/shell-hints";
import { judgeAfterProbe } from "../src/services/api";
import { probeEmbedContract } from "../src/services/external";
import { postgresSpec } from "../src/services/postgres";
import { createSupervisor } from "../src/services/supervisor";
import { launchWithUv, workerSpec } from "../src/services/worker";
import type { LaunchContext, ServiceId, ServiceSpec, ServiceStatus } from "../src/services/types";

const s = (over: Partial<ServiceStatus>): ServiceStatus => ({
  id: "api",
  process: "failed",
  health: "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

describe("recoveryHint", () => {
  it("tells the user to start Docker", () => {
    expect(recoveryHint(s({ id: "postgres", detail: "Docker Desktop이 실행 중이 아니에요." })))
      .toMatch(/Docker Desktop/);
  });

  it("tells the user where to put the uv path", () => {
    expect(recoveryHint(s({ id: "worker", detail: "uv를 찾지 못했어요." })))
      .toMatch(/config\.json/);
  });

  it("tells the user to run the migration command", () => {
    expect(recoveryHint(s({ detail: "적용되지 않은 마이그레이션이 3개 있어요" })))
      .toMatch(/pnpm be:migrate/);
  });

  it("tells the user to copy the worker env example", () => {
    expect(recoveryHint(s({ id: "worker", detail: "be/worker/.env가 없어요." })))
      .toMatch(/\.env\.example/);
  });

  it("explains an external worker in terms of STORAGE_ROOT", () => {
    expect(
      recoveryHint(s({ id: "worker", process: "running", owned: false, detail: "외부 worker가 실행 중이에요 (pid 4101)." })),
    ).toMatch(/STORAGE_ROOT/);
  });

  it("says a degraded API recovers on its own", () => {
    expect(recoveryHint(s({ process: "running", health: "degraded", detail: "데이터베이스에 연결할 수 없어요." })))
      .toMatch(/자동으로/);
  });

  it("returns undefined for a healthy service", () => {
    expect(recoveryHint(s({ process: "running", health: "ok" }))).toBeUndefined();
  });

  it("returns undefined for an unrecognised cause rather than inventing one", () => {
    // 모르는 원인에 그럴듯한 안내를 붙이면 사용자를 엉뚱한 곳으로 보낸다.
    expect(recoveryHint(s({ detail: "알 수 없는 오류 0x99" }))).toBeUndefined();
  });
});

// ─── 아래는 브리프 밖에서 더한 것 ───────────────────────────────────────────────────────────
//
// 위 여덟 개는 원인 문구를 **손으로** 적는다. 그것만으로는 두 가지를 못 본다: (1) 매핑이 어느
// 원인을 조용히 빠뜨렸는가, (2) 앞선 정규식이 뒤 원인의 문구를 삼키는가(브리프의 `/Docker
// Desktop/`이 "docker를 찾지 못했어요. Docker Desktop을 설치했는지…"를 먼저 잡았다). 그래서
// 원인 목록은 causes.ts의 CAUSES를 **돌며** 만들고, 문구는 실제 어댑터가 낸 것을 쓴다.

const SERVICE_IDS: readonly ServiceId[] = ["postgres", "api", "embed", "worker"];

type TemplateId = { [K in CauseId]: (typeof CAUSES)[K]["text"] extends string ? never : K }[CauseId];
type ArgsOf<K extends TemplateId> = (typeof CAUSES)[K]["text"] extends (...args: infer A) => string ? A : never;

/** 값이 끼는 원인의 예시 인자. 타입이 키를 전부 요구하므로 템플릿 원인을 더하면 여기서 걸린다. */
const SAMPLE_ARGS: { [K in TemplateId]: ArgsOf<K> } = {
  spawnNotFound: ["/nowhere/uv"],
  pendingMigrations: [3, "022_x.sql, 023_y.sql, 024_z.sql"],
  externalWorker: [[4101, 4102]],
  embedMismatch: ["other/model", 768, "BAAI/bge-m3", 1024],
  noFreePort: [10],
  processExited: [1],
  readinessThrew: ["boom"],
  healthProbeThrew: ["boom"],
  externalCheckFailed: ["ps를 못 돌렸어요"],
};

function sampleOf(id: CauseId): string {
  const text = CAUSES[id].text;
  if (typeof text === "string") return text;
  return (text as (...args: unknown[]) => string)(...(SAMPLE_ARGS[id as TemplateId] as unknown[]));
}

describe("recoveryHint — 원인 목록 전체 (causes.ts에서 끌어온다)", () => {
  it("every cause is recognised as itself — no earlier pattern swallows it", () => {
    const misread = CAUSE_IDS.filter((id) => causeIn(sampleOf(id)) !== id).map(
      (id) => `${id} → ${causeIn(sampleOf(id)) ?? "undefined"}`,
    );
    expect(misread).toEqual([]);
  });

  it("HINTS decides every cause the catalog defines, and nothing else", () => {
    // 타입(Record<CauseId, …>)이 이미 강제하지만 캐스트 하나로 뚫린다. 런타임에서도 본다.
    expect(Object.keys(HINTS).sort()).toEqual([...CAUSE_IDS].sort());
  });

  it("a failed service gets exactly the hint its cause is mapped to, for every service id", () => {
    const wrong: string[] = [];
    for (const id of CAUSE_IDS) {
      const mapped = HINTS[id];
      for (const sid of SERVICE_IDS) {
        const want = mapped === null ? undefined : typeof mapped === "string" ? mapped : mapped[sid];
        const got = recoveryHint(s({ id: sid, detail: sampleOf(id) }));
        if (got !== want) wrong.push(`${id}@${sid}: ${String(got)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("every degraded cause says it recovers on its own and never says to restart", () => {
    expect(DEGRADED_HINT).not.toMatch(/다시 시작하세요|재시작하세요|다시 켜 주세요/);
    for (const id of CAUSE_IDS) {
      for (const sid of SERVICE_IDS) {
        expect(recoveryHint(s({ id: sid, process: "running", health: "degraded", detail: sampleOf(id) })))
          .toBe(DEGRADED_HINT);
      }
    }
  });

  it("a stale cause on a service that is starting again or stopped gets no hint", () => {
    // 감독자는 상태를 덧대기만 해서 재기동이 시작돼도 지난 실패의 detail이 남는다.
    for (const id of CAUSE_IDS) {
      for (const process of ["starting", "stopped"] as const) {
        expect(recoveryHint(s({ id: "worker", process, detail: sampleOf(id) }))).toBeUndefined();
      }
    }
  });

  it("an adopted service with no cause gets no hint", () => {
    expect(recoveryHint(s({ id: "embed", process: "running", health: "ok", owned: false }))).toBeUndefined();
  });
});

describe("recoveryHint — 스펙 §6.12의 표가 말하는 것", () => {
  // 원인별 안내의 **내용**. 위의 매핑 검사는 "표가 정한 대로 나오는가"만 보므로 표 자체가 틀린
  // 말을 해도 초록이다. 스펙 표의 행마다 핵심 낱말을 고정한다.
  const rows: Array<[CauseId, ServiceId, RegExp]> = [
    ["dockerDaemonDown", "postgres", /Docker Desktop을 실행/],
    ["dockerMissing", "postgres", /DOCKER_BIN/],
    ["uvMissing", "worker", /config\.json의 UV_BIN/],
    ["spawnNotFound", "worker", /UV_BIN/],
    ["repoRootMissing", "api", /폴더를 골라/],
    ["workerEnvMissing", "worker", /be\/worker\/\.env\.example을 복사/],
    ["pendingMigrations", "api", /pnpm be:migrate/],
    ["externalWorker", "worker", /worker를 끄.*STORAGE_ROOT/],
    ["embedMismatch", "embed", /embed/],
    // P2-C10: 유예를 넘긴 worker에는 DB 연결 문제일 수 있다는 원인이 보여야 한다 (스펙 §8).
    ["readyTimeout", "worker", /데이터베이스.*config\.json의 DATABASE_URL/],
  ];
  it.each(rows)("%s on %s", (cause, id, want) => {
    expect(hintForDetail(sampleOf(cause), id)).toMatch(want);
  });

  it("does not blame the database for a timeout it cannot narrow down", () => {
    // ready 줄이 DB 연결 뒤에 찍히는 것은 worker뿐이다. embed의 유예 초과는 모델 로딩일 수 있다.
    for (const id of ["postgres", "api", "embed"] as const) {
      expect(recoveryHint(s({ id, detail: CAUSES.readyTimeout.text }))).toBeUndefined();
    }
  });

  it("does not tell the API launcher about UV_BIN when pnpm is what went missing", () => {
    expect(recoveryHint(s({ id: "api", detail: CAUSES.spawnNotFound.text("pnpm") }))).toBeUndefined();
  });
});

describe("recoveryHint — 실제 어댑터가 낸 원인에서", () => {
  // 위 두 묶음은 causes.ts의 문구를 쓴다. 어댑터가 그 문구를 **실제로** 쓰는지는 여기서 본다 —
  // 어댑터가 문구를 인라인으로 다시 적으면 위는 초록인 채 화면에서 안내가 사라진다.
  const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv", docker: "/usr/local/bin/docker" },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    ...over,
  });

  const thrown = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("던지지 않았다");
  };

  it("postgres: Docker daemon down (compose up -d)", async () => {
    const spec = postgresSpec(async () => ({
      stdout: "",
      stderr:
        "failed to connect to the docker API at unix:///Users/x/.docker/run/docker.sock; check if the path is correct and if the daemon is running",
      code: 1,
    }));
    const detail = await thrown(spec.launch(ctx()));
    expect(recoveryHint(s({ id: "postgres", detail }))).toBe(HINTS.dockerDaemonDown);
  });

  it("worker: uv missing", async () => {
    const detail = await thrown(
      workerSpec({ listExternal: async () => [] }).launch(ctx({ bins: { uv: null, docker: null } })),
    );
    expect(recoveryHint(s({ id: "worker", detail }))).toBe(HINTS.uvMissing);
  });

  it("worker: be/worker/.env missing", async () => {
    const detail = await thrown(workerSpec({ listExternal: async () => [], exists: () => false }).launch(ctx()));
    expect(recoveryHint(s({ id: "worker", detail }))).toBe(HINTS.workerEnvMissing);
  });

  it("worker: an external supervisor made the app stand down", async () => {
    const ext = await workerSpec({ listExternal: async () => [4101] }).detectExternal(ctx());
    expect(ext.kind).toBe("stand-down");
    const detail = ext.kind === "stand-down" ? ext.detail : "";
    expect(recoveryHint(s({ id: "worker", process: "running", owned: false, detail }))).toBe(HINTS.externalWorker);
  });

  const apiHandle = (stdout: string) =>
    ({
      pid: 1,
      alive: () => true,
      stderrTail: () => "",
      stdoutTail: () => stdout,
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    }) as const;
  const apiDeps = {
    verifyOwnListener: async () => true,
    isPortOccupied: async () => false,
    onPendingMigrations: () => undefined,
    onMigrationCheckSkipped: () => undefined,
  };

  it("api: pending migrations gate", async () => {
    const r = await judgeAfterProbe(
      apiHandle("WARN [DatabaseService] 3 pending migration(s): 022_x.sql, 023_y.sql, 024_z.sql — run `pnpm be:migrate`"),
      "ready",
      3000,
      apiDeps,
    );
    expect(r.kind).toBe("failed");
    const detail = r.kind === "failed" ? r.detail : "";
    expect(recoveryHint(s({ id: "api", detail }))).toBe(HINTS.pendingMigrations);
  });

  it("api: database dropped after boot is degraded and recovers on its own", async () => {
    const r = await judgeAfterProbe(apiHandle(""), "db-unreachable", 3000, apiDeps);
    expect(r.kind).toBe("degraded");
    const detail = r.kind === "degraded" ? r.detail : "";
    expect(recoveryHint(s({ id: "api", process: "running", health: "degraded", detail }))).toBe(DEGRADED_HINT);
  });

  it("embed: contract mismatch", async () => {
    const r = await probeEmbedContract("http://127.0.0.1:8100", { model: "BAAI/bge-m3", dimension: 1024 }, async () => ({
      status: 200,
      json: async () => ({ model: "other/model", dimension: 768 }),
    }));
    const detail = r.kind === "mismatch" ? r.detail : "";
    expect(recoveryHint(s({ id: "embed", detail }))).toBe(HINTS.embedMismatch);
  });

  const workerOnly = (over: Partial<ServiceSpec>): ServiceSpec => ({
    id: "worker",
    dependsOn: [],
    gate: false,
    detectExternal: async () => ({ kind: "absent" }),
    launch: async () => ({ handle: null, owned: true }),
    readiness: async () => ({ kind: "not-ready" }),
    stop: async () => ({ stopped: true, leaked: [] }),
    restart: "never",
    ...over,
  });

  it("supervisor: a worker that never logs ready fails with a DB hint (P2-C10)", async () => {
    const sup = createSupervisor([workerOnly({ readyTimeoutMs: 30 })], ctx(), { readyIntervalMs: 5 });
    await sup.start();
    await vi.waitFor(() => expect(sup.statuses()[0].process).toBe("failed"));
    const hint = recoveryHint(sup.statuses()[0]);
    expect(hint).toBe((HINTS.readyTimeout as Record<string, string>).worker);
  });

  let tmp: string | undefined;
  afterEach(() => {
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("supervisor + launchWithUv: a UV_BIN pointing nowhere fails with the UV_BIN hint (P2-C8)", async () => {
    // cfg.uvBin은 탐색을 건너뛰고 그대로 쓰인다(main.ts). 틀린 경로면 spawn이 'error'(ENOENT)를
    // 내고, launchWithUv가 그것을 stderr 싱크에 적고, 감독자가 죽은 핸들의 블록으로 올린다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-hint-"));
    tmp = dir;
    const spawnFn = () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined, kill: () => true });
      setTimeout(() => child.emit("error", Object.assign(new Error("spawn /nowhere/uv ENOENT"), { code: "ENOENT" })), 0);
      return child;
    };
    const launchCtx = ctx({ bins: { uv: "/nowhere/uv", docker: null }, logFile: (id) => path.join(dir, `${id}.log`) });
    const sup = createSupervisor(
      [workerOnly({ launch: async (c) => launchWithUv({ ctx: c, args: ["x"], logId: "worker", spawnFn }) })],
      launchCtx,
      { readyIntervalMs: 5, readyTimeoutMs: 2_000 },
    );
    await sup.start();
    await vi.waitFor(() => expect(sup.statuses()[0].process).toBe("failed"));
    const st = sup.statuses()[0];
    expect(st.detail).toContain("spawn /nowhere/uv ENOENT");
    expect(recoveryHint(st)).toBe(HINTS.uvMissing);
  });
});
