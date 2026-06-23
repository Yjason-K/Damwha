"""SpeechBrain ECAPA-TDNN speaker-embedding adapter.

Implements the `Embedder` protocol: one 192-d voiceprint vector per diar segment.
The worker normalizes to 16 kHz mono, which is what ECAPA expects.
"""

from .base import DiarSegment

_SR = 16000
_DIM = 192  # spkrec-ecapa-voxceleb embedding dimension


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

    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float]]:
        import soundfile as sf
        import torch

        audio, sr = sf.read(wav_path, dtype="float32")
        if audio.ndim > 1:  # safety: collapse to mono
            audio = audio.mean(axis=1)

        out: list[list[float]] = []
        for seg in segments:
            start = int(seg.start_ms / 1000 * sr)
            end = int(seg.end_ms / 1000 * sr)
            clip = audio[start:end]
            if clip.size < int(0.1 * sr):  # < 100 ms → too short to embed reliably
                out.append([0.0] * _DIM)
                continue
            tensor = torch.from_numpy(clip).float().unsqueeze(0)  # [1, samples]
            emb = self._encoder.encode_batch(tensor).squeeze().tolist()  # [192]
            out.append(emb)
        return out
