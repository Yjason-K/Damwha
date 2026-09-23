import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertReleaseTag, describeReleaseTag, releaseTagFor } from "../../scripts/lib/release-tag.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repoWithTags(tags: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c");
  for (const t of tags) git("tag", t);
  return dir;
}

describe("releaseTagFor", () => {
  it("v 접두사 하나만 붙인다", () => {
    expect(releaseTagFor("0.4.0")).toBe("v0.4.0");
  });
});

describe("describeReleaseTag", () => {
  it("HEAD의 v* 태그를 읽는다", () => {
    expect(describeReleaseTag(repoWithTags(["v0.4.0"]))).toBe("v0.4.0");
  });
  it("옛 desktop-v* 태그만 있으면 null이다", () => {
    expect(describeReleaseTag(repoWithTags(["desktop-v0.4.0"]))).toBeNull();
  });
  it("태그가 없으면 null이다", () => {
    expect(describeReleaseTag(repoWithTags([]))).toBeNull();
  });
});

describe("assertReleaseTag", () => {
  it("버전과 맞는 v 태그는 통과한다", () => {
    expect(() => assertReleaseTag("v0.4.0", "0.4.0")).not.toThrow();
  });
  it("태그가 없으면 기대 태그를 말하며 던진다", () => {
    expect(() => assertReleaseTag(null, "0.4.0")).toThrow(/v0\.4\.0여야 한다/);
  });
  it("버전이 다르면 던진다", () => {
    expect(() => assertReleaseTag("v0.3.9", "0.4.0")).toThrow(/v0\.3\.9/);
  });
});
