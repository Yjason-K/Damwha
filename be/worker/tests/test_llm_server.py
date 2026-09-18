import inspect
import json
import os
import shutil
import stat
import subprocess
import sys

import pytest

from damwha_worker import llm_server as ls
from damwha_worker.config import READINESS_STALL_SECONDS, Settings
from damwha_worker.db import core
from damwha_worker.errors import ErrorKind, WorkerError

MODEL = "mlx-community/Qwen3.5-4B-8bit"
_REAL_WHICH = shutil.which
_SERVER_ARGS = [
    "--model",
    MODEL,
    "--chat-template-args",
    json.dumps({"enable_thinking": False}),
    "--host",
    "127.0.0.1",
    "--port",
    "8000",
]


def _settings(**overrides):
    base = {
        "_env_file": None,
        "database_url": "postgresql://x/y",
        "lens_llm_base_url": "http://127.0.0.1:8000/v1",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


class FakeProc:
    """Popen 대역. terminate/kill 호출과 종료 코드만 기록한다."""

    def __init__(self, exit_code=None):
        self._exit = exit_code
        self.terminated = False
        self.killed = False

    def poll(self):
        return self._exit

    def terminate(self):
        self.terminated = True
        self._exit = -15

    def kill(self):
        self.killed = True
        self._exit = -9

    def wait(self, timeout=None):
        if self._exit is None:
            raise subprocess.TimeoutExpired("mlx_lm.server", timeout)
        return self._exit


class FakeClock:
    """sleep이 곧 시간 경과인 가짜 시계 — 준비 대기 루프를 실시간 없이 돌린다."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def _probe_after(n_failures, models=(MODEL,)):
    """앞의 n번은 None(안 뜸), 그 뒤로는 모델 목록을 돌려주는 probe 대역.

    첫 호출은 '외부 서버가 이미 떠 있나'를 보는 사전 프로브다 — 워커가 직접 띄우는
    경로를 태우려면 최소 1회는 None이어야 한다.
    """
    calls = {"n": 0}

    def probe(_base_url, timeout_seconds=5.0):
        calls["n"] += 1
        return None if calls["n"] <= n_failures else list(models)

    probe.calls = calls
    return probe


@pytest.fixture(autouse=True)
def _which_found(monkeypatch):
    monkeypatch.setattr(ls.shutil, "which", lambda name: f"/usr/local/bin/{name}")


@pytest.fixture(autouse=True)
def _no_ambient_readiness_connection(monkeypatch):
    """`_wait_ready`의 연결은 **주입된 것**이어야 한다 (conftest의 훅 가드와 같은 규칙).

    기본은 "DB를 못 열었다" — 유예 연장만 없어지고 기다림은 그대로 돈다. 그 경로를 쓰는
    테스트는 이 이름을 자기 대역으로 다시 덮는다.
    """
    monkeypatch.setattr(ls, "_open_readiness_connection", lambda _settings: None)


class FakeReadinessConn:
    """`read_model_readiness`가 읽을 한 행을 내주는 연결 대역. 닫힘 여부를 기록한다."""

    def __init__(self, rows):
        self._rows = list(rows)
        self.reads = 0
        self.closed = False

    def execute(self, *_args, **_kwargs):
        value = self._rows[min(self.reads, len(self._rows) - 1)]
        self.reads += 1
        return _FetchOne({"value": value})

    def close(self):
        self.closed = True


class _FetchOne:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


def _downloading(writer, *, age_seconds=0.0, state="downloading"):
    """`model_readiness` 한 행 — `age_seconds`만큼 **오래된** updated_at을 단다."""
    stamp = core.readiness_now() if age_seconds == 0.0 else _aged(age_seconds)
    return {
        "updated_at": stamp,
        "entries": {
            MODEL: {
                "state": state,
                "bytes_done": 1,
                "bytes_total": 0,
                "writer": writer,
                "attempt": 1,
                "started_at": stamp,
                "updated_at": stamp,
                "error": None,
                "error_kind": None,
            }
        },
    }


def _aged(seconds):
    from datetime import UTC, datetime, timedelta

    return (datetime.now(UTC) - timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def test_managed_disabled_does_not_spawn():
    spawned = []

    with ls.managed_llm_server(
        MODEL,
        _settings(lens_llm_managed=False),
        popen=lambda *a, **kw: spawned.append(a) or FakeProc(),
        probe=lambda *a, **kw: None,
    ) as proc:
        assert proc is None
    assert spawned == []


def test_external_server_is_reused_and_not_killed():
    """이미 떠 있는 서버는 남의 것이다 — 재사용만 하고 죽이지 않는다."""
    spawned = []

    with ls.managed_llm_server(
        MODEL,
        _settings(),
        popen=lambda *a, **kw: spawned.append(a) or FakeProc(),
        probe=lambda *a, **kw: [MODEL],
    ) as proc:
        assert proc is None
    assert spawned == []


def _capture_argv(settings):
    """managed_llm_server가 popen에 넘긴 argv를 돌려준다(준비는 즉시 끝난다)."""
    captured = {}

    def popen(argv, **kwargs):
        captured["argv"] = argv
        return FakeProc()

    with ls.managed_llm_server(MODEL, settings, popen=popen, probe=_probe_after(1)):
        pass
    return captured["argv"]


def test_spawns_with_expected_argv_and_waits_for_readiness(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["/x/damwha_worker/__main__.py", "--once", "--run-id=rid-1"])
    captured = {}
    fake = FakeProc()
    clock = FakeClock()
    probe = _probe_after(2)

    def popen(argv, **kwargs):
        captured["argv"] = argv
        return fake

    with ls.managed_llm_server(
        MODEL,
        _settings(),
        popen=popen,
        probe=probe,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    ) as proc:
        assert proc is fake
        assert not fake.terminated  # 본문 동안에는 살아 있다

    assert captured["argv"] == [
        sys.executable,
        "-m",
        "damwha_worker.llm_entry",
        "--run-id=rid-1",
        *_SERVER_ARGS,
    ]
    assert probe.calls["n"] == 3  # 실패 2회 뒤 성공
    assert fake.terminated


def test_default_runs_the_bundled_module_entry_with_the_parents_run_id(monkeypatch):
    """기본값("")은 콘솔 스크립트가 아니라 `-m` 모듈 진입이다 — 셔뱅을 타지 않는다 (스펙 §6.2)."""
    monkeypatch.setattr(sys, "argv", ["/x/damwha_worker/__main__.py", "--once", "--run-id=abc"])
    # 기본 경로는 PATH를 보지 않는다 — which가 불리면 실패시킨다.
    monkeypatch.setattr(ls.shutil, "which", lambda name: pytest.fail(f"which({name!r}) called"))

    argv = _capture_argv(_settings())

    assert _settings().lens_llm_server_bin == ""
    assert argv[0] == sys.executable
    assert argv[1:3] == ["-m", "damwha_worker.llm_entry"]
    assert "--run-id=abc" in argv
    assert argv.index("--run-id=abc") == 3  # 모듈 바로 뒤 (스펙 §6.2)
    assert argv[4:] == _SERVER_ARGS


def test_default_without_parent_run_id_adds_no_run_id_token(monkeypatch):
    """부모가 run-id를 안 받았으면 지어내지 않는다 (`__main__._once_argv`와 같은 규칙)."""
    monkeypatch.setattr(sys, "argv", ["/x/damwha_worker/__main__.py", "--once"])

    argv = _capture_argv(_settings())

    assert argv == [sys.executable, "-m", "damwha_worker.llm_entry", *_SERVER_ARGS]
    assert not any(a.startswith("--run-id") for a in argv)


def _executable(path):
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_escape_hatch_runs_that_file_without_run_id(monkeypatch, tmp_path):
    """탈출구로 띄운 서버에는 소유 표식이 없다 — 앱이 소유를 증명할 수 없다 (스펙 §6.2)."""
    monkeypatch.setattr(ls.shutil, "which", _REAL_WHICH)
    monkeypatch.setattr(sys, "argv", ["/x/damwha_worker/__main__.py", "--once", "--run-id=abc"])
    server = _executable(tmp_path / "custom-llm-server")

    argv = _capture_argv(_settings(lens_llm_server_bin=str(server)))

    assert argv == [str(server), *_SERVER_ARGS]
    assert not any(a.startswith("--run-id") for a in argv)


def test_missing_escape_hatch_path_names_the_setting_not_uv_tool(monkeypatch, tmp_path):
    monkeypatch.setattr(ls.shutil, "which", _REAL_WHICH)
    missing = tmp_path / "no-such-server"
    assert not os.path.exists(missing)

    with pytest.raises(WorkerError) as exc:
        with ls.managed_llm_server(
            MODEL,
            _settings(lens_llm_server_bin=str(missing)),
            popen=lambda *a, **kw: pytest.fail("must not spawn"),
            probe=lambda *a, **kw: None,
        ):
            pass

    assert exc.value.code == ls.LLM_SERVER_START_FAILED
    assert exc.value.kind is ErrorKind.PERMANENT
    assert "LENS_LLM_SERVER_BIN" in exc.value.message
    assert "uv tool install" not in exc.value.message


def test_terminates_server_when_body_raises():
    fake = FakeProc()

    with pytest.raises(ValueError):
        with ls.managed_llm_server(
            MODEL,
            _settings(),
            popen=lambda *a, **kw: fake,
            probe=_probe_after(1),
        ):
            raise ValueError("job failed")

    assert fake.terminated


def test_kills_server_that_ignores_sigterm():
    fake = FakeProc()
    fake.terminate = lambda: None  # SIGTERM 무시 — wait가 계속 TimeoutExpired

    with ls.managed_llm_server(
        MODEL, _settings(), popen=lambda *a, **kw: fake, probe=_probe_after(1)
    ):
        pass

    assert fake.killed


def test_missing_binary_is_permanent(monkeypatch):
    # 기본 경로(모듈 진입)에는 찾을 바이너리가 없다 — 없을 수 있는 것은 탈출구 값뿐이다.
    monkeypatch.setattr(ls.shutil, "which", lambda name: None)

    with pytest.raises(WorkerError) as exc:
        with ls.managed_llm_server(
            MODEL,
            _settings(lens_llm_server_bin="mlx_lm.server"),
            popen=lambda *a, **kw: FakeProc(),
            probe=lambda *a, **kw: None,
        ):
            pass

    assert exc.value.code == ls.LLM_SERVER_START_FAILED
    assert exc.value.kind is ErrorKind.PERMANENT


def test_readiness_timeout_is_transient_and_stops_server():
    fake = FakeProc()
    clock = FakeClock()

    with pytest.raises(WorkerError) as exc:
        with ls.managed_llm_server(
            MODEL,
            _settings(lens_llm_server_start_timeout_seconds=3.0),
            popen=lambda *a, **kw: fake,
            probe=lambda *a, **kw: None,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        ):
            pass

    assert exc.value.code == ls.LLM_SERVER_START_FAILED
    assert exc.value.kind is ErrorKind.TRANSIENT
    assert fake.terminated


def test_server_exiting_early_is_transient():
    """서버가 준비되기 전에 죽으면 그 자리에서 실패한다 — 타임아웃까지 기다리지 않는다."""
    fake = FakeProc(exit_code=1)
    clock = FakeClock()

    with pytest.raises(WorkerError) as exc:
        with ls.managed_llm_server(
            MODEL,
            _settings(),
            popen=lambda *a, **kw: fake,
            probe=lambda *a, **kw: None,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        ):
            pass

    assert exc.value.code == ls.LLM_SERVER_START_FAILED
    assert exc.value.kind is ErrorKind.TRANSIENT
    assert "1" in exc.value.message
    assert clock.now == 0.0  # 대기 없이 즉시


def test_base_url_without_port_is_permanent():
    with pytest.raises(WorkerError) as exc:
        with ls.managed_llm_server(
            MODEL,
            _settings(lens_llm_base_url="http://localhost/v1"),
            popen=lambda *a, **kw: FakeProc(),
            probe=lambda *a, **kw: None,
        ):
            pass

    assert exc.value.code == ls.LLM_SERVER_START_FAILED
    assert exc.value.kind is ErrorKind.PERMANENT


# ── 준비 유예와 model_readiness (Task 10, 스펙 §6.9) ──────────────────────
#
# `_wait_ready`는 `--once` 자식의 코드이고 `llm_entry`는 그것이 popen한 **자식**이다. 진행 보고는
# 그 자식이 DB에 올리므로, 여기서 유예를 밀려면 DB를 읽어야 한다.


def _wait_with(settings, probe, conn_factory, clock=None):
    """managed_llm_server를 태워 `_wait_ready`를 돌린다. 연결 팩토리는 주입한다."""
    clock = clock or FakeClock()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(ls, "_open_readiness_connection", conn_factory)
        with ls.managed_llm_server(
            MODEL,
            settings,
            popen=lambda *a, **kw: FakeProc(),
            probe=probe,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        ):
            pass
    return clock


def test_wait_ready_does_not_spend_grace_while_this_writer_downloads():
    """진행이 갱신되는 동안에는 600초 예산을 쓰지 않는다 — 멈춘 뒤에야 쓰기 시작한다."""
    clock = FakeClock()
    fresh = [_downloading("worker-1") for _ in range(20)]
    stalled = _downloading("worker-1", age_seconds=READINESS_STALL_SECONDS + 10)
    conn = FakeReadinessConn([*fresh, stalled])

    with pytest.raises(WorkerError) as exc:
        _wait_with(
            _settings(lens_llm_server_start_timeout_seconds=3.0),
            lambda *a, **kw: None,
            lambda _s: conn,
            clock,
        )

    assert exc.value.kind is ErrorKind.TRANSIENT
    # 예산은 3초인데 12.5초를 기다렸다 — 앞의 10초는 다운로드가 진행 중이라 소모되지 않았다.
    assert clock.now == pytest.approx(12.5)
    assert conn.reads > 20
    assert conn.closed


def test_wait_ready_ignores_another_writers_download():
    """embed가 모델을 받는 동안 LLM의 시계가 멈추면 안 된다 (스펙 §6.9의 writer 구별)."""
    clock = FakeClock()
    # 20번째 읽기부터 멈춘 것으로 바뀐다 — writer 구별이 무너져도 이 테스트가 **빨리** 실패하게.
    fresh = [_downloading("embed") for _ in range(20)]
    stale = _downloading("embed", age_seconds=READINESS_STALL_SECONDS + 10)
    conn = FakeReadinessConn([*fresh, stale])

    with pytest.raises(WorkerError) as exc:
        _wait_with(
            _settings(lens_llm_server_start_timeout_seconds=3.0),
            lambda *a, **kw: None,
            lambda _s: conn,
            clock,
        )

    assert exc.value.kind is ErrorKind.TRANSIENT
    assert clock.now == pytest.approx(3.0)
    assert conn.closed


def test_wait_ready_proceeds_when_the_database_cannot_be_opened():
    """DB를 못 열어도 기다림은 진행한다 — 유예 연장만 없고, 그것이 실패의 사유가 되지 않는다."""
    clock = FakeClock()
    opens = {"n": 0}

    def _refuse(_settings_):
        opens["n"] += 1
        raise RuntimeError("connection refused")

    with pytest.raises(WorkerError) as exc:
        _wait_with(
            _settings(lens_llm_server_start_timeout_seconds=3.0),
            lambda *a, **kw: None,
            _refuse,
            clock,
        )

    assert exc.value.kind is ErrorKind.TRANSIENT
    assert "3.0" in exc.value.message  # 평소의 타임아웃 문구 그대로
    assert clock.now == pytest.approx(3.0)
    assert opens["n"] == 1  # 폴링마다 다시 열지 않는다


def test_wait_ready_survives_a_read_that_raises():
    clock = FakeClock()

    class Broken:
        closed = False

        def execute(self, *a, **kw):
            raise RuntimeError("server closed the connection unexpectedly")

        def close(self):
            self.closed = True

    broken = Broken()
    with pytest.raises(WorkerError):
        _wait_with(
            _settings(lens_llm_server_start_timeout_seconds=3.0),
            lambda *a, **kw: None,
            lambda _s: broken,
            clock,
        )

    assert clock.now == pytest.approx(3.0)
    assert broken.closed


def test_wait_ready_closes_its_connection_when_the_server_comes_up():
    conn = FakeReadinessConn([_downloading("worker-1")])
    _wait_with(_settings(), _probe_after(2), lambda _s: conn)
    assert conn.closed


def test_wait_ready_does_not_read_in_external_database_mode(monkeypatch):
    """`DAMWHA_SHARED_STATE=off`면 앱이 소유하지 않은 DB다 — 읽지도 않는다 (스펙 §6.9)."""
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")
    clock = FakeClock()

    def _must_not_open(_settings_):
        raise AssertionError("_wait_ready opened a connection in external-DB mode")

    with pytest.raises(WorkerError):
        _wait_with(
            _settings(lens_llm_server_start_timeout_seconds=3.0),
            lambda *a, **kw: None,
            _must_not_open,
            clock,
        )

    assert clock.now == pytest.approx(3.0)


def test_the_two_public_signatures_do_not_change():
    """계약 절이 못 박은 것 — Task 10은 본문만 고친다."""
    assert list(inspect.signature(ls.managed_llm_server).parameters) == [
        "model",
        "settings",
        "popen",
        "probe",
        "monotonic",
        "sleep",
    ]
    assert list(inspect.signature(ls._wait_ready).parameters) == [
        "proc",
        "model",
        "settings",
        "probe",
        "monotonic",
        "sleep",
    ]


def test_the_supervisor_judgment_fires_after_the_worker_watchdog():
    """Task 9b의 무진행 90초가 이 판정 120초보다 **먼저** 끝난다.

    같은 다운로드를 양쪽이 두 번 죽이지 않게 하는 관계다 (config.py의 두 상수 주석).
    """
    from damwha_worker.config import HF_STALL_SECONDS

    assert READINESS_STALL_SECONDS == 120.0
    assert HF_STALL_SECONDS < READINESS_STALL_SECONDS
