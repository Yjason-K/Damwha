// 언어 저장소(shared/i18n)가 만들어지기 전에 한국어로 고정한다. jsdom의 navigator.language는 en-US라
// 이것이 없으면 한글 문구로 찾는 기존 테스트가 전부 영어 화면을 본다 (다국어 스펙 §8).
// 키는 shared/i18n/language-store.ts의 UI_LANGUAGE_STORAGE_KEY.
window.localStorage.setItem("damwha:ui-language", "ko");

// 모든 테스트에 i18n을 한 번 초기화한다 — 정적 import는 위 setItem보다 먼저 끌어올려져(hoist) 저장소가
// "ko"를 쓰기 전에 만들어지므로, 반드시 top-level await로 setItem 다음에 실행한다.
await import("@/shared/i18n");

import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy*·waitFor의 기본 대기 1000ms는 파일의 첫 테스트가 lazy 라우트(회의 상세 등)를 처음 그리기에
// 모자라다(#134). 처음 한 번은 lazy()가 suspend해 fallback이 뜨고, 라우트가 셸보다 약 300ms 늦게
// 마운트된다(react-dom의 Suspense 표시 스로틀 FALLBACK_THROTTLE_MS = 300ms와 맞는다). 모듈을 미리
// import해도 lazy()는 한 번 suspend하므로 이 간격은 줄지 않았다. 여기에 CPU 부하에 비례하는 렌더가
// 더해져 회의 셸 첫 h1까지 한가할 때 0.5~0.6초, 바쁜 루프 14개를 건 부하에서 0.7~1.04초가 걸렸다
// (M4 Pro, 2026-11-25). 같은 파일의 두 번째 테스트는 0.1초 안팎이다. 성공하는 테스트는 더 기다리지 않으므로 통과 시간은 그대로다.
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
