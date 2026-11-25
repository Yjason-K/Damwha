// 언어 저장소(shared/i18n)가 만들어지기 전에 한국어로 고정한다. jsdom의 navigator.language는 en-US라
// 이것이 없으면 한글 문구로 찾는 기존 테스트가 전부 영어 화면을 본다 (다국어 스펙 §8).
// 키는 shared/i18n/language-store.ts의 UI_LANGUAGE_STORAGE_KEY.
window.localStorage.setItem("damwha:ui-language", "ko");

// 모든 테스트에 i18n을 한 번 초기화한다 — 정적 import는 위 setItem보다 먼저 끌어올려져(hoist) 저장소가
// "ko"를 쓰기 전에 만들어지므로, 반드시 top-level await로 setItem 다음에 실행한다.
await import("@/shared/i18n");

import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy*·waitFor의 기본 대기 1000ms는 회의 셸처럼 무거운 화면이 CPU가 바쁜 머신(CI 러너,
// 병렬 실행)에서 첫 렌더를 마치기에 모자라다 — 로컬 부하 재현에서 매번 1~2건이 시간 초과로
// 깨졌다. 성공하는 테스트는 더 기다리지 않으므로 통과 시간은 그대로다.
configure({ asyncUtilTimeout: 5000 });

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
