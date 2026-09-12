import { describe, expect, it } from "vitest";
import { mayRenderShell } from "../src/shell-latch";

/** BrowserWindow 자리. 이 판정이 보는 것은 동일성뿐이라 빈 객체로 충분하다. */
function fakeWindow(): object {
  return {};
}

describe("mayRenderShell", () => {
  it("paints when no window has the app attached — the shell screen is what is showing", () => {
    expect(mayRenderShell(null, fakeWindow())).toBe(true);
  });

  it("refuses to paint over the window that is showing the app", () => {
    // showStatus는 loadFile이다. 앱을 쓰는 중에 부르면 사용자가 보던 것이 준비 화면으로
    // 갈아 끼워진다. ready 이후의 사망은 감독자가 백오프로 되살리는 중이므로(스펙 §6.8)
    // 그 복구를 화면 전환으로 덮지 않는다.
    const w = fakeWindow();
    expect(mayRenderShell(w, w)).toBe(false);
  });

  it("paints again after the window was closed and a new one took its place", () => {
    // Task 12 리뷰 Critical-1. boolean 래치는 자기가 기술하는 창보다 오래 살아서, 창을 한 번
    // 닫으면 그 뒤로 어떤 서비스 상태도 화면에 닿지 못했다 — 완료 기준 P2-C1·C6·C10·C11이
    // 전부 "상태 창에서 확인한다"에 걸려 있다.
    expect(mayRenderShell(fakeWindow(), fakeWindow())).toBe(true);
  });
});
