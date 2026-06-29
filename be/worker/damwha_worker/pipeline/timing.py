import logging
import time
from contextlib import contextmanager

log = logging.getLogger("damwha_worker")


@contextmanager
def timed_stage(stage: str, ctx: str):
    """단계 완료를 elapsed_ms와 함께 INFO로 남긴다.

    state["detail"]에는 카운트/ID만 넣는다 — 발화 텍스트·화자 PII·절대경로 금지(프라이버시).
    """
    state = {"detail": ""}
    t0 = time.perf_counter()
    try:
        yield state
    finally:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        suffix = f" {state['detail']}" if state["detail"] else ""
        log.info("%s stage=%s done elapsed_ms=%d%s", ctx, stage, elapsed_ms, suffix)
