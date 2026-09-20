import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compareVersion, parseMinos, readMinos } from "../../scripts/lib/minos.mjs";

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

  it("시스템 바이너리에서 minos 값을 읽는다 — LC_BUILD_VERSION의 tool version이 아니다", () => {
    const v = readMinos("/bin/echo");
    expect(v).not.toBeNull();
    expect(v).toMatch(/^\d+\.\d+/);

    // 값의 모양(정규식)만 보면 이 회귀를 못 잡는다: 옛 구현은 `minos`와 `version`(링커
    // tool 버전, 예: "27037.1") 둘 다 집어 fat-슬라이스 최대값 규칙이 "27037.1"을
    // 골랐고, 그것도 /^\d+\.\d+/를 통과한다. macOS 릴리스는 10~27대라 상한을 둔다 —
    // 다섯 자리 링커 tool 버전은 이 상한을 훌쩍 넘는다.
    expect(Number(v!.split(".")[0])).toBeLessThan(100);

    // readMinos와 **다른 경로**로 같은 파일의 minos를 직접 뽑아 대조한다: 이 정규식은
    // `minos` 키워드만 보고 `version`은 보지 않으므로(블록 추적 없이도) 옳다 — 애초에
    // 모호했던 것은 `version` 쪽이었지 `minos` 쪽이 아니다.
    const out = execFileSync("xcrun", ["vtool", "-show-build", "/bin/echo"], { encoding: "utf8" });
    const minosLines = [...out.matchAll(/^\s*minos\s+(\d+(?:\.\d+)*)\s*$/gm)].map((m) => m[1]);
    expect(minosLines.length).toBeGreaterThan(0);
    const expected = minosLines.reduce((hi, x) => (compareVersion(x, hi) > 0 ? x : hi));
    expect(v).toBe(expected);
  });
});

describe("parseMinos — 블록 인식", () => {
  // `LC_VERSION_MIN_MACOSX`를 실제로 갖고 있는 바이너리를 이 머신에서 찾지 못했다 — 그 로드
  // 커맨드는 Xcode 10(2018)에서 LC_BUILD_VERSION으로 대체되어, /bin·/usr/lib·Homebrew
  // Cellar(postgresql·python@3.*·ffmpeg) 전수를 xcrun vtool·otool -l로 훑어도(각각 별도
  // 조사) 한 건도 없었다. 그래서 vtool -show-build의 실제 출력 형식을 그대로 본떠 만든
  // 합성 텍스트로 파서 자체를 검증한다 — readMinos(file)를 거치지 않고 parseMinos에 직접
  // 넣으므로 "진짜 바이너리를 흉내 냈다"고 주장하지 않는다.
  it("LC_VERSION_MIN_MACOSX 블록의 version을 읽는다", () => {
    const synthetic = [
      "/synthetic (architecture x86_64):",
      "Load command 5",
      "      cmd LC_VERSION_MIN_MACOSX",
      "  cmdsize 16",
      "  version 10.9",
      "      sdk 10.9",
      "",
    ].join("\n");
    expect(parseMinos(synthetic)).toBe("10.9");
  });

  it("LC_BUILD_VERSION 블록의 tool version을 minos로 착각하지 않는다", () => {
    const synthetic = [
      "/synthetic (architecture x86_64):",
      "Load command 10",
      "      cmd LC_BUILD_VERSION",
      "  cmdsize 32",
      " platform MACOS",
      "    minos 15.0",
      "      sdk 15.0",
      "   ntools 1",
      "     tool LD",
      "  version 27037.1",
      "",
    ].join("\n");
    expect(parseMinos(synthetic)).toBe("15.0");
  });

  it("LC_VERSION_MIN_IPHONEOS 같은 다른 플랫폼 블록은 무시한다", () => {
    const synthetic = [
      "Load command 3",
      "      cmd LC_VERSION_MIN_IPHONEOS",
      "  cmdsize 16",
      "  version 12.0",
      "      sdk 12.0",
      "",
    ].join("\n");
    expect(parseMinos(synthetic)).toBeNull();
  });
});
