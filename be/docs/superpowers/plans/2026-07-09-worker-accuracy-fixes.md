# Worker 정확도 수정 2건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zero-vector 임베딩 sentinel을 `None` 계약으로 교체(centroid 오염·쓰레기 voiceprint 차단)하고, `transcribe_failed`/`silence` 판정을 세그먼트별로 정확하게 만든다.

**Architecture:** 워커 내부만 변경 — `Embedder` 프로토콜 반환 타입에 `None` 허용(짧은 클립), centroid 계산에서 `None` 제외, enroll에서 `None`이면 PERMANENT 실패. `process_meeting`은 VAD spans를 align에 무조건 전달. 기존 오염 voiceprint는 일회성 SQL 마이그레이션으로 삭제.

**Tech Stack:** Python 3.12 (uv, pytest, testcontainers), pgvector 0.8 (`vector_norm`), Jest (마이그레이션 테스트).

**Spec:** `docs/superpowers/specs/2026-07-09-worker-accuracy-fixes-design.md`

## Global Constraints

- **계약/API 불변:** `src/contracts/`, `worker/damwha_worker/contracts.py`, NestJS `src/` 코드 변경 금지. 마이그레이션은 새 numbered 파일 1개만 추가(기존 파일 편집 금지).
- **테스트는 Docker 필요** (testcontainers가 `damwha/postgres-bigm:pg16` 컨테이너 구동).
- Worker 명령은 전부 `worker/` 디렉토리에서: `uv run pytest -q`, `uv run ruff check .`, `uv run ruff format .`
- API(jest) 명령은 리포 루트에서, Node 22 (`nvm use`): `npx jest test/migration.spec.ts`
- "너무 짧음" 기준은 기존과 동일: **100ms 미만** (`clip.size < int(0.1 * sr)`과 동치).
- 무거운 ML import는 함수/메서드 내부에만 (`ecapa_embed.py`의 top-level import는 `.base`뿐 — 유지).

## File Structure

| 파일 | 책임 |
|---|---|
| `worker/damwha_worker/models/base.py` | `Embedder` 프로토콜 반환 타입 `list[list[float] \| None]` |
| `worker/damwha_worker/models/ecapa_embed.py` | 순수 헬퍼 `too_short_for_embedding` + 짧은 클립 `None` 반환 |
| `worker/damwha_worker/pipeline/identify.py` | `None` 제외 centroid, `None` centroid는 DB 조회 없이 미식별 |
| `worker/damwha_worker/pipeline/enroll_speaker.py` | `None` 임베딩 → PERMANENT `sample_too_short` |
| `worker/damwha_worker/errors.py` | `SAMPLE_TOO_SHORT` 코드 상수 |
| `worker/damwha_worker/pipeline/process_meeting.py` | `failed_spans=speech_spans` 무조건 전달 (1줄) |
| `worker/tests/fakes.py` | `FakeEmbedder` 타입 힌트에 `None` 허용 |
| `worker/tests/test_ecapa_helpers.py` (신규) | 순수 헬퍼 경계값 테스트 |
| `worker/tests/test_identify.py` | `None` 필터/유지 테스트 추가 |
| `worker/tests/test_process_meeting.py` | all-short cluster e2e + 부분 STT 실패 caller-level 회귀 테스트 |
| `worker/tests/test_enroll_speaker.py` | `sample_too_short` PERMANENT + speaker `failed` 테스트 |
| `src/database/migrations/006_delete_zero_voiceprints.sql` (신규) | 기존 zero-vector voiceprint 일회성 삭제 |
| `test/migration.spec.ts` | 006 테스트 추가 |

---

### Task 1: Embedder 계약 변경 — 짧은 클립은 `None` (헬퍼 + ECAPA + fake)

**Files:**
- Create: `worker/tests/test_ecapa_helpers.py`
- Modify: `worker/damwha_worker/models/ecapa_embed.py`
- Modify: `worker/damwha_worker/models/base.py:34-35`
- Modify: `worker/tests/fakes.py:20-25`

**Interfaces:**
- Consumes: 없음 (기존 코드만).
- Produces: `too_short_for_embedding(n_samples: int, sr: int) -> bool` (모듈 수준 순수 함수, `worker/damwha_worker/models/ecapa_embed.py`). `Embedder.embed(...) -> list[list[float] | None]` — 이후 Task 2(centroid), Task 3(enroll)가 이 `None` 의미론에 의존. `FakeEmbedder`는 `None` 원소를 받을 수 있다.

- [ ] **Step 1: 실패하는 헬퍼 테스트 작성**

`worker/tests/test_ecapa_helpers.py` 생성:

```python
"""too_short_for_embedding 순수 헬퍼 테스트.

실 ECAPA 어댑터의 "너무 짧음" 분기 기준을 CI에서 직접 검증한다
(ecapa_embed.py의 top-level import는 .base뿐이라 models extra 없이 import 가능).
어댑터 end-to-end는 SMOKE 소관.
"""

from damwha_worker.models.ecapa_embed import too_short_for_embedding

_SR = 16000


def test_below_100ms_is_too_short():
    assert too_short_for_embedding(int(0.099 * _SR), _SR) is True


def test_100ms_and_above_is_ok():
    # 경계: 정확히 100ms(1600 samples @16k)는 임베딩 가능 (기존 < 비교와 동치)
    assert too_short_for_embedding(int(0.1 * _SR), _SR) is False
    assert too_short_for_embedding(_SR, _SR) is False


def test_zero_samples_is_too_short():
    assert too_short_for_embedding(0, _SR) is True
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_ecapa_helpers.py -q`
Expected: FAIL — `ImportError: cannot import name 'too_short_for_embedding'`

- [ ] **Step 3: 구현**

`worker/damwha_worker/models/ecapa_embed.py` — 헬퍼 추가 + zero sentinel 제거. 전체 변경 후 모습:

```python
"""SpeechBrain ECAPA-TDNN speaker-embedding adapter.

Implements the `Embedder` protocol: one 192-d voiceprint vector per diar segment,
or None when the clip is too short to embed reliably.
The worker normalizes to 16 kHz mono, which is what ECAPA expects.
"""

from .base import DiarSegment

_SR = 16000
_DIM = 192  # spkrec-ecapa-voxceleb embedding dimension
_MIN_EMBED_MS = 100  # 이보다 짧은 클립은 임베딩 신뢰 불가 → None


def too_short_for_embedding(n_samples: int, sr: int) -> bool:
    return n_samples < int(_MIN_EMBED_MS / 1000 * sr)


class EcapaEmbedder:
    def __init__(self, model: str, device: str) -> None:
        from speechbrain.inference.speaker import EncoderClassifier

        # ECAPA is tiny; run it on CPU even when the pipeline device is 'mps' —
        # SpeechBrain's MPS op-coverage is unreliable and the speedup here is
        # marginal. pyannote (diarization) and mlx-whisper still use the GPU.
        run_device = "cpu" if device == "mps" else device
        self._encoder = EncoderClassifier.from_hparams(
            source=model, run_opts={"device": run_device}
        )

    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float] | None]:
        import soundfile as sf
        import torch

        audio, sr = sf.read(wav_path, dtype="float32")
        if audio.ndim > 1:  # safety: collapse to mono
            audio = audio.mean(axis=1)

        out: list[list[float] | None] = []
        for seg in segments:
            start = int(seg.start_ms / 1000 * sr)
            end = int(seg.end_ms / 1000 * sr)
            clip = audio[start:end]
            if too_short_for_embedding(clip.size, sr):
                out.append(None)
                continue
            tensor = torch.from_numpy(clip).float().unsqueeze(0)  # [1, samples]
            emb = self._encoder.encode_batch(tensor).squeeze().tolist()  # [192]
            out.append(emb)
        return out
```

`worker/damwha_worker/models/base.py` — `Embedder` 프로토콜 교체:

```python
class Embedder(Protocol):
    def embed(self, wav_path: str, segments: list[DiarSegment]) -> list[list[float] | None]: ...
```

`worker/tests/fakes.py` — `FakeEmbedder` 교체:

```python
class FakeEmbedder:
    def __init__(self, vectors: list[list[float] | None]) -> None:
        self._vectors = vectors

    def embed(self, wav_path: str, segments) -> list[list[float] | None]:
        return self._vectors
```

- [ ] **Step 4: 테스트 통과 + 기존 스위트 회귀 없음 확인**

Run (in `worker/`): `uv run pytest tests/test_ecapa_helpers.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS (기존 테스트는 `None` 안 쓰므로 무회귀)
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/models/ecapa_embed.py worker/damwha_worker/models/base.py worker/tests/fakes.py worker/tests/test_ecapa_helpers.py
git commit -m "feat(worker): embedder returns None for too-short clips instead of zero sentinel"
```

---

### Task 2: centroid에서 `None` 제외 + `None` centroid 미식별 처리

**Files:**
- Modify: `worker/damwha_worker/pipeline/identify.py`
- Test: `worker/tests/test_identify.py` (추가), `worker/tests/test_process_meeting.py` (추가)

**Interfaces:**
- Consumes: Task 1의 `Embedder.embed -> list[list[float] | None]`, `FakeEmbedder([None, ...])`.
- Produces: `centroids_by_label(segments, embeddings) -> dict[str, list[float] | None]` (라벨은 항상 유지, 유효 임베딩 0개면 값 `None`). `identify_clusters`는 `None` centroid를 DB 조회 없이 미식별(`None`) 처리. persist(`db.py`)는 변경 없음 — centroid `None` cluster는 기존 분기가 speaker/voiceprint 없이 보존.

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_identify.py`에 추가:

```python
def test_centroids_skip_none_embeddings():
    # None(너무 짧은 클립)은 평균을 희석하지 않는다
    segs = [DiarSegment("S0", 0, 1), DiarSegment("S0", 1, 2)]
    embs = [[1.0, 0.0] + [0.0] * 190, None]
    c = centroids_by_label(segs, embs)
    assert c["S0"] == [1.0, 0.0] + [0.0] * 190


def test_centroids_all_none_label_kept_with_none_centroid():
    # 전부 짧은 라벨도 dict에 남는다 (cluster row 보존 경로) — 값만 None
    segs = [DiarSegment("S0", 0, 1), DiarSegment("S1", 1, 2)]
    embs = [None, [1.0] + [0.0] * 191]
    c = centroids_by_label(segs, embs)
    assert set(c) == {"S0", "S1"}
    assert c["S0"] is None
    assert c["S1"] is not None


def test_identify_none_centroid_is_unidentified_without_db_query(conn):
    # threshold=0.0이면 어떤 voiceprint든 매칭되므로, None이 나오는 것 자체가
    # DB 조회를 타지 않았다는 증거다
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    out = identify_clusters(
        conn,
        {"S0": None},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.0,
    )
    assert out["S0"] is None
```

`worker/tests/test_process_meeting.py`에 추가 (파일 상단 import는 기존 그대로 — `FakeVAD` 등 이미 있음):

```python
def test_all_short_cluster_preserved_without_provisional_speaker(conn, tmp_path):
    # 전부 100ms 미만인 클러스터: cluster row는 centroid 없이 보존되고,
    # provisional speaker / zero voiceprint는 생성되지 않는다
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([]),
        diarizer=FakeDiarizer([DiarSegment("SPEAKER_00", 0, 50)]),
        embedder=FakeEmbedder([None]),  # <100ms → 임베딩 없음
        transcriber=FakeTranscriber([Word("짧다", 0, 40, 0.9)]),
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(50),
    )
    assert out == "committed"
    cl = conn.execute(
        "SELECT centroid, resolved_speaker_id FROM meeting_cluster WHERE meeting_id=%s", (mid,)
    ).fetchall()
    assert len(cl) == 1
    assert cl[0]["centroid"] is None and cl[0]["resolved_speaker_id"] is None
    assert conn.execute("SELECT count(*) AS c FROM speaker", ()).fetchone()["c"] == 0
    assert conn.execute("SELECT count(*) AS c FROM voiceprint", ()).fetchone()["c"] == 0
    utt = conn.execute(
        "SELECT speaker_id, text FROM utterance WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert utt["speaker_id"] is None and utt["text"] == "짧다"
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_identify.py tests/test_process_meeting.py -q`
Expected: 신규 4개 FAIL — `centroids_by_label`이 `None`에서 `TypeError`(`len(None)` 또는 `None[i]`), `identify_clusters`가 `None` centroid로 `_vec(None)` 시도.

- [ ] **Step 3: 구현**

`worker/damwha_worker/pipeline/identify.py` — `centroids_by_label`와 `identify_clusters` 교체 (`_normalize`, `_vec`는 그대로):

```python
def centroids_by_label(
    segments: list[DiarSegment], embeddings: list[list[float] | None]
) -> dict[str, list[float] | None]:
    # None(너무 짧은 클립)은 평균에서 제외한다. 유효 임베딩이 하나도 없는
    # 라벨도 dict에 남긴다(값 None) — persist의 cluster 보존 경로가 라벨을 쓴다.
    groups: dict[str, list[list[float]]] = {}
    for seg, emb in zip(segments, embeddings, strict=True):
        groups.setdefault(seg.diar_label, [])
        if emb is not None:
            groups[seg.diar_label].append(emb)
    out: dict[str, list[float] | None] = {}
    for label, vecs in groups.items():
        if not vecs:
            out[label] = None
            continue
        dim = len(vecs[0])
        mean = [sum(v[i] for v in vecs) / len(vecs) for i in range(dim)]
        out[label] = _normalize(mean)
    return out
```

```python
def identify_clusters(conn, centroids, model, dimension, threshold) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for label, centroid in centroids.items():
        if centroid is None:
            out[label] = None  # 임베딩 불가 라벨 — DB 조회 없이 미식별
            continue
        row = conn.execute(
            """
            SELECT v.speaker_id, 1 - (v.embedding <=> %s::vector) AS similarity
            FROM voiceprint v
            JOIN speaker s ON s.id = v.speaker_id
            WHERE v.model = %s AND v.dimension = %s AND s.enrollment_status = 'ready'
            ORDER BY v.embedding <=> %s::vector ASC
            LIMIT 1
            """,
            (_vec(centroid), model, dimension, _vec(centroid)),
        ).fetchone()
        out[label] = row["speaker_id"] if row and row["similarity"] >= threshold else None
    return out
```

- [ ] **Step 4: 테스트 통과 확인**

Run (in `worker/`): `uv run pytest tests/test_identify.py tests/test_process_meeting.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/identify.py worker/tests/test_identify.py worker/tests/test_process_meeting.py
git commit -m "fix(worker): exclude None embeddings from centroids; skip identification for centroidless clusters"
```

---

### Task 3: enroll — `None` 임베딩은 PERMANENT `sample_too_short`

**Files:**
- Modify: `worker/damwha_worker/errors.py:36-40` (Permanent codes 블록)
- Modify: `worker/damwha_worker/pipeline/enroll_speaker.py`
- Test: `worker/tests/test_enroll_speaker.py` (추가)

**Interfaces:**
- Consumes: Task 1의 `FakeEmbedder([None])`.
- Produces: `errors.SAMPLE_TOO_SHORT = "sample_too_short"` 상수. `run_enroll_speaker`는 임베딩 `None`이면 `WorkerError(SAMPLE_TOO_SHORT, ..., ErrorKind.PERMANENT)`를 raise — 기존 `handle_job` → `db.fail_enroll` 경로가 job `failed` + speaker `enrollment_status='failed'` 처리 (신규 코드 불요).

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_enroll_speaker.py`에 추가. 파일 상단 import 블록에 다음을 보강:

```python
import pytest

from damwha_worker.__main__ import handle_job
from damwha_worker.errors import ErrorKind, WorkerError
```

테스트 2개 추가:

```python
def test_enroll_too_short_sample_raises_permanent(conn, tmp_path):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    with pytest.raises(WorkerError) as ei:
        run_enroll_speaker(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(sid, "speakers/s/sample.wav"),
            FakeEmbedder([None]),  # <100ms 샘플 → 임베딩 불가
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(50),
        )
    assert ei.value.code == "sample_too_short"
    assert ei.value.kind is ErrorKind.PERMANENT


def test_enroll_too_short_fails_job_and_speaker(conn, tmp_path, monkeypatch):
    # handle_job 경유: PERMANENT → 재시도 없이 job failed + speaker failed
    import damwha_worker.pipeline.enroll_speaker as es

    monkeypatch.setattr(es.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(es.ffmpeg, "probe", lambda p: ProbeResult(50))
    sid = seed_speaker(conn, enrollment_status="pending")
    payload = {
        "schema_version": 1,
        "speaker_id": str(sid),
        "audio_key": "speakers/s/sample.wav",
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
    }
    jid = seed_job(conn, type="enroll_speaker", payload=payload)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    job = db.claim(conn, "w1")
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1", build_embedder=lambda: FakeEmbedder([None])
    )
    assert out == "failed"
    row = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "failed"
    assert row["error"]["code"] == "sample_too_short"
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "failed"
    )
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_enroll_speaker.py -q`
Expected: 신규 2개 FAIL — 현재 `run_enroll_speaker`는 `None`을 그대로 persist로 넘겨 `_vec(None)`에서 `TypeError`(uncategorized TRANSIENT → requeued) 발생. `pytest.raises(WorkerError)`의 code 단언 실패 / `out == "failed"` 대신 `"requeued"`.

- [ ] **Step 3: 구현**

`worker/damwha_worker/errors.py` — Permanent codes 블록에 추가:

```python
# Permanent codes
CORRUPT_AUDIO = "corrupt_audio"
UNSUPPORTED_FORMAT = "unsupported_format"
PROBE_FAILED = "probe_failed"
UNSUPPORTED_PAYLOAD_VERSION = "unsupported_payload_version"
SAMPLE_TOO_SHORT = "sample_too_short"
```

`worker/damwha_worker/pipeline/enroll_speaker.py` — import 보강:

```python
from ..errors import SAMPLE_TOO_SHORT, ErrorKind, WorkerError
```

`extract_embedding` 블록 안, `embedding = embedder.embed(...)` 직후·`t["detail"]` 이전에 삽입:

```python
        embedding = embedder.embed(norm_path, [segment])[0]
        if embedding is None:
            raise WorkerError(
                SAMPLE_TOO_SHORT,
                f"enrollment sample too short to embed ({duration_ms}ms)",
                ErrorKind.PERMANENT,
                stage="extract_embedding",
            )
        t["detail"] = f"reused={reused} duration_ms={duration_ms} dim={len(embedding)}"
```

- [ ] **Step 4: 테스트 통과 확인**

Run (in `worker/`): `uv run pytest tests/test_enroll_speaker.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/errors.py worker/damwha_worker/pipeline/enroll_speaker.py worker/tests/test_enroll_speaker.py
git commit -m "fix(worker): fail enroll permanently when sample is too short to embed"
```

---

### Task 4: `failed_spans` 무조건 전달 — 부분 STT 실패의 세그먼트별 판정

**Files:**
- Modify: `worker/damwha_worker/pipeline/process_meeting.py:118` (1줄)
- Test: `worker/tests/test_process_meeting.py` (추가)

**Interfaces:**
- Consumes: 기존 `build_utterances(words, segments, failed_spans)` — 세그먼트별 overlap 판정은 `align.py`에 이미 구현돼 있음(변경 없음).
- Produces: 없음 (동작 수정만).

**중요:** 회귀 테스트는 반드시 `run_process_meeting`을 통과해야 한다. `align.py`는 이미 per-segment 판정을 지원하므로 align 단독 테스트는 수정 전 코드에서도 통과한다 — 버그는 호출부 조건이다.

- [ ] **Step 1: 실패하는 caller-level 테스트 작성**

`worker/tests/test_process_meeting.py` — 파일 상단 import에 `SpeechSpan` 보강:

```python
from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
```

테스트 추가:

```python
def test_partial_stt_failure_marks_transcribe_failed_per_segment(conn, tmp_path):
    # words가 비어있지 않아도(부분 STT 실패) VAD speech와 겹치는 무발화 세그먼트는
    # silence가 아니라 transcribe_failed여야 한다. 수정 전 코드는 words가 있으면
    # failed_spans를 아예 전달하지 않아 SPEAKER_01이 silence로 위장된다.
    mid = seed_meeting(
        conn, status="processing", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    models = Models(
        vad=FakeVAD([SpeechSpan(1100, 1900)]),  # SPEAKER_01 구간에서 speech 감지
        diarizer=FakeDiarizer(
            [
                DiarSegment("SPEAKER_00", 0, 1000),
                DiarSegment("SPEAKER_01", 1000, 2000),
                DiarSegment("SPEAKER_02", 2000, 3000),
            ]
        ),
        embedder=FakeEmbedder(
            [
                [1.0] + [0.0] * 191,
                [0.0, 1.0] + [0.0] * 190,
                [0.0, 0.0, 1.0] + [0.0] * 189,
            ]
        ),
        transcriber=FakeTranscriber([Word("안녕", 0, 500, 0.9)]),  # words 비어있지 않음
    )
    out = run_process_meeting(
        conn,
        conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
        _payload(mid, "meetings/m/original.m4a"),
        models,
        Storage(str(tmp_path)),
        worker_id="w1",
        normalize_fn=lambda s, d: None,
        probe_fn=lambda p: ProbeResult(3000),
    )
    assert out == "committed"
    rows = conn.execute(
        "SELECT diar_label, status FROM utterance WHERE meeting_id=%s ORDER BY order_index",
        (mid,),
    ).fetchall()
    by_label = {r["diar_label"]: r["status"] for r in rows}
    assert by_label["SPEAKER_00"] == "ok"
    assert by_label["SPEAKER_01"] == "transcribe_failed"  # 수정 전: "silence"
    assert by_label["SPEAKER_02"] == "silence"
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_process_meeting.py::test_partial_stt_failure_marks_transcribe_failed_per_segment -q`
Expected: FAIL — `by_label["SPEAKER_01"]`이 `"silence"`.

- [ ] **Step 3: 구현 (1줄)**

`worker/damwha_worker/pipeline/process_meeting.py`의 align 단계에서:

```python
    utts = build_utterances(words, segments, failed_spans=speech_spans if not words else None)
```

를 다음으로 교체:

```python
    utts = build_utterances(words, segments, failed_spans=speech_spans)
```

- [ ] **Step 4: 테스트 통과 확인**

Run (in `worker/`): `uv run pytest tests/test_process_meeting.py tests/test_align.py tests/test_worker_loop.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS
Run (in `worker/`): `uv run ruff check .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/process_meeting.py worker/tests/test_process_meeting.py
git commit -m "fix(worker): pass VAD spans to align unconditionally so partial STT failures surface per segment"
```

---

### Task 5: 마이그레이션 006 — 기존 zero-vector voiceprint 삭제

**Files:**
- Create: `src/database/migrations/006_delete_zero_voiceprints.sql`
- Test: `test/migration.spec.ts` (추가)

**Interfaces:**
- Consumes: pgvector `vector_norm(vector) -> float8` (0.8.3에서 동작 확인됨), `voiceprint` 테이블(001).
- Produces: 없음 (일회성 데이터 정리, 멱등).

- [ ] **Step 1: 실패하는 테스트 작성**

`test/migration.spec.ts`의 describe 블록 안에 추가 (`fs`/`path`는 파일 상단에 이미 import됨):

```typescript
  it('006: removes zero-vector voiceprints, keeps non-zero ones (idempotent)', async () => {
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('z') RETURNING id`);
    const zero = '[' + Array(192).fill(0).join(',') + ']';
    const ok = '[' + Array(192).fill(0.1).join(',') + ']';
    const ins = (vec: string, model: string) =>
      db.pool.query(
        `INSERT INTO voiceprint(speaker_id, embedding, model, dimension)
         VALUES($1, $2::vector, $3, 192)`,
        [sp.rows[0].id, vec, model],
      );
    await ins(zero, 'zero-m');
    await ins(ok, 'ok-m');

    // 이미 적용된 DB에 재실행 — 멱등해야 한다
    const sql006 = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'database', 'migrations', '006_delete_zero_voiceprints.sql'),
      'utf8',
    );
    await expect(db.pool.query(sql006)).resolves.toBeDefined();

    const rows = await db.pool.query(
      `SELECT model FROM voiceprint WHERE speaker_id=$1 ORDER BY model`,
      [sp.rows[0].id],
    );
    expect(rows.rows.map((r) => r.model)).toEqual(['ok-m']);
  });
```

- [ ] **Step 2: 실패 확인**

Run (리포 루트, `nvm use` 후): `npx jest test/migration.spec.ts -t "006"`
Expected: FAIL — `ENOENT ... 006_delete_zero_voiceprints.sql` (파일 없음)

- [ ] **Step 3: 마이그레이션 작성**

`src/database/migrations/006_delete_zero_voiceprints.sql` 생성:

```sql
-- 006: 기존 zero-vector voiceprint 일회성 정리.
--
-- 과거 워커는 100ms 미만 클립에 [0,...,0] sentinel 임베딩을 저장할 수 있었다
-- (auto_cluster/enroll source 모두). zero vector는 pgvector cosine 연산에 NaN을
-- 유입시켜 화자 식별을 오염시킨다. 워커는 이제 임베딩 불가 클립에 voiceprint를
-- 만들지 않으므로(None 계약), 남은 행만 지우면 된다. 멱등.
--
-- - auto_cluster zero voiceprint: 삭제해도 provisional speaker는 meeting_cluster
--   참조가 남아 유지된다 (persist GC 조건과 정합).
-- - enroll zero voiceprint: ready speaker가 voiceprint 없이 남는다 — 식별에
--   매칭되지 않을 뿐이며 재등록으로 복구 가능.
DELETE FROM voiceprint WHERE vector_norm(embedding) = 0;
```

- [ ] **Step 4: 테스트 통과 확인**

Run (리포 루트): `npx jest test/migration.spec.ts`
Expected: 전체 PASS (신규 006 테스트 포함 — testcontainers가 006까지 적용 후, 테스트가 zero/non-zero 행을 넣고 006을 재실행해 zero만 삭제됨을 확인)

Run (in `worker/`): `uv run pytest tests/test_identify.py tests/test_process_meeting.py -q`
Expected: PASS — worker conftest도 전체 마이그레이션(006 포함)을 적용하므로 워커 스위트가 여전히 통과하는지 확인.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/006_delete_zero_voiceprints.sql test/migration.spec.ts
git commit -m "fix(db): delete legacy zero-vector voiceprints that poison speaker identification"
```

---

### Task 6: 최종 검증

**Files:** 없음 (검증만).

- [ ] **Step 1: 워커 전체 스위트 + 린트**

Run (in `worker/`):
```bash
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```
Expected: 전체 PASS, lint clean.

- [ ] **Step 2: API 스위트 (마이그레이션 영향 확인)**

Run (리포 루트, `nvm use` 후):
```bash
npm test
```
Expected: 전체 PASS. 특히 `migration.spec.ts`, `speakers-management.e2e-spec.ts`, `clusters.e2e-spec.ts`가 006 추가 후에도 통과.

- [ ] **Step 3: 변경 없는 것 확인**

```bash
git diff --stat HEAD~5 -- src/contracts worker/damwha_worker/contracts.py
```
Expected: 출력 없음 (계약 무변경).
