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

## 프리셋별 스모크 (spec 2026-07-13 processing-settings)

Payload v2가 단계별 디바이스(`devices.{diarization,stt}`)와 whisper 모델을 실어
나른다. STT 백엔드는 payload에서 파생된다: `devices.stt: gpu` → `mlx-whisper`,
`cpu` → `faster-whisper` (int8). 프리셋 정의는 `src/settings/presets.ts`
(`PRESET_REVISION='2026-07-13.1'`).

각 프리셋에 대해: `PUT /settings/processing`으로 프리셋 설정 → 짧은 오디오 업로드
→ job 완료(`status=done`) 확인. (또는 업로드 시 multipart `processing`
JSON-string 필드 / reprocess JSON body로 job별 오버라이드.)

- **light**: whisper `small` + STT `cpu`(faster-whisper) — **ARM Mac에서
  faster-whisper CPU 경로가 실제로 도는지 확인** (이전엔 플랫폼 마커로 설치 자체가
  안 됐음; 지금은 전 플랫폼 설치).
- **standard**: `large-v3-turbo` + STT `gpu`(mlx).
- **quality**: `large-v3` + STT `gpu`(mlx).
- v2 payload의 `models.devices`/`preset`이 job 행에 그대로 박혔는지 psql로 확인:
  ```sql
  SELECT payload->'models'->'devices', payload->'models'->>'preset'
    FROM job WHERE type='process_meeting' ORDER BY created_at DESC LIMIT 1;
  ```
- (선택) `devices.diarization: cpu` custom으로 pyannote CPU 경로 1회. 어떤 개별
  필드든(language만 바꿔도) preset은 `custom`으로 전환된다.
- tiny/base/small/medium 신규 모델은 여기서 처음 다운로드·추론된다 — repo 이름은
  `whisper_mlx.py::_REPO`에 실재 확인됨(HF 200); 여기서는 다운로드/추론 자체를 검증.
  미리 캐시하려면 `WHISPER_MLX_REPOS=...` 로 `download_models.py` 실행.

> **GPU 미가용 시**: payload가 `gpu`를 요청했는데 MPS가 없으면 job은
> `gpu_unavailable`로 **PERMANENT 실패**한다 — CPU 폴백 없음(재현성 보존).
