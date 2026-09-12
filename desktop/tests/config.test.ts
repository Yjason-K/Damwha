import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultConfig, loadConfig, refreshEnv } from "../src/config";

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
      "EMBED_SERVICE_PORT",
      "PORT",
      "STORAGE_ROOT",
      "WORKER_ID",
    ]);
  });

  it("does not carry EMBED_SERVICE_HOST — that key must never reach config.json", () => {
    // defaultConfig가 그대로 첫 실행의 config.json이 된다. 여기에 두면 인증 없는 embed
    // 서비스의 bind 주소가 사용자에게 "고쳐도 되는 값"으로 광고된다 (리뷰 Important-1).
    expect(defaultConfig("/u").EMBED_SERVICE_HOST).toBeUndefined();
  });
});

describe("defaultConfig — Phase 2 keys", () => {
  it("defaults the embed port so one value drives three processes", () => {
    expect(defaultConfig("/u").EMBED_SERVICE_PORT).toBe("8100");
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
    // 파일에는 없고,
    expect("EMBED_SERVICE_HOST" in onDisk).toBe(false);
    // 자식 env에는 앱이 직접 얹는다. 아무것도 넣지 않으면 be/worker/.env의 낡은 값이 이긴다 —
    // pydantic-settings는 환경변수를 .env보다 먼저 본다.
    expect(r.env.EMBED_SERVICE_HOST).toBe("127.0.0.1");
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
  it("says out loud that it discarded an app-owned key the file tried to set", () => {
    // 조용히 버리면 사용자는 자기가 적은 값이 왜 안 먹는지 알 길이 없다. EXTRA_PATH와 같은
    // 규칙이다 — 무시했으면 왜 무시했는지 적는다.
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ EMBED_SERVICE_HOST: "0.0.0.0", HOST: "0.0.0.0" }),
    );
    const c = loadConfig(dir);
    expect(c.warning).toMatch(/EMBED_SERVICE_HOST/);
    expect(c.warning).toMatch(/HOST/);
  });

  it("pins EMBED_SERVICE_HOST to loopback however the file writes it", () => {
    // config.json 한 줄로 **인증이 없는** embed 서비스가 LAN에 열린다. HOST와 같은 규칙이다.
    // be/worker/damwha_worker/embed_service.py가 이 값을 uvicorn.run(host=…)에 그대로 넘긴다.
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ EMBED_SERVICE_HOST: "0.0.0.0" }));
    expect(loadConfig(dir).env.EMBED_SERVICE_HOST).toBe("127.0.0.1");
  });

  it("asserts loopback even when the file says nothing about it", () => {
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ PORT: "3100" }));
    expect(loadConfig(dir).env.EMBED_SERVICE_HOST).toBe("127.0.0.1");
  });

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

  it("rejects an EXTRA_PATH whose elements are not all strings, and says why", () => {
    // 섞인 배열은 Array.isArray를 통과한다. 원소 타입을 보지 않으면 ["/opt/x", 3]이
    // searchDirs를 지나 findExecutable의 path.join(3, "uv")에서 던지고, 사용자는
    // `앱을 시작하지 못했어요: The "path" argument must be of type string`만 본다
    // (리뷰 Minor-1 — 이 변이는 235개 초록불 아래 살아남았다).
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ EXTRA_PATH: ["/opt/x", 3] }));
    const c = loadConfig(dir);
    expect(c.extraPath).toEqual([]);
    expect(c.env.EXTRA_PATH).toBeUndefined();
    // 조용히 버리면 사용자는 자기가 적은 경로가 왜 안 먹는지 알 길이 없다.
    expect(c.warning).toMatch(/EXTRA_PATH/);
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

describe("refreshEnv", () => {
  it("lets a corrected config.json value reach a running LaunchContext", () => {
    // 완료 기준 P2-C8. 실패 화면은 "값을 고치면 다시 시도합니다"라고 적는데, 감독자를 실행당
    // 하나만 만드는 구조에서는 ctx.env가 생성 시점에 얼어붙어 그 문장이 거짓이 된다.
    const current = { DATABASE_URL: "postgres://wrong", PORT: "3000" };
    const baseline = { ...current };
    const changed = refreshEnv(current, baseline, { DATABASE_URL: "postgres://right", PORT: "3000" });
    expect(current.DATABASE_URL).toBe("postgres://right");
    expect(changed).toEqual(["DATABASE_URL"]);
  });

  it("does not undo a value prepare() moved to match a live child", () => {
    // embed의 prepare는 포트가 겹치면 EMBED_SERVICE_PORT를 옮기고 EMBED_SERVICE_URL을 그
    // 한 값에서 파생시킨다. 파일 값으로 되돌리면 둘이 어긋나고, 어긋난 결과는 오류가 아니라
    // 조용한 degrade다.
    const current = { EMBED_SERVICE_PORT: "54321", EMBED_SERVICE_URL: "http://127.0.0.1:54321" };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const changed = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "8100" });
    expect(current.EMBED_SERVICE_PORT).toBe("54321");
    expect(changed).toEqual([]);
  });

  it("reports nothing when the file has not changed", () => {
    const current = { PORT: "3000" };
    const baseline = { PORT: "3000" };
    expect(refreshEnv(current, baseline, { PORT: "3000" })).toEqual([]);
  });

  it("takes a second edit to the same key — the baseline moves with the file", () => {
    // baseline을 갱신하지 않으면 한 번 바뀐 키는 "prepare()가 고친 값"으로 오인돼 두 번째
    // 수정을 영영 받지 못한다.
    const current = { PORT: "3000" };
    const baseline = { PORT: "3000" };
    refreshEnv(current, baseline, { PORT: "3100" });
    expect(refreshEnv(current, baseline, { PORT: "3200" })).toEqual(["PORT"]);
    expect(current.PORT).toBe("3200");
  });

  it("adds a key the file gained since startup", () => {
    const current: Record<string, string> = { PORT: "3000" };
    const baseline: Record<string, string> = { PORT: "3000" };
    refreshEnv(current, baseline, { PORT: "3000", SUMMARY_LLM_MODEL: "x" });
    expect(current.SUMMARY_LLM_MODEL).toBe("x");
  });
});
