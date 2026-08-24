"""End-to-end local smoke: real models → pipeline → persist, on one audio file.

Self-contained: spins a throwaway pgvector Postgres (testcontainers), applies the
Plan 1 migrations, seeds a meeting + queued process_meeting job pointing at the
given audio, then runs the worker's `run_once` with the REAL model adapters and
prints the resulting speaker-attributed utterances.

Usage:
    uv run python scripts/smoke_process_meeting.py /path/to/2speaker.wav [--device mps|cpu]

Requires: HF_TOKEN in worker/.env (+ pyannote license accepted), ffmpeg, Docker.
This is NOT a CI test — it loads gated/heavy models and is run by hand.
"""

import shutil
import sys
import tempfile
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

from damwha_worker import db
from damwha_worker.config import load_settings
from damwha_worker.models.registry import build_models
from damwha_worker.storage import Storage

MIGRATIONS = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"


def _payload(meeting_id: str, audio_key: str, device: str) -> dict:
    """v4 — the shape the API actually enqueues.

    Kept in step with production on purpose: this smoke is the only place the real
    models meet the identify path, so pinning it to an older wire version would
    leave the two-tier suggestion band unexercised against real embeddings. The
    thresholds mirror be/.env defaults (set from scripts/eval_speaker_id.py).
    """
    # The --device flag speaks v1's torch vocabulary (mps|cpu); v2+ payloads carry
    # the per-stage abstract device instead.
    dev = "gpu" if device == "mps" else device
    return {
        "schema_version": 4,
        "meeting_id": meeting_id,
        "audio_key": audio_key,
        "processing_version": 0,
        "reprocess": False,
        "models": {
            "whisper_model": "large-v3-turbo",
            "language": "ko",
            "devices": {"diarization": dev, "stt": dev},
            "preset": "standard",
            "preset_revision": None,
            "summary_model": "mlx-community/Qwen3.5-4B-8bit",
            "diarization": {
                "model": "pyannote/speaker-diarization-3.1",
                "min_speakers": None,
                "max_speakers": None,
            },
            "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
        },
        "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    audio = Path(sys.argv[1]).expanduser().resolve()
    if not audio.is_file():
        print(f"no such audio file: {audio}")
        return 2
    device = "mps"
    if "--device" in sys.argv:
        device = sys.argv[sys.argv.index("--device") + 1]

    settings = load_settings()
    if not settings.hf_token:
        print("HF_TOKEN not set — put it in worker/.env and accept the pyannote license first.")
        return 2

    storage_root = Path(tempfile.mkdtemp(prefix="dw-smoke-"))
    storage = Storage(str(storage_root))

    with PostgresContainer("damwha/postgres-bigm:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
        # apply Plan 1 schema
        with psycopg.connect(url, autocommit=True) as mig:
            for f in sorted(MIGRATIONS.glob("*.sql")):
                mig.execute(f.read_text())

        conn = db.connect(url)
        # id는 DB가 채번 → RETURNING으로 받는다 (UUID 직접 삽입은 CHECK 위반). dict_row → ["id"].
        meeting_id = conn.execute(
            "INSERT INTO meeting(audio_key, status, processing_version) "
            "VALUES ('', 'uploaded', 0) RETURNING id"
        ).fetchone()["id"]
        audio_key = f"meetings/{meeting_id}/original{audio.suffix.lower()}"
        dst = Path(storage.resolve(audio_key))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(audio, dst)
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (audio_key, meeting_id))
        payload = _payload(meeting_id, audio_key, device)
        job = conn.execute(
            "INSERT INTO job(type, meeting_id, payload) "
            "VALUES ('process_meeting',%s,%s) RETURNING id",
            (meeting_id, Jsonb(payload)),
        ).fetchone()
        conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (job["id"], meeting_id))

        print(f"built models (device={device}) ...", flush=True)
        models = build_models(payload, settings)

        # import here so a missing registry/model dep fails loudly above, not at import
        from damwha_worker.__main__ import run_once

        print("running pipeline (real models) ...", flush=True)
        outcome = run_once(conn, "smoke-worker", storage, build_models=lambda: models)
        print(f"\noutcome: {outcome}")

        m = conn.execute(
            "SELECT status, duration_ms FROM meeting WHERE id=%s", (meeting_id,)
        ).fetchone()
        print(f"meeting: status={m['status']} duration_ms={m['duration_ms']}")

        rows = conn.execute(
            "SELECT order_index, diar_label, speaker_id, status, text "
            "FROM utterance WHERE meeting_id=%s ORDER BY order_index",
            (meeting_id,),
        ).fetchall()
        print(f"\n{len(rows)} utterance(s):")
        for r in rows:
            who = r["speaker_id"] or r["diar_label"]
            print(f"  [{r['order_index']:>2}] {who:>12}  {r['status']:<16} {r['text']!r}")

        clusters = conn.execute(
            "SELECT diar_label FROM meeting_cluster WHERE meeting_id=%s ORDER BY diar_label",
            (meeting_id,),
        ).fetchall()
        print(f"\nunidentified clusters: {[c['diar_label'] for c in clusters]}")
        conn.close()

    shutil.rmtree(storage_root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
