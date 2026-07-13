# Local smoke (real ML models) — Task 14

Not a CI test. Loads gated/heavy models; run by hand on a machine with the
`models` extra installed, ffmpeg, and Docker.

## One-time setup

1. **Accept the pyannote licenses** (logged into HF). The diarization pipeline
   (pyannote.audio 4.x) pulls a gated chain — accept **all three**:
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
   - https://huggingface.co/pyannote/speaker-diarization-community-1
   (download_models.py / the first run will name any further gated repo to accept.)
2. **Set your HF token** in `worker/.env`:
   ```
   HF_TOKEN=hf_xxx...
   ```
3. **Install the model deps** (already done if `uv sync --extra models` ran):
   ```
   cd worker && uv sync --extra models
   ```
4. **Pre-cache models** (optional; first real run downloads them anyway):
   ```
   uv run python scripts/download_models.py
   ```

The STT backend follows the job payload's `devices.stt`: `gpu` runs `mlx-whisper`
(Apple Silicon), `cpu` runs `faster-whisper`.

## Option A — scripted end-to-end (recommended)

Spins a throwaway pgvector Postgres, seeds a meeting + job, runs the real
pipeline on your audio, prints the speaker-attributed timeline:

```
uv run python scripts/smoke_process_meeting.py /path/to/2speaker.wav
# CPU-only embedder/diarizer: add --device cpu
```

Expect: `outcome: committed`, `meeting: status=done`, one utterance per
diarized turn with text, and the diarized speakers listed as unidentified
clusters (no speakers enrolled in a throwaway DB).

### Enroll + identify smoke

Verifies the enrollment and auto-identification paths with real models:

```
uv run python scripts/smoke_enroll_identify.py <enroll_audio> <meeting_audio>
```

It (1) enrolls a speaker from `enroll_audio` (real ECAPA → voiceprint, speaker
`ready`), (2) processes `meeting_audio` and reports whether the enrolled speaker
matched any diarized cluster (cross-recording — informational), and (3) does a
deterministic check: registers a real diarized cluster centroid as a voiceprint
and confirms `identify` matches it. Expect `[1] ENROLL: PASS` and
`[3] DETERMINISTIC IDENTIFY: PASS`.

> **Enrollment quality:** `enroll_speaker` embeds the *whole* sample as one
> voiceprint. Enroll from a **clean single-speaker clip** (~10–30 s of one
> person), not a full multi-speaker meeting — a multi-speaker clip yields a
> muddy averaged embedding that won't identify reliably. (That's why the
> cross-recording step can report "did not match" when enrolling from a meeting.)

## Option B — full stack via the Plan 1 API

1. Run Postgres (pgvector) + apply migrations (`npm run migrate`).
2. `npm run start:dev` (NestJS API).
3. `POST /meetings` with a 2-speaker audio file → creates a queued job.
4. `uv run python -m damwha_worker` (the real worker) → claims + processes.
5. `GET /meetings/:id` → speaker-attributed utterance timeline; `status=done`.
6. Enrollment: `POST /speakers` with a sample → `uv run python -m damwha_worker`
   → `GET /speakers/:id` shows `enrollment_status=ready`. Re-process a meeting
   with that speaker present to see auto-identification.

## Search indexing + embed service (Phase 2 addition)

### One-time: build the custom Postgres image

The search feature requires `pg_bigm` (Korean trigram FTS) alongside `pgvector`.
Build the combined image once before running any integration tests or the full stack:

```bash
# from repo root
docker build -t damwha/postgres-bigm:pg16 docker/postgres-bigm/
```

Or just `docker compose up -d` from the repo root — the `postgres` service
builds and tags the same `damwha/postgres-bigm:pg16` image and runs it.

### Install search model deps

bge-m3 is included in the `models` extra:

```bash
cd worker && uv sync --extra models
```

### Start the embed service

The embed service exposes bge-m3 over HTTP (localhost RPC only):

```bash
cd worker
uv run uvicorn damwha_worker.embed_service:app --host 127.0.0.1 --port 8100
```

First load downloads / warms the bge-m3 model — expect **30–90 s** on first
start (subsequent starts use the local cache). Confirm it's ready:

```bash
curl -s http://127.0.0.1:8100/health | python3 -m json.tool
```

### Startup order (full stack)

Start services in this order; each step must be healthy before the next:

1. **Postgres** (`damwha/postgres-bigm:pg16`) + `npm run migrate`
2. **Embed service** — wait for `/health` → `{"status":"ok"}`
3. **NestJS API** — `npm run start:dev`
4. **Python worker** — `uv run python -m damwha_worker`

The `uv run python -m damwha_worker` command launches a **supervisor parent process** that does not import heavy ML libraries. When a job is available, the parent spawns a child subprocess (`python -m damwha_worker --once`) to process a single job, waits for it to complete, and reclaims the next job. The child exits after processing, allowing the OS to fully reclaim its GPU memory (MLX, torch). This is the core mechanism to prevent OOM from GPU memory accumulation across jobs. When confirming smoke with BGE-M3 CPU embedder or MLX memory caps, verify that both the `index_meeting` (embedding) and `process_meeting` (speech models) paths complete OOM-free.

### Search smoke (Option B extended)

After a meeting is processed (`status=done`), trigger search indexing:

```bash
# reindex all un-indexed meetings
curl -s -X POST http://localhost:3000/meetings/reindex-missing | python3 -m json.tool

# hybrid search (BM25 + dense RRF)
curl -s 'http://localhost:3000/search' \
  -H 'Content-Type: application/json' \
  -d '{"q":"검색어","limit":10}' | python3 -m json.tool
```

`index_meeting` jobs are processed by the same worker poll loop. A failed index
job marks only the job (not the meeting) as failed — the meeting remains `done`
and searchable via BM25 alone until the dense index is rebuilt.
