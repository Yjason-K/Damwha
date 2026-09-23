"""RUN_ID_PREFIX·run_id_arg·runtime_facts, and `--once` 자식으로의 run-id 전파.

계약(공통 컨텍스트의 Interfaces 절)을 그대로 쓴다 — 여기서 다시 정의하지 않는다.
"""

import sys

from damwha_worker import runtime_report
from damwha_worker.__main__ import _once_argv


def test_run_id_arg_reads_equals_form():
    assert runtime_report.run_id_arg(["-m", "damwha_worker", "--run-id=abc"]) == "abc"


def test_run_id_arg_missing_is_none():
    assert runtime_report.run_id_arg(["-m", "damwha_worker", "--once"]) is None


def test_run_id_arg_space_separated_form_is_not_ours():
    """`=` 없는 형식(`--run-id abc`, 공백 분리)은 우리가 인식하는 형태가 아니다."""
    assert runtime_report.run_id_arg(["--run-id", "abc"]) is None


def test_run_id_arg_empty_value_is_empty_string():
    """`--run-id=`(값 없이 프리픽스만)는 "달았지만 비웠다"로 읽어 빈 문자열을 돌려준다 —
    아예 달지 않은 경우(None)와 구분한다."""
    assert runtime_report.run_id_arg(["--run-id="]) == ""


def test_runtime_facts_matches_this_interpreter():
    facts = runtime_report.runtime_facts()
    assert facts["executable"] == sys.executable
    assert facts["prefix"] == sys.prefix
    assert facts["version"] == sys.version
    assert isinstance(facts["sys_path_head"], list)
    assert facts["sys_path_head"] == sys.path[:5]
    assert len(facts["sys_path_head"]) <= 5
    assert set(facts.keys()) == {"executable", "prefix", "version", "sys_path_head"}


def test_once_child_argv_carries_parents_run_id():
    argv = _once_argv("probe-1")
    assert argv[:4] == [sys.executable, "-m", "damwha_worker", "--once"]
    assert argv[-1] == f"{runtime_report.RUN_ID_PREFIX}probe-1"


def test_once_child_argv_without_run_id_has_no_run_id_flag():
    argv = _once_argv(None)
    assert not any(a.startswith(runtime_report.RUN_ID_PREFIX) for a in argv)
