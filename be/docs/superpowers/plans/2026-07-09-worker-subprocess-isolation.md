# Worker subprocess-per-job 메모리 격리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 장수 워커 폴 루프를 "supervisor 부모 + job당 자식 프로세스"로 재편해, job 간 GPU 메모리(주로 MLX 전역 캐시) 누적으로 인한 OOM을 프로세스 종료로 원천 차단한다.

**Architecture:** 부모(supervisor)는 torch/pyannote를 import하지 않고 `SELECT 1 FROM job WHERE status='queued'`로 peek만 한다. 큐에 job이 있으면 `python -m damwha_worker --once` 자식을 spawn하고 종료를 기다린다. 자식은 job 1건을 claim→heartbeat→dispatch로 처리한 뒤 exit하고, OS가 자식의 전 메모리(MLX·torch 포함)를 회수한다. 자식 exit code로 부모가 분기하고, claim-전-크래시로 인한 무한 spawn을 capped backoff로 막는다.

**Tech Stack:** Python 3.12, psycopg3, `subprocess`(spawn, `start_new_session=True`), pytest + testcontainers(실 Postgres) + fake 모델. 실 ML 어댑터(mlx-whisper/BGE-M3)는 `models` extra라 CI 미포함 — smoke로만 검증.

## Global Constraints

- job payload 계약(pydantic), DB 스키마, NestJS `src/`는 **변경 금지** — 워커 내부 + 워커 테스트만.
- 운영 형태: 단일 Mac, job **직렬** 처리(동시성 0). 목표는 처리량 아닌 OOM 방지.
- 서브프로세스 기동: `subprocess.Popen([sys.executable, "-m", "damwha_worker", "--once"], start_new_session=True)` — 리터럴 `"python"` 금지, `fork` 금지(spawn 전용).
- 자식 exit code 계약: `0`=처리 완료, `3`=no job, 그 외(`2` 포함)=크래시.
- `--once` 판별은 `sys.argv` 직접 검사 — argparse 금지(사용법 오류 시 exit 2가 크래시로 흡수되어야 함).
- 자식 stdout/stderr는 Popen 기본(부모 상속) — `capture_output` 금지.
- 기존 `handle_job`/`run_once`/`dispatch_claimed_job`/`Heartbeat` 시그니처 **변경 금지**(자식이 그대로 재사용, 기존 job-처리 테스트 유효 유지).
- 참조 spec: `docs/superpowers/specs/2026-07-09-worker-subprocess-isolation-design.md`

---

## File Structure

- **Modify** `worker/damwha_worker/db.py` — `peek_queued(conn) -> bool` 신설.
- **Modify** `worker/damwha_worker/__main__.py` — `run_loop`/in-flight requeue 제거; `run_single_job`, `run_supervisor`, `run_child`, `run_supervisor_main` 신설; `main()`을 argv 분기로; `_reconnect`는 유지(부모·자식 공용).
- **Modify** `worker/tests/test_worker_loop.py` — `test_run_loop_*` 4건 제거, import에서 `run_loop` 제거. `run_once`/dispatch/handle_job/`_reconnect` 테스트는 유지.
- **Create** `worker/tests/test_supervisor.py` — stub 자식으로 supervisor 결정적 테스트.
- **Modify** `worker/damwha_worker/models/bge_embed.py` — BGE-M3 CPU 강제.
- **Modify** `worker/damwha_worker/models/whisper_mlx.py` — MLX active 메모리 상한.
- **Modify** `docs/worker-architecture.md`, `worker/SMOKE.md` — 프로세스 모델 갱신.
- **Modify (optional)** `worker/damwha_worker/errors.py` — MPS/CUDA OOM RuntimeError → `oom`.

작업 디렉토리는 `worker/`. 모든 `uv run`/`pytest`는 `cd worker` 기준.

---

## Task 1: `db.peek_queued` — 큐 존재 확인

**Files:**
- Modify: `worker/damwha_worker/db.py` (파일 끝에 함수 추가)
- Test: `worker/tests/test_db_lifecycle.py` (기존 파일에 테스트 추가)

**Interfaces:**
- Produces: `peek_queued(conn) -> bool` — 큐에 `status='queued'` job이 하나라도 있으면 True. 어떤 행도 claim/수정하지 않는다(읽기 전용).

- [ ] **Step 1: Write the failing test**

`worker/tests/test_db_lifecycle.py` 끝에 추가:

```python
def test_peek_queued_true_when_queued_job_exists(conn):
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        ("mtg_peek", '{"schema_version": 1}'),
    )
    assert db.peek_queued(conn) is True


def test_peek_queued_false_when_empty(conn):
    assert db.peek_queued(conn) is False


def test_peek_queued_does_not_claim(conn):
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        ("mtg_peek2", '{"schema_version": 1}'),
    )
    db.peek_queued(conn)
    row = conn.execute("SELECT status FROM job WHERE meeting_id='mtg_peek2'").fetchone()
    assert row["status"] == "queued"  # peek는 running으로 바꾸지 않는다
```

`test_db_lifecycle.py` 상단에 `from damwha_worker import db`가 이미 있는지 확인, 없으면 추가.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_db_lifecycle.py -k peek_queued -v`
Expected: FAIL — `AttributeError: module 'damwha_worker.db' has no attribute 'peek_queued'`

- [ ] **Step 3: Write minimal implementation**

`worker/damwha_worker/db.py` 파일 끝에 추가:

```python
def peek_queued(conn) -> bool:
    """큐에 처리 대기 job이 있는지 읽기 전용 확인. 어떤 행도 claim하지 않는다."""
    return conn.execute("SELECT 1 FROM job WHERE status='queued' LIMIT 1").fetchone() is not None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_db_lifecycle.py -k peek_queued -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/db.py worker/tests/test_db_lifecycle.py
git commit -m "feat(worker): add db.peek_queued for supervisor queue check"
```

---

## Task 2: `run_single_job` — 자식 코어와 exit code 계약

**Files:**
- Modify: `worker/damwha_worker/__main__.py` (신설 함수)
- Test: `worker/tests/test_supervisor.py` (신규 파일)

**Interfaces:**
- Consumes: `db.claim`, `db.connect`, `_reconnect`, `dispatch_claimed_job`, `Heartbeat`.
- Produces: `run_single_job(settings, storage, shutdown, *, connect_fn, build_models_fn, build_embedder_fn, build_text_embedder_fn) -> int` — job 1건 처리, exit code(`0`=처리, `3`=no job) 반환. 미포착 예외는 전파(부모가 nonzero 크래시로 관측). connect 전 shutdown이면 `0`(job 미접촉).

- [ ] **Step 1: Write the failing test**

`worker/tests/test_supervisor.py` 신규 생성. 상단 import 및 헬퍼는 `test_worker_loop.py`의 `_models`/`_enqueue_pm` 패턴을 복제(엔지니어가 태스크를 순서 없이 읽을 수 있으므로 그대로 적는다):

```python
import threading

import pytest

from damwha_worker import db
from damwha_worker.__main__ import run_single_job
from damwha_worker.storage import Storage
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD  # 존재 확인 필요
from damwha_worker.pipeline.process_meeting import Models


def _models():
    return Models(vad=FakeVAD(), diarizer=FakeDiarizer(), embedder=FakeEmbedder(), transcriber=FakeTranscriber())


def _settings_stub(pg_url):
    class S:
        database_url = pg_url
        worker_id = "w1"
        heartbeat_interval_seconds = 30.0
        search_embedding_model = "fake-model"
        search_embedding_dim = 3
        default_speaker_prefix = "Speaker"
    return S()


def _enqueue_index(conn, pv=0):
    conn.execute(
        "INSERT INTO meeting(id, title, status, processing_version) "
        "VALUES('mtg_c', 't', 'done', %s)",
        (pv,),
    )
    conn.execute(
        "INSERT INTO job(id, type, meeting_id, status, payload) "
        "VALUES('job_c', 'index_meeting', 'mtg_c', 'queued', %s)",
        ('{"schema_version": 1, "meeting_id": "mtg_c", "processing_version": 0, '
         '"search_embedding": {"model": "fake-model", "dimension": 3}}',),
    )


def test_run_single_job_no_job_returns_3(conn, pg_url, tmp_path):
    shutdown = threading.Event()
    code = run_single_job(
        _settings_stub(pg_url), Storage(str(tmp_path)), shutdown,
        connect_fn=lambda: db.connect(pg_url),
        build_models_fn=lambda payload, settings: _models(),
        build_embedder_fn=lambda payload, settings: FakeEmbedder(),
        build_text_embedder_fn=lambda settings: FakeTextEmbedder(),
    )
    assert code == 3


def test_run_single_job_processes_and_returns_0(conn, pg_url, tmp_path):
    _enqueue_index(conn)
    shutdown = threading.Event()
    code = run_single_job(
        _settings_stub(pg_url), Storage(str(tmp_path)), shutdown,
        connect_fn=lambda: db.connect(pg_url),
        build_models_fn=lambda payload, settings: _models(),
        build_embedder_fn=lambda payload, settings: FakeEmbedder(),
        build_text_embedder_fn=lambda settings: FakeTextEmbedder(),
    )
    assert code == 0
    row = conn.execute("SELECT status FROM job WHERE id='job_c'").fetchone()
    assert row["status"] == "done"
```

> 구현 전 확인: `tests/fakes.py`에 `FakeTextEmbedder`가 있는지 (`test_dispatch_index.py`/`test_index_meeting.py`가 쓰는 것) — 없으면 그 파일들이 쓰는 이름으로 맞춘다. `pg_url`/`conn` fixture는 `conftest.py` 제공(기존 테스트가 사용).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_supervisor.py -v`
Expected: FAIL — `ImportError: cannot import name 'run_single_job'`

- [ ] **Step 3: Write minimal implementation**

`worker/damwha_worker/__main__.py`에 추가(기존 `dispatch_claimed_job` 아래):

```python
def run_single_job(
    settings,
    storage: Storage,
    shutdown: threading.Event,
    *,
    connect_fn,
    build_models_fn,
    build_embedder_fn,
    build_text_embedder_fn,
) -> int:
    """자식 진입점: job 1건 처리 후 exit code 반환.

    0 = 처리 완료(성공/정상 fail/requeue/shutdown requeue), 3 = no job.
    미포착 예외는 전파 → 부모가 nonzero 크래시로 관측.
    """
    conn = _reconnect(connect_fn, shutdown)
    if conn is None:
        return 0  # connect 전 shutdown — job 미접촉
    try:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            return 3
        from .heartbeat import Heartbeat

        hb = Heartbeat(
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        )
        dispatch_claimed_job(
            conn,
            job,
            storage,
            settings,
            build_models_fn=build_models_fn,
            build_embedder_fn=build_embedder_fn,
            build_text_embedder_fn=build_text_embedder_fn,
            heartbeat_cm=hb,
            shutdown_event=shutdown,
        )
        return 0
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
```

`Heartbeat` import를 함수 안에 두는 이유: 기존 `main()`이 그렇게 lazy import함(테스트가 실 heartbeat 없이 dispatch를 stub할 수 있게).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_supervisor.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/__main__.py worker/tests/test_supervisor.py
git commit -m "feat(worker): add run_single_job child entrypoint with exit-code contract"
```

---

## Task 3: `run_supervisor` — 부모 루프, exit-code 분기, backoff, peek 재접속

**Files:**
- Modify: `worker/damwha_worker/__main__.py` (신설 함수 + 모듈 상수)
- Test: `worker/tests/test_supervisor.py`

**Interfaces:**
- Consumes: `db.peek_queued`, `_reconnect`.
- Produces: `run_supervisor(settings, shutdown, *, connect_fn, spawn_fn, child_holder) -> None`.
  - `spawn_fn() -> proc` — `proc`은 `.wait(timeout)`/`.terminate()`/`.kill()`/`.returncode`를 갖는 객체(실전은 `subprocess.Popen`, 테스트는 stub).
  - `child_holder: dict` — `{"proc": <현재 자식 or None>, "count": <시그널 횟수>}`. 부모 시그널 핸들러가 이 dict로 자식을 제어(Task 4).
- 모듈 상수: `_MAX_BACKOFF_SECONDS = 60.0`.

- [ ] **Step 1: Write the failing test**

`worker/tests/test_supervisor.py`에 추가:

```python
from damwha_worker.__main__ import run_supervisor


class _StubProc:
    def __init__(self, code):
        self._code = code
        self.returncode = None
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        self.returncode = self._code
        return self._code

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def _peek_settings():
    class S:
        worker_id = "w1"
        poll_interval_seconds = 0.01
    return S()


def test_supervisor_spawns_child_when_job_queued(conn, pg_url, monkeypatch):
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        ("mtg_s", '{"schema_version": 1}'),
    )
    shutdown = threading.Event()
    spawns = []

    def _spawn():
        # 첫 spawn 후 shutdown → 루프 1회로 종료
        shutdown.set()
        p = _StubProc(0)
        spawns.append(p)
        return p

    run_supervisor(
        _peek_settings(), shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=_spawn,
        child_holder={"proc": None, "count": 0},
    )
    assert len(spawns) == 1


def test_supervisor_no_spawn_when_queue_empty(conn, pg_url):
    shutdown = threading.Event()
    spawns = []

    # peek False → sleep(poll) → shutdown로 종료. 별도 스레드로 shutdown 트리거.
    def _delayed_shutdown():
        shutdown.set()

    t = threading.Timer(0.05, _delayed_shutdown)
    t.start()
    run_supervisor(
        _peek_settings(), shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: spawns.append(_StubProc(0)) or spawns[-1],
        child_holder={"proc": None, "count": 0},
    )
    t.cancel()
    assert spawns == []


def test_supervisor_backoff_on_crash(conn, pg_url, monkeypatch):
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        ("mtg_s2", '{"schema_version": 1}'),
    )
    shutdown = threading.Event()
    waits = []
    monkeypatch.setattr(shutdown, "wait", lambda t: (waits.append(t), shutdown.set(), False)[2] or shutdown.is_set())

    run_supervisor(
        _peek_settings(), shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(1),  # 크래시
        child_holder={"proc": None, "count": 0},
    )
    assert waits and waits[0] >= 0.01  # 크래시 후 backoff sleep 발생
```

> 주의: 위 backoff 테스트의 `monkeypatch.setattr(shutdown, "wait", ...)`는 첫 wait 호출에서 `waits`에 기록하고 shutdown을 set해 루프를 끝낸다. `shutdown.wait`가 정상 Event 메서드라 setattr 가능한지 실행 시 확인 — 불가하면 `shutdown`을 감싼 소형 스텁 클래스로 대체(같은 `is_set`/`wait`/`set` 인터페이스).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_supervisor.py -k supervisor -v`
Expected: FAIL — `ImportError: cannot import name 'run_supervisor'`

- [ ] **Step 3: Write minimal implementation**

`worker/damwha_worker/__main__.py` 상단(로거 아래)에 상수 추가:

```python
_MAX_BACKOFF_SECONDS = 60.0
```

`run_single_job` 아래에 추가:

```python
def _wait_child(proc, shutdown) -> int:
    """자식 종료까지 대기. shutdown이 걸리면 부모 시그널 핸들러가 child_holder로
    terminate/kill을 이미 보냈으므로, 여기서는 폴링하며 returncode만 회수한다."""
    while True:
        try:
            return proc.wait(timeout=0.5)
        except _TIMEOUT_EXC:
            continue


def run_supervisor(settings, shutdown, *, connect_fn, spawn_fn, child_holder) -> None:
    """부모: peek → job 있으면 자식 spawn → 종료 대기 → exit code 분기.

    자식 exit code: 0=처리 완료(즉시 재peek), 3=no job(poll sleep),
    그 외(2 포함)=크래시(capped backoff + WARNING).
    """
    conn = _reconnect(connect_fn, shutdown)
    if conn is None:
        return
    consecutive_failures = 0
    while not shutdown.is_set():
        try:
            has_job = db.peek_queued(conn)
        except Exception:  # noqa: BLE001 — DB 장애: 재접속 후 계속
            log.exception("supervisor peek error — reconnecting")
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            conn = _reconnect(connect_fn, shutdown)
            if conn is None:
                return
            continue
        if not has_job:
            if shutdown.wait(settings.poll_interval_seconds):
                break
            continue

        proc = spawn_fn()
        child_holder["proc"] = proc
        code = _wait_child(proc, shutdown)
        child_holder["proc"] = None

        if shutdown.is_set():
            # shutdown 중 자식 종료는 크래시로 분류하지 않는다(핸들러 설치 전
            # 자식이 -SIGTERM으로 죽어 nonzero여도 정상 종료 경로).
            break
        if code == 0:
            consecutive_failures = 0
        elif code == 3:
            consecutive_failures = 0
            if shutdown.wait(settings.poll_interval_seconds):
                break
        else:
            consecutive_failures += 1
            delay = min(
                settings.poll_interval_seconds * (2 ** (consecutive_failures - 1)),
                _MAX_BACKOFF_SECONDS,
            )
            log.warning(
                "child crashed (exit=%s, consecutive=%d) — backoff %.1fs",
                code,
                consecutive_failures,
                delay,
            )
            if shutdown.wait(delay):
                break
    try:
        conn.close()
    except Exception:  # noqa: BLE001
        pass
```

파일 상단 import에 추가:

```python
import subprocess
```

그리고 `_TIMEOUT_EXC`는 `subprocess.TimeoutExpired`이되, stub proc의 `wait`가 timeout을 무시하고 즉시 반환할 수 있으므로 예외 없이 동작한다. 상단에 별칭 정의:

```python
_TIMEOUT_EXC = subprocess.TimeoutExpired
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_supervisor.py -k supervisor -v`
Expected: PASS (3 passed). 실패 시 위 backoff 테스트 주의사항대로 shutdown 스텁으로 교체.

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/__main__.py worker/tests/test_supervisor.py
git commit -m "feat(worker): add run_supervisor with exit-code branching and capped backoff"
```

---

## Task 4: main argv 분기 + 2단계 시그널 + `run_loop` 제거

**Files:**
- Modify: `worker/damwha_worker/__main__.py` (`main` 재작성, `run_loop`/in-flight requeue 제거)
- Test: `worker/tests/test_supervisor.py` (main 배선 정적 검증), `worker/tests/test_worker_loop.py` (다음 Task에서 정리)

**Interfaces:**
- Consumes: `run_single_job`, `run_supervisor`.
- Produces: `run_child(settings, shutdown) -> int`, `run_supervisor_main(settings, shutdown) -> None`, 그리고 `main()`이 `sys.argv`로 둘 분기.

- [ ] **Step 1: Write the failing test (정적 배선 검증)**

`test_worker_loop.py`의 `test_main_wires_initial_connection_through_reconnect`가 소스 문자열을 검사하는 패턴을 따른다. `worker/tests/test_supervisor.py`에 추가:

```python
import inspect
from damwha_worker import __main__ as m


def test_main_dispatches_once_flag_to_child():
    src = inspect.getsource(m.main)
    assert '"--once"' in src and "sys.argv" in src
    # argparse 금지(exit 2 흡수 계약)
    assert "argparse" not in src


def test_child_spawn_uses_sys_executable_and_new_session():
    src = inspect.getsource(m.run_supervisor_main)
    assert "sys.executable" in src
    assert "start_new_session=True" in src
    assert '"python"' not in src  # 리터럴 python 금지


def test_run_loop_removed():
    assert not hasattr(m, "run_loop")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_supervisor.py -k "main or spawn or run_loop_removed" -v`
Expected: FAIL — `run_supervisor_main` 없음 / `run_loop` 아직 존재.

- [ ] **Step 3: Write minimal implementation**

`worker/damwha_worker/__main__.py`에서 **`run_loop` 함수 전체 삭제**(현재 182–227행 근처). in-flight requeue 로직도 그 안에 있으므로 함께 제거. `_reconnect`는 남긴다(부모·자식 공용).

`main()`을 아래로 교체:

```python
def run_child(settings, shutdown: threading.Event) -> int:
    """--once 자식: 시그널 핸들러 설치 후 job 1건 처리."""
    def _on_signal(signum, frame):
        log.info("signal %s received — stop at next stage boundary (send again to force)", signum)
        shutdown.set()
        signal.signal(signum, signal.SIG_DFL)  # 2차 = 즉시 종료

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    storage = Storage(settings.storage_root)
    from .models.registry import build_embedder, build_models, build_text_embedder

    return run_single_job(
        settings,
        storage,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        build_models_fn=build_models,
        build_embedder_fn=build_embedder,
        build_text_embedder_fn=build_text_embedder,
    )


def run_supervisor_main(settings, shutdown: threading.Event) -> None:
    """부모: 2단계 시그널 핸들러 설치 후 supervisor 루프."""
    child_holder = {"proc": None, "count": 0}

    def _on_signal(signum, frame):
        child_holder["count"] += 1
        shutdown.set()
        proc = child_holder["proc"]
        if proc is not None:
            if child_holder["count"] == 1:
                log.info("signal %s — forwarding SIGTERM to child (send again to kill)", signum)
                proc.terminate()
            else:
                log.info("signal %s again — killing child and exiting", signum)
                proc.kill()
                os._exit(1)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _on_signal)

    def _spawn():
        return subprocess.Popen(
            [sys.executable, "-m", "damwha_worker", "--once"],
            start_new_session=True,
        )

    log.info("supervisor %s started", settings.worker_id)
    run_supervisor(
        settings,
        shutdown,
        connect_fn=lambda: db.connect(settings.database_url),
        spawn_fn=_spawn,
        child_holder=child_holder,
    )
    log.info("supervisor %s stopped", settings.worker_id)


def main() -> None:  # pragma: no cover — 실모델 + 시그널 배선 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    shutdown = threading.Event()
    if "--once" in sys.argv[1:]:
        sys.exit(run_child(settings, shutdown))
    run_supervisor_main(settings, shutdown)
```

파일 상단 import에 `import os`, `import sys` 추가(없으면). `signal`은 이미 있음.

> `main`에 `# pragma: no cover`가 있어도 위 정적 테스트는 `inspect.getsource`로 문자열만 보므로 커버리지와 무관하게 통과한다.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_supervisor.py -v`
Expected: PASS. (`run_loop` 제거로 `test_worker_loop.py`가 import 에러 날 수 있음 — 다음 Task에서 정리. 지금은 `test_supervisor.py`만 녹색이면 OK.)

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/__main__.py worker/tests/test_supervisor.py
git commit -m "feat(worker): supervisor/child argv dispatch and two-stage signal handling"
```

---

## Task 5: `test_worker_loop.py`에서 `run_loop` 테스트 제거

**Files:**
- Modify: `worker/tests/test_worker_loop.py`

**Interfaces:** 없음(테스트 정리).

- [ ] **Step 1: import와 테스트 제거**

`test_worker_loop.py` 5행 import에서 `run_loop` 제거:

```python
from damwha_worker.__main__ import _reconnect, dispatch_claimed_job, handle_job, run_once
```

아래 4개 테스트 함수와 그 전용 헬퍼를 삭제(현재 파일 463–567행 근처):
- `class _BrokenConn`
- `test_run_loop_exits_immediately_when_shutdown_set`
- `test_run_loop_reconnects_and_requeues_inflight_on_dispatch_error`
- `test_run_loop_leaves_exhausted_job_for_reaper`
- `test_run_loop_survives_claim_error`

`_reconnect` 테스트(`test_reconnect_returns_connection_on_success`, `test_reconnect_backoff_doubles_and_stops_on_shutdown`)와 `test_main_wires_initial_connection_through_reconnect`는 **유지**한다 — 단, 마지막 것은 `main`이 바뀌었으므로 Step 2에서 갱신.

- [ ] **Step 2: `test_main_wires_initial_connection_through_reconnect` 갱신**

이 테스트는 옛 `main`의 `_reconnect(lambda: db.connect` 배선을 검사한다. 새 `main`에서 초기 연결은 `run_supervisor`/`run_single_job` 내부의 `_reconnect(connect_fn, ...)`로 이동했다. 검사 대상을 `run_supervisor_main`으로 바꾼다:

```python
def test_supervisor_connects_through_reconnect():
    import inspect
    from damwha_worker import __main__ as m
    src = inspect.getsource(m.run_supervisor)
    assert "_reconnect(connect_fn" in src
    src2 = inspect.getsource(m.run_supervisor_main)
    assert "connect_fn=lambda: db.connect" in src2
```

옛 `test_main_wires_initial_connection_through_reconnect`는 삭제.

- [ ] **Step 3: Run full worker suite**

Run: `cd worker && uv run pytest -q`
Expected: PASS (전체 녹색). import 에러/잔존 `run_loop` 참조 없음.

- [ ] **Step 4: Commit**

```bash
git add worker/tests/test_worker_loop.py
git commit -m "test(worker): replace run_loop tests with supervisor wiring checks"
```

---

## Task 6: BGE-M3 CPU 강제 (보조, smoke 검증)

**Files:**
- Modify: `worker/damwha_worker/models/bge_embed.py`

**Interfaces:** 변경 없음(`embed_texts` 시그니처 동일).

- [ ] **Step 1: device="cpu" 전달**

`worker/damwha_worker/models/bge_embed.py`의 `__init__` 수정:

```python
    def __init__(self, model_name: str = "BAAI/bge-m3") -> None:
        from sentence_transformers import SentenceTransformer

        # 텍스트 임베더는 MPS를 쓰지 않는다 — 파이프라인 GPU 모델과의 메모리 경쟁
        # 회피(ECAPA가 CPU로 강제되는 것과 동일 근거). 색인은 백그라운드 job이라
        # CPU 지연이 무해하다.
        self._model = SentenceTransformer(model_name, device="cpu")
```

- [ ] **Step 2: 결정적 스위트 회귀 없음 확인**

Run: `cd worker && uv run pytest -q`
Expected: PASS. (bge_embed는 `models` extra라 CI 스위트가 import하지 않음 — 회귀 없음만 확인.)

- [ ] **Step 3: smoke 노트**

이 변경의 실검증은 `worker/SMOKE.md`의 index 경로 smoke에서 확인한다(Task 8에서 문서화). 코드 리뷰어는 `device="cpu"`가 `SentenceTransformer` 생성자에 전달되는지만 확인.

- [ ] **Step 4: Commit**

```bash
git add worker/damwha_worker/models/bge_embed.py
git commit -m "fix(worker): force BGE-M3 text embedder to CPU to avoid MPS contention"
```

---

## Task 7: MLX active 메모리 상한 (보조, smoke 검증)

**Files:**
- Modify: `worker/damwha_worker/models/whisper_mlx.py`

**Interfaces:** 변경 없음.

- [ ] **Step 1: mlx 설치본 API 확인**

Run: `cd worker && uv run --extra models python -c "import mlx.core as mx; print([n for n in ('set_memory_limit','set_cache_limit') if hasattr(mx, n)])"`
Expected: `['set_memory_limit', 'set_cache_limit']` 중 존재하는 것 출력. 없으면 `mx.metal` 하위 확인:
`uv run --extra models python -c "import mlx.core as mx; import inspect; print([n for n in dir(mx) if 'limit' in n.lower()]); print(hasattr(mx,'metal') and [n for n in dir(mx.metal) if 'limit' in n.lower()])"`

- [ ] **Step 2: active 메모리 상한 설정**

`worker/damwha_worker/models/whisper_mlx.py`의 `transcribe` 진입부에 추가(Step 1에서 확인한 정확한 심볼 사용; 아래는 top-level `set_memory_limit` 기준):

```python
    def transcribe(self, wav_path: str, language: str) -> list[Word]:
        import mlx.core as mx
        import mlx_whisper

        # job 내부 GPU 피크 억제: MLX active 메모리 상한(물리 메모리의 절반).
        # subprocess 격리는 job '간' 누적만 막고, 단독 process_meeting의 내부
        # 피크는 이 상한으로 방어한다. (cache_limit은 idle 상한이라 목적이 다름.)
        import psutil  # 이미 base deps인지 확인 — 없으면 os.sysconf로 대체

        mx.set_memory_limit(int(psutil.virtual_memory().total * 0.5))
```

> `psutil`이 base 의존이 아니면(확인: `grep psutil worker/pyproject.toml`) `os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')`로 물리 메모리를 구한다. Step 1에서 심볼명이 `mx.metal.set_memory_limit`이면 그쪽으로.

- [ ] **Step 3: 결정적 스위트 회귀 없음 확인**

Run: `cd worker && uv run pytest -q`
Expected: PASS. (whisper_mlx는 `models` extra라 CI 미import.)

- [ ] **Step 4: Commit**

```bash
git add worker/damwha_worker/models/whisper_mlx.py
git commit -m "fix(worker): cap MLX active memory to curb in-job GPU peak"
```

---

## Task 8: 문서 갱신

**Files:**
- Modify: `docs/worker-architecture.md`
- Modify: `worker/SMOKE.md`

**Interfaces:** 없음.

- [ ] **Step 1: `worker-architecture.md` 프로세스 모델 갱신**

"ML worker poller — `python -m damwha_worker`로 실행" 서술을 supervisor 모델로 갱신. 추가할 요지(해당 섹션 산문에 녹여서):

```markdown
`python -m damwha_worker`는 **supervisor 부모**를 띄운다. 부모는 torch/pyannote를
import하지 않고 `job` 큐를 peek만 하며, 처리 대기 job이 있으면 자식
`python -m damwha_worker --once`를 spawn(`start_new_session=True`)하고 종료를
기다린다. 자식은 job 1건을 claim→heartbeat→dispatch로 처리한 뒤 exit하고, OS가
자식의 GPU 메모리(MLX·torch)를 전부 회수한다 — 이것이 job 간 MPS 메모리 누적으로
인한 OOM을 막는 핵심이다. 자식 exit code(0=처리, 3=no job, 그 외=크래시)로 부모가
분기하며, claim 전 결정적 실패로 인한 무한 spawn은 capped backoff로 스로틀한다.
graceful shutdown은 부모가 자식에 SIGTERM을 전달해 자식의 stage-boundary 종료
로직을 태우고, 2차 시그널은 자식을 SIGKILL한다.
```

이전 "resilient poll loop"(단일 프로세스 재접속) 서술은 이 모델로 대체됨을 명시. heartbeat 스레드 재접속(자식 내부)은 유지됨을 언급.

- [ ] **Step 2: `SMOKE.md` 실행 커맨드 반영**

`uv run python -m damwha_worker`가 supervisor를 띄우고 job당 자식을 spawn한다는 한 문단 추가. BGE-M3 CPU / MLX 메모리 상한 변경으로 index·process 경로 smoke에서 OOM 없이 완주하는지가 확인 포인트임을 명시.

- [ ] **Step 3: Commit**

```bash
git add docs/worker-architecture.md worker/SMOKE.md
git commit -m "docs: update worker docs for subprocess-per-job supervisor model"
```

---

## Task 9 (Optional): OOM 분류 정정

**Files:**
- Modify: `worker/damwha_worker/errors.py`
- Test: `worker/tests/test_errors.py`

**Interfaces:** `classify` 반환 동작만 확장(시그니처 동일).

- [ ] **Step 1: Write the failing test**

`worker/tests/test_errors.py`에 추가:

```python
def test_mps_oom_runtimeerror_classified_as_oom():
    exc = RuntimeError("MPS backend out of memory (MPS allocated: 4.01 GiB, ...)")
    werr = classify(exc)
    assert werr.code == OOM
    assert werr.kind is ErrorKind.TRANSIENT
```

(파일 상단에 `from damwha_worker.errors import OOM, ErrorKind, classify`가 있는지 확인.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_errors.py -k oom -v`
Expected: FAIL — `assert 'uncategorized' == 'oom'`

- [ ] **Step 3: Implement**

`worker/damwha_worker/errors.py`의 `classify`에서 `MemoryError` 분기 뒤, uncategorized 폴백 앞에 추가:

```python
    if isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower():
        return WorkerError(OOM, str(exc), ErrorKind.TRANSIENT)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_errors.py -k oom -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/errors.py worker/tests/test_errors.py
git commit -m "fix(worker): classify MPS/CUDA OOM RuntimeError as oom"
```

---

## Self-Review 결과

**Spec coverage:**
- §3 구조(supervisor/자식) → Task 2·3·4. §4 기동(spawn/argv/stdout) → Task 3·4. §5 exit code + backoff → Task 3. §6 shutdown 2단계 + returncode 오분류 + 고아 자식 → Task 3(shutdown 분기)·4(핸들러). §7 크래시 복구(reaper 위임) → Task 3(코드 분기, 추가 배선 없음)로 커버. §8 run_loop 제거 + peek 재접속 → Task 1·3·4·5. §9 보조(BGE CPU/MLX) → Task 6·7. §10 테스트 → Task 2·3·5(stub 자식·exit code·backoff·shutdown·peek 재접속). §11 문서 → Task 8. §12 선택 OOM 분류 → Task 9.
- 갭: §10의 "shutdown 전달: 부모 시그널 → 자식 SIGTERM → 종료; 2차 → SIGKILL" 통합 테스트는 실 `subprocess`가 필요해 stub으로는 부분만 검증됨 — Task 4의 정적 배선 검사(`terminate`/`kill`/`os._exit` 존재)로 보완. 완전한 e2e 시그널 테스트는 smoke 영역으로 남긴다(문서 명시).

**Placeholder scan:** "TBD"/"적절히 처리" 없음. Task 7 Step 1은 실행형 확인 커맨드(placeholder 아님) — mlx 심볼명이 버전 의존이라 의도된 런타임 확인.

**Type consistency:** `run_single_job`/`run_supervisor`/`run_supervisor_main`/`run_child` 시그니처가 Task 2·3·4에서 일관. `child_holder` dict 키(`"proc"`,`"count"`)가 Task 3·4에서 일치. exit code(0/3/기타)가 Task 2·3·4·5·8에서 일관. `spawn_fn`/`connect_fn` 파라미터명 일치.

---

## Execution Handoff

계획은 `docs/superpowers/plans/2026-07-09-worker-subprocess-isolation.md`에 저장됨.
