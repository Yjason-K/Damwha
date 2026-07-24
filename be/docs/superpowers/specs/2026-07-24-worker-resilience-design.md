# Worker Resilience Design

**Date:** 2026-07-24

## Goal

Ensure a queued job reaches a terminal state or a delayed retry when model bootstrapping fails, transient failures cannot monopolize the FIFO queue, normalized WAV files cannot be published partially, and stale-job recovery does not require the NestJS API to be running.

## Scope

This design changes the existing Postgres queue, Python ML worker, and living architecture document. It preserves the current API reaper as a compatible second recovery actor.

It does not split queues by resource class. The existing single-worker, serial execution model remains the default until measured queue delay makes separate GPU/CPU/LLM consumers necessary.

## 1. Claim Before Heavy Model Imports

`python -m damwha_worker --once` must be able to connect, claim one job, start its heartbeat, and dispatch the job without importing model adapters first. The model registry and its heavy adapter imports move behind a callback that is evaluated only after a job is claimed.

If a required package is absent, the exception is handled by `handle_job()`. The claimed job becomes `failed` with `model_load_failed` and `PERMANENT`; the applicable meeting or speaker gets the existing failure propagation. A missing model package must never leave a queued job unclaimed in an infinite supervisor crash/backoff loop.

## 2. Delayed Transient Retry

Add nullable `job.next_attempt_at timestamptz`. A queued job is eligible when `next_attempt_at IS NULL OR next_attempt_at <= now()`.

`claim()` selects the oldest eligible job, ordered by `next_attempt_at NULLS FIRST, created_at`, and clears `next_attempt_at` while changing the job to `running`.

When a claimed job fails transiently and has attempts remaining, `requeue()` returns it to `queued` and sets `next_attempt_at` from its already-incremented attempt count:

| attempts after claim | retry delay |
|---:|---:|
| 1 | 1 second |
| 2 | 2 seconds |
| 3+ | `min(2^(attempts-1), 60)` seconds |

This is deterministic; jitter is intentionally omitted so tests and operator expectations are simple. Reaper recovery and graceful-shutdown requeue set `next_attempt_at=NULL`: the former already waited for a stale timeout, and the latter is not an error.

Add an index on `(status, next_attempt_at, created_at)` for eligible-job lookup. Existing rows receive `NULL`, so the migration is backward compatible.

## 3. Atomic Normalized WAV Publication

`ffmpeg.normalize(src, destination)` creates a unique temporary WAV in the destination directory. It runs ffmpeg against that temporary path, verifies the temporary WAV with `ffprobe`, and atomically publishes it using `os.replace(temp, destination)`.

On ffmpeg/probe failure or process interruption, it removes its temporary path best-effort and leaves an existing published normalized WAV untouched. The pipeline keeps its current `Storage.exists(normalized_key)` reuse behavior; only fully verified files can become reusable.

This does not introduce content hashing or source fingerprints. Reprocessing after an external original-file replacement remains a separately scoped cache-invalidation concern.

## 4. Worker-Owned Stale Reaper

Move the stale-recovery SQL semantics into the Python DB adapter and invoke it from the ML supervisor on a periodic schedule using a separate DB connection. It retains the API reaper; both actors use `FOR UPDATE SKIP LOCKED`, so exactly one actor transitions a stale row.

The worker reaper must preserve current outcomes:

- retryable stale jobs become `queued` with cleared lock and immediately eligible retry;
- exhausted `process_meeting` jobs fail their current meeting;
- exhausted `enroll_speaker` jobs fail their current speaker;
- exhausted `extract_lenses` jobs fail their linked extraction run;
- `index_meeting` failure does not change its meeting.

Worker configuration adds `reaper_stale_minutes` (default 30) and `reaper_interval_seconds` (default 300). The supervisor launches its reaper loop independently of a running child, so a long child cannot prevent stale recovery of another job. A reaper DB failure is logged and retried on the next interval; it must not stop job polling.

## 5. Documentation and Promotion Criterion

The living worker architecture document records the delayed retry, atomic normalized-file publication, and redundant reaper ownership.

Resource queue separation is deferred. Revisit it when a short CPU/LLM job waits behind `process_meeting` long enough to violate an explicitly adopted queue-latency SLO, or when queue-depth metrics show sustained backlog. The intended first step is type-filtered supervisors (`process_meeting` GPU consumer; CPU/index/LLM consumer), not a new broker.

## Test Plan

- Python unit/integration tests prove a model builder import-style failure after claim marks the job failed instead of escaping the child.
- Python and TypeScript queue tests prove delayed jobs are not claimable before `next_attempt_at`, are claimable after it, and immediate queued jobs still win.
- Python ffmpeg tests prove output is written to a temporary path, probed, atomically replaced, and cleaned up after failure.
- Python DB/supervisor tests prove worker reaping performs the same status propagation as the API reaper and survives a reaper exception.
- Existing NestJS reaper tests remain green, documenting safe API/worker redundancy.
