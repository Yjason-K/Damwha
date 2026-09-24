import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../../diagnostics/causes";
import { failureBlock } from "../../diagnostics/stderr";
import { manualUnlessTagged, ServiceFailure } from "../failure";
import { DB_NAME, DB_SUPERUSER, PG_BINARY_NAMES, PG_MAJOR, pgToolEnv, socketPathTooLong, type PgBinaries, type PgLayout } from "./layout";
import type { PostmasterStopResult } from "./handle";
import {
  decideCluster,
  decideDatabase,
  parseControldataClusterId,
  parseMarker,
  readStorageFacts,
  writeMarkerAtomic,
  type ClusterRefusal,
  type DatabaseRefusal,
} from "./pairing";
import { clearPostmasterLock } from "./lock";
import { parsePostmasterPid, type ProcessInfo } from "./pidfile";
import { describeToolFailure, toolOk, type ToolOptions, type ToolResult } from "../../process/tool-runner";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceHandle, ServiceSpec } from "../types";

/** crash recovery를 포함한 상한. Task 13이 실측과 대조한다. */
export const PG_READY_TIMEOUT_MS = 180_000;
/** 재확인은 파일 읽기라 값싸다. */
export const PG_HEALTH_INTERVAL_MS = 10_000;
/** 종료 순서상 클라이언트가 이미 없다 — 보통 1초 안에 끝난다. */
export const PG_FAST_GRACE_MS = 30_000;
export const PG_IMMEDIATE_GRACE_MS = 10_000;
export const PG_TOOL_DEADLINES = { initdb: 120_000, controldata: 10_000, psql: 15_000, createdb: 30_000 } as const;

export interface EmbeddedPostgresDeps {
  binaries: PgBinaries;
  layout: PgLayout;
  runTool(bin: string, args: readonly string[], opts: ToolOptions): Promise<ToolResult>;
  psInfo(pid: number): Promise<ProcessInfo | null>;
  spawnPostmaster(logFile: string): ServiceHandle;
  stopOrphan(pid: number): Promise<PostmasterStopResult>;
  log(line: string): void;
}

const REASON_TEXT: Record<Exclude<ClusterRefusal, "version-mismatch" | "controldata-failed"> | DatabaseRefusal, string> = {
  "storage-without-cluster": "파일 저장소에 파일이 있는데 데이터베이스가 없어요",
  "cluster-without-marker": "데이터베이스는 있는데 파일 저장소의 짝 표시가 없어요",
  "marker-unreadable": "파일 저장소의 짝 표시를 읽을 수 없어요",
  "marker-mismatch": "파일 저장소가 다른 데이터베이스의 것이에요",
  "database-dropped": "데이터베이스(damwha)가 지워졌어요",
  "database-recreated": "데이터베이스(damwha)가 새로 만들어진 것이에요",
  "storage-without-database": "파일 저장소에 파일이 있는데 데이터베이스(damwha)가 없어요",
};

const INITDB_LEFTOVER = /^postgres\.initdb-[0-9a-f]{8}$/;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 거부. 부류는 manual이고, 부르기 전에 아무것도 바꾸지 않았어야 한다 (스펙 §5). */
function refuse(text: string): never {
  throw new ServiceFailure(text, "manual");
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 번들 PostgreSQL 클러스터 (Phase 3 스펙 §6.4). 이 어댑터는 클러스터의 수명주기만 진다 — 마이그레이션은 api 어댑터의
 * 스폰 전 게이트가 한다(§6.5).
 */
export function embeddedPostgresSpec(deps: EmbeddedPostgresDeps): ServiceSpec {
  const { binaries, layout } = deps;
  const env = pgToolEnv();
  /** 판정표 2를 통과한 핸들. 핸들마다 한 번이고, 10초 재확인은 물리적 준비만 본다. */
  const verified = new WeakSet<ServiceHandle>();
  const pairing = (reason: keyof typeof REASON_TEXT) => CAUSES.pgPairingRefused.text(REASON_TEXT[reason], layout.pgdata, layout.storage);
  const tool = (bin: string, args: readonly string[], deadlineMs: number, signal: AbortSignal) =>
    deps.runTool(bin, args, { env, deadlineMs, signal });

  async function readClusterId(pgdata: string, signal: AbortSignal): Promise<{ id: string | null; failure?: string }> {
    const r = await tool(binaries.pgControldata, ["-D", pgdata], PG_TOOL_DEADLINES.controldata, signal);
    if (!toolOk(r)) return { id: null, failure: describeToolFailure("pg_controldata", r) };
    const id = parseControldataClusterId(r.stdout);
    return id === null ? { id: null, failure: "pg_controldata 출력에서 클러스터 id를 찾지 못했어요" } : { id };
  }

  function ensureDirs(): void {
    for (const dir of [layout.dataDir, layout.runDir, layout.backups]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    fs.mkdirSync(layout.logDir, { recursive: true });
  }

  /** §5의 첫 번째 삭제 — 앱이 만든 이름이고 실제 디렉터리일 때만. 심볼릭 링크를 따라가 지우지 않는다. */
  function removeInitdbLeftovers(): void {
    for (const name of fs.readdirSync(layout.dataDir)) {
      if (!INITDB_LEFTOVER.test(name)) continue;
      const p = path.join(layout.dataDir, name);
      if (!fs.lstatSync(p).isDirectory()) continue;
      fs.rmSync(p, { recursive: true, force: true });
      deps.log(`postgres: 이전 실행이 남긴 initdb 임시 디렉터리를 지웠다 — ${p}`);
    }
  }

  async function initCluster(signal: AbortSignal): Promise<void> {
    const tmp = path.join(layout.dataDir, `postgres.initdb-${randomBytes(4).toString("hex")}`);
    const r = await tool(
      binaries.initdb,
      ["-D", tmp, "-U", DB_SUPERUSER, "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject"],
      PG_TOOL_DEADLINES.initdb,
      signal,
    );
    if (!toolOk(r)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      deps.log(`postgres: 실패한 initdb 임시 디렉터리를 지웠다 — ${tmp}`);
      refuse(CAUSES.pgInitdbFailed.text(describeToolFailure("initdb", r)));
    }
    const c = await readClusterId(tmp, signal);
    if (c.id === null) {
      fs.rmSync(tmp, { recursive: true, force: true });
      deps.log(`postgres: 실패한 initdb 임시 디렉터리를 지웠다 — ${tmp}`);
      refuse(CAUSES.pgInitdbFailed.text(c.failure ?? "pg_controldata"));
    }
    // 마커를 옮기기 **전에** 쓴다. 그래야 "클러스터는 있는데 마커가 없다"가 앱이 만든 클러스터에서 생길 수 없다 (§6.2).
    writeMarkerAtomic(layout.marker, { clusterId: c.id, databaseOid: null });
    fs.renameSync(tmp, layout.pgdata);
    deps.log(`postgres: 새 클러스터를 만들었다 — ${layout.pgdata} (id ${c.id})`);
  }

  /** "retry"는 서버가 아직 접속을 받지 않는다는 뜻이다(psql exit 2). 준비 유예가 상한이다. */
  async function queryDatabaseOid(signal: AbortSignal): Promise<number | null | "retry"> {
    const r = await tool(
      binaries.psql,
      ["-X", "-A", "-t", "-h", layout.runDir, "-U", DB_SUPERUSER, "-d", "postgres", "-c", `SELECT oid FROM pg_database WHERE datname = '${DB_NAME}'`],
      PG_TOOL_DEADLINES.psql,
      signal,
    );
    if (r.code === 2 && !r.timedOut && !r.aborted) return "retry";
    if (!toolOk(r)) refuse(CAUSES.pgQueryFailed.text(describeToolFailure("psql", r)));
    const out = r.stdout.trim();
    if (out === "") return null;
    const oid = Number(out);
    if (!Number.isInteger(oid) || oid <= 0) refuse(CAUSES.pgQueryFailed.text(`알아볼 수 없는 psql 출력: ${out.slice(0, 80)}`));
    return oid;
  }

  /** 판정표 2 (§6.2). */
  async function verifyDatabase(signal: AbortSignal): Promise<"ok" | "retry"> {
    // 파일이 아예 없는 것과 있는데 못 읽는 것은 다른 이유다 — decideCluster(판정표 1)가 자신이 읽는 마커에 이미
    // 같은 구분을 두므로(pairing.ts), 판정표 2도 같은 어휘를 쓴다.
    const markerText = readIfExists(layout.marker);
    if (markerText === null) refuse(pairing("cluster-without-marker"));
    const marker = parseMarker(markerText);
    if (marker === null) refuse(pairing("marker-unreadable"));
    const oid = await queryDatabaseOid(signal);
    if (oid === "retry") return "retry";
    const decision = decideDatabase({ oid, marker, storageHasFiles: readStorageFacts(layout.storage).hasFiles });
    if (decision.kind === "ok") return "ok";
    if (decision.kind === "refuse") refuse(pairing(decision.reason));
    if (decision.kind === "record-oid") {
      writeMarkerAtomic(layout.marker, { ...marker, databaseOid: decision.oid });
      deps.log(`postgres: 데이터베이스 ${DB_NAME}의 oid ${decision.oid}를 마커에 적었다`);
      return "ok";
    }
    const created = await tool(binaries.createdb, ["-h", layout.runDir, "-U", DB_SUPERUSER, DB_NAME], PG_TOOL_DEADLINES.createdb, signal);
    if (!toolOk(created)) refuse(CAUSES.pgCreatedbFailed.text(describeToolFailure("createdb", created)));
    const after = await queryDatabaseOid(signal);
    if (after === null || after === "retry") refuse(CAUSES.pgCreatedbFailed.text("만든 뒤에도 데이터베이스가 보이지 않아요"));
    writeMarkerAtomic(layout.marker, { ...marker, databaseOid: after });
    deps.log(`postgres: 데이터베이스 ${DB_NAME}를 만들었다 (oid ${after})`);
    return "ok";
  }

  return {
    id: "postgres",
    dependsOn: [],
    gate: true,
    readyTimeoutMs: PG_READY_TIMEOUT_MS,
    healthIntervalMs: PG_HEALTH_INTERVAL_MS,
    async detectExternal() {
      // 이전 실행의 고아는 "외부"가 아니다. 채택하지 않고 launch()가 내린다.
      return { kind: "absent" };
    },
    launch(ctx: LaunchContext): Promise<LaunchResult> {
      return manualUnlessTagged(async () => {
        const missing = PG_BINARY_NAMES.filter((n) => !isExecutable(path.join(binaries.dir, "bin", n)));
        if (missing.length > 0) refuse(CAUSES.pgBundleMissing.text(missing));
        const tooLong = socketPathTooLong(layout);
        if (tooLong !== null) refuse(CAUSES.pgSocketPathTooLong.text(layout.socketFile, tooLong));

        // 판정에는 디렉터리가 필요 없다. 디렉터리 생성과 임시 디렉터리 정리를 판정 **뒤로** 둬, 거부 경로가 아무것도
        // 만들거나 지우지 않게 한다 (스펙 §5).
        const pgdataExists = fs.existsSync(layout.pgdata);
        const pgVersion = pgdataExists ? (readIfExists(path.join(layout.pgdata, "PG_VERSION"))?.trim() ?? null) : null;
        let clusterId: string | null = null;
        let controldataFailure: string | undefined;
        if (pgdataExists && pgVersion === PG_MAJOR) {
          const c = await readClusterId(layout.pgdata, ctx.signal);
          clusterId = c.id;
          controldataFailure = c.failure;
        }
        const decision = decideCluster({ pgdataExists, pgVersion, clusterId, storage: readStorageFacts(layout.storage) });
        if (decision.kind === "refuse") {
          if (decision.reason === "version-mismatch") refuse(CAUSES.pgVersionMismatch.text(decision.detail ?? "(없음)", PG_MAJOR));
          if (decision.reason === "controldata-failed") refuse(CAUSES.pgControldataFailed.text(controldataFailure ?? layout.pgdata));
          refuse(pairing(decision.reason));
        }
        // 락 판정(clearPostmasterLock)도 거부할 수 있다 — ps가 실패하거나 고아가 안 내려가면. 그 거부가 §5를 어기지
        // 않도록 "start" 경로는 clearPostmasterLock을 먼저 끝내고서야 디렉터리를 만들고 initdb 임시물을 지운다.
        if (decision.kind === "initdb") {
          ensureDirs();
          removeInitdbLeftovers();
          await initCluster(ctx.signal);
        } else {
          await clearPostmasterLock(deps);
          ensureDirs();
          removeInitdbLeftovers();
        }
        return { handle: deps.spawnPostmaster(ctx.logFile("postgres")), owned: true };
      });
    },
    async readiness(result, ctx): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null) return { kind: "failed", detail: CAUSES.noHandle.text, recovery: "manual" };
      // auto로 못박는다. 서버가 준비 전에 죽은 것은 다시 띄워 볼 만하다 (스펙 §6.7 표) — manualUnlessTagged와
      // 달리 readiness()는 기본값이 없으므로, 명시하지 않으면 undefined가 되어 감독자가 이 행을 특정할 수 없다.
      if (!handle.alive())
        return { kind: "failed", recovery: "auto", detail: failureBlock(handle.stderrTail()) || CAUSES.processExited.text(handle.exitCode() ?? "?") };
      const text = readIfExists(path.join(layout.pgdata, "postmaster.pid"));
      const pidfile = text === null ? null : parsePostmasterPid(text);
      // pid를 대조한다. 고아를 내린 직후나 재시작 직후에는 이전 postmaster의 ready가 파일에 남아 있을 수 있다.
      if (pidfile === null || pidfile.pid !== handle.pid) return { kind: "not-ready" };
      // 판정표 2를 아직 통과하지 않은 핸들의 stopping은 degraded가 아니다 — 감독자는 degraded를 게이트가 열려도
      // 되는 신호로 읽으므로, 검증 전에 이 상태를 주면 마이그레이션을 못 마친 데이터베이스로 게이트가 열린다.
      if (pidfile.status === "stopping") return verified.has(handle) ? { kind: "degraded", detail: CAUSES.pgStopping.text } : { kind: "not-ready" };
      if (pidfile.status !== "ready" || !fs.existsSync(layout.socketFile)) return { kind: "not-ready" };
      if (verified.has(handle)) return { kind: "ready" };
      try {
        if ((await verifyDatabase(ctx.signal)) === "retry") return { kind: "not-ready" };
      } catch (e) {
        return { kind: "failed", detail: reasonOf(e), recovery: "manual" };
      }
      verified.add(handle);
      return { kind: "ready" };
    },
    async stop(result) {
      // plan.graceMs와 onGraceExpired를 쓰지 않는다. 사람이 판단할 정보(진행 중인 job)가 postgres에는 없고, 종료 순서상
      // 클라이언트가 이미 없다. 감독자의 기동 중 정리(5초)가 부를 때도 같은 절차다 (스펙 §6.4 종료).
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(PG_FAST_GRACE_MS);
      if (!handle.alive()) return { stopped: true, leaked: [] };
      const pid = handle.pid;
      return { stopped: false, leaked: pid === undefined ? [] : [pid], detail: CAUSES.pgStopLeaked.text(pid ?? "?") };
    },
    // 앱이 소유자다. Phase 2의 never는 compose의 restart: unless-stopped가 소유했기 때문이었다.
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}

/**
 * 외부 디버그 모드 (스펙 §6.1). 아무것도 띄우지 않고 내리지 않는다. DB에 닿는지는 api의 /api/health가 보여준다 —
 * desktop에 pg 클라이언트를 넣지 않는다.
 */
export function externalPostgresSpec(): ServiceSpec {
  return {
    id: "postgres",
    dependsOn: [],
    gate: true,
    async detectExternal() {
      return { kind: "adopt", detail: CAUSES.externalDatabase.text };
    },
    async launch() {
      return { handle: null, owned: false };
    },
    async readiness() {
      return { kind: "ready" };
    },
    async stop() {
      return { stopped: true, leaked: [] };
    },
    restart: "never",
  };
}
