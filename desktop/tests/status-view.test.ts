import * as vm from "vm";
import { describe, expect, it } from "vitest";
import { CAUSES } from "../src/causes";
import { DEGRADED_HINT, HINTS } from "../src/shell-hints";
import {
  HINT_PREFIX,
  NO_SERVICES_YET,
  failureDetail,
  renderCall,
  servicesView,
  shellStatusFrom,
  statusLine,
  type ServicesView,
} from "../src/status-view";
import type { ServiceId, ServiceStatus } from "../src/services/types";

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

  it("uses the db-unreachable screen when postgres failed, with the supervisor log", () => {
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail: CAUSES.dockerDaemonDown.text }), st("api", { process: "stopped", health: "unknown" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).toBe("db-unreachable");
    expect(shell.logPath).toBe("/logs/supervisor.log");
    // P2-C7: 원인과 "Docker Desktop을 실행"이 실패 화면에 있다.
    expect(shell.detail).toContain(CAUSES.dockerDaemonDown.text);
    expect(shell.detail).toContain(HINTS.dockerDaemonDown as string);
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
