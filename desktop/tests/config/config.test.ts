import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appOwnedChildEnv,
  DB_ENV_KEYS,
  defaultConfig,
  LEGACY_DATABASE_URL,
  llmBaseUrl,
  loadConfig,
  pycachePrefix,
  refreshEnv,
  sanitizeChildEnv,
  STRIPPED_CHILD_ENV_KEYS,
  withoutDbKeys,
} from "../../src/config/config";
import { CAUSES } from "../../src/diagnostics/causes";
import { embeddedDatabaseUrl, pgLayout } from "../../src/services/postgres/layout";
import type { LaunchContext } from "../../src/services/types";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-config-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  it("does not put the database or the storage into the first config.json — the app derives both (Phase 3)", () => {
    // Phase 1·2는 여기에 Docker DB 주소와 <userData>/storage를 적었고, 그 값이 사람이 고른 것인지 옛 기본값인지
    // 파일만으로 구별되지 않게 됐다 (Phase 3 스펙 §6.1 옛 키).
    const env = defaultConfig("/tmp/ud");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STORAGE_ROOT).toBeUndefined();
  });

  it("carries the keys the app owns defaults for — and not WORKER_ID, which is per run", () => {
    expect(Object.keys(defaultConfig("/tmp/ud")).sort()).toEqual(["EMBED_SERVICE_PORT", "PORT"]);
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
    const id = loadConfig(dir).env.WORKER_ID;
    expect(id).toMatch(/^desktop-/);
    expect(id).not.toBe("worker-1");
  });

  it("keeps the same worker id for every call in one run", async () => {
    // 재리뷰 §4-2. 재시도가 loadConfig를 다시 부를 때마다 id가 새로 발급되면, 백오프가 되살린
    // worker가 **새 신분으로** 떠서 옛 id로 locked_by가 찍힌 job을 다시 집지 못하고(스펙 §6.5),
    // 재적용 진단은 파일을 건드리지도 않았는데 "바뀐 키: WORKER_ID"를 3·8·20초마다 적는다.
    // 첫 호출은 config.json을 만들고 둘째는 그것을 읽는다 — 두 경로가 같은 값을 줘야 한다.
    const first = loadConfig(dir);
    expect(first.created).toBe(true);
    expect(loadConfig(dir).env.WORKER_ID).toBe(first.env.WORKER_ID);
    // 파일이 값을 못 주는 경로에서도 같아야 한다 — 그 경로가 정확히 재시도 루프와 같이 온다.
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    expect(loadConfig(dir).env.WORKER_ID).toBe(first.env.WORKER_ID);
  });

  it("does not write the worker id to config.json", () => {
    // 적으면 다음 실행이 그 파일을 읽는다. 아래 테스트가 그때도 새 id가 나오는지를 보지만, 사람에게
    // "고쳐도 되는 값"으로 광고하지 않는 것도 따로 지킨다 (EMBED_SERVICE_HOST와 같은 규칙).
    loadConfig(dir);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect("WORKER_ID" in onDisk).toBe(false);
  });

  it("mints a new worker id for the next run even when config.json still holds the previous run's id", async () => {
    // 최종 리뷰 I-4. 예전 테스트는 "모듈을 다시 불러오는 것"을 새 실행으로 보고 defaultConfig만
    // 불렀다 — 진짜 두 번째 실행은 **config.json도 읽는다**는 사실을 빼먹어, 첫 실행이 id를 파일에
    // 적고 둘째가 그것을 다시 쓰는 동안에도 초록이었다. 여기서는 같은 userData로 두 실행을 돌리고,
    // 둘 사이에 이전 빌드가 남긴 모양 그대로 파일에 첫 실행의 id를 넣어 둔다.
    const run1 = loadConfig(dir).env.WORKER_ID;
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), WORKER_ID: run1 }));

    vi.resetModules();
    const run2 = (await import("../../src/config/config")).loadConfig(dir).env.WORKER_ID;
    expect(run2).toMatch(/^desktop-/);
    expect(run2).not.toBe(run1);
  });
});

describe("loadConfig", () => {
  it("creates config.json with the defaults on first run", () => {
    const r = loadConfig(dir);
    expect(r.created).toBe(true);
    expect(r.warning).toBeUndefined();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect("DATABASE_URL" in onDisk).toBe(false);
    expect(onDisk.PORT).toBe("3000");
    expect("EMBED_SERVICE_HOST" in onDisk).toBe(false);
    expect(r.env.EMBED_SERVICE_HOST).toBe("127.0.0.1");
    expect(r.databaseMode).toEqual({ kind: "embedded" });
    expect(r.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
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

  it("resolves a relative STORAGE_ROOT against the user data directory in external debug mode", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ DEBUG_EXTERNAL_DATABASE_URL: "postgres://x@h/db", STORAGE_ROOT: "./audio" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe(path.join(dir, "audio"));
  });

  it("keeps an absolute STORAGE_ROOT as given in external debug mode", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ DEBUG_EXTERNAL_DATABASE_URL: "postgres://x@h/db", STORAGE_ROOT: "/srv/damwha" }));
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

  // 기본값으로 떨어지는 경로에서도 앱이 주장하는 두 값은 그대로여야 한다. 빠지면 자식이
  // be/worker/.env를 읽어 WORKER_ID가 외부 worker와 같은 `worker-1`이 되고(스펙 §6.5), embed의
  // 루프백 바인딩도 그 파일이 정하게 된다(§6.11). 네 경로 중 두 곳은 이것을 지키는 테스트가
  // 없었다(최종 재리뷰 M-A).
  const appOwnedHold = (env: Record<string, string>) => {
    expect(env.EMBED_SERVICE_HOST).toBe("127.0.0.1");
    expect(env.WORKER_ID).toMatch(/^desktop-/);
  };

  it("keeps the app-owned values when config.json is not an object", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify([1, 2]));
    appOwnedHold(loadConfig(dir).env);
  });

  it("keeps the app-owned values when config.json cannot be created", () => {
    // userData가 디렉터리가 아니라 파일 밑이면 mkdir이 ENOTDIR로 실패한다 — 권한을 건드리지 않고
    // "만들 수 없다" 경로를 연다.
    const blocker = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const r = loadConfig(path.join(blocker, "userData"));
    expect(r.created).toBe(false);
    expect(r.warning).toMatch(/만들 수 없어/);
    appOwnedHold(r.env);
  });

  it("keeps the app-owned values when config.json is broken JSON", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    appOwnedHold(loadConfig(dir).env);
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

  it("reads REPO_ROOT and UV_BIN as app settings, and ignores DOCKER_BIN with a log note (Phase 3)", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ REPO_ROOT: "/r", UV_BIN: "/x/uv", DOCKER_BIN: "/x/docker" }),
    );
    const c = loadConfig(dir);
    expect(c.repoRoot).toBe("/r");
    expect(c.uvBin).toBe("/x/uv");
    expect("dockerBin" in c).toBe(false);
    for (const key of ["REPO_ROOT", "UV_BIN", "DOCKER_BIN"]) expect(key in c.env).toBe(false);
    expect(c.warning).toBeUndefined();
    expect(c.notes.join("\n")).toMatch(/DOCKER_BIN/);
  });
});

describe("refreshEnv", () => {
  /** 이 파일은 기구만 본다. 실제로 어느 키가 여기 들어가는지는 config-reload.test.ts가 잠근다. */
  const RESTART_ONLY = ["EMBED_SERVICE_PORT", "EMBED_SERVICE_URL", "WORKER_ID"];

  it("lets a corrected config.json value reach a running LaunchContext", () => {
    // 완료 기준 P2-C8. 실패 화면은 "값을 고치면 다시 시도합니다"라고 적는데, 감독자를 실행당
    // 하나만 만드는 구조에서는 ctx.env가 생성 시점에 얼어붙어 그 문장이 거짓이 된다.
    const current = { DATABASE_URL: "postgres://wrong", PORT: "3000" };
    const baseline = { ...current };
    const out = refreshEnv(
      current,
      baseline,
      { DATABASE_URL: "postgres://right", PORT: "3000" },
      RESTART_ONLY,
    );
    expect(current.DATABASE_URL).toBe("postgres://right");
    expect(out.changed).toEqual(["DATABASE_URL"]);
  });

  it("does not undo a value prepare() moved to match a live child", () => {
    // **갱신 루프**의 `current[key] !== baseline[key]` 한 줄을 지키는 테스트다. 파일이 말한
    // 값(baseline)에서 살아 있는 값이 이미 옮겨져 있으면 파일이 이긴다고 볼 수 없다.
    //
    // 이 테스트는 원래 EMBED_SERVICE_PORT를 썼는데, 라운드 2가 그 키를 restartOnly 분기로
    // 빼내면서 **지키려던 줄에 닿지 않게 됐다** — 초록인 채로 다른 것을 지키고 있었고, 그 줄을
    // 지우는 변이가 294개 초록 아래 살아남았다 (재재리뷰 §4-2). 그래서 restart-only가 아닌
    // 키로 다시 쓴다. 새 분기를 낼 때는 기존 테스트가 아직 원래 줄에 닿는지 같이 봐야 한다.
    const current = { SUMMARY_LLM_MODEL: "moved-by-prepare", PORT: "3000" };
    const baseline = { SUMMARY_LLM_MODEL: "from-file", PORT: "3000" };
    const out = refreshEnv(
      current,
      baseline,
      { SUMMARY_LLM_MODEL: "from-file", PORT: "3000" },
      RESTART_ONLY,
    );
    expect(current.SUMMARY_LLM_MODEL).toBe("moved-by-prepare");
    expect(out.changed).toEqual([]);
  });

  it("says nothing when prepare() moved the port and the file never changed", () => {
    // 재재리뷰 §4-5. 외부 embed가 8100을 쥐고 있으면 prepare가 스펙 §6.5대로 포트를 옮긴다 —
    // 그것이 **정상 상태**다. 사용자는 파일을 건드린 적이 없고, 앱을 다시 켜도 외부 embed가
    // 그대로면 또 옮긴다. 여기서 "다시 켜야 바뀌어요"를 띄우면 실패 화면에서 진짜 실패 줄과
    // 나란히, 사용자가 할 수 있는 일이 없는 곳으로 보내는 문장이 재시도마다 선다.
    const current = { EMBED_SERVICE_PORT: "54321", EMBED_SERVICE_URL: "http://127.0.0.1:54321" };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const out = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "8100" }, RESTART_ONLY);
    expect(out.needsRestart).toEqual([]);
    expect(out.changed).toEqual([]);
    expect(current.EMBED_SERVICE_PORT).toBe("54321");
  });

  it("stops asking for a restart once the file names the value that is actually running", () => {
    // 판정의 다른 축. 사용자가 파일을 고치기는 했는데(54321 !== baseline 8100) 고친 결과가
    // 살아 있는 값과 같다 — 어긋난 것이 없으므로 할 말도 없다. baseline만 보는 판정은 여기서
    // 거짓 안내를 낸다.
    const current = { EMBED_SERVICE_PORT: "54321" };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const out = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "54321" }, RESTART_ONLY);
    expect(out.needsRestart).toEqual([]);
    expect(current.EMBED_SERVICE_PORT).toBe("54321");
  });

  it("refuses a key prepare() derives from even when the live value is still the file's", () => {
    // **갱신 루프의 restartOnly 단락**을 지키는 테스트다. current === baseline이라 prepare-moved
    // 배제는 여기서 아무것도 하지 않는다 — 단락이 빠지면 이 값은 그대로 얹힌다. 위의
    // "does not undo a value prepare() moved…"와 짝이고, 둘이 갱신 루프의 두 분기를 나눠 진다.
    const current = { EMBED_SERVICE_PORT: "8100" };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const out = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "9000" }, RESTART_ONLY);
    expect(current.EMBED_SERVICE_PORT).toBe("8100");
    expect(out.changed).toEqual([]);
    expect(out.needsRestart.map((r) => r.key)).toEqual(["EMBED_SERVICE_PORT"]);
  });

  it("refuses a key prepare() derives from, however the file and the live value differ", () => {
    // 재리뷰 §4-1. 파생의 **입력**을 다시 읽으면서 파생을 다시 돌리지 않는 것은 아예 다시
    // 읽지 않는 것보다 나쁘다: embed는 9000에 bind하고 준비 판정은 8100을 찌르고(180초 뒤
    // failed ×3), API에게 넘어간 URL은 :8100이라 의미 검색이 오류 없이 키워드 검색으로
    // 떨어진다. 살아 있는 감독자 안에서 PORT와 URL이 어긋나는 일은 없어야 한다.
    const current = {
      EMBED_SERVICE_PORT: "8100",
      EMBED_SERVICE_URL: "http://127.0.0.1:8100",
    };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const out = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "9000" }, RESTART_ONLY);
    expect(current.EMBED_SERVICE_PORT).toBe("8100");
    expect(current.EMBED_SERVICE_URL).toBe("http://127.0.0.1:8100");
    expect(out.changed).toEqual([]);
  });

  it("reports the refused key with both values so the screen can say what disagrees", () => {
    const current = { EMBED_SERVICE_PORT: "8100" };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const out = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "9000" }, RESTART_ONLY);
    expect(out.needsRestart).toEqual([
      { key: "EMBED_SERVICE_PORT", file: "9000", live: "8100" },
    ]);
  });

  it("reports the mirror case too — prepare moved the port and the file still disagrees", () => {
    // 이쪽은 예전에 완전히 침묵했다: current !== baseline이라 continue로 빠지고 changed가
    // 비어 있어 로그도 화면도 아무 말을 하지 않았다. 사용자의 수정은 영영 무시된다.
    const current = { EMBED_SERVICE_PORT: "54321" };
    const baseline = { EMBED_SERVICE_PORT: "8100" };
    const out = refreshEnv(current, baseline, { EMBED_SERVICE_PORT: "9000" }, RESTART_ONLY);
    expect(out.needsRestart).toEqual([
      { key: "EMBED_SERVICE_PORT", file: "9000", live: "54321" },
    ]);
    expect(current.EMBED_SERVICE_PORT).toBe("54321");
  });

  it("says nothing about a restart-only key the file agrees with", () => {
    const current = { EMBED_SERVICE_PORT: "8100", WORKER_ID: "desktop-a" };
    const baseline = { ...current };
    const out = refreshEnv(
      current,
      baseline,
      { EMBED_SERVICE_PORT: "8100", WORKER_ID: "desktop-a" },
      RESTART_ONLY,
    );
    expect(out.needsRestart).toEqual([]);
    expect(out.changed).toEqual([]);
  });

  it("never swaps a running worker's identity", () => {
    // 재리뷰 §4-2의 다른 절반. WORKER_ID는 이 실행의 신분이다 — 살아 있는 worker 밑에서
    // 바뀌면 백오프가 되살린 worker가 새 id로 떠서 옛 id의 locked_by 행이 고아가 된다.
    const current = { WORKER_ID: "desktop-live" };
    const baseline = { WORKER_ID: "desktop-live" };
    const out = refreshEnv(current, baseline, { WORKER_ID: "desktop-other" }, RESTART_ONLY);
    expect(current.WORKER_ID).toBe("desktop-live");
    expect(out.changed).toEqual([]);
    expect(out.needsRestart.map((r) => r.key)).toEqual(["WORKER_ID"]);
  });

  it("reports nothing when the file has not changed", () => {
    const current = { PORT: "3000" };
    const baseline = { PORT: "3000" };
    const out = refreshEnv(current, baseline, { PORT: "3000" }, RESTART_ONLY);
    expect(out).toEqual({ changed: [], removed: [], needsRestart: [] });
  });

  it("takes a second edit to the same key — the baseline moves with the file", () => {
    // baseline을 갱신하지 않으면 한 번 바뀐 키는 "prepare()가 고친 값"으로 오인돼 두 번째
    // 수정을 영영 받지 못한다.
    const current = { PORT: "3000" };
    const baseline = { PORT: "3000" };
    refreshEnv(current, baseline, { PORT: "3100" }, RESTART_ONLY);
    expect(refreshEnv(current, baseline, { PORT: "3200" }, RESTART_ONLY).changed).toEqual(["PORT"]);
    expect(current.PORT).toBe("3200");
  });

  it("adds a key the file gained since startup", () => {
    const current: Record<string, string> = { PORT: "3000" };
    const baseline: Record<string, string> = { PORT: "3000" };
    refreshEnv(current, baseline, { PORT: "3000", SUMMARY_LLM_MODEL: "x" }, RESTART_ONLY);
    expect(current.SUMMARY_LLM_MODEL).toBe("x");
  });

  it("drops a key the user deleted from config.json", () => {
    // 재리뷰 §4-8. "파일을 다시 읽는다"가 파일과 옛 값의 합집합을 뜻하면, 키를 지운
    // 사용자에게는 화면의 "값을 고치면 다시 시도합니다"가 여전히 거짓이다.
    const current: Record<string, string> = { PORT: "3000", SUMMARY_LLM_MODEL: "old" };
    const baseline: Record<string, string> = { PORT: "3000", SUMMARY_LLM_MODEL: "old" };
    const out = refreshEnv(current, baseline, { PORT: "3000" }, RESTART_ONLY);
    expect(current.SUMMARY_LLM_MODEL).toBeUndefined();
    expect(out.removed).toEqual(["SUMMARY_LLM_MODEL"]);
    // 두 번째 재시도가 같은 키를 또 지웠다고 말하지 않는다.
    expect(refreshEnv(current, baseline, { PORT: "3000" }, RESTART_ONLY).removed).toEqual([]);
  });

  it("does not let the file's silence strip this run's identity", () => {
    // **삭제 루프의 restartOnly 가드**. config.json에서 WORKER_ID를 지우는 것은 평범한
    // 조작이다("앱이 알아서 만들겠지"). 그 침묵이 살아 있는 env에서도 그것을 지우면 백오프가
    // 되살린 worker는 be/worker/damwha_worker/config.py:13의 기본값 worker-1로 뜨고,
    // locked_by만 보는 소유권 가드가 외부 worker와 이 앱을 구별하지 못한다 — 스펙 §6.5가
    // WORKER_ID를 실행마다 새로 만드는 이유가 통째로 무효가 된다 (재재리뷰 §4-1).
    //
    // current === baseline이므로 prepare-moved 배제는 여기서 아무것도 하지 않는다. 이 키를
    // 살리는 줄은 restartOnly 가드 하나뿐이다.
    const current: Record<string, string> = { WORKER_ID: "desktop-live", PORT: "3000" };
    const baseline: Record<string, string> = { ...current };
    const out = refreshEnv(current, baseline, { PORT: "3000" }, RESTART_ONLY);
    expect(current.WORKER_ID).toBe("desktop-live");
    expect(out.removed).toEqual([]);
  });

  it("does not let the file's silence delete a value prepare() contributed", () => {
    // prepare가 만든 EMBED_SERVICE_URL은 파일에 원래 없다. 파일에 없다는 이유로 지우면
    // 살아 있는 embed의 주소가 사라진다.
    const current: Record<string, string> = {
      PORT: "3000",
      SUMMARY_LLM_MODEL: "moved-by-prepare",
    };
    const baseline: Record<string, string> = { PORT: "3000", SUMMARY_LLM_MODEL: "from-file" };
    const out = refreshEnv(current, baseline, { PORT: "3000" }, RESTART_ONLY);
    expect(current.SUMMARY_LLM_MODEL).toBe("moved-by-prepare");
    expect(out.removed).toEqual([]);
  });
});

describe("loadConfig — database mode (Phase 3 스펙 §6.1)", () => {
  const write = (obj: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj));

  it("derives the embedded database and its paired storage by default", () => {
    write({ PORT: "3000" });
    const c = loadConfig(dir);
    const layout = pgLayout(dir);
    expect(c.databaseMode).toEqual({ kind: "embedded" });
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(layout));
    expect(c.env.STORAGE_ROOT).toBe(layout.storage);
  });

  it("ignores the Phase 1·2 defaults quietly — a note for the log, nothing on screen, the file untouched", () => {
    write({ DATABASE_URL: LEGACY_DATABASE_URL, STORAGE_ROOT: path.join(dir, "storage"), PORT: "3000" });
    const before = fs.readFileSync(path.join(dir, "config.json"));
    const c = loadConfig(dir);
    expect(c.warning).toBeUndefined();
    expect(c.notes).toHaveLength(2);
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
    expect(c.env.STORAGE_ROOT).toBe(pgLayout(dir).storage);
    expect(fs.readFileSync(path.join(dir, "config.json")).equals(before)).toBe(true);
  });

  it("warns on screen about a DATABASE_URL someone chose, and still uses the embedded database", () => {
    write({ DATABASE_URL: "postgres://me:pw@db.internal:5432/other" });
    const c = loadConfig(dir);
    expect(c.warning).toMatch(/DATABASE_URL/);
    expect(c.warning).toMatch(/DEBUG_EXTERNAL_DATABASE_URL/);
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
  });

  it("masks the password in a discarded DATABASE_URL instead of printing it raw to screen and supervisor.log", () => {
    // 사람이 손으로 적은 URL은 진짜 비밀번호를 담고 있을 수 있다. 옛 키 경고는 화면에도 뜨고
    // supervisor.log에도 남으므로 원문을 그대로 옮기면 그 비밀번호가 로그 파일에 평문으로 앉는다.
    write({ DATABASE_URL: "postgres://me:s3cret@db.example:5432/x" });
    const c = loadConfig(dir);
    expect(c.warning).toBeDefined();
    expect(c.warning).not.toContain("s3cret");
    expect(c.warning).toContain("***");
  });

  it("omits the value entirely when the discarded DATABASE_URL cannot be parsed as a URL", () => {
    write({ DATABASE_URL: "not-a-url-at-all" });
    const c = loadConfig(dir);
    expect(c.warning).toBeDefined();
    expect(c.warning).not.toContain("not-a-url-at-all");
  });

  it("switches to external debug mode only when DEBUG_EXTERNAL_DATABASE_URL is written, and keeps that key out of the child env", () => {
    write({ DEBUG_EXTERNAL_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha" });
    const c = loadConfig(dir);
    expect(c.databaseMode).toEqual({ kind: "external", url: "postgres://postgres:postgres@localhost:5432/damwha" });
    expect(c.env.DATABASE_URL).toBe("postgres://postgres:postgres@localhost:5432/damwha");
    expect(c.env.STORAGE_ROOT).toBe(path.join(dir, "storage"));
    expect("DEBUG_EXTERNAL_DATABASE_URL" in c.env).toBe(false);
  });

  it("rejects a DEBUG_EXTERNAL_DATABASE_URL that is not a non-empty string and stays embedded", () => {
    write({ DEBUG_EXTERNAL_DATABASE_URL: 5432 });
    const c = loadConfig(dir);
    expect(c.databaseMode).toEqual({ kind: "embedded" });
    expect(c.warning).toMatch(/DEBUG_EXTERNAL_DATABASE_URL/);
  });

  it("stays embedded when config.json is broken", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    const c = loadConfig(dir);
    expect(c.databaseMode).toEqual({ kind: "embedded" });
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
  });

  it("strips exactly the database keys for the reload baseline", () => {
    expect(DB_ENV_KEYS).toEqual(["DATABASE_URL", "STORAGE_ROOT"]);
    expect(withoutDbKeys({ DATABASE_URL: "a", STORAGE_ROOT: "b", PORT: "3000" })).toEqual({ PORT: "3000" });
  });
});

describe("child env hygiene (Phase 4 스펙 §6.3)", () => {
  const REPO = "/Users/me/daewha";
  const USER_DATA = "/Users/me/Library/Application Support/Damwha";
  const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
    repoRoot: REPO,
    userData: USER_DATA,
    packaged: false,
    databaseMode: "embedded",
    env: { LENS_LLM_BASE_URL: llmBaseUrl(51234) },
    bins: {
      uv: null,
      python: `${REPO}/desktop/build/python/bin/python3.12`,
      ffmpeg: `${REPO}/desktop/build/ffmpeg/bin/ffmpeg`,
      ffprobe: `${REPO}/desktop/build/ffmpeg/bin/ffprobe`,
    },
    runId: "desktop-test",
    searchDirs: [],
    logFile: (id) => `${USER_DATA}/logs/${id}.log`,
    signal: new AbortController().signal,
    ...over,
  });
  const packaged = (over: Partial<LaunchContext> = {}) =>
    ctx({
      repoRoot: null,
      packaged: true,
      bins: {
        uv: null,
        python: "/Applications/Damwha.app/Contents/Resources/python/bin/python3.12",
        ffmpeg: "/Applications/Damwha.app/Contents/Resources/ffmpeg/bin/ffmpeg",
        ffprobe: "/Applications/Damwha.app/Contents/Resources/ffmpeg/bin/ffprobe",
      },
      ...over,
    });
  /** Task 5의 런처가 쓰는 합성 규칙 그대로 — 합친 뒤 씻고, 앱 값을 그 뒤에 얹는다 (appOwnedChildEnv의 주석). */
  const compose = (inherited: Record<string, string | undefined>, c: LaunchContext) => ({
    ...sanitizeChildEnv({ ...inherited, ...c.env }),
    ...appOwnedChildEnv(c),
  });

  it("strips exactly the keys of the spec table, PYTHONPATH and PYTHONDONTWRITEBYTECODE included", () => {
    expect([...STRIPPED_CHILD_ENV_KEYS].sort()).toEqual(
      [
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PYTHONUSERBASE",
        "PYTHONDONTWRITEBYTECODE",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
        "HF_HUB_CACHE",
        "TRANSFORMERS_CACHE",
        "TORCH_HOME",
        "XDG_CACHE_HOME",
        "PYTHONPATH",
      ].sort(),
    );
  });

  it("sanitizeChildEnv drops every stripped key and every undefined value, keeps the rest, and leaves its input alone", () => {
    const input: Record<string, string | undefined> = { HOME: "/Users/me", EMPTY: undefined, KEEP: "" };
    for (const key of STRIPPED_CHILD_ENV_KEYS) input[key] = `/from/${key}`;
    const before = { ...input };
    expect(sanitizeChildEnv(input)).toEqual({ HOME: "/Users/me", KEEP: "" });
    expect(input).toEqual(before);
  });

  it("claims the model cache, the bundled ffmpeg pair, the bytecode prefix and the LLM address", () => {
    const c = ctx();
    const owned = appOwnedChildEnv(c);
    expect(owned.HF_HOME).toBe(path.join(USER_DATA, "models"));
    expect(owned.FFMPEG_BIN).toBe(c.bins.ffmpeg);
    expect(owned.FFPROBE_BIN).toBe(c.bins.ffprobe);
    expect(owned.PYTHONPYCACHEPREFIX).toBe(pycachePrefix(USER_DATA));
    expect(pycachePrefix(USER_DATA)).toBe(path.join(USER_DATA, "pycache"));
    expect(owned.LENS_LLM_BASE_URL).toBe("http://127.0.0.1:51234/v1");
  });

  it("gives PYTHONPYCACHEPREFIX in every mode — worker, embed and llm_entry all inherit this one env", () => {
    // Part 1 Task 6이 넘긴 계약(6회차 BL-1). 자식 스폰 3곳(capabilities·--once·llm_entry)은 env= 없이
    // 상속하므로, 감독자가 주는 env에 들어 있으면 셋 다 덮인다. 빠지면 번들 트리에 .pyc가 쌓인다.
    for (const c of [ctx(), packaged(), ctx({ databaseMode: "external" }), packaged({ databaseMode: "external" })]) {
      const env = compose({ PYTHONDONTWRITEBYTECODE: "1" }, c);
      expect(env.PYTHONPYCACHEPREFIX).toBe(path.join(USER_DATA, "pycache"));
      // 상속되면 prefix를 조용히 이겨 import가 4.5배 느려진다.
      expect("PYTHONDONTWRITEBYTECODE" in env).toBe(false);
    }
  });

  it("points PYTHONPATH at the repo's worker in dev only", () => {
    expect(appOwnedChildEnv(ctx()).PYTHONPATH).toBe(path.join(REPO, "be", "worker"));
    expect("PYTHONPATH" in appOwnedChildEnv(packaged())).toBe(false);
  });

  it("refuses to build a dev env without a repo instead of silently running the bundled worker", () => {
    // PYTHONPATH가 빠진 dev는 번들에 박힌 옛 damwha_worker를 오류 없이 돌린다.
    expect(() => appOwnedChildEnv(ctx({ repoRoot: null }))).toThrow(CAUSES.repoRootMissing.text);
  });

  it("turns the shared-state writers off in external DB mode and asserts them on otherwise", () => {
    expect(appOwnedChildEnv(ctx({ databaseMode: "external" })).DAMWHA_SHARED_STATE).toBe("off");
    expect(appOwnedChildEnv(packaged({ databaseMode: "external" })).DAMWHA_SHARED_STATE).toBe("off");
    expect(appOwnedChildEnv(ctx()).DAMWHA_SHARED_STATE).toBe("on");
    // 상속된 off가 내장 모드의 준비 상태 보고를 끄지 못한다.
    expect(compose({ DAMWHA_SHARED_STATE: "off" }, packaged()).DAMWHA_SHARED_STATE).toBe("on");
  });

  it("leaves LENS_LLM_BASE_URL out when the context has none — it never invents an address", () => {
    expect("LENS_LLM_BASE_URL" in appOwnedChildEnv(ctx({ env: {} }))).toBe(false);
  });

  it("builds an LLM address the worker can bind — explicit loopback host and port, OpenAI /v1 base", () => {
    // llm_server.py의 _host_port가 host·port를 URL에서 꺼내 서버를 그 자리에 띄우고, lens_client가
    // `<base>/chat/completions`, probe_models가 `<base>/models`를 부른다.
    const url = new URL(llmBaseUrl(51234));
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("51234");
    expect(url.pathname).toBe("/v1");
  });

  it("washes the final composition, so a key that came through ctx.env is stripped too", () => {
    // 상속분만 씻으면 config.json이 임의 키를 되돌린다 (config.ts의 pass-through). loadConfig가 이제
    // 금지 키를 버리지만, 합성 규칙은 그것에 기대지 않는다.
    const c = packaged({ env: { PYTHONHOME: "/elsewhere", HF_HUB_CACHE: "/cache", LENS_LLM_BASE_URL: llmBaseUrl(1) } });
    const env = compose({ PYTHONPATH: "/Users/me/src", VIRTUAL_ENV: "/Users/me/.venv", HOME: "/Users/me" }, c);
    for (const key of STRIPPED_CHILD_ENV_KEYS) expect(key in env).toBe(false);
    expect(env.HOME).toBe("/Users/me");
  });

  it("lays the app's values over the washed env, so what the app claims survives and wins", () => {
    // 씻기 전에 얹으면 dev PYTHONPATH가 금지 목록에 씻겨 나간다.
    const c = ctx({ env: { LENS_LLM_BASE_URL: llmBaseUrl(51234), HF_HOME: "/from/ctx" } });
    const env = compose(
      { PYTHONPATH: "/Users/me/src", HF_HOME: "/Users/me/.cache/huggingface", FFMPEG_BIN: "/opt/homebrew/bin/ffmpeg", LENS_LLM_BASE_URL: "http://127.0.0.1:8000/v1" },
      c,
    );
    expect(env.PYTHONPATH).toBe(path.join(REPO, "be", "worker"));
    expect(env.HF_HOME).toBe(path.join(USER_DATA, "models"));
    expect(env.FFMPEG_BIN).toBe(c.bins.ffmpeg);
    expect(env.LENS_LLM_BASE_URL).toBe("http://127.0.0.1:51234/v1");
  });
});

describe("loadConfig — keys the child env must not take from config.json (P4-C30)", () => {
  const write = (obj: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj));

  it("drops every stripped key and names each one on screen", () => {
    const file: Record<string, string> = {};
    for (const key of STRIPPED_CHILD_ENV_KEYS) file[key] = `/from/${key}`;
    write(file);
    const c = loadConfig(dir);
    for (const key of STRIPPED_CHILD_ENV_KEYS) {
      expect(key in c.env).toBe(false);
      expect(c.warning).toContain(key);
    }
  });

  it("drops PYTHONHOME and HF_HUB_CACHE with a warning — the two P4-C30 names", () => {
    write({ PYTHONHOME: "/opt/py", HF_HUB_CACHE: "/Volumes/x/hub", PORT: "3000" });
    const c = loadConfig(dir);
    expect(c.env.PYTHONHOME).toBeUndefined();
    expect(c.env.HF_HUB_CACHE).toBeUndefined();
    expect(c.warning).toMatch(/PYTHONHOME/);
    expect(c.warning).toMatch(/HF_HUB_CACHE/);
    expect(c.env.PORT).toBe("3000");
  });

  it("ignores HF_TOKEN from the file and never prints the token", () => {
    // 이 문구는 화면과 supervisor.log에 남는다.
    write({ HF_TOKEN: "hf_s3cretTokenValue" });
    const c = loadConfig(dir);
    expect(c.env.HF_TOKEN).toBeUndefined();
    expect(c.warning).toMatch(/HF_TOKEN/);
    expect(c.warning).not.toContain("hf_s3cretTokenValue");
    expect(c.warning).not.toContain("s3cret");
  });

  it("ignores the child keys the app claims, and says so", () => {
    const claimed = ["LENS_LLM_BASE_URL", "HF_HOME", "FFMPEG_BIN", "FFPROBE_BIN", "PYTHONPYCACHEPREFIX", "DAMWHA_SHARED_STATE"];
    write(Object.fromEntries(claimed.map((k) => [k, "x"])));
    const c = loadConfig(dir);
    for (const key of claimed) {
      expect(key in c.env).toBe(false);
      expect(c.warning).toContain(key);
    }
  });

  it("keeps the other LLM settings as pass-through values", () => {
    write({ LENS_LLM_MODEL: "mlx-community/x", LENS_LLM_MANAGED: false });
    const c = loadConfig(dir);
    expect(c.env.LENS_LLM_MODEL).toBe("mlx-community/x");
    expect(c.env.LENS_LLM_MANAGED).toBe("false");
    expect(c.warning).toBeUndefined();
  });

  it("keeps the HOST wording for the loopback keys", () => {
    write({ HOST: "0.0.0.0" });
    expect(loadConfig(dir).warning).toBe('config.json의 HOST는 앱이 127.0.0.1으로 고정합니다. 파일 값은 무시했습니다: "0.0.0.0"');
  });
});
