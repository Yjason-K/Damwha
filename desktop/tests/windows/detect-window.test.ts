import { describe, expect, it } from "vitest";
import type { CardView } from "../../src/app/meeting-detection";
import { DESKTOP_KEYS, t } from "../../src/i18n/dictionary";
import type { UiLanguage } from "../../src/i18n/locale";
import { ASK_RETRY_LIMIT, createDetectWindow, type DetectWindowHost } from "../../src/windows/detect-window";
import {
  cardViewModel,
  DETECT_ASK_SCRIPT,
  detectCardBounds,
  detectRenderCall,
  type DetectAnswer,
} from "../../src/windows/detect-view";

const prompt: CardView = { kind: "prompt", token: 1 };
const finished = (variant: Extract<CardView, { kind: "finished" }>["variant"]): CardView => ({
  kind: "finished",
  token: 3,
  variant,
  meetingId: variant === "done" ? "mtg_1" : null,
});

describe("detectCardBounds", () => {
  it("표시 영역의 위쪽 가운데다", () => {
    expect(detectCardBounds({ x: 0, y: 0, width: 1440 }, { width: 360, height: 112 })).toEqual({
      x: 540,
      y: 12,
      width: 360,
      height: 112,
    });
  });

  it("보조 모니터 원점을 더한다", () => {
    expect(detectCardBounds({ x: 1440, y: -200, width: 1920 }, { width: 360, height: 112 })).toEqual({
      x: 1440 + 780,
      y: -200 + 12,
      width: 360,
      height: 112,
    });
  });
});

describe("cardViewModel", () => {
  it("prompt: 질문과 녹음 시작(primary)·닫기", () => {
    expect(cardViewModel(prompt, "ko")).toEqual({
      title: "회의를 기록할까요?",
      detail: "녹음은 이 Mac에만 저장돼요",
      buttons: [
        { label: "녹음 시작", action: "start", primary: true },
        { label: "닫기", action: "dismiss", primary: false },
      ],
    });
  });

  it("recording: 중지 버튼, micOnly면 마이크만 녹음 중", () => {
    const both = cardViewModel({ kind: "recording", token: 2, micOnly: false }, "ko");
    expect(both.title).toBe("녹음 중");
    expect(both.buttons).toEqual([{ label: "중지", action: "stop", primary: false }]);
    expect(cardViewModel({ kind: "recording", token: 2, micOnly: true }, "ko").title).toBe("마이크만 녹음 중");
  });

  it("finished: 변형마다 문구와 버튼이 정해져 있다", () => {
    const open = [{ label: "회의 보기", action: "open", primary: true }];
    expect(cardViewModel(finished("done"), "ko")).toMatchObject({ title: "녹음을 마쳤어요", buttons: open });
    expect(cardViewModel(finished("interrupted"), "ko")).toMatchObject({
      title: "녹음이 중단됐어요",
      detail: "지금까지 녹음된 내용은 남아 있어요",
      buttons: open,
    });
    expect(cardViewModel(finished("empty"), "ko")).toMatchObject({ title: "녹음된 내용이 없어요", buttons: [] });
    expect(cardViewModel(finished("lost"), "ko")).toMatchObject({
      title: "녹음이 끊겼어요",
      detail: "담화에서 회의를 확인해 주세요",
      buttons: [],
    });
    expect(cardViewModel(finished("startFailed"), "ko")).toMatchObject({
      title: "녹음을 시작하지 못했어요",
      buttons: [],
    });
  });

  it("en 사전에도 같은 키가 있다", () => {
    const keys = DESKTOP_KEYS.filter((k) => k.startsWith("detect."));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      expect(t("en", k)).not.toBe("");
      expect(t("en", k)).not.toBe(t("ko", k));
    }
    expect(cardViewModel(prompt, "en").title).toBe(t("en", "detect.prompt.title"));
  });
});

interface FakeWin {
  destroyed: boolean;
  loads: Array<() => void>;
  scripts: string[];
  asks: number;
}

function harness(opts: { runRejects?: unknown; answers?: unknown[] } = {}) {
  const wins: FakeWin[] = [];
  const logs: string[] = [];
  const actions: DetectAnswer[] = [];
  const answers = [...(opts.answers ?? [])];
  const host: DetectWindowHost<FakeWin> = {
    create: () => {
      const w: FakeWin = { destroyed: false, loads: [], scripts: [], asks: 0 };
      wins.push(w);
      return w;
    },
    alive: (w) => !w.destroyed,
    close: (w) => {
      w.destroyed = true;
    },
    onLoad: (w, l) => w.loads.push(l),
    onClosed: () => undefined,
    run: (w, script) => {
      if (script === DETECT_ASK_SCRIPT) {
        w.asks += 1;
        if (opts.runRejects !== undefined) return Promise.reject(opts.runRejects);
        return Promise.resolve(answers.length > 0 ? answers.shift() : null);
      }
      w.scripts.push(script);
      return Promise.resolve(undefined);
    },
    lang: (): UiLanguage => "ko",
    onAction: (a) => void actions.push(a),
    log: (l) => void logs.push(l),
  };
  return { host, wins, logs, actions, answers };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createDetectWindow", () => {
  it("show는 창을 만들고 로드가 끝나면 view를 그린 뒤 묻기 시작한다", async () => {
    const h = harness();
    const w = createDetectWindow(h.host);
    w.show(prompt);
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].scripts).toEqual([]);
    h.wins[0].loads[0]();
    await tick();
    expect(h.wins[0].scripts).toEqual([detectRenderCall(prompt, cardViewModel(prompt, "ko"))]);
    expect(h.wins[0].asks).toBe(1);
  });

  it("떠 있는 창에 show하면 새 창 없이 다시 그린다", async () => {
    const h = harness();
    const w = createDetectWindow(h.host);
    w.show(prompt);
    h.wins[0].loads[0]();
    await tick();
    const rec: CardView = { kind: "recording", token: 2, micOnly: false };
    w.show(rec);
    expect(h.wins).toHaveLength(1);
    expect(h.wins[0].scripts.at(-1)).toBe(detectRenderCall(rec, cardViewModel(rec, "ko")));
  });

  it("답 { token, action }을 onAction으로 넘기고 모르는 모양은 버린다", async () => {
    const h = harness({ answers: [{ token: 1, action: "start" }, { token: 1, action: "rm -rf" }, "x", { token: "1", action: "stop" }, { token: 1, action: "dismiss" }] });
    const w = createDetectWindow(h.host);
    w.show(prompt);
    h.wins[0].loads[0]();
    await tick();
    await tick();
    expect(h.actions).toEqual([
      { token: 1, action: "start" },
      { token: 1, action: "dismiss" },
    ]);
    expect(h.logs.filter((l) => l.includes("알 수 없는"))).toHaveLength(3);
  });

  it("페이지가 새로 로드되면 낡은 세대의 답을 버리고 현재 view를 다시 그린다", async () => {
    const h = harness();
    let release: (v: unknown) => void = () => undefined;
    const run = h.host.run;
    let first = true;
    h.host.run = (win, script) => {
      if (script === DETECT_ASK_SCRIPT && first) {
        first = false;
        win.asks += 1;
        return new Promise((r) => (release = r));
      }
      return run(win, script);
    };
    const w = createDetectWindow(h.host);
    w.show(prompt);
    h.wins[0].loads[0]();
    await tick();
    const rec: CardView = { kind: "recording", token: 2, micOnly: true };
    w.show(rec);
    h.wins[0].loads[0](); // ⌘R — 같은 리스너가 다시 불린다
    await tick();
    expect(h.wins[0].scripts.at(-1)).toBe(detectRenderCall(rec, cardViewModel(rec, "ko")));
    release({ token: 1, action: "start" });
    await tick();
    expect(h.actions).toEqual([]);
  });

  it("hide는 창을 닫고 이후 답을 버린다. 다시 show하면 새 창이다", async () => {
    const h = harness();
    const w = createDetectWindow(h.host);
    w.show(prompt);
    h.wins[0].loads[0]();
    await tick();
    w.hide();
    expect(h.wins[0].destroyed).toBe(true);
    w.show(prompt);
    expect(h.wins).toHaveLength(2);
    w.dispose();
    expect(h.wins[1].destroyed).toBe(true);
  });

  it(`묻기가 ${ASK_RETRY_LIMIT}번 연달아 거부되면 멈춘다`, async () => {
    const h = harness({ runRejects: new Error("busy") });
    const w = createDetectWindow(h.host);
    w.show(prompt);
    h.wins[0].loads[0]();
    for (let i = 0; i < 6; i++) await tick();
    expect(h.wins[0].asks).toBe(ASK_RETRY_LIMIT);
  });
});
