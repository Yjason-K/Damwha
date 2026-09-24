import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIdOf,
  needsSnapshot,
  parseBuildInfo,
  parseGeneration,
  readGeneration,
  readGenerationText,
  writeGenerationAtomic,
} from "../../../src/services/postgres/generation";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gen-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("build info", () => {
  it("parses version and a 12-char commit, optionally dirty", () => {
    expect(parseBuildInfo('{"version":"0.4.0","commit":"0123456789ab"}')).toEqual({ version: "0.4.0", commit: "0123456789ab" });
    expect(parseBuildInfo('{"version":"0.4.0","commit":"0123456789ab-dirty"}')?.commit).toBe("0123456789ab-dirty");
    expect(buildIdOf({ version: "0.4.0", commit: "0123456789ab" })).toBe("0.4.0+0123456789ab");
  });
  it.each([
    ["not json", "nope"],
    ["empty version", '{"version":"","commit":"0123456789ab"}'],
    ["short commit", '{"version":"0.4.0","commit":"0123"}'],
    ["upper-case commit", '{"version":"0.4.0","commit":"0123456789AB"}'],
    ["array", "[]"],
  ])("rejects %s", (_n, text) => expect(parseBuildInfo(text)).toBeNull());
});

describe("generation record", () => {
  it("round-trips atomically and leaves no temp file", () => {
    const file = path.join(root, "data", ".damwha-generation");
    fs.mkdirSync(path.dirname(file));
    writeGenerationAtomic(file, { build: "0.4.0+0123456789ab", snapshot: "20260924T084933Z" });
    expect(readGeneration(file)).toEqual({ build: "0.4.0+0123456789ab", snapshot: "20260924T084933Z" });
    expect(fs.readdirSync(path.dirname(file))).toEqual([".damwha-generation"]);
    expect(readGenerationText(file)).toBe('{"build":"0.4.0+0123456789ab","snapshot":"20260924T084933Z"}');
  });
  it("keeps restoredFrom and accepts null build/snapshot", () => {
    expect(parseGeneration('{"build":null,"snapshot":null,"restoredFrom":"20260925T010203Z"}')).toEqual({
      build: null,
      snapshot: null,
      restoredFrom: "20260925T010203Z",
    });
  });
  it("reads missing or garbage as null", () => {
    expect(readGeneration(path.join(root, "nope"))).toBeNull();
    fs.writeFileSync(path.join(root, "bad"), "{");
    expect(readGeneration(path.join(root, "bad"))).toBeNull();
    expect(parseGeneration('{"build":3,"snapshot":null}')).toBeNull();
  });
});

describe("needsSnapshot", () => {
  const rec = { build: "0.4.0+0123456789ab", snapshot: "S" };
  it("never in dev, even with no record", () => {
    expect(needsSnapshot({ packaged: false, currentBuild: "0.4.0+0123456789ab", recorded: null })).toBe(false);
  });
  it("packaged: no record → yes, different build → yes, same build → no", () => {
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.0+0123456789ab", recorded: null })).toBe(true);
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.1+ba9876543210", recorded: rec })).toBe(true);
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.0+0123456789ab", recorded: rec })).toBe(false);
  });
  it("a restored record (build from before the update) needs a new snapshot", () => {
    expect(needsSnapshot({ packaged: true, currentBuild: "0.4.0+0123456789ab", recorded: { build: null, snapshot: null, restoredFrom: "R" } })).toBe(true);
  });
});
