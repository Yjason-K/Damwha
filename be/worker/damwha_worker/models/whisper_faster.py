"""faster-whisper transcription adapter (CUDA / CPU, non-Apple-Silicon).

Implements the `Transcriber` protocol. Selected when `WHISPER_BACKEND=faster`.
Not exercised on Apple Silicon (which uses mlx-whisper), kept for portability.
"""

from .base import Word

_MODEL = {
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
