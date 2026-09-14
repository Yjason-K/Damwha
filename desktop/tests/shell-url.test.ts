import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { isSameShellPage } from "../src/shell-url";

const STATUS_HTML = "/Applications/Damwha.app/Contents/Resources/app.asar/shell/status.html";
const SERVICES_HTML = "/Applications/Damwha.app/Contents/Resources/app.asar/shell/services.html";

/** win.loadFile(file, { query })가 실제로 거는 file:// URL을 흉내 낸다. */
function currentUrlFor(file: string, query: Record<string, string>): string {
  const base = pathToFileURL(file);
  const params = new URLSearchParams(query);
  return `${base.href}?${params.toString()}`;
}

describe("isSameShellPage", () => {
  it("recognizes the identical file and query as the same page", () => {
    const query = { state: "failed", detail: "원인", retryInSeconds: "20", logPath: "/log" };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, query), STATUS_HTML, query)).toBe(true);
  });

  it("treats a changed detail as a different page", () => {
    const before = { state: "failed", detail: "원인 A" };
    const after = { state: "failed", detail: "원인 B" };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, before), STATUS_HTML, after)).toBe(false);
  });

  it("treats a changed retryInSeconds as a different page — the countdown must still re-render", () => {
    const before = { state: "failed", retryInSeconds: "20" };
    const after = { state: "failed", retryInSeconds: "19" };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, before), STATUS_HTML, after)).toBe(false);
  });

  it("treats an extra key as a different page", () => {
    const before = { state: "failed" };
    const after = { state: "failed", logPath: "/log" };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, before), STATUS_HTML, after)).toBe(false);
  });

  it("treats a missing key as a different page", () => {
    const before = { state: "failed", logPath: "/log" };
    const after = { state: "failed" };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, before), STATUS_HTML, after)).toBe(false);
  });

  it("treats a different shell file as a different page", () => {
    const query = { state: "failed" };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, query), SERVICES_HTML, query)).toBe(false);
  });

  it("never matches the SPA's http origin", () => {
    const query = { state: "failed" };
    expect(isSameShellPage("http://127.0.0.1:5173/", STATUS_HTML, query)).toBe(false);
  });

  it("round-trips Korean text and embedded newlines in detail", () => {
    const query = {
      state: "failed",
      detail: "마이그레이션 거부\n원인: 잠금 실패",
      logPath: "/Users/담화/로그.log",
    };
    expect(isSameShellPage(currentUrlFor(STATUS_HTML, query), STATUS_HTML, query)).toBe(true);
  });

  it("falls back to false on a malformed current URL — never skip on doubt", () => {
    expect(isSameShellPage("not a url", STATUS_HTML, { state: "failed" })).toBe(false);
  });
});
