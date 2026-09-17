import json
import os
import shutil
import stat
import subprocess
import sys

import pytest

from damwha_worker import llm_server as ls
from damwha_worker.config import Settings
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
