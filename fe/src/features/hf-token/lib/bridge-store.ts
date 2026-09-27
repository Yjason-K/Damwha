import type { HfTokenAction, HfTokenState } from "../model/types";

/** main이 부르는 두 함수. 렌더러가 먼저 여는 채널이 아니다 — main이 묻고 이것이 답한다(스펙 §6.11). */
export interface HfTokenBridge {
  show(state: HfTokenState): void;
  next(): Promise<HfTokenAction>;
}

export interface HfTokenStore {
  bridge: HfTokenBridge;
  /** 화면의 동작을 main에게 — main이 다음에 next()를 물을 때 받는다. */
  send(action: HfTokenAction): void;
  subscribe(listener: () => void): () => void;
  /** null = main이 아직 show()를 부르지 않았다. */
  getSnapshot(): HfTokenState | null;
}

export function createHfTokenStore(): HfTokenStore {
  let state: HfTokenState | null = null;
  const listeners = new Set<() => void>();
  const queued: HfTokenAction[] = [];
  const waiting: Array<(action: HfTokenAction) => void> = [];

  return {
    bridge: {
      show(next) {
        state = next;
        for (const l of listeners) l();
      },
      next() {
        const action = queued.shift();
        if (action !== undefined) return Promise.resolve(action);
        return new Promise((resolve) => waiting.push(resolve));
      },
    },
    send(action) {
      const resolve = waiting.shift();
      if (resolve !== undefined) resolve(action);
      else queued.push(action);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
  };
}

/** 앱 하나에 하나. installDesktopBridge가 이 bridge를 window에 건다. */
export const hfTokenStore = createHfTokenStore();
