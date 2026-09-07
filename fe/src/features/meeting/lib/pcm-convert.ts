/** 워커의 audio/source.py와 같은 값이어야 한다. 바꾸면 양쪽을 같이 바꾼다. */
export const SR = 16000;
export const FRAME_SAMPLES = 512;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
/** 청크 하나 = 16,384샘플 = 1.024초. 고정 크기라야 서버가 파일 크기만으로 다음 오프셋을 안다. */
export const CHUNK_SAMPLES = 16384;
export const CHUNK_BYTES = CHUNK_SAMPLES * 2;

export function floatToInt16(input: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * 임의 길이의 Float32 입력을 512샘플 int16 프레임으로 자른다.
 *
 * AudioWorkletProcessor.process()의 렌더 퀀텀은 통상 128이지만 스펙이 보장하지 않는다.
 * 128을 하드코딩하면 다른 값을 주는 브라우저에서 정본이 조용히 달라진다 (설계 §2.3).
 */
export class FrameAccumulator {
  private rest = new Float32Array(0);

  push(samples: Float32Array): Int16Array<ArrayBuffer>[] {
    const buf = new Float32Array(this.rest.length + samples.length);
    buf.set(this.rest);
    buf.set(samples, this.rest.length);
    const frames: Int16Array<ArrayBuffer>[] = [];
    let at = 0;
    while (buf.length - at >= FRAME_SAMPLES) {
      frames.push(floatToInt16(buf.subarray(at, at + FRAME_SAMPLES)));
      at += FRAME_SAMPLES;
    }
    this.rest = buf.slice(at);
    return frames;
  }

  /** 남은 rest를 int16로 변환해 반환하고 비운다. Worklet 종료 시 자투리(0–511샘플)를
   *  잃지 않고 내보내는 데 쓴다 (설계 §7). */
  flush(): Int16Array<ArrayBuffer> {
    const tail = floatToInt16(this.rest);
    this.rest = new Float32Array(0);
    return tail;
  }
}

/**
 * 실제 샘플 수로 16,384샘플(32,768바이트)씩 청크를 낸다 — 프레임 개수가 아니다.
 * 입력 길이가 얼마든(512샘플 프레임이든 Worklet 종료 시의 1–511샘플 꼬리든) 받아서,
 * 완전한 청크가 여러 개 쌓였으면 전부 반환한다. flush는 남은 꼬리를 패딩 없이 그대로 준다.
 */
export class ChunkAccumulator {
  private rest = new Int16Array(0);

  push(samples: Int16Array): Uint8Array[] {
    const buf = new Int16Array(this.rest.length + samples.length);
    buf.set(this.rest);
    buf.set(samples, this.rest.length);
    const chunks: Uint8Array[] = [];
    let at = 0;
    while (buf.length - at >= CHUNK_SAMPLES) {
      chunks.push(this.bytesOf(buf.subarray(at, at + CHUNK_SAMPLES)));
      at += CHUNK_SAMPLES;
    }
    this.rest = buf.slice(at);
    return chunks;
  }

  flush(): Uint8Array {
    const out = this.bytesOf(this.rest);
    this.rest = new Int16Array(0);
    return out;
  }

  private bytesOf(samples: Int16Array): Uint8Array {
    return new Uint8Array(samples.slice().buffer);
  }
}
