# 다크 테마 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 담화 fe 전체를 다크 테마로 읽히게 하고, 기본은 시스템 설정을 따르되 사이드바에서 시스템/라이트/다크를 고르게 한다. 데스크톱은 창 바탕과 셸 창만 macOS 설정에 맞춘다.

**Architecture:** `index.css`의 `.dark` 블록이 원시 스케일·별칭·그림자를 다시 정의하고 `<html class="dark">`가 스위치다. 첫 페인트 전 `index.html` 인라인 스크립트가 클래스를 붙이고, 이후 `shared/lib/theme.ts` 저장소(`useSyncExternalStore`)가 선택·시스템 변경·다른 탭 변경을 따른다. 사이드바 하단의 Radix DropdownMenu가 선택 UI다.

**Tech Stack:** React 19, Vite 8, Tailwind 4(CSS-first), `radix-ui` 1.6(DropdownMenu), Vitest + jsdom + Testing Library + user-event, Electron(`nativeTheme`), desktop Vitest(node).

**Spec:** `docs/superpowers/specs/2026-09-25-dark-theme-design.md`

## Global Constraints

- 브랜치 `feat/dark-theme`, 워크트리 `/Users/jason/projects/Damwha2-dark-theme`, 기준 `dev`.
- **`npm install` 금지** — 의존성 추가 없음(Radix DropdownMenu는 이미 `radix-ui`에 들어 있다).
- 명령은 루트에서 `pnpm fe <script>` / `pnpm --filter damwha-desktop exec vitest run …`. **`pnpm desktop exec`는 테스트 0개로 exit 0이 나는 거짓 초록불이다 — 쓰지 않는다.**
- 저장 키는 정확히 `damwha:theme`, 값은 `"system" | "light" | "dark"`, 기본 `"system"`.
- 매체 쿼리 문자열은 정확히 `(prefers-color-scheme: dark)`.
- 다크 값은 스펙 §3.2·§3.3·§3.4 표 그대로 — 표에 없는 값을 만들지 않는다.
- 화자 `-solid`, `--red-9`, `brand-mark.tsx`, `index.html`의 `theme-color`는 바꾸지 않는다.
- `fe/DESIGN.md`에는 토큰 **이름**만 쓴다 — 값을 옮겨 적지 않는다(`fe/CLAUDE.md` 규칙).
- desktop-bridge의 "main → 렌더러 한 방향" 계약을 깨지 않는다 — 렌더러 → main 채널 없음.
- 커밋 메시지는 저장소 관례(`feat(fe): …`, 한국어 본문)로 쓰고 끝에 다음 줄을 붙인다:
  `Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W`
- 코드를 고친 뒤 루트에서 `graphify update .`(마지막 Task에서 한 번).

## Review Focus

1. **`matchMedia`가 없는 환경**(jsdom, 오래된 WebView) — 던지지 않고 라이트로 해석해야 한다. → Task 1 `browserThemeEnv` 테스트, Task 2 인라인 스크립트 테스트.
2. **저장소 접근이 던지는 브라우저**(차단된 사이트 데이터·일부 사생활 모드) — 읽기 실패는 `"system"`, 쓰기 실패여도 이번 세션에는 고른 테마가 적용돼야 한다. → Task 1, Task 2.
3. **저장값이 오염됨**(`"Dark"`, `""`, 옛 형식 JSON) — `"system"`으로 떨어져야 한다. → Task 1, Task 2.
4. **라이트/다크를 직접 고른 상태에서 macOS가 바뀜** — 직접 고른 값이 이겨야 하고 화면이 바뀌면 안 된다. `"system"`일 때만 따라간다. → Task 1.
5. **다른 탭이 `localStorage.clear()`** — `storage` 이벤트의 `key`가 `null`로 온다. 이 탭도 `"system"`으로 돌아가야 한다. → Task 1.

---

## File Structure

| 파일 | 책임 |
| --- | --- |
| `fe/src/shared/lib/theme.ts` (신규) | 선택 파싱·해석 규칙, 저장소(`createThemeStore`), 브라우저 환경 어댑터, 싱글턴 `themeStore` |
| `fe/src/shared/lib/use-theme.ts` (신규) | `useTheme()` 훅 — 저장소를 React에 잇는다 |
| `fe/index.html` | 첫 페인트 전 인라인 스크립트 |
| `fe/src/main.tsx` | `themeStore.start()` 한 번 |
| `fe/src/index.css` | 새 토큰(`:root`), `.dark` 블록 |
| `fe/src/features/theme/ui/theme-menu.tsx` (신규) | 사이드바 테마 버튼 + 드롭다운 |
| `fe/src/features/meeting/ui/icons.tsx` | `sun`·`moon`·`monitor` 글리프 |
| `fe/src/features/meeting/ui/left-nav.tsx` | 하단 줄에 `ThemeMenu` |
| `fe/src/shared/ui/{switch,tooltip,toast,toaster,button,tag,command-bar,checkbox,utterance}.tsx`, `fe/src/features/meeting/ui/{left-nav,transcript-pane,player-bar}.tsx` | 하드코딩 색 → 토큰 |
| `fe/src/design-tokens.test.ts` | `.dark`⊂`:root`, raw 색 금지, 잉크 위 `text-white` 금지 |
| `desktop/src/windows/window-background.ts` (신규) | 창 바탕색 결정(순수) |
| `desktop/src/main.ts`, `desktop/src/windows/shell-window.ts` | `backgroundColor` |
| `desktop/shell/status.html`, `desktop/shell/services.html` | 다크 매체 쿼리 블록 + CSP 해시 |
| `desktop/tests/windows/shell-html.test.ts`, `desktop/tests/windows/window-background.test.ts` (신규) | 셸 다크 값·창 바탕 검증 |
| `fe/DESIGN.md`, `fe/CLAUDE.md`, `desktop/CLAUDE.md`, 스펙 §5 | 문서 |

---

### Task 1: 테마 저장소와 해석 규칙

**Files:**
- Create: `fe/src/shared/lib/theme.ts`
- Create: `fe/src/shared/lib/use-theme.ts`
- Test: `fe/src/shared/lib/theme.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ThemePreference = "system" | "light" | "dark"`
  - `type ResolvedTheme = "light" | "dark"`
  - `const THEME_STORAGE_KEY = "damwha:theme"`
  - `const THEME_PREFERENCES: readonly ThemePreference[]` (순서: system, light, dark)
  - `parsePreference(raw: unknown): ThemePreference`
  - `resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme`
  - `applyTheme(root: HTMLElement, resolved: ResolvedTheme): void`
  - `interface ThemeEnv { readStored(): string | null; writeStored(v: string): void; systemDark(): boolean; onSystemChange(cb: () => void): () => void; onStorage(cb: (key: string | null) => void): () => void; apply(r: ResolvedTheme): void }`
  - `type ThemeSnapshot = { readonly preference: ThemePreference; readonly resolved: ResolvedTheme }`
  - `createThemeStore(env: ThemeEnv): { getSnapshot(): ThemeSnapshot; subscribe(l: () => void): () => void; setPreference(p: ThemePreference): void; start(): () => void }`
  - `browserThemeEnv(w?: Window): ThemeEnv`
  - `themeStore` (싱글턴, `createThemeStore(browserThemeEnv())`)
  - `useTheme(): { preference: ThemePreference; resolved: ResolvedTheme; setPreference(p: ThemePreference): void }` (`use-theme.ts`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/shared/lib/theme.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test src/shared/lib/theme.test.ts`
Expected: FAIL — `Failed to resolve import "./theme"`.

- [ ] **Step 3: 구현한다**

`fe/src/shared/lib/theme.ts`:

```ts
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
```

`fe/src/shared/lib/use-theme.ts`:

```ts
import { useSyncExternalStore } from "react";

import { themeStore, type ThemePreference, type ResolvedTheme } from "./theme";

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
} {
  const snapshot = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
  );
  return { ...snapshot, setPreference: themeStore.setPreference };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm fe test src/shared/lib/theme.test.ts`
Expected: PASS (모든 케이스).

- [ ] **Step 5: 커밋한다**

```bash
git add fe/src/shared/lib/theme.ts fe/src/shared/lib/use-theme.ts fe/src/shared/lib/theme.test.ts
git commit -m "feat(fe): 화면 테마 저장소와 해석 규칙을 추가한다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 2: 첫 페인트 인라인 스크립트와 기동

**Files:**
- Modify: `fe/index.html` (`<head>` 안, `<meta name="viewport">` 바로 뒤)
- Modify: `fe/src/main.tsx`
- Test: `fe/src/app/theme-inline-script.test.ts`

**Interfaces:**
- Consumes: `parsePreference`, `resolveTheme`, `THEME_STORAGE_KEY`, `themeStore.start()` (Task 1)
- Produces: 로드 직후 `<html>`에 `.dark`/`color-scheme`이 붙어 있다는 불변식

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/app/theme-inline-script.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  THEME_STORAGE_KEY,
  parsePreference,
  resolveTheme,
} from "@/shared/lib/theme";

/**
 * index.html의 **실제** 인라인 스크립트를 뽑아 돌린다. 그 스크립트는 모듈을 import할 수 없어
 * theme.ts의 규칙을 한 벌 더 들고 있다 — 여기서 둘이 같은 답을 내는지 묶는다.
 */
const html = readFileSync(
  join(import.meta.dirname, "..", "..", "index.html"),
  "utf8",
);
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (m) => m[1],
);

type Case = {
  stored: string | null;
  systemDark: boolean;
  storageThrows?: boolean;
  noMatchMedia?: boolean;
};

function run(c: Case) {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    localStorage: {
      getItem(key: string) {
        if (c.storageThrows) throw new Error("SecurityError");
        return key === THEME_STORAGE_KEY ? c.stored : null;
      },
    },
    document: {
      documentElement: { classList: { add: (n: string) => classes.add(n) }, style },
    },
  };
  if (!c.noMatchMedia) {
    sandbox.matchMedia = (q: string) => ({
      matches: q === "(prefers-color-scheme: dark)" && c.systemDark,
    });
  }
  runInNewContext(inline[0], sandbox);
  return { dark: classes.has("dark"), colorScheme: style.colorScheme };
}

function expected(c: Case) {
  const pref = c.storageThrows ? "system" : parsePreference(c.stored);
  const resolved = resolveTheme(pref, c.noMatchMedia ? false : c.systemDark);
  return { dark: resolved === "dark", colorScheme: resolved };
}

describe("index.html 첫 페인트 스크립트", () => {
  it("속성 없는 인라인 스크립트가 딱 하나이고, 모듈 스크립트보다 먼저 온다", () => {
    expect(inline).toHaveLength(1);
    expect(html.indexOf("<script>")).toBeLessThan(
      html.indexOf('<script type="module"'),
    );
  });

  const stored = [null, "system", "light", "dark", "Dark", ""];
  for (const s of stored) {
    for (const systemDark of [false, true]) {
      const c = { stored: s, systemDark };
      it(`저장값=${JSON.stringify(s)} 시스템 다크=${systemDark} → theme.ts와 같다`, () => {
        expect(run(c)).toEqual(expected(c));
      });
    }
  }

  it("저장소가 던져도 멈추지 않고 시스템 설정을 따른다", () => {
    const c = { stored: "light", systemDark: true, storageThrows: true };
    expect(run(c)).toEqual(expected(c));
    expect(run(c).dark).toBe(true);
  });

  it("matchMedia가 없으면 라이트다", () => {
    const c = { stored: null, systemDark: true, noMatchMedia: true };
    expect(run(c)).toEqual({ dark: false, colorScheme: "light" });
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test src/app/theme-inline-script.test.ts`
Expected: FAIL — `expected [] to have a length of 1`.

- [ ] **Step 3: 인라인 스크립트를 넣는다**

`fe/index.html`의 `<meta name="viewport" … />` 줄 바로 뒤에 넣는다:

```html
    <!-- 첫 페인트 전 테마. 모듈을 기다리면 다크 사용자가 흰 화면을 한 번 본다.
         규칙은 src/shared/lib/theme.ts(parsePreference·resolveTheme)와 같아야 한다 —
         src/app/theme-inline-script.test.ts가 둘을 묶는다. -->
    <script>
      (function () {
        var pref = "system";
        try {
          pref = localStorage.getItem("damwha:theme");
        } catch (e) {}
        if (pref !== "light" && pref !== "dark") pref = "system";
        var dark =
          pref === "dark" ||
          (pref === "system" &&
            typeof matchMedia === "function" &&
            matchMedia("(prefers-color-scheme: dark)").matches);
        var root = document.documentElement;
        if (dark) root.classList.add("dark");
        root.style.colorScheme = dark ? "dark" : "light";
      })();
    </script>
```

- [ ] **Step 4: 기동에서 저장소를 시작한다**

`fe/src/main.tsx`:

```tsx
import "@/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { installDesktopBridge } from "@/features/meeting/lib/desktop-bridge";
import { themeStore } from "@/shared/lib/theme";

// 데스크톱 앱의 종료 handshake용 훅. 웹에서는 아무도 부르지 않는다.
installDesktopBridge();

// 인라인 스크립트가 붙인 테마를 이어받고, 시스템·다른 탭 변경을 따르기 시작한다.
// React 밖에서 한 번 — StrictMode의 이중 마운트가 리스너를 두 번 걸지 않게.
themeStore.start();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
```

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm fe test src/app/theme-inline-script.test.ts src/shared/lib/theme.test.ts`
Expected: PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add fe/index.html fe/src/main.tsx fe/src/app/theme-inline-script.test.ts
git commit -m "feat(fe): 첫 페인트 전에 테마를 정하고 기동 때 저장소를 시작한다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 3: 다크 토큰과 새 토큰

**Files:**
- Modify: `fe/src/index.css` (`:root` 블록에 새 토큰, `:root` 블록 바로 뒤 `@theme inline` 앞에 `.dark` 블록)
- Test: `fe/src/design-tokens.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: CSS 변수 `--surface-floating`, `--border-floating`, `--text-on-floating`, `--text-on-floating-muted`, `--toast-success`, `--toast-danger`, `--red-9-hover`, `--overlay-hover`, `--surface-scrim-soft` (Task 4가 쓴다), `.dark { … }` 블록(Task 6의 desktop 테스트가 파싱한다 — 선택자는 정확히 줄 머리의 `.dark {`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/design-tokens.test.ts`의 `describe("디자인 토큰", …)` 안, 기존 `it` 뒤에 추가한다:

```ts
  it(".dark 블록은 :root에 있는 변수만 덮는다 — 없는 이름을 덮으면 조용히 무시된다", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const block = (selector: RegExp) => {
      const m = selector.exec(css);
      expect(m, String(selector)).not.toBeNull();
      return new Set(
        [...m![1].matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((x) => x[1]),
      );
    };
    const root = block(/^:root\s*\{([^}]*)\}/m);
    const dark = block(/^\.dark\s*\{([^}]*)\}/m);
    expect(dark.size).toBeGreaterThan(40);
    expect([...dark].filter((t) => !root.has(t))).toEqual([]);
  });

  it("다크에서 뒤집히는 역할 토큰은 .dark가 모두 다시 정의한다", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const dark = /^\.dark\s*\{([^}]*)\}/m.exec(css)![1];
    for (const token of [
      "--gray-0",
      "--gray-12",
      "--accent-9",
      "--accent-11",
      "--text-on-accent",
      "--surface-floating",
      "--text-on-floating",
      "--text-on-floating-muted",
      "--overlay-hover",
      "--surface-scrim-soft",
      "--surface-overlay",
      "--shadow-md",
      "--spk-1-bg",
      "--spk-8-text",
    ]) {
      expect(dark, token).toMatch(new RegExp(`^\\s*${token}\\s*:`, "m"));
    }
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test src/design-tokens.test.ts`
Expected: FAIL — `/^\.dark\s*\{([^}]*)\}/m`가 null.

- [ ] **Step 3: `:root`에 새 토큰을 넣는다**

`fe/src/index.css`의 `:root` 안, `--focus-ring: …;` 줄 바로 뒤에 넣는다:

```css

  /* --- Floating layers (tooltip · toast) ---
   * Light keeps them deliberately dark so they pop off a light page. Dark
   * mode lifts them one step above the card instead of inverting them —
   * a bright slab on a dark reading screen glares. */
  --surface-floating: var(--gray-12);
  --border-floating: transparent;
  --text-on-floating: var(--gray-1);
  --text-on-floating-muted: var(--gray-7);
  /* Toast icons sit on the floating surface, which is dark in BOTH themes,
   * so the two values do not change with the theme. */
  --toast-success: #5fe3ad;
  --toast-danger: #f58c8c;

  /* --- One-off states that used to be raw values in components --- */
  --red-9-hover: #b03d3d;
  --overlay-hover: rgba(10, 10, 10, 0.06);
  --surface-scrim-soft: rgba(20, 23, 28, 0.28);
```

- [ ] **Step 4: `.dark` 블록을 넣는다**

`fe/src/index.css`에서 `:root { … }` 블록이 닫히는 `}` 바로 뒤, `/* shadcn color contract + Timbre extras → Tailwind utilities (theming-aware) */` 주석 앞에 넣는다:

```css

/* ============================================================
 * Dark theme — toggled by `class="dark"` on <html> (see
 * src/shared/lib/theme.ts and the inline script in index.html).
 *
 * Raw scales keep their NAMES and ROLES and only change value: --gray-0 is
 * still "the card surface" and --gray-12 still "body text". That is why the
 * components that reach for raw scales directly still land right.
 * Neutral black (not brand-ink blue) so speaker hues and mint stay true.
 * The primary button inverts to light ink; mint stays the signal colour.
 * Speaker -solid values are NOT redefined: they carry white initials in
 * both themes. Every value here comes from the 2026-09-25 dark-theme spec.
 * Must come after :root — same specificity, so source order decides.
 * ============================================================ */
.dark {
  --gray-0: #18181a;
  --gray-1: #111113;
  --gray-2: #0c0c0d;
  --gray-3: #232326;
  --gray-4: #2a2a2e;
  --gray-5: #37373c;
  --gray-6: #4a4a50;
  --gray-7: #6e6e75;
  --gray-8: #8b8b92;
  --gray-9: #a8a8ae;
  --gray-10: #c8c8cc;
  --gray-11: #e2e2e4;
  --gray-12: #ededed;

  --accent-1: #0d1f1a;
  --accent-2: #0f2a23;
  --accent-3: #133a30;
  --accent-6: #2fdcae;
  --accent-9: #ededed;
  --accent-10: #d4d4d8;
  --accent-11: #4fe0b9;
  --accent-12: #a6f2dd;

  --green-bg: #0f2417;
  --green-9: #3fae66;
  --green-text: #6fd394;
  --amber-bg: #2a1f0a;
  --amber-9: #d99a2b;
  --amber-text: #f0bd5e;
  --red-bg: #2c1414;
  --red-text: #f28b8b;

  --spk-1-bg: #1c2340;
  --spk-1-text: #9fb1f5;
  --spk-2-bg: #13291a;
  --spk-2-text: #7fd497;
  --spk-3-bg: #2b2210;
  --spk-3-text: #e7b95e;
  --spk-4-bg: #321a24;
  --spk-4-text: #f09bbb;
  --spk-5-bg: #251d3d;
  --spk-5-text: #bea5f3;
  --spk-6-bg: #1f2714;
  --spk-6-text: #aed17c;
  --spk-7-bg: #10262e;
  --spk-7-text: #7cc9e2;
  --spk-8-bg: #2f1c16;
  --spk-8-text: #f2a38b;

  --text-on-accent: #0a0a0a;
  --surface-overlay: rgba(0, 0, 0, 0.6);

  --surface-floating: #26262a;
  --border-floating: #34343a;
  --text-on-floating: #ededed;
  --text-on-floating-muted: #a8a8ae;
  --overlay-hover: rgba(255, 255, 255, 0.08);
  --surface-scrim-soft: rgba(0, 0, 0, 0.5);

  /* Faint shadows vanish on dark surfaces — same shapes, heavier black,
   * plus a hairline light ring on the floating ones. */
  --shadow-xs: 0 1px 1px rgba(0, 0, 0, 0.3);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35), 0 1px 1px rgba(0, 0, 0, 0.25);
  --shadow-md:
    0 6px 16px rgba(0, 0, 0, 0.5), 0 2px 5px rgba(0, 0, 0, 0.3),
    0 0 0 1px rgba(255, 255, 255, 0.04);
  --shadow-lg:
    0 16px 40px rgba(0, 0, 0, 0.6), 0 6px 14px rgba(0, 0, 0, 0.35),
    0 0 0 1px rgba(255, 255, 255, 0.05);
  --shadow-inset: inset 0 1px 2px rgba(0, 0, 0, 0.3);
}
```

그리고 파일 머리 주석의 ` * Mintlify-toned · light-first reading UI.` 줄을 ` * Mintlify-toned · light-first reading UI, with a full dark token set below.`로 바꾼다.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm fe test src/design-tokens.test.ts`
Expected: PASS (기존 1개 + 새 2개).

- [ ] **Step 6: 커밋한다**

```bash
git add fe/src/index.css fe/src/design-tokens.test.ts
git commit -m "feat(fe): 다크 토큰 세트와 떠 있는 층·일회성 상태 토큰을 추가한다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 4: 하드코딩 색을 토큰으로

**Files:**
- Modify: `fe/src/features/meeting/ui/left-nav.tsx:109`, `fe/src/features/meeting/ui/transcript-pane.tsx:103`, `fe/src/features/meeting/ui/player-bar.tsx:159`, `fe/src/shared/ui/utterance.tsx:250`, `fe/src/shared/ui/checkbox.tsx:75`, `fe/src/shared/ui/switch.tsx:31-33`, `fe/src/shared/ui/tooltip.tsx:51`, `fe/src/shared/ui/toast.tsx:43,88,105`, `fe/src/shared/ui/toaster.tsx:34-36`, `fe/src/shared/ui/button.tsx:22`, `fe/src/shared/ui/tag.tsx:89`, `fe/src/shared/ui/command-bar.tsx:97`
- Test: `fe/src/design-tokens.test.ts`

**Interfaces:**
- Consumes: Task 3의 새 토큰 이름들
- Produces: 없음

- [ ] **Step 1: 실패하는 가드 테스트를 쓴다**

`fe/src/design-tokens.test.ts`의 `describe` 안에 추가한다(파일 위쪽의 `walk`·`SRC` 재사용):

```ts
  it("컴포넌트는 raw 색(hex·rgba)을 쓰지 않는다 — brand-mark만 예외", () => {
    // 브랜드 마크는 테마를 따르지 않는 고정 색이다 (DESIGN.md §2).
    const ALLOWED = new Set(["shared/ui/brand-mark.tsx"]);
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) hits.push(`${rel}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("잉크(--accent-solid) 면 위 글자는 text-white가 아니라 --text-on-accent다 — 다크에서 잉크가 밝아진다", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith(".tsx")) continue;
      const rel = file.slice(SRC.length + 1);
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/var\(--accent-solid\)/.test(line) && /\btext-white\b/.test(line)) {
            hits.push(`${rel}:${i + 1}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test src/design-tokens.test.ts`
Expected: FAIL — 첫 테스트가 `shared/ui/toaster.tsx:34`, `toaster.tsx:36`, `switch.tsx:33`, `command-bar.tsx:97`, `button.tsx:22`를, 둘째가 `left-nav.tsx:109`, `transcript-pane.tsx:103`, `player-bar.tsx:159`, `checkbox.tsx:75`, `utterance.tsx:250`을 보고한다.

- [ ] **Step 3: 잉크 위 글자를 바꾼다**

다섯 곳에서 `text-white`를 `text-[color:var(--text-on-accent)]`로 바꾼다(각 줄의 나머지는 그대로):

- `fe/src/features/meeting/ui/left-nav.tsx:109` — `? "bg-[var(--accent-solid)] text-white"` → `? "bg-[var(--accent-solid)] text-[color:var(--text-on-accent)]"`
- `fe/src/features/meeting/ui/transcript-pane.tsx:103` — 같은 교체.
- `fe/src/features/meeting/ui/player-bar.tsx:159` — `bg-[var(--accent-solid)] text-white` → `bg-[var(--accent-solid)] text-[color:var(--text-on-accent)]`.
- `fe/src/shared/ui/utterance.tsx:250` — `bg-[var(--accent-solid)] text-white hover:bg-[color:var(--accent-text)]` → `bg-[var(--accent-solid)] text-[color:var(--text-on-accent)] hover:bg-[color:var(--accent-text)]`.
- `fe/src/shared/ui/checkbox.tsx:75` — `bg-card text-white` → `bg-card text-[color:var(--text-on-accent)]`.

- [ ] **Step 4: 스위치 손잡이**

`fe/src/shared/ui/switch.tsx`의 트랙 `<span>` className에서 `peer-checked:[&>span]:translate-x-[14px]` 뒤에 ` peer-checked:[&>span]:bg-[var(--text-on-accent)]`를 붙이고, 손잡이 `<span>`의 `shadow-[0_1px_2px_rgba(20,23,28,0.25)]`를 `[box-shadow:var(--shadow-xs)]`로 바꾼다. 결과:

```tsx
      <span
        aria-hidden="true"
        className="relative inline-flex h-[18px] w-8 shrink-0 rounded-full bg-[var(--gray-5)] transition-colors duration-[120ms] ease-[cubic-bezier(0.4,0,0.2,1)] peer-checked:bg-[var(--accent-solid)] peer-focus-visible:[box-shadow:var(--focus-ring)] peer-checked:[&>span]:translate-x-[14px] peer-checked:[&>span]:bg-[var(--text-on-accent)]"
      >
        <span className="absolute left-0.5 top-0.5 size-3.5 rounded-full bg-white [box-shadow:var(--shadow-xs)] transition-transform duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)]" />
      </span>
```

(켜짐: 라이트는 잉크 트랙 + 흰 손잡이 그대로, 다크는 밝은 트랙 + 검은 손잡이. 꺼짐 손잡이는 두 테마 모두 흰색 — 꺼진 트랙 `--gray-5`가 다크에서 `#37373c`라 잘 보인다.)

- [ ] **Step 5: 툴팁·토스트**

`fe/src/shared/ui/tooltip.tsx:51` — `bg-[var(--gray-12)]` → `border border-[color:var(--border-floating)] bg-[var(--surface-floating)]`, `text-[color:var(--gray-1)]` → `text-[color:var(--text-on-floating)]`. 같은 파일 8행 주석 `Dark surface (--gray-12 / --gray-1)`을 `Floating surface (--surface-floating / --text-on-floating)`로.

`fe/src/shared/ui/toast.tsx`:
- 43행 — `bg-[var(--gray-12)]` → `border border-[color:var(--border-floating)] bg-[var(--surface-floating)]`, `text-[color:var(--gray-1)]` → `text-[color:var(--text-on-floating)]`.
- 88행 — `hover:text-white` → `hover:text-[color:var(--text-on-floating)]`.
- 105행 — `text-[color:var(--gray-7)]` → `text-[color:var(--text-on-floating-muted)]`, `hover:text-white` → `hover:text-[color:var(--text-on-floating)]`.
- 8행 주석 `(dark --gray-12 surface)` → `(--surface-floating)`.

`fe/src/shared/ui/toaster.tsx:34-36`:

```ts
  const tone =
    variant === "success"
      ? "text-[color:var(--toast-success)]"
      : variant === "error"
        ? "text-[color:var(--toast-danger)]"
        : "text-[color:var(--accent-6)]";
```

- [ ] **Step 6: 나머지 셋**

- `fe/src/shared/ui/button.tsx:22` — `hover:bg-[#b03d3d]` → `hover:bg-[var(--red-9-hover)]`.
- `fe/src/shared/ui/tag.tsx:89` — `hover:bg-black/[0.06]` → `hover:bg-[var(--overlay-hover)]`.
- `fe/src/shared/ui/command-bar.tsx:97` — `bg-[rgba(20,23,28,0.28)]` → `bg-[var(--surface-scrim-soft)]`.

- [ ] **Step 7: 통과를 확인한다**

Run: `pnpm fe test`
Expected: PASS 전체. 기존 테스트 중 클래스 문자열(`text-white`, `bg-[var(--gray-12)]` 등)을 단정한 것이 깨지면, 그 단정을 새 토큰 이름으로 바꾼다 — 동작 단정은 건드리지 않는다.

- [ ] **Step 8: 커밋한다**

```bash
git add fe/src
git commit -m "refactor(fe): 하드코딩된 색을 테마를 따르는 토큰으로 옮긴다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 5: 사이드바 테마 메뉴

**Files:**
- Modify: `fe/src/features/meeting/ui/icons.tsx` (`PATHS`에 세 글리프)
- Create: `fe/src/features/theme/ui/theme-menu.tsx`
- Modify: `fe/src/features/meeting/ui/left-nav.tsx` (`</nav>` 직전 하단 줄)
- Test: `fe/src/features/theme/ui/theme-menu.test.tsx`

**Interfaces:**
- Consumes: `useTheme()`, `themeStore`, `parsePreference`, `THEME_STORAGE_KEY` (Task 1), `IconButton` (`@/shared/ui/icon-button`), `Icon`/`IconName` (`@/features/meeting/ui/icons`)
- Produces: `export function ThemeMenu(): JSX.Element`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/theme/ui/theme-menu.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";

import { THEME_STORAGE_KEY, themeStore } from "@/shared/lib/theme";

import { ThemeMenu } from "./theme-menu";

let stop: () => void;
beforeEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  themeStore.setPreference("system");
  stop = themeStore.start();
});
afterEach(() => {
  cleanup();
  stop();
  themeStore.setPreference("system");
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.className = "";
});

test("버튼 이름이 현재 선택을 말하고, 메뉴에서 현재 선택에 체크가 있다", async () => {
  const user = userEvent.setup();
  render(<ThemeMenu />);
  await user.click(screen.getByRole("button", { name: "화면 테마: 시스템" }));
  expect(
    await screen.findByRole("menuitemradio", { name: "시스템 설정 따르기" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(screen.getByRole("menuitemradio", { name: "다크" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("다크를 고르면 <html>이 다크가 되고 저장되며 버튼 이름이 바뀐다", async () => {
  const user = userEvent.setup();
  render(<ThemeMenu />);
  await user.click(screen.getByRole("button", { name: "화면 테마: 시스템" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "다크" }));
  expect(document.documentElement).toHaveClass("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(
    screen.getByRole("button", { name: "화면 테마: 다크" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("라이트로 돌아오면 다크 클래스가 빠진다", async () => {
  themeStore.setPreference("dark");
  const user = userEvent.setup();
  render(<ThemeMenu />);
  await user.click(screen.getByRole("button", { name: "화면 테마: 다크" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "라이트" }));
  expect(document.documentElement).not.toHaveClass("dark");
  expect(document.documentElement.style.colorScheme).toBe("light");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test src/features/theme/ui/theme-menu.test.tsx`
Expected: FAIL — `Failed to resolve import "./theme-menu"`.

- [ ] **Step 3: 글리프를 추가한다**

`fe/src/features/meeting/ui/icons.tsx`의 `PATHS`에서 `x: …,` 줄 앞에 넣는다(Lucide `sun`·`moon`·`monitor`와 같은 기하):

```ts
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z",
  monitor:
    "M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4",
```

- [ ] **Step 4: 메뉴를 구현한다**

`fe/src/features/theme/ui/theme-menu.tsx`:

```tsx
import { DropdownMenu } from "radix-ui";

import { Icon, type IconName } from "@/features/meeting/ui/icons";
import { parsePreference, type ThemePreference } from "@/shared/lib/theme";
import { useTheme } from "@/shared/lib/use-theme";
import { IconButton } from "@/shared/ui/icon-button";

/**
 * 좌측 사이드바 하단의 화면 테마 선택(스펙 2026-09-25 다크 테마 §5).
 * 팝오버에 role을 손으로 다는 대신 Radix DropdownMenu의 RadioGroup을 쓴다 — menuitemradio·
 * aria-checked·화살표 키 이동·Esc 닫기를 그대로 받는다.
 */
const OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  short: string;
  icon: IconName;
}> = [
  { value: "system", label: "시스템 설정 따르기", short: "시스템", icon: "monitor" },
  { value: "light", label: "라이트", short: "라이트", icon: "sun" },
  { value: "dark", label: "다크", short: "다크", icon: "moon" },
];

export function ThemeMenu() {
  const { preference, setPreference } = useTheme();
  const current = OPTIONS.find((o) => o.value === preference) ?? OPTIONS[0];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton size="sm" label={`화면 테마: ${current.short}`}>
          <Icon name={current.icon} size={15} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-[110] min-w-[176px] rounded-md border border-border bg-popover p-1 text-popover-foreground outline-none [box-shadow:var(--shadow-md)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DropdownMenu.Label className="px-2 pt-1 pb-1.5 text-2xs font-medium text-[color:var(--text-muted)]">
            화면 테마
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={preference}
            onValueChange={(v) => setPreference(parsePreference(v))}
          >
            {OPTIONS.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                className="flex cursor-pointer select-none items-center gap-2 rounded-xs px-2 py-1.5 text-sm text-foreground outline-none transition-colors duration-[80ms] data-[highlighted]:bg-accent"
              >
                <Icon
                  name={o.icon}
                  size={15}
                  className="text-[color:var(--text-secondary)]"
                />
                <span className="flex-1">{o.label}</span>
                <DropdownMenu.ItemIndicator>
                  <Icon
                    name="check"
                    size={14}
                    className="text-[color:var(--accent-text)]"
                  />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
```

- [ ] **Step 5: 메뉴 테스트 통과를 확인한다**

Run: `pnpm fe test src/features/theme/ui/theme-menu.test.tsx`
Expected: PASS 3개.

- [ ] **Step 6: 사이드바에 단다 — 실패하는 테스트 먼저**

`fe/src/features/meeting/ui/left-nav.test.tsx` 끝에 추가한다(파일의 기존 `render` 준비 — `QueryClientProvider` + `MemoryRouter` — 를 그대로 따른다):

```tsx
test("사이드바 맨 아래에 화면 테마 버튼이 있다", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <LeftNav filter="all" onFilter={() => {}} onOpenSearch={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const nav = screen.getByRole("navigation", { name: "주 탐색" });
  const button = screen.getByRole("button", { name: /^화면 테마: / });
  expect(nav).toContainElement(button);
});
```

Run: `pnpm fe test src/features/meeting/ui/left-nav.test.tsx`
Expected: FAIL — `Unable to find role="button" and name /^화면 테마: /`.

- [ ] **Step 7: 사이드바에 단다 — 구현**

`fe/src/features/meeting/ui/left-nav.tsx` 상단 import에 추가:

```tsx
import { ThemeMenu } from "@/features/theme/ui/theme-menu";
```

`{env.demoMode ? ( … ) : null}` 블록 뒤, `<NewMeetingDialog` 앞에 넣는다:

```tsx
      <div className="flex shrink-0 items-center border-t border-[color:var(--border-subtle)] px-3 py-1.5">
        <ThemeMenu />
      </div>
```

- [ ] **Step 8: 통과를 확인한다**

Run: `pnpm fe test src/features/meeting/ui src/features/theme`
Expected: PASS (`left-nav.demo.test.tsx` 포함 — 투어 버튼의 `data-tour`는 그대로다).

- [ ] **Step 9: 커밋한다**

```bash
git add fe/src/features/meeting/ui/icons.tsx fe/src/features/theme fe/src/features/meeting/ui/left-nav.tsx fe/src/features/meeting/ui/left-nav.test.tsx
git commit -m "feat(fe): 사이드바 하단에 화면 테마 메뉴를 단다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 6: 데스크톱 창 바탕과 셸 창

**Files:**
- Create: `desktop/src/windows/window-background.ts`
- Test: `desktop/tests/windows/window-background.test.ts`
- Modify: `desktop/src/main.ts:1` (import), `desktop/src/main.ts:310-319` (`createWindow`)
- Modify: `desktop/src/windows/shell-window.ts:1` (import), `:55-63`
- Modify: `desktop/shell/status.html`, `desktop/shell/services.html` (`<style>` 안 주석·`@media` 블록, CSP 메타의 `style-src` 해시)
- Modify: `desktop/tests/windows/shell-html.test.ts` (`describe("design tokens — …")`)

**Interfaces:**
- Consumes: `fe/src/index.css`의 `:root`·`.dark` 블록(Task 3)
- Produces: `WINDOW_BACKGROUND: { light: "#f7f7f7"; dark: "#0c0c0d" }`, `windowBackground(dark: boolean): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/windows/window-background.test.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { WINDOW_BACKGROUND, windowBackground } from "../../src/windows/window-background";

/** 창 바탕은 첫 페인트 전 잠깐 보이는 면이다 — fe의 앱 바탕(--surface-app = --gray-2)과 달라지면 번쩍인다. */
describe("windowBackground", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "..", "fe", "src", "index.css"), "utf8");
  const gray2Of = (block: RegExp) => /--gray-2:\s*([^;]+);/.exec(block.exec(css)![1])![1].trim();

  it("macOS 설정에 따라 두 값 중 하나를 고른다", () => {
    expect(windowBackground(false)).toBe(WINDOW_BACKGROUND.light);
    expect(windowBackground(true)).toBe(WINDOW_BACKGROUND.dark);
  });

  it("fe의 라이트·다크 --gray-2와 같다", () => {
    expect(WINDOW_BACKGROUND.light).toBe(gray2Of(/^:root\s*\{([^}]*)\}/m));
    expect(WINDOW_BACKGROUND.dark).toBe(gray2Of(/^\.dark\s*\{([^}]*)\}/m));
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/window-background.test.ts`
Expected: FAIL — `Cannot find module '../../src/windows/window-background'`.

- [ ] **Step 3: 구현한다**

`desktop/src/windows/window-background.ts`:

```ts
/**
 * 창이 첫 페인트 전에 칠하는 바탕. fe의 --surface-app(= --gray-2)과 같아야 로딩 중 창과 담화 화면이
 * 이어진다 — tests/windows/window-background.test.ts가 fe/src/index.css와 대조한다.
 *
 * macOS 설정만 본다. 앱 안에서 고른 테마는 렌더러 localStorage에 있고, 그것을 main이 읽으려면
 * 렌더러 → main 채널이 필요하다(스펙 2026-09-25 다크 테마 §2.2 — 만들지 않는다).
 */
export const WINDOW_BACKGROUND = { light: "#f7f7f7", dark: "#0c0c0d" } as const;

export function windowBackground(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}
```

- [ ] **Step 4: 두 창에 잇는다**

`desktop/src/main.ts:1`:

```ts
import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from "electron";
```

같은 파일 import 묶음(다른 `./windows/…` import 옆)에:

```ts
import { windowBackground } from "./windows/window-background";
```

`createWindow`의 `new BrowserWindow({ … })`에 `title: "담화",` 다음 줄로:

```ts
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
```

`desktop/src/windows/shell-window.ts:1`:

```ts
import { app, BrowserWindow, nativeTheme } from "electron";
```

import 묶음에:

```ts
import { windowBackground } from "./window-background";
```

`new BrowserWindow({ … })`에 `show: false,` 다음 줄로:

```ts
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
```

- [ ] **Step 5: 통과·타입 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/window-background.test.ts && pnpm --filter damwha-desktop run lint`
Expected: PASS, 타입 오류 없음.

- [ ] **Step 6: 셸 HTML 테스트를 다크 기준으로 바꾼다 (실패 먼저)**

`desktop/tests/windows/shell-html.test.ts`의 `describe("design tokens — fe/src/index.css와 같은 값 (Notion P2-B)", …)` 안을 다음처럼 바꾼다.

`const resolve = …` 정의 바로 뒤에 추가:

```ts
  // fe의 .dark 블록 — 다크에서는 거기 있는 이름이 :root 값을 덮는다.
  const feDark = declsOf(/^\.dark\s*\{([^}]*)\}/m.exec(feCss)![1]);
  const resolveDark = (value: string, depth = 0): string =>
    depth > 10
      ? value
      : value.replace(/var\(--([\w-]+)\)/g, (_, name: string) =>
          resolveDark(feDark.get(name) ?? fe.get(name) ?? `<fe에 없음: --${name}>`, depth + 1),
        );
  const DARK_MEDIA = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/;
  const isColour = (v: string) => /^#|^rgba?\(/.test(v);
```

`for (const file of …)` 안의 `describe(file, …)`에서 `const shell = declsOf(rootBlock);` 뒤에:

```ts
      const darkBlock = DARK_MEDIA.exec(style)?.[1] ?? "";
      const shellDark = declsOf(darkBlock);
```

`it("writes no colour outside :root …")`의 `rest` 계산을 다크 블록까지 빼도록 바꾼다:

```ts
        const rest = style.replace(DARK_MEDIA, "").replace(/:root\s*\{[^}]*\}/, "");
```

`it("stays light — …")` 테스트를 통째로 다음 둘로 바꾼다:

```ts
      it("follows macOS dark with the colour tokens fe resolves under .dark", () => {
        expect(darkBlock, "@media (prefers-color-scheme: dark) { :root { … } } 블록").not.toBe("");
        expect(darkBlock).toMatch(/color-scheme:\s*dark;/);
        const colourNames = [...shell].filter(([, v]) => isColour(v)).map(([n]) => n).sort();
        expect([...shellDark.keys()].sort()).toEqual(colourNames);
        for (const [name, value] of shellDark) {
          expect({ name, value }).toEqual({ name, value: resolveDark(`var(--${name})`) });
        }
      });

      it("declares light as the base scheme — the dark block only overrides", () => {
        expect(rootBlock).toMatch(/color-scheme:\s*light;/);
      });
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/shell-html.test.ts`
Expected: FAIL — 두 파일 모두 `@media … 블록`이 빈 문자열.

- [ ] **Step 7: 셸 HTML에 다크 블록을 넣는다**

`desktop/shell/status.html` — `<style>` 첫 주석의 마지막 두 문장(`fe에 다크 모드가 없으므로 라이트로 고정한다: … 밝게 번쩍인다.`)을 다음으로 바꾼다:

```
         다크는 아래 @media 블록이 fe의 .dark 값으로 덮는다. 이 창은 file://이라 앱의 localStorage를
         못 읽으므로 macOS 설정만 따른다 — 앱 안에서 테마를 직접 고른 사람은 붙는 순간 한 번 바뀔 수 있다.
```

그리고 `:root { … }` 블록이 닫힌 바로 뒤에:

```css
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --surface-app: #0c0c0d;
          --surface-card: #18181a;
          --text-primary: #ededed;
          --text-secondary: #a8a8ae;
          --text-muted: #8b8b92;
          --border-subtle: #232326;
          --border-default: #2a2a2e;
          --accent-6: #2fdcae;
        }
      }
```

`desktop/shell/services.html` — 같은 자리의 주석에 같은 두 문장을 넣고(그 파일 주석이 라이트 고정을 말하는 문장이 있으면 그것을 대체), `:root` 블록 뒤에 **그 파일 `:root`에 있는 색 토큰 전부**를 다크 값으로 적는다. 색 토큰 목록은 파일의 `:root`에서 `#`·`rgba(`로 시작하는 값을 가진 이름이다. 값은 스펙 §3.2 표에서 해당 토큰이 가리키는 원시 스케일의 다크 값을 쓴다(예: `--surface-app`→`--gray-2`→`#0c0c0d`, `--accent-solid`→`--accent-9`→`#ededed`, `--accent-solid-hover`→`--accent-10`→`#d4d4d8`, `--gray-0`→`#18181a`, `--gray-2`→`#0c0c0d`, `--border-strong`→`--gray-5`→`#37373c`, `--green-9`→`#3fae66`, `--amber-9`→`#d99a2b`, `--red-9`→`#c94a4a`). 틀린 값은 Step 6의 테스트가 이름과 기대값을 찍어준다.

- [ ] **Step 8: CSP 해시를 맞춘다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/windows/shell-html.test.ts -t "by hash"`
Expected: FAIL — 기대값 `'sha256-…'`가 출력된다. 각 파일 `<meta http-equiv="Content-Security-Policy" …>`의 `style-src '…'`를 출력된 기대값으로 바꾼다(`script-src`는 스크립트를 안 건드렸으므로 그대로).

- [ ] **Step 9: 데스크톱 전체 테스트**

Run: `pnpm --filter damwha-desktop exec vitest run`
Expected: PASS 전체, 테스트 개수가 0이 아님을 출력에서 확인.

- [ ] **Step 10: 커밋한다**

```bash
git add desktop/src/windows/window-background.ts desktop/tests/windows/window-background.test.ts desktop/src/main.ts desktop/src/windows/shell-window.ts desktop/shell desktop/tests/windows/shell-html.test.ts
git commit -m "feat(desktop): 창 바탕과 셸 창이 macOS 다크 설정을 따른다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 7: 문서

**Files:**
- Modify: `fe/DESIGN.md` (§2 첫 항목, §3 표면·텍스트 표, §9 Don't 첫 두 항목)
- Modify: `fe/CLAUDE.md` (UI 절 첫 단락의 "light-only", 토큰 목록)
- Modify: `desktop/CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-25-dark-theme-design.md` §5

- [ ] **Step 1: `fe/DESIGN.md` §2**

"**라이트 전용.** 다크 모드는 구현되어 있지 않다 …" 항목 전체를 다음으로 바꾼다:

```markdown
- **라이트가 기준, 다크는 같은 역할을 뒤집은 한 벌이다.** `<html class="dark">`가
  스위치이고 `src/index.css`의 `.dark` 블록이 값을 다시 정한다. 원시 스케일은
  이름과 역할을 지킨다 — `--gray-0`은 두 테마 모두 "카드 면", `--gray-12`는
  "본문 글자"다. 주 버튼은 다크에서 밝은 잉크로 뒤집히고, 민트는 두 테마 모두
  신호 전용이다. 바탕은 무채색이다 — 브랜드 잉크의 푸른 기를 깔면 화자 색이
  물든다. 선택은 사이드바 하단 메뉴(시스템 / 라이트 / 다크, 기본 시스템)
```

- [ ] **Step 2: `fe/DESIGN.md` §3 표**

표면 표의 `| 모달 뒤 스크림 | --surface-overlay | — |` 행 뒤에 두 행을 더한다:

```markdown
| 명령 팔레트 뒤 옅은 스크림    | `--surface-scrim-soft` | —                     |
| 떠 있는 층 (툴팁 · 토스트)    | `--surface-floating` + `--border-floating` | — |
| 색 있는 면 위 hover 덧칠      | `--overlay-hover`   | —                        |
```

텍스트 표의 `| 링크 | --text-link | — |` 행 뒤에:

```markdown
| 떠 있는 층 위의 글자     | `--text-on-floating` · `--text-on-floating-muted` | — |
```

강조 · 상태 표의 `| 위험 버튼 면 | --red-9 | bg-destructive |` 행 뒤에:

```markdown
| 위험 버튼 hover               | `--red-9-hover`        | —                                   |
| 토스트 아이콘 (성공 · 오류)   | `--toast-success` · `--toast-danger` | —                     |
```

- [ ] **Step 3: `fe/DESIGN.md` §9 Don't**

"**다크 모드 대응을 추가하지 말 것.** …" 항목 전체를 다음으로 바꾼다:

```markdown
- **한 테마에서만 보고 끝내지 말 것.** 색은 토큰으로만 고르고, 새 화면은
  라이트와 다크 둘 다 띄워 본다. `dark:` 접두사는 토큰으로 표현할 수 없는
  경우에만 쓴다 — 대부분은 `.dark` 블록에 토큰 값을 더하는 것이 답이다.
  잉크(`--accent-solid`) 면 위 글자는 `text-white`가 아니라
  `--text-on-accent`다: 다크에서 잉크가 밝아진다(`design-tokens.test.ts`가
  잡는다).
```

"**raw hex나 임의 색값을 쓰지 말 것.**" 항목의 괄호 부분 `(기존 예외 3곳: … 늘리지 말 것.)`을 다음으로 바꾼다:

```markdown
  예외는 `brand-mark.tsx` 하나다(`design-tokens.test.ts`가 나머지를 잡는다).
  예전 예외 3곳(danger hover, 토스트 아이콘 두 색)은 토큰으로 옮겼다.
```

- [ ] **Step 4: `fe/CLAUDE.md`**

UI 절 첫 단락의 `the hard Don'ts (light-only, no raw hex, …)`를 `the hard Don'ts (check both themes, no raw hex, …)`로 바꾼다. 그리고 `- \`@theme inline\` / \`@theme\` blocks expose …` 항목 앞에 다음 항목을 넣는다:

```markdown
- **`.dark` (right after `:root`) is the dark token set**, switched by `class="dark"` on `<html>`. Raw scales keep their names and roles and only change value, so components that reach for `--gray-*` directly still land right. The switch is decided twice: `index.html`'s inline script before first paint (it cannot import modules) and `src/shared/lib/theme.ts` afterwards (`themeStore`, `useTheme()`). The two copies of the rule are pinned together by `src/app/theme-inline-script.test.ts` — change one, change both. Speaker `-solid` values are not redefined in `.dark`.
```

- [ ] **Step 5: `desktop/CLAUDE.md`**

창·셸 관련 절(없으면 파일 끝)에 한 단락을 더한다:

```markdown
**Window background and shell pages follow macOS dark, not the in-app theme.** `src/windows/window-background.ts` picks `backgroundColor` from `nativeTheme.shouldUseDarkColors`; its two values must equal fe's light and dark `--gray-2` (`tests/windows/window-background.test.ts`). `shell/*.html` add an `@media (prefers-color-scheme: dark)` block that `tests/windows/shell-html.test.ts` checks against fe's `.dark` values — any edit to a shell `<style>` also changes its CSP `style-src` hash. Syncing the title bar to the in-app choice would need a renderer → main channel, which the one-way desktop-bridge contract rules out.
```

- [ ] **Step 6: 스펙 §5를 구현에 맞춘다**

`docs/superpowers/specs/2026-09-25-dark-theme-design.md` §5의 목록을 다음으로 바꾼다:

```markdown
- 위치: `left-nav.tsx` 맨 아래, 회의 목록(`flex-1`)·데모 투어 버튼 뒤에 고정되는 하단 줄(`border-t`).
- 구현: `features/theme/ui/theme-menu.tsx`. 기존 `IconButton`을 트리거로, **Radix DropdownMenu의
  RadioGroup**을 메뉴로 쓴다 — 팝오버에 role을 손으로 달면 화살표 키 이동·Esc·포커스 복귀를 다시 만들어야
  한다. (설계 대화에서는 "popover"라고 불렀다.)
- 아이콘: 선택에 따라 시스템 `monitor` / 라이트 `sun` / 다크 `moon`(`features/meeting/ui/icons.tsx`에 추가).
- 메뉴: "화면 테마" 라벨 + 세 항목(시스템 설정 따르기 / 라이트 / 다크), 현재 선택에 체크.
  `menuitemradio` + `aria-checked`는 Radix가 붙인다. 고르면 `setPreference` 후 닫힌다.
- 버튼 이름: `화면 테마: 시스템`처럼 현재 선택을 담는다(`IconButton`이 `title`로도 쓴다).
- 데모 투어의 `data-tour` 대상은 건드리지 않는다.
```

- [ ] **Step 7: 커밋한다**

```bash
git add fe/DESIGN.md fe/CLAUDE.md desktop/CLAUDE.md docs/superpowers/specs/2026-09-25-dark-theme-design.md
git commit -m "docs: 다크 테마를 DESIGN.md·CLAUDE.md·스펙에 반영한다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

---

### Task 8: 전체 검증과 화면 확인

**Files:** 없음(발견한 결함은 해당 파일을 고치고 그 Task의 방식으로 커밋)

- [ ] **Step 1: 전체 테스트·린트·빌드**

Run (저장소 루트에서):

```bash
pnpm fe test && pnpm fe lint && pnpm fe build
pnpm --filter damwha-desktop exec vitest run
pnpm --filter damwha-desktop run lint
```

Expected: 모두 성공. desktop 출력에 테스트 개수가 0이 아님을 확인한다.

- [ ] **Step 2: 화면을 띄운다**

Run: `pnpm db:up` 뒤 `pnpm dev`(백그라운드). 브라우저에서 `http://localhost:5173`.

- [ ] **Step 3: 라이트·다크 각각 확인**

사이드바 하단 테마 버튼으로 라이트 → 다크를 바꿔가며 다음을 본다. 각 항목에서 "글자가 배경에 묻히거나, 흰 면이 남거나, 잉크 위 흰 글씨가 흰 면 위 흰 글씨가 된 곳"이 없어야 한다:

- 회의 화면: 사이드바(선택된 회의 행), 전사(화자 칩·선택된 발화·저장 버튼 켜짐), 인사이트, 플레이어 재생 버튼
- 설정: 스위치 켜짐/꺼짐, 체크박스, 셀렉트 팝업
- 화자 관리, 저장한 발언
- ⌘K 명령 팔레트(뒤 스크림), 새 회의 다이얼로그(뒤 스크림)
- 툴팁(발화 저장 버튼에 hover), 토스트(발화 저장 → "저장했어요")
- 새로고침: 다크 상태에서 ⌘R — 흰 화면 번쩍임 없음

- [ ] **Step 4: 시스템 모드**

테마를 "시스템 설정 따르기"로 두고 macOS 시스템 설정 → 화면 모드를 바꿔 페이지가 즉시 따라가는지 본다. 다른 탭을 하나 더 열어 한쪽에서 다크를 고르면 다른 탭도 바뀌는지 본다.

- [ ] **Step 5: 그래프 갱신**

Run (루트): `graphify update .`

- [ ] **Step 6: 수정 사항이 있었으면 커밋한다**

```bash
git add -A fe desktop
git commit -m "fix(fe): 다크 화면 확인에서 찾은 색 누락을 고친다

Claude-Session: https://claude.ai/code/session_01R21X4LSrPNp5mGQ5Gyti3W"
```

(수정이 없으면 이 단계는 건너뛴다.)
