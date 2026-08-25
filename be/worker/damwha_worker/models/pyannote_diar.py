"""pyannote.audio 3.1 diarization adapter.

Implements the `Diarizer` protocol. pyannote/speaker-diarization-community-1 is a GATED
model — requires an accepted license + HF token (passed as `use_auth_token`).
"""

from .base import DiarSegment


class PyannoteDiarizer:
    def __init__(self, model: str, hf_token: str | None, device: str) -> None:
        import torch
        from pyannote.audio import Pipeline

        # pyannote.audio 4.x renamed the auth param: use_auth_token → token
        pipeline = Pipeline.from_pretrained(model, token=hf_token)
        if pipeline is None:
            # from_pretrained returns None when the license isn't accepted / token is bad
            raise RuntimeError(
                f"failed to load gated diarization model {model!r} — "
                "check HF_TOKEN and that the model license is accepted on HuggingFace"
            )
        # device는 registry의 torch_device()가 이미 검증한 'mps'|'cpu' — 폴백 없음 (spec §6)
        self._pipeline = pipeline.to(torch.device(device))

    @classmethod
    def from_pipeline(cls, pipeline) -> "PyannoteDiarizer":
        """이미 로드된 pipeline 객체를 감싼다 (테스트용 — 게이트 모델 없이 호출 계약 검증)."""
        self = cls.__new__(cls)
        self._pipeline = pipeline
        return self

    def diarize(
        self, wav_path: str, min_speakers: int | None = None, max_speakers: int | None = None
    ) -> list[DiarSegment]:
        from .audio_io import load_mono_tensor

        # pyannote의 경로 입력은 내부 Audio가 torchaudio.load() → torchcodec를 탄다
        # (ffmpeg 9에서 dlopen 실패). in-memory 파형 dict은 그 디코더를 건너뛴다 —
        # pyannote가 경고문에서 직접 안내하는 우회로다. 파형은 (channel, time).
        wav, sr = load_mono_tensor(wav_path)
        # 화자 수 상/하한은 payload의 diarization.min/max_speakers. None이면 kwargs에서
        # 아예 빼서 pipeline 기본값(자동 추정)을 그대로 쓴다.
        bounds = {
            k: v
            for k, v in (("min_speakers", min_speakers), ("max_speakers", max_speakers))
            if v is not None
        }
        output = self._pipeline({"waveform": wav.unsqueeze(0), "sample_rate": sr}, **bounds)
        # pyannote 4.x returns a DiarizeOutput dataclass; .speaker_diarization is
        # the Annotation. Older versions return the Annotation directly.
        annotation = getattr(output, "speaker_diarization", output)
        segments: list[DiarSegment] = []
        for turn, _, label in annotation.itertracks(yield_label=True):
            segments.append(DiarSegment(str(label), int(turn.start * 1000), int(turn.end * 1000)))
        segments.sort(key=lambda s: s.start_ms)
        return segments
