import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAUSES, CAUSE_IDS, causeIn, type CauseId } from "../../src/diagnostics/causes";
import { causeOf, DEGRADED_HINT, HINTS, RETRY_LAYERS, hintForDetail, recoveryHint } from "../../src/windows/shell-hints";
import { judgeAfterProbe } from "../../src/services/api";
import { probeEmbedContract } from "../../src/services/embed-probe";
import { embeddedPostgresSpec } from "../../src/services/postgres/service";
import { PG_BINARY_NAMES, pgBinaries, pgLayout } from "../../src/services/postgres/layout";
import { createSupervisor } from "../../src/services/supervisor";
import { workerSpec } from "../../src/services/worker";
import { launchPython } from "../../src/process/python-launcher";
import { fakeChild } from "../fake-child";
import type { LaunchContext, ServiceId, ServiceSpec, ServiceStatus } from "../../src/services/types";

const s = (over: Partial<ServiceStatus>): ServiceStatus => ({
  id: "api",
  process: "failed",
  health: "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

describe("recoveryHint", () => {
  it("tells the user to run the migration command", () => {
    expect(recoveryHint(s({ detail: "적용되지 않은 마이그레이션이 3개 있어요" })))
      .toMatch(/pnpm be:migrate/);
  });

  it("tells a worker that died mid-download to use the restart button — not a bare 다시 시도 (스펙 §6.10 2층)", () => {
    expect(recoveryHint(s({ id: "worker", detail: CAUSES.modelDownloadFailed.text("BAAI/bge-m3", "timeout") })))
      .toBe(RETRY_LAYERS.service);
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
    // 모르는 원인에 그럴듯한 안내를 붙이면 사용자를 엉뚱한 곳으로 보낸다. degraded여도 같다 — "자동으로
    // 복구됩니다"도 안내이고, 원문 stderr(compose 출력 같은)는 그렇게 풀린다는 근거가 없다.
    expect(recoveryHint(s({ detail: "알 수 없는 오류 0x99" }))).toBeUndefined();
    expect(recoveryHint(s({ process: "running", health: "degraded", detail: "알 수 없는 오류 0x99" }))).toBeUndefined();
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
  spawnNotFound: ["/nowhere/python/bin/python3.12"],
  pendingMigrations: [3, "022_x.sql, 023_y.sql, 024_z.sql"],
  externalWorker: [[4101, 4102]],
  embedMismatch: ["other/model", 768, "BAAI/bge-m3", 1024],
  noFreePort: [10],
  processExited: [1],
  readinessThrew: ["boom"],
  healthProbeThrew: ["boom"],
  externalCheckFailed: ["ps를 못 돌렸어요"],
  restartStopFailed: ["worker"],
  modelDownloadFailed: ["BAAI/bge-m3", "ReadTimeout: huggingface.co"],
  modelDownloadStalled: ["BAAI/bge-m3"],
  diskFull: ["1.2 GB", "4.0 GB"],
  pgBundleMissing: [["initdb", "psql"]],
  pgSocketPathTooLong: ["/x/run/.s.PGSQL.5432", 120],
  pgPairingRefused: ["파일 저장소가 다른 데이터베이스의 것이에요", "/u/data/postgres", "/u/data/storage"],
  pgVersionMismatch: ["15", "16"],
  pgControldataFailed: ["pg_controldata: 종료 코드 1"],
  pgLockUnprovable: [4242, "/u/data/postgres/postmaster.pid", "ps가 실패했어요"],
  pgOrphanStuck: [4242],
  pgInitdbFailed: ["initdb: 종료 코드 1"],
  pgCreatedbFailed: ["createdb: 종료 코드 1"],
  pgQueryFailed: ["psql: 종료 코드 1"],
  pgStopLeaked: [4242],
  migrationStatusFailed: ["마이그레이션 러너: 종료 코드 1"],
  migrationUnknown: [["999_from_future.sql"]],
  backupFailed: ["pg_dump: 종료 코드 1"],
  migrationFailed: ["마이그레이션 러너: 종료 코드 1\nERROR: relation \"x\" does not exist", "/u/backups/20260914T101500Z-before-025_x.sql.dump"],
  migrationsStillPending: [1, "025_x.sql"],
  writersAlive: [[7777]],
  buildInfoMissing: ["/Applications/Damwha.app/Contents/Resources/build-info.json"],
  snapshotFailed: ["cp -c -R: 종료 코드 1\nNo space left on device", "/u/snapshots"],
  restoreJournalUnreadable: ["/u/restore-journal.json", "형식이 맞지 않아요"],
  restoreIncomplete: ["교체를 이어 갈 수 없는 상태예요 (data/ 있음, 보관본 있음, 임시 사본 있음)"],
  restoreAborted: ["되돌릴 스냅샷을 찾지 못했어요 (20260924T084933Z)"],
};

/** 실패한 서비스에 이 원인이 받아야 하는 안내 — HINTS 표를 그대로 읽는다. */
function mappedHint(id: CauseId, sid: ServiceId): string | undefined {
  const mapped = HINTS[id];
  return mapped === null ? undefined : typeof mapped === "string" ? mapped : mapped[sid];
}

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
      for (const sid of SERVICE_IDS) {
        const want = mappedHint(id, sid);
        const got = recoveryHint(s({ id: sid, detail: sampleOf(id) }));
        if (got !== want) wrong.push(`${id}@${sid}: ${String(got)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a degraded service is told it recovers on its own only when the catalog says its cause does — otherwise it gets its cause's own fix", () => {
    // 전에는 이 테스트가 **모든** 원인 × 서비스에 DEGRADED_HINT를 단언해 결함을 지켰다(리뷰 I-1).
    // 어느 원인이든 degraded로 온다 — 감독자의 재프로브가 readiness의 failed detail을 degraded에 싣는다.
    // ready였던 postgres가 재프로브에서 원인 모를 not-ready를 받은(notAnswering) 경우가 그렇고,
    // 왜 그런지 모르므로 사람이 확인하기 전에는 돌아오지 않는다. 기대값은
    // 원인 목록의 선언(selfRecovers)에서 끌어온다 — 원인을 더하면 그 원인도 이 검사를 탄다.
    expect(DEGRADED_HINT).not.toMatch(/다시 시작하세요|재시작하세요|다시 켜 주세요/);
    const wrong: string[] = [];
    for (const id of CAUSE_IDS) {
      for (const sid of SERVICE_IDS) {
        const want = CAUSES[id].selfRecovers ? DEGRADED_HINT : mappedHint(id, sid);
        const got = recoveryHint(s({ id: sid, process: "running", health: "degraded", detail: sampleOf(id) }));
        if (got !== want) wrong.push(`${id}@${sid}: ${String(got)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a cause that recovers on its own has no fix for a person — and a cause with a fix is not marked as recovering on its own", () => {
    // 위 검사는 선언을 **따르는지**만 본다. 선언 자체가 틀리면(notAnswering을 selfRecovers로 적으면)
    // 위는 초록인 채 I-1이 돌아온다. 사람이 할 일이 적힌 원인은 정의상 저절로 풀리지 않는다.
    expect(CAUSE_IDS.filter((id) => CAUSES[id].selfRecovers && HINTS[id] !== null)).toEqual([]);
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
    // Phase 4: worker·embed의 spawn ENOENT는 번들 python이 없다는 뜻이다. UV_BIN은 더 읽지 않는다.
    ["spawnNotFound", "worker", /다시 설치.*build-python\.sh/],
    ["spawnNotFound", "embed", /다시 설치.*build-python\.sh/],
    // Phase 4 스펙 §6.3: dev 전용 원인이 됐고 폴더 선택창이 사라졌다 — "고르라"고 말하면 없는 창을 가리킨다.
    ["repoRootMissing", "api", /desktop\/에서 앱을 띄웠는지.*config\.json의 REPO_ROOT/],
    // Phase 4 스펙 §8 — 다운로드가 멈춘 것은 서비스 다시 시작(2층)이다.
    ["modelDownloadStalled", "embed", /서비스 다시 시작/],
    ["diskFull", "worker", /공간을 만든 뒤/],
    ["pendingMigrations", "api", /pnpm be:migrate/],
    ["externalWorker", "worker", /worker를 끄.*STORAGE_ROOT/],
    ["embedMismatch", "embed", /embed/],
    // P2-C10: 유예를 넘긴 worker에는 DB 연결 문제일 수 있다는 원인이 보여야 한다 (Phase 2 스펙 §8).
    ["readyTimeout", "worker", /데이터베이스에 연결하지 못해.*데이터베이스 줄의 상태/],
  ];
  it.each(rows)("%s on %s", (cause, id, want) => {
    expect(hintForDetail(sampleOf(cause), id)).toMatch(want);
  });

  it("does not blame the database for a timeout it cannot narrow down", () => {
    // ready 줄이 DB 연결 뒤에 찍히는 것은 worker뿐이다. embed의 유예 초과는 모델 로딩일 수 있다.
    // postgres는 여기서 빠진다 — Phase 3부터 자기 크래시 복구가 오래 걸릴 수 있다는 자기 원인을
    // 따로 받는다(logs/postgres/를 가리킨다). 아래 "server's own logs" 테스트가 그것을 본다.
    for (const id of ["api", "embed"] as const) {
      expect(recoveryHint(s({ id, detail: CAUSES.readyTimeout.text }))).toBeUndefined();
    }
  });

  it("does not tell the API launcher about the Python bundle when pnpm is what went missing", () => {
    expect(recoveryHint(s({ id: "api", detail: CAUSES.spawnNotFound.text("pnpm") }))).toBeUndefined();
  });

  it("no longer points anyone at UV_BIN for a failure the app can still produce (Phase 4)", () => {
    // uvMissing은 Task 11이 지웠다. spawnNotFound는 여전히 난다 — 그 안내가
    // 읽히지도 않는 설정을 고치라고 하면 사람은 고칠 수 없는 것을 고친다.
    for (const sid of SERVICE_IDS) {
      expect(mappedHint("spawnNotFound", sid) ?? "").not.toMatch(/UV_BIN/);
    }
  });
});

describe("recoveryHint — 실제 어댑터가 낸 원인에서", () => {
  // 위 두 묶음은 causes.ts의 문구를 쓴다. 어댑터가 그 문구를 **실제로** 쓰는지는 여기서 본다 —
  // 어댑터가 문구를 인라인으로 다시 적으면 위는 초록인 채 화면에서 안내가 사라진다.
  const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    databaseMode: "embedded",
    env: {},
    bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
    ...over,
  });

  it("worker: the bundled python is not there — the real adapter's dead-handle cause gets the bundle hint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-hint-"));
    try {
      const child = fakeChild();
      const spec = workerSpec({ listExternal: async () => [], spawnFn: () => child });
      const c = ctx({ logFile: (id) => path.join(dir, `${id}.log`) });
      const result = await spec.launch(c);
      child.emit("error", Object.assign(new Error(`spawn ${c.bins.python} ENOENT`), { code: "ENOENT" }));
      const r = await spec.readiness(result, c);
      const detail = r.kind === "failed" ? r.detail : "";
      expect(detail).toContain(`spawn ${c.bins.python} ENOENT`);
      expect(recoveryHint(s({ id: "worker", detail }))).toBe((HINTS.spawnNotFound as Record<string, string>).worker);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("worker: launching no longer fails for a missing be/worker/.env or a missing checkout (packaged)", async () => {
    // Phase 2의 두 거부(uv 없음·.env 없음)는 어댑터에서 사라졌다. 원인 항목 자체는 Task 11이 지운다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-hint-"));
    try {
      const child = fakeChild();
      const spec = workerSpec({ listExternal: async () => [], spawnFn: () => child });
      const result = await spec.launch(ctx({ repoRoot: null, packaged: true, logFile: (id) => path.join(dir, `${id}.log`) }));
      expect(result.handle).not.toBeNull();
      child.emit("exit", 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("postgres: a pairing refusal from the real adapter gets its fix, and says the app changed nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rh-"));
    try {
      const layout = pgLayout(path.join(root, "ud"));
      const bundle = path.join(root, "bundle");
      fs.mkdirSync(path.join(bundle, "bin"), { recursive: true });
      for (const n of PG_BINARY_NAMES) {
        fs.writeFileSync(path.join(bundle, "bin", n), "");
        fs.chmodSync(path.join(bundle, "bin", n), 0o755);
      }
      fs.mkdirSync(path.join(layout.storage, "meetings", "mtg_37"), { recursive: true });
      fs.writeFileSync(path.join(layout.storage, "meetings", "mtg_37", "original.m4a"), "x");
      const spec = embeddedPostgresSpec({
        binaries: pgBinaries(bundle),
        layout,
        runTool: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false }),
        psInfo: async () => null,
        spawnPostmaster: () => {
          throw new Error("스폰까지 오면 안 된다");
        },
        stopOrphan: async () => "fast",
        log: () => undefined,
      });
      const detail = await spec.launch({ ...ctx(), userData: layout.userData }).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(recoveryHint(s({ id: "postgres", detail }))).toBe(HINTS.pgPairingRefused);
      expect(HINTS.pgPairingRefused).toMatch(/아무것도 지우거나 새로 만들지 않았어요/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("postgres: a database that is stopping is degraded and does not claim to recover on its own", () => {
    expect(recoveryHint(s({ id: "postgres", process: "running", health: "degraded", detail: CAUSES.pgStopping.text }))).toBeUndefined();
  });

  it("supervisor: a health probe that throws after ready is degraded and does not claim to recover on its own (최종 리뷰 M-3)", async () => {
    // N-1이 notAnswering·workerDbUnreachable 둘만 잠그고 셋째 갈래를 남겼다 — healthProbeThrew.selfRecovers를
    // true로 뒤집어도 522개가 초록이었다. 재프로브가 **왜** 던졌는지 모르므로 스스로 풀린다고 말할 근거가
    // 없다. 그 원인 문구는 감독자의 probeHealth만 만들므로, 진짜 감독자로 그 경로를 태운다.
    let throwNow = false;
    const spec: ServiceSpec = {
      id: "embed",
      dependsOn: [],
      gate: false,
      healthIntervalMs: 5,
      detectExternal: async () => ({ kind: "absent" }),
      launch: async () => ({ handle: null, owned: false }),
      readiness: async () => {
        if (throwNow) throw new Error("probe exploded");
        return { kind: "ready" };
      },
      stop: async () => ({ stopped: true, leaked: [] }),
      restart: "never",
    };
    const sup = createSupervisor([spec], ctx(), { readyIntervalMs: 5 });
    await sup.start();
    await vi.waitFor(() => expect(sup.statuses()[0]).toMatchObject({ process: "running", health: "ok" }));

    throwNow = true;
    await vi.waitFor(() => expect(sup.statuses()[0].health).toBe("degraded"));
    const status = sup.statuses()[0];
    await sup.stopAll({ graceMs: 5 });
    expect(status.detail).toBe(CAUSES.healthProbeThrew.text("probe exploded"));
    expect(recoveryHint(status)).not.toBe(DEGRADED_HINT);
  });

  it("worker: reconnect failing after ready is degraded and DOES get the auto-recover hint (뒤집힌 방향의 잠금, 리뷰 N-1)", async () => {
    // 위와 반대 방향의 결함을 잠근다: workerDbUnreachable.selfRecovers를 false로 뒤집어도(리뷰 표의 F4)
    // 517개가 그대로 초록이었다 — degraded worker 줄이 참인 안내를 조용히 잃어도 아무도 못 본다.
    // readiness는 launch()가 stderr 스트림에 붙인 감시를 읽으므로, 손으로 만든 handle이 아니라 launch를 거친다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-hint-"));
    tmp = dir;
    const child = new EventEmitter() as unknown as ChildProcess & { stderr: EventEmitter };
    Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 1, kill: () => true });
    const spec = workerSpec({ listExternal: async () => [], spawnFn: () => child });
    const launchCtx = ctx({ logFile: (id) => path.join(dir, `${id}.log`) });
    const result = await spec.launch(launchCtx);
    child.stderr.emit("data", Buffer.from("INFO supervisor desktop-7 ready (db connected)\nWARNING reconnect failed — retry in 2s\n"));
    const r = await spec.readiness(result, launchCtx);
    child.emit("exit", 0);
    expect(r).toEqual({ kind: "degraded", detail: CAUSES.workerDbUnreachable.text });
    const detail = r.kind === "degraded" ? r.detail : "";
    expect(recoveryHint(s({ id: "worker", process: "running", health: "degraded", detail }))).toBe(DEGRADED_HINT);
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

  it("supervisor + launchPython: a bundled python that is not there fails with the bundle hint (P2-C8, Phase 4)", async () => {
    // main.ts는 번들 경로를 만들 뿐 존재를 확인하지 않는다. 없으면 spawn이 'error'(ENOENT)를 내고,
    // launchPython이 그것을 stderr 싱크에 적고, 감독자가 죽은 핸들의 블록으로 올린다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-hint-"));
    tmp = dir;
    const spawnFn = () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined, kill: () => true });
      setTimeout(
        () => child.emit("error", Object.assign(new Error("spawn /nowhere/python/bin/python3.12 ENOENT"), { code: "ENOENT" })),
        0,
      );
      return child;
    };
    const launchCtx = ctx({
      bins: { ...ctx().bins, python: "/nowhere/python/bin/python3.12" },
      logFile: (id) => path.join(dir, `${id}.log`),
    });
    const sup = createSupervisor(
      [workerOnly({ launch: async (c) => launchPython({ ctx: c, module: "damwha_worker", logId: "worker", spawnFn }) })],
      launchCtx,
      { readyIntervalMs: 5, readyTimeoutMs: 2_000 },
    );
    await sup.start();
    await vi.waitFor(() => expect(sup.statuses()[0].process).toBe("failed"));
    const st = sup.statuses()[0];
    expect(st.detail).toContain("spawn /nowhere/python/bin/python3.12 ENOENT");
    expect(recoveryHint(st)).toBe((HINTS.spawnNotFound as Record<string, string>).worker);
    expect(recoveryHint(st)).not.toMatch(/UV_BIN/);
  });
});

describe("Phase 3 causes", () => {
  it("names the backup in a migration failure so the person knows where the data before it is", () => {
    const text = CAUSES.migrationFailed.text("boom", "/u/backups/b.dump");
    expect(text).toContain("/u/backups/b.dump");
    expect(CAUSES.migrationFailed.text("boom", null)).not.toContain("백업");
  });

  it("never tells a person to delete the data folder — dev and packaged share one cluster", () => {
    // 스펙 §6.1·§6.5-2. 안내가 data 폴더를 지우라고 하면 실제 데이터를 지우라는 말이다.
    for (const id of CAUSE_IDS) {
      const hint = HINTS[id];
      const texts = hint === null ? [] : typeof hint === "string" ? [hint] : Object.values(hint);
      for (const t of texts) expect(t, id).not.toMatch(/(data|데이터) ?폴더를 (지우|삭제|정리)/);
    }
  });

  it("tells a pairing-refusal reader to check the folder was not moved OR deleted (스펙 §6.7 원문 문구)", () => {
    expect(HINTS.pgPairingRefused).toMatch(/옮기거나 지우지 않았는지/);
  });

  it("points a postgres readiness timeout and a postgres exit at the server's own logs", () => {
    expect(recoveryHint(s({ id: "postgres", detail: CAUSES.readyTimeout.text }))).toMatch(/logs\/postgres\//);
    expect(recoveryHint(s({ id: "postgres", detail: CAUSES.processExited.text(1) }))).toMatch(/logs\/postgres\//);
  });

  it("does not tell the worker to fix DATABASE_URL in config.json — the app derives it now", () => {
    expect(recoveryHint(s({ id: "worker", detail: CAUSES.readyTimeout.text }))).not.toMatch(/DATABASE_URL/);
  });

  it("does not let spawnNotFound swallow a Phase 3 block that happens to embed a spawn ENOENT failure", () => {
    // migration-gate.ts의 runnerFailureBlock은 원인 형태를 모르면 describeToolFailure로 되돌아가고,
    // 그 문구가 "실행하지 못했어요 (spawn pnpm ENOENT)"다. spawnNotFound의 정규식이 이 문구만 보고
    // CAUSE_IDS를 spawnNotFound가 먼저 걸리는 순서로 두면, migrationStatusFailed 같은 Phase 3 원인이
    // 자기 문구("마이그레이션 상태를 확인하지 못했어요")로 시작하는데도 엉뚱한 원인·안내로 읽힌다.
    const detail = CAUSES.migrationStatusFailed.text("마이그레이션 러너: 실행하지 못했어요 (spawn pnpm ENOENT)");
    expect(causeIn(detail)).toBe("migrationStatusFailed");
  });

  it("does not claim a postgres that goes not-ready for no known reason recovers on its own (notAnswering)", () => {
    // 이 원인을 고정하는 유일한 테스트였던 "docker compose stop postgres" 테스트가 Task 12에서
    // Docker 원인과 함께 지워졌다 — 내장 postgres로 다시 건다. ready였던 postgres가 재프로브에서
    // 원인 모를 not-ready를 받으면(notAnswering) 왜 그런지 모르므로 스스로 풀린다고 말하지 않는다.
    expect(CAUSES.notAnswering.selfRecovers).toBe(false);
    const status = s({ id: "postgres", process: "running", health: "degraded", detail: CAUSES.notAnswering.text });
    expect(recoveryHint(status)).not.toBe(DEGRADED_HINT);
    expect(recoveryHint(status) ?? "").not.toMatch(/자동으로/);
  });
});

/**
 * 판정 R-10c — 정리 중인 서비스가 **실제로 갖는 모양**으로 본다. `running`·`ok`·`owned`라
 * 기존 관문 셋(failed·degraded·stand-down) 중 어느 것에도 걸리지 않는다. 합성한 `failed`로
 * 검사하면 그 사실을 영영 못 본다.
 */
describe("causeOf·recoveryHint — 정리 중 (R-10c)", () => {
  /**
   * 이 원인의 안내는 **서비스별**이어야 한다 — 기다리는 시간의 근거가 worker(job 마무리 90초)와
   * embed(받던 모델)에서 다르다. 좁히는 이 함수가 그 모양을 단언한다.
   */
  const wait = (id: ServiceId): string => {
    const h = HINTS.restartStopFailed;
    if (h === null || typeof h === "string") throw new Error("restartStopFailed는 서비스별 안내여야 한다");
    return h[id]!;
  };

  /** restartOnce가 실패한 정지 뒤에 세우는 그 상태 그대로. */
  const cleaning = (id: ServiceId, detail: string): ServiceStatus => ({
    id,
    process: "running",
    health: "ok",
    owned: true,
    restarts: 0,
    cleaningUp: true,
    detail,
  });

  it("shows the cause even though the service is running, ok and owned", () => {
    const status = cleaning("worker", CAUSES.restartStopFailed.text("worker"));
    expect(causeOf(status)).toBe(CAUSES.restartStopFailed.text("worker"));
  });

  it("gives each service its own wait — the text is not worker-only", () => {
    expect(recoveryHint(cleaning("worker", CAUSES.restartStopFailed.text("worker")))).toBe(
      wait("worker"),
    );
    expect(recoveryHint(cleaning("embed", CAUSES.restartStopFailed.text("embed")))).toBe(
      wait("embed"),
    );
  });

  it("never invites the second press — that signal is a kill for the worker", () => {
    const hint = recoveryHint(cleaning("worker", CAUSES.restartStopFailed.text("worker")));
    expect(hint).not.toContain("다시 시작");
    expect(hint).not.toContain("다시 시도");
  });

  it("still says nothing for a healthy owned service", () => {
    expect(causeOf(s({ process: "running", health: "ok", detail: "지난 실패" }))).toBeUndefined();
    expect(recoveryHint(s({ process: "running", health: "ok", detail: "지난 실패" }))).toBeUndefined();
  });

  it("carries the adapter's own words that restartOnce appended under the cause head", () => {
    const detail = `${CAUSES.restartStopFailed.text("worker")}\n강제 종료 여부를 물을 수 있는 사람이 없어서 그대로 두었어요.`;
    expect(causeOf(cleaning("worker", detail))).toBe(detail);
    expect(recoveryHint(cleaning("worker", detail))).toBe(wait("worker"));
  });
});
