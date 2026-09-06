import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES } from "./pcm-convert";
import { checkCaptureSupport, LiveRecorder } from "./live-recorder";

const chunkOf = (n = CHUNK_BYTES) => new Uint8Array(n);

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
