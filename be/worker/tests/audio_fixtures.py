"""테스트용 16 kHz 모노 int16 WAV 생성기 — 표준 wave만 쓴다(models extra 불필요)."""

import struct
import wave

FRAME_SAMPLES = 512


def frame_bytes(value: int) -> bytes:
    """샘플값이 전부 value인 프레임 1개(1024바이트)."""
    return struct.pack("<h", value) * FRAME_SAMPLES


def make_wav(path: str, frames: int, *, sample_rate: int = 16000, tail_samples: int = 0) -> str:
    """frames개 프레임(프레임 i의 샘플값은 i)을 담은 WAV. tail_samples는 프레임 경계
    밖에 남는 자투리 샘플 수 — FileSource가 버려야 한다."""
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        for i in range(frames):
            w.writeframes(frame_bytes(i))
        if tail_samples:
            w.writeframes(struct.pack("<h", 0) * tail_samples)
    return path
