import { isUiLanguage, pickUiLanguage, type UiLanguage } from "@damwha/contracts";

/**
 * 화면 언어 — 첫 값을 정하고, 바뀌면 <html lang>과 구독자(i18n)에게 알리고, desktop main과 주고받는다
 * (다국어 스펙 §4). 모양은 shared/lib/theme.ts의 저장소를 따른다.
 *
 * 원본이 둘이다. desktop 안에서는 main(ui-language.json)이 원본이고 이 저장소는 캐시다 — main이 준 값(show)을
 * localStorage에 적어 두어, ⌘R로 ?lang 없는 URL이 다시 떠도 같은 언어로 뜬다. 브라우저 단독에서는 localStorage가
 * 원본이고, 사람이 고를 때만 쓴다(그 전에는 기기 언어를 따른다).
 */
export const UI_LANGUAGE_STORAGE_KEY = "damwha:ui-language";

export interface LanguageEnv {
  /** `location.search` — desktop main이 첫 로드에 `?lang=`을 붙인다. */
  search(): string;
  /** 던질 수 있다 — 사이트 데이터가 막힌 브라우저. */
  readStored(): string | null;
  /** 던질 수 있다. */
  writeStored(v: string): void;
  systemLanguages(): readonly string[];
  apply(lang: UiLanguage): void;
}

export function resolveInitialLanguage(env: LanguageEnv): UiLanguage {
  const fromQuery = new URLSearchParams(env.search()).get("lang");
  if (isUiLanguage(fromQuery)) return fromQuery;
  try {
    const stored = env.readStored();
    if (isUiLanguage(stored)) return stored;
  } catch {
    // 막힌 저장소 — 기기 언어로 간다.
  }
  return pickUiLanguage(env.systemLanguages());
}

/** main이 부르는 두 함수 (desktop windows/language-bridge.ts). 렌더러가 먼저 여는 채널이 아니다. */
export interface UiLanguageBridge {
  /** main이 확정한 값. 렌더러 밖에서 온 데이터라 모르는 값은 버린다. */
  show(lang: unknown): void;
  /** 사람이 고른 다음 값. 고를 때까지 기다린다. */
  next(): Promise<UiLanguage>;
}

export function createLanguageStore(env: LanguageEnv) {
  let language = resolveInitialLanguage(env);
  const listeners = new Set<() => void>();
  // 대기열은 **마지막 값 하나**다. main이 묻지 않는 동안(브라우저 단독, 붙기 전) 고른 값이 쌓이면
  // 나중에 main이 옛 값들을 차례로 받아 저장·메뉴 재구성을 헛돈다.
  let queued: UiLanguage | null = null;
  const waiting: Array<(lang: UiLanguage) => void> = [];

  const persist = (next: UiLanguage) => {
    try {
      env.writeStored(next);
    } catch {
      // 저장 실패 — 이번 세션에는 적용된다. 다음 실행은 ?lang 또는 기기 언어로 뜬다.
    }
  };

  const set = (next: UiLanguage) => {
    if (next === language) return;
    language = next;
    env.apply(next);
    listeners.forEach((l) => l());
  };

  return {
    getSnapshot: (): UiLanguage => language,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 사람이 설정에서 골랐다. */
    choose(next: UiLanguage): void {
      persist(next);
      set(next);
      const resolve = waiting.shift();
      if (resolve !== undefined) resolve(next);
      else queued = next;
    },
    bridge: {
      show(raw: unknown): void {
        if (!isUiLanguage(raw)) return;
        persist(raw);
        set(raw);
      },
      next(): Promise<UiLanguage> {
        if (queued !== null) {
          const v = queued;
          queued = null;
          return Promise.resolve(v);
        }
        return new Promise((resolve) => waiting.push(resolve));
      },
    } satisfies UiLanguageBridge,
    /** 한 번만 부른다(main.tsx). 첫 값을 <html lang>에 적는다. */
    start(): void {
      env.apply(language);
    },
  };
}

export type LanguageStore = ReturnType<typeof createLanguageStore>;

export function browserLanguageEnv(w: Window = window): LanguageEnv {
  return {
    search: () => w.location.search,
    readStored: () => w.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY),
    writeStored: (v) => w.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, v),
    systemLanguages: () =>
      w.navigator.languages?.length ? w.navigator.languages : [w.navigator.language],
    apply: (lang) => {
      w.document.documentElement.lang = lang;
    },
  };
}
