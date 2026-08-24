"""Local smoke for the ENROLL + IDENTIFY real-model paths (the two not covered by
scripts/smoke_process_meeting.py, which ran process_meeting with no enrolled speakers).

Verifies, with REAL models:
  1. enroll_speaker: audio → ECAPA embedding → voiceprint persist + speaker 'ready'.
  2. identify (cross-recording, informational): does the enrolled speaker match any
     diarized cluster in a different meeting?
  3. identify (deterministic): register a real diarized cluster centroid as an enrolled
     voiceprint, then confirm identify_clusters() matches it above threshold and the
     pipeline would assign that speaker_id. Real ECAPA vectors → guaranteed match.

Usage:
    uv run python scripts/smoke_enroll_identify.py <enroll_audio> <meeting_audio> [--device mps|cpu]
    # enroll_audio = a speaker sample; meeting_audio = a meeting to identify them in.

Requires: HF_TOKEN in worker/.env (+ pyannote licenses), ffmpeg, Docker. Not a CI test.
"""

import math
import shutil
import sys
import tempfile
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

from damwha_worker import db
from damwha_worker.config import load_settings
from damwha_worker.models.registry import build_embedder, build_models
from damwha_worker.pipeline.enroll_speaker import run_enroll_speaker
from damwha_worker.pipeline.identify import identify_clusters
from damwha_worker.pipeline.process_meeting import run_process_meeting
from damwha_worker.storage import Storage

MIGRATIONS = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"
EMB_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
THRESHOLD = 0.5


def _process_payload(meeting_id: str, audio_key: str, device: str) -> dict:
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "audio_key": audio_key,
        "processing_version": 0,
        "reprocess": False,
        "models": {
            "whisper_model": "large-v3-turbo",
            "device": device,
            "language": "ko",
            "diarization": {
                "model": "pyannote/speaker-diarization-3.1",
                "min_speakers": None,
                "max_speakers": None,
            },
            "embedding": {"model": EMB_MODEL, "dimension": 192},
        },
        "identify": {"threshold": THRESHOLD},
    }


def _enroll_payload(speaker_id: str, audio_key: str) -> dict:
    return {
        "schema_version": 1,
        "speaker_id": speaker_id,
        "audio_key": audio_key,
        "embedding": {"model": EMB_MODEL, "dimension": 192},
    }


def _copy_into(storage: Storage, key: str, src: Path) -> None:
    dst = Path(storage.resolve(key))
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)


def _parse_vec(v) -> list[float]:
    if isinstance(v, str):
        return [float(x) for x in v.strip("[]").split(",")]
    return list(v)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    enroll_audio = Path(sys.argv[1]).expanduser().resolve()
    meeting_audio = Path(sys.argv[2]).expanduser().resolve()
    for p in (enroll_audio, meeting_audio):
        if not p.is_file():
            print(f"no such audio file: {p}")
            return 2
    device = "mps"
    if "--device" in sys.argv:
        device = sys.argv[sys.argv.index("--device") + 1]

    settings = load_settings()
    if not settings.hf_token:
        print("HF_TOKEN not set — put it in worker/.env and accept the pyannote licenses.")
        return 2

    storage_root = Path(tempfile.mkdtemp(prefix="dw-smoke-ei-"))
    storage = Storage(str(storage_root))
    ok = True

    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
        with psycopg.connect(url, autocommit=True) as mig:
            for f in sorted(MIGRATIONS.glob("*.sql")):
                mig.execute(f.read_text())
        conn = db.connect(url)

        print(f"building models (device={device}) ...", flush=True)
        models = build_models(_process_payload("mtg_1", "x", device), settings)

        # ---- 1. ENROLL (real ECAPA) ----------------------------------------
        print(f"\n[1] enrolling speaker from {enroll_audio.name} ...", flush=True)
        spk_id = conn.execute(
            "INSERT INTO speaker(name, enrollment_status) "
            "VALUES ('Enrolled-A','pending') RETURNING id"
        ).fetchone()["id"]
        enroll_key = f"speakers/{spk_id}/sample{enroll_audio.suffix.lower()}"
        _copy_into(storage, enroll_key, enroll_audio)
        ep = _enroll_payload(spk_id, enroll_key)
        ejob = conn.execute(
            "INSERT INTO job(type, payload) VALUES ('enroll_speaker',%s) RETURNING id", (Jsonb(ep),)
        ).fetchone()
        conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (ejob["id"], spk_id))
        db.claim(conn, "smoke")
        from damwha_worker.contracts import EnrollSpeakerPayload

        # enroll 전용 빌더로 임베더를 만든다 — 실제 워커의 enroll 라우팅과 동일 경로.
        e_out = run_enroll_speaker(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (ejob["id"],)).fetchone(),
            EnrollSpeakerPayload.model_validate(ep),
            build_embedder(ep, settings),
            storage,
            worker_id="smoke",
        )
        srow = conn.execute(
            "SELECT enrollment_status FROM speaker WHERE id=%s", (spk_id,)
        ).fetchone()
        vrow = conn.execute(
            "SELECT embedding, source, sample_duration_ms FROM voiceprint WHERE speaker_id=%s",
            (spk_id,),
        ).fetchone()
        emb = _parse_vec(vrow["embedding"]) if vrow else []
        norm = math.sqrt(sum(x * x for x in emb)) if emb else 0.0
        enroll_ok = (
            e_out == "committed"
            and srow["enrollment_status"] == "ready"
            and vrow is not None
            and vrow["source"] == "enroll"
            and len(emb) == 192
            and norm > 0.0
        )
        ok = ok and enroll_ok
        print(
            f"    enroll outcome={e_out}, status={srow['enrollment_status']}, "
            f"voiceprint dim={len(emb)} norm={norm:.3f} source={vrow and vrow['source']}"
        )
        print(f"    [1] ENROLL: {'PASS' if enroll_ok else 'FAIL'}")

        # ---- 2. PROCESS meeting (real pipeline) w/ enrolled speaker present --
        print(f"\n[2] processing {meeting_audio.name} (enrolled speaker present) ...", flush=True)
        mid = conn.execute(
            "INSERT INTO meeting(audio_key, status, processing_version) "
            "VALUES ('', 'uploaded', 0) RETURNING id"
        ).fetchone()["id"]
        mkey = f"meetings/{mid}/original{meeting_audio.suffix.lower()}"
        _copy_into(storage, mkey, meeting_audio)
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (mkey, mid))
        pp = _process_payload(mid, mkey, device)
        pjob = conn.execute(
            "INSERT INTO job(type, meeting_id, payload) "
            "VALUES ('process_meeting',%s,%s) RETURNING id",
            (mid, Jsonb(pp)),
        ).fetchone()
        conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (pjob["id"], mid))
        db.claim(conn, "smoke")
        from damwha_worker.contracts import ProcessMeetingPayload

        p_out = run_process_meeting(
            conn,
            conn.execute("SELECT * FROM job WHERE id=%s", (pjob["id"],)).fetchone(),
            ProcessMeetingPayload.model_validate(pp),
            models,
            storage,
            worker_id="smoke",
        )
        ident = conn.execute(
            "SELECT DISTINCT diar_label, speaker_id FROM utterance "
            "WHERE meeting_id=%s ORDER BY diar_label",
            (mid,),
        ).fetchall()
        clusters = conn.execute(
            "SELECT diar_label, centroid FROM meeting_cluster "
            "WHERE meeting_id=%s ORDER BY diar_label",
            (mid,),
        ).fetchall()
        n_utt = conn.execute(
            "SELECT count(*) c FROM utterance WHERE meeting_id=%s", (mid,)
        ).fetchone()["c"]
        print(f"    process outcome={p_out}, {n_utt} utterances")
        for r in ident:
            tag = f"speaker={r['speaker_id']}" if r["speaker_id"] else "UNIDENTIFIED"
            print(f"      {r['diar_label']}: {tag}")
        cross_match = any(r["speaker_id"] == spk_id for r in ident if r["speaker_id"])
        if cross_match:
            print("    [2] cross-recording: enrolled speaker MATCHED a cluster")
        else:
            print("    [2] cross-recording: enrolled speaker did NOT match")
            print("        (test/test2 may not share a speaker — informational, not a failure)")

        # ---- 3. DETERMINISTIC identify (real embeddings, guaranteed match) ---
        print("\n[3] deterministic identify: register a real cluster centroid as a voiceprint ...")
        det_ok = False
        if not clusters:
            print("    (no unidentified clusters available — skipping; step 2 already matched all)")
            det_ok = cross_match  # if everything matched in step 2, identify clearly works
        else:
            target = clusters[0]
            centroid = _parse_vec(target["centroid"])
            alice = conn.execute(
                "INSERT INTO speaker(name, enrollment_status) VALUES ('Alice','ready') RETURNING id"
            ).fetchone()["id"]
            conn.execute(
                "INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source) "
                "VALUES (%s,%s::vector,%s,192,'enroll')",
                (alice, target["centroid"], EMB_MODEL),
            )
            result = identify_clusters(
                conn,
                {target["diar_label"]: centroid},
                model=EMB_MODEL,
                dimension=192,
                threshold=THRESHOLD,
            )
            matched = result[target["diar_label"]]
            det_ok = matched.speaker_id == alice
            print(
                f"    cluster {target['diar_label']} centroid → identify returned "
                f"{'Alice ✓' if det_ok else matched}"
            )
        ok = ok and det_ok
        print(f"    [3] DETERMINISTIC IDENTIFY: {'PASS' if det_ok else 'FAIL'}")

        conn.close()

    shutil.rmtree(storage_root, ignore_errors=True)
    print(f"\n==== {'ALL CHECKS PASS' if ok else 'SOME CHECKS FAILED'} ====")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
