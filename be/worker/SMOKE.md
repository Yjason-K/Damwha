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

Apple Silicon uses `mlx-whisper` (default `WHISPER_BACKEND=mlx`); CUDA/CPU hosts
set `WHISPER_BACKEND=faster` to use `faster-whisper`.

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

## Option B — full stack via the Plan 1 API

1. Run Postgres (pgvector) + apply migrations (`npm run migrate`).
2. `npm run start:dev` (NestJS API).
3. `POST /meetings` with a 2-speaker audio file → creates a queued job.
4. `uv run python -m damwha_worker` (the real worker) → claims + processes.
5. `GET /meetings/:id` → speaker-attributed utterance timeline; `status=done`.
6. Enrollment: `POST /speakers` with a sample → `uv run python -m damwha_worker`
   → `GET /speakers/:id` shows `enrollment_status=ready`. Re-process a meeting
   with that speaker present to see auto-identification.
