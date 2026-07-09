import threading

from damwha_worker import db
from damwha_worker.__main__ import run_single_job, run_supervisor
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


class _StubProc:
    def __init__(self, code):
        self._code = code
        self.returncode = None
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        self.returncode = self._code
        return self._code

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def _peek_settings():
    class S:
        worker_id = "w1"
        poll_interval_seconds = 0.01

    return S()


def test_supervisor_spawns_child_when_job_queued(conn, pg_url, monkeypatch):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        (mid, '{"schema_version": 1}'),
    )
    shutdown = threading.Event()
    spawns = []

    def _spawn():
        # 첫 spawn 후 shutdown → 루프 1회로 종료
        shutdown.set()
        p = _StubProc(0)
        spawns.append(p)
        return p

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=_spawn,
        child_holder={"proc": None, "count": 0},
    )
    assert len(spawns) == 1


def test_supervisor_no_spawn_when_queue_empty(conn, pg_url):
    shutdown = threading.Event()
    spawns = []

    # peek False → sleep(poll) → shutdown로 종료. 별도 스레드로 shutdown 트리거.
    def _delayed_shutdown():
        shutdown.set()

    t = threading.Timer(0.05, _delayed_shutdown)
    t.start()
    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: spawns.append(_StubProc(0)) or spawns[-1],
        child_holder={"proc": None, "count": 0},
    )
    t.cancel()
    assert spawns == []


def test_supervisor_backoff_on_crash(conn, pg_url, monkeypatch):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        (mid, '{"schema_version": 1}'),
    )
    shutdown = threading.Event()
    waits = []
    monkeypatch.setattr(
        shutdown, "wait", lambda t: (waits.append(t), shutdown.set(), False)[2] or shutdown.is_set()
    )

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(1),  # 크래시
        child_holder={"proc": None, "count": 0},
    )
    assert waits and waits[0] >= 0.01  # 크래시 후 backoff sleep 발생
