from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

# 전사 진행 보고: (처리된 오디오 ms, 처리할 총 오디오 ms). clip/segment 하나가 끝날
# 때마다 호출된다. speech_spans 없이(전체 파일) 호출되면 총량을 모르므로 보고하지 않는다.
ProgressFn = Callable[[int, int], None]


@dataclass
class SpeechSpan:
    start_ms: int
    end_ms: int


@dataclass
class DiarSegment:
    diar_label: str
    start_ms: int
    end_ms: int


@dataclass
class Word:
    text: str
    start_ms: int
    end_ms: int
    confidence: float | None


class VAD(Protocol):
    def detect(self, wav_path: str) -> list[SpeechSpan]: ...


class Diarizer(Protocol):
    def diarize(
        self, wav_path: str, min_speakers: int | None = None, max_speakers: int | None = None
    ) -> list[DiarSegment]: ...


class Embedder(Protocol):
    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float] | None]: ...


class Transcriber(Protocol):
    def transcribe(
        self,
        wav_path: str,
        language: str,
        speech_spans: list[SpeechSpan] | None = None,
        *,
        on_progress: ProgressFn | None = None,
    ) -> list[Word]: ...


class TextEmbedder(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...
