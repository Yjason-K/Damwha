"""모델에 넘길 파형을 메모리로 읽는 단일 진입점 — torchaudio/torchcodec를 타지 않는다.

torchaudio 2.9+는 자체 디코딩 백엔드를 제거하고 `torchaudio.load()`를 torchcodec에
위임한다. 그런데 torchcodec가 들고 오는 dylib는 FFmpeg 4~8(libavutil ≤ 60)에만
링크돼 있고, Homebrew ffmpeg 9는 libavutil.61만 설치한다. 그래서 파일 '경로'를
넘기는 로드는 전부 dlopen 단계에서 죽는다(실측: silero read_audio → torchaudio.load
→ torchcodec import 실패로 vad 스테이지 전멸, job_102).

워커는 어떤 모델이 돌기 전에 이미 16 kHz mono FLAC으로 정규화한다
(pipeline/ffmpeg.py). FLAC은 libsndfile 네이티브 포맷이라 soundfile로 바로 읽히므로,
모델에는 경로 대신 여기서 디코딩한 파형을 넘긴다 — 시스템 ffmpeg 버전과 무관해진다.

무거운 import(numpy/soundfile/torch)는 함수 안에서 한다. models extra 없이도
모듈 import가 되어야 CI가 순수 헬퍼를 검증할 수 있다.
"""

SR = 16000


class UnexpectedSampleRate(ValueError):
    """정규화를 건너뛴 파일이 들어왔다 — 리샘플링은 여기서 하지 않는다."""


def ensure_sample_rate(sr: int, expected: int = SR) -> int:
    """정규화 계약(16 kHz)을 강제한다. 어긋나면 조용히 리샘플하지 않고 실패시킨다."""
    if sr != expected:
        raise UnexpectedSampleRate(
            f"expected {expected} Hz audio, got {sr} Hz — "
            "run pipeline.ffmpeg.normalize() on the source file first"
        )
    return sr


def load_mono(path: str, *, expected_sr: int = SR):
    """(float32 1-D numpy 파형, sample_rate)를 돌려준다."""
    import numpy as np
    import soundfile as sf

    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    ensure_sample_rate(sr, expected_sr)
    if audio.ndim > 1:  # safety: 정규화가 mono를 보장하지만 방어적으로 접는다
        audio = audio.mean(axis=1)
    return np.ascontiguousarray(audio, dtype="float32"), sr


def load_mono_tensor(path: str, *, expected_sr: int = SR):
    """(float32 1-D torch 텐서 [samples], sample_rate)를 돌려준다."""
    import torch

    audio, sr = load_mono(path, expected_sr=expected_sr)
    return torch.from_numpy(audio), sr
