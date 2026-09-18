"""pyannote.audio 3.1 diarization adapter.

Implements the `Diarizer` protocol. pyannote/speaker-diarization-community-1 is a GATED
model — requires an accepted license + HF token (passed as `use_auth_token`).
"""

from .. import errors
from .base import DiarSegment


def _raise_auth_failure(model: str, exc: BaseException) -> None:
    """HF의 401·403을 서로 다른 PERMANENT로 바꿔 던진다. 그 밖의 실패는 그대로 둔다.

    pyannote 4.x의 `download_from_hf_hub`는 HTTP 오류를 안내문만 찍고 다시 던진다 — 예전 코드는
    그것을 잡지 않아 `errors.classify`가 "uncategorized" TRANSIENT로 받아 재시도만 반복했다.
    둘은 재시도로 풀리지 않고 필요한 조치가 다르다 (스펙 §8): 401은 토큰 재입력, 403은 게이트 모델의
    사용 조건 수락. 게이트 체인의 하위 모델도 같은 저장소 안이라 링크는 `model` 하나다.
    """
    status = errors.http_status(exc)
    if status == 401:
        raise errors.WorkerError(
            errors.HF_TOKEN_INVALID,
            f"Hugging Face rejected the token while loading {model!r} (401) — "
            "the HF token is missing or invalid; enter a valid token and restart the service",
            errors.ErrorKind.PERMANENT,
        ) from exc
    if status == 403:
        raise errors.WorkerError(
            errors.HF_GATE_NOT_ACCEPTED,
            f"access to the gated model {model!r} was refused (403) — accept its user "
            f"conditions at https://huggingface.co/{model} with the account that owns the token",
            errors.ErrorKind.PERMANENT,
        ) from exc


class PyannoteDiarizer:
    def __init__(self, model: str, hf_token: str | None, device: str) -> None:
        import torch
        from pyannote.audio import Pipeline

        from .downloads import load_cache_first

        # pyannote.audio 4.x renamed the auth param: use_auth_token → token
        # 캐시 우선 (스펙 §6.6-b). `from_pretrained`에도 `local_files_only`가 없다 — 훅이 hub
        # 호출에 끼워 넣는다. 게이트 체인의 하위 모델까지 같은 컨텍스트 안에서 적재되므로
        # 한 번의 시도로 3-모델 체인 전체가 오프라인이 된다.
        try:
            pipeline = load_cache_first(
                model, lambda **_: Pipeline.from_pretrained(model, token=hf_token)
            )
        except Exception as exc:
            _raise_auth_failure(model, exc)
            raise
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
