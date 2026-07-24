# Worker Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make worker model-boot failures terminal, transient retries delayed, normalized WAV publishing atomic, and stale-job recovery independent of the API runtime.

**Architecture:** Keep Postgres as the only queue. A backward-compatible migration adds an eligibility timestamp that both TypeScript and Python claim paths honor. The worker owns a redundant reaper thread while the API cron remains safe through `SKIP LOCKED`; ffmpeg publishes only probe-verified files through atomic replacement.

**Tech Stack:** PostgreSQL 16, NestJS/TypeScript/Jest, Python 3.12, psycopg3, pytest, ffmpeg/ffprobe.

## Global Constraints

- Preserve the existing `job` table as the API/worker contract; migration files are append-only.
- Retain the NestJS reaper; worker reaping is a redundant recovery actor and must use `FOR UPDATE SKIP LOCKED`.
- Retry delays are deterministic: `min(2^(attempts-1), 60)` seconds; do not add jitter.
- `requeue_for_shutdown` and stale reaping make a job immediately eligible (`next_attempt_at=NULL`).
- Do not implement resource-class queues in this change; document the measured-latency promotion criterion only.
- Run Python tests with `cd worker && uv run pytest`; run API tests with `npx jest --runInBand`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/database/migrations/015_job_retry_schedule.sql` | Add retry eligibility timestamp and lookup index. |
| `src/jobs/jobs.repository.ts` | Claim only eligible queued jobs and clear eligibility at claim. |
| `src/jobs/jobs.types.ts` | Expose `next_attempt_at` to TypeScript callers. |
| `test/jobs.repository.spec.ts` | Prove API claim honors delayed eligibility. |
| `worker/damwha_worker/db.py` | Python eligible claim, delayed requeue, and stale-recovery SQL. |
| `worker/damwha_worker/__main__.py` | Lazy adapter callbacks and worker-owned reaper lifecycle. |
| `worker/damwha_worker/reaper.py` | Isolated periodic reaper loop. |
| `worker/damwha_worker/config.py` | Worker reaper configuration. |
| `worker/damwha_worker/pipeline/ffmpeg.py` | Temporary write, probe, atomic replace, cleanup. |
| `worker/tests/test_supervisor.py` | Model-build failure and supervisor/reaper behavior. |
| `worker/tests/test_db_lifecycle.py` | Retry eligibility and Python stale reaper integration coverage. |
| `worker/tests/test_ffmpeg.py` | Atomic normalization behavior. |
| `docs/worker-architecture.md` | Living operational contract and resource-queue promotion criterion. |

### Task 1: Add queue retry scheduling to schema and API claim

**Files:**
- Create: `src/database/migrations/015_job_retry_schedule.sql`
- Modify: `src/jobs/jobs.repository.ts:21-32`
- Modify: `src/jobs/jobs.types.ts:7-22`
- Modify: `test/jobs.repository.spec.ts:24-48`

**Interfaces:**
- Produces `job.next_attempt_at timestamptz NULL`.
- Produces `JobsRepository.claim(exec, workerId): Promise<JobRow | null>` that claims only an eligible job.
- `JobRow.next_attempt_at` is `Date | null`.

- [ ] **Step 1: Write the failing API claim tests**

```ts
it('does not claim a queued job scheduled for the future', async () => {
  const mid = await seedMeeting();
  const job = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
  await db.pool.query(`UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=$1`, [job.id]);

  expect(await repo.claim(db.pool, 'worker-1')).toBeNull();
});

it('claims an immediately eligible job ahead of an older delayed job', async () => {
  const delayedMeeting = await seedMeeting();
  const delayed = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: delayedMeeting, payload: {} });
  await db.pool.query(`UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=$1`, [delayed.id]);
  const readyMeeting = await seedMeeting();
  const ready = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: readyMeeting, payload: {} });

  expect((await repo.claim(db.pool, 'worker-1'))!.id).toBe(ready.id);
});
```

- [ ] **Step 2: Run the API test to verify it fails because the column does not exist**

Run: `npx jest test/jobs.repository.spec.ts --runInBand`

Expected: FAIL with PostgreSQL error mentioning `next_attempt_at`.

- [ ] **Step 3: Add the migration, type, and eligible claim implementation**

Create `src/database/migrations/015_job_retry_schedule.sql`:

```sql
ALTER TABLE job ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX job_status_next_attempt_created_idx
  ON job (status, next_attempt_at, created_at);
```

Add to `JobRow`:

```ts
next_attempt_at: Date | null;
```

Replace the repository claim SQL with:

```ts
`UPDATE job SET status='running', locked_by=$1, locked_at=now(),
                attempts = attempts + 1, next_attempt_at=NULL, updated_at=now()
 WHERE id IN (
   SELECT id FROM job
   WHERE status='queued'
     AND (next_attempt_at IS NULL OR next_attempt_at <= now())
   ORDER BY next_attempt_at NULLS FIRST, created_at
   FOR UPDATE SKIP LOCKED LIMIT 1
 ) RETURNING *`
```

- [ ] **Step 4: Run the API queue test to verify it passes**

Run: `npx jest test/jobs.repository.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit the API queue contract**

```bash
git add src/database/migrations/015_job_retry_schedule.sql src/jobs/jobs.repository.ts src/jobs/jobs.types.ts test/jobs.repository.spec.ts
git commit -m "feat: schedule transient job retries"
```

### Task 2: Make Python claim/requeue honor retry scheduling and lazy-load adapters

**Files:**
- Modify: `worker/damwha_worker/db.py:10-78`
- Modify: `worker/damwha_worker/__main__.py:344-372`
- Modify: `worker/tests/test_db_lifecycle.py`
- Modify: `worker/tests/test_supervisor.py:51-67`

**Interfaces:**
- Consumes `job.next_attempt_at` from Task 1.
- Produces `db.claim(conn, worker_id)` with the same eligibility predicate as the API.
- Produces `db.requeue(conn, job_id, worker_id)` that sets the deterministic delay from `attempts`.
- `run_child()` passes adapter callbacks that import their module only when called after claim.

- [ ] **Step 1: Write failing Python retry and post-claim builder tests**

```python
def test_claim_skips_future_retry_until_eligible(conn):
    delayed = seed_job(conn, type="index_meeting", payload={"schema_version": 1})
    conn.execute("UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=%s", (delayed,))
    ready = seed_job(conn, type="index_meeting", payload={"schema_version": 1})

    assert db.claim(conn, "w1")["id"] == ready


def test_requeue_sets_delay_from_claimed_attempt(conn):
    job_id = seed_job(conn, type="index_meeting", payload={"schema_version": 1})
    db.claim(conn, "w1")

    assert db.requeue(conn, job_id, "w1") == 1
    row = conn.execute("SELECT next_attempt_at - now() AS delay FROM job WHERE id=%s", (job_id,)).fetchone()
    assert 0.5 <= row["delay"].total_seconds() <= 1.5


def test_run_single_job_records_missing_model_dependency_after_claim(conn, pg_url, tmp_path):
    job_id = _enqueue_index(conn)
    code = run_single_job(
        _settings_stub(pg_url), Storage(str(tmp_path)), threading.Event(),
        connect_fn=lambda: db.connect(pg_url),
        build_models_fn=lambda payload, settings: None,
        build_embedder_fn=lambda payload, settings: FakeEmbedder(),
        build_text_embedder_fn=lambda settings: (_ for _ in ()).throw(ModuleNotFoundError("bge")),
    )

    assert code == 0
    row = conn.execute("SELECT status, error FROM job WHERE id=%s", (job_id,)).fetchone()
    assert row["status"] == "failed"
    assert row["error"]["code"] == "model_load_failed"
```

- [ ] **Step 2: Run the Python tests to verify they fail**

Run: `cd worker && uv run pytest -q tests/test_db_lifecycle.py tests/test_supervisor.py`

Expected: FAIL because `next_attempt_at` is not honored and the post-claim failure test is not yet present.

- [ ] **Step 3: Implement Python scheduling and lazy callbacks**

Use this claim and requeue SQL in `worker/damwha_worker/db.py`:

```python
UPDATE job SET status='running', locked_by=%s, locked_at=now(),
               attempts=attempts + 1, next_attempt_at=NULL, updated_at=now()
WHERE id IN (
  SELECT id FROM job
  WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  ORDER BY next_attempt_at NULLS FIRST, created_at FOR UPDATE SKIP LOCKED LIMIT 1
) RETURNING *

UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               next_attempt_at=now() + least(power(2, attempts - 1), 60) * interval '1 second',
               updated_at=now()
WHERE id=%s AND locked_by=%s AND status='running'
```

Change `run_child()` so these callbacks perform imports when invoked:

```python
def _build_models(payload, settings):
    from .models.registry import build_models
    return build_models(payload, settings)

def _build_embedder(payload, settings):
    from .models.registry import build_embedder
    return build_embedder(payload, settings)

def _build_text_embedder(settings):
    from .models.registry import build_text_embedder
    return build_text_embedder(settings)
```

Pass the three functions to `run_single_job`; keep `LensClient` lazy inside its existing callback. Ensure `requeue_for_shutdown()` explicitly sets `next_attempt_at=NULL`.

- [ ] **Step 4: Run the Python queue and dispatch tests to verify they pass**

Run: `cd worker && uv run pytest -q tests/test_db_lifecycle.py tests/test_supervisor.py`

Expected: PASS.

- [ ] **Step 5: Commit Python retry and import hardening**

```bash
git add worker/damwha_worker/db.py worker/damwha_worker/__main__.py worker/tests/test_db_lifecycle.py worker/tests/test_supervisor.py
git commit -m "fix: claim jobs before loading model adapters"
```

### Task 3: Publish normalized WAV files atomically

**Files:**
- Modify: `worker/damwha_worker/pipeline/ffmpeg.py:1-43`
- Modify: `worker/tests/test_ffmpeg.py:42-61`

**Interfaces:**
- Produces `normalize(src_path: str, dst_path: str, runner: Runner = _run) -> None`.
- The returned behavior guarantees `dst_path` is replaced only after `probe(temp_path)` succeeds.

- [ ] **Step 1: Write failing atomic-publication tests**

```python
def test_normalize_probes_temp_file_then_atomically_replaces_destination(monkeypatch, tmp_path):
    destination = tmp_path / "normalized.wav"
    calls = []
    monkeypatch.setattr(ffmpeg, "probe", lambda path: calls.append(("probe", path)) or ffmpeg.ProbeResult(1))
    monkeypatch.setattr(ffmpeg.os, "replace", lambda src, dst: calls.append(("replace", src, dst)))

    ffmpeg.normalize("/in/a.m4a", str(destination), runner=lambda cmd: calls.append(("ffmpeg", cmd)) or ok_proc())

    temp_path = calls[0][1][-1]
    assert temp_path != str(destination)
    assert calls[1] == ("probe", temp_path)
    assert calls[2] == ("replace", temp_path, str(destination))


def test_normalize_removes_temp_file_when_probe_fails(monkeypatch, tmp_path):
    removed = []
    monkeypatch.setattr(ffmpeg, "probe", lambda path: (_ for _ in ()).throw(WorkerError("x", "bad", ErrorKind.PERMANENT)))
    monkeypatch.setattr(ffmpeg.os, "unlink", lambda path: removed.append(path))

    with pytest.raises(WorkerError):
        ffmpeg.normalize("/in/a.m4a", str(tmp_path / "normalized.wav"), runner=lambda cmd: ok_proc())

    assert len(removed) == 1
```

- [ ] **Step 2: Run the ffmpeg test to verify it fails**

Run: `cd worker && uv run pytest -q tests/test_ffmpeg.py`

Expected: FAIL because the current command writes directly to the destination and does not probe or replace it.

- [ ] **Step 3: Implement temp-file normalization and cleanup**

At module scope import `os`, `tempfile`, and `Path`. Replace `normalize()` with:

```python
def normalize(src_path: str, dst_path: str, runner: Runner = _run) -> None:
    destination = Path(dst_path)
    fd, temp_path = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    os.close(fd)
    try:
        proc = runner(["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-f", "wav", temp_path])
        if proc.returncode != 0:
            raise WorkerError(CORRUPT_AUDIO, f"ffmpeg normalize failed: {proc.stderr!r}", ErrorKind.PERMANENT)
        probe(temp_path)
        os.replace(temp_path, destination)
    except BaseException:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise
```

- [ ] **Step 4: Run the ffmpeg test to verify it passes**

Run: `cd worker && uv run pytest -q tests/test_ffmpeg.py`

Expected: PASS.

- [ ] **Step 5: Commit atomic normalized-file publication**

```bash
git add worker/damwha_worker/pipeline/ffmpeg.py worker/tests/test_ffmpeg.py
git commit -m "fix: publish normalized audio atomically"
```

### Task 4: Add worker-owned stale recovery

**Files:**
- Create: `worker/damwha_worker/reaper.py`
- Modify: `worker/damwha_worker/db.py`
- Modify: `worker/damwha_worker/config.py:9-25`
- Modify: `worker/damwha_worker/__main__.py:375-409`
- Modify: `worker/tests/test_db_lifecycle.py`
- Modify: `worker/tests/test_supervisor.py`

**Interfaces:**
- Produces `db.reap_stale(conn, stale_minutes: float) -> tuple[int, int]` returning `(requeued, failed)`.
- Produces `run_reaper_loop(database_url, stale_minutes, interval_seconds, shutdown_event) -> None`.
- `Settings` gains `reaper_stale_minutes: float = 30` and `reaper_interval_seconds: float = 300`.

- [ ] **Step 1: Write failing stale-recovery and reaper-loop tests**

```python
def test_worker_reap_stale_fails_exhausted_process_meeting_and_entity(conn):
    meeting_id = seed_meeting(conn, status="processing")
    job_id = seed_job(conn, type="process_meeting", meeting_id=meeting_id, attempts=3, max_attempts=3)
    conn.execute("UPDATE job SET status='running', locked_by='dead', locked_at=now() - interval '31 minutes' WHERE id=%s", (job_id,))
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (job_id, meeting_id))

    assert db.reap_stale(conn, 30) == (0, 1)
    assert conn.execute("SELECT status FROM job WHERE id=%s", (job_id,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (meeting_id,)).fetchone()["status"] == "failed"


def test_reaper_loop_recovers_after_db_error(monkeypatch):
    shutdown = threading.Event()
    calls = []
    monkeypatch.setattr(reaper.db, "connect", lambda url: object())
    monkeypatch.setattr(reaper.db, "reap_stale", lambda conn, minutes: calls.append(minutes) or (_ for _ in ()).throw(RuntimeError("db")) if len(calls) == 1 else (shutdown.set() or (0, 0)))

    reaper.run_reaper_loop("postgresql://x", 30, 0.001, shutdown)
    assert calls == [30, 30]
```

- [ ] **Step 2: Run the worker recovery tests to verify they fail**

Run: `cd worker && uv run pytest -q tests/test_db_lifecycle.py tests/test_supervisor.py`

Expected: FAIL because Python has no `reap_stale` or reaper loop.

- [ ] **Step 3: Implement shared stale SQL and the independent worker loop**

Port the existing API `reapStale` CTE into `db.reap_stale`, using psycopg placeholders and `Jsonb` only where needed. Return integer counts from its single result row. The `requeued` CTE must set `next_attempt_at=NULL`; retain the existing `fail_lens_extraction_runs`, meeting, and speaker updates.

Create `reaper.py`:

```python
import logging

from . import db

log = logging.getLogger("damwha_worker")


def run_reaper_loop(database_url, stale_minutes, interval_seconds, shutdown_event) -> None:
    while not shutdown_event.is_set():
        conn = None
        try:
            conn = db.connect(database_url)
            requeued, failed = db.reap_stale(conn, stale_minutes)
            if requeued or failed:
                log.warning("worker reaper: requeued=%s failed=%s", requeued, failed)
        except Exception:
            log.exception("worker reaper failed")
        finally:
            if conn is not None:
                conn.close()
        shutdown_event.wait(interval_seconds)
```

In `run_supervisor_main()`, start a daemon `threading.Thread` with this target before `run_supervisor()`, and set `shutdown` plus `join(timeout=5)` after the supervisor returns. Add the two config fields with defaults in `Settings`.

- [ ] **Step 4: Run worker recovery tests to verify they pass**

Run: `cd worker && uv run pytest -q tests/test_db_lifecycle.py tests/test_supervisor.py`

Expected: PASS.

- [ ] **Step 5: Commit worker-owned stale recovery**

```bash
git add worker/damwha_worker/reaper.py worker/damwha_worker/db.py worker/damwha_worker/config.py worker/damwha_worker/__main__.py worker/tests/test_db_lifecycle.py worker/tests/test_supervisor.py
git commit -m "feat: recover stale jobs from worker supervisor"
```

### Task 5: Document and verify the completed resilience contract

**Files:**
- Modify: `docs/worker-architecture.md:1-500`
- Modify: `test/reaper.spec.ts`

**Interfaces:**
- Documents `next_attempt_at`, atomic normalized WAV publication, redundant API/worker reapers, and the resource-queue promotion criterion.
- Preserves API reaper semantics after the retry-scheduling migration.

- [ ] **Step 1: Add the API reaper regression assertion**

```ts
it('makes a reaped stale retry immediately eligible', async () => {
  const { jobId } = await runningJob({ minutesAgo: 45, attempts: 1, maxAttempts: 3 });
  await db.pool.query(`UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=$1`, [jobId]);

  await repo.reapStale(db.pool, 30);

  const { rows } = await db.pool.query('SELECT status, next_attempt_at FROM job WHERE id=$1', [jobId]);
  expect(rows[0]).toMatchObject({ status: 'queued', next_attempt_at: null });
});
```

- [ ] **Step 2: Run the regression test to verify it fails**

Run: `npx jest test/reaper.spec.ts --runInBand`

Expected: FAIL because the API reaper does not yet clear `next_attempt_at`.

- [ ] **Step 3: Clear retry scheduling in the API reaper and update living documentation**

Change its `requeued` CTE to:

```sql
UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               next_attempt_at=NULL, updated_at=now()
```

Update the architecture document’s retry, reaper, normalization, and operations sections to state:

```markdown
- transient retry uses `next_attempt_at` with deterministic capped exponential delay;
- API and worker supervisors both run the same `SKIP LOCKED` stale reaper;
- normalized WAV is created in a temporary sibling path, probed, then atomically published;
- split resource queues only after a measured latency SLO is violated or backlog remains sustained.
```

- [ ] **Step 4: Run focused and full verification**

Run: `npx jest test/jobs.repository.spec.ts test/reaper.spec.ts --runInBand && cd worker && uv run pytest -q && uv run ruff check . && cd .. && git diff --check`

Expected: all tests and Ruff pass, and `git diff --check` has no output.

- [ ] **Step 5: Commit documentation and final regression test**

```bash
git add src/jobs/jobs.repository.ts test/reaper.spec.ts docs/worker-architecture.md
git commit -m "docs: record resilient worker queue behavior"
```

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover delayed retry and post-claim imports; Task 3 covers atomic WAV publication; Task 4 covers worker-owned recovery; Task 5 covers compatibility and the deferred resource-queue criterion.
- Placeholder scan: no implementation placeholders remain; every task has a concrete test, command, and implementation target.
- Interface consistency: both queue implementations use `next_attempt_at`; both reapers clear it; worker reaping returns `(requeued, failed)` and the periodic loop calls that interface.
