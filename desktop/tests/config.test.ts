import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultConfig, loadConfig } from "../src/config";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-config-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  it("puts storage under the user data directory as an absolute path", () => {
    const env = defaultConfig("/tmp/ud");
    expect(env.STORAGE_ROOT).toBe(path.join("/tmp/ud", "storage"));
    expect(path.isAbsolute(env.STORAGE_ROOT)).toBe(true);
  });

  it("carries the three keys the app owns defaults for", () => {
    expect(Object.keys(defaultConfig("/tmp/ud")).sort()).toEqual([
      "DATABASE_URL",
      "PORT",
      "STORAGE_ROOT",
    ]);
  });
});

describe("loadConfig", () => {
  it("creates config.json with the defaults on first run", () => {
    const r = loadConfig(dir);
    expect(r.created).toBe(true);
    expect(r.warning).toBeUndefined();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(onDisk.DATABASE_URL).toBe("postgres://postgres:postgres@localhost:5432/damwha");
    expect(onDisk.PORT).toBe("3000");
  });

  it("passes through keys that have no app default", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ SUMMARY_LLM_MODEL: "mlx-community/Qwen3.5-4B-8bit" }),
    );
    expect(loadConfig(dir).env.SUMMARY_LLM_MODEL).toBe("mlx-community/Qwen3.5-4B-8bit");
  });

  it("stringifies numbers and booleans because env values are strings", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ PORT: 4100, DEMO_READ_ONLY: false }));
    const env = loadConfig(dir).env;
    expect(env.PORT).toBe("4100");
    expect(env.DEMO_READ_ONLY).toBe("false");
  });

  it("resolves a relative STORAGE_ROOT against the user data directory", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ STORAGE_ROOT: "./audio" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe(path.join(dir, "audio"));
  });

  it("keeps an absolute STORAGE_ROOT as given", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ STORAGE_ROOT: "/srv/damwha" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe("/srv/damwha");
  });

  it("falls back to defaults on broken JSON without overwriting the file", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{ not json");
    const r = loadConfig(dir);
    expect(r.created).toBe(false);
    expect(r.warning).toBeDefined();
    expect(r.env.PORT).toBe("3000");
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("warns when the file is valid JSON but not an object", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify([1, 2]));
    const r = loadConfig(dir);
    expect(r.warning).toBeDefined();
    expect(r.env.PORT).toBe("3000");
  });

  it("never returns a HOST key — the app injects that itself", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ HOST: "0.0.0.0" }));
    expect(loadConfig(dir).env.HOST).toBeUndefined();
  });
});
