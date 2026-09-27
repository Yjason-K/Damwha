/**
 * 앱이 띄운 다른 모달(재시작 안내·ask() 대화상자)이 떠 있는가 (Phase 6b-1 스펙 §4.4).
 * 자동 업데이트 알림이 그 위에 겹치지 않게 한다. 업데이트 대화상자 자신은 세지 않는다 — 그것은
 * update-flow.ts의 표시 잠금이 막는다.
 */
export interface ModalTracker {
  track<T>(p: Promise<T>): Promise<T>;
  isOpen(): boolean;
}

export function createModalTracker(): ModalTracker {
  let open = 0;
  return {
    track(p) {
      open++;
      return p.finally(() => {
        open--;
      });
    },
    isOpen: () => open > 0,
  };
}
