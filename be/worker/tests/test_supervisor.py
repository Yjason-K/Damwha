import threading

from damwha_worker import db
from damwha_worker.__main__ import run_single_job
from damwha_worker.pipeline.process_meeting import Models
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import (
    FakeDiarizer,
    FakeEmbedder,
    FakeTextEmbedder,
    FakeTranscriber,
    FakeVAD,
)


def _models():
    return Models(
        vad=FakeVAD(),
        diarizer=FakeDiarizer(),
        embedder=FakeEmbedder(),
        transcriber=FakeTranscriber(),
    )


def _settings_stub(pg_url):
    class S:
        database_url = pg_url
        worker_id = "w1"
        heartbeat_interval_seconds = 30.0
        search_embedding_model = "fake-model"
        search_embedding_dim = 1024
        default_speaker_prefix = "Speaker"

    return S()


def _enqueue_index(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    payload = {
        "schema_version": 1,
        "meeting_id": mid,
        "processing_version": 0,
        "search_embedding": {"model": "fake-model", "dimension": 1024},
    }
    return seed_job(conn, type="index_meeting", meeting_id=mid, payload=payload)


def test_run_single_job_no_job_returns_3(conn, pg_url, tmp_path):
    shutdown = threading.Event()
    code = run_single_job(
        _settings_stub(pg_url),
        Storage(str(tmp_path)),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        build_models_fn=lambda payload, settings: _models(),
        build_embedder_fn=lambda payload, settings: FakeEmbedder(),
        build_text_embedder_fn=lambda settings: FakeTextEmbedder(),
    )
    assert code == 3


def test_run_single_job_processes_and_returns_0(conn, pg_url, tmp_path):
    jid = _enqueue_index(conn)
    shutdown = threading.Event()
    code = run_single_job(
        _settings_stub(pg_url),
        Storage(str(tmp_path)),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        build_models_fn=lambda payload, settings: _models(),
        build_embedder_fn=lambda payload, settings: FakeEmbedder(),
        build_text_embedder_fn=lambda settings: FakeTextEmbedder(),
    )
    assert code == 0
    row = conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "done"
