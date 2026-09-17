import * as path from "path";
import { describe, expect, it } from "vitest";
import { isRepoRoot, resolveRepoRoot } from "../../src/config/repo-root";

describe("isRepoRoot", () => {
  const present = (paths: string[]) => (p: string) => paths.includes(p);

  it("accepts a dir that holds the worker project — the compose file is not needed since Phase 3", () => {
    expect(isRepoRoot("/r", present(["/r/be/worker/pyproject.toml"]))).toBe(true);
  });

  it("rejects a dir missing the worker project", () => {
    expect(isRepoRoot("/r", present(["/r/be/docker-compose.yml"]))).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isRepoRoot("", () => true)).toBe(false);
  });
});

describe("resolveRepoRoot (Phase 4 스펙 §6.3)", () => {
  const repo = (...roots: string[]) => (p: string) => roots.some((r) => p === `${r}/be/worker/pyproject.toml`);

  it("returns null for a packaged app without looking at REPO_ROOT or the disk", () => {
    // packaged는 번들 python으로 돈다 — 저장소를 요구하던 게이트(폴더 선택창)가 사라진다.
    const looked: string[] = [];
    const exists = (p: string) => {
      looked.push(p);
      return true;
    };
    expect(resolveRepoRoot({ packaged: true, configured: "/r", appPath: "/r/desktop" }, exists)).toBeNull();
    expect(looked).toEqual([]);
  });

  it("in dev takes REPO_ROOT from config.json when it is a repo", () => {
    expect(resolveRepoRoot({ packaged: false, configured: "/mine", appPath: "/r/desktop" }, repo("/mine", "/r"))).toBe("/mine");
  });

  it("in dev falls back to the app's parent when REPO_ROOT is not a repo", () => {
    expect(resolveRepoRoot({ packaged: false, configured: "/nowhere", appPath: "/r/desktop" }, repo("/r"))).toBe("/r");
    expect(resolveRepoRoot({ packaged: false, configured: undefined, appPath: "/r/desktop" }, repo("/r"))).toBe("/r");
  });

  it("in dev resolves a relative REPO_ROOT to an absolute path and validates that path", () => {
    // 이 값이 dev PYTHONPATH가 된다. 자식의 cwd가 <userData>가 되면 상대 경로는 다른 곳을 가리키고, Python은
    // 없는 sys.path 항목을 조용히 무시한다 — 번들의 옛 worker가 돈다.
    const abs = path.resolve("rel/repo");
    expect(resolveRepoRoot({ packaged: false, configured: "rel/repo", appPath: "/tmp/desktop" }, repo(abs))).toBe(abs);
    expect(path.isAbsolute(resolveRepoRoot({ packaged: false, configured: "./rel/repo", appPath: "/tmp/desktop" }, repo(abs))!)).toBe(true);
  });

  it("in dev does not read an empty REPO_ROOT as the current directory", () => {
    expect(resolveRepoRoot({ packaged: false, configured: "", appPath: "/tmp/desktop" }, repo(process.cwd()))).toBeNull();
  });

  it("in dev returns null when neither is a repo — the caller reports repoRootMissing, nothing asks", () => {
    expect(resolveRepoRoot({ packaged: false, configured: "/nowhere", appPath: "/tmp/desktop" }, repo("/r"))).toBeNull();
  });
});
