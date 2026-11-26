import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { SR } from "./pcm-convert";
import type { WorkletCommand, WorkletEvent } from "./pcm-worklet-protocol";
import {
  LiveCaptureCancelled,
  MIC_OPEN_TIMEOUT_MS,
  SYSTEM_AUDIO_OPEN_TIMEOUT_MS,
} from "./live-recorder";
import {
  awaitLiveStart,
  cancelLivePreparation,
  clearLiveCapture,
  isLiveStarting,
  LiveCaptureBusy,
  prepareLiveRecorder,
} from "./live-session";
import { CREATE_MEETING_TIMEOUT_MS, startLiveRecording } from "./start-live";
import { SystemAudioUnavailable } from "./system-audio";

/**
 * 시작 흐름(준비 → 생성 → 붙이기)의 순서·예약·취소만 본다. 가짜 마이크·Worklet은
 * live-session.test.tsx와 같은 수준이고, 레코더 자신의 동작은 live-recorder.test.ts가 덮는다.
 */

function stubMic() {
  const stopTrack = vi.fn();
  let endedCallback: (() => void) | null = null;
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
    getAudioTracks: () => [
      {
        addEventListener: (_event: string, cb: () => void) => {
          endedCallback = cb;
        },
      },
    ],
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });

  const posted: WorkletCommand[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent<WorkletEvent>) => void) | null,
    postMessage(message: WorkletCommand) {
      posted.push(message);
      if (message.type === "begin") emit({ type: "begun" });
      if (message.type === "flush") emit({ type: "flushed" });
    },
  };
  const emit = (event: WorkletEvent) =>
    port.onmessage?.({ data: event } as MessageEvent<WorkletEvent>);

  class FakeAudioContext {
    sampleRate = SR;
    destination = {};
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    createGain = vi
      .fn()
      .mockReturnValue({ gain: { value: 1 }, connect: vi.fn() });
    close = vi.fn().mockResolvedValue(undefined);
    resume = vi.fn(async () => emit({ type: "ready" }));
  }
  class FakeAudioWorkletNode {
    port = port;
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  return { stopTrack, posted, endDevice: () => endedCallback?.() };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** getUserMedia 응답을 손으로 쥔다 — 준비 도중의 상태를 만들기 위해서다. */
function holdMic() {
  const mic = stubMic();
  const stream = {
    getTracks: () => [{ stop: mic.stopTrack }],
    getAudioTracks: () => [{ addEventListener: () => undefined }],
  };
  const gum = deferred<typeof stream>();
  (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockReturnValue(gum.promise);
  return { ...mic, release: () => gum.resolve(stream) };
}

describe("startLiveRecording", () => {
  afterEach(async () => {
    await awaitLiveStart();
    clearLiveCapture("m1");
    await cancelLivePreparation();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("준비 실패면 createMeeting을 부르지 않는다", async () => {
    stubMic();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockRejectedValue(new Error("Permission denied"));
    const createMeeting = vi.fn();
    await expect(startLiveRecording({ createMeeting })).rejects.toThrow(
      "Permission denied",
    );
    expect(createMeeting).not.toHaveBeenCalled();
    expect(isLiveStarting()).toBe(false);
  });

  it("createMeeting 실패면 예약을 놓고 다시 던진다", async () => {
    const mic = stubMic();
    const boom = new Error("409");
    await expect(
      startLiveRecording({ createMeeting: () => Promise.reject(boom) }),
    ).rejects.toBe(boom);
    expect(isLiveStarting()).toBe(false);
    expect(mic.stopTrack).toHaveBeenCalled();
    // 예약이 풀렸으니 다음 시작이 막히지 않는다.
    await expect(
      startLiveRecording({ createMeeting: async () => ({ id: "m1" }) }),
    ).resolves.toBe("m1");
  });

  it("시작 중 두 번째 호출은 LiveCaptureBusy다", async () => {
    const mic = holdMic();
    const first = startLiveRecording({
      createMeeting: async () => ({ id: "m1" }),
    });
    await expect(
      startLiveRecording({ createMeeting: async () => ({ id: "m2" }) }),
    ).rejects.toBeInstanceOf(LiveCaptureBusy);
    mic.release();
    await expect(first).resolves.toBe("m1");
  });

  it("시작 중 isLiveStarting은 참이고 끝나면 거짓이다", async () => {
    const mic = holdMic();
    expect(isLiveStarting()).toBe(false);
    const run = startLiveRecording({
      createMeeting: async () => ({ id: "m1" }),
    });
    expect(isLiveStarting()).toBe(true);
    mic.release();
    await run;
    expect(isLiveStarting()).toBe(false);
  });

  it("준비만 된 active가 있으면 LiveCaptureBusy다", async () => {
    stubMic();
    await prepareLiveRecorder();
    const createMeeting = vi.fn();
    await expect(startLiveRecording({ createMeeting })).rejects.toBeInstanceOf(
      LiveCaptureBusy,
    );
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it("준비 중 abort되면 준비가 끝난 뒤 캡처를 놓고 createMeeting을 부르지 않는다", async () => {
    const mic = holdMic();
    const ctrl = new AbortController();
    const createMeeting = vi.fn();
    const run = startLiveRecording({ createMeeting, signal: ctrl.signal });
    const settled = expect(run).rejects.toBeInstanceOf(LiveCaptureCancelled);
    ctrl.abort();
    mic.release();
    await settled;
    expect(createMeeting).not.toHaveBeenCalled();
    expect(mic.stopTrack).toHaveBeenCalled();
    expect(isLiveStarting()).toBe(false);
  });

  it("POST 중 abort되면 응답 뒤 그 회의를 0바이트 stop으로 지우고 캡처를 놓는다", async () => {
    const mic = stubMic();
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      status: 200,
      data: { outcome: "discarded" },
    });
    const ctrl = new AbortController();
    const created = deferred<{ id: string }>();
    const run = startLiveRecording({
      createMeeting: () => created.promise,
      signal: ctrl.signal,
    });
    const settled = expect(run).rejects.toBeInstanceOf(LiveCaptureCancelled);
    await vi.waitFor(() => expect(isLiveStarting()).toBe(true));
    // 준비가 끝나 POST를 기다리는 지점까지 보낸다.
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    created.resolve({ id: "m9" });
    await settled;
    expect(post).toHaveBeenCalledWith(
      "/meetings/m9/live/stop",
      expect.any(Uint8Array),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Final-Offset": "0" }),
      }),
    );
    expect(mic.stopTrack).toHaveBeenCalled();
    expect(isLiveStarting()).toBe(false);
  });

  /**
   * 회의가 붙기 전 세 단계에는 시간 제한이 없었다 (#139). 하나라도 응답하지 않으면 시작 예약이 영영 남아 새 녹음도,
   * 녹음 종료도(awaitLiveStart), 오류 화면의 새로고침도 막혔다. 제한 값은 실측에서 왔다 (2026-11-26, dev 앱 10회):
   * 마이크 ≤623ms·시스템 오디오 ≤698ms(권한 직후 첫 회 3,016ms)·생성 POST ≤72ms. 처음 쓰는 마이크는 macOS 권한 창에
   * 답할 때까지 멈춘다(실측 11분) — 30초는 그 창을 읽을 시간이고, 넘기면 답한 뒤 다시 시작하면 된다.
   */
  describe("회의가 붙기 전 단계의 시간 제한 (#139)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("제한 값은 실측에 여유를 얹은 값이다", () => {
      expect(MIC_OPEN_TIMEOUT_MS).toBe(30_000);
      expect(SYSTEM_AUDIO_OPEN_TIMEOUT_MS).toBe(10_000);
      expect(CREATE_MEETING_TIMEOUT_MS).toBe(10_000);
    });

    it("마이크가 열리지 않으면 제한에서 시작을 끝내고 예약을 푼다 — 늦게 온 스트림은 끈다", async () => {
      vi.useFakeTimers();
      const mic = holdMic();
      const createMeeting = vi.fn();
      const run = startLiveRecording({ createMeeting });
      const settled = expect(run).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(MIC_OPEN_TIMEOUT_MS - 1);
      expect(isLiveStarting()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(createMeeting).not.toHaveBeenCalled();
      expect(isLiveStarting()).toBe(false);
      // 권한 창에 늦게 답하면 스트림이 그제야 온다. 주인이 없으니 녹음 표시등을 켠 채 두지 않는다.
      mic.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(mic.stopTrack).toHaveBeenCalled();
    });

    it("시스템 오디오가 열리지 않으면 제한에서 SystemAudioUnavailable로 끝내고 마이크를 닫는다", async () => {
      vi.useFakeTimers();
      const mic = stubMic();
      const opened = deferred<ReadableStream<Uint8Array>>();
      const createMeeting = vi.fn();
      const run = startLiveRecording({
        createMeeting,
        openSystemAudio: () => opened.promise,
      });
      const settled = expect(run).rejects.toBeInstanceOf(
        SystemAudioUnavailable,
      );
      await vi.advanceTimersByTimeAsync(SYSTEM_AUDIO_OPEN_TIMEOUT_MS);
      await settled;
      expect(createMeeting).not.toHaveBeenCalled();
      expect(isLiveStarting()).toBe(false);
      expect(mic.stopTrack).toHaveBeenCalled();
      // 늦게 열린 스트림은 cancel해야 데스크톱 헬퍼가 꺼진다.
      const cancel = vi.fn().mockResolvedValue(undefined);
      opened.resolve({ cancel } as unknown as ReadableStream<Uint8Array>);
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalled();
    });

    it("회의 생성이 응답하지 않으면 제한에서 끝내고, 늦게 만들어진 회의는 0바이트 stop으로 지운다", async () => {
      vi.useFakeTimers();
      const mic = stubMic();
      const post = vi.spyOn(apiClient, "post").mockResolvedValue({
        status: 200,
        data: { outcome: "discarded" },
      });
      const created = deferred<{ id: string }>();
      const run = startLiveRecording({ createMeeting: () => created.promise });
      const settled = expect(run).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(CREATE_MEETING_TIMEOUT_MS);
      await settled;
      expect(isLiveStarting()).toBe(false);
      expect(mic.stopTrack).toHaveBeenCalled();
      created.resolve({ id: "m-late" });
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledWith(
        "/meetings/m-late/live/stop",
        expect.any(Uint8Array),
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Final-Offset": "0" }),
        }),
      );
    });

    it("마이크를 기다리는 중 abort되면 기다리지 않고 바로 끝내고 예약을 푼다", async () => {
      // 회의 감지 카드의 60초 취소가 여기로 온다. 예전에는 단계가 끝나야 abort를 봤다.
      const mic = holdMic();
      const ctrl = new AbortController();
      const run = startLiveRecording({
        createMeeting: vi.fn(),
        signal: ctrl.signal,
      });
      ctrl.abort();
      await expect(run).rejects.toBeInstanceOf(LiveCaptureCancelled);
      expect(isLiveStarting()).toBe(false);
      mic.release();
      await vi.waitFor(() => expect(mic.stopTrack).toHaveBeenCalled());
    });

    it("회의 생성을 기다리는 중 abort되면 바로 끝내고, 늦게 온 회의는 지운다", async () => {
      const mic = stubMic();
      const post = vi.spyOn(apiClient, "post").mockResolvedValue({
        status: 200,
        data: { outcome: "discarded" },
      });
      const ctrl = new AbortController();
      const created = deferred<{ id: string }>();
      const createMeeting = vi.fn(() => created.promise);
      const run = startLiveRecording({ createMeeting, signal: ctrl.signal });
      await vi.waitFor(() => expect(createMeeting).toHaveBeenCalled());
      ctrl.abort();
      await expect(run).rejects.toBeInstanceOf(LiveCaptureCancelled);
      expect(isLiveStarting()).toBe(false);
      expect(mic.stopTrack).toHaveBeenCalled();
      created.resolve({ id: "m-aborted" });
      await vi.waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          "/meetings/m-aborted/live/stop",
          expect.any(Uint8Array),
          expect.anything(),
        ),
      );
    });
  });
});
