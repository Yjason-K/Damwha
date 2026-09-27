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
