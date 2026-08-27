"""STT 진행 보고 — Transcriber의 on_progress 콜백을 콘솔 로그 + job.progress로 옮긴다.

Transcriber는 clip(또는 segment)을 하나 끝낼 때마다 `(done_ms, total_ms)`를 넘긴다.
여기서 unit 카운트·퍼센트·처리속도·ETA를 파생시켜 로그로 남기고, stage 구간 안에서
선형보간한 job.progress를 DB에 쓴다. 발화 텍스트는 절대 다루지 않는다(프라이버시).
"""

import logging
import threading
import time
from collections.abc import Callable

from ..console import ProgressBar
from ..errors import ShutdownRequested

log = logging.getLogger("damwha_worker")

# clip 하나마다 로그 한 줄 + UPDATE 한 번이면 긴 회의(수백 clip)에서 과하다 —
# 최소 간격을 두고, 첫 호출과 마지막 unit은 간격과 무관하게 항상 보고한다.
_MIN_INTERVAL_SECONDS = 2.0


class SttProgressReporter:
    def __init__(
        self,
        ctx: str,
        *,
        total_units: int,
        set_progress: Callable[[int], None] | None = None,
        bar: ProgressBar | None = None,
        progress_from: int = 75,
        progress_to: int = 90,
        min_interval_s: float = _MIN_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        abort_event: threading.Event | None = None,
    ) -> None:
        self._ctx = ctx
        self._abort_event = abort_event
        self._total_units = total_units
        self._set_progress = set_progress
        self._bar = bar
        self._from = progress_from
        self._to = progress_to
        self._min_interval_s = min_interval_s
        self._clock = clock
        self._t0 = clock()
        self._units = 0
        self._last_emit: float | None = None

    def __call__(self, done_ms: int, total_ms: int) -> None:
        # STT는 가장 긴 stage라 stage 경계(enter_stage)만으로는 취소가 늦다 — clip마다
        # 확인해 시그널/운영자 취소(heartbeat on_lost)를 여기서도 받는다.
        if self._abort_event is not None and self._abort_event.is_set():
            raise ShutdownRequested("shutdown requested during stt")
        self._units += 1
        now = self._clock()
        fraction = min(max(done_ms / total_ms, 0.0), 1.0) if total_ms > 0 else 0.0
        rate = self._rate(done_ms, now)
        eta_s = self._eta_s(done_ms, total_ms, rate)
        if self._bar is not None:
            # 바는 한 줄을 덮어쓸 뿐이라 매 clip 갱신한다 — throttle은 로그/DB만.
            self._bar.update(fraction, self._bar_text(rate, eta_s))
        if not self._should_emit(now):
            return
        self._last_emit = now
        suffix = "" if rate is None else f" rate={rate:.1f}x"
        if eta_s is not None:
            suffix += f" eta_s={eta_s}"
        log.info(
            "%s stage=stt running units=%d/%d audio_ms=%d/%d pct=%d%s",
            self._ctx,
            self._units_shown,
            self._total_units,
            done_ms,
            total_ms,
            int(fraction * 100),
            suffix,
        )
        if self._set_progress is None:
            return
        try:
            self._set_progress(int(self._from + (self._to - self._from) * fraction))
        except Exception:  # noqa: BLE001 — 진행 보고 실패로 전사를 죽이지 않는다
            log.warning("%s stt progress update failed", self._ctx, exc_info=True)

    @property
    def _units_shown(self) -> int:
        return min(self._units, self._total_units)

    def _should_emit(self, now: float) -> bool:
        if self._last_emit is None or self._units >= self._total_units:
            return True
        return now - self._last_emit >= self._min_interval_s

    def _rate(self, done_ms: int, now: float) -> float | None:
        """처리속도(오디오 ms / 벽시계 ms). 근거가 없으면 None — 지어내지 않는다."""
        elapsed_ms = (now - self._t0) * 1000
        if elapsed_ms <= 0 or done_ms <= 0:
            return None
        return done_ms / elapsed_ms

    def _eta_s(self, done_ms: int, total_ms: int, rate: float | None) -> int | None:
        if rate is None or total_ms <= done_ms:
            return None
        return int((total_ms - done_ms) / 1000 / rate)

    def _bar_text(self, rate: float | None, eta_s: int | None) -> str:
        text = f"{self._units_shown}/{self._total_units} clips"
        if rate is not None:
            text += f" {rate:.1f}x"
        if eta_s is not None:
            text += f" eta {_format_eta(eta_s)}"
        return text


def _format_eta(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    return f"{seconds // 60}m{seconds % 60:02d}s"
