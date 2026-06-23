"""Assemble the four real model adapters from a job payload + worker settings.

`build_models` is imported only inside `__main__.main()` (the real worker), never
by the test suite — so the heavy/gated model imports stay out of CI.

Model selection is the PAYLOAD's responsibility (reproducibility): the diarization
model, embedding model, whisper model, and device all come from `payload["models"]`.
Settings provide only infra: the HF token and the STT backend choice.
"""

from ..config import Settings
from ..pipeline.process_meeting import Models
from .ecapa_embed import EcapaEmbedder
from .pyannote_diar import PyannoteDiarizer
from .silero_vad import SileroVAD


def build_models(payload: dict, settings: Settings) -> Models:
    m = payload["models"]
    device = m["device"]

    if settings.whisper_backend == "mlx":
        from .whisper_mlx import MlxWhisper

        transcriber = MlxWhisper(m["whisper_model"])
    else:
        from .whisper_faster import FasterWhisper

        transcriber = FasterWhisper(m["whisper_model"], device=device)

    return Models(
        vad=SileroVAD(),
        diarizer=PyannoteDiarizer(m["diarization"]["model"], settings.hf_token, device),
        embedder=EcapaEmbedder(m["embedding"]["model"], device),
        transcriber=transcriber,
    )
