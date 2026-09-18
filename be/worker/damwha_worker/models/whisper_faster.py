"""faster-whisper transcription adapter (CUDA / CPU, non-Apple-Silicon).

Implements the `Transcriber` protocol. Selected when the payload's `devices.stt`
is `cpu` (mlx-whisper handles `gpu`). Runs on CPU on Apple Silicon so the light
preset's cpu STT stays available there; kept for CUDA portability too.
"""

from ..pipeline.stt_repetition import drop_repetition_loops
from .base import ProgressFn, SpeechSpan, Word, whisper_language

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


def _repo_id(size: str) -> str:
    """faster-whisper가 그 크기 이름으로 내려받는 HF 저장소 — `model_readiness`의 key다.

    이름→저장소 표를 여기에 베끼지 않는다. `large-v3-turbo`는 `Systran/…`이 아니라
    `mobiuslabsgmbh/…`이고, 그런 예외를 손으로 옮기면 조용히 갈린다. 표를 못 읽으면(모듈 없음 ·
    상수 이름 변경) 크기 이름 그대로를 쓴다 — 보고의 key가 덜 정확할 뿐 적재는 그대로 돈다.
    """
    if "/" in size:
        return size
    try:
        from faster_whisper.utils import _MODELS
    except ImportError:
        return size
    return _MODELS.get(size, size)


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

        from .downloads import load_cache_first

        size = _MODEL.get(whisper_model, whisper_model)
        compute_type = "float16" if device == "cuda" else "int8"
        # 캐시 우선 (스펙 §6.6-b). `download_model`이 자기 `tqdm_class`(disabled_tqdm)를 넘기므로
        # 이 경로는 훅의 진행 보고에서 빠지고 무진행 감시도 안 붙는다(알려진 한계) — 그래서
        # 캐시 우선이 더 중요하다. 캐시가 차 있으면 네트워크 호출이 0건이라 먹통 네트워크에서도
        # 멈추지 않는다.
        self._model = load_cache_first(
            _repo_id(size),
            lambda local_files_only: WhisperModel(
                size,
                device="cuda" if device == "cuda" else "cpu",
                compute_type=compute_type,
                local_files_only=local_files_only,
            ),
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
        # 'auto' → None. faster-whisper는 한 호출 안에서 스스로 한 번만 감지하므로
        # mlx 쪽의 재사용 배선이 필요 없다.
        segments, _info = self._model.transcribe(
            wav_path,
            language=whisper_language(language),
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
