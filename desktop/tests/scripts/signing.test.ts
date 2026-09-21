import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSigning } from "../../scripts/lib/signing.mjs";

function tmpWith(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signing-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "signing.json"), contents);
  return dir;
}

describe("loadSigning", () => {
  it("세 값을 읽는다", () => {
    // identity는 40자 sha1 지문 모양이어야 한다(Step 3 구현이 그것을 던지므로) — 브리프 원문의
    // "ABC123"은 그 검증과 모순돼 그대로 두면 이 테스트가 실패한다. 검증 로직은 그대로 두고
    // 값만 지문 모양의 가짜 문자열로 고쳤다.
    const fakeFingerprint = "AB12CD34".repeat(5);
    const dir = tmpWith(JSON.stringify({ identity: fakeFingerprint, teamId: "L5Y9SZHGRN", notaryProfile: "damwha" }));
    expect(loadSigning(dir)).toEqual({ identity: fakeFingerprint, teamId: "L5Y9SZHGRN", notaryProfile: "damwha" });
  });

  it("파일이 없으면 던진다 — ad-hoc으로 조용히 떨어지지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signing-"));
    fs.mkdirSync(path.join(dir, "scripts"));
    expect(() => loadSigning(dir)).toThrow(/signing\.json/);
  });

  it("identity가 sha1 지문 모양이 아니면 던진다 — 이름은 중복될 수 있다", () => {
    const dir = tmpWith(JSON.stringify({ identity: "Developer ID Application: Someone", teamId: "X", notaryProfile: "y" }));
    expect(() => loadSigning(dir)).toThrow(/지문/);
  });

  it("키가 하나라도 빠지면 던진다", () => {
    const dir = tmpWith(JSON.stringify({ identity: "A".repeat(40) }));
    expect(() => loadSigning(dir)).toThrow(/teamId/);
  });
});
