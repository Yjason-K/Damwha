import { describe, expect, it } from "vitest";
import { MAX_SYSTEM_LAG_SAMPLES, SystemAudioMixer } from "./pcm-mix";

const le = (...samples: number[]) => {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return bytes;
};

describe("SystemAudioMixer", () => {
  it("adds system samples to the mic frame and keeps the mic's length", () => {
    const m = new SystemAudioMixer();
    m.pushBytes(le(10, -20, 30));
    expect([...m.mixInto(Int16Array.from([1, 2, 3, 4]))]).toEqual([11, -18, 33, 4]);
  });

  it("carries leftover system samples into the next frame", () => {
    const m = new SystemAudioMixer();
    m.pushBytes(le(1, 2, 3));
    expect([...m.mixInto(Int16Array.from([0, 0]))]).toEqual([1, 2]);
    expect([...m.mixInto(Int16Array.from([0, 0]))]).toEqual([3, 0]);
  });

  it("joins a sample split across two chunks", () => {
    const m = new SystemAudioMixer();
    const bytes = le(1000, -1000);
    m.pushBytes(bytes.subarray(0, 3));
    m.pushBytes(bytes.subarray(3));
    expect([...m.mixInto(new Int16Array(2))]).toEqual([1000, -1000]);
  });

  it("clamps instead of wrapping when the sum overflows int16", () => {
    const m = new SystemAudioMixer();
    m.pushBytes(le(30000, -30000));
    expect([...m.mixInto(Int16Array.from([10000, -10000]))]).toEqual([32767, -32768]);
  });

  it("drops the oldest samples past the lag bound so the far side never drifts late", () => {
    const m = new SystemAudioMixer();
    const old = new Array(MAX_SYSTEM_LAG_SAMPLES).fill(1);
    m.pushBytes(le(...old));
    m.pushBytes(le(7, 8));
    const out = m.mixInto(new Int16Array(MAX_SYSTEM_LAG_SAMPLES));
    expect(out[MAX_SYSTEM_LAG_SAMPLES - 2]).toBe(7);
    expect(out[MAX_SYSTEM_LAG_SAMPLES - 1]).toBe(8);
    expect(out[0]).toBe(1);
  });

  it("forgets what came before reset — that audio predates the recording", () => {
    const m = new SystemAudioMixer();
    m.pushBytes(le(5, 5));
    m.pushBytes(new Uint8Array([9]));
    m.reset();
    m.pushBytes(le(3));
    expect([...m.mixInto(new Int16Array(2))]).toEqual([3, 0]);
  });
});
