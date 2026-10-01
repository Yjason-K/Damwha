import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { LEGACY_TOKEN_FILE, removeLegacyToken } from "../../src/app/legacy-token-cleanup";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "damwha-token-"));
}

describe("removeLegacyToken", () => {
  it("removes the encrypted token file an older build left", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, LEGACY_TOKEN_FILE), "x");
    const lines: string[] = [];
    expect(removeLegacyToken(dir, { log: (l) => lines.push(l) })).toBe("removed");
    expect(fs.existsSync(path.join(dir, LEGACY_TOKEN_FILE))).toBe(false);
    expect(lines.join("\n")).toMatch(/hf-token\.bin/);
  });

  it("does nothing when there is no file", () => {
    expect(removeLegacyToken(tmp())).toBe("absent");
  });

  it("logs and carries on when removal fails", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, LEGACY_TOKEN_FILE), "x");
    const lines: string[] = [];
    const out = removeLegacyToken(dir, {
      rm: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
      log: (l) => lines.push(l),
    });
    expect(out).toBe("failed");
    expect(lines.join("\n")).toMatch(/EPERM/);
  });

  it("uses the file name older builds wrote", () => {
    expect(LEGACY_TOKEN_FILE).toBe("hf-token.bin");
  });
});
