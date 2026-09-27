"""mlx-whisper transcription adapter (Apple Silicon).

Implements the `Transcriber` protocol. mlx-whisper runs on the Apple GPU via MLX
(not torch), so the pipeline `device` is irrelevant here. Returns word-level
timestamps. mlx-whisper handles long audio internally (windowed decoding), so no
manual chunking is needed for typical meeting lengths; `stt_chunk_minutes` is a
reserved knob for splitting very long files in a future pass.
"""

from ..pipeline.stt_repetition import drop_repetition_loops
from .base import ProgressFn, SpeechSpan, Word, whisper_language
from .specs import MLX_WHISPER_REPOS as _REPO

# 환각 방어(스펙 §1.3): 창 간 오류 전파(반복 루프) 차단 + 2초+ 무음 구간의 환각 의심
# 단어 제거. word_timestamps=True가 전제. 값 변경 = 코드 변경(payload 재현성).
_CONDITION_ON_PREVIOUS_TEXT = False
_HALLUCINATION_SILENCE_S = 2.0


class MlxWhisper:
    def __init__(self, whisper_model: str) -> None:
        if whisper_model not in _REPO:
            raise ValueError(
                f"unknown whisper_model {whisper_model!r}; expected one of {list(_REPO)}"
            )
        self._repo = _REPO[whisper_model]

    def _snapshot(self, local_files_only: bool) -> str:
        """저장소를 로컬 스냅샷 디렉터리로 푼다 — `load_model`이 하는 것과 같은 호출이다.

        `mlx_whisper.transcribe(path_or_hf_repo=...)`에는 `local_files_only`가 없고,
        `load_models.load_model`은 경로가 존재하지 않을 때만 `snapshot_download(repo_id=...)`를
        부른다. 그래서 우리가 먼저 풀어 **경로를** 넘긴다 — 경로면 hub를 아예 타지 않는다.
        """
        from huggingface_hub import snapshot_download

        return snapshot_download(repo_id=self._repo, local_files_only=local_files_only)

    def transcribe(
        self,
        wav_path: str,
        language: str,
        speech_spans: list[SpeechSpan] | None = None,
        *,
        on_progress: ProgressFn | None = None,
    ) -> list[Word]:
        if speech_spans is not None and not speech_spans:
            # 빈 리스트 = '발화 없음' — clip_timestamps=[]가 '전체 오디오'로 해석되는
            # 것을 방어. None만 전체 파일 전사를 의미한다.
            return []

        import os

        import mlx.core as mx
        import mlx_whisper
        from mlx_whisper.audio import load_audio

        from .downloads import load_cache_first

        # 캐시 우선 (스펙 §6.6-b). mlx-whisper의 `snapshot_download`는 먹통 네트워크에서 캐시가
        # 차 있어도 무한 대기한다(실측 900초 초과) — 캐시가 있으면 그 호출 자체를 없앤다.
        model_path = load_cache_first(self._repo, self._snapshot)

        # job 내부 GPU 피크 억제: MLX active 메모리 상한(물리 메모리의 절반).
        # subprocess 격리는 job '간' 누적만 막고, 단독 process_meeting의 내부 피크는
        # 이 상한으로 방어한다. mlx 0.31 top-level API — 정확 심볼은 로컬 smoke에서 확인.
        _phys = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        mx.set_memory_limit(int(_phys * 0.5))

        # 오디오는 한 번만 디코드한다. 아래 clip 루프는 span당 transcribe()를 개별
        # 호출하는데, 경로를 넘기면 mlx_whisper가 호출마다 파일 전체를 ffmpeg로 다시
        # 디코드한다(WAV는 I/O 비용뿐이지만 FLAC은 디코드 CPU가 clip 수만큼 곱해진다).
        # mx.array까지 미리 만들어 호출당 numpy→mx 복사도 없앤다. clip_timestamps는
        # 배열 입력에서도 같은 '초 단위 절대 시각'으로 해석된다.
        audio = mx.array(load_audio(wav_path))

        # 'auto'는 language를 비워 mlx_whisper가 감지하게 한다. 단 감지는 호출마다
        # 다시 일어나고(앞 30초로 매번), 아래 루프는 clip마다 개별 호출한다 — 그대로
        # 두면 인코더 forward가 clip 수만큼 반복된다(73-clip 파일이면 73회). 첫 호출이
        # 돌려준 언어를 이후 호출에 넘겨 감지를 1회로 묶는다. 감지 대상은 어차피 파일
        # 앞 30초라 clip마다 다시 감지해도 같은 답이 나온다.
        lang = whisper_language(language)

        def _run(**extra) -> dict:
            nonlocal lang
            result = mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=model_path,
                language=lang,
                word_timestamps=True,
                condition_on_previous_text=_CONDITION_ON_PREVIOUS_TEXT,
                hallucination_silence_threshold=_HALLUCINATION_SILENCE_S,
                **extra,
            )
            if lang is None:
                lang = result.get("language")
            return result

        if speech_spans:
            # 발화 구간만 디코딩하되 clip마다 개별 호출한다. 다수 clip을 한 번에 넘기면
            # mlx-whisper의 seek 루프가 일부 clip 출력을 드랍한다(로컬 재현: 73-clip
            # 호출에서 특정 clip 무출력, 동일 clip 단독 호출은 정상). 모델 가중치는
            # mlx_whisper 내부 캐시라 호출당 재로드 비용은 없다.
            total_ms = sum(s.end_ms - s.start_ms for s in speech_spans)
            done_ms = 0
            results = []
            for span in speech_spans:
                results.append(_run(clip_timestamps=[span.start_ms / 1000, span.end_ms / 1000]))
                done_ms += span.end_ms - span.start_ms
                if on_progress is not None:
                    on_progress(done_ms, total_ms)
        else:
            results = [_run()]

        words: list[Word] = []
        for result in results:
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
        # 디코더 축퇴 출력은 decode 파라미터로 못 막는다 — stt_repetition 모듈 주석 참고
        return drop_repetition_loops(words)
