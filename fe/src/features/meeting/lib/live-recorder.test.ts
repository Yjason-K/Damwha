import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES, FRAME_BYTES, SR } from "./pcm-convert";
import {
  checkCaptureSupport,
  LiveRecorder,
  LiveUploadRejected,
  type PostResult,
  type RecorderFailure,
} from "./live-recorder";

const chunkOf = (n = CHUNK_BYTES) => new Uint8Array(n);

/** 즉시 settle하지 않는 Promise. 네트워크가 아직 응답하지 않은 상태를 흉내낸다. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("LiveRecorder upload loop", () => {
  it("sends one chunk at a time and advances the offset", async () => {
    const seen: number[] = [];
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      return { ok: true as const, expected: offset + CHUNK_BYTES };
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
      return { ok: true as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post });
    for (let i = 0; i < 4; i += 1) r.enqueue(chunkOf());
    await r.drain();
    expect(maxInFlight).toBe(1);
  });

  it("resyncs from the expected_offset a 409 carries", async () => {
    const seen: number[] = [];
    let first = true;
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      if (first) {
        first = false;
        return { ok: false as const, expected: CHUNK_BYTES };
      }
      return { ok: true as const, expected: offset + CHUNK_BYTES };
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
      return { ok: true as const, expected: offset + CHUNK_BYTES };
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
        return { ok: true as const, expected: offset + CHUNK_BYTES };
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
    first.resolve({ ok: true, expected: CHUNK_BYTES });

    await r.drain();
    expect(seenElapsed).toEqual([0, 1024]);
    vi.restoreAllMocks();
  });
});

/**
 * run()의 while 조건은 `queue.length > 0 && status.failed === null`이라, fail() 뒤에는
 * 큐가 비지 않은 채로 루프가 빠진다. stop()이 그 위에 최신 꼬리만 이어 붙이면
 * [offset..][큐에 남은 구멍][꼬리]가 "정상 완료"로 봉인된다 (review Important 2) — 이
 * 리뷰가 지적하기 전까지 stop()을 실패 뒤에 부르는 테스트가 하나도 없었다.
 */
/** start()가 실제 워크릿을 태우는 경로를 흉내낸다 — jsdom엔 AudioContext가 없다. */
function stubWorkletGlobals() {
  const stream = {
    getTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [{ addEventListener: vi.fn() }],
  } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  });
  const port: { onmessage: ((e: MessageEvent<ArrayBuffer>) => void) | null } = {
    onmessage: null,
  };
  class FakeAudioContext {
    sampleRate = SR;
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
    close = vi.fn().mockResolvedValue(undefined);
  }
  class FakeAudioWorkletNode {
    port = port;
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  return { port };
}

describe("LiveRecorder stop() after a recorder failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("seals at the last contiguous offset with an empty body instead of splicing the queued hole", async () => {
    const { port } = stubWorkletGlobals();

    // 네트워크가 죽어 있다 — 큐에 들어간 청크는 절대 전송되지 않는다.
    const post = vi.fn(async () => {
      throw new Error("network down");
    });
    const stopSpy = vi.fn<
      (
        id: string,
        offset: number,
        final: number,
        body: Uint8Array,
        elapsedMs: number,
        failure: RecorderFailure | null,
      ) => Promise<void>
    >(async () => undefined);
    const r = new LiveRecorder({
      postChunk: post,
      postStop: stopSpy,
      retryDelayMs: 0,
      bufferLimitMs: 2000, // 청크 2개(2048ms)면 넘는다
    });

    await r.start("mtg_1");
    const frame = () => new ArrayBuffer(FRAME_BYTES);
    // 청크 2개(64프레임) — 큐에 쌓이지만 네트워크가 죽어 있어 전송되지 않고, 그 백로그가
    // buffer_overflow를 일으킨다.
    for (let i = 0; i < 64; i += 1) {
      port.onmessage?.({ data: frame() } as MessageEvent<ArrayBuffer>);
    }
    expect(r.status.failed).toBe("buffer_overflow");
    // 청크 경계에 못 미치는 꼬리 5프레임 — 큐에 쌓인 두 청크보다 나중에 캡처됐다. 옛
    // 코드는 stop()에서 이 꼬리를 flush()해 그대로 이어 붙였다.
    for (let i = 0; i < 5; i += 1) {
      port.onmessage?.({ data: frame() } as MessageEvent<ArrayBuffer>);
    }

    await r.drain();
    await r.stop();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    const [id, offset, final, body, , failure] = stopSpy.mock.calls[0];
    expect(id).toBe("mtg_1");
    expect(offset).toBe(0);
    expect(final).toBe(0);
    expect((body as Uint8Array).byteLength).toBe(0);
    // 실패 사유가 stop에 실려야 서버의 meeting.capture_error에 남는다. 이게 없으면
    // 마이크를 잃은 회의와 깨끗한 회의가 서버에서 구별되지 않는다 (설계 §5.3·§7).
    expect(failure).toBe("buffer_overflow");
  });

  it("재동기화 오프셋 없는 거절은 재시도하지 않고 upload_failed로 끝낸다", async () => {
    const { port } = stubWorkletGlobals();

    // 종단 409 — postLiveChunk가 LiveUploadRejected로 바꿔 던지는 그 모양이다.
    const post = vi.fn(async () => {
      throw new LiveUploadRejected("no expected_offset");
    });
    const stopSpy = vi.fn(async () => undefined);
    const r = new LiveRecorder({
      postChunk: post,
      postStop: stopSpy,
      retryDelayMs: 0,
    });
    await r.start("mtg_1");
    for (let i = 0; i < 32; i += 1) {
      port.onmessage?.({
        data: new ArrayBuffer(FRAME_BYTES),
      } as MessageEvent<ArrayBuffer>);
    }
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
    devices?: Array<{ kind: string }>;
    permissionState?: "granted" | "denied" | "unsupported" | "throws";
  } = {},
) {
  const devices = options.devices ?? [{ kind: "audioinput" }];
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
      enumerateDevices: vi.fn().mockResolvedValue(devices),
    },
  });
  if (options.permissionState === "unsupported") {
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: undefined,
    });
    return;
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
 * start()가 마이크는 얻었지만 워크릿 로딩에서 실패하는 경로. 여기서 정리를 빼먹으면
 * 마이크가 계속 켜진 채로 남는다 — 사용자는 브라우저 녹음 표시등을 보고 여전히 녹음
 * 중이라 믿지만 아무것도 잡히지 않는다, 단순 누수보다 나쁜 결과다.
 */
describe("LiveRecorder start() cleanup on worklet failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("stops the mic stream and closes the AudioContext when addModule rejects", async () => {
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
      getAudioTracks: () => [{ addEventListener: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });

    const close = vi.fn().mockResolvedValue(undefined);
    const addModule = vi
      .fn()
      .mockRejectedValue(new Error("worklet load failed"));
    class FakeAudioContext {
      sampleRate = SR;
      audioWorklet = { addModule };
      close = close;
      createMediaStreamSource = vi.fn();
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const r = new LiveRecorder({ postChunk: vi.fn() });
    // 에러의 정체(메시지)가 그대로 드러나야 한다 — 삼켜지거나 다른 에러로 바뀌면 안 된다.
    await expect(r.start("mtg_1")).rejects.toThrow("worklet load failed");
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * 일부 브라우저는 지원하지 않는 sampleRate에 대해 `new AudioContext(...)` 생성자
   * 자체에서 동기적으로 던진다. 이 생성자가 기존 try 밖에 있으면 그 예외가 곧바로
   * start()를 실패시키면서 teardown()을 한 번도 안 태우고 빠져나가 — 마이크는 켜진
   * 채로 아무것도 안 잡는다 (review finding 3).
   */
  it("stops the mic stream when the AudioContext constructor itself throws", async () => {
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
      getAudioTracks: () => [{ addEventListener: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    class ThrowingAudioContext {
      constructor() {
        throw new Error("unsupported sampleRate");
      }
    }
    vi.stubGlobal("AudioContext", ThrowingAudioContext);

    const r = new LiveRecorder({ postChunk: vi.fn() });
    await expect(r.start("mtg_1")).rejects.toThrow("unsupported sampleRate");
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
