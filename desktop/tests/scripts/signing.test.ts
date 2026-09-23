import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codesign, loadSigning } from "../../scripts/lib/signing.mjs";

// codesign()은 인자만 본다 — 실제 서명은 하지 않는다.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

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

describe("codesign", () => {
  const id = "AB12CD34".repeat(5);
  const argv = () => vi.mocked(execFileSync).mock.calls.map((c) => c[1]);
  beforeEach(() => vi.mocked(execFileSync).mockClear());

  it("entitlements가 없어도 hardened runtime을 켠다 — 공증이 모든 실행 파일에 요구한다(R12, 최종 리뷰 I3)", () => {
    // 옛 기본값(`runtime = entitlements !== null`)이면 ShipIt·postgres처럼 plist 없이 서명하는
    // 트리에서 runtime이 조용히 빠지고, 로컬은 초록인 채 Apple 공증에서야 거절된다.
    codesign(id, null, ["/x/ShipIt"]);
    expect(argv()).toEqual([["--force", "--sign", id, "--options", "runtime", "--timestamp", "/x/ShipIt"]]);
  });

  it("entitlements가 있으면 runtime과 함께 plist를 준다", () => {
    codesign(id, "/e.plist", ["/x/python3.12"]);
    expect(argv()).toEqual([
      ["--force", "--sign", id, "--options", "runtime", "--timestamp", "--entitlements", "/e.plist", "/x/python3.12"],
    ]);
  });

  it("runtime을 끄는 것은 명시했을 때뿐이다", () => {
    codesign(id, null, ["/x/y"], { runtime: false });
    expect(argv()).toEqual([["--force", "--sign", id, "--timestamp", "/x/y"]]);
  });
});
