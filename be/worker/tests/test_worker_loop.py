import threading
from types import SimpleNamespace

from damwha_worker import db
from damwha_worker.__main__ import _reconnect, dispatch_claimed_job, handle_job, run_once
from damwha_worker.contracts import LensCandidate
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


def test_extract_routes_to_lens_client_only(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    utt = conn.execute(
        """INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,
                                  order_index,processing_version)
           VALUES (%s,'S0',0,1000,'extract this','ok',0,0) RETURNING id""",
        (mid,),
    ).fetchone()["id"]
    run_id = conn.execute(
        """INSERT INTO lens_extraction_run(meeting_id,processing_version,status,model)
           VALUES (%s,0,'queued','model') RETURNING id""",
        (mid,),
    ).fetchone()["id"]
    payload = {
        "schema_version": 1,
        "meeting_id": mid,
        "processing_version": 0,
        "extraction_run_id": run_id,
        "model": "model",
    }
    jid = seed_job(conn, type="extract_lenses", meeting_id=mid, payload=payload)
    conn.execute("UPDATE lens_extraction_run SET job_id=%s WHERE id=%s", (jid, run_id))
    job = db.claim(conn, "w1")
    calls = []

    class Client:
        def extract(self, *, model, utterances):
            calls.append(utterances)
            return [
                LensCandidate(
                    kind="action",
                    text="do it",
                    assignee_speaker_id=None,
                    due_at=None,
                    primary_utterance_id=utt,
                    supporting_utterance_ids=[],
                )
            ]

    assert (
        handle_job(
            conn,
            job,
            Storage(str(tmp_path)),
            "w1",
            build_lens_client=lambda: Client(),
            build_models=lambda: (_ for _ in ()).throw(AssertionError("must not build models")),
        )
        == "committed"
    )
    assert [row["id"] for row in calls[0]] == [utt]


def test_extract_terminal_llm_failure_after_version_advance_is_discarded(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        """INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,
                                  order_index,processing_version)
           VALUES (%s,'S0',0,1000,'extract this','ok',0,0)""",
        (mid,),
    )
    run_id = conn.execute(
        """INSERT INTO lens_extraction_run(meeting_id,processing_version,status,model)
           VALUES (%s,0,'queued','model') RETURNING id""",
        (mid,),
    ).fetchone()["id"]
    payload = {
        "schema_version": 1,
        "meeting_id": mid,
        "processing_version": 0,
        "extraction_run_id": run_id,
        "model": "model",
    }
    jid = seed_job(conn, type="extract_lenses", meeting_id=mid, payload=payload, max_attempts=1)
    conn.execute("UPDATE lens_extraction_run SET job_id=%s WHERE id=%s", (jid, run_id))
    job = db.claim(conn, "w1")

    class Client:
        def extract(self, *, model, utterances):
            conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (mid,))
            raise WorkerError("llm_invalid_response", "invalid", ErrorKind.PERMANENT)

    assert (
        handle_job(conn, job, Storage(str(tmp_path)), "w1", build_lens_client=lambda: Client())
        == "discarded"
    )
    job_row = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    run_row = conn.execute(
        "SELECT status, error FROM lens_extraction_run WHERE id=%s", (run_id,)
    ).fetchone()
    assert job_row["status"] == run_row["status"] == "done"
    assert job_row["error"]["code"] == run_row["error"]["code"] == "discarded_by_stale_guard"


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
        lens_llm_model="qwen2.5:14b-instruct",
        summary_llm_model="qwen2.5:14b-instruct",
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
        lens_llm_model="qwen-dispatch",
        summary_llm_model="qwen-dispatch",
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
    run = conn.execute(
        "SELECT model, job_id FROM lens_extraction_run WHERE meeting_id=%s", (mid,)
    ).fetchone()
    assert run["model"] == "qwen-dispatch"
    assert run["job_id"] is not None


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


def test_supervisor_connects_through_reconnect():
    import inspect

    from damwha_worker import __main__ as m

    src = inspect.getsource(m.run_supervisor)
    assert "_reconnect(connect_fn" in src
    src2 = inspect.getsource(m.run_supervisor_main)
    assert "connect_fn=lambda: db.connect" in src2


# --- LLM 서버 수명 배선 테스트 ---


class _SpyLlmServer:
    """llm_server(model) 팩토리 대역 — 어떤 모델로 몇 번 진입했는지 기록."""

    def __init__(self):
        self.models = []
        self.entered = 0
        self.exited = 0

    def __call__(self, model):
        self.models.append(model)
        return self

    def __enter__(self):
        self.entered += 1
        return None

    def __exit__(self, *exc):
        self.exited += 1
        return False


def test_extract_lenses_runs_inside_llm_server_for_the_payload_model(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        """INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,
                                  order_index,processing_version)
           VALUES (%s,'S0',0,1000,'extract this','ok',0,0)""",
        (mid,),
    )
    run_id = conn.execute(
        """INSERT INTO lens_extraction_run(meeting_id,processing_version,status,model)
           VALUES (%s,0,'queued','repo/lens-a') RETURNING id""",
        (mid,),
    ).fetchone()["id"]
    payload = {
        "schema_version": 1,
        "meeting_id": mid,
        "processing_version": 0,
        "extraction_run_id": run_id,
        "model": "repo/lens-a",
    }
    jid = seed_job(conn, type="extract_lenses", meeting_id=mid, payload=payload)
    conn.execute("UPDATE lens_extraction_run SET job_id=%s WHERE id=%s", (jid, run_id))
    job = db.claim(conn, "w1")
    spy = _SpyLlmServer()

    class Client:
        def extract(self, *, model, utterances):
            assert spy.entered == 1 and spy.exited == 0  # LLM 호출 시점엔 서버가 살아 있다
            return []

    handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_lens_client=lambda: Client(),
        llm_server=spy,
    )
    assert spy.models == ["repo/lens-a"]
    assert spy.entered == spy.exited == 1


def test_summarize_meeting_runs_inside_llm_server_for_the_payload_model(conn, tmp_path):
    from damwha_worker.contracts import SummaryResponse

    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        """INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,
                                  order_index,processing_version)
           VALUES (%s,'S0',0,1000,'summarize this','ok',0,0)""",
        (mid,),
    )
    payload = {
        "schema_version": 1,
        "meeting_id": mid,
        "processing_version": 0,
        "model": "repo/summary-b",
    }
    jid = seed_job(conn, type="summarize_meeting", meeting_id=mid, payload=payload)
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'repo/summary-b', 'queued')""",
        (mid, jid),
    )
    job = db.claim(conn, "w1")
    spy = _SpyLlmServer()

    class Client:
        def summarize(self, *, model, utterances):
            assert spy.entered == 1 and spy.exited == 0
            return SummaryResponse()

    handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_summary_client=lambda: Client(),
        llm_server=spy,
    )
    assert spy.models == ["repo/summary-b"]
    assert spy.entered == spy.exited == 1


def test_process_meeting_never_starts_the_llm_server(conn, tmp_path, monkeypatch):
    _stub_ffmpeg(monkeypatch)
    _enqueue_pm(conn)
    job = db.claim(conn, "w1")
    spy = _SpyLlmServer()

    handle_job(
        conn,
        job,
        Storage(str(tmp_path)),
        "w1",
        build_models=lambda: _models(),
        llm_server=spy,
    )
    assert spy.models == []
