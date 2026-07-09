import threading
from types import SimpleNamespace

from damwha_worker import db
from damwha_worker.__main__ import _reconnect, dispatch_claimed_job, handle_job, run_loop, run_once
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.base import DiarSegment, Word
from damwha_worker.pipeline.ffmpeg import ProbeResult
from damwha_worker.pipeline.process_meeting import Models
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting, seed_speaker
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
    out = run_once(conn, "w1", Storage(str(tmp_path)), build_models=_models)
    assert out == "committed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"


def test_run_once_empty_returns_none(conn, tmp_path):
    assert run_once(conn, "w1", Storage(str(tmp_path)), build_models=_models) is None


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
    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", build_models=lambda: boom)
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
    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", build_models=lambda: boom)
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


# --- NEW: build-failure tests ---


def _enqueue_index(conn, pv=0):
    mid = seed_meeting(conn, status="done", processing_version=pv)
    payload = {
        "schema_version": 1,
        "meeting_id": str(mid),
        "processing_version": pv,
        "search_embedding": {"model": "BAAI/bge-m3", "dimension": 1024},
    }
    jid = seed_job(conn, type="index_meeting", meeting_id=mid, payload=payload)
    return mid, jid


def _boom(exc):
    def _raise():
        raise exc

    return _raise


def test_index_build_failure_marks_job_only(conn, tmp_path):
    mid, jid = _enqueue_index(conn)
    job = db.claim(conn, "w1")
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_text_embedder=_boom(ModuleNotFoundError("no sentence_transformers")),
    )
    assert out == "failed"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    # 핵심: 색인 실패는 meeting을 건드리지 않는다
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "done"
    )


def test_process_build_failure_fails_meeting(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_models=_boom(ImportError("torch missing")),
    )
    assert out == "failed"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "failed"
    )


def test_process_build_transient_requeues_when_attempts_left(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")  # attempts=1, max=3
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_models=_boom(WorkerError("io_error", "x", ErrorKind.TRANSIENT)),
    )
    assert out == "requeued"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "queued"
    )


def test_enroll_build_failure_fails_speaker(conn, tmp_path):
    # 라우팅 목적지(enroll 빌드 실패 → speaker failed)를 고정한다. enroll은 전용
    # 빌더(build_embedder)로 라우팅되며, 그 빌드가 PERMANENT 예외면 즉시-fail 한다.
    sid = seed_speaker(conn, enrollment_status="pending")
    payload = {
        "schema_version": 1,
        "speaker_id": str(sid),
        "audio_key": "speakers/s/original.m4a",
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
    }
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None, payload=payload)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    job = db.claim(conn, "w1")
    out = handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_embedder=_boom(ModuleNotFoundError("speechbrain missing")),
    )
    assert out == "failed"
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "failed"
    )


# --- NEW: enroll routing tests (enroll 전용 빌더) ---


def _stub_enroll_ffmpeg(monkeypatch):
    import damwha_worker.pipeline.enroll_speaker as es

    monkeypatch.setattr(es.ffmpeg, "normalize", lambda s, d: None)
    monkeypatch.setattr(es.ffmpeg, "probe", lambda p: ProbeResult(3000))


def _enqueue_enroll(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    payload = {
        "schema_version": 1,
        "speaker_id": str(sid),
        "audio_key": "speakers/s/original.m4a",
        "embedding": {"model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192},
    }
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None, payload=payload)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    return sid, jid


def test_enroll_routes_to_build_embedder(conn, tmp_path, monkeypatch):
    # enroll은 build_models가 아닌 enroll 전용 빌더(build_embedder)로 라우팅된다.
    _stub_enroll_ffmpeg(monkeypatch)
    sid, jid = _enqueue_enroll(conn)
    job = db.claim(conn, "w1")
    emb_calls = []

    def _build_embedder():
        emb_calls.append("emb")
        return FakeEmbedder([[0.3] * 192])

    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", build_embedder=_build_embedder)
    assert out == "committed"
    assert emb_calls == ["emb"]  # enroll 빌더가 콜백 경유로 정확히 1회
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "ready"
    )


# --- NEW: dispatch_claimed_job wiring tests ---


class _SpyCM:
    def __init__(self):
        self.entered = False
        self.exited = False

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *exc):
        self.exited = True
        return False


def _settings_stub():
    return SimpleNamespace(
        worker_id="w1",
        search_embedding_model="BAAI/bge-m3",
        search_embedding_dim=1024,
        default_speaker_prefix="Speaker",
    )


def test_dispatch_process_builds_models_only_within_heartbeat(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    cm = _SpyCM()
    pm_calls, te_calls = [], []

    def fake_build_models_fn(payload, settings):
        assert cm.entered and not cm.exited  # heartbeat 진입 후, 종료 전
        pm_calls.append(payload["meeting_id"])
        return _models()

    def fake_build_text_embedder_fn(settings):
        te_calls.append("te")
        return None

    out = dispatch_claimed_job(
        conn,
        job,
        Storage(str(tmp_path)),
        _settings_stub(),
        build_models_fn=fake_build_models_fn,
        build_embedder_fn=lambda payload, s: None,
        build_text_embedder_fn=fake_build_text_embedder_fn,
        heartbeat_cm=cm,
    )
    assert out == "committed"
    assert pm_calls == [str(mid)]  # 모델 빌더가 콜백 경유로 정확히 1회
    assert te_calls == []  # process 경로에선 text embedder 빌드 안 함
    assert cm.entered and cm.exited


def test_dispatch_index_builds_text_embedder_only_within_heartbeat(conn, tmp_path):
    mid, jid = _enqueue_index(conn)
    job = db.claim(conn, "w1")
    cm = _SpyCM()
    pm_calls, te_calls = [], []

    def fake_build_models_fn(payload, settings):
        pm_calls.append("pm")
        return _models()

    def fake_build_text_embedder_fn(settings):
        assert cm.entered and not cm.exited
        te_calls.append("te")
        raise ModuleNotFoundError("no sentence_transformers")

    out = dispatch_claimed_job(
        conn,
        job,
        Storage(str(tmp_path)),
        _settings_stub(),
        build_models_fn=fake_build_models_fn,
        build_embedder_fn=lambda payload, s: None,
        build_text_embedder_fn=fake_build_text_embedder_fn,
        heartbeat_cm=cm,
    )
    assert out == "failed"
    assert te_calls == ["te"]  # 실패 경로의 text embedder 빌더 1회
    assert pm_calls == []  # index 경로에선 모델 빌드 안 함
    assert cm.entered and cm.exited
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "done"
    )


def test_dispatch_passes_prefix_through_to_persist(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)  # no seeded voiceprint → S0 unidentified → provisional
    job = db.claim(conn, "w1")
    settings = SimpleNamespace(
        worker_id="w1",
        search_embedding_model="BAAI/bge-m3",
        search_embedding_dim=1024,
        default_speaker_prefix="Zz",
    )
    out = dispatch_claimed_job(
        conn,
        job,
        Storage(str(tmp_path)),
        settings,
        build_models_fn=lambda payload, s: _models(),
        build_embedder_fn=lambda payload, s: None,
        build_text_embedder_fn=lambda s: None,
        heartbeat_cm=_SpyCM(),
    )
    assert out == "committed"
    names = [r["name"] for r in conn.execute("SELECT name FROM speaker", ()).fetchall()]
    assert names and all(n.startswith("Zz_") for n in names)


def test_dispatch_enroll_builds_embedder_not_models(conn, tmp_path, monkeypatch):
    # 회귀 방지: enroll은 build_models(payload["models"]) 경로를 절대 타지 않는다.
    # 과거엔 enroll이 build_models로 라우팅돼 payload에 없는 'models' 키를 읽어
    # KeyError → uncategorized → TRANSIENT → 재큐가 반복됐다(worker-bug.md 참조).
    _stub_enroll_ffmpeg(monkeypatch)
    sid, jid = _enqueue_enroll(conn)
    job = db.claim(conn, "w1")
    pm_calls, emb_calls = [], []

    def real_like_build_models_fn(payload, settings):
        pm_calls.append("pm")
        payload["models"]  # 실제 registry.build_models와 동일 — enroll payload엔 없음
        return _models()

    def build_embedder_fn(payload, settings):
        emb_calls.append(payload["embedding"]["model"])
        return FakeEmbedder([[0.3] * 192])

    out = dispatch_claimed_job(
        conn,
        job,
        Storage(str(tmp_path)),
        _settings_stub(),
        build_models_fn=real_like_build_models_fn,
        build_text_embedder_fn=lambda s: None,
        build_embedder_fn=build_embedder_fn,
        heartbeat_cm=_SpyCM(),
    )
    assert out == "committed"
    assert pm_calls == []  # KeyError를 유발하던 모델 빌더는 호출되지 않는다
    assert emb_calls == ["speechbrain/spkrec-ecapa-voxceleb"]  # enroll 빌더가 1회
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "ready"
    )


def test_shutdown_requeues_without_consuming_attempts(conn, tmp_path):
    # dispatch 직전 시그널: 모델 빌드조차 하지 않고 attempts 소모 없이 반납
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")  # attempts 0→1
    ev = threading.Event()
    ev.set()

    def _boom_models():
        raise AssertionError("must not build models during shutdown")

    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1", build_models=_boom_models, shutdown_event=ev
    )
    assert out == "requeued_shutdown"
    row = conn.execute("SELECT status, attempts, locked_by FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
    assert row["attempts"] == 0  # 미소모
    assert row["locked_by"] is None
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "uploaded"  # 아무 것도 건드리지 않음
    )


def test_shutdown_with_lost_ownership_returns_lost(conn, tmp_path):
    # shutdown 반납 시점에 이미 소유권을 잃었으면(reaper 회수 등) "lost"
    mid, jid = _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    conn.execute("UPDATE job SET locked_by='other' WHERE id=%s", (jid,))  # 소유권 상실 시뮬레이션
    ev = threading.Event()
    ev.set()
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1", build_models=_models, shutdown_event=ev
    )
    assert out == "lost"


class _BrokenConn:
    """execute 시 죽은 커넥션. run_loop에 fixture conn을 직접 주지 않기 위한 대역."""

    def execute(self, *a, **k):
        raise OSError("dead connection")

    def close(self):
        pass


def test_run_loop_exits_immediately_when_shutdown_set():
    # run_loop는 종료 시 자기 conn을 close하므로 fixture conn을 주면 안 된다
    shutdown = threading.Event()
    shutdown.set()
    run_loop(
        _BrokenConn(),
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=lambda: (_ for _ in ()).throw(AssertionError("must not connect")),
        dispatch_fn=lambda c, j: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )  # 반환하면 성공 (execute 미호출 — while 조건에서 즉시 탈출)


def test_run_loop_reconnects_and_requeues_inflight_on_dispatch_error(conn, pg_url):
    # dispatch 1회차 예외 → 재접속 + in-flight requeue → 2회차에 같은 job을 다시 claim.
    # 2회차 claim이 성공한다는 것 자체가 requeue가 동작했다는 증거다.
    mid, jid = _enqueue_pm(conn)
    shutdown = threading.Event()
    connects, calls = [], []

    def connect_fn():
        connects.append(1)
        return db.connect(pg_url)

    def dispatch_fn(c, job):
        calls.append(job["id"])
        if len(calls) == 1:
            raise OSError("db died mid-job")
        shutdown.set()
        return "committed"

    loop_conn = db.connect(pg_url)  # run_loop이 close하므로 fixture conn과 분리
    run_loop(
        loop_conn,
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=connect_fn,
        dispatch_fn=dispatch_fn,
    )
    assert calls == [jid, jid]  # 같은 job이 requeue 후 재claim됨
    assert connects == [1]  # 재접속 1회


def test_run_loop_leaves_exhausted_job_for_reaper(conn, pg_url):
    # attempts 소진된 job은 dispatch 예외 후 requeue하지 않는다 — running으로 남겨
    # reaper가 fail+전파. requeue했다면 결정적 오류를 무한 재claim했을 것이다.
    mid, jid = _enqueue_pm(conn)
    conn.execute("UPDATE job SET attempts=2, max_attempts=3 WHERE id=%s", (jid,))
    shutdown = threading.Event()
    calls = []

    def dispatch_fn(c, job):
        calls.append(job["id"])
        raise OSError("deterministic failure")

    threading.Timer(0.5, shutdown.set).start()  # requeue-생략 확인 후 루프 종료
    run_loop(
        db.connect(pg_url),
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        dispatch_fn=dispatch_fn,
    )
    assert calls == [jid]  # 재claim 없음 (claim 시 attempts 2→3 == max)
    row = conn.execute("SELECT status, locked_by FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "running" and row["locked_by"] == "w1"  # reaper 몫


def test_run_loop_survives_claim_error(conn, pg_url):
    # claim 시점에 커넥션이 죽어 있어도 재접속 후 계속
    mid, jid = _enqueue_pm(conn)
    shutdown = threading.Event()
    connects, calls = [], []

    def connect_fn():
        connects.append(1)
        return db.connect(pg_url)

    def dispatch_fn(c, job):
        calls.append(job["id"])
        shutdown.set()
        return "committed"

    run_loop(
        _BrokenConn(),
        SimpleNamespace(worker_id="w1", poll_interval_seconds=0.01),
        shutdown,
        connect_fn=connect_fn,
        dispatch_fn=dispatch_fn,
    )
    assert connects == [1]
    assert calls == [jid]  # 새 커넥션으로 claim + dispatch 성공


def test_reconnect_returns_connection_on_success():
    shutdown = threading.Event()
    sentinel = object()
    assert _reconnect(lambda: sentinel, shutdown) is sentinel


def test_reconnect_backoff_doubles_and_stops_on_shutdown(monkeypatch):
    shutdown = threading.Event()
    waits = []

    def rec_wait(t):
        waits.append(t)
        if len(waits) == 4:
            shutdown.set()
            return True
        return False

    monkeypatch.setattr(shutdown, "wait", rec_wait)

    def failing():
        raise OSError("down")

    assert _reconnect(failing, shutdown, initial_delay=1.0, max_delay=30.0) is None
    assert waits == [1.0, 2.0, 4.0, 8.0]


def test_main_wires_initial_connection_through_reconnect():
    # main()은 pragma: no cover — 초기 연결이 _reconnect 경유라는 배선(스펙 §2.1의 High
    # 리뷰 결함 수정)을 런타임으로 못 잡으므로 정적으로 고정한다.
    import inspect

    from damwha_worker.__main__ import main

    src = inspect.getsource(main)
    assert "_reconnect(lambda: db.connect" in src
    # 초기 연결용 direct 호출 금지: db.connect는 _reconnect/connect_fn 람다 안에만 존재
    for line in src.splitlines():
        if "db.connect" in line:
            assert "lambda" in line, f"main()에 직접 db.connect 호출: {line.strip()}"
