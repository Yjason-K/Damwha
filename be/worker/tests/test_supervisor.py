import inspect
import sys
import threading
from types import SimpleNamespace

from damwha_worker import __main__ as m
from damwha_worker import db
from damwha_worker.__main__ import run_single_job, run_supervisor
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeEmbedder, FakeTextEmbedder


def _settings_stub(pg_url):
    class S:
        database_url = pg_url
        worker_id = "w1"
        heartbeat_interval_seconds = 30.0
        search_embedding_model = "fake-model"
        search_embedding_dim = 1024
        default_speaker_prefix = "Speaker"
        lens_llm_model = "qwen2.5:14b-instruct"

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
        # index_meeting never builds models
        build_models_fn=lambda payload, settings: None,
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
        # index_meeting never builds models
        build_models_fn=lambda payload, settings: None,
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


def test_supervisor_reconnects_on_peek_exception(conn, pg_url, monkeypatch):
    # 1회 peek 예외 → 재접속 → 다음 peek은 정상(빈 큐) → shutdown으로 정상 종료.
    peek_calls = {"count": 0}
    real_peek = db.peek_queued

    def _flaky_peek(c):
        peek_calls["count"] += 1
        if peek_calls["count"] == 1:
            raise RuntimeError("simulated db blip")
        return real_peek(c)

    monkeypatch.setattr(db, "peek_queued", _flaky_peek)

    connects = []

    def _connect_fn():
        c = db.connect(pg_url)
        connects.append(c)
        return c

    shutdown = threading.Event()
    monkeypatch.setattr(shutdown, "wait", lambda t: (shutdown.set(), True)[1])

    spawned = []
    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=_connect_fn,
        spawn_fn=lambda: spawned.append(1) or _StubProc(0),
        child_holder={"proc": None, "count": 0},
    )

    assert peek_calls["count"] == 2  # 예외 1회 + 재접속 후 정상 1회
    assert len(connects) == 2  # 최초 접속 + peek 예외 후 재접속
    assert spawned == []  # 크래시가 아니라 정상 종료: spawn 없음


def test_main_dispatches_once_flag_to_child():
    src = inspect.getsource(m.main)
    assert '"--once"' in src and "sys.argv" in src
    # argparse 금지(exit 2 흡수 계약)
    assert "argparse" not in src


def test_run_child_defers_model_registry_import_until_after_claim(monkeypatch, tmp_path):
    real_import = __import__
    sys.modules.pop("damwha_worker.models.registry", None)

    def _import(name, *args, **kwargs):
        if name.endswith("models.registry"):
            raise ModuleNotFoundError("missing models")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", _import)
    monkeypatch.setattr(m, "run_single_job", lambda *args, **kwargs: 3)
    settings = SimpleNamespace(
        storage_root=str(tmp_path),
        database_url="postgresql://unused",
        lens_llm_base_url="http://127.0.0.1:11434/v1",
        lens_llm_api_key=None,
        lens_llm_timeout_seconds=1,
    )

    assert m.run_child(settings, threading.Event()) == 3


def test_child_spawn_uses_sys_executable_and_new_session():
    src = inspect.getsource(m.run_supervisor_main)
    assert "sys.executable" in src
    assert "start_new_session=True" in src
    assert '"python"' not in src  # 리터럴 python 금지


def test_run_loop_removed():
    assert not hasattr(m, "run_loop")
