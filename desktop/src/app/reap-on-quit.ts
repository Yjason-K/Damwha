import { CAUSES } from "../diagnostics/causes";
import {
  clipArgs,
  processLabel,
  reapByKind,
  reasonOf,
  type DamwhaProcess,
  type KnownTree,
  type ReapDeps,
  type ReapEntry,
  type ReapPlan,
  type ReapRun,
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

/** 로그를 못 써도 종료를 막지 않는다. */
function say(d: ReapDeps, line: string): void {
  try {
    d.log(`${PREFIX}${line}`);
  } catch {
    // 삼킨다 — 이 단계는 던지지 않는다.
  }
}

/**
 * B층 한 판의 전체 결과 — 신호를 보낸 칸 전부(표식 없는 자손 포함)와 스캔을 끝냈는가. 종료 화면의 판정은
 * 이것으로 내린다(`stopThenReap`). 도중에 의존이 던지면 한 줄을 남기고 **실패**로 돌려준다 — 끝까지 보지 못했다.
 */
async function reapOwned(d: ReapDeps): Promise<ReapRun> {
  const signalled: ReapEntry[] = [];
  let run: ReapRun;
  try {
    run = await reapByKind(d, QUIT_PLAN, signalled);
  } catch (e) {
    say(d, `도중에 멈췄어요 — ${reasonOf(e)}`);
    run = { failed: true, signalled };
  }
  if (signalled.length > 0) {
    say(
      d,
      `서비스별 정지(A층)가 놓친 이번 실행의 프로세스 ${signalled.length}개에 종료 마지막 단계에서 신호를 보냈어요 — ` +
        `pid ${signalled.map((e) => e.pid).join(", ")}. 서비스 정지 절차가 무엇을 놓쳤는지 확인해야 해요.`,
    );
  }
  return run;
}

/**
 * 이번 실행의 run-id를 단 프로세스를 전부 내린다. `stopAll`이 끝난 **뒤에**, 핸들 유무와 무관하게 항상 부른다.
 *
 * - 돌려주는 `reaped`는 신호가 실제로 한 번이라도 닿은 담화 프로세스다(신호 순서 — 자손이 먼저). 표식 없는
 *   자손(탈출구 LLM 서버 등)도 함께 내리지만 `DamwhaProcess`가 아니라 여기 담지 않는다 — 로그에는 남고, 종료
 *   화면의 판정(`stopThenReap`)은 그것까지 센다.
 * - **던지지 않는다.** 종료를 막지 않는 것이 먼저다. `ps` 실패·빈 출력·읽을 수 없는 줄·자손 조회 실패는
 *   한 줄을 남기고 신호 없이 끝난다. 도중에 의존이 던지면 한 줄을 남기고 그때까지 보낸 것을 돌려준다.
 *   스캔 실패는 이 반환값에 없다 — 화면에 싣는 쪽은 `stopThenReap`이다.
 * - 아무것도 찾지 못했으면 아무것도 적지 않는다. 무엇이든 내렸으면 프로세스마다 줄(pid·모듈·`--once`·run-id)과
 *   "A층이 놓쳤다"는 요약 한 줄을 남긴다 — 조용히 덮으면 A층의 결함이 영영 안 보인다.
 */
export async function reapOwnedOnQuit(d: ReapDeps): Promise<{ reaped: DamwhaProcess[] }> {
  const { signalled } = await reapOwned(d);
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

/** 화면에 싣는 B층의 사유. 표식 없는 자손도 센다. */
function reapedDetail(signalled: readonly ReapEntry[]): string {
  return `서비스를 하나씩 멈추는 단계가 놓친 프로세스 ${signalled.length}개를 종료 마지막 단계에서 찾아 내렸어요 (pid ${signalled
    .map((e) => e.pid)
    .join(", ")}).`;
}

/**
 * A층의 사유 중 **남은 것이 있다는 말**. 그 pid가 이제 없으면 거짓이 된다. 한 줄에 다른 사유와 공백으로 이어져
 * 올 수 있으므로(worker-shutdown.ts의 verdict) 줄이 아니라 문장을 지운다.
 *  - `STOP_DETAIL.orphans`·`diedFirst`는 어느 pid의 말인지 모르므로 A층의 `leaked`가 **전부** 없어졌을 때만.
 *  - postgres의 `pgStopLeaked`는 pid를 실으므로 그 pid가 없어졌을 때마다.
 */
function freshReasons(out: StopOutcome, gone: readonly number[], allGone: boolean): string[] {
  if (out.detail === undefined) return [];
  const stale = [
    ...(allGone ? [STOP_DETAIL.orphans, STOP_DETAIL.diedFirst] : []),
    ...gone.map((pid) => CAUSES.pgStopLeaked.text(pid)),
  ];
  return out.detail
    .split("\n")
    .map((line) => stale.reduce((rest, sentence) => rest.split(sentence).join(" "), line).replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

/**
 * B층의 결과를 A층의 `StopOutcome`에 합친다 — 이 값이 runQuitFlow(quit-flow.ts)의 "남은 것" 판정
 * (`!out.stopped` → `leftoverNotice`)으로 간다.
 *
 * 1. **A층의 `leaked`를 다시 본다.** 이제 없는 pid는 뺀다 — A층이 남겼다고 한 `llm_entry`(자기 세션이라 그룹
 *    SIGTERM이 닿지 않는다)를 B층이 방금 내렸는데 화면이 "살아 있을 수 있다"고 하면 거짓이다. 그 pid에 대한
 *    "남았다"는 사유도 함께 지운다(`freshReasons`). 그러고도 사유가 남지 않으면 A층은 깨끗했던 것과 같다.
 *    사유 없이 깨끗하지 않았던 A층(`{stopped:false, leaked:[]}`)은 화면이 원래 적었을 말
 *    (`STOP_DETAIL.unverifiable`, leftoverNotice의 기본값)을 지킨다.
 * 2. **B층이 신호를 하나라도 보냈으면** — 표식 없는 자손에게만 갔어도 — 깨끗하지 않았다. `leaked`에는 보낸 것 중
 *    아직 있는 pid만 더한다.
 * 3. **B층이 스캔을 끝내지 못했으면**(`run.failed`) 깨끗하다고 하지 않는다 — 스펙 §6.5 "판독 실패를 '고아
 *    없음'으로 처리하지 않는다". 사유는 `STOP_DETAIL.unverifiable`.
 * 4. B층이 내렸고, 스캔을 끝냈고, A층이 (1) 뒤에 깨끗하고, 남은 pid가 하나도 없으면 `cleanedUp` — 화면은
 *    "정리했다"고 적는다.
 * B층이 아무것도 보내지 않고 스캔을 끝냈으면 A층의 판정(1을 거친 것)이 그대로 결과다. 바뀐 것이 없으면 같은
 * 객체를 돌려준다.
 */
export function withReaped(out: StopOutcome, run: ReapRun, exists: (pid: number) => boolean): StopOutcome {
  const aLeft = out.leaked.filter((pid) => exists(pid));
  const gone = out.leaked.filter((pid) => !aLeft.includes(pid));
  const allGone = out.leaked.length > 0 && aLeft.length === 0;
  const aReasons = freshReasons(out, gone, allGone);
  const aClean = out.stopped || (allGone && aReasons.length === 0);
  const acted = run.signalled.length > 0;

  if (!acted && !run.failed) {
    if (aClean) return out.stopped ? out : { stopped: true, leaked: [] };
    if (gone.length === 0) return out;
  }

  const lines = aClean ? [] : aReasons.length > 0 ? aReasons : [STOP_DETAIL.unverifiable];
  if (acted) lines.push(reapedDetail(run.signalled));
  if (run.failed && !lines.includes(STOP_DETAIL.unverifiable)) lines.push(STOP_DETAIL.unverifiable);
  const bLeft = run.signalled.map((e) => e.pid).filter((pid) => !aLeft.includes(pid) && exists(pid));
  const leaked = [...aLeft, ...bLeft];
  const cleanedUp = acted && !run.failed && aClean && leaked.length === 0;
  return cleanedUp
    ? { stopped: false, leaked, detail: lines.join("\n"), cleanedUp: true }
    : { stopped: false, leaked, detail: lines.join("\n") };
}

/**
 * main.ts `stopServices()`의 순서. A층(`stop` — 감독자 역순 종료)이 **끝난 뒤에** B층을 돈다.
 *
 * - A층이 도는 동안에는 B층을 시작하지 않는다. worker의 정중한 정지(유예 90초, P2-C5) 한가운데에 B층의
 *   SIGTERM → 3초 → SIGKILL이 끼면 그 정지가 깨진다.
 * - **A층이 던져도 B층은 돈다.** 그 뒤 A층의 예외를 그대로 다시 던진다 — main.ts의 `.catch`가 그것을 받아
 *   `quitNow()`로 간다. B층의 존재 이유가 "A층이 놓친 경로"인데 그중 하나를 놓치면 안 된다.
 * - `deps`가 null이면(이번 실행이 트리를 계산하기 전) B층을 건너뛰고 A층의 값을 그대로 돌려준다.
 * - A층이 값을 돌려줬으면 B층의 전체 결과(스캔 실패 포함)를 합친다(`withReaped`).
 */
export async function stopThenReap(stop: () => Promise<StopOutcome>, deps: ReapDeps | null): Promise<StopOutcome> {
  let out: StopOutcome;
  try {
    out = await stop();
  } catch (e) {
    if (deps !== null) await reapOwned(deps);
    throw e;
  }
  if (deps === null) return out;
  const run = await reapOwned(deps);
  return withReaped(out, run, (pid) => deps.exists(pid));
}
