"""TTY 진행 바 — 한 줄을 \\r로 덮어쓰고, 로그 한 줄이 나가면 지웠다 다시 그린다."""

import logging

from damwha_worker import console

CLEAR = "\r\x1b[K"


class FakeStream:
    def __init__(self, *, tty: bool = True) -> None:
        self.chunks: list[str] = []
        self._tty = tty

    def write(self, s: str) -> int:
        self.chunks.append(s)
        return len(s)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return self._tty

    @property
    def text(self) -> str:
        return "".join(self.chunks)


def test_bar_renders_percent_and_text_on_a_tty():
    stream = FakeStream()
    with console.progress_bar("stt", stream=stream, width=10) as bar:
        bar.update(0.62, "45/73 clips 1.8x eta 2m03s")
    text = stream.text
    assert "stt" in text
    assert "62%" in text
    assert "45/73 clips 1.8x eta 2m03s" in text
    assert "█" in text and "░" in text
    assert CLEAR in text  # 커서를 줄 앞으로 되돌리고 지운다(스크롤하지 않는다)


def test_bar_fill_is_proportional_to_fraction():
    stream = FakeStream()
    with console.progress_bar("stt", stream=stream, width=10) as bar:
        bar.update(0.5, "")
    frame = stream.text.split(CLEAR)[1]
    assert "█████░░░░░" in frame


def test_bar_is_noop_when_stream_is_not_a_tty():
    stream = FakeStream(tty=False)
    with console.progress_bar("stt", stream=stream) as bar:
        bar.update(0.5, "1/2")
    assert stream.text == ""


def test_bar_disabled_by_env(monkeypatch):
    monkeypatch.setenv("DAMWHA_PROGRESS_BAR", "0")
    stream = FakeStream()
    with console.progress_bar("stt", stream=stream) as bar:
        bar.update(0.5, "1/2")
    assert stream.text == ""


def test_bar_clears_its_line_on_close():
    stream = FakeStream()
    with console.progress_bar("stt", stream=stream) as bar:
        bar.update(0.5, "1/2")
    assert stream.text.endswith(CLEAR)  # 다음 로그 줄이 바 잔해 위에 겹치지 않는다


def test_fraction_clamped_to_unit_range():
    stream = FakeStream()
    with console.progress_bar("stt", stream=stream, width=4) as bar:
        bar.update(1.9, "")
        bar.update(-0.5, "")
    frames = stream.text.split(CLEAR)
    assert "100%" in frames[1] and "████" in frames[1]
    assert "0%" in frames[2] and "░░░░" in frames[2]


def test_log_record_clears_bar_then_redraws_it():
    stream = FakeStream()
    logger = logging.getLogger("test-bar-aware")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = console.BarAwareStreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    try:
        with console.progress_bar("stt", stream=stream, width=4) as bar:
            bar.update(0.5, "1/2")
            stream.chunks.clear()
            logger.info("stage=vad done elapsed_ms=1")
        text = stream.text
    finally:
        logger.removeHandler(handler)
    assert text.startswith(CLEAR)  # 로그 전에 바를 지운다
    assert "stage=vad done elapsed_ms=1\n" in text
    # 로그 뒤에 바를 다시 그린다
    assert text.index("50%") > text.index("stage=vad done")


def test_handler_writes_plainly_when_no_bar_is_active():
    stream = FakeStream()
    logger = logging.getLogger("test-bar-aware-plain")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = console.BarAwareStreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    try:
        logger.info("hello")
    finally:
        logger.removeHandler(handler)
    assert stream.text == "hello\n"
