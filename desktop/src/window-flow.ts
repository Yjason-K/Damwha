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
  /** 담화 화면을 붙인다. */
  attach(): Promise<void>;
  /** 붙이기 실패를 화면과 재시도로 바꾼다 (main.ts의 reportFailure). */
  onFailure(e: unknown): Promise<void>;
}

export async function openWindowFlow(deps: WindowFlowDeps): Promise<void> {
  try {
    // **먼저** 셸을 건다. 이 한 줄이 "빈 흰 창 최대 30초"와 "지금 서비스가 어떤 상태인지"를
    // 가른다.
    await deps.showShell();
  } catch {
    // 셸을 못 걸었다고 붙이기를 포기하지 않는다. 붙이기가 성공하면 그것이 곧 화면이고,
    // 실패하면 아래 onFailure가 다시 화면을 시도한다. 여기서 물러나면 창은 빈 채로 남는다.
  }
  try {
    await deps.attach();
  } catch (e) {
    await deps.onFailure(e);
  }
}
