from damwha_worker import db
from damwha_worker.__main__ import handle_job, run_once
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.base import DiarSegment, Word
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.pipeline.process_meeting import Models
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def _models():
    return Models(
        FakeVAD([]),
        FakeDiarizer([DiarSegment("S0", 0, 1000)]),
        FakeEmbedder([[0.1] * 192]),
        FakeTranscriber([Word("hi", 0, 500, 0.9)]),
    )


def _enqueue_pm(conn, pv=0):
    mid = seed_meeting(
        conn, status="uploaded", processing_version=pv, audio_key="meetings/m/original.m4a"
    )
    payload = {
        "schema_version": 1,
        "meeting_id": str(mid),
        "audio_key": "meetings/m/original.m4a",
        "processing_version": pv,
        "reprocess": False,
        "models": {
            "whisper_model": "large-v3-turbo",
            "device": "cpu",
            "language": "ko",
            "diarization": {"model": "d", "min_speakers": None, "max_speakers": None},
            "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
        },
        "identify": {"threshold": 0.7},
    }
    jid = seed_job(conn, meeting_id=mid, payload=payload)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    return mid, jid


def test_run_once_processes_to_done(conn, tmp_path, monkeypatch):
    import damwha_worker.pipeline.process_meeting as pm

    monkeypatch.setattr(pm.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(pm.ffmpeg, "probe", lambda p: ProbeResult(1000))
    mid, jid = _enqueue_pm(conn)
    out = run_once(conn, "w1", _models(), Storage(str(tmp_path)))
    assert out == "committed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"


def test_run_once_empty_returns_none(conn, tmp_path):
    assert run_once(conn, "w1", _models(), Storage(str(tmp_path))) is None


def _stub_ffmpeg(monkeypatch):
    import damwha_worker.pipeline.process_meeting as pm

    monkeypatch.setattr(pm.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(pm.ffmpeg, "probe", lambda p: ProbeResult(1000))


def test_transient_error_requeues_when_attempts_left(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)  # 진짜 ffmpeg가 diarizer 전에 실패하지 않도록
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")  # attempts=1, max=3
    boom = _models()
    boom.diarizer = _RaisingDiarizer(WorkerError("io_error", "x", ErrorKind.TRANSIENT))
    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", models=boom)
    assert out == "requeued"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "queued"
    )


def test_permanent_error_fails(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    boom = _models()
    boom.diarizer = _RaisingDiarizer(WorkerError("corrupt_audio", "x", ErrorKind.PERMANENT))
    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", models=boom)
    assert out == "failed"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "failed"
    )


class _RaisingDiarizer:
    def __init__(self, exc):
        self._exc = exc

    def diarize(self, wav_path):
        raise self._exc
