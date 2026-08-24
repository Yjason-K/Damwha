import logging
import threading
import time
from contextlib import contextmanager

log = logging.getLogger("damwha_worker")

# stage 진행 중 tick 간격. STT/diarize/LLM은 수 분 걸려 완료 로그만으로는 콘솔이
# 무음이 된다 — 살아있음과 경과를 이 간격으로 알린다.
_DEFAULT_TICK_SECONDS = 15.0


@contextmanager
def timed_stage(stage: str, ctx: str, *, tick_seconds: float | None = _DEFAULT_TICK_SECONDS):
    """단계 완료를 elapsed_ms와 함께 INFO로 남기고, 진행 중에는 tick을 찍는다.

    state["detail"]에는 카운트/ID만 넣는다 — 발화 텍스트·화자 PII·절대경로 금지(프라이버시).
    tick_seconds=None이면 tick 없이 완료 로그만 남긴다.
    """
    state = {"detail": ""}
    t0 = time.perf_counter()
    done = threading.Event()

    def _suffix() -> str:
        detail = state["detail"]
        return f" {detail}" if detail else ""

    def _tick() -> None:
        while not done.wait(tick_seconds):
            log.info(
                "%s stage=%s running elapsed_ms=%d%s",
                ctx,
                stage,
                int((time.perf_counter() - t0) * 1000),
                _suffix(),
            )

    if tick_seconds is not None:
        # daemon: shutdown이 stage 중간에 걸려도 프로세스 종료를 붙잡지 않는다.
        threading.Thread(target=_tick, name=f"tick-{stage}", daemon=True).start()
    try:
        yield state
    finally:
        done.set()
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        log.info("%s stage=%s done elapsed_ms=%d%s", ctx, stage, elapsed_ms, _suffix())
