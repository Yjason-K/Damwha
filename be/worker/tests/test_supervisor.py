import inspect
import logging
import os
import signal
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
        summary_llm_model = "qwen2.5:14b-instruct"
        hf_token = None
        meeting_timezone = "Asia/Seoul"
        live_max_minutes = 240.0

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
    # 다운로드 훅(Task 9)은 이 프로세스의 huggingface_hub를 전역으로 바꾼다 — 기록만 한다.
    monkeypatch.setattr(m.downloads, "install_hf_progress_hook", lambda writer: None)
    settings = SimpleNamespace(
        worker_id="worker-1",
        storage_root=str(tmp_path),
        database_url="postgresql://unused",
        lens_llm_base_url="http://127.0.0.1:11434/v1",
        lens_llm_api_key=None,
        lens_llm_timeout_seconds=1,
    )

    assert m.run_child(settings, threading.Event()) == 3


def test_child_spawn_uses_sys_executable_and_new_session():
    # Task 2: --run-id 전파를 위해 자식 argv 조립이 `_once_argv`로 빠졌다 — 스폰 자체
    # (start_new_session=True)는 여전히 run_supervisor_main 안이다.
    argv_src = inspect.getsource(m._once_argv)
    assert "sys.executable" in argv_src
    assert '"python"' not in argv_src  # 리터럴 python 금지
    main_src = inspect.getsource(m.run_supervisor_main)
    assert "start_new_session=True" in main_src


def test_run_loop_removed():
    assert not hasattr(m, "run_loop")


def test_supervisor_logs_ready_after_db_connect(conn, pg_url, caplog):
    # 기존 `supervisor <id> started`는 run_supervisor 호출 **전**에 찍히므로
    # (__main__.py:296 → :298 → :107) 준비 신호로 쓸 수 없다. DB에 실제로 붙은 뒤
    # 찍히는 줄이 데스크톱 앱의 준비 계약이다.
    caplog.set_level(logging.INFO, logger="damwha_worker")
    shutdown = threading.Event()
    t = threading.Timer(0.05, shutdown.set)
    t.start()
    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(0),
        child_holder={"proc": None, "count": 0},
    )
    t.cancel()
    # r.message는 caplog 핸들러가 이미 substitute한 최종 문자열이라 다시 %-format하면
    # (브리핑 원안이 그랬다) 인자가 남아 TypeError가 난다 — getMessage()로 재확인한다.
    assert any("ready (db connected)" in r.getMessage() for r in caplog.records)


def test_supervisor_logs_ready_again_after_reconnect(conn, pg_url, monkeypatch, caplog):
    # 한 번만 찍으면 ready는 판정되지만 degraded에서 ok로 돌아온 것을 관찰할 수 없다
    # (스펙 §6.6). peek 예외 → 재접속 경로에서도 같은 줄이 나와야 한다.
    caplog.set_level(logging.INFO, logger="damwha_worker")
    peek_calls = {"count": 0}
    real_peek = db.peek_queued

    def _flaky_peek(c):
        peek_calls["count"] += 1
        if peek_calls["count"] == 1:
            raise RuntimeError("simulated db blip")
        return real_peek(c)

    monkeypatch.setattr(db, "peek_queued", _flaky_peek)

    shutdown = threading.Event()
    monkeypatch.setattr(shutdown, "wait", lambda t: (shutdown.set(), True)[1])

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(0),
        child_holder={"proc": None, "count": 0},
    )

    ready_lines = [r for r in caplog.records if "ready (db connected)" in r.getMessage()]
    assert len(ready_lines) == 2  # 최초 접속 + peek 예외 후 재접속


# ── P4-C20: 2차 신호는 자식의 **그룹**을 죽인다 ──────────────────────────────


class _KillSpy:
    """`--once` 자식 대역. 자기 자신이 kill됐는지만 기록한다."""

    def __init__(self, pid: int, returncode=None):
        self.pid = pid
        self.returncode = returncode
        self.killed = False
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def test_second_signal_kills_the_childs_process_group_not_just_the_child():
    # P4-C20 실측: 2차 신호가 `proc.kill()`이면 자식이 SIGKILL로 즉사해
    # `managed_llm_server`의 `finally: _stop(proc)`가 **안 돈다** → 그 자식이 띄운 LLM
    # 서버가 pid 1로 재부모화돼 남는다. 자식은 `start_new_session=True`라 세션·그룹
    # 리더(pgid == pid)이고 LLM 서버는 같은 그룹에 있으므로, 그룹째 죽이면 한 번에 거둬진다.
    calls = []
    proc = _KillSpy(4242)
    m._kill_child_group(proc, killpg=lambda pgid, sig: calls.append((pgid, sig)))
    assert calls == [(4242, signal.SIGKILL)]
    # 그룹이 자식을 포함하므로 자식만 따로 때릴 이유가 없다.
    assert proc.killed is False


def test_kill_child_group_falls_back_to_the_child_when_the_group_is_gone():
    # 그룹이 이미 비었거나(ESRCH) 권한이 없으면 자식만이라도 반드시 죽인다 —
    # 여기서 예외가 새면 신호 핸들러가 터지고 supervisor가 `os._exit`에 못 간다.
    proc = _KillSpy(4242)

    def _boom(pgid, sig):
        raise ProcessLookupError

    m._kill_child_group(proc, killpg=_boom)
    assert proc.killed is True


def test_kill_child_group_skips_a_child_that_is_already_reaped():
    # `proc.kill()`은 `Popen.send_signal`을 거치고 그 안에 pid 재사용 가드가 있다(bpo-38630).
    # `os.killpg`는 그것을 우회하므로 여기서 직접 세운다 — 자식이 거둬진 뒤 그 번호는
    # 재배정될 수 있고, `run_supervisor`가 자식을 거두는 자리와 `child_holder`를 비우는
    # 자리 사이의 창에 신호가 들어오면 남의 그룹을 때린다.
    calls = []
    proc = _KillSpy(4242, returncode=0)
    m._kill_child_group(proc, killpg=lambda pgid, sig: calls.append((pgid, sig)))
    assert calls == []
    assert proc.killed is False


def test_kill_child_group_defaults_to_killpg_not_kill():
    # 기본 인자를 `os.kill`로 바꾸면 P4-C20의 원래 결함(자식만 SIGKILL → LLM 서버 고아)이
    # 그대로 되살아나는데, 위 테스트들은 전부 `killpg`를 주입하거나 소스 텍스트를 읽어서
    # 초록불인 채로 남는다. 기본 결선 자체를 잠근다.
    assert inspect.signature(m._kill_child_group).parameters["killpg"].default is os.killpg


def test_supervisor_second_signal_is_wired_to_the_group_kill():
    # 핸들러는 `run_supervisor_main` 안의 클로저라 직접 호출할 이음매가 없다.
    # 배선이 끊기면 위 두 테스트가 초록불인 채로 고아가 되살아난다.
    src = inspect.getsource(m.run_supervisor_main)
    assert "_kill_child_group(proc)" in src
    assert "proc.kill()" not in src


# ── P4-C7: stall-kill 뒤 `--once` 자식이 반드시 끝난다 ──────────────────────


def test_hard_exit_flushes_then_exits_without_finalizing():
    # P4-C7 실측(2026-09-19): 무진행 90초로 다운로드를 끊은 `--once` 자식이 job을 재큐까지
    # 끝내 놓고 **죽지 않았다**. 메인 스레드 스택이 `Py_FinalizeEx → wait_for_thread_shutdown
    # → threading._shutdown() → Thread.join()`에서 영구 대기였다 — `_run_watched`가 버린
    # 다운로드는 파이썬 스레드로는 daemon이지만 `hf_xet`이 남긴 네이티브 스레드 8개와
    # non-daemon 파이썬 스레드가 finalize를 붙잡는다. 감독자는 `os_waitpid`에서 안 돌아와
    # 다시 peek하지 않았고, 재큐된 job을 **아무도 집지 않았다**(11분 관측, 자식을 kill -9
    # 하자 8초 만에 재claim). 한 건만 처리하고 끝나는 프로세스라 finalize에 걸 것이 없다.
    order = []
    m._hard_exit(
        3,
        flush_fn=lambda: order.append("flush"),
        exit_fn=lambda c: order.append(f"exit{c}"),
    )
    # flush가 먼저다 — os._exit는 atexit도 버퍼도 비우지 않는다.
    assert order == ["flush", "exit3"]


def test_hard_exit_still_exits_when_flushing_raises():
    # 닫힌 stderr로 flush가 터져도 프로세스는 반드시 끝나야 한다 — 여기서 예외가 새면
    # 고치려던 그 멈춤이 그대로 돌아온다.
    order = []

    def _boom():
        raise ValueError("closed")

    m._hard_exit(1, flush_fn=_boom, exit_fn=lambda c: order.append(f"exit{c}"))
    assert order == ["exit1"]


def test_once_child_path_is_wired_to_hard_exit():
    # `main()`은 pragma: no cover라 직접 부를 수 없다. 배선이 끊기면 위 두 테스트가
    # 초록불인 채로 워커가 다시 통째로 멈춘다.
    src = inspect.getsource(m.main)
    assert "_hard_exit(run_child(" in src
    assert "sys.exit(run_child(" not in src


def _seed_own_orphan(conn):
    """이 워커(`w1`) 신분으로 잠긴 채 남은 `running` 행 — 죽은 `--once` 자식이 쥐던 것."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="w1",
        attempts=1,
        max_attempts=5,
        locked_minutes_ago=0,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    return jid


def test_supervisor_reclaims_its_own_running_job_after_reconnect(conn, pg_url, monkeypatch):
    """DB가 죽으면 자식도 함께 죽는다 — 부모는 재접속 직후 자기 고아를 되돌려야 한다.

    이게 없으면 그 행은 30분 reaper까지 `running`으로 얼어 있고 화면은 "처리하고 있어요"를
    계속 말한다 (Phase 5 결과 §5, P5-C8).
    """
    jid = _seed_own_orphan(conn)

    peek_calls = {"count": 0}
    real_peek = db.peek_queued

    def _flaky_peek(c):
        peek_calls["count"] += 1
        if peek_calls["count"] == 1:
            raise RuntimeError("simulated db blip")
        return real_peek(c)

    monkeypatch.setattr(db, "peek_queued", _flaky_peek)

    shutdown = threading.Event()
    monkeypatch.setattr(shutdown, "wait", lambda t: (shutdown.set(), True)[1])

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: (shutdown.set(), _StubProc(3))[1],
        child_holder={"proc": None, "count": 0},
    )

    row = conn.execute("SELECT status, locked_by FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None


def test_supervisor_reclaims_its_own_running_job_after_a_child_crash(conn, pg_url, monkeypatch):
    """DB가 멀쩡한데 자식만 죽은 경우(OOM·SIGKILL)도 같은 구멍이다."""
    jid = _seed_own_orphan(conn)
    # 큐에 한 건 있어야 부모가 자식을 띄운다.
    mid = seed_meeting(conn, status="done", processing_version=0)
    seed_job(conn, type="index_meeting", meeting_id=mid, payload={"schema_version": 1})

    shutdown = threading.Event()
    monkeypatch.setattr(shutdown, "wait", lambda t: (shutdown.set(), True)[1])

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: _StubProc(1),  # 크래시
        child_holder={"proc": None, "count": 0},
    )

    row = conn.execute("SELECT status, locked_by FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None


def test_supervisor_cleans_stale_incomplete_after_each_child(conn, pg_url, monkeypatch):
    from damwha_worker import __main__ as main_mod

    calls = []
    monkeypatch.setattr(main_mod.cache_scan, "clean_stale_incomplete",
                        lambda root, age, **_: calls.append((root, age)) or 0)

    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
        (mid, '{"schema_version": 1}'),
    )
    shutdown = threading.Event()

    def _spawn():
        # 첫 spawn 후 shutdown → 루프 1회로 종료 (기존 spawn_when_job_queued와 같은 방식)
        shutdown.set()
        return _StubProc(0)

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=_spawn,
        child_holder={"proc": None, "count": 0},
    )
    assert len(calls) >= 2  # 시작 1회 + 자식 종료 뒤 1회


def test_supervisor_reclaims_its_own_running_job_at_startup(conn, pg_url, monkeypatch):
    """supervisor만 재시작한 경우 — 앱은 앞 supervisor의 `--once` 자식을 **죽이지만**
    그 행은 같은 `WORKER_ID`로 잠긴 채 남는다(신분은 앱 실행 단위라 supervisor 재시작으로
    바뀌지 않는다). 새 supervisor가 붙는 순간 자기 자식은 아직 하나도 없으므로 그 행은 고아다.
    """
    jid = _seed_own_orphan(conn)

    shutdown = threading.Event()
    monkeypatch.setattr(shutdown, "wait", lambda t: (shutdown.set(), True)[1])

    run_supervisor(
        _peek_settings(),
        shutdown,
        connect_fn=lambda: db.connect(pg_url),
        spawn_fn=lambda: (shutdown.set(), _StubProc(3))[1],
        child_holder={"proc": None, "count": 0},
    )

    row = conn.execute("SELECT status, locked_by FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None
