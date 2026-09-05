from damwha_worker import db
from damwha_worker.__main__ import handle_job
from damwha_worker.audio.source import FileSource
from damwha_worker.errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError
from damwha_worker.models.base import Word
from damwha_worker.pipeline.live_session import LiveModels
from damwha_worker.storage import Storage
from tests.audio_fixtures import make_wav
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeEmbedder, FakeStreamingVAD, FakeTranscriber, RaisingSource


def _live_payload(mid):
    return {
        "schema_version": 1,
        "meeting_id": str(mid),
        "audio_key": f"meetings/{mid}/original.wav",
        "source": "mic",
        "process": {
            "schema_version": 5,
            "meeting_id": str(mid),
            "audio_key": f"meetings/{mid}/original.wav",
            "processing_version": 0,
            "reprocess": False,
            "models": {
                "whisper_model": "large-v3-turbo",
                "language": "ko",
                "devices": {"diarization": "cpu", "stt": "cpu"},
                "preset": "standard",
                "preset_revision": None,
                "summary_model": "mlx-community/Qwen3.5-4B-8bit",
                "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
                "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
            },
            "identify": {"threshold": 0.8, "suggest_threshold": 0.6},
            "followups": {"lens": True, "summary": True},
        },
    }


def _claimed(conn, mid):
    jid = seed_job(
        conn, type="live_session", meeting_id=mid, payload=_live_payload(mid), max_attempts=1
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _models():
    return LiveModels(
        transcriber=FakeTranscriber([Word("안녕", 0, 300, 0.9)]),
        embedder=FakeEmbedder([None]),
        vad=FakeStreamingVAD({2: [("start", 0)], 30: [("end", 0)]}),
    )


def test_dispatches_live_session_and_queues_the_final_pass(conn, tmp_path):
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    src = FileSource(make_wav(str(tmp_path / "in.wav"), 64))
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda: src,
    )
    assert out == "committed"
    m = conn.execute("SELECT status, current_job_id FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "uploaded"
    assert (
        conn.execute("SELECT type FROM job WHERE id=%s", (m["current_job_id"],)).fetchone()["type"]
        == "process_meeting"
    )


def test_live_failure_never_requeues_even_when_transient(conn, tmp_path):
    mid = seed_meeting(conn, status="recording")
    job = _claimed(conn, mid)
    src = RaisingSource(WorkerError(AUDIO_DEVICE_FAILED, "no mic", ErrorKind.TRANSIENT))
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_live_models=_models,
        build_live_source=lambda: src,
    )
    assert out == "failed"
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (job["id"],)).fetchone()
    assert j["status"] == "failed" and j["error"]["code"] == AUDIO_DEVICE_FAILED
    m = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert m["status"] == "failed" and m["error"]["code"] == AUDIO_DEVICE_FAILED
