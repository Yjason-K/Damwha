import { describe, expect, it } from "vitest";
import {
  ChunkAccumulator,
  CHUNK_BYTES,
  FRAME_SAMPLES,
  FrameAccumulator,
  floatToInt16,
} from "./pcm-convert";

describe("floatToInt16", () => {
  it("maps -1..1 to the int16 range and clamps beyond it", () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe("FrameAccumulator", () => {
  it("emits only complete 512-sample frames regardless of input length", () => {
    const acc = new FrameAccumulator();
    // 렌더 퀀텀이 128이 아니어도 동작해야 한다 — 스펙이 128을 보장하지 않는다
    expect(acc.push(new Float32Array(100))).toHaveLength(0);
    expect(acc.push(new Float32Array(400))).toHaveLength(0);
    const frames = acc.push(new Float32Array(200)); // 누적 700 → 512 하나
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(FRAME_SAMPLES);
  });

  it("emits several frames from one large push", () => {
    expect(
      new FrameAccumulator().push(new Float32Array(FRAME_SAMPLES * 3)),
    ).toHaveLength(3);
  });
});

describe("ChunkAccumulator", () => {
  it("emits a chunk every 32 frames", () => {
    const acc = new ChunkAccumulator();
    const frame = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < 31; i += 1) expect(acc.push(frame)).toBeNull();
    const chunk = acc.push(frame);
    expect(chunk).not.toBeNull();
    expect(chunk!.byteLength).toBe(CHUNK_BYTES);
  });

  it("flush returns the partial tail without padding it", () => {
    const acc = new ChunkAccumulator();
    acc.push(new Int16Array(FRAME_SAMPLES));
    const tail = acc.flush();
    // 정본 WAV는 절대 자르지도 늘리지도 않는다 — 512샘플이 안 되는 꼬리도 그대로 (설계 §4.5)
    expect(tail.byteLength).toBe(1024);
    expect(acc.flush().byteLength).toBe(0);
  });
});
