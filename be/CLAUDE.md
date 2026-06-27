# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Damwha is a personal, self-hosted meeting recording/search platform. The primary object is the **utterance** — every spoken line is attributed to a speaker, timestamped, and traceable back to the original audio. This repo is the **backend**.

The full design and the executable plans live in `docs/superpowers/`:
- Spec (NestJS API): `docs/superpowers/specs/2026-06-22-damwha-ingestion-backend-design.md`
- Plan 1 (`src/`, NestJS API): `docs/superpowers/plans/2026-06-22-damwha-ingestion-api.md`
- Spec (Python worker): `docs/superpowers/specs/2026-06-23-damwha-ml-worker-design.md`
- Plan 2 (`worker/`, Python ML worker): `docs/superpowers/plans/2026-06-23-damwha-ml-worker.md`

Read the spec before changing data model / pipeline semantics — many decisions there are deliberate (privacy: local-only; non-goals). Specs/plans are dated snapshots and are **not** edited after the fact; record implementation deltas in living docs (this file, `docs/README.md`, `worker/SMOKE.md`).

## Architecture: two runtimes joined by one table

The system is a **polyglot** split that communicates **only through the Postgres `job` table** — never HTTP between them:

- **NestJS API (`src/`, TypeScript)** — HTTP only, knows nothing about ML. Stores audio, CRUDs metadata, enqueues jobs, serves status/results.
- **Python ML worker (`worker/`, Python)** — polls `job`, runs ffmpeg normalize+probe → VAD → diarization → speaker ID → STT → align, writes `utterance`/`meeting_cluster`/`voiceprint` rows. No HTTP. **Implemented** (Plan 2); see the worker section below.

The `job` table is the contract. The TypeScript side validates job payloads with zod (`src/contracts/job-payload.schema.ts`); the Python worker mirrors the same shape with pydantic (`worker/damwha_worker/contracts.py`), and the same JSON fixtures (`test/fixtures/job-payloads/`) are validated on both sides to block drift. The payload carries a top-level `schema_version` (currently `1`; both sides default missing → 1). **Changing the payload shape or the `stage`/`status` enums means changing both sides** — treat `src/contracts/`, `worker/damwha_worker/contracts.py`, and the `001_init.sql` CHECK constraints as the source of truth.

There is **no ORM**. All DB access is raw SQL through `DatabaseService` (`pg.Pool` wrapper with `query` + `withTransaction`). This is intentional — `SELECT ... FOR UPDATE SKIP LOCKED` and pgvector types don't fit ORMs cleanly. Each domain has a thin `*.repository.ts` (SQL), a `*.service.ts` (transactions/orchestration), and a `*.controller.ts` (HTTP).

## Non-obvious invariants (read before editing these areas)

These cross-file rules are easy to break and are enforced by tests:

- **Job queue (`src/jobs/`)**: `attempts` is incremented at **claim** time (queued→running), not on retry — so a crashed worker still counts as one attempt. `claim` must not set `stage` (the worker sets stage per type as it enters each step). `complete()`/`fail()` update the `job` row **only** — on normal completion the linked `meeting.status`/`speaker.enrollment_status` transitions are the *worker's* responsibility (Plan 2, in the same persist/enroll transaction). The **reaper** (`reaper.service.ts`, every 5 min) is the *only* place that propagates status on the crash path: stale `running` jobs (`locked_at` older than `REAPER_STALE_MINUTES`) are requeued if attempts remain, else failed + linked meeting/speaker marked failed.
- **Reprocess + stale guard**: reprocess bumps `meeting.processing_version` and enqueues a new job (it does **not** wrap ML in a DB transaction). The worker's `persist` step must only write results when `meeting.processing_version = payload.processing_version AND meeting.current_job_id = job.id` — otherwise a stale lower-version job would overwrite newer results. Phase 1 reprocess is **overwrite, no history**; `processing_version`/`job_id` stamps on rows exist to support this guard and a future non-destructive merge.
- **Storage path safety (`src/storage/`)**: the DB stores only relative keys (`meetings/<uuid>/...`). Never trust client filenames or store absolute paths. All key→path resolution goes through `StorageService.resolve()`, which rejects traversal/absolute keys. Uploads use multer **diskStorage** (temp file) + `saveFromTemp` — never buffer large audio in memory.
- **Speaker identification (`voiceprint`)**: pgvector columns are fixed-dimension (`vector(192)`). Identification must filter voiceprints by matching `model` + `dimension`, and only compare against speakers with `enrollment_status='ready'`. Unidentified speakers are preserved as `meeting_cluster` rows (raw `diar_label`), never force-created as `speaker`.
- **Env loading**: `loadEnv()` parses the full schema and **requires `DATABASE_URL`** — only call it inside constructors/runtime, never in decorator/module metadata (it runs at import time before tests set env). Use the narrow `maxUploadBytes()` helper in decorators instead.

## Python worker (`worker/`)

Separate Python project under `worker/` (uv + ruff + pytest + pydantic v2 + psycopg3, no ORM — same raw-SQL reasons as the API). It consumes the `job` contract and never imports the NestJS side. Key realities (mostly learned during Plan 2 and the real-model smoke):

- **Models are an optional extra.** Heavy/gated ML deps live in `[project.optional-dependencies] models` (platform-marked: `mlx-whisper` on Apple Silicon, `faster-whisper` elsewhere), **not** base deps. The deterministic test suite never imports them (registry/adapters are imported only inside `__main__.main()`), so plain `uv sync` stays light; the real worker runs `uv sync --extra models`.
- **Ownership guards (the safety model).** Every worker write to shared state is guarded; 0 affected rows = lost ownership → discard local result. Two distinct guards, both needed: **job guard** (`locked_by = worker AND status='running'` — catches a same-job requeue+reclaim) and **meeting guard** (`processing_version = payload_pv AND current_job_id = job.id` — catches a newer reprocess). `persist` applies both in one short TX → returns `committed` / `discarded` (stale: job marked `done`+reason, meeting untouched) / `lost`.
- **Failure classification.** `errors.ErrorKind` is PERMANENT vs TRANSIENT (uncategorized → TRANSIENT). PERMANENT → fail immediately; TRANSIENT → immediate requeue if attempts remain (no timed backoff — `job` has no `next_attempt_at`). Heartbeat runs on its own DB connection in a daemon thread and survives a transient DB error.
- **pyannote.audio resolves to 4.x** (the spec named the 3.1 *model*; the *library* major bumped). 4.x renamed `use_auth_token` → `token` and the pipeline returns a `DiarizeOutput` (use `.speaker_diarization`). The diarization pipeline pulls a **3-model gated HF chain** — see `worker/SMOKE.md`. ECAPA runs on **CPU** even on Apple Silicon (SpeechBrain MPS support is unreliable; the model is tiny); pyannote and mlx-whisper use the GPU.
- **Tests vs smoke.** All deterministic glue (db guards, align, identify, persist, poll loop) is tested with **fake models + real Postgres** (testcontainers) and runs in CI. The **real models are verified only by a local smoke** (`worker/SMOKE.md`, `scripts/smoke_process_meeting.py`) — gated/heavy, never in CI.
- **Search indexing.** `index_meeting` is a separate job type (dispatched by the API after persist completes). Failure marks the job only — the meeting stays `done` and BM25-searchable. Query embedding is the **single exception to the job-table-only invariant**: the API calls the embed service (localhost HTTP RPC, `POST /embed`) directly at query time; this never crosses a network boundary (`EMBED_SERVICE_ALLOW_NON_LOOPBACK=false`).

## Commands

Node **22** is required (`.nvmrc`, `engines`). Use `nvm use` first.

```bash
npm install                              # once
cp .env.example .env                     # configure DATABASE_URL, STORAGE_ROOT, model envs

docker compose up -d                     # start Postgres (pgvector + pg_bigm); first run builds the image
npm run migrate                          # apply SQL migrations (needs a running Postgres w/ pgvector)
npm run start:dev                        # watch mode (Swagger UI at /docs, OpenAPI JSON at /docs-json)
npm run build && npm start               # prod (build copies migrations into dist/)

npm test                                 # full suite, serial
npx jest test/meetings.e2e-spec.ts       # one suite
npx jest test/jobs.repository.spec.ts -t "concurrent"   # one test by name
npx tsc --noEmit -p tsconfig.build.json  # type-check src without emitting
```

Python worker (`worker/`, Python 3.12 via uv):

```bash
cd worker
uv sync                                  # deterministic deps only (CI/tests; no heavy models)
uv run pytest -q                         # full worker suite (testcontainers Postgres + fake models)
uv run ruff check . && uv run ruff format .

uv sync --extra models                   # real ML models (mlx-whisper/pyannote/ECAPA/silero)
uv run python scripts/download_models.py # pre-cache models (needs HF_TOKEN; see SMOKE.md)
uv run python -m damwha_worker           # run the real worker (poll loop)
uv run python scripts/smoke_process_meeting.py <audio>   # local end-to-end smoke
```

**Tests require Docker.** Integration/e2e tests use Testcontainers, which spins up a real `pgvector/pgvector:pg16` Postgres per suite (see `test/db.ts`). Run with `--runInBand` (already in `npm test`) — parallel containers are heavy. No mocking of the DB; tests exercise real SQL including `SKIP LOCKED`, the reaper CTE, and pgvector.

## Conventions

- Follow the plan doc's task structure and the existing per-domain repository/service/controller split when adding features.
- Migrations are plain SQL files in `src/database/migrations/` applied in filename order by `migrate.ts` (tracked in a `_migrations` table). Add new numbered files; don't edit applied ones.
- Enums are `text` + `CHECK` (not native Postgres enums) so values can evolve; keep the zod/pydantic contracts and CHECK lists in sync.
- **Keep the API/worker split clean.** The ML pipeline, ffmpeg audio-integrity validation, and worker-side status transitions live in the Python worker (`worker/`), not the NestJS `src/`. Don't add ML or cloud calls to `src/`; both halves keep the privacy premise (local-only, no external network) intact.

---

## Working guidelines (general)

> Behavioral guidelines to reduce common LLM coding mistakes. Adapted from
> [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md).
> They bias toward caution over speed; for trivial tasks, use judgment.

### 1. Think before coding
**Don't assume. Don't hide confusion. Surface tradeoffs.** Before implementing: state assumptions explicitly (ask if uncertain); if multiple interpretations exist, present them rather than picking silently; if a simpler approach exists, say so and push back when warranted; if something is unclear, stop, name what's confusing, and ask.

### 2. Simplicity first
**Minimum code that solves the problem. Nothing speculative.** No features beyond what was asked; no abstractions for single-use code; no "flexibility"/"configurability" that wasn't requested; no error handling for impossible scenarios. If you write 200 lines and it could be 50, rewrite it. Test: "Would a senior engineer call this overcomplicated?"

### 3. Surgical changes
**Touch only what you must. Clean up only your own mess.** Don't "improve" adjacent code/comments/formatting; don't refactor what isn't broken; match existing style even if you'd do it differently; if you spot unrelated dead code, mention it — don't delete it. Remove imports/variables/functions that *your* changes orphaned, but leave pre-existing dead code unless asked. Every changed line should trace directly to the request.

### 4. Goal-driven execution
**Define success criteria. Loop until verified.** Turn tasks into verifiable goals ("Add validation" → "write tests for invalid inputs, then make them pass"; "Fix the bug" → "write a test that reproduces it, then make it pass"; "Refactor X" → "ensure tests pass before and after"). For multi-step work, state a brief plan with a verify check per step. Strong success criteria let you loop independently; weak ones ("make it work") force constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites from overcomplication, and clarifying questions come before implementation rather than after mistakes.
