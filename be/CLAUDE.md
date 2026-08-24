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

The `job` table is the contract. The TypeScript side validates job payloads with zod (`src/contracts/job-payload.schema.ts`); the Python worker mirrors the same shape with pydantic (`worker/damwha_worker/contracts.py`), and the same JSON fixtures (`test/fixtures/job-payloads/`) are validated on both sides to block drift. The payload carries a top-level `schema_version`. Supported versions are **per job type** (`SUPPORTED_SCHEMA_VERSIONS` dict in `worker/damwha_worker/contracts.py`): `process_meeting` accepts **v1 through v5**, while `enroll_speaker`/`index_meeting` stay **v1**. **v2** adds per-stage `models.devices.{diarization,stt}` (`cpu`|`gpu`) plus `preset`/`preset_revision` reference info; **v3** adds `models.summary_model` (the summary LLM the processing preset chose), required on the wire; **v4** adds `identify.suggest_threshold`, the floor of the two-tier identification band, also required on the wire; **v5** adds `followups.{lens,summary}`, the switches that decide whether `persist` queues the lens/summary jobs — required on the wire, and a payload converted from v1–v4 gets both `true`, which is what those versions always did. The worker converts any version's `process_meeting` payload to one internal shape, so downstream code always sees the same fields — a payload converted from v1/v2 has `summary_model=None` there and the worker falls back to its own env default, and one converted from v1/v2/v3 has `suggest_threshold=None`, which disables suggestions entirely. Both fields are required from the version that introduced them for the same reason: the model and the thresholds *are* the behaviour, so replaying a recorded job must not silently pick up a different worker default. **Changing the payload shape or the `stage`/`status` enums means changing both sides** — treat `src/contracts/`, `worker/damwha_worker/contracts.py`, and the `001_init.sql` CHECK constraints as the source of truth.

There is **no ORM**. All DB access is raw SQL through `DatabaseService` (`pg.Pool` wrapper with `query` + `withTransaction`). This is intentional — `SELECT ... FOR UPDATE SKIP LOCKED` and pgvector types don't fit ORMs cleanly. Each domain has a thin `*.repository.ts` (SQL), a `*.service.ts` (transactions/orchestration), and a `*.controller.ts` (HTTP).

## Non-obvious invariants (read before editing these areas)

These cross-file rules are easy to break and are enforced by tests:

- **Job queue (`src/jobs/`)**: `attempts` is incremented at **claim** time (queued→running), not on retry — so a crashed worker still counts as one attempt. `claim` must not set `stage` (the worker sets stage per type as it enters each step). `complete()`/`fail()` update the `job` row **only** — on normal completion the linked `meeting.status`/`speaker.enrollment_status` transitions are the *worker's* responsibility (Plan 2, in the same persist/enroll transaction). The **reaper** is what propagates status on the crash path: stale `running` jobs (`locked_at` older than `REAPER_STALE_MINUTES`) are requeued if attempts remain, else failed + linked meeting/speaker marked failed. There are **two reapers running the same CTE every 5 min** — the NestJS `reaper.service.ts` and the worker supervisor's daemon thread (`worker/damwha_worker/reaper.py` → `db.reap_stale`). Concurrent runs are safe because the CTE selects `FOR UPDATE SKIP LOCKED`; keep the two SQL bodies in sync when editing either. A reaper requeue clears `next_attempt_at` (no backoff — the worker is already gone) and leaves `attempts` as claimed.
- **Reprocess + stale guard**: reprocess bumps `meeting.processing_version` and enqueues a new job (it does **not** wrap ML in a DB transaction). The worker's `persist` step must only write results when `meeting.processing_version = payload.processing_version AND meeting.current_job_id = job.id` — otherwise a stale lower-version job would overwrite newer results. **`utterance` rows of older versions are retained** (migration `013`: the uniqueness key is `(meeting_id, processing_version, order_index)`) so lens evidence pointing at a superseded utterance stays valid; `meeting_cluster` is still replaced wholesale. Every reader therefore filters `u.processing_version = m.processing_version` — a query that forgets it will surface stale turns.
- **Storage path safety (`src/storage/`)**: the DB stores only relative keys (`meetings/<meeting_id>/...`). Never trust client filenames or store absolute paths. All key→path resolution goes through `StorageService.resolve()`, which rejects traversal/absolute keys. Uploads use multer **diskStorage** (temp file) + `saveFromTemp` — never buffer large audio in memory.
- **Speaker identification (`voiceprint`, `identify.py`)**: pgvector columns are fixed-dimension (`vector(192)`). Identification must filter voiceprints by matching `model` + `dimension`, and compares against speakers whose enrollment has **settled** — `ready` *or* `provisional` (`MATCHABLE_STATUSES`); `pending`/`failed` stay out. Provisional used to be excluded until a human renamed the speaker, and that made cross-meeting identity **structurally impossible**: a fresh install has zero `ready` speakers, so the candidate set was always empty and the same person re-appeared as a new speaker in every meeting (the same audio uploaded twice produced two disjoint speaker sets at centroid similarity 1.0000). Matching is **two-tier**, both thresholds stamped into the payload (wire **v4**): at/above `identify.threshold` the cluster **binds**; down to `identify.suggest_threshold` the score is too close to call, so the cluster still mints its own provisional speaker and the candidate is parked in `meeting_cluster.suggested_speaker_id`/`suggested_similarity` (migration `018`) for the user to confirm through the existing `POST /meetings/:id/clusters/:clusterId/resolve` — which clears the suggestion either way. v1–v3 payloads carry no band and behave exactly as before (bind or nothing). Cluster centroids are a **duration-weighted** mean (`centroids_by_label`): a sub-second backchannel carries little identity but plenty of the model's bias direction, and weighting drops the worst measured different-speaker pair from .674 to .619 without stranding short clusters the way a minimum-length filter did. Unidentified clusters are **auto-created as `provisional` speakers** (default name `Speaker_NNN` via `speaker_default_seq`) with an `auto_cluster` voiceprint carrying `source_cluster_id` provenance. **Every** diar label gets a `meeting_cluster` row — including one identify bound outright — because that table is the per-meeting `diar_label→speaker` record and the entry point for a user correction. `resolve` reattaches the cluster's single voiceprint (`ON CONFLICT (source_cluster_id)`) and GCs orphaned provisional speakers. `persist` likewise GCs unconfirmed `provisional` orphans on reprocess (a global conditional DELETE of `provisional` speakers with no utterance/cluster references; **a pending suggestion counts as a reference**, and confirmed `ready` speakers are never deleted). Thresholds are set from measurement, not feel — `worker/scripts/eval_speaker_id.py` replays the whole policy offline against the live DB; **retune with it**. Known gaps (stale-version speakers polluting the candidate pool, no intra-meeting merge, zero-utterance clusters becoming speakers) are recorded in `docs/backlog.md`.
- **Env loading**: the worker's `Settings` (`worker/damwha_worker/config.py`) has two **required** fields with no default — `DATABASE_URL` and `LENS_LLM_BASE_URL`. A default would blur "address not configured" into "nothing listening there", and the managed-server path binds that URL's `host:port`, so it must be explicit. The supervisor probes `GET {base_url}/models` once at startup (`log_lens_llm_health`) and **warns without failing** — `process_meeting` doesn't touch the LLM, so a down LLM server must not block audio ingestion. With `LENS_LLM_MANAGED=true` (the default) that startup probe logs info instead of warning: no server running yet is the normal state. On the API side, `loadEnv()` parses the full schema and **requires `DATABASE_URL`** — only call it inside constructors/runtime, never in decorator/module metadata (it runs at import time before tests set env). Use the narrow `maxUploadBytes()` helper in decorators instead.
- **Lenses (`src/lenses/`, migrations `008`–`014`)**: `lens_item` holds actions/decisions/promises with a `source` (`ai`|`user`|`edited`), `user_modified`, `completion_status`, `lifecycle_status`; `lens_evidence` links an item to utterances (`primary`|`supporting`). **Re-extraction must never clobber human work** — `classifyAiMerge` (`lenses.service.ts`) only considers items that are `source='ai' AND NOT user_modified AND active AND open`, matches a candidate to one by `(kind, primary utterance)`, and archives eligible items no candidate matched. Everything else (user-created, edited, completed, archived) is invisible to the merge. An **active AI item must always keep exactly one primary evidence row** — enforced by deferred constraint triggers (`014`) plus service-level conflict guards on evidence add/remove; a `PATCH` with no editable field is a deliberate no-op so an empty request can't stamp `edited`/`user_modified` and silently drop the item out of merge eligibility. Evidence may only cite an utterance of the item's own meeting (deferred trigger, `013`).
- **Lens extraction runs (`extract_lenses` job)**: `lens_extraction_run` is keyed per `(meeting, processing_version)`. The API side (`lens-extraction.service.ts`) requires `meeting.status='done'`, reuses the active run instead of enqueueing a second one (idempotent retry), and the worker auto-enqueues a run in the same transaction as `persist` (skipped when the worker has no `lens_llm_model` configured, **or when the payload's `followups.lens` is false** — upload sends `defer_lens=true` for that, and the user runs it later through the same manual endpoint; reprocess never defers). The worker guards every write with the same run/job/version ownership checks as the ML pipeline (`db.mark_lens_run_running` / `db.persist_lens_extraction`) and re-validates the LLM's ids server-side — an utterance or assignee that isn't in the meeting at that `processing_version` is rejected, never stored. `GET /lenses` (keyset cursor; `completion_status` is a **single value**, not a set) and `GET /lenses/extraction-status` back the global dashboard. `GET /meetings/:id/lenses` additionally returns `extraction_status` — the latest run's status **at the meeting's current `processing_version`**, or `null` when that version never ran one. It exists so the UI can tell "deferred / never extracted" from "extracted, found nothing"; a deferred upload writes no run row at all, so without it a deferred meeting is indistinguishable from an empty one. It is deliberately not a `failed` row — the global banner reads `failed` as a real extraction error.

## Python worker (`worker/`)

Separate Python project under `worker/` (uv + ruff + pytest + pydantic v2 + psycopg3, no ORM — same raw-SQL reasons as the API). It consumes the `job` contract and never imports the NestJS side. Key realities (mostly learned during Plan 2 and the real-model smoke):

- **Process model: supervisor + one-job child, not a single poll loop.** `python -m damwha_worker` starts a **parent supervisor** (`__main__.py`) that only does `db.peek_queued` and spawns `python -m damwha_worker --once` as a **child process per job**; the child claims, processes exactly one job, and exits. The parent branches on the child's exit code — `0` = handled (peek again immediately), `3` = no job (poll sleep), anything else = crash (capped exponential backoff, max 60s, to stop infinite respawn on a deterministic error). The lock never crosses the process boundary, so the parent's peek deliberately ignores `next_attempt_at` and the child's claim enforces it. The supervisor also runs the reaper daemon thread. Signals are two-stage: first SIGINT/SIGTERM stops at the next stage boundary, second one kills. Full detail (including the mermaid flow) lives in `docs/worker-architecture.md` §4 — that doc is current; prefer it over this summary.
- **Models are an optional extra.** Heavy/gated ML deps live in `[project.optional-dependencies] models`, **not** base deps. `mlx-whisper` stays Apple-Silicon–marked, but **`faster-whisper` now installs on all platforms** (the CPU STT path must work on ARM Mac too). The deterministic test suite never imports them (registry/adapters are imported only inside `__main__.main()`), so plain `uv sync` stays light; the real worker runs `uv sync --extra models`.
- **STT backend is derived from the payload, not settings.** `whisper_backend`/`device` are **gone** from `config.py`. `build_models` (`worker/damwha_worker/models/registry.py`) picks the transcriber from `devices.stt`: `gpu` → `MlxWhisper` (MLX repo per `whisper_mlx.py::_REPO`), `cpu` → `FasterWhisper` (int8). Per-stage device → torch device goes through `torch_device` (`models/device.py`); a `gpu` request on a machine without MPS is a **PERMANENT `gpu_unavailable`** failure — **no CPU fallback** (payload reproducibility).
- **Processing settings live in the API.** `src/settings/` owns the global `ProcessingConfig` (`app_setting` table, migration `007`; presets light/standard/quality in `presets.ts` also pin a `summary_model` from the catalog in `src/contracts/model-catalog.ts` — `mlx-community/Qwen3.5-{4B,9B,27B}-8bit` — `PRESET_REVISION='2026-08-12.3'`) exposed via `GET`/`PUT /settings/processing` — PUT fully resolves a named preset before its GPU-eligibility check. `src/system/` exposes `GET /system/capabilities` (`gpu_eligible` = hardware fit only). Job-level overrides: upload multipart `processing` JSON-string field (plus the `defer_lens`/`defer_summary` `"true"`/`"false"` fields — follow-up switches, not processing settings, so they stay out of `ProcessingOverride`), reprocess JSON body — **any individual field (even language-only) flips `preset` to `custom`**.
- **Ownership guards (the safety model).** Every worker write to shared state is guarded; 0 affected rows = lost ownership → discard local result. Two distinct guards, both needed: **job guard** (`locked_by = worker AND status='running'` — catches a same-job requeue+reclaim) and **meeting guard** (`processing_version = payload_pv AND current_job_id = job.id` — catches a newer reprocess). `persist` applies both in one short TX → returns `committed` / `discarded` (stale: job marked `done`+reason, meeting untouched) / `lost`.
- **Failure classification and retry timing.** `errors.ErrorKind` is PERMANENT vs TRANSIENT (uncategorized → TRANSIENT). PERMANENT → fail immediately; TRANSIENT → requeue if attempts remain. Retries **are** time-gated: migration `015` added `job.next_attempt_at`, and `db.requeue` sets it to `now() + least(power(2, attempts - 1), 60) * interval '1 second'` (capped exponential backoff). Both `claim` implementations (`src/jobs/jobs.repository.ts`, `worker/damwha_worker/db.py`) filter on `next_attempt_at IS NULL OR <= now()` and order by `next_attempt_at NULLS FIRST, created_at`; claim clears it. The two other paths back to `queued` deliberately do **not** back off: the reaper (worker already dead) and `requeue_for_shutdown`, which also **decrements `attempts`** so a graceful restart doesn't burn a retry. Heartbeat runs on its own DB connection in a daemon thread and survives a transient DB error.
- **pyannote.audio resolves to 4.x** (the spec named the 3.1 *model*; the *library* major bumped). 4.x renamed `use_auth_token` → `token` and the pipeline returns a `DiarizeOutput` (use `.speaker_diarization`). The diarization pipeline pulls a **3-model gated HF chain** — see `worker/SMOKE.md`. ECAPA runs on **CPU** even on Apple Silicon (SpeechBrain MPS support is unreliable; the model is tiny); pyannote and mlx-whisper use the GPU.
- **Tests vs smoke.** All deterministic glue (db guards, align, identify, persist, poll loop) is tested with **fake models + real Postgres** (testcontainers) and runs in CI. The **real models are verified only by a local smoke** (`worker/SMOKE.md`, `scripts/smoke_process_meeting.py`) — gated/heavy, never in CI.
- **Lens extraction is a third job type.** `extract_lenses` (`pipeline/extract_lenses.py`) reads the meeting's `status='ok'` utterances at the payload's `processing_version`, calls a **local OpenAI-compatible LLM** (`lens_client.py`; `lens_llm_base_url` defaults to `http://127.0.0.1:8000/v1`, model `mlx-community/Qwen3.5-4B-8bit`), and only persists candidates that pass pydantic validation. Failure marks the run/job — the meeting stays `done`. The LLM endpoint is loopback-local like the embed service, so the no-external-network premise holds. The client is **runtime-agnostic — there is no Ollama dependency**; the local runtime is `mlx_lm.server`, which serves an HF repo directly and validates the request's `model` field as a repo id with no way to alias it — which is why the summary catalog holds repo ids rather than Ollama tags (setup + five gotchas in `worker/SMOKE.md`). Because `response_format` is advisory for local runtimes, the LLM-response contract must tolerate an omitted nullable field — `LensCandidate.assignee_speaker_id`/`due_at` default to `None`; `extra="forbid"` still rejects invented fields. That contract is **worker-only** (no TS counterpart), unlike the job payload.
- **Conversation summary is a fourth job type.** `summarize_meeting`
  (`pipeline/summarize_meeting.py`) reads the same `status='ok'` utterances as
  `extract_lenses` and calls the same local LLM through `summary_client.py`,
  but writes a single `meeting_summary` row (topics + segments as jsonb). The
  summary model comes from two different places depending on who triggers the
  job: the worker's auto-enqueue uses the payload's `models.summary_model`
  (falling back to the worker's own env default when absent — v1/v2
  payloads; skipped entirely when `followups.summary` is false, which is what
  upload's `defer_summary=true` sets), while the API's manual regeneration
  (`POST /meetings/:id/summary/generate`) uses the global processing
  setting's `summary_model` unless the request body overrides it, and
  returns `409` if a different model is already in flight for that meeting.
  The two jobs are queued together in the `persist` transaction and are
  otherwise **independent** — a summary failure leaves lens items untouched
  and vice versa. **The LLM supplies only boundary `utterance_id`s; `start_ms`/`end_ms`
  are derived from the DB rows** (`_resolve_segments`), so a model cannot
  invent timestamps. Validation is all-or-nothing: an unknown utterance,
  reversed boundaries, or out-of-order segments raise a PERMANENT
  `WorkerError` and nothing is stored. The summary is **read-only** — there is
  no per-item edit path, no `source` column, and no merge; regeneration
  replaces the row wholesale. `summary_client.py` sends an explicit
  `max_tokens` (`lens_llm_max_tokens`, default 8192) because the server default
  (512 on `mlx_lm.server`) truncates a long meeting's JSON mid-object, and
  retries **once** on a JSON/schema failure by feeding the rejected reply plus
  the validation error back as extra turns — a bare re-ask returns the same
  bytes at `temperature=0`. A `finish_reason='length'` reply is **not** retried
  (same budget, same truncation); it fails PERMANENT naming the budget.
- **The LLM server's lifetime is owned by the job, not by the operator.**
  `llm_server.py::managed_llm_server` wraps the `extract_lenses` /
  `summarize_meeting` branches of `handle_job`: the one-job child starts
  `mlx_lm.server` on the `LENS_LLM_BASE_URL` host:port with the **payload's**
  `model` (both LLM payloads carry it, so `peek_queued` stays a bare bool and
  no model swap happens), waits for `GET /models`, and SIGTERMs it in a
  `finally` — SIGKILL if it ignores that. The point is memory: an idle 8-bit
  27B holds ~28GB, and it would hold it *alongside* whisper during an
  unrelated `process_meeting`. The cost is one model load per job — lens and
  summary are queued together by `persist`, so a pair costs two loads.
  **A server that is already listening is treated as someone else's** (manual
  start, SMOKE) — reused, never killed. `LENS_LLM_MANAGED=false` restores the
  old operator-owned behavior. Failures are `llm_server_start_failed`:
  PERMANENT for a missing binary or a port-less base URL, TRANSIENT for a
  startup timeout or an early exit. Because the server is a grandchild of the
  supervisor and inherits its process group, a group kill takes it down too;
  the normal path never relies on that.
- **Search indexing.** `index_meeting` is a separate job type (dispatched by the API after persist completes). Failure marks the job only — the meeting stays `done` and BM25-searchable. Query embedding is the **single exception to the job-table-only invariant**: the API calls the embed service (localhost HTTP RPC, `POST /embed`) directly at query time; this never crosses a network boundary (`EMBED_SERVICE_ALLOW_NON_LOOPBACK=false`).

## Commands

`be/` is the `damwha-be` package of the Damwha monorepo. Node **22** is required
(`.nvmrc`, `engines`); `pnpm` is pinned to 10.26.0 by the root `package.json` and
activated by corepack. **Never run `npm install` here** — it recreates a
`package-lock.json` and a hoisted `node_modules` that the workspace no longer uses,
and it re-masks undeclared dependencies (`multer` was exactly that bug).

Install once from the monorepo root; everything else works from either directory.

```bash
pnpm install                             # FROM THE MONOREPO ROOT — installs be + fe
cp .env.example .env                     # configure DATABASE_URL, STORAGE_ROOT, model envs

docker compose up -d                     # from be/ — Postgres (pgvector + pg_bigm); first run builds the image
pnpm migrate                             # apply SQL migrations (needs a running Postgres w/ pgvector)
pnpm start:dev                           # watch mode (Swagger UI at /docs, OpenAPI JSON at /docs-json)
pnpm build && pnpm start                 # prod (build copies migrations into dist/)

pnpm test                                # full suite, serial
pnpm exec jest test/meetings.e2e-spec.ts # one suite
pnpm exec jest test/jobs.repository.spec.ts -t "concurrent"   # one test by name
pnpm exec tsc --noEmit -p tsconfig.build.json                 # type-check src without emitting
```

From the monorepo root the same commands are `pnpm db:up`, `pnpm be:migrate`,
`pnpm be:dev`, `pnpm be:build`, `pnpm be:test`, or `pnpm be <script>` for anything else.

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

**Tests require Docker.** Integration/e2e tests use Testcontainers, which spins up a real `damwha/postgres-bigm:pg16` Postgres per suite (see `test/db.ts`). Run with `--runInBand` (already in `pnpm test`) — parallel containers are heavy. No mocking of the DB; tests exercise real SQL including `SKIP LOCKED`, the reaper CTE, and pgvector.

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
