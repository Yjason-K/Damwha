"""STT 진행 보고 — clip 단위 콘솔 로그 + job.progress(75→90) 갱신."""

import pytest

from damwha_worker.pipeline.progress import SttProgressReporter

CTX = "job=j1 meeting=m1"


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _lines(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if "stage=stt running units=" in r.getMessage()]


def test_first_call_logs_units_audio_and_pct(caplog):
    report = SttProgressReporter(CTX, total_units=2, clock=FakeClock())
    with caplog.at_level("INFO", logger="damwha_worker"):
        report(2_700, 8_600)
    (line,) = _lines(caplog)
    assert line.startswith(f"{CTX} stage=stt running units=1/2")
    assert "audio_ms=2700/8600" in line
    assert "pct=31" in line


def test_progress_lerped_between_stage_bounds():
    writes: list[int] = []
    clock = FakeClock()
    report = SttProgressReporter(
        CTX, total_units=2, set_progress=writes.append, clock=clock, min_interval_s=0.0
    )
    report(4_300, 8_600)  # 50% → 75 + 15*0.5
    clock.now += 1.0
    report(8_600, 8_600)  # 100% → 90
    assert writes == [82, 90]


def test_throttle_suppresses_midstream_but_keeps_first_and_last(caplog):
    writes: list[int] = []
    report = SttProgressReporter(
        CTX, total_units=3, set_progress=writes.append, clock=FakeClock(), min_interval_s=2.0
    )
    with caplog.at_level("INFO", logger="damwha_worker"):
        report(1_000, 3_000)  # 첫 호출 — 항상 보고
        report(2_000, 3_000)  # throttle 구간(시계 정지) — 억제
        report(3_000, 3_000)  # 마지막 unit — 항상 보고
    assert len(writes) == 2
    units = [line.split("units=")[1].split()[0] for line in _lines(caplog)]
    assert units == ["1/3", "3/3"]


def test_throttle_emits_once_interval_elapsed():
    writes: list[int] = []
    clock = FakeClock()
    report = SttProgressReporter(
        CTX, total_units=10, set_progress=writes.append, clock=clock, min_interval_s=2.0
    )
    report(1_000, 10_000)
    report(2_000, 10_000)  # 억제
    clock.now += 2.0
    report(3_000, 10_000)  # 간격 경과 → 보고
    assert len(writes) == 2


def test_rate_and_eta_derived_from_wall_clock(caplog):
    clock = FakeClock()
    report = SttProgressReporter(CTX, total_units=5, clock=clock, min_interval_s=0.0)
    clock.now = 10.0  # 오디오 20초를 벽시계 10초에 처리 → 2.0x
    with caplog.at_level("INFO", logger="damwha_worker"):
        report(20_000, 100_000)
    (line,) = _lines(caplog)
    assert "rate=2.0x" in line
    assert "eta_s=40" in line  # 남은 80초 오디오 / 2.0x


def test_zero_total_ms_reports_without_crashing(caplog):
    report = SttProgressReporter(CTX, total_units=1, clock=FakeClock(), min_interval_s=0.0)
    with caplog.at_level("INFO", logger="damwha_worker"):
        report(0, 0)
    (line,) = _lines(caplog)
    assert "pct=0" in line
    assert "eta_s=" not in line  # 총량을 모르면 ETA를 지어내지 않는다


def test_progress_write_failure_never_breaks_transcription(caplog):
    def boom(_progress: int) -> None:
        raise RuntimeError("db gone")

    report = SttProgressReporter(
        CTX, total_units=1, set_progress=boom, clock=FakeClock(), min_interval_s=0.0
    )
    with caplog.at_level("WARNING", logger="damwha_worker"):
        report(1_000, 1_000)  # 예외가 STT 루프로 새어나가면 job이 죽는다
    assert any("progress update failed" in r.getMessage() for r in caplog.records)


def test_units_never_exceed_total():
    # 백엔드가 예상보다 많이 콜백해도 units 표시는 total에서 멈춘다
    clock = FakeClock()
    writes: list[int] = []
    report = SttProgressReporter(
        CTX, total_units=1, set_progress=writes.append, clock=clock, min_interval_s=0.0
    )
    report(500, 1_000)
    report(1_000, 1_000)
    assert writes == [82, 90]


@pytest.mark.parametrize(
    ("done", "total", "expected"),
    [(0, 1_000, 75), (1_000, 1_000, 90), (2_000, 1_000, 90)],
)
def test_progress_clamped_to_bounds(done, total, expected):
    writes: list[int] = []
    report = SttProgressReporter(
        CTX, total_units=1, set_progress=writes.append, clock=FakeClock(), min_interval_s=0.0
    )
    report(done, total)
    assert writes == [expected]


class FakeBar:
    def __init__(self) -> None:
        self.updates: list[tuple[float, str]] = []

    def update(self, fraction: float, text: str = "") -> None:
        self.updates.append((fraction, text))


def test_bar_updates_every_call_even_while_log_is_throttled(caplog):
    # 바는 한 줄을 덮어쓸 뿐이라 매 clip 갱신해도 싸다 — 로그/DB만 throttle 대상
    bar = FakeBar()
    report = SttProgressReporter(CTX, total_units=3, bar=bar, clock=FakeClock(), min_interval_s=2.0)
    with caplog.at_level("INFO", logger="damwha_worker"):
        report(1_000, 3_000)
        report(2_000, 3_000)
        report(3_000, 3_000)
    assert [round(f, 3) for f, _ in bar.updates] == [0.333, 0.667, 1.0]
    assert len(_lines(caplog)) == 2  # 첫 호출 + 마지막 unit


def test_bar_text_shows_units_rate_and_eta():
    bar = FakeBar()
    clock = FakeClock()
    report = SttProgressReporter(CTX, total_units=5, bar=bar, clock=clock, min_interval_s=0.0)
    clock.now = 10.0
    report(20_000, 100_000)
    (_fraction, text) = bar.updates[-1]
    assert text == "1/5 clips 2.0x eta 40s"


def test_bar_eta_over_a_minute_is_minutes_and_seconds():
    bar = FakeBar()
    clock = FakeClock()
    report = SttProgressReporter(CTX, total_units=5, bar=bar, clock=clock, min_interval_s=0.0)
    clock.now = 10.0
    report(10_000, 133_000)  # 1.0x, 남은 123초
    assert bar.updates[-1][1] == "1/5 clips 1.0x eta 2m03s"


def test_bar_text_omits_rate_before_first_measurement():
    bar = FakeBar()
    report = SttProgressReporter(CTX, total_units=5, bar=bar, clock=FakeClock(), min_interval_s=0.0)
    report(0, 100_000)  # 경과 0초 — 속도를 지어내지 않는다
    assert bar.updates[-1][1] == "1/5 clips"


def test_abort_event_raises_before_reporting():
    # 운영자 취소: heartbeat가 소유권 상실을 보고 event를 set하면 다음 clip에서 STT를 끊는다
    import threading

    from damwha_worker.errors import ShutdownRequested

    ev = threading.Event()
    writes: list[int] = []
    report = SttProgressReporter(
        CTX, total_units=2, set_progress=writes.append, clock=FakeClock(), abort_event=ev
    )
    report(4_300, 8_600)
    ev.set()
    with pytest.raises(ShutdownRequested):
        report(8_600, 8_600)
    assert writes == [82]  # set 이후엔 아무 것도 보고하지 않는다
