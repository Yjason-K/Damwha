import {
  clipArgs,
  processLabel,
  reapByKind,
  type DamwhaProcess,
  type KnownTree,
  type ReapDeps,
  type ReapEntry,
  type ReapPlan,
} from "../process/orphans";
import type { StopOutcome } from "../services/types";
import { STOP_DETAIL } from "../services/worker-shutdown";
import { systemReapDeps } from "./reap-on-start";

/**
 * 앱 종료의 B층 — 서비스 핸들과 독립인 마지막 단계 (Phase 4 스펙 §6.5 "종료 절차").
 *
 * 종료는 두 층이다. A층은 감독자가 핸들을 쥔 서비스마다 `stop()`(SIGTERM → 유예 → 자손 SIGKILL)이고, B층은
 * `ps`의 argv 표식만 보고 **이번 실행의 run-id를 단 모든 프로세스**를 내린다. B층이 따로 있는 이유가 둘 겹친다:
 *
 *  1. Python supervisor는 두 번째 신호에서 `--once` 자식을 `proc.kill()`하고 `os._exit(1)`한다
 *     (be/worker/damwha_worker/__main__.py의 `_on_signal`). 자식은 `start_new_session=True`라 별도 세션이어서,
 *     부모가 먼저 사라지면 자손 SIGKILL이 훑을 트리가 없다.
 *  2. **감독자는 죽은 서비스의 `stop()`을 아예 부르지 않는다.** `watchForDeath`가 `rt.result = null`로 만들고
 *     `stopAll`이 `rt.result === null`인 서비스를 건너뛴다(services/supervisor.ts). `stop()` 안에 무엇을 넣어도
 *     그 경로에서는 돌지 않는다.
 *
 * 그래서 이 파일은 핸들도 감독자 상태도 받지 않는다 — 받는 것은 run-id·트리·커널 잎(`ReapDeps`)뿐이다. 절차는
 * 기동 정리와 같은 한 벌(process/orphans.ts의 `reapByKind`)이고 대상 딱지만 `mine`이다. 자손을 부모보다 먼저,
 * 신호 직전마다 `exists`, SIGTERM → 유예 → args가 같은 pid에만 SIGKILL (판정 R-7e — B층이 잡는 것은 A층이
 * 핸들을 잃어 SIGTERM을 한 번도 못 받은 것들이다).
 *
 * 다른 run-id(이전 실행의 고아)와 `external`(run-id 없는 터미널 worker, 트리 밖 python)은 건드리지 않는다 —
 * 전자는 다음 기동의 정리가 맡는다. run-id가 없는 번들 프로세스(capabilities 프로브 `-c`, embed의
 * `resource_tracker`)는 살아 있는 표식 프로세스의 자손일 때만 함께 내려간다. 프로브는 A층의 group SIGTERM이
 * 맡는다(services/worker-shutdown.ts).
 *
 * main.ts는 electron을 값으로 import해 vitest가 부를 수 없다. 순서(`stopThenReap`)와 판정 합치기(`withReaped`)를
 * 여기 둔다.
 */

/** 종료 회수의 모든 로그 줄 머리. 같은 supervisor.log에 기동 정리의 줄도 있다. */
const PREFIX = "종료 회수 — ";

const QUIT_PLAN: ReapPlan = {
  target: "mine",
  words: {
    prefix: PREFIX,
    subject: "이번 실행의 프로세스",
    // 한 줄로 모은다. 신호는 하나도 가지 않는다 — 읽을 수 없는 줄이 우리 것이 아니라고 증명할 수 없다.
    unreadable: (rows) => [
      `이번 실행의 프로세스인지 읽을 수 없는 줄이 있어 아무것도 내리지 않았어요 — ${rows
        .map((row) => `pid ${row.pid}: ${clipArgs(row.args)}`)
        .join(" / ")}`,
    ],
    // 다른 run-id·external은 조용히 둔다. 기동 정리처럼 "이미 있다"고 적을 대상이 없다.
    bystander: () => null,
    sent: (entry, how) =>
      entry.root === null
        ? `서비스 정지가 놓친 프로세스의 자손을 내려요 (${how}) — pid ${entry.pid}`
        : `서비스 정지가 놓친 이번 실행의 프로세스를 내려요 (${how}) — ${processLabel(entry.root)}`,
  },
};

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 로그를 못 써도 종료를 막지 않는다. */
function say(d: ReapDeps, line: string): void {
  try {
    d.log(`${PREFIX}${line}`);
  } catch {
    // 삼킨다 — 이 단계는 던지지 않는다.
  }
}

/**
 * 이번 실행의 run-id를 단 프로세스를 전부 내린다. `stopAll`이 끝난 **뒤에**, 핸들 유무와 무관하게 항상 부른다.
 *
 * - 돌려주는 `reaped`는 신호가 실제로 한 번이라도 닿은 담화 프로세스다(신호 순서 — 자손이 먼저). 표식 없는
 *   자손(탈출구 LLM 서버 등)도 함께 내리지만 `DamwhaProcess`가 아니라 여기 담지 않는다 — 로그에는 남는다.
 * - **던지지 않는다.** 종료를 막지 않는 것이 먼저다. `ps` 실패·빈 출력·읽을 수 없는 줄·자손 조회 실패는
 *   한 줄을 남기고 신호 없이 끝난다. 도중에 의존이 던지면 한 줄을 남기고 그때까지 보낸 것을 돌려준다.
 * - 아무것도 찾지 못했으면 아무것도 적지 않는다. 무엇이든 내렸으면 프로세스마다 줄(pid·모듈·`--once`·run-id)과
 *   "A층이 놓쳤다"는 요약 한 줄을 남긴다 — 조용히 덮으면 A층의 결함이 영영 안 보인다.
 */
export async function reapOwnedOnQuit(d: ReapDeps): Promise<{ reaped: DamwhaProcess[] }> {
  const signalled: ReapEntry[] = [];
  try {
    await reapByKind(d, QUIT_PLAN, signalled);
  } catch (e) {
    say(d, `도중에 멈췄어요 — ${reasonOf(e)}`);
  }
  if (signalled.length > 0) {
    say(
      d,
      `서비스별 정지(A층)가 놓친 이번 실행의 프로세스 ${signalled.length}개에 종료 마지막 단계에서 신호를 보냈어요 — ` +
        `pid ${signalled.map((e) => e.pid).join(", ")}. 서비스 정지 절차가 무엇을 놓쳤는지 확인해야 해요.`,
    );
  }
  return { reaped: signalled.flatMap((e) => (e.root === null ? [] : [e.root])) };
}

/** B층이 볼 이번 실행의 표식과 트리. main.ts가 트리를 계산하는 자리(어떤 자식보다 먼저)에서 채운다. */
export interface QuitReapTarget {
  runId: string;
  trees: readonly KnownTree[];
}

/**
 * main.ts가 B층에 넘기는 배선. 기동 정리와 같은 커널 잎(`systemReapDeps` — SIGTERM·유예·SIGKILL)을 쓴다.
 * 이번 실행이 트리를 계산하기 전에 끝났으면(토큰 온보딩 중 종료 등) 이번 실행의 자식이 있을 수 없으므로 null —
 * B층을 건너뛴다.
 */
export function quitReapDeps(target: QuitReapTarget | null, log: (line: string) => void): ReapDeps | null {
  if (target === null) return null;
  return systemReapDeps({ runId: target.runId, trees: target.trees, log });
}

/** 화면에 싣는 B층의 사유. */
function reapedDetail(reaped: readonly DamwhaProcess[]): string {
  return `서비스를 하나씩 멈추는 단계가 놓친 담화 프로세스 ${reaped.length}개를 종료 마지막 단계에서 찾아 내렸어요 (pid ${reaped
    .map((p) => p.pid)
    .join(", ")}).`;
}

/**
 * B층의 결과를 A층의 `StopOutcome`에 합친다 — 이 값이 runQuitFlow(quit-flow.ts)의 "남은 것" 판정
 * (`!out.stopped` → `leftoverNotice`)으로 간다.
 *
 * B층이 무엇이든 내렸으면 A층이 `stopped: true`라고 했어도 깨끗하지 않았다. `leaked`에는 내린 것 중 **아직
 * 있는** pid만 더한다 — 신호로 끝난 것을 "살아 있을 수 있다"고 적으면 거짓이다. A층이 사유 없이 깨끗하지
 * 않았으면 화면이 원래 적었을 말(`STOP_DETAIL.unverifiable`, leftoverNotice의 기본값)을 지킨다.
 */
export function withReaped(
  out: StopOutcome,
  reaped: readonly DamwhaProcess[],
  exists: (pid: number) => boolean,
): StopOutcome {
  if (reaped.length === 0) return out;
  const survivors = reaped.map((p) => p.pid).filter((pid) => !out.leaked.includes(pid) && exists(pid));
  const aReason = out.detail ?? (out.stopped ? undefined : STOP_DETAIL.unverifiable);
  return {
    stopped: false,
    leaked: [...out.leaked, ...survivors],
    detail: [aReason, reapedDetail(reaped)].filter((line): line is string => line !== undefined).join("\n"),
  };
}

/**
 * main.ts `stopServices()`의 순서. A층(`stop` — 감독자 역순 종료와 dev의 Vite)이 **끝난 뒤에** B층을 돈다.
 *
 * - A층이 도는 동안에는 B층을 시작하지 않는다. worker의 정중한 정지(유예 90초, P2-C5) 한가운데에 B층의
 *   SIGTERM → 3초 → SIGKILL이 끼면 그 정지가 깨진다.
 * - **A층이 던져도 B층은 돈다.** 그 뒤 A층의 예외를 그대로 다시 던진다 — main.ts의 `.catch`가 그것을 받아
 *   `quitNow()`로 간다. B층의 존재 이유가 "A층이 놓친 경로"인데 그중 하나를 놓치면 안 된다.
 * - `deps`가 null이면(이번 실행이 트리를 계산하기 전) B층을 건너뛴다.
 * - A층이 값을 돌려줬으면 B층의 결과를 합친다(`withReaped`).
 */
export async function stopThenReap(stop: () => Promise<StopOutcome>, deps: ReapDeps | null): Promise<StopOutcome> {
  let out: StopOutcome;
  try {
    out = await stop();
  } catch (e) {
    if (deps !== null) await reapOwnedOnQuit(deps);
    throw e;
  }
  if (deps === null) return out;
  const { reaped } = await reapOwnedOnQuit(deps);
  return withReaped(out, reaped, (pid) => deps.exists(pid));
}
