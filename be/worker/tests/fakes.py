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


class BackloggedSource:
    """MicSource와 같은 구조 — 콜백이 앞서 채운 큐를 frames()가 비운다.

    stop()이 이미 쌓인 프레임 *뒤에* sentinel을 넣으므로 stop() 뒤에도 프레임이 계속
    나온다. 실제 마이크가 정확히 그렇다(PortAudio 콜백이 소비자보다 앞서 큐를 채운다).
    종료 순서가 틀려 writer가 캡처보다 먼저 끝나면 그 꼬리가 파일에서 사라지는데,
    프레임이 즉시 고갈되는 FileSource로는 그 창이 열리지 않아 잡히지 않는다.
    """

    def __init__(self, frames: int, *, interval_seconds: float = 0.003) -> None:
        import queue

        self._q: queue.Queue = queue.Queue()
        for _ in range(frames):
            self._q.put(b"\x00" * 1024)
        self._interval = interval_seconds
        self.emitted = 0

    def frames(self):
        import time

        while True:
            pcm = self._q.get()
            if pcm is None:
                return
            time.sleep(self._interval)
            self.emitted += 1
            yield pcm

    def stop(self) -> None:
        self._q.put(None)
