// 앱 모듈이 import되며 언어 저장소를 만들기 전에 한국어로 고정한다. jsdom의 navigator.language는 en-US라
// 이것이 없으면 한글 문구로 찾는 기존 테스트가 전부 영어 화면을 본다 (다국어 스펙 §8).
// 키는 shared/i18n/language-store.ts의 UI_LANGUAGE_STORAGE_KEY — 여기서 import하면 저장소가 먼저 만들어진다.
window.localStorage.setItem("damwha:ui-language", "ko");

import "@testing-library/jest-dom/vitest";

// Radix UI(Select 등)는 jsdom에 없는 Pointer Capture / scrollIntoView API를
// 참조한다. 테스트에서 Select를 열고 옵션을 고를 수 있도록 최소 폴리필을 둔다.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
