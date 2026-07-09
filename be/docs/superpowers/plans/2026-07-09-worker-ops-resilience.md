# Worker 운영 안정성 3건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커 프로세스가 DB 장애에 죽지 않고(루프·heartbeat 재접속), SIGINT/SIGTERM에 stage 경계에서 job을 attempts 소모 없이 반납하고 종료한다.

**Architecture:** 국소 수정 3건 — heartbeat `_run` 재접속 루프, `__main__`의 `run_loop`/`_reconnect` 추출(모든 예외 → capped backoff 재접속 → in-flight requeue → 계속), 공용 `enter_stage` 헬퍼(shutdown 확인 + 소유권 가드)를 세 파이프라인에 적용. 시그널 → `threading.Event`, stage 경계에서 `ShutdownRequested` → `requeue_for_shutdown`(attempts −1).

**Tech Stack:** Python 3.12 (uv, pytest, testcontainers), psycopg3, threading/signal 표준 라이브러리.

**Spec:** `docs/superpowers/specs/2026-07-09-worker-ops-resilience-design.md`

## Global Constraints

- **계약/API 불변:** `src/contracts/`, `worker/damwha_worker/contracts.py`, NestJS `src/` 코드, DB 스키마/마이그레이션 변경 금지.
- **테스트는 Docker 필요** (testcontainers `damwha/postgres-bigm:pg16`).
- Worker 명령은 전부 `worker/` 디렉토리에서: `uv run pytest -q`, `uv run ruff check .`, `uv run ruff format .`
- `main()`과 시그널 배선은 `# pragma: no cover` 유지 — 추출된 `run_loop`/`_reconnect`/`enter_stage`/파이프라인 경로를 테스트한다.
- 기존 파이프라인 호출부는 무변경 동작해야 한다: 신규 파라미터 `shutdown_event`는 전부 기본값 `None`.
- 예외적으로 enroll/index의 lost-ownership 의미는 **의도적으로** 바뀐다(무시 → TRANSIENT `lost_ownership` raise) — spec §2.3.

## File Structure

| 파일 | 책임 |
|---|---|
| `worker/damwha_worker/heartbeat.py` | `_run` 재접속 루프 (connect/beat 실패 → interval 후 재시도) |
| `worker/damwha_worker/errors.py` | `ShutdownRequested` 예외 |
| `worker/damwha_worker/db.py` | `requeue_for_shutdown` (attempts −1 requeue) |
| `worker/damwha_worker/pipeline/stage.py` (신규) | `enter_stage` 공용 헬퍼 |
| `worker/damwha_worker/pipeline/process_meeting.py` | `_stage` 제거 → `enter_stage`, normalize 전 shutdown 확인, `shutdown_event` 파라미터 |
| `worker/damwha_worker/pipeline/enroll_speaker.py` | `enter_stage` 적용, `shutdown_event` 파라미터 |
| `worker/damwha_worker/pipeline/index_meeting.py` | 〃 |
| `worker/damwha_worker/__main__.py` | `run_loop`/`_reconnect` 추출, handle_job의 `ShutdownRequested` 처리 + 초입 shutdown 확인, `main()` 시그널/초기연결 재배선 |
| `worker/tests/test_heartbeat.py`, `test_stage.py`(신규), `test_db_lifecycle.py`, `test_process_meeting.py`, `test_enroll_speaker.py`, `test_index_meeting.py`, `test_worker_loop.py` | 테스트 |

---

### Task 1: Heartbeat 재접속 루프

**Files:**
- Modify: `worker/damwha_worker/heartbeat.py` (`_run` 전체 교체)
- Test: `worker/tests/test_heartbeat.py` (2개 추가)

**Interfaces:**
- Consumes: 기존 `db.connect(url)`, `db.heartbeat(conn, job_id, worker_id)`.
- Produces: 없음 — `Heartbeat.__init__`/`__enter__`/`__exit__` 시그니처 불변. 이후 태스크가 의존하는 것 없음.

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_heartbeat.py`에 추가:

```python
def _locked_at(conn, jid):
    return conn.execute("SELECT locked_at FROM job WHERE id=%s", (jid,)).fetchone()["locked_at"]


def test_heartbeat_survives_initial_connect_failure(conn, pg_url, monkeypatch):
    # 최초 connect가 2회 실패해도 스레드는 죽지 않고 재시도 후 beat를 기록한다
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    before = _locked_at(conn, jid)

    real_connect = db.connect
    calls = []

    def flaky_connect(url):
        calls.append(1)
        if len(calls) <= 2:
            raise OSError("db down")
        return real_connect(url)

    monkeypatch.setattr(db, "connect", flaky_connect)
    with Heartbeat(pg_url, jid, "w1", interval=0.05):
        time.sleep(0.6)
    assert len(calls) >= 3  # 실패 2회 + 성공
    assert _locked_at(conn, jid) > before  # 이후 beat가 실제 기록됨


def test_heartbeat_reconnects_after_beat_failure(conn, pg_url, monkeypatch):
    # beat 1회 실패 → 커넥션 폐기 → 다음 interval에 재접속해 beat 재개
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    before = _locked_at(conn, jid)

    real_connect = db.connect
    real_heartbeat = db.heartbeat
    connects, beats = [], []

    def counting_connect(url):
        connects.append(1)
        return real_connect(url)

    def flaky_beat(c, job_id, worker_id):
        beats.append(1)
        if len(beats) == 1:
            raise OSError("connection lost")
        return real_heartbeat(c, job_id, worker_id)

    monkeypatch.setattr(db, "connect", counting_connect)
    monkeypatch.setattr(db, "heartbeat", flaky_beat)
    with Heartbeat(pg_url, jid, "w1", interval=0.05):
        time.sleep(0.6)
    assert len(connects) >= 2  # 초기 접속 + beat 실패 후 재접속
    assert len(beats) >= 2
    assert _locked_at(conn, jid) > before
```

주의: `heartbeat.py`는 `from . import db` 후 `db.connect(...)`를 호출하므로, 테스트 파일이 import한 동일 모듈 객체 `db`에 monkeypatch하면 스레드에도 반영된다.

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_heartbeat.py -v`
Expected: `test_heartbeat_survives_initial_connect_failure` FAIL — 현재 코드는 connect 실패 시 스레드가 죽어 `len(calls) >= 3` 불성립(calls == 1) 또는 `locked_at` 미갱신. `test_heartbeat_reconnects_after_beat_failure`도 FAIL — 재접속 없이 같은 커넥션 재사용이라 `len(connects) >= 2` 불성립.

- [ ] **Step 3: 구현**

`worker/damwha_worker/heartbeat.py`의 `_run`을 교체:

```python
    def _run(self) -> None:
        conn = None
        try:
            while not self._stop.is_set():
                if conn is None:
                    try:
                        conn = db.connect(self._url)  # 별도 커넥션 (psycopg는 스레드 간 공유 불가)
                    except Exception:  # noqa: BLE001 — connect 실패가 스레드를 죽이면 안 된다
                        log.warning(
                            "heartbeat connect failed for job %s (retry in %ss)",
                            self._job_id,
                            self._interval,
                            exc_info=True,
                        )
                        if self._stop.wait(self._interval):
                            break
                        continue
                if self._stop.wait(self._interval):
                    break
                try:
                    db.heartbeat(conn, self._job_id, self._worker_id)
                except Exception:  # noqa: BLE001 — a transient beat failure must not kill the heartbeat thread
                    log.warning(
                        "heartbeat failed for job %s (reconnect next interval)",
                        self._job_id,
                        exc_info=True,
                    )
                    try:
                        conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    conn = None
        finally:
            if conn is not None:
                conn.close()
```

- [ ] **Step 4: 통과 확인 + 회귀 없음**

Run (in `worker/`): `uv run pytest tests/test_heartbeat.py -v` → 3개 전부 PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/heartbeat.py worker/tests/test_heartbeat.py
git commit -m "fix(worker): heartbeat thread survives connect/beat failures and reconnects"
```

---

### Task 2: `ShutdownRequested` + `requeue_for_shutdown` + `enter_stage` 헬퍼

**Files:**
- Modify: `worker/damwha_worker/errors.py`
- Modify: `worker/damwha_worker/db.py` (함수 1개 추가)
- Create: `worker/damwha_worker/pipeline/stage.py`
- Test: `worker/tests/test_stage.py` (신규), `worker/tests/test_db_lifecycle.py` (추가)

**Interfaces:**
- Consumes: 기존 `db.set_stage(conn, job_id, worker_id, stage, progress) -> int`, `WorkerError(code, message, kind, stage=None)`, `ErrorKind.TRANSIENT`.
- Produces (Task 3·4가 의존):
  - `errors.ShutdownRequested(Exception)` — 분류 대상 아닌 제어 흐름 예외.
  - `db.requeue_for_shutdown(conn, job_id: str, worker_id: str) -> int` — 소유 시 queued 복귀 + `attempts = greatest(attempts - 1, 0)`, rowcount 반환.
  - `pipeline.stage.enter_stage(conn, job_id, worker_id, stage, progress, shutdown_event=None) -> None` — shutdown이면 `ShutdownRequested`, set_stage 0-row면 `WorkerError("lost_ownership", ..., TRANSIENT)`.

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_stage.py` 생성:

```python
import threading

import pytest

from damwha_worker import db
from damwha_worker.errors import ErrorKind, ShutdownRequested, WorkerError
from damwha_worker.pipeline.stage import enter_stage
from tests.conftest import seed_job, seed_meeting


def _claimed_job(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    return jid


def test_enter_stage_sets_stage_when_owned(conn):
    jid = _claimed_job(conn)
    enter_stage(conn, jid, "w1", "vad", 15)
    row = conn.execute("SELECT stage, progress FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["stage"] == "vad" and row["progress"] == 15


def test_enter_stage_raises_shutdown_before_touching_db(conn):
    jid = _claimed_job(conn)
    ev = threading.Event()
    ev.set()
    with pytest.raises(ShutdownRequested):
        enter_stage(conn, jid, "w1", "vad", 15, shutdown_event=ev)
    # shutdown이 set_stage보다 먼저 — stage는 미기록
    assert conn.execute("SELECT stage FROM job WHERE id=%s", (jid,)).fetchone()["stage"] is None


def test_enter_stage_raises_lost_ownership_transient(conn):
    jid = _claimed_job(conn)  # w1 소유
    with pytest.raises(WorkerError) as ei:
        enter_stage(conn, jid, "w2", "vad", 15)  # 소유자 아님
    assert ei.value.code == "lost_ownership"
    assert ei.value.kind is ErrorKind.TRANSIENT
```

`worker/tests/test_db_lifecycle.py`에 추가 (파일 상단 import에 없으면 `from tests.conftest import seed_job, seed_meeting` 형태는 기존 파일 스타일을 따른다):

```python
def test_requeue_for_shutdown_restores_attempts(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)  # attempts=0
    db.claim(conn, "w1")  # attempts 0→1
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    row = conn.execute(
        "SELECT status, locked_by, locked_at, attempts FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None and row["locked_at"] is None
    assert row["attempts"] == 0  # claim의 +1이 되돌려짐 — 순 소모 0


def test_requeue_for_shutdown_attempts_never_negative(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    conn.execute("UPDATE job SET attempts=0 WHERE id=%s", (jid,))  # 인위적 0
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert conn.execute("SELECT attempts FROM job WHERE id=%s", (jid,)).fetchone()["attempts"] == 0


def test_requeue_for_shutdown_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.requeue_for_shutdown(conn, jid, "w2") == 0  # 소유자 아님 — no-op
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"]
        == "running"
    )
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_stage.py tests/test_db_lifecycle.py -q`
Expected: FAIL — `ImportError: cannot import name 'ShutdownRequested'` / `No module named 'damwha_worker.pipeline.stage'` / `AttributeError: module ... has no attribute 'requeue_for_shutdown'`.

- [ ] **Step 3: 구현**

`worker/damwha_worker/errors.py` — `WorkerError` 클래스 정의 아래에 추가:

```python
class ShutdownRequested(Exception):
    """Graceful shutdown 제어 흐름 예외 — 실패 분류(classify) 대상이 아니다."""
```

`worker/damwha_worker/db.py` — `requeue` 함수 아래에 추가:

```python
def requeue_for_shutdown(conn, job_id: str, worker_id: str) -> int:
    # graceful shutdown은 job의 잘못이 아니다 — claim이 올린 attempts를 되돌린다.
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               attempts = greatest(attempts - 1, 0), updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount
```

`worker/damwha_worker/pipeline/stage.py` 생성:

```python
"""세 파이프라인 공통 stage 진입점: shutdown 확인 + 소유권 가드 set_stage."""

import threading

from .. import db
from ..errors import ErrorKind, ShutdownRequested, WorkerError


def enter_stage(
    conn,
    job_id: str,
    worker_id: str,
    stage: str,
    progress: int,
    shutdown_event: threading.Event | None = None,
) -> None:
    if shutdown_event is not None and shutdown_event.is_set():
        raise ShutdownRequested(f"shutdown requested before stage {stage}")
    if db.set_stage(conn, job_id, worker_id, stage, progress) == 0:
        raise WorkerError(
            "lost_ownership", f"lock lost at {stage}", ErrorKind.TRANSIENT, stage=stage
        )
```

- [ ] **Step 4: 통과 확인**

Run (in `worker/`): `uv run pytest tests/test_stage.py tests/test_db_lifecycle.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/errors.py worker/damwha_worker/db.py worker/damwha_worker/pipeline/stage.py worker/tests/test_stage.py worker/tests/test_db_lifecycle.py
git commit -m "feat(worker): add ShutdownRequested, attempts-preserving shutdown requeue, and shared enter_stage guard"
```

---

### Task 3: 파이프라인 3개 shutdown/소유권 적용 + handle_job 배선

**Files:**
- Modify: `worker/damwha_worker/pipeline/process_meeting.py`
- Modify: `worker/damwha_worker/pipeline/enroll_speaker.py`
- Modify: `worker/damwha_worker/pipeline/index_meeting.py`
- Modify: `worker/damwha_worker/__main__.py` (`handle_job`, `run_once`, `dispatch_claimed_job`)
- Test: `worker/tests/test_process_meeting.py`, `worker/tests/test_enroll_speaker.py`, `worker/tests/test_index_meeting.py`, `worker/tests/test_worker_loop.py`

**Interfaces:**
- Consumes (Task 2): `pipeline.stage.enter_stage(conn, job_id, worker_id, stage, progress, shutdown_event=None)`, `errors.ShutdownRequested`, `db.requeue_for_shutdown(conn, job_id, worker_id) -> int`.
- Produces (Task 4가 의존): `handle_job(..., shutdown_event=None)`, `dispatch_claimed_job(..., shutdown_event=None)` — shutdown 시 outcome `"requeued_shutdown"` (소유권 상실 시 `"lost"`). `run_process_meeting`/`run_enroll_speaker`/`run_index_meeting`에 `shutdown_event: threading.Event | None = None` 키워드 파라미터.

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_process_meeting.py` — 상단 import에 `threading`, `pytest`, `from damwha_worker.errors import ShutdownRequested` 추가 후:

```python
def test_shutdown_before_normalize_raises_without_side_effects(conn, tmp_path):
    # shutdown 확인은 mark_processing/normalize보다 먼저 — 아무 부작용 없이 반납된다
    mid = seed_meeting(
        conn, status="uploaded", processing_version=0, audio_key="meetings/m/original.m4a"
    )
    jid = seed_job(conn, meeting_id=mid, payload={})
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    ev = threading.Event()
    ev.set()
    normalize_calls = []
    with pytest.raises(ShutdownRequested):
        run_process_meeting(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(mid, "meetings/m/original.m4a"),
            _models(),
            Storage(str(tmp_path)),
            worker_id="w1",
            normalize_fn=lambda s, d: normalize_calls.append(1),
            probe_fn=lambda p: ProbeResult(2000),
            shutdown_event=ev,
        )
    assert normalize_calls == []  # ffmpeg 미실행
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "uploaded"  # mark_processing 미도달
    )
```

`worker/tests/test_enroll_speaker.py` — 추가 (`WorkerError`/`ErrorKind`/`pytest`는 정확도 작업에서 이미 import됨):

```python
def test_enroll_lost_ownership_raises_transient(conn, tmp_path):
    # enter_stage 도입으로 enroll도 소유권 상실 시 헛연산 없이 즉시 중단된다
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", payload={})
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")  # w1 소유
    with pytest.raises(WorkerError) as ei:
        run_enroll_speaker(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone(),
            _payload(sid, "speakers/s/sample.wav"),
            FakeEmbedder([[0.3] * 192]),
            Storage(str(tmp_path)),
            worker_id="w2",  # 소유자 아님
            normalize_fn=lambda s, d: None,
            probe_fn=lambda p: ProbeResult(3000),
        )
    assert ei.value.code == "lost_ownership"
    assert ei.value.kind is ErrorKind.TRANSIENT
```

`worker/tests/test_index_meeting.py` — 상단에 `import pytest`, `from damwha_worker.errors import ErrorKind, WorkerError` 추가 후:

```python
def test_index_lost_ownership_raises_transient(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "ok", "안녕하세요")])
    job = _claim(conn, mid)  # w1 소유
    with pytest.raises(WorkerError) as ei:
        run_index_meeting(conn, job, _payload(mid), FakeTextEmbedder(), worker_id="w2")
    assert ei.value.code == "lost_ownership"
    assert ei.value.kind is ErrorKind.TRANSIENT
```

`worker/tests/test_worker_loop.py` — 상단에 `import threading` 추가 후:

```python
def test_shutdown_requeues_without_consuming_attempts(conn, tmp_path):
    # dispatch 직전 시그널: 모델 빌드조차 하지 않고 attempts 소모 없이 반납
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")  # attempts 0→1
    ev = threading.Event()
    ev.set()

    def _boom_models():
        raise AssertionError("must not build models during shutdown")

    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1", build_models=_boom_models, shutdown_event=ev
    )
    assert out == "requeued_shutdown"
    row = conn.execute(
        "SELECT status, attempts, locked_by FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == "queued"
    assert row["attempts"] == 0  # 미소모
    assert row["locked_by"] is None
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "uploaded"  # 아무 것도 건드리지 않음
    )


def test_shutdown_with_lost_ownership_returns_lost(conn, tmp_path):
    # shutdown 반납 시점에 이미 소유권을 잃었으면(reaper 회수 등) "lost"
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    conn.execute("UPDATE job SET locked_by='other' WHERE id=%s", (jid,))  # 소유권 상실 시뮬레이션
    ev = threading.Event()
    ev.set()
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1", build_models=_models, shutdown_event=ev
    )
    assert out == "lost"
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_process_meeting.py tests/test_enroll_speaker.py tests/test_index_meeting.py tests/test_worker_loop.py -q`
Expected: 신규 4개 FAIL — `run_process_meeting`에 `shutdown_event` 파라미터 없음(TypeError), enroll/index는 set_stage 무시라 raise 없이 진행(`DID NOT RAISE`), `handle_job`에 `shutdown_event` 없음(TypeError).

- [ ] **Step 3: 구현**

**`worker/damwha_worker/pipeline/process_meeting.py`:**

import 변경 — 상단에 `import threading` 추가, `from ..errors import ErrorKind, WorkerError`를 `from ..errors import ShutdownRequested`로 정리(기존 `WorkerError`/`ErrorKind`는 `_stage` 제거로 이 파일에서 더 안 쓰이면 제거), `from .stage import enter_stage` 추가. 모듈의 `_stage` 함수를 **삭제**한다.

시그니처에 파라미터 추가:

```python
def run_process_meeting(
    conn,
    job: dict,
    payload: ProcessMeetingPayload,
    models: Models,
    storage: Storage,
    *,
    worker_id: str,
    search_embedding_model: str | None = None,
    search_embedding_dim: int | None = None,
    normalize_fn: Callable[[str, str], None] | None = None,
    probe_fn: Callable[[str], ffmpeg.ProbeResult] | None = None,
    default_speaker_prefix: str = "Speaker",
    shutdown_event: threading.Event | None = None,
) -> str:
```

함수 본문 최상단(기본값 해석 직후, `mark_processing` **이전**)에 삽입:

```python
    if shutdown_event is not None and shutdown_event.is_set():
        # normalize(ffmpeg)는 stage enum 밖이지만 긴 파일에서 수 분 걸릴 수 있다 —
        # mark_processing 전에 확인해 아무 부작용 없이 반납한다.
        raise ShutdownRequested("shutdown requested before normalize")
```

기존 6개 `_stage(conn, job_id, worker_id, "<stage>", <progress>)` 호출을 전부 다음으로 교체:

```python
    enter_stage(conn, job_id, worker_id, "vad", 15, shutdown_event)
    # ... 동일하게: ("diarize", 35), ("identify", 50), ("stt", 75), ("align", 90), ("persist", 95)
```

**`worker/damwha_worker/pipeline/enroll_speaker.py`:**

상단에 `import threading`, `from .stage import enter_stage` 추가. 시그니처에 `shutdown_event: threading.Event | None = None` 키워드 파라미터 추가. 두 곳 교체:

```python
    enter_stage(conn, job_id, worker_id, "extract_embedding", 30, shutdown_event)
    # ...
    enter_stage(conn, job_id, worker_id, "enroll_persist", 80, shutdown_event)
```

(기존 `db.set_stage(...)` 두 줄 삭제. `db` import는 `persist_enroll`에서 계속 쓰므로 유지.)

**`worker/damwha_worker/pipeline/index_meeting.py`:**

상단에 `import threading`, `from .stage import enter_stage` 추가. 시그니처에 `shutdown_event: threading.Event | None = None` 추가. 교체:

```python
    enter_stage(conn, job_id, worker_id, "embed", 20, shutdown_event)
```

**`worker/damwha_worker/__main__.py`:**

import에 `ShutdownRequested` 추가: `from .errors import ErrorKind, ShutdownRequested, classify`.

`handle_job` 시그니처에 `shutdown_event=None` 추가, try 초입에 확인 삽입, `ShutdownRequested` catch를 일반 except **앞에** 추가, 세 `run_*` 호출에 `shutdown_event=shutdown_event` 전달:

```python
def handle_job(
    conn,
    job: dict,
    storage: Storage,
    worker_id: str,
    *,
    build_models=None,
    build_embedder=None,
    build_text_embedder=None,
    search_embedding=None,
    default_speaker_prefix="Speaker",
    shutdown_event=None,
) -> str:
    try:
        if shutdown_event is not None and shutdown_event.is_set():
            # claim과 dispatch 사이에 시그널 — 모델 빌드 전에 반납
            raise ShutdownRequested("shutdown requested before dispatch")
        payload = parse_payload(job["type"], job["payload"])
        if job["type"] == "process_meeting":
            sm, sd = search_embedding or (None, None)
            models = build_models()
            return run_process_meeting(
                conn,
                job,
                payload,
                models,
                storage,
                worker_id=worker_id,
                search_embedding_model=sm,
                search_embedding_dim=sd,
                default_speaker_prefix=default_speaker_prefix,
                shutdown_event=shutdown_event,
            )
        if job["type"] == "enroll_speaker":
            embedder = build_embedder()
            return run_enroll_speaker(
                conn, job, payload, embedder, storage,
                worker_id=worker_id, shutdown_event=shutdown_event,
            )
        if job["type"] == "index_meeting":
            text_embedder = build_text_embedder()
            return run_index_meeting(
                conn, job, payload, text_embedder,
                worker_id=worker_id, shutdown_event=shutdown_event,
            )
        raise ValueError(f"unknown job type {job['type']}")
    except ShutdownRequested:
        log.info("job %s type=%s → shutdown requeue", job["id"], job["type"])
        ok = db.requeue_for_shutdown(conn, job["id"], worker_id)
        return "requeued_shutdown" if ok else "lost"
    except Exception as exc:  # noqa: BLE001 — 분류해서 requeue/fail
        # (이 블록의 기존 본문은 한 줄도 바꾸지 않는다 — classify/transient_retry/타입별 fail 경로 그대로)
```

`run_once`와 `dispatch_claimed_job`에도 `shutdown_event=None` 파라미터를 추가해 `handle_job`으로 그대로 전달한다(기존 파라미터 뒤에 키워드로).

- [ ] **Step 4: 통과 확인**

Run (in `worker/`): `uv run pytest tests/test_process_meeting.py tests/test_enroll_speaker.py tests/test_index_meeting.py tests/test_worker_loop.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS (기존 lost-ownership 경로: process_meeting의 `_stage` 대체가 동작 동일함을 기존 테스트가 확인)
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/process_meeting.py worker/damwha_worker/pipeline/enroll_speaker.py worker/damwha_worker/pipeline/index_meeting.py worker/damwha_worker/__main__.py worker/tests/test_process_meeting.py worker/tests/test_enroll_speaker.py worker/tests/test_index_meeting.py worker/tests/test_worker_loop.py
git commit -m "feat(worker): stage-boundary graceful shutdown and unified ownership guard across pipelines"
```

---

### Task 4: `run_loop`/`_reconnect` + `main()` 재배선

**Files:**
- Modify: `worker/damwha_worker/__main__.py`
- Test: `worker/tests/test_worker_loop.py` (추가)

**Interfaces:**
- Consumes (Task 2·3): `db.claim`, `db.requeue`, `dispatch_claimed_job(..., shutdown_event=...)`.
- Produces:
  - `run_loop(conn, settings, shutdown, *, connect_fn, dispatch_fn) -> None` — settings는 `worker_id`/`poll_interval_seconds`만 사용. dispatch_fn: `(conn, job) -> str`. 어떤 예외에도 재접속 후 계속.
  - `_reconnect(connect_fn, shutdown, *, initial_delay=1.0, max_delay=30.0) -> Connection | None` — capped 지수 backoff, shutdown 시 `None`.
  - spec의 `run_loop(conn, settings, storage, shutdown, ...)` 스케치에서 **storage 파라미터는 제거**(내부 미사용 — dispatch_fn 클로저가 보유. 의도된 단순화).

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/test_worker_loop.py`에 추가 (`threading`은 Task 3에서 import됨; `run_loop`, `_reconnect`를 import 라인에 추가: `from damwha_worker.__main__ import _reconnect, dispatch_claimed_job, handle_job, run_loop, run_once`):

```python
def test_run_loop_exits_immediately_when_shutdown_set(conn):
    shutdown = threading.Event()
    shutdown.set()
    run_loop(
        conn,
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=lambda: (_ for _ in ()).throw(AssertionError("must not connect")),
        dispatch_fn=lambda c, j: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )  # 반환하면 성공


def test_run_loop_reconnects_and_requeues_inflight_on_dispatch_error(conn, pg_url):
    # dispatch 1회차 예외 → 재접속 + in-flight requeue → 2회차에 같은 job을 다시 claim.
    # 2회차 claim이 성공한다는 것 자체가 requeue가 동작했다는 증거다.
    mid, jid = _enqueue_pm(conn)
    shutdown = threading.Event()
    connects, calls = [], []

    def connect_fn():
        connects.append(1)
        return db.connect(pg_url)

    def dispatch_fn(c, job):
        calls.append(job["id"])
        if len(calls) == 1:
            raise OSError("db died mid-job")
        shutdown.set()
        return "committed"

    loop_conn = db.connect(pg_url)  # run_loop이 close할 수 있으므로 fixture conn과 분리
    run_loop(
        loop_conn,
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=connect_fn,
        dispatch_fn=dispatch_fn,
    )
    assert calls == [jid, jid]  # 같은 job이 requeue 후 재claim됨
    assert connects == [1]  # 재접속 1회


def test_run_loop_survives_claim_error(conn, pg_url):
    # claim 시점에 커넥션이 죽어 있어도 재접속 후 계속
    mid, jid = _enqueue_pm(conn)
    shutdown = threading.Event()
    connects, calls = [], []

    class BrokenConn:
        def execute(self, *a, **k):
            raise OSError("dead connection")

        def close(self):
            pass

    def connect_fn():
        connects.append(1)
        return db.connect(pg_url)

    def dispatch_fn(c, job):
        calls.append(job["id"])
        shutdown.set()
        return "committed"

    run_loop(
        BrokenConn(),
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=connect_fn,
        dispatch_fn=dispatch_fn,
    )
    assert connects == [1]
    assert calls == [jid]  # 새 커넥션으로 claim + dispatch 성공


def test_reconnect_returns_connection_on_success():
    shutdown = threading.Event()
    sentinel = object()
    assert _reconnect(lambda: sentinel, shutdown) is sentinel


def test_reconnect_backoff_doubles_and_stops_on_shutdown(monkeypatch):
    shutdown = threading.Event()
    waits = []

    def rec_wait(t):
        waits.append(t)
        if len(waits) == 4:
            shutdown.set()
            return True
        return False

    monkeypatch.setattr(shutdown, "wait", rec_wait)

    def failing():
        raise OSError("down")

    assert _reconnect(failing, shutdown, initial_delay=1.0, max_delay=30.0) is None
    assert waits == [1.0, 2.0, 4.0, 8.0]
```

- [ ] **Step 2: 실패 확인**

Run (in `worker/`): `uv run pytest tests/test_worker_loop.py -q`
Expected: FAIL — `ImportError: cannot import name 'run_loop'` (및 `_reconnect`).

- [ ] **Step 3: 구현**

`worker/damwha_worker/__main__.py` 상단 import에 `import signal`, `import threading` 추가. `main()` 위에 두 함수 추가:

```python
def _reconnect(connect_fn, shutdown, *, initial_delay: float = 1.0, max_delay: float = 30.0):
    """capped 지수 backoff로 재접속. shutdown이 set되면 None."""
    delay = initial_delay
    while not shutdown.is_set():
        try:
            return connect_fn()
        except Exception:  # noqa: BLE001 — 어떤 연결 실패든 재시도
            log.warning("reconnect failed — retry in %.0fs", delay, exc_info=True)
            if shutdown.wait(delay):
                break
            delay = min(delay * 2, max_delay)
    return None


def run_loop(conn, settings, shutdown, *, connect_fn, dispatch_fn) -> None:
    """폴 루프: claim → dispatch. 어떤 예외에도 죽지 않는다 — 재접속 후 계속."""
    job = None  # 현재 in-flight job (예외 시 requeue 대상)
    while not shutdown.is_set():
        try:
            job = db.claim(conn, settings.worker_id)
            if job is None:
                shutdown.wait(settings.poll_interval_seconds)
                continue
            outcome = dispatch_fn(conn, job)
            log.info("job %s type=%s → %s", job["id"], job["type"], outcome)
            job = None  # 정상 완료 — 큐에 남은 job 즉시 재claim
        except Exception:  # noqa: BLE001 — 루프는 죽지 않는다
            log.exception("worker loop error — reconnecting")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = _reconnect(connect_fn, shutdown)
            if conn is None:
                break  # 재접속 중 shutdown
            if job is not None:
                # in-flight job을 reaper 대기 없이 즉시 반환 시도.
                # 소유권 가드라 0-row(이미 회수됨)여도 무해.
                try:
                    db.requeue(conn, job["id"], settings.worker_id)
                except Exception:  # noqa: BLE001
                    log.warning("in-flight requeue failed — reaper will recover job %s", job["id"])
                job = None
```

`main()` 전체 교체:

```python
def main() -> None:  # pragma: no cover — 실모델 + 시그널 배선 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    shutdown = threading.Event()

    def _on_signal(signum, frame):
        log.info(
            "signal %s received — will stop at next stage boundary (send again to force)", signum
        )
        shutdown.set()
        signal.signal(signum, signal.SIG_DFL)  # 2차 시그널 = 기본 동작(즉시 종료)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    from .heartbeat import Heartbeat
    from .models.registry import build_embedder, build_models, build_text_embedder

    conn = _reconnect(lambda: db.connect(settings.database_url), shutdown)
    if conn is None:
        log.info("shutdown before initial DB connection")
        return
    log.info("worker %s started", settings.worker_id)

    def _dispatch(c, job):
        hb = Heartbeat(
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        )
        return dispatch_claimed_job(
            c,
            job,
            storage,
            settings,
            build_models_fn=build_models,
            build_embedder_fn=build_embedder,
            build_text_embedder_fn=build_text_embedder,
            heartbeat_cm=hb,
            shutdown_event=shutdown,
        )

    run_loop(
        conn,
        settings,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        dispatch_fn=_dispatch,
    )
    log.info("worker %s stopped", settings.worker_id)
```

(`import time`이 더 이상 안 쓰이면 제거.)

- [ ] **Step 4: 통과 확인**

Run (in `worker/`): `uv run pytest tests/test_worker_loop.py -q` → PASS
Run (in `worker/`): `uv run pytest -q` → 전체 PASS
Run (in `worker/`): `uv run ruff check . && uv run ruff format .` → clean

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/__main__.py worker/tests/test_worker_loop.py
git commit -m "feat(worker): resilient poll loop with reconnect backoff, in-flight requeue, and signal-driven shutdown"
```

---

### Task 5: 최종 검증

**Files:** 없음 (검증만).

- [ ] **Step 1: 워커 전체 스위트 + 린트**

Run (in `worker/`):
```bash
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
```
Expected: 전체 PASS, lint clean.

- [ ] **Step 2: API 스위트 (무영향 확인)**

Run (리포 루트, `nvm use` 후):
```bash
npm test
```
Expected: 전체 PASS (API 코드/마이그레이션 무변경 — 회귀 없음 확인용).

- [ ] **Step 3: 계약/스키마 무변경 확인**

Run (리포 루트):
```bash
git diff --stat HEAD~4 -- src/ worker/damwha_worker/contracts.py
```
Expected: 출력 없음.

- [ ] **Step 4: 수동 스모크 (선택, 로컬)**

실모델 없이도 확인 가능한 시그널 동작: `cd worker && uv run python -m damwha_worker` 기동(큐 비어있음) → Ctrl-C 1회 → "signal 2 received" 로그 후 즉시 정상 종료(유휴 `shutdown.wait` 탈출) 확인.
