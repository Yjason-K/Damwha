/**
 * "창이 지금 담화 화면(렌더러)을 보고 있는가" 래치의 **판정부**.
 *
 * 판정만 떼어 두는 이유: Task 12는 이것을 main.ts의 boolean 하나(`rendererAttached`)로 뒀다.
 * 올리는 곳은 reattachWindow, 내리는 곳은 showShell 하나뿐이라 창을 닫아도 내려가지 않았고,
 * 그 뒤에는 embed가 31초 뒤 ready가 되는 것도, worker의 stand-down 경고도, degraded API도
 * 전부 supervisor.log에서 끝났다 (Task 12 리뷰 Critical-1). **래치가 자기가 기술하는 창보다
 * 오래 살았다는 것**이 결함의 전부다. 그래서 boolean이 아니라 "어느 창에 붙였나"를 들고
 * 그것이 지금 창인지 비교한다 — 창이 갈리면 래치는 저절로 낡는다.
 *
 * main.ts에 두면 어떤 테스트도 이것을 부를 수 없다(electron을 값으로 import하는 파일은
 * vitest가 못 불러온다 — shell-window.ts:4). 그래서 BrowserWindow가 아니라 동일성만 보는
 * 제네릭을 받는다. 창을 고르는 배선은 main.ts에 남고, 규칙은 여기서 돈다.
 */

/**
 * 감독자의 상태 갱신이 `current` 창에 셸(준비/실패) 화면을 다시 그려도 되는가.
 *
 * showStatus는 loadFile이라, 사용자가 앱을 쓰는 중에 부르면 보던 것이 준비 화면으로 갈아
 * 끼워진다. ready 이후의 사망은 감독자가 백오프로 되살리는 중이므로(스펙 §6.8) 그 복구를
 * 화면 전환으로 덮지 않는다 — 그것이 false를 돌려주는 유일한 경우다.
 *
 * 파괴 여부는 보지 않는다. 부르는 쪽(main.ts의 activeWindow)이 파괴된 창을 이미 걸러 내므로
 * 여기서 한 번 더 보면 어느 쪽도 혼자서는 하중을 받지 않는 두 줄이 되고, 그러면 둘 중 무엇을
 * 지워도 테스트가 초록으로 남는다 — 이 프로젝트가 반복해 온 모양이 정확히 그것이다.
 */
export function mayRenderShell<T extends object>(attached: T | null, current: T): boolean {
  // 아무 창에도 붙이지 않았다 = 지금 떠 있는 것이 셸 화면이다. 갱신해서 잃을 것이 없다.
  if (attached === null) return true;
  // 붙여 둔 창이 지금 창이 아니다 — 닫고 다시 열었거나 다른 창이다. 저 래치는 낡았다.
  return attached !== current;
}
