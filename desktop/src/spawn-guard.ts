/**
 * "이 호출이 아직 자식을 띄우고 화면을 건드려도 되는가" 판정.
 *
 * 이름은 **가장 비싼 소비자**에서 왔다. 이 술어가 틀렸을 때 잃는 것은 화면 한 장이 아니라,
 * `app.quit()` **뒤에** 뜬 `docker compose up -d` 하나와 detached 자식 둘 — 아무도 정리하지
 * 않는 프로세스다. 감독자가 선 뒤로는 감독자 자신의 stopping/pending이 그 일을 하므로,
 * 구멍은 `supervisor`가 아직 null인 구간 하나였고 Task 12가 Phase 1의 그 검사를 잃었다
 * (리뷰 Important-2).
 *
 * main.ts에 두면 어떤 테스트도 이것을 부를 수 없다(electron을 값으로 import하는 파일은
 * vitest가 못 불러온다 — shell-window.ts:4). electron 상태를 **읽는 일**은 main.ts에 남기고
 * 판정만 여기로 옮긴다. main.ts의 activeWindow도 같은 이 술어를 쓴다 — 같은 규칙을 두 벌
 * 적어 두면 한쪽만 고치는 사고가 나고, 그것이 activeWindow가 애초에 통합한 문제였다.
 */
export interface SpawnGate {
  /** before-quit이 이미 지나갔는가. 종료가 치운 것을 되살리면 안 된다. */
  quitting: boolean;
  /** 지금 최신 기동 세대. */
  generation: number;
  /** 이 호출이 시작될 때의 세대. 더 새 start()가 있으면 이 호출의 관찰은 이미 낡았다. */
  mine: number;
  /** 붙일 창이 아직 살아 있는가 (`win !== null && !win.isDestroyed()`). */
  hasWindow: boolean;
}

export function maySpawnServices(gate: SpawnGate): boolean {
  // 종료가 cancelRetry()를 이미 돌렸다. 여기서 자식을 띄우면 stopAll()은 그것을 못 본다.
  if (gate.quitting) return false;
  // 더 새로운 start()가 시작됐으면 이 호출은 물러난다.
  if (gate.mine !== gate.generation) return false;
  // 'closed'가 win을 null로 만들기 전에도 창은 파괴돼 있을 수 있다. 그 창에 loadFile을 부르면
  // 'Object has been destroyed'가 **동기로** 던져진다 — 읽는 쪽이 둘을 합쳐 넘긴다.
  return gate.hasWindow;
}
