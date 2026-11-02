import { describe, expect, it, vi } from "vitest";
import {
  createMeetingDetection,
  DETECTION_TARGETS,
  type CardView,
  type DetectionTarget,
  type RecordingSnapshot,
} from "../../src/app/meeting-detection";

const ZOOM = "us.zoom.xos";
const CHROME = "com.google.Chrome";

const idleSnap: RecordingSnapshot = { phase: "idle", meetingId: null, failed: false, systemAudioLost: false, micSwitched: false, end: null };
const recSnap: RecordingSnapshot = { ...idleSnap, phase: "recording", meetingId: "m1" };
type Snap = RecordingSnapshot | "timeout" | "gone";
type StartResult = { started: boolean; meetingId?: string; reason?: string };

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(targets: DetectionTarget[] = DETECTION_TARGETS) {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const h = {
    ready: true,
    snap: (async () => idleSnap) as () => Promise<Snap>,
    start: (async () => ({ started: true, meetingId: "m1" })) as () => Promise<StartResult>,
    snapshotCalls: 0,
  };
  const deps = {
    targets,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    ready: () => h.ready,
    show: vi.fn<(v: CardView) => void>(),
    hide: vi.fn(),
    start: vi.fn(() => h.start()),
    now: () => 1_000,
    cancelStart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
    snapshot: vi.fn(() => {
      h.snapshotCalls++;
      return h.snap();
    }),
    open: vi.fn(),
    log: vi.fn(),
  };
  const md = createMeetingDetection(deps);
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.live = false;
      next.fn();
      await flush();
    }
    now = end;
    await flush();
  }
  const input = (...ids: string[]) => md.onWatch({ kind: "snapshot", input: ids });
  const last = () => deps.show.mock.calls.at(-1)?.[0];
  const prompt = async (...ids: string[]) => {
    input(...(ids.length ? ids : [ZOOM]));
    await advance(2000);
    const v = last();
    expect(v?.kind).toBe("prompt");
    return v!.token;
  };
  const record = async (...ids: string[]) => {
    const t = await prompt(...ids);
    h.snap = async () => recSnap;
    md.onCard(t, "start");
    await advance(0);
    const v = last();
    expect(v?.kind).toBe("pill");
    return v!.token;
  };
  return { md, deps, h, advance, input, last, prompt, record };
}

describe("DETECTION_TARGETS", () => {
  it("Zoom이 Chrome보다 앞이다", () => {
    expect(DETECTION_TARGETS.map((t) => t.name)).toEqual(["Zoom", "Chrome"]);
  });
});

describe("카드 띄우기", () => {
  it("2초 지속 뒤에만 카드가 뜬다", async () => {
    const s = setup();
    s.input(ZOOM);
    await s.advance(1999);
    expect(s.deps.show).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.deps.show).toHaveBeenCalledWith({ kind: "prompt", token: expect.any(Number) });
  });

  it("2초 전에 꺼지면 안 뜬다", async () => {
    const s = setup();
    s.input(ZOOM);
    await s.advance(1000);
    s.input();
    await s.advance(10_000);
    expect(s.deps.show).not.toHaveBeenCalled();
  });

  it("목록 밖 번들은 무시한다", async () => {
    const s = setup();
    s.input("com.apple.Siri");
    await s.advance(5000);
    expect(s.deps.show).not.toHaveBeenCalled();
  });

  it("helper 번들도 접두사로 잡는다", async () => {
    const s = setup();
    s.input("com.google.Chrome.helper.Renderer");
    await s.advance(2000);
    expect(s.last()?.kind).toBe("prompt");
  });

  it("첫 스냅숏 전(불명)에는 띄우지 않는다", async () => {
    const s = setup();
    s.md.onWatch({ kind: "exit" });
    s.md.reevaluate();
    await s.advance(5000);
    expect(s.deps.show).not.toHaveBeenCalled();
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.last()?.kind).toBe("prompt");
  });

  it("snapshot이 recording이면 띄우지 않고 끝날 때 억제를 건다", async () => {
    const s = setup();
    s.h.snap = async () => recSnap;
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.deps.show).not.toHaveBeenCalled();
    s.h.snap = async () => ({ ...idleSnap, phase: "ended", end: "acked", meetingId: "m1" });
    await s.advance(2000);
    await s.advance(20_000);
    expect(s.deps.show).not.toHaveBeenCalled(); // 입력이 이어져도 억제
    s.input();
    await s.advance(60_000);
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.last()?.kind).toBe("prompt");
  });

  it("준비 안 된 동안 지난 2초는 카드를 띄우지 않고, reevaluate가 입력이 이어지면 다시 잰다", async () => {
    const s = setup();
    s.h.ready = false;
    s.input(ZOOM);
    await s.advance(5000);
    expect(s.deps.show).not.toHaveBeenCalled();
    s.h.ready = true;
    s.md.reevaluate();
    await s.advance(1999);
    expect(s.deps.show).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.last()?.kind).toBe("prompt");
  });

  it("카드 직전 snapshot 조회 중 입력이 꺼지면 띄우지 않는다", async () => {
    const s = setup();
    let resolve!: (v: Snap) => void;
    s.h.snap = () => new Promise<Snap>((r) => (resolve = r));
    s.input(ZOOM);
    await s.advance(2000);
    s.input();
    resolve(idleSnap);
    await s.advance(5000);
    expect(s.deps.show).not.toHaveBeenCalled();
  });
});

describe("닫기와 억제", () => {
  it("30초 무응답은 닫기와 같다", async () => {
    const s = setup();
    await s.prompt();
    await s.advance(29_999);
    expect(s.deps.hide).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.deps.hide).toHaveBeenCalledTimes(1);
    await s.advance(60_000);
    expect(s.deps.show).toHaveBeenCalledTimes(1); // 입력이 이어져도 다시 안 뜬다
  });

  it("닫기 뒤 입력이 60초 꺼지기 전에는 다시 안 뜬다", async () => {
    const s = setup();
    s.md.onCard(await s.prompt(), "dismiss");
    s.input();
    await s.advance(59_000);
    s.input(ZOOM);
    await s.advance(5000);
    expect(s.deps.show).toHaveBeenCalledTimes(1);
  });

  it("59초에 입력이 돌아오면 60초를 다시 잰다", async () => {
    const s = setup();
    s.md.onCard(await s.prompt(), "dismiss");
    s.input();
    await s.advance(59_000);
    s.input(ZOOM);
    await s.advance(100);
    s.input();
    await s.advance(59_000);
    s.input(ZOOM);
    await s.advance(5000);
    expect(s.deps.show).toHaveBeenCalledTimes(1);
    s.input();
    await s.advance(60_000);
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.deps.show).toHaveBeenCalledTimes(2);
  });

  it("카드 표시 중 대상은 고정, 동시 입력은 목록 앞쪽이 대상이다", async () => {
    const s = setup();
    s.md.onCard(await s.prompt(CHROME, ZOOM), "dismiss"); // Zoom이 대상 → Zoom만 억제
    await s.advance(2000);
    expect(s.deps.show).toHaveBeenCalledTimes(2); // 남은 Chrome 차례
    s.md.onCard(s.last()!.token, "dismiss");
    await s.advance(10_000);
    expect(s.deps.show).toHaveBeenCalledTimes(2);

    const t = setup();
    const token = await t.prompt(CHROME);
    t.input(CHROME, ZOOM); // 카드 중 Zoom이 붙어도 대상은 Chrome
    await t.advance(5000);
    expect(t.deps.show).toHaveBeenCalledTimes(1);
    t.md.onCard(token, "dismiss"); // Chrome 억제, Zoom은 새 카드
    await t.advance(2000);
    expect(t.deps.show).toHaveBeenCalledTimes(2);
  });
});

describe("시작", () => {
  it("시작 실패면 finished(startFailed)를 보이고 억제한다", async () => {
    const s = setup();
    s.h.start = async () => ({ started: false, reason: "denied" });
    s.md.onCard(await s.prompt(), "start");
    await s.advance(0);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "startFailed", meetingId: null });
    await s.advance(10_000);
    expect(s.deps.hide).toHaveBeenCalled();
    await s.advance(20_000);
    expect(s.deps.show).toHaveBeenCalledTimes(2);
  });

  it("busy면 카드를 닫고 external로 간다", async () => {
    const s = setup();
    s.h.start = async () => ({ started: false, reason: "busy" });
    s.md.onCard(await s.prompt(), "start");
    await s.advance(0);
    expect(s.deps.hide).toHaveBeenCalled();
    expect(s.deps.show).toHaveBeenCalledTimes(1);
    const before = s.h.snapshotCalls;
    s.h.snap = async () => recSnap;
    await s.advance(2000);
    expect(s.h.snapshotCalls).toBeGreaterThan(before); // 2초마다 지켜본다
    s.h.snap = async () => ({ ...idleSnap, phase: "ended", end: "acked", meetingId: "m1" });
    await s.advance(2000);
    await s.advance(20_000);
    expect(s.deps.show).toHaveBeenCalledTimes(1);
  });

  it("시작 60초 초과는 cancelStart를 부르고 startFailed다", async () => {
    const s = setup();
    s.h.start = () => new Promise(() => undefined);
    s.md.onCard(await s.prompt(), "start");
    await s.advance(59_999);
    expect(s.deps.cancelStart).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.deps.cancelStart).toHaveBeenCalledTimes(1);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "startFailed" });
  });

  it("초과 뒤 도착한 시작 응답은 상태를 바꾸지 않는다", async () => {
    const s = setup();
    let resolve!: (v: StartResult) => void;
    s.h.start = () => new Promise((r) => (resolve = r));
    s.md.onCard(await s.prompt(), "start");
    await s.advance(60_000);
    const shows = s.deps.show.mock.calls.length;
    resolve({ started: true, meetingId: "m1" });
    await s.advance(30_000);
    expect(s.deps.show).toHaveBeenCalledTimes(shows);
    expect(s.deps.stop).not.toHaveBeenCalled();
  });
});

describe("자동 종료", () => {
  it("모든 대상 입력이 꺼지고 10초 뒤 stop을 부른다", async () => {
    const s = setup();
    await s.record();
    s.input();
    await s.advance(9999);
    expect(s.deps.stop).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });

  it("9초에 돌아오면 멈추지 않고, 다시 꺼지면 10초를 처음부터 잰다", async () => {
    const s = setup();
    await s.record();
    s.input();
    await s.advance(9000);
    s.input(ZOOM);
    await s.advance(20_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    s.input();
    await s.advance(9999);
    expect(s.deps.stop).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });

  it("다른 대상 입력이 남아 있으면 멈추지 않는다", async () => {
    const s = setup();
    await s.record(ZOOM, CHROME);
    s.input(CHROME);
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
  });

  it("autoStop false면 멈추지 않는다", async () => {
    const s = setup([{ name: "Zoom", bundlePrefix: ZOOM, autoStop: false }]);
    await s.record();
    s.input();
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
  });

  it("exit·error면 카운트다운을 취소하고 재기동 스냅숏 뒤 재개한다", async () => {
    const s = setup();
    await s.record();
    s.input();
    await s.advance(5000);
    s.md.onWatch({ kind: "exit" });
    await s.advance(20_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    s.input();
    await s.advance(9999);
    expect(s.deps.stop).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });

  it("불명 동안 stop을 부르지 않는다", async () => {
    const s = setup();
    await s.record();
    s.md.onWatch({ kind: "error", detail: "list -1" });
    await s.advance(60_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
  });

  it("중지 버튼은 stop을 한 번 부른다", async () => {
    const s = setup();
    const t = await s.record();
    s.md.onCard(t, "stop");
    s.md.onCard(t, "stop");
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });
});

describe("suspend·resume", () => {
  it("suspend는 카운트다운을 취소하고, recording이면 녹음 표시를 유지한다", async () => {
    const s = setup();
    await s.record();
    s.input();
    await s.advance(5000);
    const hides = s.deps.hide.mock.calls.length;
    const polls = s.h.snapshotCalls;
    s.md.suspend("sleep");
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    expect(s.deps.hide).toHaveBeenCalledTimes(hides);
    expect(s.h.snapshotCalls).toBe(polls);
  });

  it("suspend는 prompting이면 카드를 닫고 start 동작을 받지 않는다", async () => {
    const s = setup();
    const t = await s.prompt();
    s.md.suspend("close");
    expect(s.deps.hide).toHaveBeenCalledTimes(1);
    s.md.onCard(t, "start");
    expect(s.deps.start).not.toHaveBeenCalled();
  });

  it("suspend는 starting이면 cancelStart를 부른다", async () => {
    const s = setup();
    let resolve!: (v: StartResult) => void;
    s.h.start = () => new Promise((r) => (resolve = r));
    s.md.onCard(await s.prompt(), "start");
    s.md.suspend("quit");
    expect(s.deps.cancelStart).toHaveBeenCalledTimes(1);
    const shows = s.deps.show.mock.calls.length;
    resolve({ started: true, meetingId: "m1" });
    await s.advance(5000);
    expect(s.deps.show).toHaveBeenCalledTimes(shows);
  });

  it("이유가 둘이면 둘 다 resume돼야 재개한다", async () => {
    const s = setup();
    s.md.suspend("quit");
    s.md.suspend("sleep");
    s.md.resume("sleep");
    s.input(ZOOM);
    await s.advance(5000);
    expect(s.deps.show).not.toHaveBeenCalled();
    s.md.resume("quit");
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.last()?.kind).toBe("prompt");
  });

  it("resume 뒤 첫 스냅숏 전에는 판단하지 않는다", async () => {
    const s = setup();
    s.input(ZOOM);
    await s.advance(1000);
    s.md.suspend("sleep");
    s.md.resume("sleep");
    await s.advance(10_000);
    expect(s.deps.show).not.toHaveBeenCalled();
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.last()?.kind).toBe("prompt");
  });
});

describe("setEnabled", () => {
  it("false는 prompting을 닫고 새 카드를 막는다", async () => {
    const s = setup();
    await s.prompt();
    s.md.setEnabled(false);
    expect(s.deps.hide).toHaveBeenCalledTimes(1);
    s.input(CHROME);
    await s.advance(5000);
    expect(s.deps.show).toHaveBeenCalledTimes(1);
  });

  it("recording은 유지하고 불명으로 가며, 다시 켜면 첫 스냅숏 뒤 자동 종료가 재개된다", async () => {
    const s = setup();
    await s.record();
    s.md.setEnabled(false);
    s.input();
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    s.md.setEnabled(true);
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    s.input();
    await s.advance(10_000);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });
});

describe("끝 카드", () => {
  const rec = async (snap: Snap) => {
    const s = setup();
    await s.record();
    s.h.snap = async () => snap;
    await s.advance(2000);
    return s;
  };
  const ended = (end: RecordingSnapshot["end"], extra: Partial<RecordingSnapshot> = {}): RecordingSnapshot => ({
    ...recSnap,
    phase: "ended",
    end,
    ...extra,
  });

  it.each([
    ["discarded→empty", ended("discarded"), "empty", null],
    ["failed 플래그는 ACK여도 interrupted", ended("acked", { failed: true }), "interrupted", "m1"],
    ["end failed→interrupted", ended("failed"), "interrupted", "m1"],
    ["acked→done", ended("acked"), "done", "m1"],
    ["sealed→done", ended("sealed"), "done", "m1"],
    ["meetingId null→lost", { ...recSnap, meetingId: null }, "lost", null],
    ["gone→lost", "gone" as const, "lost", null],
  ] as const)("%s", async (_n, snap, variant, id) => {
    const s = await rec(snap as Snap);
    expect(s.last()).toMatchObject({ kind: "finished", variant, meetingId: id });
  });

  it("timeout 3회 연속→lost", async () => {
    const s = await rec("timeout");
    expect(s.last()?.kind).toBe("pill");
    await s.advance(2000);
    expect(s.last()?.kind).toBe("pill");
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost" });
  });

  it("failed && end null이면 finish()를 한 번 부르고 end가 나올 때까지 finished로 가지 않는다", async () => {
    const s = await rec({ ...recSnap, failed: true });
    await s.advance(4000); // finish가 끝난 뒤 poll 둘 — 아직 한도 전
    expect(s.deps.finish).toHaveBeenCalledTimes(1);
    expect(s.last()?.kind).toBe("pill");
  });

  it.each([
    ["ACK", ended("acked", { failed: true }), "interrupted"],
    ["폐기", ended("discarded", { failed: true }), "empty"],
    ["거절", ended("failed", { failed: true }), "interrupted"],
  ] as const)("finish 뒤 %s", async (_n, snap, variant) => {
    const s = await rec({ ...recSnap, failed: true });
    s.h.snap = async () => snap;
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant });
  });

  it("systemAudioLost면 micOnly true로 다시 그린다", async () => {
    const s = setup();
    const t = await s.record();
    s.h.snap = async () => ({ ...recSnap, systemAudioLost: true });
    await s.advance(2000);
    expect(s.last()).toEqual({ kind: "recording", token: t, micOnly: true, micSwitched: false });
  });

  it("micSwitched면 마이크가 바뀐 카드로 다시 그린다", async () => {
    const s = setup();
    const t = await s.record();
    s.h.snap = async () => ({ ...recSnap, micSwitched: true });
    await s.advance(2000);
    expect(s.last()).toEqual({ kind: "recording", token: t, micOnly: false, micSwitched: true });
  });

  it("낡은 token의 onCard는 무시한다", async () => {
    const s = setup();
    const t = await s.prompt();
    s.md.onCard(t + 1, "start");
    s.md.onCard(t - 1, "dismiss");
    expect(s.deps.start).not.toHaveBeenCalled();
    expect(s.deps.hide).not.toHaveBeenCalled();
    s.md.onCard(t, "start");
    await s.advance(0);
    s.md.onCard(t, "stop"); // 프롬프트 token은 녹음 표시에서 낡았다
    expect(s.deps.stop).not.toHaveBeenCalled();
  });

  it("open은 finished의 meetingId로 부른다", async () => {
    const s = await rec(ended("acked"));
    s.md.onCard(s.last()!.token, "open");
    expect(s.deps.open).toHaveBeenCalledWith("m1");
    expect(s.deps.hide).toHaveBeenCalled();
  });
});

describe("리뷰 1차 수정", () => {
  it("효과 없이 끝난 stop 뒤에도 중지 버튼이 다시 stop을 부른다", async () => {
    const s = setup();
    const t = await s.record();
    s.md.onCard(t, "stop");
    await s.advance(0); // stop이 {kind:"failed"}처럼 reject 없이 끝났다
    s.md.onCard(t, "stop");
    expect(s.deps.stop).toHaveBeenCalledTimes(2);
  });

  it("stop이 진행 중이면 중지 버튼이 겹쳐 부르지 않는다", async () => {
    const s = setup();
    s.deps.stop.mockImplementationOnce(() => new Promise(() => undefined));
    const t = await s.record();
    s.md.onCard(t, "stop");
    s.md.onCard(t, "stop");
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });

  it("효과 없이 끝난 자동 종료는 입력이 여전히 꺼져 있으면 10초를 다시 잰다", async () => {
    const s = setup();
    await s.record();
    s.input();
    await s.advance(10_000);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
    await s.advance(9999);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
    await s.advance(1);
    expect(s.deps.stop).toHaveBeenCalledTimes(2);
  });

  it("finish가 reject하면 interrupted로 간다", async () => {
    const s = setup();
    s.deps.finish.mockRejectedValueOnce(new Error("x"));
    await s.record();
    s.h.snap = async () => ({ ...recSnap, failed: true });
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "interrupted", meetingId: "m1" });
  });

  it("finish가 끝난 뒤 3번째 poll에도 end가 null이면 interrupted로 간다", async () => {
    const s = setup();
    await s.record();
    s.h.snap = async () => ({ ...recSnap, failed: true });
    await s.advance(2000); // finish 호출, 아직 settle 전 poll
    await s.advance(4000);
    expect(s.last()?.kind).toBe("pill");
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "interrupted", meetingId: "m1" });
  });

  it("suspend 동안의 스냅숏은 resume 뒤 첫 스냅숏으로 치지 않는다", async () => {
    const s = setup();
    s.md.suspend("sleep");
    s.input(ZOOM);
    s.md.resume("sleep");
    s.md.reevaluate();
    await s.advance(10_000);
    expect(s.deps.show).not.toHaveBeenCalled();
    s.input(ZOOM);
    await s.advance(2000);
    expect(s.last()?.kind).toBe("prompt");
  });

  it("suspend 동안 회의가 끝나도, 새 스냅숏이 와야 카운트다운이 선다", async () => {
    const s = setup();
    await s.record();
    s.md.suspend("sleep");
    s.input();
    s.md.resume("sleep");
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    s.input();
    await s.advance(10_000);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
  });

  it("suspend 동안 억제가 만료돼도 카드가 뜨지 않는다", async () => {
    const s = setup();
    s.md.onCard(await s.prompt(), "dismiss");
    s.input();
    await s.advance(30_000);
    s.md.suspend("sleep");
    s.input(ZOOM);
    await s.advance(60_000);
    s.md.resume("sleep");
    await s.advance(10_000);
    expect(s.deps.show).toHaveBeenCalledTimes(1);
  });

  it("timeout 사이에 정상 응답이 오면 연속 횟수를 다시 센다", async () => {
    const s = setup();
    await s.record();
    s.h.snap = async () => "timeout";
    await s.advance(4000);
    s.h.snap = async () => recSnap;
    await s.advance(2000);
    s.h.snap = async () => "timeout";
    await s.advance(4000);
    expect(s.last()?.kind).toBe("pill");
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost" });
  });
});

describe("최종 리뷰 수정", () => {
  const timedOut = async () => {
    const s = setup();
    await s.record();
    s.h.snap = async () => "timeout";
    return s;
  };

  it("timeout 3회면 stop을 한 번 부르고, 끝난 뒤에 lost를 보인다", async () => {
    const s = await timedOut();
    let settle!: () => void;
    s.deps.stop.mockImplementationOnce(() => new Promise<undefined>((r) => (settle = () => r(undefined))));
    await s.advance(4000);
    expect(s.deps.stop).not.toHaveBeenCalled();
    await s.advance(2000);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
    expect(s.last()?.kind).toBe("pill");
    await s.advance(60_000); // 기다리는 동안 다시 묻지도, 다시 멈추지도 않는다
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
    settle();
    await s.advance(0);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost", meetingId: null });
  });

  it("timeout 뒤 stop이 실패해도 lost로 닫는다", async () => {
    const s = await timedOut();
    s.deps.stop.mockRejectedValueOnce(new Error("x"));
    await s.advance(6000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost" });
  });

  it("중지 버튼의 stop이 진행 중이면 timeout이 겹쳐 부르지 않고 그 끝을 기다린다", async () => {
    const s = setup();
    const t = await s.record();
    let settle!: () => void;
    s.deps.stop.mockImplementationOnce(() => new Promise<undefined>((r) => (settle = () => r(undefined))));
    s.md.onCard(t, "stop");
    s.h.snap = async () => "timeout";
    await s.advance(6000);
    expect(s.deps.stop).toHaveBeenCalledTimes(1);
    expect(s.last()?.kind).toBe("pill");
    settle();
    await s.advance(0);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost" });
  });

  it("gone은 stop을 부르지 않는다", async () => {
    const s = setup();
    await s.record();
    s.h.snap = async () => "gone";
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost" });
    expect(s.deps.stop).not.toHaveBeenCalled();
  });

  it("system_audio 시작 실패는 억제하지 않아, 끝 카드가 닫힌 뒤 입력이 이어지면 카드가 돌아온다", async () => {
    const s = setup();
    s.h.start = async () => ({ started: false, reason: "system_audio" });
    s.md.onCard(await s.prompt(), "start");
    await s.advance(0);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "startFailed" });
    await s.advance(10_000);
    expect(s.deps.hide).toHaveBeenCalled();
    await s.advance(1999);
    expect(s.deps.show).toHaveBeenCalledTimes(2);
    await s.advance(1);
    expect(s.deps.show).toHaveBeenCalledTimes(3);
    expect(s.last()?.kind).toBe("prompt");
  });

  it.each(["permission", "create_failed", "cancelled"])("%s 시작 실패는 억제한다", async (reason) => {
    const s = setup();
    s.h.start = async () => ({ started: false, reason });
    s.md.onCard(await s.prompt(), "start");
    await s.advance(30_000);
    expect(s.deps.show).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["녹음 중", { ...recSnap, meetingId: "m2" }],
    ["끝남", { ...recSnap, phase: "ended", end: "acked", meetingId: "m2" }],
  ] as const)("다른 회의 id(%s)는 카드 세션의 끝이고 그 세션을 멈추지 않는다", async (_n, snap) => {
    const s = setup();
    await s.record();
    s.input();
    s.h.snap = async () => snap;
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "lost", meetingId: null });
    await s.advance(30_000);
    expect(s.deps.stop).not.toHaveBeenCalled();
  });
});

describe("알약과 경고 카드", () => {
  const warn = { ...recSnap, micSwitched: true };

  it("녹음이 시작되면 알약을 보인다", async () => {
    const s = setup();
    const t = await s.record();
    expect(s.last()).toEqual({ kind: "pill", token: t, startedAt: 1_000 });
  });

  it("경고가 생기면 카드로 펼치고 10초 뒤 알약으로 돌아온다", async () => {
    const s = setup();
    const t = await s.record();
    s.h.snap = async () => warn;
    await s.advance(2000);
    expect(s.last()).toEqual({ kind: "recording", token: t, micOnly: false, micSwitched: true });
    await s.advance(10_000);
    expect(s.last()).toEqual({ kind: "pill", token: t, startedAt: 1_000 });
  });

  it("같은 경고는 다시 펼치지 않는다", async () => {
    const s = setup();
    await s.record();
    s.h.snap = async () => warn;
    await s.advance(2000);
    await s.advance(10_000);
    const calls = s.deps.show.mock.calls.length;
    expect(s.last()?.kind).toBe("pill");
    await s.advance(6000);
    expect(s.deps.show.mock.calls.length).toBe(calls);
  });

  it("펼친 동안 두 번째 경고가 오면 카드를 바꾸고 10초를 다시 잰다", async () => {
    const s = setup();
    const t = await s.record();
    s.h.snap = async () => warn;
    await s.advance(2000);
    await s.advance(6000); // 경고 후 6초
    s.h.snap = async () => ({ ...warn, systemAudioLost: true });
    await s.advance(2000); // 두 번째 경고, 타이머 재시작
    expect(s.last()).toEqual({ kind: "recording", token: t, micOnly: true, micSwitched: true });
    await s.advance(6000);
    expect(s.last()?.kind).toBe("recording");
    await s.advance(4000);
    expect(s.last()?.kind).toBe("pill");
  });

  it("경고 카드 중 녹음이 끝나면 복귀 타이머가 끝 카드를 덮지 않는다", async () => {
    const s = setup();
    await s.record();
    s.h.snap = async () => warn;
    await s.advance(2000);
    s.h.snap = async () => ({ ...warn, phase: "ended", end: "acked" });
    await s.advance(2000);
    expect(s.last()).toMatchObject({ kind: "finished", variant: "done" });
    await s.advance(9_000);
    expect(s.last()?.kind).not.toBe("pill");
  });

  it("recording의 open은 회의를 열고 알약을 유지한다", async () => {
    const s = setup();
    const t = await s.record();
    s.md.onCard(t, "open");
    expect(s.deps.open).toHaveBeenCalledWith("m1");
    expect(s.last()?.kind).toBe("pill");
    expect(s.deps.hide).not.toHaveBeenCalled();
  });

  it("meetingId가 없으면 open은 로그만 남긴다", async () => {
    const s = setup();
    s.h.start = async () => ({ started: true });
    const t = await s.prompt();
    s.md.onCard(t, "start");
    await s.advance(0);
    s.md.onCard(s.last()!.token, "open");
    expect(s.deps.open).not.toHaveBeenCalled();
    expect(s.deps.log).toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("이후 입력과 타이머는 아무것도 하지 않는다", async () => {
    const s = setup();
    s.input(ZOOM);
    s.md.dispose();
    await s.advance(10_000);
    expect(s.deps.show).not.toHaveBeenCalled();
  });
});
