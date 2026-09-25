import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../../src/diagnostics/causes";
import { DEGRADED_HINT, HINTS, RETRY_LAYERS } from "../../src/windows/shell-hints";
import { HF_GATED_MODEL_PAGE_URL, maskToken } from "../../src/config/token-store";
import { STALL_MS, type ReadinessEntry } from "../../src/services/model-readiness";
import {
  HINT_PREFIX,
  causeWithFix,
  NO_SERVICES_YET,
  NO_TOKEN_NOTE,
  RESTART_BUSY_LABEL,
  RESTART_CLEANING_NOTE,
  RESTART_LABEL,
  RESTART_NOT_OURS_NOTE,
  RESTORE_MENU_NOTE,
  TOKEN_NOTE,
  TOKEN_UNAVAILABLE_NOTE,
  UNREADABLE_TOKEN_NOTE,
  failureDetail,
  parseServicesAction,
  renderCall,
  servicesView,
  shellStatusFrom,
  statusLine,
  type ServicesView,
} from "../../src/windows/status-view";
import { judgeAfterProbe } from "../../src/services/api";
import { workerSpec } from "../../src/services/worker";
import type { LaunchContext, ServiceId, ServiceStatus } from "../../src/services/types";
import { fakeChild } from "../fake-child";

const st = (id: ServiceId, over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id,
  process: "running",
  health: "ok",
  owned: true,
  restarts: 0,
  ...over,
});

const logPathOf = (id: ServiceId | "supervisor") => `/logs/${id}.log`;

const ALL_OK = [st("postgres"), st("api"), st("embed"), st("worker")];

/** 서비스도 모델도 토큰도 없는 빈 한 장. renderCall의 모양만 보는 자리에서 쓴다. */
function emptyView(notices: string[] = []): ServicesView {
  return {
    rows: [],
    models: [],
    token: { masked: null, note: "" },
    notices,
  };
}

describe("servicesView", () => {
  it("shows all four services in the order the supervisor reports them", () => {
    const view = servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf });
    expect(view.rows.map((r) => [r.id, r.name, r.state, r.tone])).toEqual([
      ["postgres", "데이터베이스", "실행 중", "ok"],
      ["api", "API", "실행 중", "ok"],
      ["embed", "검색 임베딩", "실행 중", "ok"],
      ["worker", "작업 처리기", "실행 중", "ok"],
    ]);
    expect(view.notices).toEqual([]);
    // 원인이 없으면 원인 블록도 안내도 없다.
    expect(view.rows.every((r) => r.cause === undefined && r.hint === undefined)).toBe(true);
  });

  it("sends postgres to its own log — the bundled cluster keeps postgres.log (Phase 3)", () => {
    const view = servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf });
    expect(view.rows.map((r) => r.log)).toEqual([
      "/logs/postgres.log",
      "/logs/api.log",
      "/logs/embed.log",
      "/logs/worker.log",
    ]);
  });

  it("shows a failed service with its cause and hint (P2-C10)", () => {
    const view = servicesView({
      statuses: [st("worker", { process: "failed", health: "unknown", detail: CAUSES.readyTimeout.text, restarts: 3 })],
      restartNotice: null,
      logPathOf,
    });
    expect(view.rows[0]).toMatchObject({
      state: "실패",
      tone: "fail",
      cause: CAUSES.readyTimeout.text,
      hint: (HINTS.readyTimeout as Record<string, string>).worker,
      notes: ["재시작 3회"],
    });
  });

  it("shows a degraded API as running with a limit, its cause, and the recover-on-its-own hint (P2-C11)", () => {
    const view = servicesView({
      statuses: [st("api", { health: "degraded", detail: CAUSES.apiDbUnreachable.text })],
      restartNotice: null,
      logPathOf,
    });
    expect(view.rows[0]).toMatchObject({
      state: "실행 중 · 동작 제한",
      tone: "warn",
      cause: CAUSES.apiDbUnreachable.text,
      hint: DEGRADED_HINT,
    });
  });

  it("drops the cause and hint again once the API is back to ok", () => {
    // 감독자의 applyReadiness가 ready에서 detail을 지운다. 창은 그 상태를 그대로 그린다.
    const view = servicesView({ statuses: [st("api")], restartNotice: null, logPathOf });
    expect(view.rows[0]).toMatchObject({ state: "실행 중", tone: "ok" });
    expect(view.rows[0].cause).toBeUndefined();
    expect(view.rows[0].hint).toBeUndefined();
  });

  it("warns about an external worker the app stood down for, with the STORAGE_ROOT hint (P2-C6)", () => {
    const view = servicesView({
      statuses: [st("worker", { health: "unknown", owned: false, detail: CAUSES.externalWorker.text([4101]) })],
      restartNotice: null,
      logPathOf,
    });
    expect(view.rows[0]).toMatchObject({
      state: "실행 중",
      tone: "warn",
      notes: ["앱이 띄우지 않음"],
      cause: CAUSES.externalWorker.text([4101]),
      hint: HINTS.externalWorker,
    });
  });

  it("treats an adopted service with no cause as healthy, but still says the app did not start it", () => {
    const view = servicesView({ statuses: [st("embed", { owned: false })], restartNotice: null, logPathOf });
    expect(view.rows[0]).toMatchObject({ tone: "ok", notes: ["앱이 띄우지 않음"] });
  });

  it("does not show a stale cause on a service that is starting again", () => {
    const view = servicesView({
      statuses: [st("api", { process: "starting", health: "unknown", detail: "startup failed: old" })],
      restartNotice: null,
      logPathOf,
    });
    expect(view.rows[0]).toMatchObject({ state: "준비 중", tone: "idle" });
    expect(view.rows[0].cause).toBeUndefined();
  });

  it("carries the restart-required notice from the config reload", () => {
    const notice = "EMBED_SERVICE_PORT은(는) 파일에 8200, 실행 중인 값은 8100 — 이 키는 앱을 다시 켜야 바뀌어요.";
    const view = servicesView({ statuses: ALL_OK, restartNotice: notice, logPathOf });
    expect(view.notices).toEqual([notice]);
  });

  it("warns on the api row when this API launch skipped the migration check — the gate switched itself off (P2-C9)", () => {
    const view = servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf, migrationCheckSkipped: true });
    const api = view.rows.find((r) => r.id === "api")!;
    expect(api.tone).toBe("warn");
    expect(api.warning).toContain("마이그레이션 검사가 돌지 않았어요");
    expect(api.warning).toContain("통과한 것이 아니에요");
    expect(api.warning).toContain("pnpm be:migrate");
    // 다른 줄에는 붙지 않는다.
    expect(view.rows.filter((r) => r.warning !== undefined).map((r) => r.id)).toEqual(["api"]);
  });

  it("does not warn when the check ran, or on an API that is not up", () => {
    expect(servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf }).rows[1].warning).toBeUndefined();
    const down = servicesView({
      statuses: [st("api", { process: "failed", health: "unknown", detail: "x" })],
      restartNotice: null,
      logPathOf,
      migrationCheckSkipped: true,
    });
    expect(down.rows[0].warning).toBeUndefined();
    expect(down.rows[0].tone).toBe("fail");
  });

  it("says nothing has been started yet when there is no supervisor", () => {
    const view = servicesView({ statuses: null, restartNotice: null, logPathOf });
    expect(view.rows).toEqual([]);
    expect(view.notices).toEqual([NO_SERVICES_YET]);
  });

  it("marks the adopted debug database on the row and in the status line, as a warning that does not go away", () => {
    const statuses = [st("postgres", { owned: false }), st("api")];
    const view = servicesView({ statuses, restartNotice: null, logPathOf, externalDatabase: true });
    expect(view.rows[0].tone).toBe("warn");
    expect(view.rows[0].notes).toContain("외부 DB(디버깅)");
    expect(view.rows[0].notes).not.toContain("앱이 띄우지 않음");
    expect(view.rows[0].warning).toBe(CAUSES.externalDatabase.text);
    expect(statusLine(statuses[0], true)).toBe("데이터베이스: 실행 중 (외부 DB(디버깅))");
  });

  it("shows the psql command on a running embedded database row only", () => {
    const cmd = `"/B/postgres/bin/psql" -h "/u/run" -U damwha damwha`;
    const up = servicesView({ statuses: [st("postgres")], restartNotice: null, logPathOf, debugCommand: cmd });
    expect(up.rows[0].command).toBe(cmd);
    const down = servicesView({ statuses: [st("postgres", { process: "failed", health: "unknown" })], restartNotice: null, logPathOf, debugCommand: cmd });
    expect(down.rows[0].command).toBeUndefined();
    const external = servicesView({ statuses: [st("postgres", { owned: false })], restartNotice: null, logPathOf, externalDatabase: true, debugCommand: cmd });
    expect(external.rows[0].command).toBeUndefined();
  });

  it("notes where the embedded postgres server keeps its own logs, only for the embedded database", () => {
    // 스펙 §6.7: 상태 창의 postgres 로그 참조는 logs/postgres/ 폴더를 가리켜야 한다. row.log는
    // 실행 싱크(logs/postgres.log)로 남지만, 내장 모드에서는 서버 자신의 로그 폴더도 알려준다.
    const dir = "/u/logs/postgres";
    const embedded = servicesView({ statuses: [st("postgres")], restartNotice: null, logPathOf, postgresLogDir: dir });
    expect(embedded.rows[0].notes).toContain(`서버 로그: ${dir}`);

    // 외부 디버그 모드는 앱이 그 postgres를 띄우지도 로그를 갖지도 않는다.
    const external = servicesView({
      statuses: [st("postgres", { owned: false })],
      restartNotice: null,
      logPathOf,
      externalDatabase: true,
      postgresLogDir: dir,
    });
    expect(external.rows[0].notes.some((n) => n.includes("서버 로그"))).toBe(false);

    // 다른 서비스 줄에는 붙지 않는다.
    const other = servicesView({ statuses: [st("api")], restartNotice: null, logPathOf, postgresLogDir: dir });
    expect(other.rows[0].notes).toEqual([]);
  });

  it("puts a config warning among the notices and on the failure screen", () => {
    const warning = "내장 DB 모드에서는 config.json의 DATABASE_URL를 쓰지 않아요";
    expect(servicesView({ statuses: [st("api")], restartNotice: null, logPathOf, configWarning: warning }).notices).toContain(warning);
    const shell = shellStatusFrom({ statuses: [st("api")], restartNotice: null, logPathOf, configWarning: warning });
    expect(shell.detail).toContain(warning);
  });

  it("links postgres to its own log, not the supervisor's", () => {
    expect(servicesView({ statuses: [st("postgres")], restartNotice: null, logPathOf }).rows[0].log).toBe("/logs/postgres.log");
  });
});

describe("statusLine / shellStatusFrom", () => {
  it("puts the cause and then the hint under a failed service", () => {
    const detail = CAUSES.pgPairingRefused.text("파일 저장소가 다른 데이터베이스의 것이에요", "/u/data/postgres", "/u/data/storage");
    const line = statusLine(st("postgres", { process: "failed", health: "unknown", detail }));
    expect(line).toBe(`데이터베이스: 실패\n    ${detail}\n    ${HINT_PREFIX}${HINTS.pgPairingRefused}`);
  });

  it("indents every line of a multi-line cause", () => {
    const line = statusLine(st("api", { process: "failed", health: "unknown", detail: "startup failed: [\n  {}\n]" }));
    expect(line).toBe("API: 실패\n    startup failed: [\n      {}\n    ]");
  });

  it("keeps the Phase 1 line for a healthy or adopted service", () => {
    expect(statusLine(st("api"))).toBe("API: 실행 중");
    expect(statusLine(st("embed", { owned: false }))).toBe("검색 임베딩: 실행 중 (앱이 띄우지 않음)");
    // stand-down worker는 그대로 꼬리 한 줄이다 — 원인을 다시 적지 않는다(좁힌 조건이 이것을 지킨다).
    expect(statusLine(st("worker", { owned: false, detail: CAUSES.externalWorker.text([4101]) }))).toBe(
      "작업 처리기: 실행 중 (앱이 띄우지 않음)",
    );
  });

  it("still shows the cause and the fix when an adopted service goes degraded (최종 리뷰)", () => {
    // 채택한 embed는 핸들이 없어도 `rt.result`가 있어 재프로브를 받는다(supervisor.ts의 probeHealth) —
    // stand-down은 런타임이 없어 여기까지 오지 못하므로 `running && !owned && degraded`는 채택뿐이다.
    // 셸 줄이 그 원인을 삼키면 "동작이 제한돼요"만 남고, 같은 상태를 조건 없이 causeOf에 넘기는
    // 상태 창과 갈린다 — 이 파일 머리가 금지하는 바로 그것이다.
    const detail = CAUSES.embedMismatch.text("bge-small", 384, "bge-m3", 1024);
    const s = st("embed", { owned: false, health: "degraded", detail });
    const line = statusLine(s);
    const row = servicesView({ statuses: [s], restartNotice: null, logPathOf }).rows[0];
    expect(row.cause).toBe(detail);
    expect(row.hint).toBe(HINTS.embedMismatch as string);
    expect(line).toBe(
      `검색 임베딩: 실행 중 (앱이 띄우지 않음) — 동작이 제한돼요\n    ${row.cause}\n    ${HINT_PREFIX}${row.hint}`,
    );
  });

  it("lists every service on the starting screen in dev", () => {
    const shell = shellStatusFrom({
      statuses: [st("postgres"), st("api", { process: "starting", health: "unknown" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell).toEqual({ state: "starting", detail: "데이터베이스: 실행 중\nAPI: 준비 중" });
  });

  it("hides the service lines on the packaged starting screen but keeps notices (Notion P2-B)", () => {
    const statuses = [st("postgres"), st("api", { process: "starting", health: "unknown" })];
    expect(shellStatusFrom({ statuses, restartNotice: null, logPathOf, packaged: true })).toEqual({ state: "starting" });
    const warning = "내장 DB 모드에서는 config.json의 DATABASE_URL를 쓰지 않아요";
    expect(
      shellStatusFrom({ statuses, restartNotice: "재시작 안내", logPathOf, configWarning: warning, packaged: true }),
    ).toEqual({ state: "starting", detail: `재시작 안내\n${warning}` });
  });

  it("still shows the cause on the packaged failure screen", () => {
    const detail = CAUSES.pgVersionMismatch.text("15", "16");
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail })],
      restartNotice: null,
      logPathOf,
      packaged: true,
    });
    expect(shell.state).toBe("failed");
    expect(shell.detail).toContain(detail);
  });

  it("always uses the plain failure screen for a postgres failure, with the server's own log (Phase 3)", () => {
    const detail = CAUSES.pgVersionMismatch.text("15", "16");
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail }), st("api", { process: "stopped", health: "unknown" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).toBe("failed");
    expect(shell.logPath).toBe("/logs/postgres.log");
    expect(shell.detail).toContain(HINTS.pgVersionMismatch as string);
  });

  it("never puts a retry countdown on the screen by itself — only the code that schedules the timer may", () => {
    // 카운트다운은 main.ts의 scheduleRetry가 실제로 타이머를 건 자리에서만 붙는다. 이 조립이 초를
    // 스스로 적으면, 창을 다시 연 화면처럼 아무 타이머도 없는 곳에서 "N초 뒤에 다시 시도해요"라고
    // 거짓말을 한다.
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail: CAUSES.pgVersionMismatch.text("15", "16") })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.retryInSeconds).toBeUndefined();
  });

  it("does not use the db-unreachable screen for a postgres readiness timeout (리뷰 M-1)", () => {
    const shell = shellStatusFrom({
      statuses: [
        st("postgres", { process: "failed", health: "unknown", detail: CAUSES.readyTimeout.text }),
        st("api", { process: "stopped", health: "unknown" }),
      ],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).not.toBe("db-unreachable");
    // 위 테스트와 같은 이유로 vacuous한 `not.toMatch`를 원인 단언으로 바꿨다 — 일반 실패 화면이 postgres의
    // 유예 초과를 그대로 말한다.
    expect(shell.detail).toContain(CAUSES.readyTimeout.text);
  });

  it("uses the generic failed screen for any other failed service, with that service's log", () => {
    const shell = shellStatusFrom({
      statuses: [st("postgres"), st("api", { process: "failed", health: "unknown", detail: "x" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell).toMatchObject({ state: "failed", logPath: "/logs/api.log" });
  });

  it("stays on the starting screen while nothing has failed, and still shows the restart notice", () => {
    const shell = shellStatusFrom({ statuses: ALL_OK, restartNotice: "다시 켜야 바뀌어요", logPathOf });
    expect(shell.state).toBe("starting");
    expect(shell.detail?.split("\n").at(-1)).toBe("다시 켜야 바뀌어요");
  });

  it("appends the restore note only for update failures and only when restorable (Phase 6b-2 §7.1)", () => {
    const failedApi = (detail: string) => st("api", { process: "failed", health: "unknown", recovery: "manual", detail });
    const mig = CAUSES.migrationFailed.text("마이그레이션 러너: error: boom", null);
    const on = shellStatusFrom({ statuses: [failedApi(mig)], restartNotice: null, logPathOf, restoreAvailable: true });
    const off = shellStatusFrom({ statuses: [failedApi(mig)], restartNotice: null, logPathOf, restoreAvailable: false });
    const other = shellStatusFrom({
      statuses: [failedApi(CAUSES.portInUse.text)],
      restartNotice: null,
      logPathOf,
      restoreAvailable: true,
    });
    expect(on.detail).toContain(RESTORE_MENU_NOTE);
    expect(off.detail).not.toContain(RESTORE_MENU_NOTE);
    expect(other.detail).not.toContain(RESTORE_MENU_NOTE);
  });
});

describe("failureDetail", () => {
  it("adds the hint under a cause thrown before the supervisor exists", () => {
    expect(failureDetail("앱을 시작하지 못했어요", CAUSES.repoRootMissing.text)).toBe(
      `앱을 시작하지 못했어요: ${CAUSES.repoRootMissing.text}\n${HINT_PREFIX}${HINTS.repoRootMissing}`,
    );
  });

  it("adds nothing for a cause it does not know", () => {
    expect(failureDetail("앱을 시작하지 못했어요", "EACCES")).toBe("앱을 시작하지 못했어요: EACCES");
  });
});

describe("renderCall — main이 렌더러에서 실행하는 식", () => {
  /** 호출문을 진짜 JS 엔진에서 돌려, 렌더 함수가 무엇을 몇 번 받았는지와 그 밖에 무슨 일이 났는지 본다. */
  function run(script: string) {
    const calls: unknown[] = [];
    const sandbox: Record<string, unknown> = {};
    sandbox.window = { __damwha_render: (view: unknown) => calls.push(view) };
    vm.runInNewContext(script, sandbox);
    return { calls, sandbox };
  }

  const hostile = [
    '"); globalThis.pwned = 1; ("',
    "'); globalThis.pwned = 1; ('",
    "`${globalThis.pwned = 1}`",
    "</script><script>globalThis.pwned = 1</script>",
    "<img src=x onerror=\"globalThis.pwned=1\">",
    "줄\u2028구분\u2029문단",
    "\\\"}]); globalThis.pwned = 1; //",
    "\u0000\x1b[31m제어문자\x1b[39m",
  ];

  it.each(hostile)("delivers %j to the render function unchanged and runs nothing else", (text) => {
    const view: ServicesView = {
      rows: [
        {
          id: "api", name: "API", state: "실패", tone: "fail", notes: [text],
          cause: text, hint: text, log: text,
          restart: { service: "api", label: text, disabled: false, note: text },
        },
      ],
      // 모델 줄도 적대적인 문자열을 싣는다 — key는 HF repo id이고 cause에는 worker의 원문이 온다.
      models: [{ key: text, state: "실패", tone: "fail", notes: [text], cause: text, hint: text }],
      token: { masked: text, note: text },
      notices: [text],
    };
    const { calls, sandbox } = run(renderCall(view));
    expect(calls).toEqual([view]);
    expect(sandbox.pwned).toBeUndefined();
  });

  it("does nothing when the page has not defined the render function yet (still loading)", () => {
    const sandbox: Record<string, unknown> = { window: {} };
    expect(() => vm.runInNewContext(renderCall(emptyView()), sandbox)).not.toThrow();
  });

  it("evaluates to undefined so executeJavaScript has nothing to serialise", () => {
    const sandbox = { window: { __damwha_render: () => ({ node: "not cloneable" }) } };
    expect(vm.runInNewContext(renderCall(emptyView()), sandbox)).toBeUndefined();
  });
});

describe("화면이 싣는 해결 문구 — 완료 기준 P2-C7·C8·C9 (Task 14 D2)", () => {
  // 원인 문구에서 고치는 방법을 떼어 HINTS로 옮겼다. 그러면 그 방법이 화면에 오르는 것은 전적으로
  // 조립(causeWithFix)에 달렸고, 세 완료 기준의 문구가 전부 그 줄에 있다. 원인은 실제 어댑터가 낸
  // 것을 쓰고, 단언은 main.ts가 화면에 넘기는 바로 그 값(shellStatusFrom·failureDetail·servicesView)에
  // 건다.
  const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
    repoRoot: "/r",
    userData: "/u",
    packaged: true,
    databaseMode: "embedded",
    env: {},
    bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test",
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
    ...over,
  });
  const failed = (id: ServiceId, detail: string): ServiceStatus =>
    st(id, { process: "failed", health: "unknown", detail });

  it("P2-C8 (Phase 4): the bundled python is missing — names what is missing and the fix, on the failure screen and in the status window", async () => {
    // Phase 2의 P2-C8은 "uv를 못 찾음 → config.json의 UV_BIN"이었다. 이제 worker는 번들 python으로 뜨고,
    // 그것이 없으면 spawn ENOENT가 죽은 핸들의 꼬리로 올라온다. 원인은 실제 어댑터가 낸 것을 쓴다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-sv-"));
    try {
      const child = fakeChild();
      const spec = workerSpec({ listExternal: async () => [], spawnFn: () => child });
      const c = ctx({ logFile: (id) => path.join(dir, `${id}.log`) });
      const result = await spec.launch(c);
      child.emit("error", Object.assign(new Error(`spawn ${c.bins.python} ENOENT`), { code: "ENOENT" }));
      const r = await spec.readiness(result, c);
      const detail = r.kind === "failed" ? r.detail : "";
      const statuses = [st("postgres"), st("api"), failed("worker", detail)];
      const shell = shellStatusFrom({ statuses, restartNotice: null, logPathOf });
      expect(shell.detail).toContain(`spawn ${c.bins.python} ENOENT`);
      expect(shell.detail).toMatch(/다시 설치.*build-python\.sh/);
      expect(shell.detail).not.toMatch(/UV_BIN/);
      const row = servicesView({ statuses, restartNotice: null, logPathOf }).rows[2];
      expect(row.cause).toContain(`spawn ${c.bins.python} ENOENT`);
      expect(row.hint).toMatch(/다시 설치.*build-python\.sh/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P2-C9: pending migrations — the failure screen gives the `pnpm be:migrate` guidance", async () => {
    const r = await judgeAfterProbe(
      {
        pid: 1,
        alive: () => true,
        stderrTail: () => "",
        stdoutTail: () => "WARN 3 pending migration(s): 022_x.sql, 023_y.sql, 024_z.sql — run `pnpm be:migrate`",
        exitCode: () => null,
        onExit: () => undefined,
        stop: async () => undefined,
      },
      "ready",
      3000,
      {
        verifyOwnListener: async () => true,
        isPortOccupied: async () => false,
        onPendingMigrations: () => undefined,
        onMigrationCheckSkipped: () => undefined,
      },
    );
    const detail = r.kind === "failed" ? r.detail : "";
    const shell = shellStatusFrom({ statuses: [st("postgres"), failed("api", detail)], restartNotice: null, logPathOf });
    expect(shell.detail).toContain("적용되지 않은 마이그레이션이 3개 있어요");
    expect(shell.detail).toContain("`pnpm be:migrate`");
  });

  it("causeWithFix puts the fix on its own line under the cause, and nothing when there is no hint", () => {
    expect(causeWithFix("원인", "고치는 법")).toBe(`원인\n${HINT_PREFIX}고치는 법`);
    expect(causeWithFix("원인", undefined)).toBe("원인");
  });
});

/**
 * 판정 R-10c — 감독자가 "서비스 다시 시작"을 거부하는 동안 화면이 그것을 말해야 한다.
 * 그 서비스의 실제 모양은 `running`·`ok`·`owned`라, 고치기 전에는 평범한 초록 "실행 중"
 * 한 줄이었다(원인도 안내도 없이).
 */
describe("정리 중인 서비스 (R-10c)", () => {
  /** 이 원인의 안내는 서비스별이다 (worker 90초 · embed 모델 마무리). 좁히면서 그 모양을 단언한다. */
  const wait = (id: ServiceId): string => {
    const h = HINTS.restartStopFailed;
    if (h === null || typeof h === "string") throw new Error("restartStopFailed는 서비스별 안내여야 한다");
    return h[id]!;
  };

  const cleaning = (id: ServiceId = "worker") =>
    st(id, {
      cleaningUp: true,
      detail: `${CAUSES.restartStopFailed.text(id)}\n강제 종료 여부를 물을 수 있는 사람이 없어서 그대로 두었어요.`,
    });

  it("is not a plain green 실행 중 row", () => {
    const view = servicesView({ statuses: [cleaning()], restartNotice: null, logPathOf });
    const row = view.rows[0];
    expect(row.tone).toBe("warn");
    expect(row.state).toBe("실행 중 · 정리 중");
  });

  it("carries the cause and the per-service wait onto the row", () => {
    const row = servicesView({ statuses: [cleaning()], restartNotice: null, logPathOf }).rows[0];
    expect(row.cause).toContain("내리는 중이에요");
    expect(row.hint).toBe(wait("worker"));
    expect(row.hint).not.toContain("다시 시작");
  });

  it("marks the row so the restart button can disable itself", () => {
    const row = servicesView({ statuses: [cleaning()], restartNotice: null, logPathOf }).rows[0];
    expect(row.restartRefused).toBe(true);
  });

  it("marks an adopted and a stand-down row the same way, and leaves an owned healthy one alone", () => {
    const view = servicesView({
      statuses: [st("embed", { owned: false }), st("worker", { owned: false, detail: "외부 worker" }), st("api")],
      restartNotice: null,
      logPathOf,
    });
    expect(view.rows.map((r) => [r.id, r.restartRefused])).toEqual([
      ["embed", true],
      ["worker", true],
      ["api", undefined],
    ]);
  });

  it("tells the shell line too", () => {
    const line = statusLine(cleaning());
    expect(line).toContain("내리는 중");
    expect(line).toContain("내리는 중이에요");
    expect(line).toContain(wait("worker"));
  });

  it("goes back to a plain row once the process really exits", () => {
    // watchForDeath가 표시를 지운 뒤의 모양 — 그때는 failed라 평소의 실패 줄이다.
    const row = servicesView({
      statuses: [st("worker", { process: "failed", health: "unknown", owned: false, detail: "프로세스가 종료됐어요 (코드 0)." })],
      restartNotice: null,
      logPathOf,
    }).rows[0];
    expect(row.tone).toBe("fail");
    expect(row.state).toBe("실패");
    expect(row.restartRefused).toBeUndefined();
  });
});

/**
 * Task 11 — 화면이 **세 층을 구분해** 말한다 (스펙 §6.9·§6.10, 판정 R-11a).
 *
 * 한 줄로 뭉친 "다시 시도"가 금지된 이유가 여기 있다: 같은 `failed`라도 사람이 할 일이 셋으로
 * 갈리고, 그중 둘에는 누를 것이 아예 없다.
 */
describe("모델 준비 줄 (스펙 §6.9)", () => {
  const NOW = 1_800_000_000_000;
  const entry = (over: Partial<ReadinessEntry> = {}): ReadinessEntry => ({
    key: "BAAI/bge-m3",
    state: "downloading",
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    writer: "embed",
    attempt: 1,
    error: null,
    errorKind: null,
    ...over,
  });
  const view = (entries: ReadinessEntry[], over: Partial<Parameters<typeof servicesView>[0]> = {}) =>
    servicesView({
      statuses: ALL_OK,
      restartNotice: null,
      logPathOf,
      modelReadiness: entries,
      now: NOW,
      ...over,
    });

  it("행이 없으면 모델 절이 비어 있다 — 받은 적도 받는 중도 아니다", () => {
    expect(servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf }).models).toEqual([]);
  });

  it("받는 중이면 진행을 보인다", () => {
    const row = view([entry({ bytesDone: 512 * 1024 * 1024, bytesTotal: 2 * 1024 ** 3 })]).models[0];
    expect(row.state).toBe("받는 중");
    expect(row.notes[0]).toBe("25% · 512.0MB / 2.0GB");
    expect(row.notes).toContain("받는 서비스: 검색 임베딩");
    expect(row.restart).toBeUndefined();
    expect(row.cause).toBeUndefined();
  });

  it("총량을 모르면 퍼센트를 지어내지 않고 '받는 중'만 말한다 (스펙 §6.9)", () => {
    const row = view([entry({ bytesDone: 123, bytesTotal: 0 })]).models[0];
    expect(row.notes[0]).toBe("받는 중");
    expect(row.notes[0]).not.toContain("%");
  });

  it("ready는 초록 한 줄이다", () => {
    const row = view([entry({ state: "ready", bytesDone: 10, bytesTotal: 10 })]).models[0];
    expect(row).toEqual({ key: "BAAI/bge-m3", state: "준비됨", tone: "ok", notes: [] });
  });

  it("진행이 STALL_MS 넘게 멈춘 downloading은 '중단됨'이고 2층 버튼을 준다", () => {
    const row = view([entry({ updatedAt: NOW - STALL_MS - 1 })]).models[0];
    expect(row.state).toBe("중단됨");
    expect(row.tone).toBe("warn");
    expect(row.cause).toBe(CAUSES.modelDownloadStalled.text("BAAI/bge-m3"));
    expect(row.hint).toBe(RETRY_LAYERS.service);
    expect(row.restart).toEqual({ service: "embed", label: RESTART_LABEL, disabled: false });
  });

  it("무진행 판정의 경계는 감독자와 같은 STALL_MS 하나다", () => {
    expect(view([entry({ updatedAt: NOW - STALL_MS })]).models[0].state).toBe("받는 중");
    expect(view([entry({ updatedAt: NOW - STALL_MS - 1 })]).models[0].state).toBe("중단됨");
  });

  it("1층 — TRANSIENT 실패에는 버튼이 없고 기다리라고 말한다", () => {
    const row = view([
      entry({ state: "failed", error: "model_download_failed: ReadTimeout", errorKind: "TRANSIENT" }),
    ]).models[0];
    expect(row.hint).toBe(RETRY_LAYERS.download);
    expect(row.restart).toBeUndefined();
    expect(row.cause).toBe(CAUSES.modelDownloadFailed.text("BAAI/bge-m3", "ReadTimeout"));
  });

  it("1층이 2층을 이긴다 — TRANSIENT면 메시지에 403이 섞여 있어도 수락 페이지로 보내지 않는다", () => {
    const row = view([
      entry({ state: "failed", error: "model_download_failed: proxy said 403", errorKind: "TRANSIENT" }),
    ]).models[0];
    expect(row.hint).toBe(RETRY_LAYERS.download);
    expect(row.cause).not.toContain(HF_GATED_MODEL_PAGE_URL);
  });

  it("401 — 코드가 hf_token_invalid면 토큰 재입력으로 보낸다 (P4-C8)", () => {
    const row = view([
      entry({
        state: "failed",
        error: "hf_token_invalid: Hugging Face rejected the token (401)",
        errorKind: "PERMANENT",
      }),
    ]).models[0];
    expect(row.cause).toContain(CAUSES.hfTokenInvalid.text);
    expect(row.hint).toContain(HINTS.hfTokenInvalid as string);
    expect(row.hint).toContain("허깅페이스 토큰");
    expect(row.hint).toContain("담화 설정");
    // 수락 페이지로 보내지 않는다 — 401과 403은 다른 안내다.
    expect(row.cause).not.toContain(HF_GATED_MODEL_PAGE_URL);
  });

  it("403 — 코드가 hf_gate_not_accepted면 수락 페이지와 3층(회의 재처리)으로 보낸다 (P4-C8)", () => {
    const row = view([
      entry({
        key: "pyannote/speaker-diarization-community-1",
        state: "failed",
        error: "hf_gate_not_accepted: Hugging Face refused access (403)",
        errorKind: "PERMANENT",
        writer: "worker-1",
      }),
    ]).models[0];
    expect(row.cause).toContain(HF_GATED_MODEL_PAGE_URL);
    // Task 6의 문구를 그대로 쓴다 — 같은 원인을 두 곳이 적으면 갈린다.
    expect(row.hint).toBe(HINTS.hfGateNotAccepted);
    expect(row.hint).toContain("다시 처리");
    expect(row.restart).toBeUndefined();
  });

  it("코드를 알아볼 수 없으면 일반 PERMANENT 문구로 간다 (R-11a 폴백)", () => {
    for (const error of ["그냥 문장입니다", "Something: went wrong", null]) {
      const row = view([entry({ state: "failed", error, errorKind: "PERMANENT" })]).models[0];
      expect(row.cause).toContain("모델을 받지 못했어요");
      expect(row.hint).toBe(RETRY_LAYERS.service);
      expect(row.restart?.service).toBe("embed");
    }
  });

  it("errorKind가 없으면 스스로 풀린다고 약속하지 않는다", () => {
    const row = view([entry({ state: "failed", error: "x: y", errorKind: null })]).models[0];
    expect(row.hint).toBe(RETRY_LAYERS.service);
  });

  it("writer로 어느 서비스의 버튼인지 가른다 (판정 R-9a)", () => {
    const stalled = { updatedAt: NOW - STALL_MS - 1 };
    expect(view([entry({ ...stalled, writer: "embed" })]).models[0].restart?.service).toBe("embed");
    expect(view([entry({ ...stalled, writer: "worker-abc" })]).models[0].restart?.service).toBe("worker");
  });

  it("앱이 소유하지 않은 서비스의 버튼은 비활성이고 그 까닭을 말한다", () => {
    const statuses = [st("embed", { owned: false })];
    const row = view([entry({ updatedAt: NOW - STALL_MS - 1 })], { statuses }).models[0];
    expect(row.restart).toEqual({
      service: "embed",
      label: RESTART_LABEL,
      disabled: true,
      note: RESTART_NOT_OURS_NOTE,
    });
  });

  it("재시작이 도는 중이면 버튼이 진행을 보인다 — 죽은 것처럼 보이지 않게", () => {
    const row = view([entry({ updatedAt: NOW - STALL_MS - 1 })], { restarting: ["embed"] }).models[0];
    expect(row.restart).toEqual({ service: "embed", label: RESTART_BUSY_LABEL, disabled: true });
  });

  it("시도 횟수는 1보다 클 때만 말한다", () => {
    expect(view([entry({ state: "failed", attempt: 1 })]).models[0].notes).not.toContain("1번째 시도");
    expect(view([entry({ state: "failed", attempt: 3 })]).models[0].notes).toContain("3번째 시도");
  });
});

describe("서비스 줄의 다시 시작 버튼 (스펙 §6.10 2층)", () => {
  it("앱이 띄운 서비스에는 눌리는 버튼이 있다", () => {
    const rows = servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf }).rows;
    for (const row of rows) {
      expect(row.restart).toEqual({ service: row.id, label: RESTART_LABEL, disabled: false });
    }
  });

  it("채택한 인스턴스·정리 중은 비활성이고, 그 판정은 restartRefused 하나다", () => {
    const adopted = st("embed", { owned: false });
    const cleaning = st("worker", { cleaningUp: true });
    const view = servicesView({ statuses: [adopted, cleaning], restartNotice: null, logPathOf });
    expect(view.rows[0].restart.disabled).toBe(true);
    expect(view.rows[0].restart.note).toBe(RESTART_NOT_OURS_NOTE);
    expect(view.rows[0].restartRefused).toBe(true);
    expect(view.rows[1].restart.disabled).toBe(true);
    expect(view.rows[1].restart.note).toBe(RESTART_CLEANING_NOTE);
    // 버튼의 비활성과 감독자의 거부가 같은 술어에서 나온다.
    for (const row of view.rows) expect(row.restart.disabled).toBe(row.restartRefused === true);
  });

  it("아직 뜨지 않은 서비스는 막지 않는다 — 소유의 문제가 아니라 '띄운 적이 없다'이다", () => {
    const view = servicesView({
      statuses: [st("worker", { process: "failed", owned: false })],
      restartNotice: null,
      logPathOf,
    });
    expect(view.rows[0].restart.disabled).toBe(false);
  });
});

describe("토큰 절 (스펙 2026-09-25 §5.4)", () => {
  it("shows only the masked token and points to the Damwha settings — no buttons here any more", () => {
    const token = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
    const view = servicesView({ statuses: [], restartNotice: null, logPathOf, maskedToken: maskToken(token) });
    expect(view.token).toEqual({ masked: "hf_****…****4567", note: TOKEN_NOTE });
    expect(JSON.stringify(view)).not.toContain(token);
    expect(TOKEN_NOTE).toContain("담화 설정");
    expect(servicesView({ statuses: [], restartNotice: null, logPathOf }).token).toEqual({ masked: null, note: NO_TOKEN_NOTE });
    expect(NO_TOKEN_NOTE).toContain("담화 설정");
  });

  it("shows a note for all four token statuses (스펙 §5.4 '상태·마스킹 값') — never the raw token", () => {
    const token = "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567";
    const masked = maskToken(token);

    const present = servicesView({ statuses: [], restartNotice: null, logPathOf, maskedToken: masked, tokenStatus: "present" });
    expect(present.token).toEqual({ masked, note: TOKEN_NOTE });

    const absent = servicesView({ statuses: [], restartNotice: null, logPathOf, tokenStatus: "absent" });
    expect(absent.token).toEqual({ masked: null, note: NO_TOKEN_NOTE });

    // unreadable: 파일은 있는데 못 풀었다 — masked는 여전히 null(원문을 들고 있지 않다)이지만
    // "없음"과 같은 안내를 주면 안 된다. 키체인 실패가 아니므로 담화 설정에서 다시 넣으라고 말한다.
    const unreadable = servicesView({ statuses: [], restartNotice: null, logPathOf, tokenStatus: "unreadable" });
    expect(unreadable.token).toEqual({ masked: null, note: UNREADABLE_TOKEN_NOTE });
    expect(UNREADABLE_TOKEN_NOTE).toContain("담화 설정");

    // unavailable: safeStorage를 못 쓴다 — "담화 설정에서 넣으세요"는 거짓 안내다(넣어도 저장되지
    // 않는다). 키체인 안내(causes.ts·shell-hints.ts)가 이 화면에도 닿아야 한다.
    const unavailable = servicesView({ statuses: [], restartNotice: null, logPathOf, tokenStatus: "unavailable" });
    expect(unavailable.token).toEqual({ masked: null, note: TOKEN_UNAVAILABLE_NOTE });
    expect(TOKEN_UNAVAILABLE_NOTE).toContain(CAUSES.safeStorageUnavailable.text);
    expect(TOKEN_UNAVAILABLE_NOTE).toContain("키체인");

    for (const view of [present, absent, unreadable, unavailable]) {
      expect(JSON.stringify(view)).not.toContain(token);
    }
  });
});

describe("parseServicesAction — 페이지에서 오는 값", () => {
  it("아는 한 모양만 통과시킨다", () => {
    expect(parseServicesAction({ kind: "restart", service: "worker" })).toEqual({
      kind: "restart",
      service: "worker",
    });
    expect(parseServicesAction({ kind: "token", op: "change" })).toBeNull();
    expect(parseServicesAction({ kind: "token", op: "clear" })).toBeNull();
  });

  it("모르는 것은 전부 null이다 — 렌더러 값이 감독자에게 그대로 들어가지 않는다", () => {
    for (const bad of [
      null,
      undefined,
      "restart",
      7,
      [],
      { kind: "restart" },
      { kind: "restart", service: "postgres!" },
      { kind: "restart", service: "toString" },
      { kind: "token" },
      { kind: "token", op: "drop" },
      { kind: "quit" },
    ]) {
      expect(parseServicesAction(bad)).toBeNull();
    }
  });
});

describe("버튼이 없으면 버튼을 가리키지 않는다 (fix 3)", () => {
  const NOW = 1_800_000_000_000;
  const stalled: ReadinessEntry = {
    key: "BAAI/bge-m3",
    state: "downloading",
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: NOW - 300_000,
    updatedAt: NOW - STALL_MS - 1,
    writer: "embed",
    attempt: 1,
    error: null,
    errorKind: null,
  };
  const failed: ReadinessEntry = {
    ...stalled,
    state: "failed",
    error: "model_download_failed: boom",
    errorKind: "PERMANENT",
    updatedAt: NOW - 1_000,
  };
  /** 감독자가 없는 창 — 거부된 기동 뒤 statuses는 비었는데 마지막 스냅숏은 남아 있다. */
  const orphaned = (entries: ReadinessEntry[]) =>
    servicesView({ statuses: [], restartNotice: null, logPathOf, modelReadiness: entries, now: NOW });

  it("중단됨 — 감독자가 그 서비스를 모르면 안내가 메뉴의 다시 시도로 간다", () => {
    const row = orphaned([stalled]).models[0];
    expect(row.restart).toBeUndefined();
    expect(row.hint).toBe(NO_SERVICES_YET);
    expect(row.hint).not.toBe(RETRY_LAYERS.service);
  });

  it("일반 PERMANENT 실패도 같다", () => {
    const row = orphaned([failed]).models[0];
    expect(row.restart).toBeUndefined();
    expect(row.hint).toBe(NO_SERVICES_YET);
  });

  it("어떤 모델 줄도 버튼 없이 '이 줄의 서비스 다시 시작'을 말하지 않는다", () => {
    for (const entries of [[stalled], [failed]]) {
      for (const statuses of [[], ALL_OK]) {
        const row = servicesView({
          statuses,
          restartNotice: null,
          logPathOf,
          modelReadiness: entries,
          now: NOW,
        }).models[0];
        if (row.hint === RETRY_LAYERS.service) expect(row.restart).toBeDefined();
      }
    }
  });

  it("감독자가 있으면 그대로 2층 버튼과 그 안내다", () => {
    const row = servicesView({
      statuses: ALL_OK,
      restartNotice: null,
      logPathOf,
      modelReadiness: [stalled],
      now: NOW,
    }).models[0];
    expect(row.hint).toBe(RETRY_LAYERS.service);
    expect(row.restart?.service).toBe("embed");
  });
});
