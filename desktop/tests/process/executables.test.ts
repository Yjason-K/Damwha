import { describe, expect, it } from "vitest";
import { buildChildPath, findExecutable, searchDirs } from "../../src/process/executables";

describe("searchDirs", () => {
  it("expands {HOME} and keeps the documented order", () => {
    const dirs = searchDirs("/Users/x");
    expect(dirs[0]).toBe("/opt/homebrew/bin");
    expect(dirs).toContain("/Users/x/.local/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs.at(-1)).toBe("/sbin");
  });

  it("puts extra dirs first", () => {
    expect(searchDirs("/Users/x", ["/opt/mine"])[0]).toBe("/opt/mine");
  });

  it("drops duplicates, keeping the earliest position", () => {
    const dirs = searchDirs("/Users/x", ["/usr/local/bin"]);
    expect(dirs[0]).toBe("/usr/local/bin");
    expect(dirs.filter((d) => d === "/usr/local/bin")).toHaveLength(1);
  });
});

describe("findExecutable", () => {
  it("returns the first directory that holds an executable", () => {
    const found = findExecutable("uv", ["/a", "/b"], (p) => p === "/b/uv");
    expect(found).toBe("/b/uv");
  });

  it("returns null when nothing is executable", () => {
    expect(findExecutable("uv", ["/a", "/b"], () => false)).toBeNull();
  });

  it("never throws when the probe throws", () => {
    expect(
      findExecutable("uv", ["/a"], () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });
});

describe("buildChildPath", () => {
  it("puts the search dirs in front of the inherited PATH", () => {
    expect(buildChildPath(["/opt/homebrew/bin"], "/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("does not repeat a dir that the inherited PATH already has", () => {
    expect(buildChildPath(["/usr/bin", "/opt/homebrew/bin"], "/usr/bin:/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("works when there is no inherited PATH", () => {
    expect(buildChildPath(["/opt/homebrew/bin"], undefined)).toBe("/opt/homebrew/bin");
  });
});
