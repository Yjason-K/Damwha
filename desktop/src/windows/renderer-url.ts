import type { UiLanguage } from "../i18n/locale";

/**
 * 담화 화면 첫 로드 URL에 화면 언어를 싣는다 (다국어 스펙 §4.1). FE는 첫 렌더 **전에** 이 값을 읽는다 —
 * 로드 뒤에 밀어 넣으면 한국어가 한 프레임 보였다가 바뀐다. 문자열 이어 붙이기가 아니라 URL API로 만든다:
 * packaged(`${apiBase}/`)와 dev(`VITE_ORIGIN`, 경로 없음) 모양이 달라서다.
 */
export function withUiLanguage(url: string, lang: UiLanguage): string {
  const u = new URL(url);
  u.searchParams.set("lang", lang);
  return u.toString();
}
