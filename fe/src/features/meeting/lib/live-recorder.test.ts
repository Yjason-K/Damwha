import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES, CHUNK_SAMPLES, SR } from "./pcm-convert";
import type { WorkletCommand, WorkletEvent } from "./pcm-worklet-protocol";
import {
  checkCaptureSupport,
  LiveCaptureCancelled,
  LiveRecorder,
  LiveUploadRejected,
  requestCaptureDevices,
  type PostResult,
  type RecorderFailure,
} from "./live-recorder";

const chunkOf = (n = CHUNK_BYTES) => new Uint8Array(n);

/** 즉시 settle하지 않는 Promise. 네트워크가 아직 응답하지 않은 상태를 흉내낸다. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** postStop 목의 기본 모양 — 보낸 final을 그대로 확정 경계로 돌려준다. */
type StopSpy = (
  id: string,
  offset: number,
  final: number,
  body: Uint8Array,
  elapsedMs: number,
  failure: RecorderFailure | null,
) => Promise<PostResult>;

const okStop = () =>
  vi.fn<StopSpy>(async (_id, _offset, final) => ({
    status: 200 as const,
    expected: final,
  }));

describe("LiveRecorder upload loop", () => {
  it("sends one chunk at a time and advances the offset", async () => {
    const seen: number[] = [];
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      return { status: 200 as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post });
    r.enqueue(chunkOf());
    r.enqueue(chunkOf());
    await r.drain();
    expect(seen).toEqual([0, CHUNK_BYTES]);
  });

  it("never has two uploads in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const post = vi.fn(async (_id, offset: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 200 as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post });
    for (let i = 0; i < 4; i += 1) r.enqueue(chunkOf());
    await r.drain();
    expect(maxInFlight).toBe(1);
  });

  it("dequeues on a 409 whose expected is this chunk's end (a lost ACK)", async () => {
    const seen: number[] = [];
    let first = true;
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      if (first) {
        first = false;
        return { status: 409 as const, expected: CHUNK_BYTES };
      }
      return { status: 200 as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post });
    r.enqueue(chunkOf());
    await r.drain();
    // 첫 시도는 0에서 409 → 서버가 이미 받았다는 뜻이므로 그 청크를 버리고 전진한다
    expect(seen).toEqual([0]);
    expect(r.offset).toBe(CHUNK_BYTES);
  });

  it("retries a network failure without skipping the chunk", async () => {
    const seen: number[] = [];
    let calls = 0;
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      calls += 1;
      if (calls === 1) throw new Error("network");
      return { status: 200 as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post, retryDelayMs: 0 });
    r.enqueue(chunkOf());
    await r.drain();
    expect(seen).toEqual([0, 0]);
  });

  it("fails visibly when the backlog passes the limit", async () => {
    const post = vi.fn(async () => {
      throw new Error("down");
    });
    const statuses: unknown[] = [];
    const r = new LiveRecorder({
      postChunk: post,
      retryDelayMs: 0,
      bufferLimitMs: 2000,
    });
    r.onStatus = (s) => statuses.push(s);
    for (let i = 0; i < 5; i += 1) r.enqueue(chunkOf()); // 5.12초 > 2초
    await r.drain();
    expect(r.status.failed).toBe("buffer_overflow");
  });

  it("stops enqueueing once failed — the queue does not keep growing past the failure", async () => {
    const post = vi.fn(async () => {
      throw new Error("down");
    });
    const r = new LiveRecorder({
      postChunk: post,
      retryDelayMs: 0,
      bufferLimitMs: 2000, // 청크 2개(2048ms)에서 넘는다
    });
    for (let i = 0; i < 5; i += 1) r.enqueue(chunkOf());
    await r.drain();
    expect(r.status.failed).toBe("buffer_overflow");
    // 실패를 일으킨 2개 이후로는 enqueue가 조용히 버려야 한다 — 안 그러면 stop()이
    // 나중에 잘라내야 할 구멍만 계속 커진다. CHUNK_MS(1024)는 export되지 않아 리터럴로 쓴다.
    expect(r.status.backlogMs).toBe(2 * 1024);
  });

  it("carries the chunk's capture-time elapsed to postChunk instead of re-reading the clock when it is finally sent", async () => {
    // 청크1은 네트워크가 느려 오래 붙들려 있고, 그 사이 청크2가 실제로는 금방(캡처
    // 시각 기준 1024ms) 잡혀 큐에 들어간다. 청크1이 늦게 끝나 청크2가 한참 뒤(캡처
    // 기준 5000ms)에야 전송되더라도, postChunk에 실리는 값은 전송 시각이 아니라
    // 캡처 시각(1024)이어야 한다 (review finding 4).
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    const seenElapsed: number[] = [];
    const first = deferred<PostResult>();
    const post = vi.fn(
      async (
        _id: string,
        offset: number,
        _body: Uint8Array,
        elapsedMs: number,
      ) => {
        seenElapsed.push(elapsedMs);
        if (offset === 0) return first.promise;
        return { status: 200 as const, expected: offset + CHUNK_BYTES };
      },
    );
    const r = new LiveRecorder({ postChunk: post });

    // 청크1: t=0에 캡처됨. postChunk가 즉시 불리고 pending 상태로 멈춘다.
    r.enqueue(chunkOf(), 0);
    // 청크2: t=1024(실제 캡처 시각)에 잡혀 큐에 들어간다 — 아직 청크1이 안 끝났으니
    // 전송은 못 하고 큐에서 대기한다.
    clock = 1024;
    r.enqueue(chunkOf(), 1024);
    // 이제 시간이 많이 흘렀다고 하자(네트워크 백로그) — 청크1이 이제야 끝난다.
    clock = 5000;
    first.resolve({ status: 200, expected: CHUNK_BYTES });

    await r.drain();
    expect(seenElapsed).toEqual([0, 1024]);
    vi.restoreAllMocks();
  });

  // 옛 코드는 "409면 서버가 이미 받았다"로 뭉뚱그려 결손 409에서도 청크를 버리고
  // 전진했다. 그 구멍은 봉인된 뒤에야 드러나고 그때는 되돌릴 수 없다 (설계 §3.3).
  it("keeps and resends the chunk on a 409 whose expected is this chunk's start", async () => {
    const seen: number[] = [];
    let calls = 0;
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      calls += 1;
      // 서버는 아직 이 청크를 못 받았다 — 확정 경계가 우리 오프셋 그대로다.
      if (calls === 1) return { status: 409 as const, expected: offset };
      return { status: 200 as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post, retryDelayMs: 0 });
    r.enqueue(chunkOf());
    await r.drain();
    expect(seen).toEqual([0, 0]); // 같은 청크를 다시 보냈다
    expect(r.offset).toBe(CHUNK_BYTES);
    expect(r.status.failed).toBeNull();
  });

  // 우리 청크의 시작도 끝도 아닌 경계는 재동기화할 곳이 없다 — 무한 재시도로 60초를
  // 태우고 엉뚱한 이름(buffer_overflow)으로 죽는 대신 그 자리에서 끝낸다.
  it("fails as upload_failed on a 409 that matches neither boundary", async () => {
    const post = vi.fn(async () => ({
      status: 409 as const,
      expected: 12345,
    }));
    const r = new LiveRecorder({ postChunk: post, retryDelayMs: 0 });
    r.enqueue(chunkOf());
    await r.drain();
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.status.failed).toBe("upload_failed");
    expect(r.offset).toBe(0); // 오프셋이 오염되지 않았다
  });

  // 서버가 4시간 상한에서 스스로 봉인했다. 일반 ACK로 dequeue하면 그 청크가 정본에
  // 들어갔다고 착각한 채 다음 청크를 계속 보낸다 (설계 §4.2).
  it("stops on a server seal without dequeuing, and reports it apart from a capture failure", async () => {
    const post = vi.fn(async () => ({
      status: 409 as const,
      expected: 460800000,
      code: "duration_limit" as const,
    }));
    const r = new LiveRecorder({ postChunk: post, retryDelayMs: 0 });
    r.enqueue(chunkOf());
    r.enqueue(chunkOf());
    await r.drain();
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.status.sealed).toBe("duration_limit");
    expect(r.status.sealedByServer).toBe(true);
    // 캡처 실패가 아니다 — failed면 stop이 X-Capture-Error를 실어 "마이크가 끊겼다"와
    // 같은 칸에 정상 종료를 넣는다.
    expect(r.status.failed).toBeNull();
    expect(r.offset).toBe(0);
    expect(r.status.backlogMs).toBe(0); // 남은 큐를 버렸다
    // 봉인된 뒤로는 새 청크도 받지 않는다
    r.enqueue(chunkOf());
    expect(r.status.backlogMs).toBe(0);
  });
});

/**
 * prepare()/begin()/stop()이 실제로 태우는 브라우저 경로를 흉내낸다 — jsdom엔
 * AudioContext도 AudioWorkletNode도 없다.
 *
 * 이 스텁이 Worklet을 **봉투(WorkletEvent)로만** 말하는 것이 중요하다. 메인 스레드가
 * 봉투를 풀지 못하면 `new Int16Array(<객체>)`가 길이 0을 조용히 돌려주고, 캡처는
 * 오류 하나 없이 0바이트가 된다 (설계 §7).
 */
function stubWorkletGlobals(
  options: {
    /** Worklet이 첫 유효 입력에서 ready를 보내는가 (설계 §6.3). */
    ready?: boolean;
    /** Worklet이 begin에 begun으로 답하는가. */
    begun?: boolean;
    /** Worklet이 flush에 flushed로 답하는가. false면 테스트가 직접 몬다. */
    autoFlush?: boolean;
    micPrompt?: Promise<MediaStream>;
    addModuleRejects?: unknown;
    resume?: () => Promise<void>;
  } = {},
) {
  const endedListeners: Array<() => void> = [];
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
    getAudioTracks: () => [
      {
        addEventListener: (_type: string, fn: () => void) =>
          endedListeners.push(fn),
      },
    ],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(
    () => options.micPrompt ?? Promise.resolve(stream),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });

  const posted: WorkletCommand[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent<WorkletEvent>) => void) | null,
    postMessage(message: WorkletCommand) {
      posted.push(message);
      if (message.type === "begin" && options.begun !== false)
        emit({ type: "begun" });
      if (message.type === "flush" && options.autoFlush !== false)
        emit({ type: "flushed" });
    },
  };
  const emit = (event: WorkletEvent) =>
    port.onmessage?.({ data: event } as MessageEvent<WorkletEvent>);

  const close = vi.fn().mockResolvedValue(undefined);
  const disconnect = vi.fn();
  const destination = {};
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  class FakeAudioContext {
    sampleRate = SR;
    destination = destination;
    audioWorklet = {
      addModule: vi.fn(() =>
        options.addModuleRejects !== undefined
          ? Promise.reject(options.addModuleRejects)
          : Promise.resolve(undefined),
      ),
    };
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    createGain = vi.fn().mockReturnValue(gain);
    close = close;
    resume =
      options.resume ??
      vi.fn(async () => {
        if (options.ready !== false) emit({ type: "ready" });
      });
  }
  class FakeAudioWorkletNode {
    port = port;
    connect = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

  /** Worklet이 보내는 PCM 봉투 — 실제 Worklet과 같은 모양이다. */
  const sendPcm = (samples: number) =>
    emit({ type: "pcm", pcm: new Int16Array(samples).buffer });

  return {
    port,
    posted,
    emit,
    sendPcm,
    stopTrack,
    close,
    disconnect,
    destination,
    gain,
    stream,
    getUserMedia,
    endTrack: () => endedListeners.forEach((fn) => fn()),
  };
}

/** prepare → begin까지 태운 recording 상태의 레코더. */
async function recording(
  deps: ConstructorParameters<typeof LiveRecorder>[0],
  worklet = stubWorkletGlobals(),
) {
  const r = new LiveRecorder(deps);
  await r.prepare();
  await r.begin("mtg_1");
  return { r, worklet };
}

const restoreCaptureGlobals = () => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
};

describe("LiveRecorder prepare()", () => {
  afterEach(restoreCaptureGlobals);

  it("goes idle → preparing → prepared and does not send begin on its own", async () => {
    const w = stubWorkletGlobals();
    const r = new LiveRecorder({ postChunk: vi.fn() });
    expect(r.status.phase).toBe("idle");
    const pending = r.prepare();
    expect(r.status.phase).toBe("preparing");
    await pending;
    expect(r.status.phase).toBe("prepared");
    // begin은 회의 id를 얻은 뒤에만 나간다 (설계 §6.5).
    expect(w.posted).toEqual([]);
  });

  it("passes the chosen deviceId through and keeps the browser's own processing off", async () => {
    const w = stubWorkletGlobals();
    const r = new LiveRecorder({ postChunk: vi.fn() });
    await r.prepare("mic-2");
    expect(w.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        deviceId: { exact: "mic-2" },
      }),
    });
  });

  it("stops the mic stream and closes the AudioContext when addModule rejects", async () => {
    const w = stubWorkletGlobals({
      addModuleRejects: new Error("worklet load failed"),
    });
    const r = new LiveRecorder({ postChunk: vi.fn() });
    // 에러의 정체(메시지)가 그대로 드러나야 한다 — 삼켜지거나 다른 에러로 바뀌면 안 된다.
    await expect(r.prepare()).rejects.toThrow("worklet load failed");
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalledTimes(1);
    expect(r.status.phase).toBe("stopped");
  });

  /**
   * 일부 브라우저는 지원하지 않는 sampleRate에 대해 `new AudioContext(...)` 생성자
   * 자체에서 동기적으로 던진다. 이 생성자가 try 밖에 있으면 그 예외가 곧바로
   * prepare()를 실패시키면서 정리를 한 번도 안 태우고 빠져나가 — 마이크는 켜진 채로
   * 아무것도 안 잡는다 (review finding 3).
   */
  it("stops the mic stream when the AudioContext constructor itself throws", async () => {
    const w = stubWorkletGlobals();
    class ThrowingAudioContext {
      constructor() {
        throw new Error("unsupported sampleRate");
      }
    }
    vi.stubGlobal("AudioContext", ThrowingAudioContext);
    const r = new LiveRecorder({ postChunk: vi.fn() });
    await expect(r.prepare()).rejects.toThrow("unsupported sampleRate");
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
  });

  it("rejects when the browser gives a sample rate other than 16 kHz", async () => {
    const w = stubWorkletGlobals();
    class WrongRateContext {
      sampleRate = 48000;
      close = w.close;
    }
    vi.stubGlobal("AudioContext", WrongRateContext);
    const r = new LiveRecorder({ postChunk: vi.fn() });
    await expect(r.prepare()).rejects.toThrow(/48000/);
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
  });

  it("keeps the worklet alive through a silent gain into destination", async () => {
    const w = stubWorkletGlobals();
    const r = new LiveRecorder({ postChunk: vi.fn() });
    await r.prepare();
    // 연결되지 않은 노드는 처리 수명을 잃고, 그냥 destination에 이으면 마이크 소리가
    // 스피커로 되돌아 하울링이 된다 — gain=0을 거치는 것이 둘 다 피하는 방법이다 (설계 §7).
    expect(w.gain.gain.value).toBe(0);
    expect(w.gain.connect).toHaveBeenCalledWith(w.destination);
  });
});

describe("LiveRecorder prepare/begin timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    restoreCaptureGlobals();
  });

  it("gives ctx.resume 5 seconds", async () => {
    const w = stubWorkletGlobals({ resume: () => new Promise<void>(() => {}) });
    const r = new LiveRecorder({ postChunk: vi.fn() });
    const pending = r.prepare();
    const assertion = expect(pending).rejects.toThrow(/resume/);
    await vi.advanceTimersByTimeAsync(4999);
    expect(w.stopTrack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("gives the ready ACK 5 seconds", async () => {
    const w = stubWorkletGlobals({ ready: false });
    const r = new LiveRecorder({ postChunk: vi.fn() });
    const pending = r.prepare();
    const assertion = expect(pending).rejects.toThrow(/ready/);
    await vi.advanceTimersByTimeAsync(4999);
    expect(w.stopTrack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("gives the begun ACK 5 seconds and leaves the recorder stopped", async () => {
    const w = stubWorkletGlobals({ begun: false });
    const r = new LiveRecorder({ postChunk: vi.fn(), postStop: okStop() });
    await r.prepare();
    const pending = r.begin("mtg_1");
    const assertion = expect(pending).rejects.toThrow(/begun/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    // begin이 실패해도 자원은 반납된다. 서버 정리(0바이트 stop)는 호출자 몫이다 (설계 §6).
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
    expect(r.status.phase).toBe("stopped");
  });

  /**
   * 설계 §6.4 — "권한 프롬프트 자체에는 제한을 두지 않는다." 사용자가 프롬프트를 오래
   * 들여다봐도 준비는 계속돼야 한다. 5초 제한이 이 대기에 잘못 걸려 있으면 origin당 첫
   * 녹음이 사람 반응 속도 때문에 실패한다.
   */
  it("puts no timeout on the permission prompt itself", async () => {
    const prompt = deferred<MediaStream>();
    const w = stubWorkletGlobals({ micPrompt: prompt.promise });
    const r = new LiveRecorder({ postChunk: vi.fn() });
    const pending = r.prepare();
    await vi.advanceTimersByTimeAsync(60_000); // 제한의 12배
    expect(r.status.phase).toBe("preparing");
    prompt.resolve(w.stream);
    await pending;
    expect(r.status.phase).toBe("prepared");
  });

  /** 설계 §4.2 — FE는 캡처 시작부터 4시간에 **정상 stop 절차**를 시작한다. */
  it("starts a normal stop 4 hours after the begun ACK", async () => {
    const stopSpy = okStop();
    const w = stubWorkletGlobals();
    const r = new LiveRecorder({ postChunk: vi.fn(), postStop: stopSpy });
    await r.prepare();
    await r.begin("mtg_1");
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 1);
    expect(stopSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(w.posted).toContainEqual({ type: "flush" });
  });

  it("clears the 4-hour timer on dispose", async () => {
    const stopSpy = okStop();
    stubWorkletGlobals();
    const r = new LiveRecorder({ postChunk: vi.fn(), postStop: stopSpy });
    await r.prepare();
    await r.begin("mtg_1");
    await r.dispose();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 1000);
    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe("LiveRecorder dispose()", () => {
  afterEach(restoreCaptureGlobals);

  it("stops a stream that arrives after the prepare was cancelled", async () => {
    const prompt = deferred<MediaStream>();
    const w = stubWorkletGlobals({ micPrompt: prompt.promise });
    const r = new LiveRecorder({ postChunk: vi.fn() });
    const pending = r.prepare();
    const assertion =
      expect(pending).rejects.toBeInstanceOf(LiveCaptureCancelled);

    await r.dispose();
    expect(w.stopTrack).not.toHaveBeenCalled(); // 아직 스트림 자체가 없다

    prompt.resolve(w.stream); // 프롬프트가 뒤늦게 허용으로 끝난다
    await assertion;
    // 아무도 주인이 아닌 스트림 — 붙들고 있으면 녹음 표시등만 켜진 채 남는다.
    expect(w.stopTrack).toHaveBeenCalledTimes(1);
    expect(r.status.phase).toBe("stopped");
  });

  it("sends no server request", async () => {
    stubWorkletGlobals();
    const stopSpy = okStop();
    const r = new LiveRecorder({ postChunk: vi.fn(), postStop: stopSpy });
    await r.prepare();
    await r.dispose();
    expect(stopSpy).not.toHaveBeenCalled();
  });
});

/**
 * 설계 §7 — 종료는 Worklet이 아직 들고 있는 것을 받아 낸 **뒤에** 자원을 반납한다.
 * 순서가 뒤집혀 있으면 마지막 자투리(1–16,383샘플)가 매 녹음마다 조용히 사라진다.
 */
describe("LiveRecorder stop() waits for the flush ACK", () => {
  afterEach(restoreCaptureGlobals);

  it("flushes first, then releases, then seals with the worklet's tail", async () => {
    const post = vi.fn(async (_id: string, offset: number) => ({
      status: 200 as const,
      expected: offset + CHUNK_BYTES,
    }));
    const stopSpy = okStop();
    const w = stubWorkletGlobals({ autoFlush: false });
    const { r } = await recording(
      { postChunk: post, postStop: stopSpy, retryDelayMs: 0 },
      w,
    );

    // 완전 청크 하나가 업로드 큐로 나간다.
    w.sendPcm(CHUNK_SAMPLES);
    expect(post).toHaveBeenCalledTimes(1);

    const stopping = r.stop();
    // flush를 보냈고, 아직 아무것도 정리하지 않았다.
    expect(w.posted).toContainEqual({ type: "flush" });
    expect(stopSpy).not.toHaveBeenCalled();
    expect(w.close).not.toHaveBeenCalled();
    expect(w.stopTrack).not.toHaveBeenCalled();

    // Worklet이 자투리를 내보내고 끝을 알린다.
    w.sendPcm(137);
    w.emit({ type: "flushed" });
    await stopping;

    expect(w.close).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    const [id, offset, final, body, , failure] = stopSpy.mock.calls[0];
    expect(id).toBe("mtg_1");
    expect(offset).toBe(CHUNK_BYTES);
    expect(final).toBe(33042); // 32,768 + 274
    expect(body.byteLength).toBe(274); // 137샘플, 패딩 없음
    expect(failure).toBeNull();
    expect(r.status.phase).toBe("stopped");
  });

  it("returns the same promise for a duplicate stop and seals only once", async () => {
    const stopSpy = okStop();
    const w = stubWorkletGlobals({ autoFlush: false });
    const { r } = await recording({ postChunk: vi.fn(), postStop: stopSpy }, w);

    const first = r.stop();
    const second = r.stop();
    expect(second).toBe(first);
    w.emit({ type: "flushed" });
    await first;
    await r.stop(); // 끝난 뒤에 한 번 더
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(w.posted.filter((m) => m.type === "flush")).toHaveLength(1);
  });

  /**
   * 이 테스트가 봉투 처리의 회귀를 잡는다. Worklet은 `{type:'pcm', pcm:ArrayBuffer}`를
   * 보내는데 메인 스레드가 옛날처럼 `new Int16Array(e.data)`를 하면 **길이 0**짜리
   * 배열이 조용히 나온다 — 예외도 경고도 없이 캡처가 0바이트가 된다.
   */
  it("turns pcm envelopes into real chunks — a mis-read envelope captures nothing", async () => {
    const bodies: Uint8Array[] = [];
    const post = vi.fn(
      async (_id: string, offset: number, body: Uint8Array) => {
        bodies.push(body);
        return { status: 200 as const, expected: offset + CHUNK_BYTES };
      },
    );
    const w = stubWorkletGlobals();
    const { r } = await recording({ postChunk: post, postStop: okStop() }, w);

    // Worklet의 실제 프레임 크기(512샘플)로 정확히 한 청크를 채운다.
    for (let i = 0; i < CHUNK_SAMPLES / 512; i += 1) w.sendPcm(512);

    expect(post).toHaveBeenCalledTimes(1);
    expect(bodies[0].byteLength).toBe(CHUNK_BYTES);
    await r.drain();
    expect(r.offset).toBe(CHUNK_BYTES);
  });

  /**
   * begin을 보내지 않으면 Worklet은 `began=false`에 머물러 PCM을 전혀 내보내지 않는다.
   * 그 배선이 빠져도 예외는 없고 무음 회의만 남으므로, 명령이 실제로 나갔는지를 본다.
   */
  it("sends exactly one begin, and only from begin()", async () => {
    const w = stubWorkletGlobals();
    const r = new LiveRecorder({ postChunk: vi.fn(), postStop: okStop() });
    await r.prepare();
    expect(w.posted).toEqual([]);
    await r.begin("mtg_1");
    expect(w.posted).toEqual([{ type: "begin" }]);
    expect(r.status.phase).toBe("recording");
  });
});

describe("LiveRecorder failure endings share one release path", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    restoreCaptureGlobals();
  });

  it("records capture_flush_failed when the flush ACK misses its 2 seconds, and still sends what it has", async () => {
    const post = vi.fn(async (_id: string, offset: number) => ({
      status: 200 as const,
      expected: offset + CHUNK_BYTES,
    }));
    const stopSpy = okStop();
    const w = stubWorkletGlobals({ autoFlush: false });
    const { r } = await recording(
      { postChunk: post, postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);
    w.sendPcm(137); // flush 이전에 이미 받아 둔 연속 PCM

    const stopping = r.stop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(stopSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    await stopping;

    expect(r.status.failed).toBe("capture_flush_failed");
    // 받아 둔 연속 PCM까지는 그대로 봉인한다 (설계 §7).
    const [, offset, final, body, , failure] = stopSpy.mock.calls[0];
    expect(offset).toBe(CHUNK_BYTES);
    expect(final).toBe(33042);
    expect(body.byteLength).toBe(274);
    expect(failure).toBe("capture_flush_failed");
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  // 설계 §7 — "장치 ended도 가능한 flush를 시도하고 device_ended를 우선 보존한다."
  it("keeps device_ended as the reason even when the flush then times out", async () => {
    const stopSpy = okStop();
    const w = stubWorkletGlobals({ autoFlush: false });
    const { r } = await recording(
      { postChunk: vi.fn(), postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    w.endTrack(); // 마이크가 뽑혔다
    expect(r.status.failed).toBe("device_ended");
    // 그래도 flush는 시도한다 — Worklet이 들고 있는 자투리는 진짜 오디오다.
    expect(w.posted).toContainEqual({ type: "flush" });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();

    // 첫 캡처 원인이 이긴다. capture_flush_failed가 덮으면 서버의 capture_error가
    // "마이크가 끊겼다"에서 "flush를 못 했다"로 바뀐다 (설계 §7).
    expect(r.status.failed).toBe("device_ended");
    await r.stop();
    expect(stopSpy.mock.calls[0][5]).toBe("device_ended");
  });

  it("turns the microphone off before it reports upload_failed", async () => {
    const order: string[] = [];
    const w = stubWorkletGlobals();
    w.stopTrack.mockImplementation(() => order.push("mic-off"));
    const post = vi.fn(async () => {
      throw new LiveUploadRejected("no expected_offset");
    });
    const { r } = await recording(
      { postChunk: post, postStop: okStop(), retryDelayMs: 0 },
      w,
    );
    r.onStatus = (s) => {
      if (s.failed) order.push(`report:${s.failed}`);
    };
    w.sendPcm(CHUNK_SAMPLES);
    await vi.runAllTimersAsync();
    await r.drain();

    expect(r.status.failed).toBe("upload_failed");
    expect(order[0]).toBe("mic-off");
    expect(order).toContain("report:upload_failed");
  });

  it("gives the normal stop drain 60 seconds, then seals at the last confirmed boundary", async () => {
    // 네트워크가 응답하지 않는다 — 큐는 영원히 비지 않는다.
    const post = vi.fn(() => new Promise<PostResult>(() => {}));
    const stopSpy = okStop();
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);

    const stopping = r.stop();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(stopSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    await stopping;

    // 한도를 넘겼을 때 마이크는 이미 꺼져 있어야 한다 (설계 §7).
    expect(w.stopTrack).toHaveBeenCalled();
    expect(r.status.failed).toBe("upload_failed");
    // 구멍(전송 못 한 청크) 뒤에 꼬리를 이어 붙이지 않는다 — 마지막 확인 경계에서 빈 stop.
    const [, offset, final, body] = stopSpy.mock.calls[0];
    expect(offset).toBe(0);
    expect(final).toBe(0);
    expect(body.byteLength).toBe(0);
  });

  /**
   * 설계 §6 — "실패는 리소스를 반납하고 stopped로 수렴한다." 자원만 반납하고 phase를
   * 그대로 두면 마이크·노드·ctx가 이미 사라진 뒤에도 `phase === "recording"`이라, phase를
   * 보는 화면은 존재하지 않는 녹음을 살아 있다고 읽는다.
   */
  it("converges on stopped after the device ends", async () => {
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: vi.fn(), postStop: okStop(), retryDelayMs: 0 },
      w,
    );
    expect(r.status.phase).toBe("recording");
    w.endTrack();
    await vi.runAllTimersAsync();
    expect(r.status.failed).toBe("device_ended");
    expect(r.status.phase).toBe("stopped");
  });

  it("converges on stopped after an upload failure", async () => {
    const post = vi.fn(async () => {
      throw new LiveUploadRejected("no expected_offset");
    });
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: okStop(), retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);
    await vi.runAllTimersAsync();
    await r.drain();
    expect(r.status.failed).toBe("upload_failed");
    expect(r.status.phase).toBe("stopped");
  });

  it("converges on stopped after a server seal", async () => {
    const post = vi.fn(async () => ({
      status: 409 as const,
      expected: 460800000,
      code: "duration_limit" as const,
    }));
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: okStop(), retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);
    await vi.runAllTimersAsync();
    await r.drain();
    expect(r.status.sealed).toBe("duration_limit");
    expect(r.status.phase).toBe("stopped");
  });

  it("releases and discards the queue when the server seals mid-upload", async () => {
    const post = vi.fn(async () => ({
      status: 409 as const,
      expected: 460800000,
      code: "duration_limit" as const,
    }));
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: okStop(), retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);
    await vi.runAllTimersAsync();
    await r.drain();

    expect(r.status.sealed).toBe("duration_limit");
    expect(r.status.sealedByServer).toBe(true);
    expect(r.status.failed).toBeNull();
    expect(w.stopTrack).toHaveBeenCalled();
    expect(w.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * run()의 while 조건은 `queue.length > 0 && status.failed === null`이라, fail() 뒤에는
 * 큐가 비지 않은 채로 루프가 빠진다. stop()이 그 위에 최신 꼬리만 이어 붙이면
 * [offset..][큐에 남은 구멍][꼬리]가 "정상 완료"로 봉인된다 (review Important 2).
 */
describe("LiveRecorder stop() after a recorder failure", () => {
  afterEach(restoreCaptureGlobals);

  it("seals at the last contiguous offset with an empty body instead of splicing the queued hole", async () => {
    const post = vi.fn(async () => {
      throw new Error("network down");
    });
    const stopSpy = okStop();
    const w = stubWorkletGlobals();
    const { r } = await recording(
      {
        postChunk: post,
        postStop: stopSpy,
        retryDelayMs: 0,
        bufferLimitMs: 2000, // 청크 2개(2048ms)면 넘는다
      },
      w,
    );

    // 청크 2개 — 큐에 쌓이지만 네트워크가 죽어 있어 전송되지 않고, 그 백로그가
    // buffer_overflow를 일으킨다.
    w.sendPcm(CHUNK_SAMPLES);
    w.sendPcm(CHUNK_SAMPLES);
    expect(r.status.failed).toBe("buffer_overflow");
    // 청크 경계에 못 미치는 꼬리 — 큐에 쌓인 두 청크보다 나중에 캡처됐다. 옛 코드는
    // stop()에서 이 꼬리를 flush()해 그대로 이어 붙였다.
    w.sendPcm(2560);

    await r.drain();
    await r.stop();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    const [id, offset, final, body, , failure] = stopSpy.mock.calls[0];
    expect(id).toBe("mtg_1");
    expect(offset).toBe(0);
    expect(final).toBe(0);
    expect(body.byteLength).toBe(0);
    // 실패 사유가 stop에 실려야 서버의 meeting.capture_error에 남는다. 이게 없으면
    // 마이크를 잃은 회의와 깨끗한 회의가 서버에서 구별되지 않는다 (설계 §5.3·§7).
    expect(failure).toBe("buffer_overflow");
  });

  /**
   * 설계 §7 — "구멍 뒤의 꼬리를 이어 붙이지 않는다"의 가장 조용한 경로.
   *
   * `fail('device_ended')`는 flush를 보낸 **뒤에** status.failed를 세우므로, 그 뒤 도착한
   * 자투리가 accumulator에서 완전한 청크를 완성하면 `enqueue`가 그것을 버린다(= 구멍).
   * 나머지는 accumulator에 남고, 큐는 비어 있다 — 옛 조건(`queue.length > 0 || sealed`)
   * 으로는 그 나머지를 **구멍 앞** 오프셋에 실어 보내 정본에 잘못된 바이트를 쓴다.
   * 필요한 조건은 15,873샘플 이상 + 빈 큐뿐이라 실제로 일어날 수 있고, 아무 오류도 남기지
   * 않는다.
   */
  it("never splices the flush tail behind a chunk the failure dropped", async () => {
    const stopSpy = okStop();
    const w = stubWorkletGlobals({ autoFlush: false });
    const { r } = await recording(
      { postChunk: vi.fn(), postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    // 청크 경계에 못 미치는 16,000샘플 — 아직 아무것도 큐에 들어가지 않는다.
    w.sendPcm(16_000);
    expect(r.status.backlogMs).toBe(0);

    w.endTrack(); // device_ended → flush 요청. 이 뒤로 enqueue는 닫힌다.
    expect(w.posted).toContainEqual({ type: "flush" });
    // 자투리 500샘플이 16,384샘플째를 넘겨 청크 하나를 완성하지만 enqueue가 버린다.
    w.sendPcm(500);
    w.emit({ type: "flushed" });
    await r.stop();

    const [, offset, final, body, , failure] = stopSpy.mock.calls[0];
    expect(offset).toBe(0);
    expect(final).toBe(0);
    // 고치기 전에는 116샘플(232바이트)이 오프셋 0에 실려 나갔다 — 구멍 뒤 바이트를
    // 구멍 앞 경계에 쓰는 것이고, final까지 틀린다.
    expect(body.byteLength).toBe(0);
    expect(failure).toBe("device_ended");
  });

  // 설계 §7. ACK를 잃은 채 stop을 보내면 서버의 확정 경계가 우리보다 앞서 있다. 로컬
  // 꼬리를 그 앞에 덧붙이면 서버가 이미 확정한 바이트 위에 구멍을 낸다.
  it("retries an empty stop at the server boundary, carrying the capture failure through", async () => {
    const post = vi.fn(async () => {
      throw new Error("network down");
    });
    const stopSpy = vi.fn<StopSpy>(async (_id, offset) =>
      offset === 0
        ? { status: 409 as const, expected: CHUNK_BYTES }
        : { status: 200 as const, expected: offset },
    );
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    // 청크 하나 + 자투리. 청크는 전송에 실패해 큐에 남는다.
    w.sendPcm(CHUNK_SAMPLES);
    w.sendPcm(2560);
    w.endTrack(); // 마이크가 끊겼다
    expect(r.status.failed).toBe("device_ended");
    await r.stop();

    expect(stopSpy).toHaveBeenCalledTimes(2);
    // 첫 시도는 로컬 경계(0)에서. 큐에 구멍이 남아 있으므로 꼬리를 싣지 않는다.
    const [, firstOffset, firstFinal, firstBody, , firstFailure] =
      stopSpy.mock.calls[0];
    expect(firstOffset).toBe(0);
    expect(firstFinal).toBe(0);
    expect(firstBody.byteLength).toBe(0);
    expect(firstFailure).toBe("device_ended");
    // 두 번째는 서버가 알려준 경계에서 빈 바디로 — 앞에 자투리를 덧붙이지 않는다.
    const [, secondOffset, secondFinal, secondBody, , secondFailure] =
      stopSpy.mock.calls[1];
    expect(secondOffset).toBe(CHUNK_BYTES);
    expect(secondFinal).toBe(CHUNK_BYTES);
    expect(secondBody.byteLength).toBe(0);
    // 재시도가 사유를 떨어뜨리면 서버의 meeting.capture_error가 비고, 마이크를 잃은 회의가
    // 깨끗한 회의와 구별되지 않는다 — 이 재시도가 그 헤더가 도착하는 유일한 경로다.
    expect(secondFailure).toBe("device_ended");
    expect(r.offset).toBe(CHUNK_BYTES);
  });

  /**
   * 재시도한 stop마저 409면 이 세션은 브라우저가 봉인하지 못한다. 옛 코드는 두 번째
   * 응답을 아예 읽지 않아 stop()이 "봉인됐다"처럼 조용히 resolve했다 — 실제로는 회의가
   * recording에 남아 orphan 스캐너를 기다리는데, 화면은 정상 종료로 보였다.
   */
  it("reports upload_failed when even the retry at the server boundary is refused", async () => {
    const stopSpy = vi.fn<StopSpy>(async () => ({
      status: 409 as const,
      expected: CHUNK_BYTES * 2,
    }));
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: vi.fn(), postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    await r.stop();
    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(r.status.failed).toBe("upload_failed");
  });

  /** 서버 경계가 우리보다 **뒤**면 재동기화할 곳이 없다 — 조용히 성공으로 접지 않는다. */
  it("reports upload_failed when the server boundary is behind our own offset", async () => {
    const post = vi.fn(async (_id: string, offset: number) => ({
      status: 200 as const,
      expected: offset + CHUNK_BYTES,
    }));
    const stopSpy = vi.fn<StopSpy>(async () => ({
      status: 409 as const,
      expected: 0,
    }));
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);
    await r.drain();
    expect(r.offset).toBe(CHUNK_BYTES);
    await r.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1); // 되돌아가 다시 보내지 않는다
    expect(r.status.failed).toBe("upload_failed");
  });

  it("재동기화 오프셋 없는 거절은 재시도하지 않고 upload_failed로 끝낸다", async () => {
    // 종단 409 — postLiveChunk가 LiveUploadRejected로 바꿔 던지는 그 모양이다.
    const post = vi.fn(async () => {
      throw new LiveUploadRejected("no expected_offset");
    });
    const stopSpy = okStop();
    const w = stubWorkletGlobals();
    const { r } = await recording(
      { postChunk: post, postStop: stopSpy, retryDelayMs: 0 },
      w,
    );
    w.sendPcm(CHUNK_SAMPLES);
    await r.drain();

    // 한 번만 시도하고 멈춘다 — 무한 재시도였다면 buffer_overflow로 60초를 태운다.
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.status.failed).toBe("upload_failed");

    await r.stop();
    // 오프셋이 오염되지 않은 채(0) 봉인되고, 사유가 실려 나간다.
    const [, offset, final, , , failure] = stopSpy.mock.calls[0];
    expect(offset).toBe(0);
    expect(final).toBe(0);
    expect(failure).toBe("upload_failed");
  });
});

/**
 * jsdom은 navigator.mediaDevices/navigator.permissions를 아예 갖지 않는다 — 매 테스트에서
 * 명시적으로 세우고 지운다. "insecure" 분기는 jsdom 기본 상태(둘 다 없음)에서도 참이라,
 * 그 사실만으로는 아무것도 검증하지 못한다. 셋을 가르는 값은 mediaDevices를 세운 뒤에도
 * insecure가 아닌 다른 분기로 실제로 넘어가는지다.
 */
function stubMediaDevices(
  options: {
    devices?: Array<{ kind: string; deviceId?: string; label?: string }>;
    permissionState?: "granted" | "denied" | "unsupported" | "throws";
    /** 권한 프롬프트에서 거부·장치 없음 등으로 getUserMedia가 거절되는 경우. */
    micRejects?: unknown;
  } = {},
) {
  const devices = options.devices ?? [{ kind: "audioinput" }];
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
  const getUserMedia = vi.fn(() =>
    options.micRejects !== undefined
      ? Promise.reject(options.micRejects)
      : Promise.resolve(stream),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue(devices),
    },
  });
  if (options.permissionState === "unsupported") {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: undefined,
    });
    return { getUserMedia, stopTrack };
  }
  const query =
    options.permissionState === "throws"
      ? vi.fn().mockRejectedValue(new TypeError("permission name unsupported"))
      : vi
          .fn()
          .mockResolvedValue({ state: options.permissionState ?? "granted" });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query },
  });
  return { getUserMedia, stopTrack };
}

describe("checkCaptureSupport", () => {
  beforeEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(navigator, "permissions");
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(navigator, "permissions");
  });

  it("is insecure when navigator.mediaDevices is missing", async () => {
    // 아무것도 stub하지 않는다 — insecure context에서 브라우저가 실제로 주는 상태다.
    expect(await checkCaptureSupport()).toEqual({
      ok: false,
      reason: "insecure",
    });
  });

  it("reaches a non-insecure branch once mediaDevices is stubbed in", async () => {
    // insecure 분기가 트리비얼하게 항상 참이 아님을 증명한다: mediaDevices를 세우면
    // 같은 함수가 다른 결과를 낸다.
    stubMediaDevices();
    const result = await checkCaptureSupport();
    expect(result.ok).toBe(true);
  });

  it("is denied when microphone permission is denied", async () => {
    stubMediaDevices({ permissionState: "denied" });
    expect(await checkCaptureSupport()).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("is no_device when enumerateDevices has no audioinput entry", async () => {
    stubMediaDevices({ devices: [{ kind: "videoinput" }] });
    expect(await checkCaptureSupport()).toEqual({
      ok: false,
      reason: "no_device",
    });
  });

  it("is ok when navigator.permissions is absent (unsupported browser)", async () => {
    stubMediaDevices({ permissionState: "unsupported" });
    expect(await checkCaptureSupport()).toEqual({ ok: true });
  });

  it("is ok when permissions.query rejects (unsupported permission name)", async () => {
    stubMediaDevices({ permissionState: "throws" });
    expect(await checkCaptureSupport()).toEqual({ ok: true });
  });

  it("is ok when a device exists and permission is granted", async () => {
    stubMediaDevices({ permissionState: "granted" });
    expect(await checkCaptureSupport()).toEqual({ ok: true });
  });
});

/**
 * 설계 §5.2의 게이트를 live 탭이 **열릴 때** 돌리기 위한 함수. checkCaptureSupport와
 * 다른 점은 권한을 실제로 **요청**한다는 것이다 — 승인 전 enumerateDevices()는 label이
 * 빈 문자열이라 "마이크 1/2"밖에 못 보여주고, 그러면 사용자는 무엇을 고르는지 모른 채
 * 고르게 된다.
 */
describe("requestCaptureDevices", () => {
  beforeEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(navigator, "permissions");
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    Reflect.deleteProperty(navigator, "permissions");
  });

  it("is insecure when navigator.mediaDevices is missing", async () => {
    expect(await requestCaptureDevices()).toEqual({
      ok: false,
      reason: "insecure",
    });
  });

  it("does not prompt when the pre-check already refuses", async () => {
    // 이미 거부된 권한·장치 없음에 프롬프트를 띄우면 사용자는 답할 수 없는 창을 본다.
    const denied = stubMediaDevices({ permissionState: "denied" });
    expect(await requestCaptureDevices()).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(denied.getUserMedia).not.toHaveBeenCalled();

    const none = stubMediaDevices({ devices: [{ kind: "videoinput" }] });
    expect(await requestCaptureDevices()).toEqual({
      ok: false,
      reason: "no_device",
    });
    expect(none.getUserMedia).not.toHaveBeenCalled();
  });

  it("prompts once and returns the labelled audio inputs", async () => {
    const mic = stubMediaDevices({
      devices: [
        { kind: "audioinput", deviceId: "a", label: "내장 마이크" },
        { kind: "videoinput", deviceId: "cam", label: "웹캠" },
        { kind: "audioinput", deviceId: "b", label: "USB 마이크" },
      ],
    });
    const result = await requestCaptureDevices();

    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      devices: [
        { kind: "audioinput", deviceId: "a", label: "내장 마이크" },
        { kind: "audioinput", deviceId: "b", label: "USB 마이크" },
      ],
    });
  });

  it("closes the permission probe stream", async () => {
    // 붙들고 있으면 다이얼로그를 열어 둔 내내 브라우저 녹음 표시등이 켜져 있다 (설계 §6.4).
    const mic = stubMediaDevices();
    await requestCaptureDevices();
    expect(mic.stopTrack).toHaveBeenCalledTimes(1);
  });

  it("is denied when the user refuses the prompt", async () => {
    stubMediaDevices({
      micRejects: new DOMException("denied", "NotAllowedError"),
    });
    expect(await requestCaptureDevices()).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("is no_device when the prompt finds no microphone", async () => {
    stubMediaDevices({
      micRejects: new DOMException("no device", "NotFoundError"),
    });
    expect(await requestCaptureDevices()).toEqual({
      ok: false,
      reason: "no_device",
    });
  });

  /**
   * 다른 앱이 마이크를 점유한 경우(NotReadableError). "권한이 거부됐어요"로 뭉뚱그리면
   * 사용자를 아무 문제도 없는 브라우저 사이트 설정으로 보낸다.
   */
  it("is unavailable when the device cannot be opened", async () => {
    stubMediaDevices({
      micRejects: new DOMException("in use", "NotReadableError"),
    });
    expect(await requestCaptureDevices()).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
