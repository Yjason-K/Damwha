import { beforeAll, describe, expect, it } from "vitest";
import type { WorkletCommand, WorkletEvent } from "./pcm-worklet-protocol";

/**
 * pcm-worklet.ts는 AudioWorkletGlobalScope의 진짜 전역(AudioWorkletProcessor,
 * registerProcessor)이 있다고 가정하고 컴파일된다. 그 전역을 흉내 낸 뒤 실제 모듈을
 * import해서, registerProcessor가 받은 생성자를 그대로 구동한다 — 프로세서 로직을
 * 테스트용으로 복제하면 이 파일이 무엇을 검증하는지 의미가 없어진다.
 */

class RecordingPort {
  onmessage: ((event: { data: WorkletCommand }) => void) | null = null;
  readonly sent: WorkletEvent[] = [];
  postMessage(message: WorkletEvent): void {
    this.sent.push(message);
  }
}

class MockAudioWorkletProcessor {
  readonly port = new RecordingPort();
}

interface ProcessorInstance {
  port: RecordingPort;
  process(inputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new () => ProcessorInstance;

let Processor!: ProcessorCtor;

beforeAll(async () => {
  Object.assign(globalThis, {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor: (name: string, ctor: ProcessorCtor) => {
      if (name !== "pcm-processor")
        throw new Error(`unexpected processor: ${name}`);
      Processor = ctor;
    },
  });
  await import("./pcm-worklet");
});

const mono = (n: number, value: number): Float32Array[] => [
  new Float32Array(n).fill(value),
];
const stereo = (n: number, a: number, b: number): Float32Array[] => [
  new Float32Array(n).fill(a),
  new Float32Array(n).fill(b),
];
const feed = (instance: ProcessorInstance, channels: Float32Array[]) =>
  instance.process([channels]);
const send = (instance: ProcessorInstance, command: WorkletCommand) =>
  instance.port.onmessage?.({ data: command });
const pcmOf = (event: WorkletEvent): number[] => {
  if (event.type !== "pcm") throw new Error(`expected pcm, got ${event.type}`);
  return Array.from(new Int16Array(event.pcm));
};

describe("PcmProcessor (registerProcessor로 받은 실제 생성자)", () => {
  it("begin 전 입력은 버리고, 이후 128/256/137 quantum·2채널 downmix를 flush까지 순서대로 낸다", () => {
    const instance = new Processor();

    // begin 전: 무음(0)도 유효한 입력이라 첫 quantum에서 ready 딱 한 번, PCM은 절대 없다.
    expect(feed(instance, mono(128, 0))).toBe(true);
    expect(feed(instance, mono(128, 0))).toBe(true);
    expect(instance.port.sent).toEqual([{ type: "ready" }]);

    send(instance, { type: "begin" });
    expect(instance.port.sent[1]).toEqual({ type: "begun" });

    // 256샘플 2채널(1, -1) downmix = 0, 137샘플 단채널(1) 순으로 393샘플 누적 —
    // 아직 512 미만이라 PCM 없음. begin 전에 버려진 위 두 128샘플은 여기 섞이지 않는다.
    expect(feed(instance, stereo(256, 1, -1))).toBe(true);
    expect(feed(instance, mono(137, 1))).toBe(true);
    expect(instance.port.sent).toHaveLength(2);

    // 128샘플(1)을 더하면 393+128=521 → 완전한 512프레임 하나 + 9샘플 rest.
    expect(feed(instance, mono(128, 1))).toBe(true);
    expect(instance.port.sent).toHaveLength(3);
    const frame = pcmOf(instance.port.sent[2]);
    expect(frame).toHaveLength(512);
    expect(frame.slice(0, 256)).toEqual(Array(256).fill(0));
    expect(frame.slice(256)).toEqual(Array(256).fill(32767));

    // flush: 남은 9샘플(1)을 패딩 없이 pcm으로 낸 뒤 flushed.
    send(instance, { type: "flush" });
    expect(instance.port.sent).toHaveLength(5);
    expect(pcmOf(instance.port.sent[3])).toEqual(Array(9).fill(32767));
    expect(instance.port.sent[4]).toEqual({ type: "flushed" });
  });

  it("flush 이후 process는 PCM을 내지 않고, flush를 두 번 보내도 flushed는 한 번만 온다", () => {
    const instance = new Processor();
    feed(instance, mono(128, 1)); // ready
    send(instance, { type: "begin" }); // begun
    send(instance, { type: "flush" }); // 누적된 rest가 없어 flushed만
    expect(instance.port.sent).toEqual([
      { type: "ready" },
      { type: "begun" },
      { type: "flushed" },
    ]);

    expect(feed(instance, mono(512, 1))).toBe(true);
    expect(instance.port.sent).toHaveLength(3); // finished 이후라 추가 메시지 없음

    send(instance, { type: "flush" });
    expect(instance.port.sent).toHaveLength(3); // 두 번째 flush는 무시된다
  });
});
