/// <reference lib="webworker" />
/**
 * 오디오 스레드에서 도는 프로세서. 512샘플 int16 프레임을 메인 스레드로 보내고,
 * flush 명령에 자투리(0–511샘플)를 실어 보낸 뒤 종료를 알린다 (설계 §7).
 *
 * 여기서 하는 일을 최소로 유지한다 — 이 콜백이 늦으면 오디오가 끊긴다. 청크 묶기와
 * 업로드는 메인 스레드가 한다.
 *
 * `?worker&url`로 로드되지만(설계 §8) worker 빌드가 import를 번들하므로, 상수·타입은
 * pcm-convert.ts / pcm-worklet-protocol.ts를 그대로 import해 복제하지 않는다.
 */
import { FrameAccumulator } from "./pcm-convert";
import type { WorkletCommand, WorkletEvent } from "./pcm-worklet-protocol";

/**
 * lib.dom.d.ts에는 AudioWorkletGlobalScope가 없다 — registerProcessor()도
 * AudioWorkletProcessor도 타입이 없다. @types/audioworklet 같은 패키지도 설치돼 있지 않다.
 * 이 파일이 도는 스코프에서만 쓰는 최소 앰비언트 선언이다.
 *
 * `declare global`이 아니라 **모듈 스코프** declare다. tsconfig.app.json이
 * `moduleDetection: "force"`라 이 파일은 import 없이도 모듈이고, 따라서 이 선언들은
 * 이 파일 안에서만 보인다. global로 두면 의도적으로 최소·불완전한 이 타입이 프로그램
 * 전역에 노출되고, 훗날 TS가 진짜 AudioWorklet lib 타입을 실으면 중복 식별자로 충돌한다.
 * 런타임은 그대로다 — declare는 아무것도 방출하지 않고, 워크릿 스코프의 진짜 전역을 쓴다.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

class PcmProcessor extends AudioWorkletProcessor {
  private readonly frames = new FrameAccumulator();
  private began = false;
  private finished = false;
  private readySent = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<WorkletCommand>) => {
      const message = e.data;
      if (message.type === "begin" && !this.began) {
        this.began = true;
        this.port.postMessage({ type: "begun" } satisfies WorkletEvent);
      } else if (message.type === "flush" && !this.finished) {
        this.finished = true;
        const tail = this.frames.flush();
        if (tail.length)
          this.port.postMessage(
            { type: "pcm", pcm: tail.buffer } satisfies WorkletEvent,
            [tail.buffer],
          );
        this.port.postMessage({ type: "flushed" } satisfies WorkletEvent);
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // 무음이라도 유효한 입력이다 — begin 전에도 ready는 보낸다 (설계 §6).
    if (!this.readySent) {
      this.readySent = true;
      this.port.postMessage({ type: "ready" } satisfies WorkletEvent);
    }
    // begin 전/flush 후에는 누적하지 않는다 (설계 §7).
    if (!this.began || this.finished) return true;
    // 채널이 여럿이면 downmix한다. 첫 채널만 조용히 쓰면 정본이 달라진다 (설계 §2.3).
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < input.length; ch += 1) {
      for (let i = 0; i < n; i += 1) mono[i] += input[ch][i] / input.length;
    }
    for (const frame of this.frames.push(mono)) {
      this.port.postMessage(
        { type: "pcm", pcm: frame.buffer } satisfies WorkletEvent,
        [frame.buffer],
      );
    }
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
