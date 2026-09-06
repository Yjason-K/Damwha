/** 워커의 audio/source.py와 같은 값이어야 한다. 바꾸면 양쪽을 같이 바꾼다. */
export const SR = 16000;
export const FRAME_SAMPLES = 512;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
/** 청크 하나 = 32프레임 = 1.024초. 고정 크기라야 서버가 파일 크기만으로 다음 오프셋을 안다. */
export const CHUNK_FRAMES = 32;
export const CHUNK_BYTES = FRAME_BYTES * CHUNK_FRAMES;

export function floatToInt16(input: Float32Array): Int16Array {
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

  push(samples: Float32Array): Int16Array[] {
    const buf = new Float32Array(this.rest.length + samples.length);
    buf.set(this.rest);
    buf.set(samples, this.rest.length);
    const frames: Int16Array[] = [];
    let at = 0;
    while (buf.length - at >= FRAME_SAMPLES) {
      frames.push(floatToInt16(buf.subarray(at, at + FRAME_SAMPLES)));
      at += FRAME_SAMPLES;
    }
    this.rest = buf.slice(at);
    return frames;
  }
}

/** 프레임을 32개씩 묶어 청크로 낸다. flush는 남은 꼬리를 패딩 없이 그대로 준다. */
export class ChunkAccumulator {
  private frames: Int16Array[] = [];

  push(frame: Int16Array): Uint8Array | null {
    this.frames.push(frame);
    return this.frames.length >= CHUNK_FRAMES ? this.take() : null;
  }

  flush(): Uint8Array {
    return this.take();
  }

  private take(): Uint8Array {
    const out = new Uint8Array(this.frames.length * FRAME_BYTES);
    this.frames.forEach((f, i) =>
      out.set(
        new Uint8Array(f.buffer, f.byteOffset, FRAME_BYTES),
        i * FRAME_BYTES,
      ),
    );
    this.frames = [];
    return out;
  }
}
