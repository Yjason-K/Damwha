import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

log = logging.getLogger("damwha_worker")

# 전사 진행 보고: (처리된 오디오 ms, 처리할 총 오디오 ms). clip/segment 하나가 끝날
# 때마다 호출된다. speech_spans 없이(전체 파일) 호출되면 총량을 모르므로 보고하지 않는다.
ProgressFn = Callable[[int, int], None]

# payload의 language 카탈로그 중 유일하게 코드가 아닌 값 (@damwha/contracts STT_LANGUAGES).
# Whisper는 언어를 하나만 받으므로 '여러 언어'는 이 계약에 없다 — auto는 '지정하지 않음'이다.
AUTO_LANGUAGE = "auto"


def whisper_language(language: str) -> str | None:
    """payload의 language를 whisper 인자로 옮긴다. `auto` → None(자동 감지)."""
    return None if language == AUTO_LANGUAGE else language


def log_stt_filters(stock_dropped: list[str], repetition_dropped: int) -> None:
    """두 어댑터가 STT 후처리로 버린 것을 같은 모양으로 남긴다. 버린 게 없으면 조용하다.

    상투구 필터의 기준값(`stt_stock_phrases.MAX_CONFIDENCE`)은 회의 두 건으로 정했다 —
    진짜 인사가 잘리는지 운영 로그로 볼 수 있어야 한다. 버린 텍스트는 정의상 상투구뿐이라
    회의 내용이 새지 않는다. 반복 루프는 수백 단어라 개수만 남긴다.
    """
    if stock_dropped:
        log.info(
            "stt dropped %d stock-phrase segment(s): %s",
            len(stock_dropped),
            " | ".join(stock_dropped),
        )
    if repetition_dropped:
        log.info("stt dropped %d repetition-loop word(s)", repetition_dropped)


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


class StreamingVAD(Protocol):
    """프레임 단위 VAD. 이벤트는 ("start", ms) 또는 ("end", ms), ms는 스트림 시작 기준.
    세그먼터는 자체 프레임 계수로 경계를 잡으므로 ms는 로그용이다."""

    def process(self, pcm: bytes) -> list[tuple[str, int]]: ...

    def reset(self) -> None: ...
