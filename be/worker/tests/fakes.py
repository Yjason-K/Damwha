from damwha_worker.models.base import DiarSegment, SpeechSpan, Word


class FakeVAD:
    def __init__(self, spans: list[SpeechSpan]) -> None:
        self._spans = spans

    def detect(self, wav_path: str) -> list[SpeechSpan]:
        return self._spans


class FakeDiarizer:
    def __init__(self, segments: list[DiarSegment]) -> None:
        self._segments = segments

    def diarize(self, wav_path: str) -> list[DiarSegment]:
        return self._segments


class FakeEmbedder:
    def __init__(self, vectors: list[list[float]]) -> None:
        self._vectors = vectors

    def embed(self, wav_path: str, segments) -> list[list[float]]:
        return self._vectors


class FakeTranscriber:
    def __init__(self, words: list[Word]) -> None:
        self._words = words

    def transcribe(self, wav_path: str, language: str) -> list[Word]:
        return self._words
