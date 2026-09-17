import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../diagnostics/causes";
import { exitCauseBlock } from "../diagnostics/stderr";
import type { SpawnFn } from "../process/tool-runner";
import { launchWithUv } from "../process/uv-launcher";
import type {
  LaunchResult,
  ReadinessResult,
  ServiceHandle,
  ServiceSpec,
  StopOutcome,
  StopPlan,
} from "./types";

/** Task 7이 __main__.py에 넣은 줄. DB에 실제로 붙은 뒤에만 나온다. */
const READY = /supervisor \S+ ready \(db connected\)/g;
/** __main__.py `_reconnect()`의 백오프 경고. */
const RECONNECT_FAILED = /reconnect failed/g;

/**
 * 줄바꿈이 아직 오지 않은 마지막 조각을 다음 청크까지 들고 가는 상한. 진행 바는 `\r`로만 다시 그려
 * 한 "줄"이 한없이 길어질 수 있으므로 **끝쪽**을 남긴다 — 그 뒤에 이어 붙는 로그 줄이 거기 있다.
 */
const LINE_CARRY_LIMIT = 8_000;

function lastIndexOfMatch(text: string, re: RegExp): number {
  let last = -1;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m.index;
  return last;
}

export type WorkerReadinessState = "not-ready" | "ready" | "degraded";

export interface ReadinessWatch {
  /** stderr 청크를 받는 순서대로 넣는다. 줄 경계는 청크 경계와 무관하다. */
  feed(text: string): void;
  state(): WorkerReadinessState;
}

/**
 * worker의 준비는 **사건**이다 — ready 줄은 supervisor 기동(과 재접속 성공)마다 한 번 찍힌다. 예전에는
 * 8,000자로 굴러가는 stderr 꼬리에서 그 줄을 찾았는데, 처리 중인 worker는 몇 초마다 STT 진행 줄을 찍어
 * 그 줄이 꼬리에서 밀려났다(2026-09-13 packaged 실측: ready 뒤 60번째 줄). 그 순간부터 멀쩡히 일하는
 * worker가 재시작 전까지 running/degraded("준비 상태로 답하지 않아요")로 남았고, 그 상태를 지켜보는
 * P2-C10·P2-C11은 판정할 수 없게 됐다. 그래서 스트림을 줄 단위로 훑어 마지막 사건을 든다.
 *
 * - ready → `ready`. reconnect 실패 뒤의 ready는 회복이다 (스펙 §6.6).
 * - ready를 **본 뒤의** reconnect 실패 → `degraded`.
 * - ready를 한 번도 못 봤으면 reconnect 실패가 있어도 `not-ready`다. degraded를 답하면 감독자가
 *   running으로 적는데, DB가 처음부터 틀린 worker는 준비 유예를 넘겨 failed가 되어야 한다 (P2-C10).
 *   `supervisor <id> started`는 DB 연결 전 줄이라 아무 사건도 아니다.
 */
export function makeReadinessWatch(): ReadinessWatch {
  let carry = "";
  let state: WorkerReadinessState = "not-ready";
  const see = (line: string) => {
    const ready = lastIndexOfMatch(line, READY);
    const failed = lastIndexOfMatch(line, RECONNECT_FAILED);
    if (ready > failed) state = "ready";
    else if (failed > ready && state !== "not-ready") state = "degraded";
  };
  return {
    feed(text: string) {
      const lines = (carry + text).split("\n");
      carry = (lines.pop() ?? "").slice(-LINE_CARRY_LIMIT);
      for (const line of lines) see(line);
    },
    state: () => state,
  };
}

export interface WorkerDeps {
  /** 외부 supervisor의 pid들. Task 4의 parseWorkerProcesses가 채운다. */
  listExternal(): Promise<number[]>;
  /** worker의 .env 존재 확인. 테스트가 주입한다. */
  exists?(p: string): boolean;
  /** 테스트 주입용. launch()가 그대로 launchWithUv에 넘긴다 — 기본은 실제 child_process.spawn. */
  spawnFn?: SpawnFn;
  /**
   * 종료 절차. Task 11의 stopWorkerProcess를 main.ts가 넘긴다.
   *
   * `graceMs`가 아니라 **StopPlan 전체**를 받는다. 유예 초과 대화상자를 띄우는 것은
   * `plan.onGraceExpired`이고, 그것을 여기서 넘겨주지 않으면 어댑터가 그 콜백에 닿을 길이
   * 없다 — 감독자도 그것을 부르지 않으므로(stopAll은 plan을 spec.stop에 넘기기만 한다)
   * 아무도 부르지 않는 콜백이 되어, 유예가 지나도 사람에게 묻지 않고 조용히 강제 단계를
   * 건너뛴다. 대화상자를 어댑터가 **직접** 띄우지 않는 이유도 같다: 그러면 감독자가
   * 넘겨준 것과 둘이 되어 사용자가 같은 질문을 두 번 받는다.
   */
  stop?(result: LaunchResult, plan: StopPlan): Promise<StopOutcome>;
}

export function workerSpec(deps: WorkerDeps): ServiceSpec {
  const exists = deps.exists ?? fs.existsSync;
  /**
   * 기동마다 하나. 핸들로 드는 이유는 api.ts의 createMigrationCheckWatch와 같다 — 재시작한 worker는
   * 새 핸들이라 사건을 처음부터 다시 본다. 불리언 하나로 들면 옛 기동의 ready가 새 기동에 남는다.
   */
  const watches = new WeakMap<ServiceHandle, ReadinessWatch>();

  return {
    id: "worker",
    dependsOn: ["postgres"],
    gate: false,
    // 스트림이 이미 갱신해 둔 마지막 사건을 읽을 뿐이라 사실상 공짜다. ready 뒤에 reconnect
    // 실패가 나타나는 순간을 잡는다 (스펙 §6.6).
    healthIntervalMs: 10_000,
    async detectExternal() {
      const pids = await deps.listExternal();
      if (pids.length === 0) return { kind: "absent" };
      // ps eww는 SIP 때문에 다른 프로세스의 env를 내주지 않는다(2026-09-12 실측).
      // 그 worker가 앱과 같은 STORAGE_ROOT를 보는지 증명할 수 없으므로 채택하지 않는다.
      return { kind: "stand-down", detail: CAUSES.externalWorker.text(pids) };
    },
    async launch(ctx) {
      // uv 확인이 .env 확인보다 먼저다. repoRoot는 packaged 빌드마다 다르고 실제 체크아웃이
      // 아닐 수도 있어(테스트의 "/r"처럼) .env 존재 검사가 먼저면 uv 부재와 무관하게 항상
      // ".env 없음"으로 넘어져, uv를 못 찾은 진짜 원인이 화면에 뜨지 않는다. launchWithUv도
      // 같은 검사를 하지만 그건 .env를 통과한 뒤라 이미 늦다.
      if (ctx.bins.uv === null) throw new Error(CAUSES.uvMissing.text);
      // packaged는 저장소를 모른다(repoRoot=null). 이 .env 검사는 Task 5가 지운다 — 앱이 필요한 env를 전부 넣는다.
      if (ctx.repoRoot === null) throw new Error(CAUSES.repoRootMissing.text);
      const envFile = path.join(ctx.repoRoot, "be", "worker", ".env");
      if (!exists(envFile)) throw new Error(CAUSES.workerEnvMissing.text);
      // 감시를 spawn **전에** 만들어 onStderr로 넘긴다 — 첫 청크부터 빠짐없이 본다.
      const watch = makeReadinessWatch();
      const result = launchWithUv({
        ctx,
        args: ["python", "-m", "damwha_worker"],
        logId: "worker",
        spawnFn: deps.spawnFn,
        onStderr: watch.feed,
      });
      if (result.handle !== null) watches.set(result.handle, watch);
      return result;
    },
    async readiness(result): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null) return { kind: "failed", detail: CAUSES.noHandle.text };
      if (!handle.alive()) {
        // 죽은 worker의 원인은 여전히 꼬리에서 온다. 감독자의 exitedDetail과 같은 블록이다 — 줄 수만
        // 자르면 줄바꿈 없는 한 줄이 상한 없이 화면에 오른다.
        return { kind: "failed", detail: exitCauseBlock(handle.stderrTail()) };
      }
      // 이 spec의 launch()가 만든 핸들만 여기로 온다. 감시가 없으면 준비를 증명할 근거도 없다.
      const state = watches.get(handle)?.state() ?? "not-ready";
      if (state === "degraded") {
        // "자동으로 복구됩니다"는 shell-hints.ts의 DEGRADED_HINT가 붙인다.
        return { kind: "degraded", detail: CAUSES.workerDbUnreachable.text };
      }
      return state === "ready" ? { kind: "ready" } : { kind: "not-ready" };
    },
    async stop(result, plan) {
      if (deps.stop !== undefined) return deps.stop(result, plan);
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(plan.graceMs);
      const leaked = handle.alive() && handle.pid !== undefined ? [handle.pid] : [];
      return { stopped: leaked.length === 0, leaked };
    },
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}
