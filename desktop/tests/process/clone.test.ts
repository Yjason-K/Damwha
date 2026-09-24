import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone } from "../../src/process/clone";
import { runTool } from "../../src/process/tool-runner";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-clone-"));
  fs.mkdirSync(path.join(root, "src", "postgres"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "src", "postgres", "PG_VERSION"), "16\n", { mode: 0o600 });
  fs.mkdirSync(path.join(root, "src", "storage"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const clone = makeClone(runTool);

describe("makeClone (real /bin/cp -c -R)", () => {
  it("copies the tree to a new destination with the tree directly under it and modes kept", async () => {
    const dst = path.join(root, "dst");
    await clone(path.join(root, "src"), dst);
    expect(fs.readFileSync(path.join(dst, "postgres", "PG_VERSION"), "utf8")).toBe("16\n");
    expect(fs.existsSync(path.join(dst, "storage"))).toBe(true);
    expect(fs.existsSync(path.join(dst, "src"))).toBe(false);
    expect(fs.statSync(path.join(dst, "postgres")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dst, "postgres", "PG_VERSION")).mode & 0o777).toBe(0o600);
  });
  it("refuses an existing destination instead of nesting into it", async () => {
    const dst = path.join(root, "dst");
    fs.mkdirSync(dst);
    await expect(clone(path.join(root, "src"), dst)).rejects.toThrow(/이미 있어요/);
    expect(fs.readdirSync(dst)).toEqual([]);
  });
  it("refuses a dangling symlink at the destination", async () => {
    const dst = path.join(root, "dst");
    fs.symlinkSync(path.join(root, "nowhere"), dst);
    await expect(clone(path.join(root, "src"), dst)).rejects.toThrow(/이미 있어요/);
  });
  it("fails when the source is missing", async () => {
    await expect(clone(path.join(root, "missing"), path.join(root, "dst"))).rejects.toThrow(/cp -c -R/);
  });
});
