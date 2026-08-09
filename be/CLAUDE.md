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
- **Python ML worker (`worker/`, Python)** — a supervisor process polls `job` and spawns a one-job child that runs ffmpeg normalize+probe → VAD → diarization → speaker ID → STT → align, writing `utterance`/`meeting_cluster`/`voiceprint` rows. No HTTP. **Implemented** (Plan 2); see the worker section below.

The `job` table is the contract. The TypeScript side validates job payloads with zod (`src/contracts/job-payload.schema.ts`); the Python worker mirrors the same shape with pydantic (`worker/damwha_worker/contracts.py`), and the same JSON fixtures (`test/fixtures/job-payloads/`) are validated on both sides to block drift. The payload carries a top-level `schema_version`. Supported versions are **per job type** (`SUPPORTED_SCHEMA_VERSIONS` dict in `worker/damwha_worker/contracts.py`): `process_meeting` accepts **v1 and v2**, while `enroll_speaker`/`index_meeting` stay **v1**. **v2** adds per-stage `models.devices.{diarization,stt}` (`cpu`|`gpu`) plus `preset`/`preset_revision` reference info; the worker parses a v1 `process_meeting` payload and converts it to v2 internally, so downstream code sees one shape. **Changing the payload shape or the `stage`/`status` enums means changing both sides** — treat `src/contracts/`, `worker/damwha_worker/contracts.py`, and the `001_init.sql` CHECK constraints as the source of truth.

There is **no ORM**. All DB access is raw SQL through `DatabaseService` (`pg.Pool` wrapper with `query` + `withTransaction`). This is intentional — `SELECT ... FOR UPDATE SKIP LOCKED` and pgvector types don't fit ORMs cleanly. Each domain has a thin `*.repository.ts` (SQL), a `*.service.ts` (transactions/orchestration), and a `*.controller.ts` (HTTP).

## Non-obvious invariants (read before editing these areas)

These cross-file rules are easy to break and are enforced by tests:

- **Job queue (`src/jobs/`)**: `attempts` is incremented at **claim** time (queued→running), not on retry — so a crashed worker still counts as one attempt. `claim` must not set `stage` (the worker sets stage per type as it enters each step). `complete()`/`fail()` update the `job` row **only** — on normal completion the linked `meeting.status`/`speaker.enrollment_status` transitions are the *worker's* responsibility (Plan 2, in the same persist/enroll transaction). The **reaper** is what propagates status on the crash path: stale `running` jobs (`locked_at` older than `REAPER_STALE_MINUTES`) are requeued if attempts remain, else failed + linked meeting/speaker marked failed. There are **two reapers running the same CTE every 5 min** — the NestJS `reaper.service.ts` and the worker supervisor's daemon thread (`worker/damwha_worker/reaper.py` → `db.reap_stale`). Concurrent runs are safe because the CTE selects `FOR UPDATE SKIP LOCKED`; keep the two SQL bodies in sync when editing either. A reaper requeue clears `next_attempt_at` (no backoff — the worker is already gone) and leaves `attempts` as claimed.
- **Reprocess + stale guard**: reprocess bumps `meeting.processing_version` and enqueues a new job (it does **not** wrap ML in a DB transaction). The worker's `persist` step must only write results when `meeting.processing_version = payload.processing_version AND meeting.current_job_id = job.id` — otherwise a stale lower-version job would overwrite newer results. **`utterance` rows of older versions are retained** (migration `013`: the uniqueness key is `(meeting_id, processing_version, order_index)`) so lens evidence pointing at a superseded utterance stays valid; `meeting_cluster` is still replaced wholesale. Every reader therefore filters `u.processing_version = m.processing_version` — a query that forgets it will surface stale turns.
- **Storage path safety (`src/storage/`)**: the DB stores only relative keys (`meetings/<meeting_id>/...`). Never trust client filenames or store absolute paths. All key→path resolution goes through `StorageService.resolve()`, which rejects traversal/absolute keys. Uploads use multer **diskStorage** (temp file) + `saveFromTemp` — never buffer large audio in memory.
- **Speaker identification (`voiceprint`)**: pgvector columns are fixed-dimension (`vector(192)`). Identification must filter voiceprints by matching `model` + `dimension`, and only compare against speakers with `enrollment_status='ready'`. Unidentified speakers are **auto-created as `provisional` speakers** (default name `Speaker_NNN` via `speaker_default_seq`) with an `auto_cluster` voiceprint carrying `source_cluster_id` provenance. `provisional` speakers are **excluded from identification** (it filters `enrollment_status='ready'`) until confirmed by rename (`PATCH /speakers/:id` promotes `provisional→ready`). `meeting_cluster` rows are retained as the per-meeting `diar_label→speaker` record; `resolve` reattaches the cluster's single voiceprint (`ON CONFLICT (source_cluster_id)`) and GCs orphaned provisional speakers. `persist` likewise GCs unconfirmed `provisional` orphans on reprocess (a global conditional DELETE of `provisional` speakers with no utterance/cluster references; confirmed `ready` speakers are never deleted).
- **Env loading**: `loadEnv()` parses the full schema and **requires `DATABASE_URL`** — only call it inside constructors/runtime, never in decorator/module metadata (it runs at import time before tests set env). Use the narrow `maxUploadBytes()` helper in decorators instead.
- **Lenses (`src/lenses/`, migrations `008`–`014`)**: `lens_item` holds actions/decisions/promises with a `source` (`ai`|`user`|`edited`), `user_modified`, `completion_status`, `lifecycle_status`; `lens_evidence` links an item to utterances (`primary`|`supporting`). **Re-extraction must never clobber human work** — `classifyAiMerge` (`lenses.service.ts`) only considers items that are `source='ai' AND NOT user_modified AND active AND open`, matches a candidate to one by `(kind, primary utterance)`, and archives eligible items no candidate matched. Everything else (user-created, edited, completed, archived) is invisible to the merge. An **active AI item must always keep exactly one primary evidence row** — enforced by deferred constraint triggers (`014`) plus service-level conflict guards on evidence add/remove; a `PATCH` with no editable field is a deliberate no-op so an empty request can't stamp `edited`/`user_modified` and silently drop the item out of merge eligibility. Evidence may only cite an utterance of the item's own meeting (deferred trigger, `013`).
- **Lens extraction runs (`extract_lenses` job)**: `lens_extraction_run` is keyed per `(meeting, processing_version)`. The API side (`lens-extraction.service.ts`) requires `meeting.status='done'`, reuses the active run instead of enqueueing a second one (idempotent retry), and the worker auto-enqueues a run in the same transaction as `persist` (skipped when the worker has no `lens_llm_model` configured). The worker guards every write with the same run/job/version ownership checks as the ML pipeline (`db.mark_lens_run_running` / `db.persist_lens_extraction`) and re-validates the LLM's ids server-side — an utterance or assignee that isn't in the meeting at that `processing_version` is rejected, never stored. `GET /lenses` (keyset cursor; `completion_status` is a **single value**, not a set) and `GET /lenses/extraction-status` back the global dashboard.

## Python worker (`worker/`)

Separate Python project under `worker/` (uv + ruff + pytest + pydantic v2 + psycopg3, no ORM — same raw-SQL reasons as the API). It consumes the `job` contract and never imports the NestJS side. Key realities (mostly learned during Plan 2 and the real-model smoke):

- **Process model: supervisor + one-job child, not a single poll loop.** `python -m damwha_worker` starts a **parent supervisor** (`__main__.py`) that only does `db.peek_queued` and spawns `python -m damwha_worker --once` as a **child process per job**; the child claims, processes exactly one job, and exits. The parent branches on the child's exit code — `0` = handled (peek again immediately), `3` = no job (poll sleep), anything else = crash (capped exponential backoff, max 60s, to stop infinite respawn on a deterministic error). The lock never crosses the process boundary, so the parent's peek deliberately ignores `next_attempt_at` and the child's claim enforces it. The supervisor also runs the reaper daemon thread. Signals are two-stage: first SIGINT/SIGTERM stops at the next stage boundary, second one kills. Full detail (including the mermaid flow) lives in `docs/worker-architecture.md` §4 — that doc is current; prefer it over this summary.
- **Models are an optional extra.** Heavy/gated ML deps live in `[project.optional-dependencies] models`, **not** base deps. `mlx-whisper` stays Apple-Silicon–marked, but **`faster-whisper` now installs on all platforms** (the CPU STT path must work on ARM Mac too). The deterministic test suite never imports them (registry/adapters are imported only inside `__main__.main()`), so plain `uv sync` stays light; the real worker runs `uv sync --extra models`.
- **STT backend is derived from the payload, not settings.** `whisper_backend`/`device` are **gone** from `config.py`. `build_models` (`worker/damwha_worker/models/registry.py`) picks the transcriber from `devices.stt`: `gpu` → `MlxWhisper` (MLX repo per `whisper_mlx.py::_REPO`), `cpu` → `FasterWhisper` (int8). Per-stage device → torch device goes through `torch_device` (`models/device.py`); a `gpu` request on a machine without MPS is a **PERMANENT `gpu_unavailable`** failure — **no CPU fallback** (payload reproducibility).
- **Processing settings live in the API.** `src/settings/` owns the global `ProcessingConfig` (`app_setting` table, migration `007`; presets light/standard/quality in `presets.ts`, `PRESET_REVISION='2026-07-13.1'`) exposed via `GET`/`PUT /settings/processing` — PUT fully resolves a named preset before its GPU-eligibility check. `src/system/` exposes `GET /system/capabilities` (`gpu_eligible` = hardware fit only). Job-level overrides: upload multipart `processing` JSON-string field, reprocess JSON body — **any individual field (even language-only) flips `preset` to `custom`**.
- **Ownership guards (the safety model).** Every worker write to shared state is guarded; 0 affected rows = lost ownership → discard local result. Two distinct guards, both needed: **job guard** (`locked_by = worker AND status='running'` — catches a same-job requeue+reclaim) and **meeting guard** (`processing_version = payload_pv AND current_job_id = job.id` — catches a newer reprocess). `persist` applies both in one short TX → returns `committed` / `discarded` (stale: job marked `done`+reason, meeting untouched) / `lost`.
- **Failure classification and retry timing.** `errors.ErrorKind` is PERMANENT vs TRANSIENT (uncategorized → TRANSIENT). PERMANENT → fail immediately; TRANSIENT → requeue if attempts remain. Retries **are** time-gated: migration `015` added `job.next_attempt_at`, and `db.requeue` sets it to `now() + least(power(2, attempts - 1), 60) * interval '1 second'` (capped exponential backoff). Both `claim` implementations (`src/jobs/jobs.repository.ts`, `worker/damwha_worker/db.py`) filter on `next_attempt_at IS NULL OR <= now()` and order by `next_attempt_at NULLS FIRST, created_at`; claim clears it. The two other paths back to `queued` deliberately do **not** back off: the reaper (worker already dead) and `requeue_for_shutdown`, which also **decrements `attempts`** so a graceful restart doesn't burn a retry. Heartbeat runs on its own DB connection in a daemon thread and survives a transient DB error.
- **pyannote.audio resolves to 4.x** (the spec named the 3.1 *model*; the *library* major bumped). 4.x renamed `use_auth_token` → `token` and the pipeline returns a `DiarizeOutput` (use `.speaker_diarization`). The diarization pipeline pulls a **3-model gated HF chain** — see `worker/SMOKE.md`. ECAPA runs on **CPU** even on Apple Silicon (SpeechBrain MPS support is unreliable; the model is tiny); pyannote and mlx-whisper use the GPU.
- **Tests vs smoke.** All deterministic glue (db guards, align, identify, persist, poll loop) is tested with **fake models + real Postgres** (testcontainers) and runs in CI. The **real models are verified only by a local smoke** (`worker/SMOKE.md`, `scripts/smoke_process_meeting.py`) — gated/heavy, never in CI.
- **Lens extraction is a third job type.** `extract_lenses` (`pipeline/extract_lenses.py`) reads the meeting's `status='ok'` utterances at the payload's `processing_version`, calls a **local OpenAI-compatible LLM** (`lens_client.py`; `lens_llm_base_url` defaults to `http://127.0.0.1:11434/v1`, model `qwen3.5:4b-mlx`), and only persists candidates that pass pydantic validation. Failure marks the run/job — the meeting stays `done`. The LLM endpoint is loopback-local like the embed service, so the no-external-network premise holds.
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
uv run python -m damwha_worker           # run the real worker (supervisor; spawns a --once child per job)
uv run python scripts/smoke_process_meeting.py <audio>   # local end-to-end smoke
uv run --with jiwer python scripts/eval_stt.py --wav <16k.wav> --json3 <ref> --outdir <dir>
                                         # STT CER/WER A/B (backends, models, guards); see SMOKE.md
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
