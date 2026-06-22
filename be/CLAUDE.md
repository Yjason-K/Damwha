# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Damwha is a personal, self-hosted meeting recording/search platform. The primary object is the **utterance** — every spoken line is attributed to a speaker, timestamped, and traceable back to the original audio. This repo is the **backend**.

The full design and the executable plan live in `docs/superpowers/`:
- Spec: `docs/superpowers/specs/2026-06-22-damwha-ingestion-backend-design.md`
- Plan 1 (this codebase): `docs/superpowers/plans/2026-06-22-damwha-ingestion-api.md`

Read the spec before changing data model / pipeline semantics — many decisions there are deliberate (privacy: local-only; non-goals).

## Architecture: two runtimes joined by one table

The system is a **polyglot** split that communicates **only through the Postgres `job` table** — never HTTP between them:

- **NestJS API (this repo, TypeScript)** — HTTP only, knows nothing about ML. Stores audio, CRUDs metadata, enqueues jobs, serves status/results.
- **Python ML worker (Plan 2, not yet in this repo)** — polls `job`, runs VAD → diarization → speaker ID → STT → align, writes `utterance`/`meeting_cluster` rows. No HTTP.

The `job` table is the contract. The TypeScript side validates job payloads with zod (`src/contracts/job-payload.schema.ts`); the future Python worker mirrors the same shape with pydantic. **Changing the payload shape or the `stage`/`status` enums means changing both sides** — treat `src/contracts/` and the `001_init.sql` CHECK constraints as the source of truth.

There is **no ORM**. All DB access is raw SQL through `DatabaseService` (`pg.Pool` wrapper with `query` + `withTransaction`). This is intentional — `SELECT ... FOR UPDATE SKIP LOCKED` and pgvector types don't fit ORMs cleanly. Each domain has a thin `*.repository.ts` (SQL), a `*.service.ts` (transactions/orchestration), and a `*.controller.ts` (HTTP).

## Non-obvious invariants (read before editing these areas)

These cross-file rules are easy to break and are enforced by tests:

- **Job queue (`src/jobs/`)**: `attempts` is incremented at **claim** time (queued→running), not on retry — so a crashed worker still counts as one attempt. `claim` must not set `stage` (the worker sets stage per type as it enters each step). `complete()`/`fail()` update the `job` row **only** — on normal completion the linked `meeting.status`/`speaker.enrollment_status` transitions are the *worker's* responsibility (Plan 2, in the same persist/enroll transaction). The **reaper** (`reaper.service.ts`, every 5 min) is the *only* place that propagates status on the crash path: stale `running` jobs (`locked_at` older than `REAPER_STALE_MINUTES`) are requeued if attempts remain, else failed + linked meeting/speaker marked failed.
- **Reprocess + stale guard**: reprocess bumps `meeting.processing_version` and enqueues a new job (it does **not** wrap ML in a DB transaction). The worker's `persist` step must only write results when `meeting.processing_version = payload.processing_version AND meeting.current_job_id = job.id` — otherwise a stale lower-version job would overwrite newer results. Phase 1 reprocess is **overwrite, no history**; `processing_version`/`job_id` stamps on rows exist to support this guard and a future non-destructive merge.
- **Storage path safety (`src/storage/`)**: the DB stores only relative keys (`meetings/<uuid>/...`). Never trust client filenames or store absolute paths. All key→path resolution goes through `StorageService.resolve()`, which rejects traversal/absolute keys. Uploads use multer **diskStorage** (temp file) + `saveFromTemp` — never buffer large audio in memory.
- **Speaker identification (`voiceprint`)**: pgvector columns are fixed-dimension (`vector(192)`). Identification must filter voiceprints by matching `model` + `dimension`, and only compare against speakers with `enrollment_status='ready'`. Unidentified speakers are preserved as `meeting_cluster` rows (raw `diar_label`), never force-created as `speaker`.
- **Env loading**: `loadEnv()` parses the full schema and **requires `DATABASE_URL`** — only call it inside constructors/runtime, never in decorator/module metadata (it runs at import time before tests set env). Use the narrow `maxUploadBytes()` helper in decorators instead.

## Commands

Node **22** is required (`.nvmrc`, `engines`). Use `nvm use` first.

```bash
npm install                              # once
cp .env.example .env                     # configure DATABASE_URL, STORAGE_ROOT, model envs

npm run migrate                          # apply SQL migrations (needs a running Postgres w/ pgvector)
npm run start:dev                        # watch mode
npm run build && npm start               # prod (build copies migrations into dist/)

npm test                                 # full suite, serial
npx jest test/meetings.e2e-spec.ts       # one suite
npx jest test/jobs.repository.spec.ts -t "concurrent"   # one test by name
npx tsc --noEmit -p tsconfig.build.json  # type-check src without emitting
```

**Tests require Docker.** Integration/e2e tests use Testcontainers, which spins up a real `pgvector/pgvector:pg16` Postgres per suite (see `test/db.ts`). Run with `--runInBand` (already in `npm test`) — parallel containers are heavy. No mocking of the DB; tests exercise real SQL including `SKIP LOCKED`, the reaper CTE, and pgvector.

## Conventions

- Follow the plan doc's task structure and the existing per-domain repository/service/controller split when adding features.
- Migrations are plain SQL files in `src/database/migrations/` applied in filename order by `migrate.ts` (tracked in a `_migrations` table). Add new numbered files; don't edit applied ones.
- Enums are `text` + `CHECK` (not native Postgres enums) so values can evolve; keep the zod/pydantic contracts and CHECK lists in sync.
- This is the **API half**. The ML pipeline, ffmpeg audio-integrity validation, and worker-side status transitions are **Plan 2** (Python). Don't add ML or cloud calls here — privacy premise is local-only.

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
