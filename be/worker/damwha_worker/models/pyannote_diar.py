"""pyannote.audio 3.1 diarization adapter.

Implements the `Diarizer` protocol. pyannote/speaker-diarization-3.1 is a GATED
model — requires an accepted license + HF token (passed as `use_auth_token`).
"""

from .base import DiarSegment


def _torch_device(device: str):
    import torch

    # pyannote/speechbrain run on torch; mlx (whisper) is separate.
    if device == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    if device == "mps" and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class PyannoteDiarizer:
    def __init__(self, model: str, hf_token: str | None, device: str) -> None:
        from pyannote.audio import Pipeline

        # pyannote.audio 4.x renamed the auth param: use_auth_token → token
        pipeline = Pipeline.from_pretrained(model, token=hf_token)
        if pipeline is None:
            # from_pretrained returns None when the license isn't accepted / token is bad
            raise RuntimeError(
                f"failed to load gated diarization model {model!r} — "
                "check HF_TOKEN and that the model license is accepted on HuggingFace"
            )
        self._pipeline = pipeline.to(_torch_device(device))

    def diarize(self, wav_path: str) -> list[DiarSegment]:
        output = self._pipeline(wav_path)
        # pyannote 4.x returns a DiarizeOutput dataclass; .speaker_diarization is
        # the Annotation. Older versions return the Annotation directly.
        annotation = getattr(output, "speaker_diarization", output)
        segments: list[DiarSegment] = []
        for turn, _, label in annotation.itertracks(yield_label=True):
            segments.append(DiarSegment(str(label), int(turn.start * 1000), int(turn.end * 1000)))
        segments.sort(key=lambda s: s.start_ms)
        return segments
