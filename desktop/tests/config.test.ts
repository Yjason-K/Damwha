import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

  it("carries the keys the app owns defaults for", () => {
    expect(Object.keys(defaultConfig("/tmp/ud")).sort()).toEqual([
      "DATABASE_URL",
      "EMBED_SERVICE_HOST",
      "EMBED_SERVICE_PORT",
      "PORT",
      "STORAGE_ROOT",
      "WORKER_ID",
    ]);
  });
});

describe("defaultConfig — Phase 2 keys", () => {
  it("defaults the embed port so one value drives three processes", () => {
    expect(defaultConfig("/u").EMBED_SERVICE_PORT).toBe("8100");
    expect(defaultConfig("/u").EMBED_SERVICE_HOST).toBe("127.0.0.1");
  });

  it("mints a worker id that cannot collide with an external worker", () => {
    // 기본값 worker-1을 외부 worker와 나눠 쓰면 locked_by만 보는 소유권 가드가
    // 둘을 구별하지 못한다 (스펙 §6.5).
    const a = defaultConfig("/u").WORKER_ID;
    const b = defaultConfig("/u").WORKER_ID;
    expect(a).toMatch(/^desktop-/);
    expect(a).not.toBe("worker-1");
    expect(a).not.toBe(b);
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

describe("loadConfig — app-owned keys", () => {
  it("still refuses to take HOST from the file", () => {
    // Phase 1의 규칙. config.json 한 줄로 API가 LAN에 열리면 안 된다.
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ HOST: "0.0.0.0" }));
    expect(loadConfig(dir).env.HOST).toBeUndefined();
  });

  it("takes EXTRA_PATH as a list and keeps it out of the child env", () => {
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ EXTRA_PATH: ["/opt/mine"] }));
    const c = loadConfig(dir);
    expect(c.extraPath).toEqual(["/opt/mine"]);
    // 배열은 자식 env에 문자열로 새어 들어가면 안 된다.
    expect(c.env.EXTRA_PATH).toBeUndefined();
  });

  it("ignores an EXTRA_PATH that is not a list of strings, and still keeps it out of env", () => {
    // 배열이 아닌 값은 무시한다 — 반쯤 맞는 목록을 PATH 앞에 붙이면 uv·docker 탐색이
    // 조용히 엉뚱한 곳을 본다. 문자열로 적힌 경우가 특히 중요하다: 위의 일반 경로는
    // 문자열을 그대로 env에 넣으므로, 앱 설정 분기가 먼저 가로채지 않으면 자식이
    // EXTRA_PATH를 환경변수로 받는다.
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ EXTRA_PATH: "/opt/mine" }));
    const c = loadConfig(dir);
    expect(c.extraPath).toEqual([]);
    expect(c.env.EXTRA_PATH).toBeUndefined();
  });

  it("reads REPO_ROOT, UV_BIN and DOCKER_BIN as app settings, not child env", () => {
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ REPO_ROOT: "/r", UV_BIN: "/x/uv", DOCKER_BIN: "/x/docker" }),
    );
    const c = loadConfig(dir);
    expect(c.repoRoot).toBe("/r");
    expect(c.uvBin).toBe("/x/uv");
    expect(c.dockerBin).toBe("/x/docker");
    expect(c.env.REPO_ROOT).toBeUndefined();
  });
});
