"""Assemble the four real model adapters from a job payload + worker settings.

`build_models` is imported only inside `__main__.main()` (the real worker), never
by the test suite — so the heavy/gated model imports stay out of CI.

Model selection is the PAYLOAD's responsibility (reproducibility): the diarization
model, embedding model, whisper model, and per-stage devices all come from the
payload (normalized via `parse_models`). The STT backend follows `devices.stt`
(gpu → mlx-whisper, cpu → faster-whisper). Settings provide only infra: the HF token.
"""

from ..config import Settings
from ..contracts import parse_models
from ..pipeline.process_meeting import Models
from .device import torch_device
from .ecapa_embed import EcapaEmbedder
from .pyannote_diar import PyannoteDiarizer
from .silero_vad import SileroVAD


def build_models(payload: dict, settings: Settings) -> Models:
    m = parse_models(payload)  # v1/v2/v3 정규화 (contracts)

    if m.devices.stt == "gpu":
        from .whisper_mlx import MlxWhisper  # ImportError → classify가 PERMANENT

        transcriber = MlxWhisper(m.whisper_model)
    else:
        from .whisper_faster import FasterWhisper

        transcriber = FasterWhisper(m.whisper_model, device="cpu")

    diar_device = torch_device(m.devices.diarization)
    return Models(
        vad=SileroVAD(),
        diarizer=PyannoteDiarizer(m.diarization.model, settings.hf_token, diar_device),
        embedder=EcapaEmbedder(m.embedding.model, "cpu"),  # ECAPA는 CPU 고정 (기존 사유 유지)
        transcriber=transcriber,
    )


def build_embedder(payload: dict, settings: Settings) -> EcapaEmbedder:
    # enroll payload엔 models 블록 없음; ECAPA는 CPU 고정
    return EcapaEmbedder(payload["embedding"]["model"], "cpu")


def build_text_embedder(settings: Settings):
    from .bge_embed import BgeM3TextEmbedder

    return BgeM3TextEmbedder(settings.search_embedding_model)


def build_live_models(payload: dict, settings: Settings):
    """live_session payload → 세션 자식이 상주시킬 세 모델. pyannote는 안 뜬다 (설계 §5.1)."""
    from ..pipeline.live_session import LiveModels
    from .silero_vad import StreamingSileroVAD

    m = parse_models(payload["process"])
    if m.devices.stt == "gpu":
        from .whisper_mlx import MlxWhisper

        transcriber = MlxWhisper(m.whisper_model)
    else:
        from .whisper_faster import FasterWhisper

        transcriber = FasterWhisper(m.whisper_model, device="cpu")
    return LiveModels(
        transcriber=transcriber,
        embedder=EcapaEmbedder(m.embedding.model, "cpu"),
        vad=StreamingSileroVAD(),
    )
