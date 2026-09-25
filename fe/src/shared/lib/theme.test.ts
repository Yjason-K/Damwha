import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  applyTheme,
  browserThemeEnv,
  createThemeStore,
  parsePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemeEnv,
} from "./theme";

/** 조작 가능한 가짜 환경. 저장소·시스템 설정·다른 탭 이벤트를 테스트가 직접 움직인다. */
function fakeEnv(init: { stored?: string | null; systemDark?: boolean } = {}) {
  let stored = init.stored ?? null;
  let systemDark = init.systemDark ?? false;
  let readThrows = false;
  let writeThrows = false;
  const systemListeners = new Set<() => void>();
  const storageListeners = new Set<(key: string | null) => void>();
  const applied: ResolvedTheme[] = [];
  const env: ThemeEnv = {
    readStored: () => {
      if (readThrows) throw new Error("SecurityError");
      return stored;
    },
    writeStored: (v) => {
      if (writeThrows) throw new Error("QuotaExceededError");
      stored = v;
    },
    systemDark: () => systemDark,
    onSystemChange: (cb) => {
      systemListeners.add(cb);
      return () => systemListeners.delete(cb);
    },
    onStorage: (cb) => {
      storageListeners.add(cb);
      return () => storageListeners.delete(cb);
    },
    apply: (r) => applied.push(r),
  };
  return {
    env,
    applied,
    get stored() {
      return stored;
    },
    setSystemDark(v: boolean) {
      systemDark = v;
      systemListeners.forEach((l) => l());
    },
    otherTabWrites(key: string | null, value: string | null) {
      stored = value;
      storageListeners.forEach((l) => l(key));
    },
    failReads() {
      readThrows = true;
    },
    failWrites() {
      writeThrows = true;
    },
    listenerCount: () => systemListeners.size + storageListeners.size,
  };
}

describe("resolveTheme", () => {
  it.each([
    ["system", false, "light"],
    ["system", true, "dark"],
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
  ] as const)("%s + 시스템 다크=%s → %s", (pref, systemDark, expected) => {
    expect(resolveTheme(pref, systemDark)).toBe(expected);
  });
});

describe("parsePreference", () => {
  it.each(["system", "light", "dark"])("%s는 그대로", (v) => {
    expect(parsePreference(v)).toBe(v);
  });
  it.each([null, undefined, "", "Dark", "auto", '{"v":"dark"}', 1])(
    "%s는 system으로 떨어진다",
    (v) => {
      expect(parsePreference(v)).toBe("system");
    },
  );
});

describe("createThemeStore", () => {
  it("저장값이 없으면 system이고, 시스템 설정으로 해석한다", () => {
    const f = fakeEnv({ systemDark: true });
    const store = createThemeStore(f.env);
    expect(store.getSnapshot()).toEqual({ preference: "system", resolved: "dark" });
  });

  it("start()는 현재 해석을 한 번 적용한다", () => {
    const f = fakeEnv({ stored: "dark" });
    const store = createThemeStore(f.env);
    store.start();
    expect(f.applied).toEqual(["dark"]);
  });

  it("읽기가 던지면 system으로 시작한다", () => {
    const f = fakeEnv({ stored: "dark", systemDark: false });
    f.failReads();
    const store = createThemeStore(f.env);
    expect(store.getSnapshot()).toEqual({ preference: "system", resolved: "light" });
  });

  it("오염된 저장값은 system으로 본다", () => {
    const f = fakeEnv({ stored: "Dark", systemDark: false });
    expect(createThemeStore(f.env).getSnapshot().preference).toBe("system");
  });

  it("setPreference는 저장하고 적용하고 구독자에게 알린다", () => {
    const f = fakeEnv();
    const store = createThemeStore(f.env);
    const listener = vi.fn();
    store.subscribe(listener);
    store.setPreference("dark");
    expect(f.stored).toBe("dark");
    expect(f.applied).toEqual(["dark"]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ preference: "dark", resolved: "dark" });
  });

  it("쓰기가 던져도 이번 세션에는 고른 테마가 적용된다", () => {
    const f = fakeEnv();
    f.failWrites();
    const store = createThemeStore(f.env);
    store.setPreference("dark");
    expect(f.applied).toEqual(["dark"]);
    expect(store.getSnapshot().preference).toBe("dark");
  });

  it("같은 값을 다시 고르면 알리지 않는다 — 스냅샷이 같아야 useSyncExternalStore가 다시 그리지 않는다", () => {
    const f = fakeEnv();
    const store = createThemeStore(f.env);
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setPreference("system");
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
  });

  it("system일 때 macOS 전환을 따른다", () => {
    const f = fakeEnv({ systemDark: false });
    const store = createThemeStore(f.env);
    store.start();
    f.setSystemDark(true);
    expect(store.getSnapshot().resolved).toBe("dark");
    expect(f.applied).toEqual(["light", "dark"]);
  });

  it("직접 고른 값은 macOS 전환에 흔들리지 않는다", () => {
    const f = fakeEnv({ stored: "light", systemDark: false });
    const store = createThemeStore(f.env);
    store.start();
    f.setSystemDark(true);
    expect(store.getSnapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(f.applied).toEqual(["light"]);
  });

  it("다른 탭의 변경을 따른다", () => {
    const f = fakeEnv();
    const store = createThemeStore(f.env);
    store.start();
    f.otherTabWrites(THEME_STORAGE_KEY, "dark");
    expect(store.getSnapshot().preference).toBe("dark");
  });

  it("다른 탭이 저장소를 통째로 비우면(key=null) system으로 돌아간다", () => {
    const f = fakeEnv({ stored: "dark", systemDark: false });
    const store = createThemeStore(f.env);
    store.start();
    f.otherTabWrites(null, null);
    expect(store.getSnapshot()).toEqual({ preference: "system", resolved: "light" });
  });

  it("다른 키의 storage 이벤트는 무시한다", () => {
    const f = fakeEnv({ stored: "dark" });
    const store = createThemeStore(f.env);
    store.start();
    f.otherTabWrites("damwha:tour", "x");
    expect(store.getSnapshot().preference).toBe("dark");
  });

  it("start()의 반환값이 리스너를 모두 뗀다", () => {
    const f = fakeEnv();
    const stop = createThemeStore(f.env).start();
    expect(f.listenerCount()).toBe(2);
    stop();
    expect(f.listenerCount()).toBe(0);
  });
});

describe("applyTheme", () => {
  afterEach(() => {
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
  });

  it("dark면 클래스와 color-scheme을 붙이고, light면 뗀다", () => {
    const root = document.documentElement;
    applyTheme(root, "dark");
    expect(root).toHaveClass("dark");
    expect(root.style.colorScheme).toBe("dark");
    applyTheme(root, "light");
    expect(root).not.toHaveClass("dark");
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("browserThemeEnv", () => {
  it("matchMedia가 없으면(jsdom) 던지지 않고 라이트로 본다", () => {
    const w = { ...window, matchMedia: undefined } as unknown as Window;
    const env = browserThemeEnv(w);
    expect(env.systemDark()).toBe(false);
    expect(() => env.onSystemChange(() => {})()).not.toThrow();
  });

  it("matchMedia가 있으면 그 결과와 change 이벤트를 쓴다", () => {
    const listeners: Array<() => void> = [];
    const mq = {
      matches: true,
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    const w = {
      ...window,
      matchMedia: vi.fn(() => mq),
    } as unknown as Window;
    const env = browserThemeEnv(w);
    expect(w.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");
    expect(env.systemDark()).toBe(true);
    const cb = vi.fn();
    const off = env.onSystemChange(cb);
    listeners.forEach((l) => l());
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(mq.removeEventListener).toHaveBeenCalledWith("change", cb);
  });
});
