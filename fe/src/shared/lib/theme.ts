/**
 * 화면 테마 — 선택(system/light/dark)을 저장하고, 시스템 설정과 합쳐 해석하고, <html>에 적용한다.
 *
 * 첫 페인트는 `index.html`의 인라인 스크립트가 맡는다. 그 스크립트는 모듈을 import할 수 없어
 * `parsePreference`·`resolveTheme`의 규칙을 손으로 한 벌 더 들고 있다 — 둘이 어긋나면
 * `app/theme-inline-script.test.ts`가 잡는다. 여기를 고치면 그쪽도 고친다.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type ThemeSnapshot = {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
};

export const THEME_STORAGE_KEY = "damwha:theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parsePreference(raw: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(raw as ThemePreference)
    ? (raw as ThemePreference)
    : "system";
}

export function resolveTheme(
  pref: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** `color-scheme`까지 바꿔야 스크롤바·폼 기본 컨트롤·<select> 팝업이 따라온다. */
export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/** 저장소가 바깥 세계와 닿는 면. 테스트는 이것을 가짜로 바꿔 끼운다. */
export interface ThemeEnv {
  /** 던질 수 있다 — 사이트 데이터가 막힌 브라우저. */
  readStored(): string | null;
  /** 던질 수 있다. */
  writeStored(v: string): void;
  systemDark(): boolean;
  onSystemChange(cb: () => void): () => void;
  /** 다른 탭의 저장소 변경. `localStorage.clear()`면 key가 null이다. */
  onStorage(cb: (key: string | null) => void): () => void;
  apply(resolved: ResolvedTheme): void;
}

export function createThemeStore(env: ThemeEnv) {
  const readPreference = (): ThemePreference => {
    try {
      return parsePreference(env.readStored());
    } catch {
      return "system";
    }
  };

  let preference = readPreference();
  let snapshot: ThemeSnapshot = {
    preference,
    resolved: resolveTheme(preference, env.systemDark()),
  };
  const listeners = new Set<() => void>();

  // 바뀐 것이 있을 때만 새 스냅샷을 만든다 — useSyncExternalStore는 참조가 바뀌면 다시 그린다.
  const recompute = () => {
    const resolved = resolveTheme(preference, env.systemDark());
    if (resolved === snapshot.resolved && preference === snapshot.preference) {
      return;
    }
    const resolvedChanged = resolved !== snapshot.resolved;
    snapshot = { preference, resolved };
    if (resolvedChanged) env.apply(resolved);
    listeners.forEach((l) => l());
  };

  return {
    getSnapshot: (): ThemeSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPreference(next: ThemePreference): void {
      try {
        env.writeStored(next);
      } catch {
        // 저장에 실패해도 이번 세션에는 고른 테마가 적용된다 — 다음 실행에는 system으로 돌아간다.
      }
      preference = next;
      recompute();
    },
    /** 한 번만 부른다(main.tsx). 반환값은 리스너를 뗀다. */
    start(): () => void {
      env.apply(snapshot.resolved);
      const offSystem = env.onSystemChange(recompute);
      const offStorage = env.onStorage((key) => {
        if (key !== null && key !== THEME_STORAGE_KEY) return;
        preference = readPreference();
        recompute();
      });
      return () => {
        offSystem();
        offStorage();
      };
    },
  };
}

export function browserThemeEnv(w: Window = window): ThemeEnv {
  // jsdom과 일부 WebView에는 matchMedia가 없다 — 그때는 시스템이 라이트라고 본다.
  const mq = typeof w.matchMedia === "function" ? w.matchMedia(DARK_QUERY) : null;
  return {
    readStored: () => w.localStorage.getItem(THEME_STORAGE_KEY),
    writeStored: (v) => w.localStorage.setItem(THEME_STORAGE_KEY, v),
    systemDark: () => mq?.matches ?? false,
    onSystemChange(cb) {
      if (!mq) return () => {};
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    onStorage(cb) {
      const handler = (e: StorageEvent) => cb(e.key);
      w.addEventListener("storage", handler);
      return () => w.removeEventListener("storage", handler);
    },
    apply: (resolved) => applyTheme(w.document.documentElement, resolved),
  };
}

export const themeStore = createThemeStore(browserThemeEnv());
