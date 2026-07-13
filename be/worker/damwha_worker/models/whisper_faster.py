"""faster-whisper transcription adapter (CUDA / CPU, non-Apple-Silicon).

Implements the `Transcriber` protocol. Selected when the payload's `devices.stt`
is `cpu` (mlx-whisper handles `gpu`). Runs on CPU on Apple Silicon so the light
preset's cpu STT stays available there; kept for CUDA portability too.
"""

from .base import Word

_MODEL = {
    "tiny": "tiny",
    "base": "base",
    "small": "small",
    "medium": "medium",
    "large-v3-turbo": "large-v3-turbo",
    "large-v3": "large-v3",
}


class FasterWhisper:
    def __init__(self, whisper_model: str, device: str) -> None:
        from faster_whisper import WhisperModel

        size = _MODEL.get(whisper_model, whisper_model)
        compute_type = "float16" if device == "cuda" else "int8"
        self._model = WhisperModel(
            size, device="cuda" if device == "cuda" else "cpu", compute_type=compute_type
        )

    def transcribe(self, wav_path: str, language: str) -> list[Word]:
        segments, _info = self._model.transcribe(wav_path, language=language, word_timestamps=True)
        words: list[Word] = []
        for segment in segments:  # generator
            for w in segment.words or []:
                text = w.word.strip()
                if not text:
                    continue
                words.append(
                    Word(
                        text=text,
                        start_ms=int(w.start * 1000),
                        end_ms=int(w.end * 1000),
                        confidence=w.probability,
                    )
                )
        return words
