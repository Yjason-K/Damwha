import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../../src/diagnostics/causes";
import { DEGRADED_HINT, HINTS } from "../../src/windows/shell-hints";
import {
  HINT_PREFIX,
  causeWithFix,
  NO_SERVICES_YET,
  failureDetail,
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
      rows: [{ id: "api", name: "API", state: "실패", tone: "fail", notes: [text], cause: text, hint: text, log: text }],
      notices: [text],
    };
    const { calls, sandbox } = run(renderCall(view));
    expect(calls).toEqual([view]);
    expect(sandbox.pwned).toBeUndefined();
  });

  it("does nothing when the page has not defined the render function yet (still loading)", () => {
    const sandbox: Record<string, unknown> = { window: {} };
    expect(() => vm.runInNewContext(renderCall({ rows: [], notices: [] }), sandbox)).not.toThrow();
  });

  it("evaluates to undefined so executeJavaScript has nothing to serialise", () => {
    const sandbox = { window: { __damwha_render: () => ({ node: "not cloneable" }) } };
    expect(vm.runInNewContext(renderCall({ rows: [], notices: [] }), sandbox)).toBeUndefined();
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
