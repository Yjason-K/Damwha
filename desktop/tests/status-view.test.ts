import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../src/causes";
import { DEGRADED_HINT, HINTS } from "../src/shell-hints";
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
} from "../src/status-view";
import { judgeAfterProbe } from "../src/services/api";
import { postgresSpec } from "../src/services/postgres";
import { workerSpec } from "../src/services/worker";
import type { LaunchContext, ServiceId, ServiceStatus } from "../src/services/types";

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

  it("sends postgres to supervisor.log — the container has no log file of its own", () => {
    const view = servicesView({ statuses: ALL_OK, restartNotice: null, logPathOf });
    expect(view.rows.map((r) => r.log)).toEqual([
      "/logs/supervisor.log",
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
});

describe("statusLine / shellStatusFrom", () => {
  it("puts the cause and then the hint under a failed service", () => {
    const line = statusLine(st("postgres", { process: "failed", health: "unknown", detail: CAUSES.dockerDaemonDown.text }));
    expect(line).toBe(
      `데이터베이스: 실패\n    ${CAUSES.dockerDaemonDown.text}\n    ${HINT_PREFIX}${HINTS.dockerDaemonDown}`,
    );
  });

  it("indents every line of a multi-line cause", () => {
    const line = statusLine(st("api", { process: "failed", health: "unknown", detail: "startup failed: [\n  {}\n]" }));
    expect(line).toBe("API: 실패\n    startup failed: [\n      {}\n    ]");
  });

  it("keeps the Phase 1 line for a healthy or adopted service", () => {
    expect(statusLine(st("api"))).toBe("API: 실행 중");
    expect(statusLine(st("embed", { owned: false }))).toBe("검색 임베딩: 실행 중 (앱이 띄우지 않음)");
  });

  it("uses the db-unreachable screen when postgres failed on the Docker daemon, with the supervisor log", () => {
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail: CAUSES.dockerDaemonDown.text }), st("api", { process: "stopped", health: "unknown" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).toBe("db-unreachable");
    expect(shell.logPath).toBe("/logs/supervisor.log");
    // P2-C7: 원인과 "Docker Desktop을 실행"이 실패 화면에 있다. 상수를 상수에 대지 않는다 — 안내
    // 문구에서 "Docker Desktop"을 빼도 초록인 단언은 기준을 지키지 않는다.
    expect(shell.detail).toContain("Docker Desktop이 실행 중이 아니에요");
    expect(shell.detail).toContain("Docker Desktop을 실행");
  });

  it("never puts a retry countdown on the screen by itself — only the code that schedules the timer may", () => {
    // 카운트다운은 main.ts의 scheduleRetry가 실제로 타이머를 건 자리에서만 붙는다. 이 조립이 초를
    // 스스로 적으면, 창을 다시 연 화면처럼 아무 타이머도 없는 곳에서 "N초 뒤에 다시 시도해요"라고
    // 거짓말을 한다.
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail: CAUSES.dockerDaemonDown.text })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.retryInSeconds).toBeUndefined();
  });

  it("does not use the db-unreachable screen for a raw compose error that is not the Docker daemon (리뷰 M-1)", () => {
    // 5432 포트 충돌 같은 원문 compose stderr는 알려진 원인이 아니다(causeIn이 undefined). 그때도
    // db-unreachable로 가면 "Docker Desktop이 실행 중인지 확인해 주세요"가 이미 켜져 있는 Docker
    // Desktop을 가리키는 거짓 안내가 된다 — 해결 줄은 포트 얘기를 하는데 본문은 딴 데를 가리킨다.
    const shell = shellStatusFrom({
      statuses: [
        st("postgres", { process: "failed", health: "unknown", detail: "Bind for 0.0.0.0:5432 failed: port is already allocated" }),
        st("api", { process: "stopped", health: "unknown" }),
      ],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).not.toBe("db-unreachable");
    // 여기 있던 `detail`에 대한 `not.toMatch(/Docker Desktop/)`는 아무것도 지키지 않았다(최종 리뷰 M-3) —
    // 그 문구는 status.html의 db-unreachable 본문에만 있고 detail에는 어떤 경로로도 들어오지 않는다.
    // 본문 선택은 위 state 단언이 지킨다. 대신 일반 실패 화면이 **원문 원인을 그대로** 싣는지를 본다:
    // 이 원인에는 안내가 없으므로(causeIn이 모른다) 사람이 포트 충돌을 읽을 곳은 이 줄뿐이다.
    expect(shell.detail).toContain("Bind for 0.0.0.0:5432 failed: port is already allocated");
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
    expect(failureDetail("앱을 시작하지 못했어요", CAUSES.dockerMissing.text)).toBe(
      `앱을 시작하지 못했어요: ${CAUSES.dockerMissing.text}\n${HINT_PREFIX}${HINTS.dockerMissing}`,
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
    env: {},
    bins: { uv: "/opt/homebrew/bin/uv" },
    searchDirs: [],
    logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
    ...over,
  });
  const reasonOf = async (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
  const failed = (id: ServiceId, detail: string): ServiceStatus =>
    st(id, { process: "failed", health: "unknown", detail });

  it("P2-C7: Docker daemon down — the failure screen says to run Docker Desktop", async () => {
    const detail = await reasonOf(
      postgresSpec(async () => ({
        stdout: "",
        stderr: "failed to connect to the docker API at unix:///x/docker.sock; check if the daemon is running",
        code: 1,
      })).launch(ctx()),
    );
    const shell = shellStatusFrom({
      statuses: [failed("postgres", detail), st("api", { process: "stopped", health: "unknown" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).toBe("db-unreachable");
    expect(shell.detail).toContain("Docker Desktop이 실행 중이 아니에요");
    expect(shell.detail).toContain("Docker Desktop을 실행");
  });

  it("P2-C8: uv not found — names what is missing and the config.json fix, on the failure screen and in the status window", async () => {
    const detail = await reasonOf(workerSpec({ listExternal: async () => [] }).launch(ctx({ bins: { uv: null } })));
    const statuses = [st("postgres"), st("api"), failed("worker", detail)];
    const shell = shellStatusFrom({ statuses, restartNotice: null, logPathOf });
    expect(shell.detail).toContain("uv를 찾지 못했어요");
    expect(shell.detail).toMatch(/config\.json의 UV_BIN/);
    const row = servicesView({ statuses, restartNotice: null, logPathOf }).rows[2];
    expect(row.cause).toContain("uv를 찾지 못했어요");
    expect(row.hint).toMatch(/config\.json의 UV_BIN/);
  });

  it("P2-C8: docker not found before the supervisor exists — names it and the config.json fix", () => {
    const text = failureDetail("앱을 시작하지 못했어요", CAUSES.dockerMissing.text);
    expect(text).toContain("docker를 찾지 못했어요");
    expect(text).toMatch(/config\.json의 .*DOCKER_BIN/);
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
