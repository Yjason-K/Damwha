from dataclasses import dataclass
from typing import Protocol


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
    def diarize(self, wav_path: str) -> list[DiarSegment]: ...


class Embedder(Protocol):
    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float]]: ...


class Transcriber(Protocol):
    def transcribe(self, wav_path: str, language: str) -> list[Word]: ...


class TextEmbedder(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...
