import type { ServiceStatus } from "./services/types";

/**
 * 창을 **다시** 열었을 때의 순서 결정. 서비스는 이미 떠 있으므로 다시 띄우지 않는다 —
 * 여기서 하는 일은 "사용자가 보는 것이 언제 무엇이 되는가"뿐이다.
 *
 * 이 순서가 판정인 이유: Task 12의 `activate`는 창을 만들고 곧바로 붙이기로 갔다. 그 사이
 * 창은 빈 흰 화면이고(dev에서 Vite가 죽어 있으면 rendererTarget이 재기동 + waitForReady
 * 30초를 통째로 그렇게 돈다), `loadURL`이 거부하면 로그 한 줄로 끝나 **빈 창에 영구히**
 * 머물렀다 — 기동 경로는 같은 거부를 실패 화면 + 재시도로 바꾸는데 이쪽만 그 안전망이
 * 없었다 (리뷰 Important-3, 완료 기준 P2-C12).
 *
 * 잎(loadFile·loadURL·대화상자)은 전부 electron이라 main.ts에 남는다. 그것들을 주입으로
 * 받는 이유는 **순서 자체가 프로덕션 코드**이기 때문이다 — main.ts에 두면 셸을 붙이기
 * 뒤로 옮기는 변이도, catch를 지우는 변이도 초록불로 살아남는다.
 */
export interface WindowFlowDeps {
  /** 셸(준비/실패) 화면을 건다. 래치도 함께 내려가 이후 상태 갱신이 이 창에 닿는다. */
  showShell(): Promise<void>;
  /**
   * 붙일 것이 있는가 — 게이트를 다 넘어 API가 떠 있는가 (main.ts: `gateUp(supervisor?.statuses())`).
   * 아니면 붙이지 않고 기동(=재시도)으로 간다.
   */
  readyToAttach(): boolean;
  /** 서비스를 (다시) 띄운다. 준비 화면은 그 경로가 스스로 건다 (main.ts의 start). */
  start(): Promise<void>;
  /** 담화 화면을 붙인다. */
  attach(): Promise<void>;
  /** 붙이기 실패를 화면과 재시도로 바꾼다 (main.ts의 reportFailure). */
  onFailure(e: unknown): Promise<void>;
}

/**
 * 계약: **onFailure의 거부는 삼키지 않고 그대로 올린다.** 여기서 삼키면 main.ts의
 * `.catch(…)` 한 줄이 죽고, 그 줄은 "붙이기도 실패했고 실패 처리도 실패했다"는 이중 실패의
 * 유일한 기록이다 — 하필 화면이 이미 잘못된 순간이라 로그가 가장 필요한 때다. start()의
 * 거부도 같은 이유로 그대로 올린다. 부르는 쪽이 void 프라미스로 띄우므로 거부를 잡지 않으면
 * Electron main의 uncaught exception이 되고, 그래서 main.ts가 반드시 .catch를 단다.
 */
export async function openWindowFlow(deps: WindowFlowDeps): Promise<void> {
  try {
    // **먼저** 셸을 건다. 이 한 줄이 "빈 흰 창 최대 30초"와 "지금 서비스가 어떤 상태인지"를
    // 가른다.
    await deps.showShell();
  } catch {
    // 셸을 못 걸었다고 붙이기를 포기하지 않는다. 붙이기가 성공하면 그것이 곧 화면이고,
    // 실패하면 아래 onFailure가 다시 화면을 시도한다. 여기서 물러나면 창은 빈 채로 남는다.
  }
  if (!deps.readyToAttach()) {
    // 붙일 것이 없다. 두 경우다.
    //
    // (1) 게이트가 넘어진 채 창이 닫혔다 (Task 14). 창이 없으면 자동 재시도는 헛돌고(스폰 가드가
    // 창 없는 기동을 막는다) 걸려 있던 타이머도 다음을 걸지 못한다. 예전에는 여기서 붙이기로 가
    // reattachWindow가 카운트다운 없는 실패 화면을 걸었다 — 거짓은 아니었지만 사용자가 돌아온 순간
    // 앱이 아무것도 하지 않았다. 기동으로 가면 재시도가 돌고, 또 넘어지면 **실제로 걸린** 타이머의
    // 초를 화면이 말한다. 화면의 카운트다운과 걸린 타이머가 늘 같은 자리(scheduleRetry)에서 나온다.
    //
    // (2) 감독자가 아예 없다. 첫 기동이 감독자를 세우기 **전에** 접혔다는 뜻이고,
    // 그 길은 실제로 있다: resolveRepoRoot의 폴더 선택 대화상자는 시간 상한이 없고, 그 사이
    // 창을 닫으면(⌘Q가 아니라 그냥 닫기 — 스펙 §6.10이 허용한다) 스폰 가드가 기동을 접는다.
    // 그때 재시도 타이머는 걸리지 않는다(걸 자리가 없다). 여기서 start()를 부르지 않으면
    // 창을 다시 열어도 서비스 줄이 한 줄도 없는 빈 "준비 중" 화면에 영구히 선다 — 탈출구는
    // 메뉴의 "다시 시도"뿐이고 화면에는 그 안내가 없다 (재리뷰 §4-3).
    await deps.start();
    return;
  }
  try {
    await deps.attach();
  } catch (e) {
    await deps.onFailure(e);
  }
}

export interface MenuRetryGate {
  /** before-quit이 이미 지나갔다. */
  quitting: boolean;
  /** 메인 창이 살아 있다 (`win !== null && !win.isDestroyed()`). */
  hasWindow: boolean;
}

/**
 * 메뉴의 "다시 시도"가 할 일.
 *
 * - `"ignore"` — 종료 중이다. 재시도가 세대 번호를 올리고 화면을 건드리는 것은 종료가 방금
 *   치운 것을 되살리는 길이다.
 * - `"start"` — 창이 있다. 기동 경로가 준비 화면부터 스스로 건다.
 * - `"open-window"` — 창이 **없다.** 창부터 열고 기동한다.
 *
 * 세 번째 갈래가 이 함수가 생긴 이유다. 창이 없을 때 앱은 자동 재시도를 하지 않는다 — 기동
 * 경로는 창에 준비·실패 화면을 거는 일과 한 몸이고, 스폰 가드(spawn-guard.ts)가 창 없는 기동을
 * 일부러 막는다(창을 닫은 사람 몰래 docker compose와 자식 둘을 띄우지 않는다). 그래서 걸려 있던
 * 재시도 타이머도 창이 닫히면 헛돈다. 그렇다면 **메뉴의 재시도가 유일한 복구**여야 하는데,
 * 예전에는 start() → startOnce()가 `win === null`에서 곧장 물러나 창을 닫고 누른 재시도가
 * 아무 일도 하지 않았다. macOS에서 창을 다 닫아도 메뉴 막대는 살아 있으므로 이것은 평범한 경로다.
 */
export function decideMenuRetry(gate: MenuRetryGate): "ignore" | "start" | "open-window" {
  if (gate.quitting) return "ignore";
  return gate.hasWindow ? "start" : "open-window";
}

/**
 * 게이트를 다 넘었는가 — API가 떠 있는가. 렌더러는 API origin에 붙으므로 이것이 "붙일 수 있다"다.
 * degraded여도 떠 있다(DB가 끊겨도 API는 살아 503을 주고, 화면은 붙어 있어야 회복을 본다).
 *
 * 기동 경로(startServices)와 창 다시 열기(openWindowFlow)가 **같은 술어**를 쓴다. 둘이 따로 적혀
 * 있으면 한쪽은 "재시도 + 카운트다운"으로, 다른 쪽은 "붙이기"로 가는 어긋남이 생긴다.
 */
export function gateUp(statuses: readonly ServiceStatus[] | null): boolean {
  return statuses?.find((s) => s.id === "api")?.process === "running";
}
