/** 셀렉터가 DOM에 나타날 때까지 기다린다. 타임아웃이면 null — 호출자가 단계를 건너뛴다. */
export function waitFor(selector: string, timeoutMs = 3000): Promise<HTMLElement | null> {
  const found = document.querySelector<HTMLElement>(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        clearTimeout(timer);
        obs.disconnect();
        resolve(el);
      }
    });
    const timer = setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeoutMs);
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

export function tourSelector(name: string): string {
  return `[data-tour="${name}"]`;
}

/** data-tour 요소를 누른다. 요소가 버튼이 아니면 그 안의 첫 버튼을 누른다. */
export function clickTour(name: string): boolean {
  const el = document.querySelector<HTMLElement>(tourSelector(name));
  if (!el) return false;
  const target = el instanceof HTMLButtonElement ? el : el.querySelector<HTMLElement>("button");
  if (!target) return false;
  target.click();
  return true;
}

/** React가 관리하는 input에 값을 넣는다(native setter + input 이벤트). */
export function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
