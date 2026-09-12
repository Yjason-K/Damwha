import { describe, expect, it } from "vitest";
import { isRepoRoot } from "../src/repo-root";

describe("isRepoRoot", () => {
  const present = (paths: string[]) => (p: string) => paths.includes(p);

  it("accepts a dir that holds both markers", () => {
    expect(
      isRepoRoot("/r", present(["/r/be/worker/pyproject.toml", "/r/be/docker-compose.yml"])),
    ).toBe(true);
  });

  it("rejects a dir missing the worker project", () => {
    expect(isRepoRoot("/r", present(["/r/be/docker-compose.yml"]))).toBe(false);
  });

  it("rejects a dir missing the compose file", () => {
    expect(isRepoRoot("/r", present(["/r/be/worker/pyproject.toml"]))).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isRepoRoot("", () => true)).toBe(false);
  });
});
