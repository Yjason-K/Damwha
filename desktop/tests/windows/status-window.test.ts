import { describe, expect, it } from "vitest";
import {
  ASK_RETRY_LIMIT,
  createStatusWindow,
  mayAutoOpen,
  type StatusWindowHost,
} from "../../src/windows/status-window";
import {
  renderCall,
  SERVICES_ASK_SCRIPT,
  type ServicesAction,
  type ServicesView,
} from "../../src/windows/status-view";
import type { ServiceId, ServiceStatus } from "../../src/services/types";

/** 서비스도 모델도 토큰도 없는 빈 한 장. 이 테스트들이 보는 것은 안내 줄과 호출 모양뿐이다. */
function emptyView(notices: string[] = []): ServicesView {
  return {
    rows: [],
    models: [],
    token: { masked: null, note: "", canClear: false, busy: false },
    notices,
  };
}

/** 가짜 창. 파괴·로드·닫힘을 테스트가 직접 일으킨다. */
interface FakeWin {
  n: number;
  focus: boolean;
  destroyed: boolean;
  focused: number;
  loads: Array<() => void>;
  closes: Array<() => void>;
  /** 렌더 호출만. 묻는 호출(SERVICES_ASK_SCRIPT)은 asks로 따로 샌다. */
  scripts: string[];
  asks: number;
}

const st = (id: ServiceId, process: ServiceStatus["process"], over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id,
  process,
  health: process === "running" ? "ok" : "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

function harness(
  opts: { autoOpen?: boolean; runRejects?: unknown; createThrows?: boolean; answers?: unknown[] } = {},
) {
  const wins: FakeWin[] = [];
  const logs: string[] = [];
  const actions: ServicesAction[] = [];
  /** 묻는 고리가 끝났다고 배선에 알린 사유. */
  const askFailures: string[] = [];
  /** 묻는 호출이 차례로 돌려줄 값. 다 떨어지면 null이라 고리가 멈춘다(다리 없음과 같은 길). */
  const answers = [...(opts.answers ?? [])];
  let view: ServicesView = emptyView(["처음"]);
  let statuses: ServiceStatus[] = [];
  let autoOpen = opts.autoOpen ?? true;
  const host: StatusWindowHost<FakeWin> = {
    create: (focus) => {
      if (opts.createThrows) throw new Error("BrowserWindow를 못 만들었어요");
      const w: FakeWin = { n: wins.length, focus, destroyed: false, focused: 0, loads: [], closes: [], scripts: [], asks: 0 };
      wins.push(w);
      return w;
    },
    alive: (w) => !w.destroyed,
    focus: (w) => {
      w.focused += 1;
    },
    onLoad: (w, l) => w.loads.push(l),
    onClosed: (w, l) => w.closes.push(l),
    run: (w, script) => {
      if (script === SERVICES_ASK_SCRIPT) {
        w.asks += 1;
        if (opts.runRejects !== undefined) return Promise.reject(opts.runRejects);
        return Promise.resolve(answers.length > 0 ? answers.shift() : null);
      }
      w.scripts.push(script);
      return opts.runRejects === undefined ? Promise.resolve(undefined) : Promise.reject(opts.runRejects);
    },
    view: () => view,
    statuses: () => statuses,
    mayAutoOpen: () => autoOpen,
    onAction: (a) => {
      actions.push(a);
    },
    onAskFailed: (reason) => askFailures.push(reason),
    log: (line) => logs.push(line),
  };
  const sw = createStatusWindow(host);
  return {
    sw,
    wins,
    logs,
    actions,
    askFailures,
    setView: (v: ServicesView) => (view = v),
    setStatuses: (s: ServiceStatus[]) => (statuses = s),
    setAutoOpen: (v: boolean) => (autoOpen = v),
    load: (w: FakeWin) => w.loads.forEach((l) => l()),
    close: (w: FakeWin) => {
      w.destroyed = true;
      w.closes.forEach((l) => l());
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createStatusWindow — 메뉴로 열기", () => {
  it("creates the window focused, and a second open focuses the same window", () => {
    const h = harness();
    h.sw.open();
    h.sw.open();
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].focus).toBe(true);
    expect(h.wins[0].focused).toBe(1);
  });

  it("draws the current state as soon as the page has loaded, even if nothing changes afterwards (P2-C1)", () => {
    // 넷이 다 running/ok인 앱은 상태를 더 내지 않는다. 로드 뒤 한 번 그리지 않으면 창은 영영 빈다.
    const h = harness();
    h.sw.open();
    expect(h.wins[0].scripts).toEqual([]);
    h.load(h.wins[0]);
    expect(h.wins[0].scripts).toEqual([renderCall(emptyView(["처음"]))]);
  });

  it("draws again after a reload (⌘R), not only after the first load", () => {
    const h = harness();
    h.sw.open();
    h.load(h.wins[0]);
    h.load(h.wins[0]);
    expect(h.wins[0].scripts).toHaveLength(2);
  });

  it("creates a new window after the previous one was closed", () => {
    const h = harness();
    h.sw.open();
    h.close(h.wins[0]);
    h.sw.open();
    expect(h.wins).toHaveLength(2);
  });

  it("logs and carries on when the window cannot be created — it runs inside the supervisor's set()", () => {
    const h = harness({ createThrows: true });
    expect(() => h.sw.onStatus([st("api", "failed")])).not.toThrow();
    expect(() => h.sw.open()).not.toThrow();
    expect(h.logs.some((l) => l.includes("BrowserWindow를 못 만들었어요"))).toBe(true);
  });
});

describe("createStatusWindow — 실시간 갱신", () => {
  it("redraws on every status while the window is open — degraded then ok (P2-C11)", () => {
    const h = harness();
    h.sw.open();
    h.load(h.wins[0]);
    h.setView(emptyView(["degraded"]));
    h.sw.onStatus([st("api", "running", { health: "degraded" })]);
    h.setView(emptyView(["ok"]));
    h.sw.onStatus([st("api", "running")]);
    expect(h.wins[0].scripts.slice(-2)).toEqual([
      renderCall(emptyView(["degraded"])),
      renderCall(emptyView(["ok"])),
    ]);
  });

  it("refresh redraws for a change that is not a status (the restart notice)", () => {
    const h = harness();
    h.sw.open();
    h.load(h.wins[0]);
    h.setView(emptyView(["다시 켜야 바뀌어요"]));
    h.sw.refresh();
    expect(h.wins[0].scripts.at(-1)).toBe(renderCall(emptyView(["다시 켜야 바뀌어요"])));
  });

  it("sends nothing to a closed window", () => {
    const h = harness();
    h.sw.open();
    h.close(h.wins[0]);
    h.sw.onStatus([st("api", "running")]);
    h.sw.refresh();
    expect(h.wins[0].scripts).toEqual([]);
  });

  it("swallows a rejected render but logs it while the window is alive — a silently frozen window is the failure", async () => {
    const h = harness({ runRejects: new Error("render blew up") });
    h.sw.open();
    h.sw.refresh();
    await flush();
    expect(h.logs.some((l) => l.includes("render blew up"))).toBe(true);
  });

  it("does not log a rejection that raced the window closing", async () => {
    const h = harness({ runRejects: new Error("Object has been destroyed") });
    h.sw.open();
    h.sw.refresh();
    h.wins[0].destroyed = true;
    await flush();
    expect(h.logs).toEqual([]);
  });
});

describe("createStatusWindow — 스스로 띄우기", () => {
  it("opens without stealing focus when a service fails while the app screen is showing", () => {
    const h = harness();
    h.sw.onStatus([st("worker", "failed")]);
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].focus).toBe(false);
  });

  it("opens for a failed background service too, not only a gate (P2-C8: uv is worker/embed)", () => {
    const h = harness();
    h.sw.onStatus([st("postgres", "running"), st("api", "running"), st("embed", "failed")]);
    expect(h.wins).toHaveLength(1);
  });

  it("does not open for starting, degraded, or stood-down services", () => {
    const h = harness();
    h.sw.onStatus([
      st("api", "starting"),
      st("postgres", "running", { health: "degraded" }),
      st("worker", "running", { owned: false, health: "unknown", detail: "외부 worker" }),
    ]);
    expect(h.wins).toHaveLength(0);
  });

  it("opens once per failure episode — a backoff retry that fails again does not reopen a window the user closed", () => {
    const h = harness();
    h.sw.onStatus([st("api", "failed")]);
    h.close(h.wins[0]);
    h.sw.onStatus([st("api", "starting")]);
    h.sw.onStatus([st("api", "failed")]);
    expect(h.wins).toHaveLength(1);
  });

  it("tracks the episode per service — an announced worker failure does not use up embed's (리뷰 M-2)", () => {
    // worker를 알린 뒤 사용자가 창을 닫았고 worker는 failed로 남아 있다. 그 사이 embed가 넘어지면 새 사건이다.
    const h = harness();
    h.sw.onStatus([st("worker", "failed"), st("embed", "running")]);
    expect(h.wins).toHaveLength(1);
    h.close(h.wins[0]);
    h.sw.onStatus([st("worker", "failed"), st("embed", "failed")]);
    expect(h.wins).toHaveLength(2);
    // 그리고 둘 다 알렸으니 그대로 남은 실패는 다시 띄우지 않는다.
    h.close(h.wins[1]);
    h.sw.onStatus([st("worker", "failed"), st("embed", "failed")]);
    expect(h.wins).toHaveLength(2);
  });

  it("does not let another service reaching running clear this service's failure episode (리뷰 M-2, 지우는 방향)", () => {
    // 실제 앱에서는 postgres·api가 늘 running이고 API 헬스 프로브가 10초마다 status를 낸다. worker가
    // failed인 채로 그 status가 반복되면, 닫은 창이 아무것도 안 바뀌었는데 되살아나서는 안 된다.
    const h = harness();
    h.sw.onStatus([st("postgres", "running"), st("api", "running"), st("embed", "running"), st("worker", "failed")]);
    expect(h.wins).toHaveLength(1);
    h.close(h.wins[0]);

    for (let i = 0; i < 3; i++) {
      h.sw.onStatus([st("postgres", "running"), st("api", "running"), st("embed", "running"), st("worker", "failed")]);
    }
    expect(h.wins).toHaveLength(1);

    // 재무장은 그대로 살아 있어야 한다: worker 자신이 running에 닿은 뒤 다시 failed면 새 사건이다.
    h.sw.onStatus([st("postgres", "running"), st("api", "running"), st("embed", "running"), st("worker", "running")]);
    h.sw.onStatus([st("postgres", "running"), st("api", "running"), st("embed", "running"), st("worker", "failed")]);
    expect(h.wins).toHaveLength(2);
  });

  it("opens again for a new failure after the service reached running", () => {
    const h = harness();
    h.sw.onStatus([st("api", "failed")]);
    h.close(h.wins[0]);
    h.sw.onStatus([st("api", "running")]);
    h.sw.onStatus([st("api", "failed")]);
    expect(h.wins).toHaveLength(2);
  });

  it("does not focus an already open window when another failure arrives", () => {
    const h = harness();
    h.sw.open();
    h.sw.onStatus([st("api", "failed")]);
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].focused).toBe(0);
  });

  it("does not open while the shell screen (or no window) is showing", () => {
    const h = harness({ autoOpen: false });
    h.sw.onStatus([st("postgres", "failed")]);
    expect(h.wins).toHaveLength(0);
  });

  it("keeps a failure that happened before attach and opens for it right after attach", () => {
    // uv가 없으면 worker는 몇 밀리초 만에 넘어지고, API는 몇 초 뒤에야 준비된다. 그 실패를
    // 붙기 전에 "알린 것"으로 치면 붙은 뒤에는 어떤 화면에도 없다.
    const h = harness({ autoOpen: false });
    const failed = [st("postgres", "running"), st("api", "starting"), st("worker", "failed")];
    h.sw.onStatus(failed);
    expect(h.wins).toHaveLength(0);
    h.setAutoOpen(true);
    h.setStatuses([st("postgres", "running"), st("api", "running"), st("worker", "failed")]);
    h.sw.reconsider();
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].focus).toBe(false);
  });

  it("reconsider does nothing when everything is fine", () => {
    const h = harness();
    h.setStatuses([st("api", "running")]);
    h.sw.reconsider();
    expect(h.wins).toHaveLength(0);
  });
});

describe("mayAutoOpen", () => {
  it("only while the app screen is attached to a live main window and the app is not quitting", () => {
    expect(mayAutoOpen({ quitting: false, hasWindow: true, rendererAttached: true })).toBe(true);
    expect(mayAutoOpen({ quitting: false, hasWindow: true, rendererAttached: false })).toBe(false);
    expect(mayAutoOpen({ quitting: false, hasWindow: false, rendererAttached: true })).toBe(false);
    expect(mayAutoOpen({ quitting: true, hasWindow: true, rendererAttached: true })).toBe(false);
  });
});

/**
 * Task 11 — 버튼이 main에 닿는 길 (스펙 §6.4·§6.10 2층). 채널이 아니라 **묻기**다: main이 건 호출이
 * 사람이 누를 때까지 안 끝나고, 답이 곧 동작이다.
 */
describe("상태 창의 버튼 — 묻는 고리", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("로드가 끝나면 묻기 시작하고, 답을 배선으로 넘긴다", async () => {
    const h = harness({
      answers: [{ kind: "restart", service: "worker" }, { kind: "token", op: "change" }],
    });
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.actions).toEqual([
      { kind: "restart", service: "worker" },
      { kind: "token", op: "change" },
    ]);
  });

  it("모르는 모양은 버리고 계속 묻는다 — 한 번의 이상한 값이 버튼 전체를 죽이지 않는다", async () => {
    const h = harness({ answers: [{ kind: "restart", service: "감독자" }, { kind: "token", op: "clear" }] });
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.actions).toEqual([{ kind: "token", op: "clear" }]);
    expect(h.logs.some((l) => l.includes("알 수 없는 요청"))).toBe(true);
  });

  it("다리가 없으면 한 번만 적고 멈춘다 — 바쁜 고리를 만들지 않는다", async () => {
    const h = harness();
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.wins[0].asks).toBe(1);
    expect(h.logs.filter((l) => l.includes("스크립트가 돌지 않아"))).toHaveLength(1);
  });

  it("창이 닫히면 더 묻지 않는다", async () => {
    const h = harness({ answers: [{ kind: "token", op: "change" }] });
    h.sw.open();
    h.load(h.wins[0]);
    h.close(h.wins[0]);
    await flush();
    expect(h.actions).toEqual([]);
  });

  it("⌘R 뒤에는 새 페이지가 묻고, 옛 페이지의 답은 버린다", async () => {
    const h = harness({
      answers: [{ kind: "token", op: "clear" }, { kind: "token", op: "change" }],
    });
    h.sw.open();
    h.load(h.wins[0]);
    h.load(h.wins[0]);
    await flush();
    // 두 세대가 함께 돌면 한 번 누른 것이 두 번 처리된다. 옛 세대(clear)는 물러나고 새 것만 남는다.
    expect(h.actions).toEqual([{ kind: "token", op: "change" }]);
  });
});

/**
 * Task 11 fix 1 — 묻는 고리가 **조용히** 죽지 않는다.
 *
 * 창은 떠 있고 버튼도 그대로 보이므로, 고리가 끝난 것을 로그에만 적으면 사람은 앱이 멈춘 줄 안다.
 */
describe("묻는 고리가 끝날 때", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("살아 있는 창의 거부는 ASK_RETRY_LIMIT번까지 다시 건다", async () => {
    const h = harness({ runRejects: new Error("Script failed to execute") });
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.wins[0].asks).toBe(ASK_RETRY_LIMIT);
  });

  it("그 한계를 넘으면 화면에 올릴 사유를 배선에 넘긴다 — 로그로 끝내지 않는다", async () => {
    const h = harness({ runRejects: new Error("Script failed to execute") });
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.askFailures).toHaveLength(1);
    expect(h.askFailures[0]).toContain("응답하지 않아요");
    expect(h.askFailures[0]).toContain("⌘R");
  });

  it("한 번이라도 답이 오면 거부 횟수가 0으로 돌아간다", async () => {
    // 답 하나 → null(다리 없음)로 끝. 거부가 없었으므로 재시도 한계와 무관하게 한 번에 멈춘다.
    const h = harness({ answers: [{ kind: "token", op: "change" }] });
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.actions).toHaveLength(1);
    expect(h.wins[0].asks).toBe(2);
  });

  it("다리가 없을 때도 화면에 올릴 사유를 넘긴다", async () => {
    const h = harness();
    h.sw.open();
    h.load(h.wins[0]);
    await flush();
    expect(h.askFailures).toHaveLength(1);
    expect(h.askFailures[0]).toContain("스크립트가 돌지 않아");
  });

  it("창이 닫힌 뒤의 거부는 알리지 않는다 — 예상된 일이다", async () => {
    const h = harness({ runRejects: new Error("Object has been destroyed") });
    h.sw.open();
    h.close(h.wins[0]);
    h.load(h.wins[0]);
    await flush();
    expect(h.askFailures).toEqual([]);
  });
});
