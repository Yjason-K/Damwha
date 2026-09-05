"""라이브 세션 로컬 smoke — 실모델(whisper·ECAPA·silero)로 세션 한 번.

    uv run python scripts/smoke_live_session.py --mic --seconds 60
    uv run python scripts/smoke_live_session.py --file /path/16k-mono.wav

testcontainers Postgres를 띄우고 마이그레이션·recording 회의·live_session job을 심은 뒤
run_live_session을 돌린다. --mic는 지정한 초 뒤에 stop 플래그를 스스로 찍는다. --file은
실시간 속도로 흘리고 EOF에서 끝난다. 세그먼트 끝 → live_utterance INSERT 지연(ms)을
"latency_ms=" 로그로 남긴다 — 설계 §9 "1~2초"의 실측이다. CI 테스트가 아니다.
"""

import argparse
import logging
import sys
import tempfile
import threading
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

from damwha_worker import db
from damwha_worker.audio.source import FileSource, MicSource
from damwha_worker.config import load_settings
from damwha_worker.contracts import parse_payload
from damwha_worker.models.registry import build_live_models
from damwha_worker.pipeline import live_session
from damwha_worker.storage import Storage

MIGRATIONS = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"


def _payload(meeting_id: str, audio_key: str, device: str) -> dict:
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "audio_key": audio_key,
        "source": "mic",
        "process": {
            "schema_version": 5,
            "meeting_id": meeting_id,
            "audio_key": audio_key,
            "processing_version": 0,
            "reprocess": False,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": device, "stt": device},
                "preset": "standard",
                "preset_revision": None,
                "summary_model": "mlx-community/Qwen3.5-4B-8bit",
                "diarization": {
                    "model": "pyannote/speaker-diarization-community-1",
                    "min_speakers": None,
                    "max_speakers": None,
                },
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
            "followups": {"lens": True, "summary": True},
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mic", action="store_true")
    ap.add_argument("--file")
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--device", choices=["gpu", "cpu"], default="gpu")
    args = ap.parse_args()
    if not args.mic and not args.file:
        ap.error("--mic 또는 --file 중 하나")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = load_settings()

    with PostgresContainer("damwha/postgres-bigm:pg16") as pg:
        url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
        with psycopg.connect(url, autocommit=True) as c:
            for f in sorted(MIGRATIONS.glob("*.sql")):
                c.execute(f.read_text())
        conn = psycopg.connect(url, row_factory=dict_row, autocommit=True)
        storage_root = tempfile.mkdtemp(prefix="damwha-live-smoke-")
        storage = Storage(storage_root)

        mid = conn.execute(
            "INSERT INTO meeting(audio_key, status) VALUES ('pending','recording') RETURNING id"
        ).fetchone()["id"]
        audio_key = f"meetings/{mid}/original.wav"
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (audio_key, mid))
        payload_dict = _payload(mid, audio_key, args.device)
        jid = conn.execute(
            "INSERT INTO job(type, meeting_id, payload, max_attempts) "
            "VALUES ('live_session', %s, %s, 1) RETURNING id",
            (mid, Jsonb(payload_dict)),
        ).fetchone()["id"]
        conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
        job = db.claim(conn, settings.worker_id)
        assert job is not None and job["id"] == jid

        models = build_live_models(payload_dict, settings)
        source = MicSource() if args.mic else FileSource(args.file, realtime=True)
        if args.mic:

            def _stop_later() -> None:
                time.sleep(args.seconds)
                with psycopg.connect(url, autocommit=True) as c2:
                    c2.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (jid,))
                logging.info("stop requested after %ss", args.seconds)

            threading.Thread(target=_stop_later, daemon=True).start()

        # 지연 측정: insert_live_utterance를 감싸 세그먼트 end_ms 대비 벽시계 지연을 찍는다.
        real_insert = db.insert_live_utterance
        t0 = time.monotonic()

        def _timed_insert(conn_, **kw):
            wall_ms = int((time.monotonic() - t0) * 1000)
            logging.info(
                "seg %d [%d-%d ms] latency_ms=%d text=%r",
                kw["seq"],
                kw["start_ms"],
                kw["end_ms"],
                wall_ms - kw["end_ms"],
                kw["text"][:40],
            )
            return real_insert(conn_, **kw)

        db.insert_live_utterance = _timed_insert  # type: ignore[assignment]

        outcome = live_session.run_live_session(
            conn,
            job,
            parse_payload("live_session", payload_dict),
            models,
            storage,
            source,
            worker_id=settings.worker_id,
            max_minutes=settings.live_max_minutes,
        )
        rows = conn.execute(
            "SELECT seq, start_ms, end_ms, speaker_id, similarity, text FROM live_utterance "
            "WHERE meeting_id=%s ORDER BY seq",
            (mid,),
        ).fetchall()
        m = conn.execute("SELECT status, duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()
        print(f"\noutcome={outcome} meeting={m} rows={len(rows)} wav={storage.resolve(audio_key)}")
        for r in rows:
            speaker = r["speaker_id"] or "?"
            print(f"  {r['seq']:3d} {r['start_ms']:7d}-{r['end_ms']:7d} {speaker:10s} {r['text']}")
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
