import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 데모 SPA가 제품 사이트와 "Damwha" 검색을 다투지 않게 한다(제품 사이트 스펙 §3.6).
// 같은 index.html을 데스크톱 앱도 쓰지만 앱 화면은 어디서도 색인 대상이 아니다.
describe("index.html", () => {
  it("검색 색인에서 빠진다", () => {
    const html = readFileSync(join(__dirname, "../../index.html"), "utf8");
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex"\s*\/?>/);
  });
});
