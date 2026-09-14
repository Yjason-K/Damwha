import { describe, expect, it } from "vitest";
import { createStatusWindow, mayAutoOpen, type StatusWindowHost } from "../src/status-window";
import { renderCall, type ServicesView } from "../src/status-view";
import type { ServiceId, ServiceStatus } from "../src/services/types";

/** 가짜 창. 파괴·로드·닫힘을 테스트가 직접 일으킨다. */
interface FakeWin {
  n: number;
  focus: boolean;
  destroyed: boolean;
  focused: number;
  loads: Array<() => void>;
  closes: Array<() => void>;
  scripts: string[];
}

const st = (id: ServiceId, process: ServiceStatus["process"], over: Partial<ServiceStatus> = {}): ServiceStatus => ({
  id,
  process,
  health: process === "running" ? "ok" : "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

function harness(opts: { autoOpen?: boolean; runRejects?: unknown; createThrows?: boolean } = {}) {
  const wins: FakeWin[] = [];
  const logs: string[] = [];
  let view: ServicesView = { rows: [], notices: ["처음"] };
  let statuses: ServiceStatus[] = [];
  let autoOpen = opts.autoOpen ?? true;
  const host: StatusWindowHost<FakeWin> = {
    create: (focus) => {
      if (opts.createThrows) throw new Error("BrowserWindow를 못 만들었어요");
      const w: FakeWin = { n: wins.length, focus, destroyed: false, focused: 0, loads: [], closes: [], scripts: [] };
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
      w.scripts.push(script);
      return opts.runRejects === undefined ? Promise.resolve(undefined) : Promise.reject(opts.runRejects);
    },
    view: () => view,
    statuses: () => statuses,
    mayAutoOpen: () => autoOpen,
    log: (line) => logs.push(line),
  };
  const sw = createStatusWindow(host);
  return {
    sw,
    wins,
    logs,
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
    expect(h.wins[0].scripts).toEqual([renderCall({ rows: [], notices: ["처음"] })]);
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
    h.setView({ rows: [], notices: ["degraded"] });
    h.sw.onStatus([st("api", "running", { health: "degraded" })]);
    h.setView({ rows: [], notices: ["ok"] });
    h.sw.onStatus([st("api", "running")]);
    expect(h.wins[0].scripts.slice(-2)).toEqual([
      renderCall({ rows: [], notices: ["degraded"] }),
      renderCall({ rows: [], notices: ["ok"] }),
    ]);
  });

  it("refresh redraws for a change that is not a status (the restart notice)", () => {
    const h = harness();
    h.sw.open();
    h.load(h.wins[0]);
    h.setView({ rows: [], notices: ["다시 켜야 바뀌어요"] });
    h.sw.refresh();
    expect(h.wins[0].scripts.at(-1)).toBe(renderCall({ rows: [], notices: ["다시 켜야 바뀌어요"] }));
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
