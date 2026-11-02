import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askSnapshot,
  createDetectionControl,
  createRendererCalls,
  createWatchLoop,
  FINISH_TIMEOUT_MS,
} from "../../src/app/detection-host";
import type { RecordingSnapshot, SuspendReason } from "../../src/app/meeting-detection";
import type { MicWatchEvent } from "../../src/process/mic-watch";

const SNAPSHOT: RecordingSnapshot = {
  phase: "recording",
  meetingId: "m1",
  failed: false,
  systemAudioLost: false,
  micSwitched: false,
  end: null,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("askSnapshot", () => {
  it("답하면 그 스냅숏이다", async () => {
    await expect(askSnapshot(() => Promise.resolve(SNAPSHOT), 3_000)).resolves.toEqual(SNAPSHOT);
  });

  it("거부는 gone이다", async () => {
    await expect(askSnapshot(() => Promise.reject(new Error("no bridge")), 3_000)).resolves.toBe("gone");
  });

  it("동기로 던져도 gone이다", async () => {
    const call = () => {
      throw new Error("파괴된 webContents");
    };
    await expect(askSnapshot(call, 3_000)).resolves.toBe("gone");
  });

  it("스냅숏 모양이 아니면 gone이다", async () => {
    await expect(askSnapshot(() => Promise.resolve(undefined), 3_000)).resolves.toBe("gone");
  });

  it("상한을 넘기면 timeout이다", async () => {
    const pending = askSnapshot(() => new Promise(() => undefined), 3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe("timeout");
  });
});

/** 시계를 손으로 돌리는 헬퍼 대역. `spawned[i].emit`이 i번째 헬퍼의 이벤트다. */
function harness() {
  const spawned: { emit: (e: MicWatchEvent) => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const events: MicWatchEvent[] = [];
  const log = vi.fn();
  const start = vi.fn((onEvent: (e: MicWatchEvent) => void) => {
    const stop = vi.fn();
    spawned.push({ emit: onEvent, stop });
    return { stop };
  });
  const loop = createWatchLoop({
    start,
    onEvent: (e) => events.push(e),
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    log,
  });
  const fireLast = () => {
    const t = timers[timers.length - 1];
    expect(t.cancelled).toBe(false);
    t.fn();
  };
  return { spawned, timers, events, log, start, loop, fireLast };
}

const SNAP: MicWatchEvent = { kind: "snapshot", input: [] };

describe("createWatchLoop", () => {
  it("헬퍼 exit 뒤 백오프로 재기동한다", () => {
    const h = harness();
    h.loop.start();
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      h.spawned[i].emit({ kind: "exit" });
      waits.push(h.timers[i].ms);
      h.fireLast();
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(h.start).toHaveBeenCalledTimes(9);
  });

  it("exit도 상태 기계에 넘긴다 — 그것이 불명을 만든다", () => {
    const h = harness();
    h.loop.start();
    h.spawned[0].emit({ kind: "error", detail: "조회 실패" });
    h.spawned[0].emit({ kind: "exit" });
    expect(h.events).toEqual([{ kind: "error", detail: "조회 실패" }, { kind: "exit" }]);
  });

  it("stop 뒤에는 재기동하지 않는다", () => {
    const h = harness();
    h.loop.start();
    h.loop.stop();
    expect(h.spawned[0].stop).toHaveBeenCalledTimes(1);
    h.spawned[0].emit({ kind: "exit" });
    expect(h.timers).toHaveLength(0);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("stop은 기다리던 재기동 타이머도 걷는다", () => {
    const h = harness();
    h.loop.start();
    h.spawned[0].emit({ kind: "exit" });
    h.loop.stop();
    expect(h.timers[0].cancelled).toBe(true);
  });

  it("스냅숏을 받으면 백오프를 되돌린다", () => {
    const h = harness();
    h.loop.start();
    h.spawned[0].emit({ kind: "exit" });
    h.fireLast();
    h.spawned[1].emit({ kind: "exit" });
    expect(h.timers[1].ms).toBe(2_000);
    h.fireLast();
    h.spawned[2].emit(SNAP);
    h.spawned[2].emit({ kind: "exit" });
    expect(h.timers[2].ms).toBe(1_000);
  });

  it("start를 겹쳐 불러도 헬퍼는 하나다", () => {
    const h = harness();
    h.loop.start();
    h.loop.start();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("헬퍼를 띄우다 던지면 exit처럼 백오프로 다시 시도한다", () => {
    const h = harness();
    h.start.mockImplementationOnce(() => {
      throw new Error("EPERM");
    });
    h.loop.start();
    expect(h.events).toEqual([{ kind: "exit" }]);
    expect(h.timers[0].ms).toBe(1_000);
  });

  it("restart는 헬퍼를 갈아 전체 스냅숏을 다시 받는다", () => {
    const h = harness();
    h.loop.start();
    h.loop.restart();
    expect(h.spawned[0].stop).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("restart로 밀려난 헬퍼의 늦은 이벤트는 버린다", () => {
    const h = harness();
    h.loop.start();
    h.loop.restart();
    h.spawned[0].emit(SNAP);
    h.spawned[0].emit({ kind: "exit" });
    expect(h.events).toEqual([]);
    expect(h.timers).toHaveLength(0);
  });

  it("restart는 기다리던 재기동 타이머를 대신한다", () => {
    const h = harness();
    h.loop.start();
    h.spawned[0].emit({ kind: "exit" });
    h.loop.restart();
    expect(h.timers[0].cancelled).toBe(true);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("꺼져 있으면 restart는 아무것도 띄우지 않는다", () => {
    const h = harness();
    h.loop.restart();
    h.loop.start();
    h.loop.stop();
    h.loop.restart();
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});

function controlHarness() {
  const detection = {
    suspend: vi.fn<(r: SuspendReason) => void>(),
    resume: vi.fn<(r: SuspendReason) => void>(),
    setEnabled: vi.fn<(on: boolean) => void>(),
    dispose: vi.fn<() => void>(),
  };
  const loop = { start: vi.fn(), stop: vi.fn(), restart: vi.fn() };
  return { detection, loop, control: createDetectionControl({ detection, loop }) };
}

describe("createDetectionControl", () => {
  it("마지막 사유가 풀리면 헬퍼를 갈아 전체 스냅숏을 받는다", () => {
    const { detection, loop, control } = controlHarness();
    control.suspend("quit");
    expect(detection.suspend).toHaveBeenCalledWith("quit");
    control.resume("quit");
    expect(detection.resume).toHaveBeenCalledWith("quit");
    expect(loop.restart).toHaveBeenCalledTimes(1);
  });

  it("상태 기계가 먼저 풀린 뒤에 재기동한다 — 거꾸로면 스냅숏을 버린다", () => {
    const { detection, loop, control } = controlHarness();
    control.suspend("sleep");
    control.resume("sleep");
    expect(detection.resume.mock.invocationCallOrder[0]).toBeLessThan(loop.restart.mock.invocationCallOrder[0]);
  });

  it("다른 사유가 남아 있으면 재기동하지 않는다", () => {
    const { loop, control } = controlHarness();
    control.suspend("sleep");
    control.suspend("close");
    control.resume("close");
    expect(loop.restart).not.toHaveBeenCalled();
    control.resume("sleep");
    expect(loop.restart).toHaveBeenCalledTimes(1);
  });

  it("걸린 적 없는 사유의 resume은 재기동하지 않는다", () => {
    const { loop, control } = controlHarness();
    control.resume("sleep");
    expect(loop.restart).not.toHaveBeenCalled();
  });

  it("켜면 감시를 띄우고 끄면 멈춘다", () => {
    const { detection, loop, control } = controlHarness();
    control.setEnabled(false);
    expect(detection.setEnabled).toHaveBeenLastCalledWith(false);
    expect(loop.stop).toHaveBeenCalledTimes(1);
    control.setEnabled(true);
    expect(detection.setEnabled).toHaveBeenLastCalledWith(true);
    expect(loop.start).toHaveBeenCalledTimes(1);
  });

  it("dispose는 상태 기계와 감시를 함께 끝낸다", () => {
    const { detection, loop, control } = controlHarness();
    control.dispose();
    expect(detection.dispose).toHaveBeenCalledTimes(1);
    expect(loop.stop).toHaveBeenCalledTimes(1);
  });

  it("dispose 뒤의 메뉴 토글은 헬퍼를 되살리지 않는다", () => {
    const { loop, control } = controlHarness();
    control.dispose();
    control.setEnabled(true);
    expect(loop.start).not.toHaveBeenCalled();
  });
});

function callsHarness(run: (script: string, gesture?: boolean) => Promise<unknown> = () => Promise.resolve()) {
  const log = vi.fn();
  const reveal = vi.fn();
  const stopRecording = vi.fn(() => Promise.resolve({ stopped: true }));
  const runSpy = vi.fn(run);
  const calls = createRendererCalls({
    run: runSpy,
    stopRecording,
    reveal,
    askTimeoutMs: 3_000,
    handshakeTimeoutMs: 90_000,
    log,
  });
  return { calls, log, reveal, stopRecording, run: runSpy };
}

const never = () => new Promise<unknown>(() => undefined);

describe("createRendererCalls", () => {
  it("start는 사용자 제스처로 부르고 main에서 상한을 걸지 않는다", async () => {
    let answer: (v: unknown) => void = () => undefined;
    const h = callsHarness(() => new Promise((r) => (answer = r)));
    const pending = h.calls.start();
    await vi.advanceTimersByTimeAsync(600_000);
    answer({ started: true, meetingId: "m1" });
    await expect(pending).resolves.toEqual({ started: true, meetingId: "m1" });
    expect(h.run.mock.calls[0][0]).toContain("startDetectedRecording");
    expect(h.run.mock.calls[0][1]).toBe(true);
  });

  it("snapshot은 묻기 상한을 쓴다", async () => {
    const h = callsHarness(never);
    const pending = h.calls.snapshot();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe("timeout");
    expect(h.run.mock.calls[0][0]).toContain("recordingStatus");
  });

  it("cancelStart는 상한을 넘기면 로그를 남기고 끝난다", async () => {
    const h = callsHarness(never);
    const pending = h.calls.cancelStart();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBeUndefined();
    expect(h.run.mock.calls[0][0]).toContain("cancelDetectedRecording");
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("finish는 75초 상한을 넘기면 거부한다 — 그것이 상태 기계의 출구다", async () => {
    expect(FINISH_TIMEOUT_MS).toBe(75_000);
    const h = callsHarness(never);
    let settled: unknown = "pending";
    const pending = h.calls.finish().catch((e: unknown) => {
      settled = e;
    });
    await vi.advanceTimersByTimeAsync(74_999);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBeInstanceOf(Error);
    expect(h.run.mock.calls[0][0]).toContain("finishRecording");
  });

  it("finish는 끝나면 타이머 없이 풀린다", async () => {
    const h = callsHarness();
    await expect(h.calls.finish()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finish의 거부는 그대로 거부다", async () => {
    const h = callsHarness(() => Promise.reject(new Error("no bridge")));
    await expect(h.calls.finish()).rejects.toThrow("no bridge");
  });

  it("stop은 핸드셰이크를 타고 실패를 적되 던지지 않는다", async () => {
    const h = callsHarness();
    h.stopRecording.mockResolvedValueOnce({ stopped: false, reason: "no-bridge" } as never);
    await expect(h.calls.stop()).resolves.toBeDefined();
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("stop은 핸드셰이크 상한을 넘기면 끝난다", async () => {
    const h = callsHarness();
    h.stopRecording.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = h.calls.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(pending).resolves.toEqual({ kind: "timeout" });
  });

  it("open은 창을 앞으로 가져온 뒤 회의를 연다", async () => {
    const h = callsHarness();
    h.calls.open('m"1');
    expect(h.reveal.mock.invocationCallOrder[0]).toBeLessThan(h.run.mock.invocationCallOrder[0]);
    expect(h.run.mock.calls[0][0]).toContain("openMeeting");
    expect(h.run.mock.calls[0][0]).toContain(JSON.stringify('m"1'));
  });

  it("open의 실패는 로그로 끝난다", async () => {
    const h = callsHarness(() => Promise.reject(new Error("창이 없어요")));
    h.calls.open("m1");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.log).toHaveBeenCalledTimes(1);
  });
});
