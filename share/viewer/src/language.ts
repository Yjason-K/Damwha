import { pickUiLanguage, type UiLanguage } from '@damwha/contracts';

/** 브라우저 언어가 ko/en 중 하나면 그것, 아니면 공유한 사람의 화면 언어 (spec §2.5). */
export function viewerLanguage(locales: readonly string[], fallback: UiLanguage): UiLanguage {
  const known = locales.some((l) => /^(ko|en)([-_]|$)/i.test(l.trim()));
  return known ? pickUiLanguage(locales) : fallback;
}
