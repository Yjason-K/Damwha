"""TTY 한 줄 진행 바. 로그와 같은 스트림을 공유하되 서로를 깨뜨리지 않는다.

로그는 줄 단위로 스크롤하고 바는 한 줄을 계속 덮어쓰므로, 그냥 섞으면 바 잔해가
로그 줄에 붙는다. `BarAwareStreamHandler`가 로그를 내보내기 전에 바를 지우고 뒤에
다시 그려서 이를 막는다. TTY가 아니면(로그 파일·CI) 바는 아무것도 쓰지 않는다 —
`\\r` 스팸이 파일을 덮는 것을 원치 않기 때문이다.
"""

import logging
import os
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager

_CLEAR_LINE = "\r\x1b[K"
_FILLED = "█"
_EMPTY = "░"

# 바 렌더와 로그 출력이 같은 스트림을 쓰므로 write는 이 lock 안에서만 한다
# (tick 스레드와 파이프라인 스레드가 동시에 쓴다).
_lock = threading.RLock()
_active: "ProgressBar | None" = None


def bar_enabled(stream=None) -> bool:
    if os.environ.get("DAMWHA_PROGRESS_BAR", "1") == "0":
        return False
    stream = stream if stream is not None else sys.stderr
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError):  # 닫힌 스트림·isatty 없는 객체
        return False


class ProgressBar:
    """`update(fraction, text)`로 한 줄을 덮어쓴다. 비활성이면 전부 no-op."""

    def __init__(self, label: str, *, stream=None, width: int = 24, enabled: bool = True) -> None:
        self._label = label
        self._stream = stream if stream is not None else sys.stderr
        self._width = width
        self._enabled = enabled
        self._frame = ""

    def update(self, fraction: float, text: str = "") -> None:
        if not self._enabled:
            return
        fraction = min(max(fraction, 0.0), 1.0)
        filled = int(round(self._width * fraction))
        bar = _FILLED * filled + _EMPTY * (self._width - filled)
        suffix = f" {text}" if text else ""
        with _lock:
            self._frame = f"{self._label} [{bar}] {int(fraction * 100)}%{suffix}"
            self._write(self._frame)

    def close(self) -> None:
        with _lock:
            self._erase()
            self._frame = ""

    def _erase(self) -> None:
        """줄만 비운다 — frame은 남겨 로그 뒤에 다시 그릴 수 있게 한다."""
        if not self._enabled:
            return
        with _lock:
            self._stream.write(_CLEAR_LINE)
            self._stream.flush()

    def _write(self, frame: str) -> None:
        self._stream.write(_CLEAR_LINE + frame)
        self._stream.flush()

    def _redraw(self) -> None:
        if self._enabled and self._frame:
            self._write(self._frame)


@contextmanager
def progress_bar(label: str, *, stream=None, width: int = 24) -> Iterator[ProgressBar]:
    """활성 바를 등록하고 빠져나갈 때 줄을 지운다. 비활성 환경에서도 같은 객체를 준다."""
    global _active
    bar = ProgressBar(label, stream=stream, width=width, enabled=bar_enabled(stream))
    with _lock:
        previous = _active
        _active = bar
    try:
        yield bar
    finally:
        bar.close()
        with _lock:
            _active = previous


class BarAwareStreamHandler(logging.StreamHandler):
    """로그 한 줄 = 바 지우기 → 로그 → 바 다시 그리기."""

    def emit(self, record: logging.LogRecord) -> None:
        with _lock:
            bar = _active
            if bar is not None:
                bar._erase()
            super().emit(record)
            if bar is not None:
                bar._redraw()


def install_logging(level: int = logging.INFO) -> None:
    """basicConfig 대신 — 루트 로거를 바와 협조하는 핸들러 하나로 구성한다."""
    handler = BarAwareStreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    logging.basicConfig(level=level, handlers=[handler], force=True)
