import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { createConfigReloader, RESTART_ONLY_KEYS } from "../../src/config/config-reload";
import { launchEnv, llmBaseUrl, loadConfig, type ApiEnv, type DatabaseMode, type LoadedConfig } from "../../src/config/config";
import { embedSpec } from "../../src/services/embed";
import { externalPostgresSpec } from "../../src/services/postgres/service";
import { buildSpecs, type SpecDeps } from "../../src/services/specs";
import type { EmbedProbe } from "../../src/services/embed-probe";
import type { LaunchContext } from "../../src/services/types";

/**
 * 잎만 가짜다 — 파일 읽기(main.ts의 loadConfig)와 로그. 판정은 진짜 코드가 한다.
 *
 * 이 모듈이 생기기 전까지 이 판정은 main.ts의 열 줄짜리 함수였고, 재리뷰가 낸 Important 둘이
 * 정확히 그 열 줄 안에 있었다 (§4-1 파생 키, §4-2 WORKER_ID). electron을 값으로 import하는
 * 파일이라 어떤 테스트도 그것을 부를 수 없었다.
 */
function harness(live: { env: ApiEnv; baseline: ApiEnv } | null, liveMode: DatabaseMode = { kind: "embedded" }) {
  const log: string[] = [];
  let next: LoadedConfig = { env: {}, created: false, extraPath: [], notes: [], databaseMode: { kind: "embedded" } };
  let loads = 0;
  const reload = createConfigReloader({
    load: () => {
      loads += 1;
      return next;
    },
    live: () => (live === null ? null : { env: live.env, baseline: live.baseline, mode: liveMode }),
    log: (line) => void log.push(line),
  });
  return {
    log,
    reload,
    loadCount: () => loads,
    file(env: ApiEnv, warning?: string, databaseMode: DatabaseMode = { kind: "embedded" }) {
      next = { env, created: false, extraPath: [], notes: [], databaseMode, ...(warning === undefined ? {} : { warning }) };
    },
  };
}

describe("createConfigReloader", () => {
  it("does not read the file before there is a supervisor to refresh", () => {
    const h = harness(null);
    expect(h.reload()).toEqual({ notice: null, isNew: false });
    expect(h.loadCount()).toBe(0);
  });

  it("puts a corrected pass-through value into the live env and names it once", () => {
    // 완료 기준 P2-C8. 이 경로가 없으면 실패 화면의 "값을 고치면 다시 시도합니다"가 거짓이다.
    // DB 키는 이제 재적용 대상이 아니다.
    const live = {
      env: { SUMMARY_LLM_MODEL: "a/wrong" },
      baseline: { SUMMARY_LLM_MODEL: "a/wrong" },
    };
    const h = harness(live);
    h.file({ SUMMARY_LLM_MODEL: "a/right" });
    expect(h.reload().notice).toBeNull();
    expect(live.env.SUMMARY_LLM_MODEL).toBe("a/right");
    expect(h.log).toEqual(["config.json을 다시 읽었어요 — 바뀐 키: SUMMARY_LLM_MODEL"]);
  });

  it("names a key the user deleted from the file", () => {
    const live = {
      env: { PORT: "3000", SUMMARY_LLM_MODEL: "old" },
      baseline: { PORT: "3000", SUMMARY_LLM_MODEL: "old" },
    };
    const h = harness(live);
    h.file({ PORT: "3000" });
    h.reload();
    expect(live.env.SUMMARY_LLM_MODEL).toBeUndefined();
    expect(h.log).toEqual(["config.json을 다시 읽었어요 — 지운 키: SUMMARY_LLM_MODEL"]);
  });

  it("keeps the embed port and its URL together — the file waits for a restart", () => {
    // 재리뷰 §4-1. 이 배선이 빠지면(RESTART_ONLY_KEYS를 안 넘기면) PORT만 9000으로 바뀌고
    // URL은 :8100에 남는다. embed는 9000에 bind하고 준비 판정은 8100을 찔러 180초 뒤 failed가
    // 되며, API는 :8100을 받아 **의미 검색이 조용히 키워드 검색으로 떨어진다.**
    const live = {
      env: { EMBED_SERVICE_PORT: "8100", EMBED_SERVICE_URL: "http://127.0.0.1:8100" },
      baseline: { EMBED_SERVICE_PORT: "8100" },
    };
    const h = harness(live);
    h.file({ EMBED_SERVICE_PORT: "9000" });
    const { notice } = h.reload();
    expect(live.env.EMBED_SERVICE_PORT).toBe("8100");
    expect(live.env.EMBED_SERVICE_URL).toBe("http://127.0.0.1:8100");
    expect(notice).toContain("EMBED_SERVICE_PORT");
    expect(notice).toContain("앱을 다시 켜야");
  });

  it("keeps this run's worker identity even when the file names another", () => {
    // 재리뷰 §4-2. 살아 있는 worker 밑에서 신분이 바뀌면 백오프가 되살린 worker가 새 id로
    // 떠서 옛 id로 locked_by가 찍힌 job을 다시 집지 못한다 (스펙 §6.5).
    const live = { env: { WORKER_ID: "desktop-live" }, baseline: { WORKER_ID: "desktop-live" } };
    const h = harness(live);
    h.file({ WORKER_ID: "desktop-other" });
    const { notice } = h.reload();
    expect(live.env.WORKER_ID).toBe("desktop-live");
    expect(notice).toContain("WORKER_ID");
  });

  it("keeps returning the notice while the disagreement stands, but logs it once", () => {
    // 화면은 재시도마다 다시 그려지므로 안내는 매번 돌려줘야 한다. 로그는 그러면 안 된다 —
    // 3·8·20초마다 같은 줄을 다시 적으면 supervisor.log에서 새 사건과 반복이 구별되지 않는다
    // (재리뷰 §4-6).
    const live = { env: { EMBED_SERVICE_PORT: "8100" }, baseline: { EMBED_SERVICE_PORT: "8100" } };
    const h = harness(live);
    h.file({ EMBED_SERVICE_PORT: "9000" });
    const first = h.reload();
    const second = h.reload();
    expect(first.isNew).toBe(true);
    expect(second.notice).toBe(first.notice);
    // 같은 안내는 다시 말하지 않는다 — 로그도, 대화상자도 (main.ts는 isNew로 가른다).
    expect(second.isNew).toBe(false);
    expect(h.log.filter((l) => l.includes("EMBED_SERVICE_PORT"))).toHaveLength(1);
  });

  it("stops claiming a restart is needed once the file agrees again", () => {
    const live = { env: { EMBED_SERVICE_PORT: "8100" }, baseline: { EMBED_SERVICE_PORT: "8100" } };
    const h = harness(live);
    h.file({ EMBED_SERVICE_PORT: "9000" });
    expect(h.reload().notice).not.toBeNull();
    h.file({ EMBED_SERVICE_PORT: "8100" });
    expect(h.reload()).toEqual({ notice: null, isNew: false });
  });

  it("says a changed notice again — one disagreeing key becoming two is new information", () => {
    // 디듀프의 기준은 "이미 한 번 말했는가"(lastNotice === "")가 아니라 "같은 말인가"다.
    // 앞엣것이면 어긋난 키가 늘거나 값이 바뀌어도 로그는 첫 안내로 끝나고, 담화 화면이 붙은
    // 뒤에는 대화상자도 뜨지 않는다 — 화면은 이미 안내를 보여줄 수 없는 상태다 (§3-2).
    const live = {
      env: { EMBED_SERVICE_PORT: "8100", WORKER_ID: "desktop-live" },
      baseline: { EMBED_SERVICE_PORT: "8100", WORKER_ID: "desktop-live" },
    };
    const h = harness(live);
    h.file({ EMBED_SERVICE_PORT: "9000", WORKER_ID: "desktop-live" });
    const first = h.reload();
    h.file({ EMBED_SERVICE_PORT: "9000", WORKER_ID: "desktop-other" });
    const second = h.reload();
    expect(first.isNew).toBe(true);
    expect(second.notice).not.toBe(first.notice);
    expect(second.isNew).toBe(true);
    expect(h.log).toHaveLength(2);
  });

  it("re-arms once the file agrees — the same disagreement a second time is news again", () => {
    // 어긋남이 풀렸을 때 lastNotice를 비우지 않으면, 사용자가 값을 되돌렸다가 다시 고친
    // 경우의 두 번째를 아무도 적지 않고 아무도 말하지 않는다.
    const live = { env: { EMBED_SERVICE_PORT: "8100" }, baseline: { EMBED_SERVICE_PORT: "8100" } };
    const h = harness(live);
    h.file({ EMBED_SERVICE_PORT: "9000" });
    expect(h.reload().isNew).toBe(true);
    h.file({ EMBED_SERVICE_PORT: "8100" });
    expect(h.reload().notice).toBeNull();
    h.file({ EMBED_SERVICE_PORT: "9000" });
    expect(h.reload().isNew).toBe(true);
    expect(h.log).toHaveLength(2);
  });

  it("never calls a notice new while nothing disagrees — there is no modal to raise", () => {
    const live = { env: { PORT: "3000" }, baseline: { PORT: "3000" } };
    const h = harness(live);
    h.file({ PORT: "3100" });
    expect(h.reload()).toEqual({ notice: null, isNew: false });
  });

  it("repeats a warning only when it changes", () => {
    // 재리뷰 §4-6. config.json에 EMBED_SERVICE_HOST나 잘못된 EXTRA_PATH가 남아 있으면 그
    // 경고가 재시도마다 다시 들어갔다. renderStatus는 이미 lastStatusLine으로 같은 일을
    // 하는데 이 경로에만 그것이 없었다.
    const live = { env: { PORT: "3000" }, baseline: { PORT: "3000" } };
    const h = harness(live);
    h.file({ PORT: "3000" }, "config.json의 EXTRA_PATH는 문자열 목록이어야 해요.");
    h.reload();
    h.reload();
    expect(h.log).toHaveLength(1);
    h.file({ PORT: "3000" }, "config.json의 HOST는 앱이 127.0.0.1로 고정합니다.");
    h.reload();
    expect(h.log).toHaveLength(2);
  });
});

/** prepare가 ctx.env에서 **실제로 읽은** 키를 기록한다. 손으로 적은 목록과 달리 같이 자란다. */
function recordingCtx(env: Record<string, string>): { ctx: LaunchContext; read: Set<string> } {
  const read = new Set<string>();
  const proxy = new Proxy(env, {
    get(target, key) {
      if (typeof key === "string") read.add(key);
      return Reflect.get(target, key) as unknown;
    },
  });
  return {
    ctx: {
      repoRoot: "/r",
      userData: "/u",
      packaged: true,
      databaseMode: "embedded",
      env: proxy,
      bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
      runId: "desktop-test",
      searchDirs: [],
      logFile: (id) => `/u/logs/${id}.log`,
      signal: new AbortController().signal,
    },
    read,
  };
}

const specFakes: SpecDeps = {
  postgres: externalPostgresSpec(),
  api: {
    verifyOwnListener: async () => true,
    isPortOccupied: async () => false,
    onPendingMigrations: () => undefined,
    onMigrationCheckSkipped: () => undefined,
  },
  embed: {
    probe: async () => ({ kind: "absent" as const }),
    freePort: async () => 8100,
    listenerPids: async () => [],
    psArgs: async () => "",
    log: () => undefined,
  },
  worker: { listExternal: async () => [] },
};

describe("RESTART_ONLY_KEYS", () => {
  /**
   * 손으로 적은 이름 셋을 toContain으로 보면 키가 **빠질** 때만 빨개지고, prepare가 넷째 키를
   * 파생시키는 날에는 집합도 테스트도 같이 침묵한다 — services/embed.ts의 주석이 피하려던
   * "두 벌로 적기"가 테스트 쪽에 그대로 남는 모양이다 (재재리뷰 §4-6). 그래서 목록을 적지 않고
   * **진짜 prepare를 불러** 읽은 키(Proxy)와 돌려준 키(결과 객체)를 그대로 끌어낸다.
   *
   * 이 테스트가 못 잡는 것: prepare가 읽지도 쓰지도 않으면서 그 결과에 딸려 가는 키가 생기는
   * 경우. 그런 키는 어떤 기계적 관찰로도 드러나지 않는다.
   */
  it("covers every key embedSpec.prepare actually reads or writes — derived, not hand-copied", async () => {
    const probes: EmbedProbe[] = [
      { kind: "match" },
      { kind: "mismatch", detail: "모델 other/model" },
      { kind: "absent" },
    ];
    // env 모양도 같이 돌린다. 값이 있는 모양 하나만 주면 `ctx.env.A ?? ctx.env.B`의 오른쪽은
    // 영영 평가되지 않아 Proxy가 B를 기록하지 못한다 — 손으로 적은 목록으로 되돌아가는
    // 조용한 구멍이다 (재리뷰 3 §4-1이 변이 K로 실측했다). 빈 env가 그 오른쪽을 깨운다.
    const shapes: Record<string, string>[] = [
      { EMBED_SERVICE_HOST: "127.0.0.1", EMBED_SERVICE_PORT: "8100" },
      {},
    ];
    for (const [probe, env] of probes.flatMap((p) => shapes.map((e) => [p, e] as const))) {
      const { ctx, read } = recordingCtx(env);
      const spec = embedSpec({
        probe: async () => probe,
        freePort: async () => 54321,
        listenerPids: async () => [],
        psArgs: async () => "",
        log: () => undefined,
      });
      const written = await spec.prepare!(ctx);
      expect(read.size).toBeGreaterThan(0);
      for (const key of read) expect(RESTART_ONLY_KEYS).toContain(key);
      for (const key of Object.keys(written)) expect(RESTART_ONLY_KEYS).toContain(key);
    }
  });

  it("is complete only while embed is the one spec with a prepare", () => {
    // 위 테스트는 embedSpec 하나만 본다. 다른 spec이 prepare를 갖는 순간 그 집합은 조용히
    // 불완전해지므로, 그 순간을 여기서 빨갛게 만든다 — 다음 사람이 같은 결함을 다시 만들지
    // 않도록.
    const withPrepare = buildSpecs(specFakes)
      .filter((s) => s.prepare !== undefined)
      .map((s) => s.id);
    expect(withPrepare).toEqual(["embed"]);
  });

  it("covers this run's identity", () => {
    expect(RESTART_ONLY_KEYS).toContain("WORKER_ID");
  });
});

describe("createConfigReloader — database mode (Phase 3 스펙 §6.6)", () => {
  it("never writes DATABASE_URL or STORAGE_ROOT into the live env, whatever the file says", () => {
    const live = {
      env: { DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu%2Frun", STORAGE_ROOT: "/u/data/storage", PORT: "3000" },
      baseline: { PORT: "3000" },
    };
    const h = harness(live);
    h.file({ DATABASE_URL: "postgres://elsewhere", STORAGE_ROOT: "/elsewhere", PORT: "3000" });
    h.reload();
    expect(live.env.DATABASE_URL).toBe("postgresql://damwha@/damwha?host=%2Fu%2Frun");
    expect(live.env.STORAGE_ROOT).toBe("/u/data/storage");
  });

  it("does not delete the live database keys when the file has none", () => {
    const live = { env: { DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu", STORAGE_ROOT: "/u/data/storage" }, baseline: {} };
    const h = harness(live);
    h.file({});
    h.reload();
    expect(live.env).toMatchObject({ DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu", STORAGE_ROOT: "/u/data/storage" });
  });

  it("says a restart is needed when the file adds external debug mode", () => {
    const live = { env: { STORAGE_ROOT: "/u/data/storage" }, baseline: {} };
    const h = harness(live);
    h.file({ STORAGE_ROOT: "/u/storage" }, undefined, { kind: "external", url: "postgres://postgres:secret@localhost:5432/damwha" });
    const r = h.reload();
    expect(r.notice).toMatch(/다시 켜야/);
    expect(r.notice).toMatch(/외부 DB/);
    expect(r.notice).not.toContain("secret");
  });

  it("says a restart is needed when the file removes external debug mode — the direction refreshEnv could not see", () => {
    const live = { env: { STORAGE_ROOT: "/u/storage" }, baseline: {} };
    const h = harness(live, { kind: "external", url: "postgres://x@h/db" });
    h.file({ STORAGE_ROOT: "/u/data/storage" });
    expect(h.reload().notice).toMatch(/내장 DB.*다시 켜야|다시 켜야.*내장 DB/);
  });

  it("says a restart is needed when the external URL or its storage changes", () => {
    const live = { env: { STORAGE_ROOT: "/u/storage" }, baseline: {} };
    const h = harness(live, { kind: "external", url: "postgres://x@h/db" });
    h.file({ STORAGE_ROOT: "/u/storage" }, undefined, { kind: "external", url: "postgres://x@h/other" });
    expect(h.reload().notice).toMatch(/다시 켜야/);
    h.file({ STORAGE_ROOT: "/srv/audio" }, undefined, { kind: "external", url: "postgres://x@h/db" });
    expect(h.reload().notice).toMatch(/다시 켜야/);
  });

  it("says nothing when the mode and storage agree", () => {
    const live = { env: { STORAGE_ROOT: "/u/data/storage" }, baseline: {} };
    const h = harness(live);
    h.file({ STORAGE_ROOT: "/u/data/storage" });
    expect(h.reload()).toEqual({ notice: null, isNew: false });
  });
});

describe("createConfigReloader — the LLM address this run chose (Phase 4 스펙 §6.3)", () => {
  /**
   * LENS_LLM_BASE_URL은 main.ts가 빈 포트를 골라 감독자의 env에 얹는다. 기준선에 들어가면 파일에 그
   * 키가 없다는 이유로 재시도가 **살아 있는 env에서 지운다** — worker가 다음 재시작에서
   * ValidationError로 죽는다. 파일이 적은 값이 그것을 옮겨도 안 된다: LLM 서버가 그 주소에 뜬다.
   * 진짜 loadConfig와 진짜 launchEnv로 본다 — 손으로 만든 live/baseline은 그 구성을 증명하지 못한다.
   */
  it("keeps it through a reload whether the file names another address or none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-reload-"));
    try {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ PORT: "3000", LENS_LLM_BASE_URL: "http://127.0.0.1:8000/v1" }));
      const cfg = loadConfig(dir);
      const live = launchEnv(cfg, 51234, "hf_launchTokenValue000000000");
      expect(live.env.LENS_LLM_BASE_URL).toBe(llmBaseUrl(51234));
      expect("LENS_LLM_BASE_URL" in live.baseline).toBe(false);

      const log: string[] = [];
      const reload = createConfigReloader({
        load: () => loadConfig(dir),
        live: () => ({ env: live.env, baseline: live.baseline, mode: cfg.databaseMode }),
        log: (line) => void log.push(line),
      });
      reload();
      expect(live.env.LENS_LLM_BASE_URL).toBe(llmBaseUrl(51234));
      fs.writeFileSync(file, JSON.stringify({ PORT: "3000" }));
      reload();
      expect(live.env.LENS_LLM_BASE_URL).toBe(llmBaseUrl(51234));
      expect(log.filter((l) => l.includes("다시 읽었어요")).join("\n")).not.toContain("LENS_LLM_BASE_URL");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createConfigReloader — the Keychain token this run carries (Phase 4 스펙 §6.4)", () => {
  /**
   * HF_TOKEN은 기동 게이트가 Keychain에서 읽어 감독자의 env에 얹는다(main.ts → launchEnv). config.json은
   * 그 키를 정할 수 없으므로(APP_OWNED_KEYS) 파일에 절대 없다 — 기준선에 들어가면 첫 재시도가 "파일에서
   * 지운 키"로 읽고 살아 있는 env에서 지워, 백오프가 되살린 worker가 토큰 없이 뜬다. LENS_LLM_BASE_URL과
   * 같은 자리다. 파일이 적은 값이 그것을 바꿔도 안 되고, 어느 로그에도 값이 남으면 안 된다.
   */
  const TOKEN = "hf_KeychainTokenValue0123456789abcd";

  it("carries the token in the live env but not in the reload baseline", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-reload-"));
    try {
      const live = launchEnv(loadConfig(dir), 51234, TOKEN);
      expect(live.env.HF_TOKEN).toBe(TOKEN);
      expect("HF_TOKEN" in live.baseline).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launchEnv without a token leaves HF_TOKEN out of env entirely", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-reload-"));
    try {
      const cfg = loadConfig(tempDir);
      const live = launchEnv(cfg, 51234, null);
      expect("HF_TOKEN" in live.env).toBe(false);
      expect("HF_TOKEN" in live.baseline).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps it through reloads whether the file names a token or not, and never logs the value", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-reload-"));
    try {
      const file = path.join(dir, "config.json");
      fs.writeFileSync(file, JSON.stringify({ PORT: "3000", SUMMARY_LLM_MODEL: "a/one" }));
      const cfg = loadConfig(dir);
      const live = launchEnv(cfg, 51234, TOKEN);

      const log: string[] = [];
      const reload = createConfigReloader({
        load: () => loadConfig(dir),
        live: () => ({ env: live.env, baseline: live.baseline, mode: cfg.databaseMode }),
        log: (line) => void log.push(line),
      });

      // 사람이 파일에 다른 토큰을 적었다 — 앱 소유 키라 버려지고 경고만 남는다.
      fs.writeFileSync(file, JSON.stringify({ PORT: "3000", SUMMARY_LLM_MODEL: "a/two", HF_TOKEN: "hf_fromTheFile000000000000" }));
      reload();
      expect(live.env.HF_TOKEN).toBe(TOKEN);
      // 같은 재적용이 다른 키는 실제로 옮겼다 — 재적용이 돌지 않아서 남은 것이 아니다.
      expect(live.env.SUMMARY_LLM_MODEL).toBe("a/two");

      // 파일에서 그 키도, 다른 키도 사라졌다.
      fs.writeFileSync(file, JSON.stringify({ PORT: "3000" }));
      reload();
      expect(live.env.HF_TOKEN).toBe(TOKEN);
      expect(live.env.SUMMARY_LLM_MODEL).toBeUndefined();

      const all = log.join("\n");
      expect(all).toContain("HF_TOKEN");
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain("hf_fromTheFile000000000000");
      expect(log.filter((l) => l.includes("다시 읽었어요")).join("\n")).not.toContain("HF_TOKEN");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
