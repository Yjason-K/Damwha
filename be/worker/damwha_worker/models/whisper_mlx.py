"""mlx-whisper transcription adapter (Apple Silicon).

Implements the `Transcriber` protocol. mlx-whisper runs on the Apple GPU via MLX
(not torch), so the pipeline `device` is irrelevant here. Returns word-level
timestamps. mlx-whisper handles long audio internally (windowed decoding), so no
manual chunking is needed for typical meeting lengths; `stt_chunk_minutes` is a
reserved knob for splitting very long files in a future pass.
"""

from .base import SpeechSpan, Word

# 환각 방어(스펙 §1.3): 창 간 오류 전파(반복 루프) 차단 + 2초+ 무음 구간의 환각 의심
# 단어 제거. word_timestamps=True가 전제. 값 변경 = 코드 변경(payload 재현성).
_CONDITION_ON_PREVIOUS_TEXT = False
_HALLUCINATION_SILENCE_S = 2.0

# payload whisper_model → MLX-converted HF repo (mlx-community)
_REPO = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}


class MlxWhisper:
    def __init__(self, whisper_model: str) -> None:
        if whisper_model not in _REPO:
            raise ValueError(
                f"unknown whisper_model {whisper_model!r}; expected one of {list(_REPO)}"
            )
        self._repo = _REPO[whisper_model]

    def transcribe(
        self, wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None
    ) -> list[Word]:
        if speech_spans is not None and not speech_spans:
            # 빈 리스트 = '발화 없음' — clip_timestamps=[]가 '전체 오디오'로 해석되는
            # 것을 방어. None만 전체 파일 전사를 의미한다.
            return []

        import os

        import mlx.core as mx
        import mlx_whisper

        # job 내부 GPU 피크 억제: MLX active 메모리 상한(물리 메모리의 절반).
        # subprocess 격리는 job '간' 누적만 막고, 단독 process_meeting의 내부 피크는
        # 이 상한으로 방어한다. mlx 0.31 top-level API — 정확 심볼은 로컬 smoke에서 확인.
        _phys = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        mx.set_memory_limit(int(_phys * 0.5))

        extra: dict = {}
        if speech_spans:
            # 발화 구간만 디코딩 — [start_s, end_s, ...] flat 초 리스트
            extra["clip_timestamps"] = [
                t for s in speech_spans for t in (s.start_ms / 1000, s.end_ms / 1000)
            ]
        result = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=self._repo,
            language=language,
            word_timestamps=True,
            condition_on_previous_text=_CONDITION_ON_PREVIOUS_TEXT,
            hallucination_silence_threshold=_HALLUCINATION_SILENCE_S,
            **extra,
        )
        words: list[Word] = []
        for segment in result.get("segments", []):
            for w in segment.get("words", []):
                text = w["word"].strip()
                if not text:
                    continue
                words.append(
                    Word(
                        text=text,
                        start_ms=int(w["start"] * 1000),
                        end_ms=int(w["end"] * 1000),
                        confidence=w.get("probability"),
                    )
                )
        return words
