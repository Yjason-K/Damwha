/**
 * 화면 언어 규칙 — `@damwha/contracts`의 사본이다 (다국어 스펙 2026-09-26 §3.1).
 *
 * 사본인 이유: desktop에는 런타임 dependencies가 없고 asar에는 컴파일된 main만 들어간다
 * (electron-builder.yml). contracts를 들이면 패키징이 바뀐다. 두 벌이 어긋나면
 * tests/i18n/locale.test.ts가 잡는다 — 여기를 고치면 contracts도 고친다.
 */
export const UI_LANGUAGES = ["ko", "en"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(v: unknown): v is UiLanguage {
  return (UI_LANGUAGES as readonly unknown[]).includes(v);
}

export function pickUiLanguage(locales: readonly string[]): UiLanguage {
  for (const raw of locales) {
    const tag = raw.trim().toLowerCase();
    for (const lang of UI_LANGUAGES) {
      if (tag === lang || tag.startsWith(`${lang}-`) || tag.startsWith(`${lang}_`)) return lang;
    }
  }
  return "en";
}
