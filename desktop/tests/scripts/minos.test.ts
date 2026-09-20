import { describe, expect, it } from "vitest";
import { compareVersion, readMinos } from "../../scripts/lib/minos.mjs";

describe("compareVersion", () => {
  it("메이저가 다르면 메이저로 가른다", () => {
    expect(compareVersion("15.0", "26.0")).toBe(-1);
    expect(compareVersion("27.0", "15.0")).toBe(1);
  });
  it("마이너까지 본다", () => {
    expect(compareVersion("15.1", "15.0")).toBe(1);
    expect(compareVersion("15.0", "15.0")).toBe(0);
  });
  it("자릿수가 다른 마이너를 문자열로 비교하지 않는다", () => {
    // "15.10" < "15.9" 가 되면 안 된다
    expect(compareVersion("15.10", "15.9")).toBe(1);
  });
  it("세 자리도 받는다", () => {
    expect(compareVersion("15.0.1", "15.0")).toBe(1);
  });
});

describe("readMinos", () => {
  it("Mach-O가 아닌 파일에는 null이다", () => {
    expect(readMinos("package.json")).toBeNull();
  });
  it("시스템 바이너리에서 값을 읽는다", () => {
    const v = readMinos("/bin/echo");
    expect(v).not.toBeNull();
    expect(v).toMatch(/^\d+\.\d+/);
  });
});
