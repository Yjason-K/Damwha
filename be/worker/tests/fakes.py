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


class FakeTextEmbedder:
    def __init__(self, vectors_by_text: dict[str, list[float]] | None = None, dim: int = 1024) -> None:
        self._by_text = vectors_by_text or {}
        self._dim = dim

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._by_text.get(t, [0.0] * self._dim) for t in texts]
