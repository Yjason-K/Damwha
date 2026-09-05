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
        self, words: list[Word], progress_steps: list[tuple[int, int]] | None = None
    ) -> None:
        self._words = words
        self._progress_steps = progress_steps or []
        self.received_spans: list[SpeechSpan] | None = None
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
        for done_ms, total_ms in self._progress_steps:
            if on_progress is not None:
                on_progress(done_ms, total_ms)
        return self._words


class FakeTextEmbedder:
    def __init__(
        self, vectors_by_text: dict[str, list[float]] | None = None, dim: int = 1024
    ) -> None:
        self._by_text = vectors_by_text or {}
        self._dim = dim

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._by_text.get(t, [0.0] * self._dim) for t in texts]


class FakeStreamingVAD:
    """프레임 인덱스 → 이벤트 목록. 시각(ms)은 세그먼터가 무시하므로 0으로 둔다."""

    def __init__(self, events: dict[int, list[tuple[str, int]]] | None = None) -> None:
        self._events = events or {}
        self.frames_seen = 0

    def process(self, pcm: bytes) -> list[tuple[str, int]]:
        i = self.frames_seen
        self.frames_seen += 1
        return list(self._events.get(i, []))

    def reset(self) -> None:
        self.frames_seen = 0


class SilenceSource:
    """stop()이 올 때까지 무음 프레임을 낸다 — stop 플래그·상한 시간 테스트용."""

    def __init__(self, interval_seconds: float = 0.005) -> None:
        import threading

        self._stop = threading.Event()
        self._interval = interval_seconds
        self.emitted = 0

    def frames(self):
        import time

        while not self._stop.is_set():
            self.emitted += 1
            yield b"\x00" * 1024
            time.sleep(self._interval)

    def stop(self) -> None:
        self._stop.set()


class RaisingSource:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def frames(self):
        raise self._exc
        yield  # noqa: RET503 — 제너레이터로 만들기 위한 도달 불가 yield

    def stop(self) -> None:
        pass
