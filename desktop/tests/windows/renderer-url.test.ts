import { describe, expect, it } from "vitest";
import { withUiLanguage } from "../../src/windows/renderer-url";

describe("withUiLanguage", () => {
  it("packaged API origin", () => {
    expect(withUiLanguage("http://127.0.0.1:51234/", "en")).toBe("http://127.0.0.1:51234/?lang=en");
  });
  it("dev Vite origin (경로 없음)", () => {
    expect(withUiLanguage("http://localhost:5173", "ko")).toBe("http://localhost:5173/?lang=ko");
  });
  it("있던 쿼리는 두고 lang만 바꾼다", () => {
    expect(withUiLanguage("http://127.0.0.1:1/?a=1&lang=ko", "en")).toBe("http://127.0.0.1:1/?a=1&lang=en");
  });
  it("origin은 바뀌지 않는다 — 탐색 경계(applyNavigationBoundary)의 origin 검사를 그대로 통과한다", () => {
    const u = "http://127.0.0.1:51234/";
    expect(new URL(withUiLanguage(u, "en")).origin).toBe(new URL(u).origin);
  });
});
