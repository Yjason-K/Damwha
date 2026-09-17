"""`python -m damwha_worker.llm_entry` — run-id를 버리고 같은 프로세스에서 mlx_lm.server를 부른다.

`mlx_lm`은 models extra라 CI에는 없다. 그래서 `sys.modules`에 가짜 `mlx_lm.server`를 심어
`main()`이 그것을 **같은 프로세스에서** 부르는지, 부르는 순간 `sys.argv`가 무엇인지를 본다.
"""

import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

from damwha_worker import llm_entry

WORKER_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def fake_server(monkeypatch, capsys):
    """가짜 `mlx_lm.server`. `main()`이 불린 순간의 argv·pid·stderr를 기록한다."""
    seen = {}

    def server_main():
        seen["argv"] = list(sys.argv)
        seen["pid"] = os.getpid()
        seen["stderr_before"] = capsys.readouterr().err

    pkg = types.ModuleType("mlx_lm")
    pkg.__path__ = []
    server = types.ModuleType("mlx_lm.server")
    server.main = server_main
    pkg.server = server
    monkeypatch.setitem(sys.modules, "mlx_lm", pkg)
    monkeypatch.setitem(sys.modules, "mlx_lm.server", server)
    return seen


def _run(monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", list(argv))
    llm_entry.main()


def test_strips_run_id_and_keeps_the_rest(monkeypatch, fake_server):
    _run(
        monkeypatch,
        [
            "/b/llm_entry.py",
            "--run-id=abc-123",
            "--model",
            "m",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
    )

    assert fake_server["argv"] == [
        "/b/llm_entry.py",
        "--model",
        "m",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
    ]


def test_argv_without_run_id_is_passed_through_unchanged(monkeypatch, fake_server):
    argv = ["/b/llm_entry.py", "--model", "m", "--port", "8000"]

    _run(monkeypatch, argv)

    assert fake_server["argv"] == argv


def test_only_tokens_starting_with_run_id_prefix_are_removed(monkeypatch, fake_server):
    """`--run-id=`로 **시작하는** 토큰만 뺀다 — 값 안에 run-id가 들어 있어도 남는다."""
    _run(
        monkeypatch,
        ["/b/llm_entry.py", "--model", "org/run-id-model", "--run-id=", "--x=--run-id=y"],
    )

    assert fake_server["argv"] == [
        "/b/llm_entry.py",
        "--model",
        "org/run-id-model",
        "--x=--run-id=y",
    ]


def test_calls_server_main_in_this_process(monkeypatch, fake_server):
    """중간 프로세스가 없다 — exec 래퍼나 자식을 만들지 않는다 (스펙 §6.2)."""
    _run(monkeypatch, ["/b/llm_entry.py", "--run-id=r"])

    assert fake_server["pid"] == os.getpid()


def test_reports_runtime_to_stderr_before_server_main(monkeypatch, fake_server):
    """P4-C12 — 서버가 뜨고 나면 찍을 자리가 없으므로 `main()` 전에 stderr로 보고한다."""
    _run(monkeypatch, ["/b/llm_entry.py", "--run-id=r"])

    lines = [ln for ln in fake_server["stderr_before"].splitlines() if ln.startswith("runtime ")]
    assert len(lines) == 1
    facts = json.loads(lines[0][len("runtime ") :])
    assert facts["executable"] == sys.executable
    assert set(facts) == {"executable", "prefix", "version", "sys_path_head"}


def test_importing_the_module_does_not_import_mlx_lm():
    """빌드의 진입점 확인(find_spec, `-E -s -P`)과 테스트 스위트가 mlx를 끌어오지 않게."""
    code = "import sys, damwha_worker.llm_entry; print('mlx_lm' in sys.modules)"
    r = subprocess.run(
        [sys.executable, "-c", code],
        cwd=WORKER_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )

    assert r.stdout.strip() == "False"
