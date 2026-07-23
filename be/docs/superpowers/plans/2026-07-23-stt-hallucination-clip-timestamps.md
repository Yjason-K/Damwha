# STT 환각 방어 + VAD clip_timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whisper 환각 방어 파라미터 2종을 두 transcriber 어댑터에 고정하고, Silero VAD 발화 구간만 STT가 디코딩하도록 `clip_timestamps`를 연결한다.

**Architecture:** `Transcriber` protocol에 `speech_spans` 선택 인자를 추가한다. 파이프라인(`process_meeting`)이 VAD span을 pure helper로 pad/clamp/merge 후 전달하고, 어댑터는 ms→초 flat list 변환만 담당한다. 빈 VAD면 STT 호출 자체를 생략한다. payload/DB 계약 변경 없음.

**Tech Stack:** Python 3.12, uv, pytest(+testcontainers Postgres), mlx-whisper 0.4.3 / faster-whisper 1.2.1 (실모델은 smoke 전용 — 테스트는 fake/stub만).

**Spec:** `docs/superpowers/specs/2026-07-23-stt-hallucination-clip-timestamps-design.md`

## Global Constraints

- payload/DB/zod/pydantic 계약 변경 금지 — worker 내부 변경만.
- 결정론 테스트 스위트는 실모델 import 금지 — 어댑터 테스트는 `sys.modules` stub 주입.
- 환각 방어 상수(두 어댑터 동일): `condition_on_previous_text=False`, `hallucination_silence_threshold=2.0`.
- span 전처리 기본 padding: `PAD_MS = 200`.
- `build_utterances`의 `failed_spans`에는 **전처리 전 원본 VAD span** 유지.
- 빈 VAD(전처리 후 span 0개) → transcriber 호출 생략 (`clip_timestamps=[]`는 "전체 오디오"로 해석될 수 있음).
- 모든 명령은 `be/worker/`에서 실행: `uv run pytest ...`, `uv run ruff check .`.
- 로그 detail에 카운트/길이만 — 텍스트·PII 금지 (`timing.py` 규칙).

---

### Task 1: `prepare_stt_spans` pure helper

**Files:**
- Create: `worker/damwha_worker/pipeline/stt_spans.py`
- Test: `worker/tests/test_stt_spans.py`

**Interfaces:**
- Consumes: `damwha_worker.models.base.SpeechSpan` (dataclass, `start_ms: int`, `end_ms: int`)
- Produces: `prepare_stt_spans(spans: list[SpeechSpan], duration_ms: int, pad_ms: int = 200) -> list[SpeechSpan]` — 정렬된 비겹침 span. Task 3이 이 시그니처를 그대로 호출.

- [ ] **Step 1: Write the failing tests**

```python
# worker/tests/test_stt_spans.py
from damwha_worker.models.base import SpeechSpan
from damwha_worker.pipeline.stt_spans import prepare_stt_spans


def test_pad_clamps_negative_start_to_zero():
    out = prepare_stt_spans([SpeechSpan(100, 500)], duration_ms=10_000)
    assert out == [SpeechSpan(0, 700)]


def test_pad_clamps_end_to_duration():
    out = prepare_stt_spans([SpeechSpan(9_900, 9_990)], duration_ms=10_000)
    assert out == [SpeechSpan(9_700, 10_000)]


def test_overlapping_spans_after_pad_are_merged():
    out = prepare_stt_spans([SpeechSpan(0, 1_000), SpeechSpan(1_300, 2_000)], duration_ms=5_000)
    assert out == [SpeechSpan(0, 2_200)]


def test_touching_spans_after_pad_are_merged():
    # pad 후 (0,1200)과 (1200,2200) — 맞닿음도 병합
    out = prepare_stt_spans([SpeechSpan(200, 1_000), SpeechSpan(1_400, 2_000)], duration_ms=5_000)
    assert out == [SpeechSpan(0, 2_200)]


def test_distant_spans_stay_separate():
    out = prepare_stt_spans([SpeechSpan(0, 500), SpeechSpan(3_000, 4_000)], duration_ms=10_000)
    assert out == [SpeechSpan(0, 700), SpeechSpan(2_800, 4_200)]


def test_invalid_and_out_of_range_spans_removed():
    out = prepare_stt_spans(
        [
            SpeechSpan(500, 500),        # end == start → 제거
            SpeechSpan(700, 600),        # end < start → 제거
            SpeechSpan(10_500, 11_000),  # duration 밖 → 제거
        ],
        duration_ms=10_000,
    )
    assert out == []


def test_empty_input_returns_empty():
    assert prepare_stt_spans([], duration_ms=10_000) == []


def test_unsorted_input_is_sorted():
    out = prepare_stt_spans([SpeechSpan(3_000, 4_000), SpeechSpan(0, 500)], duration_ms=10_000)
    assert out == [SpeechSpan(0, 700), SpeechSpan(2_800, 4_200)]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_stt_spans.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'damwha_worker.pipeline.stt_spans'`

- [ ] **Step 3: Write the implementation**

```python
# worker/damwha_worker/pipeline/stt_spans.py
"""VAD span → STT 입력 구간 전처리 (pure).

Silero VAD가 낸 발화 구간을 STT clip 입력으로 다듬는다: 경계 절단 완화를 위한
pad, 파일 범위 clamp, pad로 겹치거나 맞닿게 된 span 병합. 실패 분류(align의
failed_spans)에는 전처리 전 원본 span을 써야 한다 — pad는 STT 입력 확장일 뿐.
"""

from ..models.base import SpeechSpan

PAD_MS = 200


def prepare_stt_spans(
    spans: list[SpeechSpan], duration_ms: int, pad_ms: int = PAD_MS
) -> list[SpeechSpan]:
    valid = [
        s for s in spans if s.end_ms > s.start_ms and s.start_ms < duration_ms and s.end_ms > 0
    ]
    padded = sorted(
        (max(0, s.start_ms - pad_ms), min(duration_ms, s.end_ms + pad_ms)) for s in valid
    )
    merged: list[SpeechSpan] = []
    for start, end in padded:
        if merged and start <= merged[-1].end_ms:
            merged[-1] = SpeechSpan(merged[-1].start_ms, max(merged[-1].end_ms, end))
        else:
            merged.append(SpeechSpan(start, end))
    return merged
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest tests/test_stt_spans.py -v`
Expected: 8 PASS

- [ ] **Step 5: Lint + commit**

```bash
cd worker && uv run ruff check . && uv run ruff format damwha_worker/pipeline/stt_spans.py tests/test_stt_spans.py
git add worker/damwha_worker/pipeline/stt_spans.py worker/tests/test_stt_spans.py
git commit -m "feat(worker): add prepare_stt_spans helper (pad/clamp/merge VAD spans)"
```

---

### Task 2: Transcriber protocol 확장 + 어댑터 환각 방어/clip 변환

**Files:**
- Modify: `worker/damwha_worker/models/base.py:38-39` (Transcriber protocol)
- Modify: `worker/damwha_worker/models/whisper_mlx.py`
- Modify: `worker/damwha_worker/models/whisper_faster.py`
- Test: `worker/tests/test_whisper_adapters.py` (신규)

**Interfaces:**
- Consumes: `SpeechSpan` (Task 1과 동일 타입, 전처리는 호출자 책임)
- Produces: `Transcriber.transcribe(wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None) -> list[Word]` — Task 3의 파이프라인과 fake가 이 시그니처를 따름.

- [ ] **Step 1: Write the failing tests**

```python
# worker/tests/test_whisper_adapters.py
"""어댑터 계약 테스트 — 실모델 없이 sys.modules stub으로 kwargs를 검증한다."""

import sys
import types

from damwha_worker.models.base import SpeechSpan

SPANS = [SpeechSpan(500, 3_200), SpeechSpan(4_000, 9_900)]
FLAT_S = [0.5, 3.2, 4.0, 9.9]


def _install_fake_mlx(monkeypatch, calls):
    fake_core = types.ModuleType("mlx.core")
    fake_core.set_memory_limit = lambda n: None
    fake_mlx = types.ModuleType("mlx")
    fake_mlx.core = fake_core

    fake_whisper = types.ModuleType("mlx_whisper")

    def transcribe(wav_path, **kwargs):
        calls.append(kwargs)
        return {
            "segments": [
                {"words": [{"word": " 안녕", "start": 0.5, "end": 0.9, "probability": 0.9}]}
            ]
        }

    fake_whisper.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx", fake_mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", fake_core)
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_whisper)


def _install_fake_faster(monkeypatch, calls):
    fake_fw = types.ModuleType("faster_whisper")

    class WhisperModel:
        def __init__(self, size, device=None, compute_type=None):
            pass

        def transcribe(self, wav_path, **kwargs):
            calls.append(kwargs)
            word = types.SimpleNamespace(word=" 안녕", start=0.5, end=0.9, probability=0.9)
            return iter([types.SimpleNamespace(words=[word])]), None

    fake_fw.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_fw)


def test_mlx_passes_guards_and_clip(monkeypatch):
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    words = MlxWhisper("large-v3-turbo").transcribe("a.wav", "ko", SPANS)
    (kwargs,) = calls
    assert kwargs["clip_timestamps"] == FLAT_S
    assert kwargs["condition_on_previous_text"] is False
    assert kwargs["hallucination_silence_threshold"] == 2.0
    assert kwargs["word_timestamps"] is True
    assert [w.text for w in words] == ["안녕"]


def test_mlx_none_spans_omits_clip(monkeypatch):
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    MlxWhisper("large-v3-turbo").transcribe("a.wav", "ko")
    (kwargs,) = calls
    assert "clip_timestamps" not in kwargs


def test_faster_passes_guards_and_clip(monkeypatch):
    calls = []
    _install_fake_faster(monkeypatch, calls)
    from damwha_worker.models.whisper_faster import FasterWhisper

    words = FasterWhisper("large-v3-turbo", device="cpu").transcribe("a.wav", "ko", SPANS)
    (kwargs,) = calls
    assert kwargs["clip_timestamps"] == FLAT_S
    assert kwargs["condition_on_previous_text"] is False
    assert kwargs["hallucination_silence_threshold"] == 2.0
    assert kwargs["word_timestamps"] is True
    assert [w.text for w in words] == ["안녕"]


def test_faster_none_spans_omits_clip(monkeypatch):
    calls = []
    _install_fake_faster(monkeypatch, calls)
    from damwha_worker.models.whisper_faster import FasterWhisper

    FasterWhisper("large-v3-turbo", device="cpu").transcribe("a.wav", "ko")
    (kwargs,) = calls
    assert "clip_timestamps" not in kwargs
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_whisper_adapters.py -v`
Expected: FAIL — `TypeError: transcribe() takes 3 positional arguments but 4 were given` (clip/가드 kwargs 미전달 assert 실패 포함)

- [ ] **Step 3: Update protocol**

`worker/damwha_worker/models/base.py`의 Transcriber를 다음으로 교체:

```python
class Transcriber(Protocol):
    def transcribe(
        self, wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None
    ) -> list[Word]: ...
```

- [ ] **Step 4: Update mlx adapter**

`worker/damwha_worker/models/whisper_mlx.py` — 상수 추가 + transcribe 교체:

```python
from .base import SpeechSpan, Word

# 환각 방어(스펙 §1.3): 창 간 오류 전파(반복 루프) 차단 + 2초+ 무음 구간의 환각 의심
# 단어 제거. word_timestamps=True가 전제. 값 변경 = 코드 변경(payload 재현성).
_CONDITION_ON_PREVIOUS_TEXT = False
_HALLUCINATION_SILENCE_S = 2.0
```

`transcribe` 메서드:

```python
    def transcribe(
        self, wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None
    ) -> list[Word]:
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
```

- [ ] **Step 5: Update faster-whisper adapter**

`worker/damwha_worker/models/whisper_faster.py` — 동일 상수 추가 + transcribe 교체 (`vad_filter`는 켜지 않는다 — 파이프라인 Silero가 유일한 발화 구간 기준):

```python
from .base import SpeechSpan, Word

# 환각 방어(스펙 §1.3) — whisper_mlx.py와 동일 값 유지 (백엔드 간 동작 일치)
_CONDITION_ON_PREVIOUS_TEXT = False
_HALLUCINATION_SILENCE_S = 2.0
```

```python
    def transcribe(
        self, wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None
    ) -> list[Word]:
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
        words: list[Word] = []
        for segment in segments:  # generator
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
        return words
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd worker && uv run pytest tests/test_whisper_adapters.py -v`
Expected: 4 PASS

- [ ] **Step 7: Lint + commit**

```bash
cd worker && uv run ruff check . && uv run ruff format damwha_worker/models/base.py damwha_worker/models/whisper_mlx.py damwha_worker/models/whisper_faster.py tests/test_whisper_adapters.py
git add worker/damwha_worker/models/base.py worker/damwha_worker/models/whisper_mlx.py worker/damwha_worker/models/whisper_faster.py worker/tests/test_whisper_adapters.py
git commit -m "feat(worker): hallucination guards + clip_timestamps in whisper adapters"
```

---

### Task 3: 파이프라인 연결 + fake/기존 테스트 갱신 + 신규 파이프라인 테스트

**Files:**
- Modify: `worker/damwha_worker/pipeline/process_meeting.py:110-114` (stt stage)
- Modify: `worker/tests/fakes.py:28-33` (FakeTranscriber)
- Modify: `worker/tests/test_process_meeting.py:38,157` (빈 VAD 사용처)
- Test: `worker/tests/test_process_meeting.py` (신규 테스트 2개 추가)

**Interfaces:**
- Consumes: `prepare_stt_spans(spans, duration_ms)` (Task 1), `transcribe(wav, language, speech_spans=None)` (Task 2)
- Produces: 없음 (최종 소비자). FakeTranscriber는 `received_spans`(마지막 호출의 speech_spans)와 `calls`(호출 횟수) 속성 노출.

- [ ] **Step 1: Update FakeTranscriber**

`worker/tests/fakes.py`의 FakeTranscriber를 교체:

```python
class FakeTranscriber:
    def __init__(self, words: list[Word]) -> None:
        self._words = words
        self.received_spans: list[SpeechSpan] | None = None
        self.calls = 0

    def transcribe(
        self, wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None
    ) -> list[Word]:
        self.calls += 1
        self.received_spans = speech_spans
        return self._words
```

- [ ] **Step 2: Write the failing tests (신규 2개, test_process_meeting.py 끝에 추가)**

```python
def test_stt_receives_prepared_spans(conn, tmp_path):
    # VAD (100,900),(1000,1600) → pad 200 → (0,1100),(800,1800) → 병합 (0,1800)
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([SpeechSpan(100, 900), SpeechSpan(1000, 1600)]),
        diarizer=FakeDiarizer(
            [DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]
        ),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9), Word("반가워", 1100, 1500, 0.8)]),
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"
    assert models.transcriber.calls == 1
    assert models.transcriber.received_spans == [SpeechSpan(0, 1800)]


def test_empty_vad_skips_stt_and_yields_silence(conn, tmp_path):
    # VAD 0개 → transcriber 호출 생략, failed_spans=[]이므로 전 세그먼트 silence
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([]),
        diarizer=FakeDiarizer(
            [DiarSegment("SPEAKER_00", 0, 1000), DiarSegment("SPEAKER_01", 1000, 2000)]
        ),
        embedder=FakeEmbedder([[1.0] + [0.0] * 191, [0.0, 1.0] + [0.0] * 190]),
        transcriber=FakeTranscriber([Word("환각", 0, 500, 0.9)]),  # 호출되면 안 됨
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(2000),
    )
    assert out == "committed"
    assert models.transcriber.calls == 0
    rows = conn.execute(
        "SELECT status, text FROM utterance WHERE meeting_id=%s ORDER BY order_index", (mid,)
    ).fetchall()
    assert len(rows) == 2
    assert all(r["status"] == "silence" and r["text"] is None for r in rows)
```

- [ ] **Step 3: Run new tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_process_meeting.py::test_stt_receives_prepared_spans tests/test_process_meeting.py::test_empty_vad_skips_stt_and_yields_silence -v`
Expected: FAIL — `received_spans`가 None(파이프라인이 span을 안 넘김) / `calls == 0` assert 실패(가드 없어 호출됨)

- [ ] **Step 4: Wire pipeline**

`worker/damwha_worker/pipeline/process_meeting.py`:

import 추가 (기존 `from .stage import enter_stage` 아래):

```python
from .stt_spans import prepare_stt_spans
```

stt stage 블록(110-114행)을 교체:

```python
    # 6) STT — VAD 발화 구간만 디코딩(무음 환각 방지). 빈 VAD면 호출 자체를 생략
    #    (clip_timestamps=[]는 라이브러리가 '전체 오디오'로 해석할 수 있다).
    enter_stage(conn, job_id, worker_id, "stt", 75, shutdown_event)
    with timed_stage("stt", ctx) as t:
        prepared = prepare_stt_spans(speech_spans, duration_ms)
        if prepared:
            words = models.transcriber.transcribe(norm_path, payload.models.language, prepared)
        else:
            words = []
        clipped_ms = sum(s.end_ms - s.start_ms for s in prepared)
        t["detail"] = (
            f"words={len(words)} spans={len(prepared)} "
            f"clipped_ms={clipped_ms} duration_ms={duration_ms}"
        )
```

align 호출(`failed_spans=speech_spans`)은 **변경하지 않는다** — 원본 span 유지.

- [ ] **Step 5: Update existing tests that rely on empty VAD + transcription**

`worker/tests/test_process_meeting.py`:

38행 `_models()`의 FakeVAD 교체 (빈 VAD면 이제 STT가 생략되므로 발화 구간 필요):

```python
        vad=FakeVAD([SpeechSpan(0, 2000)]),
```

157행 `test_all_short_cluster_preserved_without_provisional_speaker`의 FakeVAD 교체 (probe 50ms, word (0,40)):

```python
        vad=FakeVAD([SpeechSpan(0, 40)]),
```

`test_partial_stt_failure_marks_transcribe_failed_per_segment`(219행)는 이미 비어있지 않은 VAD — 무변경.

- [ ] **Step 6: Run full worker suite**

Run: `cd worker && uv run pytest -q`
Expected: 전체 PASS (기존 + 신규 2개 + Task 1·2 테스트 포함, Docker 필요)

`test_stage_logs_emitted_with_counts`의 `words=2` assert는 새 detail 형식(`words=2 spans=1 clipped_ms=... duration_ms=2000`)에서도 부분 문자열로 통과한다. 실패 시 detail 형식 오타 확인.

- [ ] **Step 7: Lint + commit**

```bash
cd worker && uv run ruff check . && uv run ruff format damwha_worker/pipeline/process_meeting.py tests/fakes.py tests/test_process_meeting.py
git add worker/damwha_worker/pipeline/process_meeting.py worker/tests/fakes.py worker/tests/test_process_meeting.py
git commit -m "feat(worker): decode only VAD speech spans in STT, skip on empty VAD"
```

---

### Task 4: 살아있는 문서 갱신 + 최종 검증

**Files:**
- Modify: `docs/worker-architecture.md` (§6 단계별 의미 3·6, mermaid `vad --> stt` 엣지)
- Modify: `docs/reference/clova-note.md` (§5 매핑 표의 EPD 행 상태 갱신)

**Interfaces:**
- Consumes: Task 1–3 완료 상태
- Produces: 없음 (문서 + 검증)

- [ ] **Step 1: Update worker-architecture.md §6**

mermaid에서 `probe --> stt` 아래에 엣지 추가:

```
    vad --> stt
```

"단계별 의미" 3번 항목을 교체:

```markdown
3. **VAD** — 음성이 존재하는 구간을 구한다. 이 span은 (a) `prepare_stt_spans`(pad ±200ms → clamp → merge)를 거쳐 STT의 `clip_timestamps` 입력이 되고, (b) 원본 그대로 align 단계에서 `transcribe_failed`와 `silence`를 구분하는 데 사용된다.
```

6번 항목을 교체:

```markdown
6. **STT** — payload의 Whisper 모델과 language로 word timestamp를 생성한다. VAD 발화 구간만 디코딩하며(`clip_timestamps`, 무음 환각 방지), VAD가 비면 STT 호출을 생략한다. 두 어댑터 모두 `condition_on_previous_text=False`, `hallucination_silence_threshold=2.0`을 고정한다. Apple Silicon은 MLX, 그 외 환경은 faster-whisper adapter를 선택할 수 있다. stage 로그에 `words/spans/clipped_ms/duration_ms`를 남긴다 — `clipped_ms/duration_ms` 비율이 비정상적으로 낮으면 VAD false negative 의심 신호.
```

- [ ] **Step 2: Update clova-note.md §5 표의 EPD 행**

```markdown
| EPD/VAD 세그먼테이션 + 병렬 디코딩 | Silero VAD → `clip_timestamps` (발화 구간만 디코딩, 2026-07-23) | 부분. speech-only 디코딩은 반영. **병렬 Beam 디코딩 없음** — supervisor는 job당 자식 1개 직렬 |
```

- [ ] **Step 3: Final verification**

```bash
cd worker && uv run pytest -q && uv run ruff check .
```

Expected: 전체 PASS, lint clean

- [ ] **Step 4: Commit**

```bash
git add docs/worker-architecture.md docs/reference/clova-note.md
git commit -m "docs: reflect STT clip_timestamps + hallucination guards in living docs"
```

---

### Task 5 (수동, 계획 외 실행): 실모델 smoke

코드 태스크 아님 — 세션에서 사용자와 함께 실행. `uv sync --extra models` + HF_TOKEN 필요.

```bash
cd worker && uv run python scripts/smoke_process_meeting.py <회의 오디오 경로>
```

확인 항목 (스펙 §5.4): 반복 루프 소멸, 무음 구간 환각 텍스트 소멸, 발화 시작/끝 절단 여부, stt stage 로그의 `spans/clipped_ms/duration_ms` 출력.
