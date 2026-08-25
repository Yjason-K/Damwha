from damwha_worker.models.base import DiarSegment, SpeechSpan, Word


class FakeVAD:
    def __init__(self, spans: list[SpeechSpan]) -> None:
        self._spans = spans

    def detect(self, wav_path: str) -> list[SpeechSpan]:
        return self._spans


class FakeDiarizer:
    def __init__(self, segments: list[DiarSegment]) -> None:
        self._segments = segments

    def diarize(
        self, wav_path: str, min_speakers: int | None = None, max_speakers: int | None = None
    ) -> list[DiarSegment]:
        self.last_bounds = (min_speakers, max_speakers)
        return self._segments


class FakeEmbedder:
    def __init__(self, vectors: list[list[float] | None]) -> None:
        self._vectors = vectors

    def embed(self, wav_path: str, segments) -> list[list[float] | None]:
        return self._vectors


class FakeTranscriber:
    def __init__(
        self,
        words: list[Word],
        progress_steps: list[tuple[int, int]] | None = None,
        later_words: list[list[Word]] | None = None,
    ) -> None:
        self._words = words
        # 두 번째 호출부터 순서대로 돌려줄 단어 목록 (겹침 재전사 단계용). 소진되면 [].
        self._later_words = list(later_words or [])
        self._progress_steps = progress_steps or []
        self.received_spans: list[SpeechSpan] | None = None
        self.spans_history: list[list[SpeechSpan] | None] = []
        self.calls = 0

    def transcribe(
        self,
        wav_path: str,
        language: str,
        speech_spans: list[SpeechSpan] | None = None,
        *,
        on_progress=None,
    ) -> list[Word]:
        self.calls += 1
        self.received_spans = speech_spans
        self.spans_history.append(speech_spans)
        for done_ms, total_ms in self._progress_steps:
            if on_progress is not None:
                on_progress(done_ms, total_ms)
        if self.calls == 1:
            return self._words
        return self._later_words.pop(0) if self._later_words else []


class FakeTextEmbedder:
    def __init__(
        self, vectors_by_text: dict[str, list[float]] | None = None, dim: int = 1024
    ) -> None:
        self._by_text = vectors_by_text or {}
        self._dim = dim

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._by_text.get(t, [0.0] * self._dim) for t in texts]
