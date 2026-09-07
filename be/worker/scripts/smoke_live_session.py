"""라이브 세션 로컬 smoke — 실모델(whisper·ECAPA·silero)로 세션 한 번.

    uv run python scripts/smoke_live_session.py --mic --seconds 60
    uv run python scripts/smoke_live_session.py --file /path/16k-mono.wav
    uv run python scripts/smoke_live_session.py --tail /path/16k-mono.wav --seconds 60

testcontainers Postgres를 띄우고 마이그레이션·recording 회의·live_session job을 심은 뒤
run_live_session을 돌린다. --mic는 지정한 초 뒤에 stop 플래그를 스스로 찍는다. --file은
실시간 속도로 흘리고 EOF에서 끝난다. --tail은 <path>의 실제 WAV를 소스로 삼아 그 PCM을
**새 파일**에 1초 청크로 실시간 append하면서 그 새 파일에 TailSource를 붙인다 — 브라우저가
올리고 API가 쓰는 파일을 워커가 따라 읽는 경로를, 브라우저·API 없이 그 계약(스트리밍 헤더 →
append → 봉인)만 흉내내어 재현한다. append가 끝나면 헤더를 확정하고 job.sealed_bytes를
찍어 TailSource가 EOF를 내게 한다. 세그먼트 끝 → live_utterance INSERT 지연(ms)을
"latency_ms=" 로그로 남긴다 — 설계 §9 "1~2초"의 실측이다. CI 테스트가 아니다.
"""

import argparse
import logging
import os
import struct
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from testcontainers.postgres import PostgresContainer

from damwha_worker import db
from damwha_worker.audio.source import SR, FileSource, MicSource
from damwha_worker.audio.tail_source import TailSource
from damwha_worker.config import load_settings
from damwha_worker.contracts import parse_payload
from damwha_worker.models.registry import build_live_models
from damwha_worker.pipeline import live_session
from damwha_worker.storage import Storage

MIGRATIONS = Path(__file__).resolve().parents[2] / "src" / "database" / "migrations"

#: be/src/storage/live-audio.service.ts와 바이트 단위로 동일한 상수·헤더 — 브라우저+API가
#: 쓰는 라이브 WAV를 흉내낸다 (설계 §2.2, §2.8).
HEADER_LEN = 44
STREAMING_SIZE = 0xFFFFFFFF


def _wav_header(data_size: int, riff_size: int) -> bytes:
    b = bytearray(HEADER_LEN)
    b[0:4] = b"RIFF"
    struct.pack_into("<I", b, 4, riff_size)
    b[8:12] = b"WAVE"
    b[12:16] = b"fmt "
    struct.pack_into("<I", b, 16, 16)
    struct.pack_into("<H", b, 20, 1)
    struct.pack_into("<H", b, 22, 1)
    struct.pack_into("<I", b, 24, SR)
    struct.pack_into("<I", b, 28, SR * 2)
    struct.pack_into("<H", b, 32, 2)
    struct.pack_into("<H", b, 34, 16)
    b[36:40] = b"data"
    struct.pack_into("<I", b, 40, data_size)
    return bytes(b)


def _append_realtime(target_path: str, source_wav: str, max_seconds: int, on_committed=None) -> int:
    """source_wav의 PCM을 target_path 끝에 1초 청크로 실시간 append한다(설계 §2.5의
    "초당 POST" 흉내). max_seconds만큼(또는 source_wav가 먼저 끝나면 그만큼) 쓰고 append한
    바이트 수를 돌려준다. target_path는 이미 스트리밍 헤더가 쓰여 있어야 한다.

    on_committed은 sync 뒤 확정 경계를 DB에 커밋하는 API의 역할을 흉내 낸다 — 이걸 안 하면
    TailSource가 committed=0만 보고 봉인 전까지 한 프레임도 읽지 않는다 (설계 §3.3 ④)."""
    max_bytes = max_seconds * SR * 2 if max_seconds else None
    written = 0
    with wave.open(source_wav, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SR, 1, 2):
            raise SystemExit(
                f"--tail source needs {SR} Hz mono int16 wav, got "
                f"{w.getframerate()} Hz / {w.getnchannels()} ch / {w.getsampwidth() * 8} bit"
            )
        with open(target_path, "r+b") as f:
            f.seek(0, os.SEEK_END)
            while max_bytes is None or written < max_bytes:
                pcm = w.readframes(SR)  # 1초치 샘플
                if not pcm:
                    break
                f.write(pcm)
                f.flush()
                os.fsync(f.fileno())
                written += len(pcm)
                if on_committed is not None:
                    on_committed(written)
                time.sleep(1.0)
    return written


def _payload(meeting_id: str, audio_key: str, device: str, *, source: str = "mic") -> dict:
    return {
        "schema_version": 1,
        "meeting_id": meeting_id,
        "audio_key": audio_key,
        "source": source,
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
    ap.add_argument(
        "--tail",
        metavar="SOURCE_WAV",
        help="SOURCE_WAV의 PCM을 새 파일에 실시간 append하며 그 파일에 TailSource를 붙인다 "
        "— 시스템 오디오 구현체가 아니라 브라우저+API가 쓰는 경로의 계약을 흉내낸다",
    )
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--device", choices=["gpu", "cpu"], default="gpu")
    args = ap.parse_args()
    if sum(bool(m) for m in (args.mic, args.file, args.tail)) != 1:
        ap.error("--mic, --file, --tail 중 정확히 하나")
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
        audio_key = f"meetings/{mid}/{'live.wav' if args.tail else 'original.wav'}"
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (audio_key, mid))
        source_kind = "browser" if args.tail else "mic"
        payload_dict = _payload(mid, audio_key, args.device, source=source_kind)
        jid = conn.execute(
            "INSERT INTO job(type, meeting_id, payload, max_attempts) "
            "VALUES ('live_session', %s, %s, 1) RETURNING id",
            (mid, Jsonb(payload_dict)),
        ).fetchone()["id"]
        conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
        job = db.claim(conn, settings.worker_id)
        assert job is not None and job["id"] == jid

        models = build_live_models(payload_dict, settings)
        state_box: dict | None = None
        if args.tail:
            target_path = storage.resolve(audio_key)
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            with open(target_path, "wb") as f:
                f.write(_wav_header(STREAMING_SIZE, STREAMING_SIZE))
            # run_live_session이 첫 스냅샷을 채운다. 소스는 이 자리를 읽기만 한다.
            state_box = {"state": db.LiveInputState(None, 0, None)}
            source = TailSource(target_path, input_state=lambda: state_box["state"])

            def _tail_writer() -> None:
                with psycopg.connect(url, autocommit=True) as c1:
                    written = _append_realtime(
                        target_path,
                        args.tail,
                        args.seconds,
                        lambda n: c1.execute(
                            "UPDATE job SET committed_bytes=%s, last_input_at=now() WHERE id=%s",
                            (n, jid),
                        ),
                    )
                with open(target_path, "r+b") as f:
                    f.seek(0)
                    f.write(_wav_header(written, 36 + written))
                    f.flush()
                    os.fsync(f.fileno())
                with psycopg.connect(url, autocommit=True) as c2:
                    # 확정 경계와 봉인은 API가 한 TX에서 같이 쓴다 (설계 §3.4) — 여기서도
                    # 같이 써야 TailSource가 그 바이트까지 실제로 읽는다.
                    c2.execute(
                        "UPDATE job SET stop_requested_at=now(), committed_bytes=%s, "
                        "sealed_bytes=%s WHERE id=%s",
                        (written, written, jid),
                    )
                logging.info("tail writer sealed after %d bytes (%d ms)", written, written // 32)

            threading.Thread(target=_tail_writer, daemon=True).start()
        elif args.mic:
            source = MicSource()

            def _stop_later() -> None:
                time.sleep(args.seconds)
                with psycopg.connect(url, autocommit=True) as c2:
                    c2.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (jid,))
                logging.info("stop requested after %ss", args.seconds)

            threading.Thread(target=_stop_later, daemon=True).start()
        else:
            source = FileSource(args.file, realtime=True)

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
            state_box=state_box,
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
