"""faster-whisper transcription adapter (CUDA / CPU, non-Apple-Silicon).

Implements the `Transcriber` protocol. Selected when the payload's `devices.stt`
is `cpu` (mlx-whisper handles `gpu`). Runs on CPU on Apple Silicon so the light
preset's cpu STT stays available there; kept for CUDA portability too.
"""

from ..pipeline.stt_repetition import drop_repetition_loops
from .base import ProgressFn, SpeechSpan, Word

# 환각 방어(스펙 §1.3) — whisper_mlx.py와 동일 값 유지 (백엔드 간 동작 일치)
_CONDITION_ON_PREVIOUS_TEXT = False
_HALLUCINATION_SILENCE_S = 2.0

_MODEL = {
    "tiny": "tiny",
    "base": "base",
    "small": "small",
    "medium": "medium",
    "large-v3-turbo": "large-v3-turbo",
    "large-v3": "large-v3",
}


def _clipped_done_ms(spans: list[SpeechSpan], position_ms: int) -> int:
    """오디오 절대 시각을 '처리한 clip 오디오 누적 ms'로 환산한다.

    faster-whisper는 clip 목록을 한 번에 받고 segment를 흘리므로, 진행률의 분모(총
    clip 길이)와 같은 단위로 맞춰야 mlx 경로와 같은 의미의 퍼센트가 나온다.
    """
    done = 0
    for span in spans:
        if position_ms >= span.end_ms:
            done += span.end_ms - span.start_ms
        elif position_ms > span.start_ms:
            done += position_ms - span.start_ms
            break
        else:
            break
    return done


class FasterWhisper:
    def __init__(self, whisper_model: str, device: str) -> None:
        from faster_whisper import WhisperModel

        size = _MODEL.get(whisper_model, whisper_model)
        compute_type = "float16" if device == "cuda" else "int8"
        self._model = WhisperModel(
            size, device="cuda" if device == "cuda" else "cpu", compute_type=compute_type
        )

    def transcribe(
        self,
        wav_path: str,
        language: str,
        speech_spans: list[SpeechSpan] | None = None,
        *,
        on_progress: ProgressFn | None = None,
    ) -> list[Word]:
        if speech_spans is not None and not speech_spans:
            # 빈 리스트 = '발화 없음' — whisper_mlx.py와 동일 방어. None만 전체 파일 전사.
            return []

        extra: dict = {}
        if speech_spans:
            extra["clip_timestamps"] = [
                t for s in speech_spans for t in (s.start_ms / 1000, s.end_ms / 1000)
            ]
        segments, _info = self._model.transcribe(
            wav_path,
            language=language,
            word_timestamps=True,
            condition_on_previous_text=_CONDITION_ON_PREVIOUS_TEXT,
            hallucination_silence_threshold=_HALLUCINATION_SILENCE_S,
            **extra,
        )
        total_ms = sum(s.end_ms - s.start_ms for s in speech_spans) if speech_spans else 0
        words: list[Word] = []
        for segment in segments:  # generator
            if on_progress is not None and speech_spans:
                on_progress(_clipped_done_ms(speech_spans, int(segment.end * 1000)), total_ms)
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
        # faster-whisper도 같은 upstream 로직을 물려받는다 — stt_repetition 모듈 주석 참고
        return drop_repetition_loops(words)
