import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LAUNCHER = path.resolve(__dirname, "../../scripts/cli-launcher.sh");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-launcher-")));
  dirs.push(d);
  return d;
}

function install(cliDir: string): string {
  fs.mkdirSync(cliDir, { recursive: true });
  const dest = path.join(cliDir, "damwha");
  fs.copyFileSync(LAUNCHER, dest);
  fs.chmodSync(dest, 0o755);
  fs.writeFileSync(path.join(cliDir, "damwha.cjs"), "console.log('NODE', process.argv.slice(2).join('|'));\n");
  return dest;
}

// 가짜 번들: Contents/MacOS/Damwha가 받은 argv·env를 출력하는 셸.
function fakeBundle(root: string): string {
  const macos = path.join(root, "Damwha 2.app", "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  const bin = path.join(macos, "Damwha");
  fs.writeFileSync(bin, '#!/bin/sh\necho "BIN RUN_AS_NODE=$ELECTRON_RUN_AS_NODE ARGS=$*"\n');
  fs.chmodSync(bin, 0o755);
  return install(path.join(root, "Damwha 2.app", "Contents", "Resources", "cli"));
}

describe("cli-launcher.sh", () => {
  it("follows symlink and runs bundled binary with ELECTRON_RUN_AS_NODE", () => {
    const root = tmp();
    const launcher = fakeBundle(root);
    // 링크 두 단계 + 상대 대상: ~/.local/bin/damwha -> ../hop -> 실제 런처
    const bin = path.join(root, "home", ".local", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(launcher, path.join(root, "home", ".local", "hop"));
    fs.symlinkSync("../hop", path.join(bin, "damwha"));
    const out = execFileSync(path.join(bin, "damwha"), ["--version"], { encoding: "utf8" });
    expect(out).toContain("BIN RUN_AS_NODE=1");
    expect(out).toContain(`ARGS=${path.join(root, "Damwha 2.app", "Contents", "Resources", "cli", "damwha.cjs")} --version`);
  });

  it("passes args through", () => {
    const root = tmp();
    const launcher = fakeBundle(root);
    const out = execFileSync(launcher, ["meetings", "list", "a b"], { encoding: "utf8" });
    expect(out).toContain("meetings list a b");
  });

  it("falls back to node outside app bundle", () => {
    const root = tmp();
    const launcher = install(path.join(root, "build", "cli"));
    const out = execFileSync(launcher, ["status", "--json"], { encoding: "utf8" });
    expect(out.trim()).toBe("NODE status|--json");
  });
});
