"""mlx-whisper transcription adapter (Apple Silicon).

Implements the `Transcriber` protocol. mlx-whisper runs on the Apple GPU via MLX
(not torch), so the pipeline `device` is irrelevant here. Returns word-level
timestamps. mlx-whisper handles long audio internally (windowed decoding), so no
manual chunking is needed for typical meeting lengths; `stt_chunk_minutes` is a
reserved knob for splitting very long files in a future pass.
"""

from .base import Word

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

    def transcribe(self, wav_path: str, language: str) -> list[Word]:
        import os

        import mlx.core as mx
        import mlx_whisper

        # job 내부 GPU 피크 억제: MLX active 메모리 상한(물리 메모리의 절반).
        # subprocess 격리는 job '간' 누적만 막고, 단독 process_meeting의 내부 피크는
        # 이 상한으로 방어한다. mlx 0.31 top-level API — 정확 심볼은 로컬 smoke에서 확인.
        _phys = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        mx.set_memory_limit(int(_phys * 0.5))

        result = mlx_whisper.transcribe(
            wav_path,
            path_or_hf_repo=self._repo,
            language=language,
            word_timestamps=True,
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
