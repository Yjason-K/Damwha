"""timed_stage의 진행 중(in-flight) tick 로그 — 긴 stage에서 콘솔 무음을 막는다."""

import time

from damwha_worker.pipeline.timing import timed_stage

CTX = "job=j1 meeting=m1"


def _ticks(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if "running elapsed_ms=" in r.getMessage()]


def _wait_for_tick(caplog, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if _ticks(caplog):
            return True
        time.sleep(0.01)
    return False


def test_tick_logged_while_stage_still_running(caplog):
    with caplog.at_level("INFO", logger="damwha_worker"):
        with timed_stage("stt", CTX, tick_seconds=0.05):
            assert _wait_for_tick(caplog), "stage 진행 중 tick 로그가 없다"
    ticks = _ticks(caplog)
    assert all(m.startswith(f"{CTX} stage=stt running elapsed_ms=") for m in ticks), ticks
    assert any("stage=stt done elapsed_ms=" in r.getMessage() for r in caplog.records)


def test_fast_stage_logs_no_tick(caplog):
    with caplog.at_level("INFO", logger="damwha_worker"):
        with timed_stage("vad", CTX):
            pass
    assert _ticks(caplog) == []


def test_tick_includes_current_detail(caplog):
    with caplog.at_level("INFO", logger="damwha_worker"):
        with timed_stage("stt", CTX, tick_seconds=0.05) as t:
            t["detail"] = "units=3/73"
            assert _wait_for_tick(caplog)
    assert all("units=3/73" in m for m in _ticks(caplog))


def test_ticker_stops_when_stage_exits(caplog):
    with caplog.at_level("INFO", logger="damwha_worker"):
        with timed_stage("stt", CTX, tick_seconds=0.05):
            assert _wait_for_tick(caplog)
        after_exit = len(_ticks(caplog))
        time.sleep(0.2)  # tick 간격 4회분
        assert len(_ticks(caplog)) == after_exit


def test_tick_survives_stage_exception(caplog):
    with caplog.at_level("INFO", logger="damwha_worker"):
        try:
            with timed_stage("stt", CTX, tick_seconds=0.05):
                assert _wait_for_tick(caplog)
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        before = len(_ticks(caplog))
        time.sleep(0.2)
        assert len(_ticks(caplog)) == before
