import { SR } from "./pcm-convert";

/**
 * 시스템 오디오 큐의 상한 — 0.5초. 시스템 오디오와 마이크는 서로 다른 장치 시계로 돌아 조금씩 어긋나고(drift),
 * 큐가 무한히 자라면 상대 목소리가 내 목소리보다 점점 늦게 섞인다. 넘치면 오래된 샘플부터 버려 지연을 이 안에 묶는다.
 */
export const MAX_SYSTEM_LAG_SAMPLES = SR / 2;

/**
 * 데스크톱 헬퍼가 보내는 시스템 오디오(16 kHz·mono·int16 LE 바이트)를 마이크 프레임에 샘플 단위로 더한다.
 *
 * 마이크가 시계다: 섞인 결과의 길이는 언제나 마이크 프레임과 같다. 그래야 업로드 오프셋·경과 시간의 근거가
 * 지금과 똑같이 마이크 하나로 남는다. 시스템 오디오가 모자라면 그 자리는 무음(0)이고, 남으면 다음 프레임에 쓴다.
 */
export class SystemAudioMixer {
  private queue = new Int16Array(0);
  /** 청크가 샘플 중간에서 잘려 온 홀수 바이트. 다음 청크의 첫 바이트와 이어 한 샘플을 만든다. */
  private carry: number | null = null;

  pushBytes(bytes: Uint8Array): void {
    let input = bytes;
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      input = joined;
      this.carry = null;
    }
    if (input.length % 2 === 1) {
      this.carry = input[input.length - 1];
      input = input.subarray(0, input.length - 1);
    }
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const samples = new Int16Array(input.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true);

    const merged = new Int16Array(this.queue.length + samples.length);
    merged.set(this.queue);
    merged.set(samples, this.queue.length);
    this.queue =
      merged.length > MAX_SYSTEM_LAG_SAMPLES
        ? merged.slice(merged.length - MAX_SYSTEM_LAG_SAMPLES)
        : merged;
  }

  mixInto(mic: Int16Array): Int16Array<ArrayBuffer> {
    const out = new Int16Array(mic.length);
    const n = Math.min(mic.length, this.queue.length);
    for (let i = 0; i < mic.length; i += 1) {
      const sum = mic[i] + (i < n ? this.queue[i] : 0);
      out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
    }
    this.queue = this.queue.slice(n);
    return out;
  }

  /** 녹음 시계가 0이 되는 begin에서 부른다 — 그 전에 쌓인 시스템 오디오는 녹음 앞의 소리다. */
  reset(): void {
    this.queue = new Int16Array(0);
    this.carry = null;
  }
}
