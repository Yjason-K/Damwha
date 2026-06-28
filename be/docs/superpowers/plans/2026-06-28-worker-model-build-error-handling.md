# Worker Model-Build Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모델 빌드(`build_models`/`build_text_embedder`) 실패가 워커 프로세스를 죽이지 않고, 기존 `classify → requeue/fail` 정책을 타도록 한다.

**Architecture:** 빌드를 이미 guarded·heartbeat로 보호된 `handle_job`의 `try` 안에서 **빌더 콜백**으로 호출한다. `main()`의 per-job 처리(heartbeat + 콜백 주입)를 테스트 가능한 `dispatch_claimed_job` 헬퍼로 분리하고, registry import는 claim 이전으로 호이스팅한다. import류 예외는 `classify()`에서 PERMANENT(즉시 fail)로 분류한다.

**Tech Stack:** Python 3.12, pytest + testcontainers(실 Postgres), psycopg3, pydantic v2. 모든 테스트는 fake 모델 — heavy ML import 없음.

## Global Constraints

- **워커 단독 변경**: `worker/`만 수정. `src/`(NestJS) 무변경.
- **테스트 격리 불변식**: registry/adapters(ecapa/pyannote/silero/bge)는 `__main__.main()`에서만 import. 테스트 스위트는 `main()`을 호출하지 않으므로 heavy import가 발생하지 않는다. 신규 테스트도 fake 콜백만 쓰고 registry를 import하지 않는다.
- **에러 분류 정책 (Option A)**: `ModuleNotFoundError`/`ImportError` → `model_load_failed` + `ErrorKind.PERMANENT`(즉시 fail). 그 외 빌드 오류 → 기존 fall-through(`uncategorized` → TRANSIENT, attempts 남으면 requeue).
- **job 타입별 실패 라우팅(변경 없음, 빌드 실패도 동일 적용)**: `process_meeting` → `fail_process_meeting`(job+meeting failed) / `index_meeting` → `fail_job`(job만 failed, meeting `done` 유지) / `enroll_speaker` → `fail_enroll`(job+speaker failed).
- **검증 게이트**: `cd worker && uv run pytest -q` 전체 통과 + `uv run ruff check . && uv run ruff format --check .`. (Docker 필요: testcontainers)
- 스펙: `docs/superpowers/specs/2026-06-28-worker-model-build-error-handling-design.md`

---

## File Structure

- `worker/damwha_worker/errors.py` — `classify()`에 import류 → PERMANENT 분기 추가 (Task 1)
- `worker/damwha_worker/__main__.py` — `handle_job`/`run_once` 빌더 콜백화(Task 2), `dispatch_claimed_job` 헬퍼 + `main()` 재작성 + registry 호이스팅(Task 3)
- `worker/tests/test_errors.py` — import류 분류 테스트 (Task 1)
- `worker/tests/test_worker_loop.py` — 호출부 갱신 + 빌드 실패/배선 테스트 (Task 2, 3)
- `worker/tests/test_dispatch_index.py` — `text_embedder=`/`run_once` 호출부 갱신 (Task 2)
- `worker/scripts/smoke_process_meeting.py` — `run_once` 호출부 갱신 (Task 2, CI 아님)

---

### Task 1: classify() — import류를 PERMANENT로

**Files:**
- Modify: `worker/damwha_worker/errors.py:48-56` (`classify`), `:41` 주변 주석
- Test: `worker/tests/test_errors.py`

**Interfaces:**
- Consumes: 기존 `WorkerError`, `ErrorKind`, `MODEL_LOAD_FAILED` 상수
- Produces: `classify(ModuleNotFoundError(...))` / `classify(ImportError(...))` → `WorkerError(code="model_load_failed", kind=PERMANENT)`

- [ ] **Step 1: Write the failing test**

`worker/tests/test_errors.py` 끝에 추가:

```python
def test_classify_import_error_is_permanent():
    w = classify(ModuleNotFoundError("No module named 'sentence_transformers'"))
    assert w.kind is ErrorKind.PERMANENT
    assert w.code == "model_load_failed"


def test_classify_plain_import_error_is_permanent():
    w = classify(ImportError("cannot import name 'X'"))
    assert w.kind is ErrorKind.PERMANENT
    assert w.code == "model_load_failed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_errors.py -q`
Expected: 두 신규 테스트 FAIL — 현재 `classify(ModuleNotFoundError)`는 `uncategorized`/TRANSIENT로 떨어짐 (`assert w.code == "model_load_failed"`에서 실패).

- [ ] **Step 3: Add the import-error branch**

`worker/damwha_worker/errors.py`의 `classify()`에서 `UnsupportedPayloadVersion` 분기 **다음**, `MemoryError` 분기 **이전**에 추가:

```python
    if isinstance(exc, (ModuleNotFoundError, ImportError)):
        return WorkerError(MODEL_LOAD_FAILED, str(exc), ErrorKind.PERMANENT)
```

그리고 `:41`의 주석 `# Transient codes`를 다음으로 보정(코드가 원인에 따라 kind가 갈림을 명시):

```python
# Mostly-transient codes (model_load_failed는 import류일 때 PERMANENT — classify 참조)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd worker && uv run pytest tests/test_errors.py -q`
Expected: PASS (전체 test_errors 통과).

- [ ] **Step 5: Lint + commit**

```bash
cd worker && uv run ruff check . && uv run ruff format --check .
git add worker/damwha_worker/errors.py worker/tests/test_errors.py
git commit -m "feat(worker): classify import/module errors as PERMANENT"
```

---

### Task 2: 빌드를 guarded 콜백으로 — handle_job/run_once 시그니처 + 전 호출부 + 빌드 실패 테스트

**Files:**
- Modify: `worker/damwha_worker/__main__.py:1-101` (imports, `handle_job`, `run_once`)
- Modify: `worker/tests/test_worker_loop.py` (호출부 갱신 + 신규 테스트)
- Modify: `worker/tests/test_dispatch_index.py:43-49,71-77,99` (호출부 갱신)
- Modify: `worker/scripts/smoke_process_meeting.py:109` (호출부 갱신, CI 아님)

**Interfaces:**
- Consumes: `db.claim`, `parse_payload`, `classify`, `run_process_meeting`/`run_enroll_speaker`/`run_index_meeting`, `db.requeue`/`fail_*`
- Produces (later tasks/tests rely on these exact signatures):
  - `handle_job(conn, job, storage, worker_id, *, build_models=None, build_text_embedder=None, search_embedding=None) -> str`
  - `run_once(conn, worker_id, storage, *, build_models=None, build_text_embedder=None, search_embedding=None) -> str | None`
  - `build_models`/`build_text_embedder`는 **무인자 콜백**: `build_models() -> Models`, `build_text_embedder() -> TextEmbedder`. `handle_job`의 `try` 안에서 타입에 맞는 콜백만 호출된다.

> 이 태스크는 시그니처를 바꾸므로 모든 직접 호출부를 같은 커밋에서 갱신해야 스위트가 green을 유지한다. 신규 빌드-실패 테스트를 먼저 작성(red)한 뒤 리팩터링(green)한다.

- [ ] **Step 1: Write the new build-failure tests (red)**

`worker/tests/test_worker_loop.py`에 추가. 파일 상단 import에 `from tests.conftest import seed_job, seed_meeting, seed_speaker` 로 `seed_speaker` 추가, `from damwha_worker.errors import ErrorKind, WorkerError`는 기존 유지.

인덱스 job 시딩 헬퍼 + 신규 테스트:

```python
def _enqueue_index(conn, pv=0):
    mid = seed_meeting(conn, status="done", processing_version=pv)
    payload = {
        "schema_version": 1,
        "meeting_id": str(mid),
        "processing_version": pv,
        "search_embedding": {"model": "BAAI/bge-m3", "dimension": 1024},
    }
    jid = seed_job(conn, type="index_meeting", meeting_id=mid, payload=payload)
    return mid, jid


def _boom(exc):
    def _raise():
        raise exc
    return _raise


def test_index_build_failure_marks_job_only(conn, tmp_path):
    mid, jid = _enqueue_index(conn)
    job = db.claim(conn, "w1")
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        build_text_embedder=_boom(ModuleNotFoundError("no sentence_transformers")),
    )
    assert out == "failed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"


def test_process_build_failure_fails_meeting(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        build_models=_boom(ImportError("torch missing")),
    )
    assert out == "failed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "failed"


def test_process_build_transient_requeues_when_attempts_left(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")  # attempts=1, max=3
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        build_models=_boom(WorkerError("io_error", "x", ErrorKind.TRANSIENT)),
    )
    assert out == "requeued"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "queued"


def test_enroll_build_failure_fails_speaker(conn, tmp_path):
    sid = seed_speaker(conn, enrollment_status="pending")
    payload = {
        "schema_version": 1,
        "speaker_id": str(sid),
        "audio_key": "speakers/s/original.m4a",
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
    }
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None, payload=payload)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    job = db.claim(conn, "w1")
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        build_models=_boom(ModuleNotFoundError("speechbrain missing")),
    )
    assert out == "failed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "failed"
    )
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `cd worker && uv run pytest tests/test_worker_loop.py -q -k "build_failure or build_transient"`
Expected: FAIL — 현재 `handle_job`은 `build_models`/`build_text_embedder` kwarg를 모름 → `TypeError: handle_job() got an unexpected keyword argument 'build_models'`.

- [ ] **Step 3: Refactor `handle_job` to call builder callbacks inside the try**

`worker/damwha_worker/__main__.py` 상단 import에서 `Models`를 제거(시그니처에서 더 이상 타입힌트로 안 씀 → ruff unused 방지):

```python
from .pipeline.process_meeting import run_process_meeting
```

`handle_job`을 아래 **완전한 함수**로 교체한다. 변경점은 시그니처(`models`/`text_embedder` → `build_models`/`build_text_embedder` 콜백)와 `try` 본문에서 빌더를 호출하는 부분뿐이며, `except` 블록(분류/requeue/fail 라우팅)은 기존과 **동일**하다(아래에 전체 포함):

```python
def handle_job(
    conn,
    job: dict,
    storage: Storage,
    worker_id: str,
    *,
    build_models=None,
    build_text_embedder=None,
    search_embedding=None,
) -> str:
    try:
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
            )
        if job["type"] == "enroll_speaker":
            models = build_models()
            return run_enroll_speaker(
                conn, job, payload, models.embedder, storage, worker_id=worker_id
            )
        if job["type"] == "index_meeting":
            text_embedder = build_text_embedder()
            return run_index_meeting(conn, job, payload, text_embedder, worker_id=worker_id)
        raise ValueError(f"unknown job type {job['type']}")
    except Exception as exc:  # noqa: BLE001 — 분류해서 requeue/fail
        werr = classify(exc)
        error_json = werr.to_json(stage=job.get("stage"))
        log.warning(
            "job %s failed: code=%s kind=%s attempt=%s/%s",
            job["id"],
            werr.code,
            werr.kind.value,
            job["attempts"],
            job["max_attempts"],
        )
        transient_retry = werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]
        if job["type"] == "enroll_speaker":
            speaker_id = (job["payload"] or {}).get("speaker_id")
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            ok = db.fail_enroll(conn, job["id"], worker_id, speaker_id, error_json)
            return "failed" if ok else "lost"
        if job["type"] == "index_meeting":
            # 검색 색인 실패는 job만 — meeting은 done 유지
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return "failed" if db.fail_job(conn, job["id"], worker_id, error_json) else "lost"
        # process_meeting
        meeting_id = job["meeting_id"]
        if transient_retry:
            return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
        return (
            "failed"
            if db.fail_process_meeting(conn, job["id"], worker_id, meeting_id, error_json)
            else "lost"
        )
```

- [ ] **Step 4: Refactor `run_once` to mirror the builders**

같은 파일의 `run_once`를 교체(positional `models` 제거, `storage`는 positional 유지):

```python
def run_once(
    conn,
    worker_id: str,
    storage: Storage,
    *,
    build_models=None,
    build_text_embedder=None,
    search_embedding=None,
) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(
        conn,
        job,
        storage,
        worker_id,
        build_models=build_models,
        build_text_embedder=build_text_embedder,
        search_embedding=search_embedding,
    )
```

- [ ] **Step 5: Migrate existing call sites in `test_worker_loop.py`**

- `test_run_once_processes_to_done`: `run_once(conn, "w1", _models(), Storage(str(tmp_path)))` → `run_once(conn, "w1", Storage(str(tmp_path)), build_models=_models)` (`_models`는 무인자로 `Models` 반환 → 콜백 그대로).
- `test_run_once_empty_returns_none`: `run_once(conn, "w1", _models(), Storage(str(tmp_path)))` → `run_once(conn, "w1", Storage(str(tmp_path)), build_models=_models)`.
- `test_transient_error_requeues_when_attempts_left`: `handle_job(conn, job, Storage(str(tmp_path)), "w1", models=boom)` → `build_models=lambda: boom`.
- `test_permanent_error_fails`: 동일하게 `models=boom` → `build_models=lambda: boom`.

- [ ] **Step 6: Migrate existing call sites in `test_dispatch_index.py`**

- `test_index_permanent_failure_fails_job_only` (line 43-49): `text_embedder=RaisingTextEmbedder(ErrorKind.PERMANENT)` → `build_text_embedder=lambda: RaisingTextEmbedder(ErrorKind.PERMANENT)`.
- `test_index_transient_failure_requeues` (line 71-77): `text_embedder=RaisingTextEmbedder(ErrorKind.TRANSIENT)` → `build_text_embedder=lambda: RaisingTextEmbedder(ErrorKind.TRANSIENT)`.
- `test_run_once_handles_index_job` (line 99): `run_once(conn, "w1", None, Storage(str(tmp_path)), text_embedder=FakeTextEmbedder())` → `run_once(conn, "w1", Storage(str(tmp_path)), build_text_embedder=lambda: FakeTextEmbedder())`.

- [ ] **Step 7: Migrate the smoke script call site**

`worker/scripts/smoke_process_meeting.py:109`: `outcome = run_once(conn, "smoke-worker", models, storage)` → `outcome = run_once(conn, "smoke-worker", storage, build_models=lambda: models)` (line 103의 `models = build_models(payload, settings)` eager 빌드는 유지 — 실모델 로딩 타이밍 보존).

- [ ] **Step 8: Run the full worker suite**

Run: `cd worker && uv run pytest -q`
Expected: PASS — 신규 4종(build_failure/transient) 포함 전체 통과, 마이그레이션된 기존 테스트도 green.

- [ ] **Step 9: Lint + commit**

```bash
cd worker && uv run ruff check . && uv run ruff format --check .
git add worker/damwha_worker/__main__.py worker/tests/test_worker_loop.py worker/tests/test_dispatch_index.py worker/scripts/smoke_process_meeting.py
git commit -m "feat(worker): build models via guarded callback so build failures classify, not crash"
```

---

### Task 3: dispatch_claimed_job 헬퍼 + main() 재작성 + registry 호이스팅

**Files:**
- Modify: `worker/damwha_worker/__main__.py` (신규 `dispatch_claimed_job`, `main()` 재작성)
- Modify: `worker/tests/test_worker_loop.py` (배선 검증 테스트)

**Interfaces:**
- Consumes: Task 2의 `handle_job(...)` 빌더 시그니처
- Produces:
  - `dispatch_claimed_job(conn, job, storage, settings, *, build_models_fn, build_text_embedder_fn, heartbeat_cm) -> str`
  - `build_models_fn(payload, settings) -> Models`, `build_text_embedder_fn(settings) -> TextEmbedder`, `heartbeat_cm`은 컨텍스트매니저. 헬퍼는 `with heartbeat_cm:` 안에서 `handle_job`에 **람다 콜백**으로 주입한다.

- [ ] **Step 1: Write the failing wiring test**

`worker/tests/test_worker_loop.py`에 추가. 상단 import에 `from types import SimpleNamespace`, `from damwha_worker.__main__ import dispatch_claimed_job` 추가.

```python
class _SpyCM:
    def __init__(self):
        self.entered = False
        self.exited = False

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *exc):
        self.exited = True
        return False


def test_dispatch_claimed_job_builds_lazily_within_heartbeat(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    cm = _SpyCM()
    calls = []

    def fake_build_models_fn(payload, settings):
        # 빌더는 heartbeat 진입 후·종료 전에, 콜백 경유로만 호출돼야 한다
        assert cm.entered and not cm.exited
        calls.append(payload["meeting_id"])
        return _models()

    settings = SimpleNamespace(
        worker_id="w1",
        search_embedding_model="BAAI/bge-m3",
        search_embedding_dim=1024,
    )
    out = dispatch_claimed_job(
        conn,
        job,
        Storage(str(tmp_path)),
        settings,
        build_models_fn=fake_build_models_fn,
        build_text_embedder_fn=lambda s: None,  # process_meeting에선 호출 안 됨
        heartbeat_cm=cm,
    )
    assert out == "committed"
    assert calls == [str(mid)]  # 빌더 콜백이 정확히 1회 실행
    assert cm.entered and cm.exited  # heartbeat 스코프가 처리를 감쌈
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd worker && uv run pytest tests/test_worker_loop.py -q -k dispatch_claimed`
Expected: FAIL — `ImportError: cannot import name 'dispatch_claimed_job'`.

- [ ] **Step 3: Add `dispatch_claimed_job` and rewrite `main()`**

`worker/damwha_worker/__main__.py`에 `dispatch_claimed_job` 추가(예: `run_once` 다음):

```python
def dispatch_claimed_job(
    conn,
    job: dict,
    storage: Storage,
    settings,
    *,
    build_models_fn,
    build_text_embedder_fn,
    heartbeat_cm,
) -> str:
    with heartbeat_cm:
        return handle_job(
            conn,
            job,
            storage,
            settings.worker_id,
            build_models=lambda: build_models_fn(job["payload"], settings),
            build_text_embedder=lambda: build_text_embedder_fn(settings),
            search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
        )
```

`main()`을 전체 교체(registry/Heartbeat import를 `while` 루프 **이전**으로 호이스팅, per-type if/else 제거):

```python
def main() -> None:  # pragma: no cover — 실모델 + 무한 루프 (로컬 실행)
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    storage = Storage(settings.storage_root)
    conn = db.connect(settings.database_url)
    from .heartbeat import Heartbeat
    from .models.registry import build_models, build_text_embedder

    log.info("worker %s started", settings.worker_id)
    while True:
        job = db.claim(conn, settings.worker_id)
        if job is None:
            time.sleep(settings.poll_interval_seconds)
            continue
        hb = Heartbeat(
            settings.database_url,
            job["id"],
            settings.worker_id,
            settings.heartbeat_interval_seconds,
        )
        outcome = dispatch_claimed_job(
            conn,
            job,
            storage,
            settings,
            build_models_fn=build_models,
            build_text_embedder_fn=build_text_embedder,
            heartbeat_cm=hb,
        )
        log.info("job %s → %s", job["id"], outcome)
        time.sleep(settings.poll_interval_seconds)
```

- [ ] **Step 4: Run the wiring test + full suite**

Run: `cd worker && uv run pytest tests/test_worker_loop.py -q -k dispatch_claimed`
Expected: PASS.

Run: `cd worker && uv run pytest -q`
Expected: PASS (전체).

- [ ] **Step 5: Lint + commit**

```bash
cd worker && uv run ruff check . && uv run ruff format --check .
git add worker/damwha_worker/__main__.py worker/tests/test_worker_loop.py
git commit -m "feat(worker): extract testable dispatch_claimed_job, hoist registry import before claim"
```

---

## Final Verification

- [ ] **전체 게이트 재확인**

```bash
cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check .
```
Expected: 전체 PASS, ruff 클린.

- [ ] **(선택) 실 환경 재현 검증** — Task 완료 후, 의존성이 빠진 상태를 인위적으로 만들지 않고도 다음으로 회귀 부재를 확인 가능: 정상 워커 1회 실행(`uv sync --extra models` 환경)에서 `process_meeting` + `index_meeting`이 여전히 `committed`되는지. (이번 수정은 정상 경로 동작을 보존하고 실패 경로만 보강한다.)

## 범위 밖 (재확인)

- `enroll_speaker`의 기능적 빌드 버그(payload에 `models` 없음 → 실 워커에서 `KeyError`)는 본 작업으로 **graceful-fail**(크래시 방지)까지만 처리된다. enroll 정상 동작용 전용 빌더는 `docs/backlog.md`에 별도 등록됨.
