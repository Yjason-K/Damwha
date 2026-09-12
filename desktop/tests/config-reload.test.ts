import { describe, expect, it } from "vitest";
import { createConfigReloader, RESTART_ONLY_KEYS } from "../src/config-reload";
import type { ApiEnv, LoadedConfig } from "../src/config";

/**
 * 잎만 가짜다 — 파일 읽기(main.ts의 loadConfig)와 로그. 판정은 진짜 코드가 한다.
 *
 * 이 모듈이 생기기 전까지 이 판정은 main.ts의 열 줄짜리 함수였고, 재리뷰가 낸 Important 둘이
 * 정확히 그 열 줄 안에 있었다 (§4-1 파생 키, §4-2 WORKER_ID). electron을 값으로 import하는
 * 파일이라 어떤 테스트도 그것을 부를 수 없었다.
 */
function harness(live: { env: ApiEnv; baseline: ApiEnv } | null) {
  const log: string[] = [];
  let next: LoadedConfig = { env: {}, created: false, extraPath: [] };
  let loads = 0;
  const reload = createConfigReloader({
    load: () => {
      loads += 1;
      return next;
    },
    live: () => live,
    log: (line) => void log.push(line),
  });
  return {
    log,
    reload,
    loadCount: () => loads,
    file(env: ApiEnv, warning?: string) {
      next = { env, created: false, extraPath: [], ...(warning === undefined ? {} : { warning }) };
    },
  };
}

describe("createConfigReloader", () => {
  it("does not read the file before there is a supervisor to refresh", () => {
    const h = harness(null);
    expect(h.reload()).toBeNull();
    expect(h.loadCount()).toBe(0);
  });

  it("puts a corrected pass-through value into the live env and names it once", () => {
    // 완료 기준 P2-C8. 이 경로가 없으면 실패 화면의 "값을 고치면 다시 시도합니다"가 거짓이다.
    const live = {
      env: { DATABASE_URL: "postgres://wrong" },
      baseline: { DATABASE_URL: "postgres://wrong" },
    };
    const h = harness(live);
    h.file({ DATABASE_URL: "postgres://right" });
    expect(h.reload()).toBeNull();
    expect(live.env.DATABASE_URL).toBe("postgres://right");
    expect(h.log).toEqual(["config.json을 다시 읽었어요 — 바뀐 키: DATABASE_URL"]);
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
    const notice = h.reload();
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
    const notice = h.reload();
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
    expect(second).toBe(first);
    expect(h.log.filter((l) => l.includes("EMBED_SERVICE_PORT"))).toHaveLength(1);
  });

  it("stops claiming a restart is needed once the file agrees again", () => {
    const live = { env: { EMBED_SERVICE_PORT: "8100" }, baseline: { EMBED_SERVICE_PORT: "8100" } };
    const h = harness(live);
    h.file({ EMBED_SERVICE_PORT: "9000" });
    expect(h.reload()).not.toBeNull();
    h.file({ EMBED_SERVICE_PORT: "8100" });
    expect(h.reload()).toBeNull();
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

describe("RESTART_ONLY_KEYS", () => {
  it("covers every key embedSpec.prepare derives from", () => {
    // services/embed.ts가 소유하는 집합을 그대로 쓴다. 여기에 손으로 다시 적으면 prepare가
    // 키를 하나 더 파생시키는 날 둘이 갈린다.
    expect(RESTART_ONLY_KEYS).toContain("EMBED_SERVICE_PORT");
    expect(RESTART_ONLY_KEYS).toContain("EMBED_SERVICE_URL");
    expect(RESTART_ONLY_KEYS).toContain("EMBED_SERVICE_HOST");
  });

  it("covers this run's identity", () => {
    expect(RESTART_ONLY_KEYS).toContain("WORKER_ID");
  });
});
