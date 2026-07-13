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
