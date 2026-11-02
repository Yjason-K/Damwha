import { describe, expect, it } from "vitest";
import { t } from "../../src/i18n/dictionary";
import { createPillWindow, type PillWindowHost } from "../../src/windows/pill-window";
import {
  PILL_ASK_SCRIPT,
  PILL_COMPACT,
  PILL_HOVER,
  pillBounds,
  pillClamp,
  pillDefaultPosition,
  pillRenderCall,
  type PillView,
  type Rect,
} from "../../src/windows/pill-view";
import type { PillPoint } from "../../src/app/detection-state";

const view: PillView = { kind: "pill", token: 7, startedAt: 1_000, stopRetry: 0 };
const LEFT: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const RIGHT: Rect = { x: 1440, y: 0, width: 1920, height: 1080 };
const labels = { stop: t("ko", "detect.stop"), open: t("ko", "detect.open") };
const render = (v: PillView) => pillRenderCall(v, labels);

interface FakeWin {
  destroyed: boolean;
  bounds: Rect;
  moves: Rect[];
  scripts: string[];
  loads: Array<() => void>;
  closed: Array<() => void>;
  queue: unknown[];
  waiters: Array<(v: unknown) => void>;
}

function harness(opts: { saved?: PillPoint | null; areas?: Rect[]; cursor?: Rect } = {}) {
  const wins: FakeWin[] = [];
  const saves: PillPoint[] = [];
  const actions: Array<[number, string]> = [];
  const logs: string[] = [];
  const env = {
    saved: opts.saved ?? null,
    areas: opts.areas ?? [LEFT, RIGHT],
    cursor: opts.cursor ?? LEFT,
  };
  const host: PillWindowHost<FakeWin> = {
    create: (bounds) => {
      const w: FakeWin = {
        destroyed: false,
        bounds,
        moves: [],
        scripts: [],
        loads: [],
        closed: [],
        queue: [],
        waiters: [],
      };
      wins.push(w);
      return w;
    },
    alive: (w) => !w.destroyed,
    close: (w) => {
      w.destroyed = true;
    },
    onLoad: (w, l) => w.loads.push(l),
    onClosed: (w, l) => w.closed.push(l),
    run: (w, script) => {
      if (script !== PILL_ASK_SCRIPT) {
        w.scripts.push(script);
        return Promise.resolve(undefined);
      }
      if (w.queue.length > 0) return Promise.resolve(w.queue.shift());
      return new Promise((resolve) => w.waiters.push(resolve));
    },
    bounds: (w) => w.bounds,
    setBounds: (w, r) => {
      w.bounds = r;
      w.moves.push(r);
    },
    workAreas: () => env.areas,
    cursorArea: () => env.cursor,
    saved: () => env.saved,
    save: (p) => {
      saves.push(p);
    },
    labels: () => labels,
    onAction: (token, action) => void actions.push([token, action]),
    log: (l) => void logs.push(l),
  };
  /** 페이지처럼 답을 큐에 넣거나 기다리는 묻기에 건넨다. */
  const send = (win: FakeWin, answer: unknown) => {
    const waiter = win.waiters.shift();
    if (waiter) waiter(answer);
    else win.queue.push(answer);
  };
  return { host, env, wins, saves, actions, logs, send };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 창을 띄우고 로드를 끝내 묻기가 돌게 한다. */
async function opened(h: ReturnType<typeof harness>) {
  const w = createPillWindow(h.host);
  w.show(view);
  const win = h.wins[0];
  win.loads[0]();
  await tick();
  return { w, win };
}

describe("createPillWindow", () => {
  it("저장된 위치가 맞으면 그 자리에 뜬다", () => {
    const saved = { x: 500, y: 300 };
    const h = harness({ saved });
    const w = createPillWindow(h.host);
    w.show(view);
    expect(h.wins[0].bounds).toEqual(pillBounds(saved, false));
    expect(w.anchor()).toEqual(saved);
  });

  it("저장된 위치가 화면 밖이면 기본 위치에 뜬다", () => {
    const h = harness({ saved: { x: 9_000, y: 9_000 }, cursor: RIGHT });
    const w = createPillWindow(h.host);
    w.show(view);
    expect(h.wins[0].bounds).toEqual(pillBounds(pillDefaultPosition(RIGHT), false));
  });

  it("저장값이 없으면 기본 위치를 녹음이 끝날 때까지 유지한다", () => {
    const h = harness({ cursor: LEFT });
    const w = createPillWindow(h.host);
    w.show(view);
    w.hide();
    h.env.cursor = RIGHT;
    w.show(view);
    expect(h.wins).toHaveLength(2);
    expect(h.wins[1].bounds).toEqual(pillBounds(pillDefaultPosition(LEFT), false));
    expect(w.anchor()).toEqual(pillDefaultPosition(LEFT));
    expect(h.saves).toEqual([]);
  });

  it("forget 뒤에는 다시 계산한다", () => {
    const h = harness({ cursor: LEFT });
    const w = createPillWindow(h.host);
    w.show(view);
    w.hide();
    w.forget();
    expect(w.anchor()).toBeNull();
    h.env.cursor = RIGHT;
    w.show(view);
    expect(h.wins[1].bounds).toEqual(pillBounds(pillDefaultPosition(RIGHT), false));
  });

  it("뜬 적이 없으면 anchor는 null이다", () => {
    expect(createPillWindow(harness().host).anchor()).toBeNull();
  });

  it("카드에서 돌아올 때 쓰는 자리도 화면에 맞아야 한다", () => {
    const h = harness({ cursor: RIGHT });
    const w = createPillWindow(h.host);
    w.show(view);
    w.hide();
    h.env.areas = [LEFT];
    h.env.cursor = LEFT;
    w.show(view);
    expect(h.wins[1].bounds).toEqual(pillBounds(pillDefaultPosition(LEFT), false));
  });

  it("로드가 끝나면 그리고 묻기 시작한다", async () => {
    const h = harness();
    const { win } = await opened(h);
    expect(win.scripts).toEqual([render(view)]);
    expect(win.waiters).toHaveLength(1);
  });

  it("떠 있는 창에 새 view를 show하면 다시 그리고 자리는 그대로다", async () => {
    const h = harness();
    const { w, win } = await opened(h);
    const next: PillView = { ...view, token: 8 };
    w.show(next);
    expect(h.wins).toHaveLength(1);
    expect(win.scripts).toEqual([render(view), render(next)]);
    expect(win.moves).toEqual([]);
  });

  it("같은 view의 show는 다시 그리지 않는다", async () => {
    const h = harness();
    const { w, win } = await opened(h);
    w.show({ ...view });
    expect(win.scripts).toEqual([render(view)]);
  });

  it("stopRetry가 바뀌면 같은 녹음이어도 다시 그려 중지를 푼다", async () => {
    const h = harness();
    const { w, win } = await opened(h);
    const retry: PillView = { ...view, stopRetry: 1 };
    w.show(retry);
    expect(win.scripts).toEqual([render(view), render(retry)]);
    expect(win.moves).toEqual([]);
  });

  it("호버는 오른쪽 끝을 고정해 크기를 바꾼다", async () => {
    const saved = { x: 500, y: 300 };
    const h = harness({ saved });
    const { win } = await opened(h);
    const right = saved.x + PILL_COMPACT.width;

    h.send(win, { token: 7, ui: "hover", on: true });
    await tick();
    expect(win.bounds).toEqual({ x: right - PILL_HOVER.width, y: 300, ...PILL_HOVER });

    h.send(win, { token: 7, ui: "hover", on: false });
    await tick();
    expect(win.bounds).toEqual({ x: 500, y: 300, ...PILL_COMPACT });
  });

  it("drag는 호버 크기여도 왼쪽 위를 어긋나게 하지 않는다", async () => {
    const saved = { x: 500, y: 300 };
    const h = harness({ saved });
    const { win } = await opened(h);
    h.send(win, { token: 7, ui: "hover", on: true });
    h.send(win, { token: 7, ui: "drag", dx: 10, dy: 20 });
    h.send(win, { token: 7, ui: "drag", dx: 5, dy: -5 });
    await tick();
    expect(win.bounds).toEqual(pillBounds({ x: 515, y: 315 }, true));
    expect(h.saves).toEqual([]);
  });

  it("drag 중의 호버 사건은 창을 옛 자리로 되돌리지 않는다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { win } = await opened(h);
    h.send(win, { token: 7, ui: "drag", dx: 40, dy: 0 });
    h.send(win, { token: 7, ui: "hover", on: true });
    await tick();
    expect(win.bounds).toEqual(pillBounds({ x: 540, y: 300 }, true));
  });

  it("drop은 안으로 밀어 넣고 저장한다", async () => {
    const h = harness({ saved: { x: 500, y: 300 }, areas: [LEFT] });
    const { w, win } = await opened(h);
    h.send(win, { token: 7, ui: "hover", on: true });
    h.send(win, { token: 7, ui: "drag", dx: 5_000, dy: 0 });
    h.send(win, { token: 7, ui: "drop" });
    await tick();
    const clamped = pillClamp({ x: 5_500, y: 300 }, [LEFT]);
    expect(win.bounds).toEqual(pillBounds(clamped, true));
    expect(h.saves).toEqual([clamped]);
    expect(w.anchor()).toEqual(clamped);
  });

  it("drag·호버·drop은 다시 그리지 않는다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { w, win } = await opened(h);
    h.send(win, { token: 7, ui: "hover", on: true });
    h.send(win, { token: 7, ui: "drag", dx: 1, dy: 1 });
    h.send(win, { token: 7, ui: "drop" });
    await tick();
    w.refit();
    expect(win.scripts).toEqual([render(view)]);
  });

  it("닫힌 뒤 도착한 drag·drop은 저장하지 않는다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { w, win } = await opened(h);
    const position = w.anchor();
    w.hide();
    h.send(win, { token: 7, ui: "drag", dx: 10, dy: 10 });
    h.send(win, { token: 7, ui: "drop" });
    await tick();
    expect(win.moves).toEqual([]);
    expect(h.saves).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(w.anchor()).toEqual(position);
  });

  it("창이 스스로 닫혀도 늦은 답을 받지 않는다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { win } = await opened(h);
    win.destroyed = true;
    win.closed[0]();
    h.send(win, { token: 7, action: "stop" });
    await tick();
    expect(h.actions).toEqual([]);
  });

  it("낡은 token의 답은 무시한다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { win } = await opened(h);
    h.send(win, { token: 6, ui: "drag", dx: 10, dy: 10 });
    h.send(win, { token: 6, ui: "drop" });
    h.send(win, { token: 6, ui: "hover", on: true });
    h.send(win, { token: 6, action: "stop" });
    await tick();
    expect(win.moves).toEqual([]);
    expect(h.saves).toEqual([]);
    expect(h.actions).toEqual([]);
  });

  it("모르는 모양은 로그만 남기고 다음 답을 받는다", async () => {
    const h = harness();
    const { win } = await opened(h);
    h.send(win, { token: 7, ui: "drag", dx: "1", dy: 1 });
    h.send(win, { token: 7, action: "open" });
    await tick();
    expect(h.logs.filter((l) => l.includes("알 수 없는"))).toHaveLength(1);
    expect(h.actions).toEqual([[7, "open"]]);
  });

  it("호버는 창이 새로 뜨면 풀린다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { w, win } = await opened(h);
    h.send(win, { token: 7, ui: "hover", on: true });
    await tick();
    w.hide();
    w.show(view);
    h.wins[1].loads[0]();
    await tick();
    h.send(h.wins[1], { token: 7, ui: "drag", dx: 10, dy: 0 });
    await tick();
    expect(h.wins[1].bounds).toEqual(pillBounds({ x: 510, y: 300 }, false));
  });

  it("refit은 화면 안의 알약을 건드리지 않는다", async () => {
    const h = harness({ saved: { x: 500, y: 300 } });
    const { w, win } = await opened(h);
    h.env.cursor = RIGHT;
    w.refit();
    expect(win.moves).toEqual([]);
  });

  it("refit은 호버 중에도 화면 밖 알약을 기본 위치로 옮긴다", async () => {
    const saved = { x: 2_000, y: 300 };
    const h = harness({ saved });
    const { w, win } = await opened(h);
    h.send(win, { token: 7, ui: "hover", on: true });
    await tick();
    h.env.areas = [LEFT];
    h.env.cursor = LEFT;
    w.refit();
    const fallback = pillDefaultPosition(LEFT);
    expect(win.bounds).toEqual(pillBounds(fallback, true));
    expect(w.anchor()).toEqual(fallback);
    expect(h.saves).toEqual([]);
  });

  it("refit은 창이 없을 때 위치만 고치고, 시작 전에는 아무것도 하지 않는다", () => {
    const h = harness({ cursor: RIGHT });
    const w = createPillWindow(h.host);
    w.refit();
    expect(w.anchor()).toBeNull();
    w.show(view);
    w.hide();
    h.env.areas = [LEFT];
    h.env.cursor = LEFT;
    w.refit();
    expect(w.anchor()).toEqual(pillDefaultPosition(LEFT));
  });

  it("stop과 open은 token과 함께 onAction으로 간다", async () => {
    const h = harness();
    const { win } = await opened(h);
    h.send(win, { token: 7, action: "stop" });
    h.send(win, { token: 7, action: "open" });
    await tick();
    expect(h.actions).toEqual([
      [7, "stop"],
      [7, "open"],
    ]);
  });
});
