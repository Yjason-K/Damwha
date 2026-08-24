"""SpeechBrain ECAPA-TDNN speaker-embedding adapter.

Implements the `Embedder` protocol: one 192-d voiceprint vector per diar segment,
or None when the clip is too short to embed reliably.
The worker normalizes to 16 kHz mono, which is what ECAPA expects.
"""

from .base import DiarSegment

_SR = 16000
_DIM = 192  # spkrec-ecapa-voxceleb embedding dimension
_MIN_EMBED_MS = 100  # 이보다 짧은 클립은 임베딩 신뢰 불가 → None


def too_short_for_embedding(n_samples: int, sr: int) -> bool:
    return n_samples < int(_MIN_EMBED_MS / 1000 * sr)


class EcapaEmbedder:
    def __init__(self, model: str, device: str) -> None:
        from speechbrain.inference.speaker import EncoderClassifier

        # ECAPA is tiny; run it on CPU even when the pipeline device is 'mps' —
        # SpeechBrain's MPS op-coverage is unreliable and the speedup here is
        # marginal. pyannote (diarization) and mlx-whisper still use the GPU.
        run_device = "cpu" if device == "mps" else device
        self._encoder = EncoderClassifier.from_hparams(
            source=model, run_opts={"device": run_device}
        )

    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float] | None]:
        import soundfile as sf
        import torch

        audio, sr = sf.read(wav_path, dtype="float32")
        if audio.ndim > 1:  # safety: collapse to mono
            audio = audio.mean(axis=1)

        out: list[list[float] | None] = []
        for seg in segments:
            start = int(seg.start_ms / 1000 * sr)
            end = int(seg.end_ms / 1000 * sr)
            clip = audio[start:end]
            if too_short_for_embedding(clip.size, sr):
                out.append(None)
                continue
            tensor = torch.from_numpy(clip).float().unsqueeze(0)  # [1, samples]
            emb = self._encoder.encode_batch(tensor).squeeze().tolist()  # [192]
            out.append(emb)
        return out
