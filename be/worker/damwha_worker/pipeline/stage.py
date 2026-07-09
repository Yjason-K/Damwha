"""세 파이프라인 공통 stage 진입점: shutdown 확인 + 소유권 가드 set_stage."""

import threading

from .. import db
from ..errors import ErrorKind, ShutdownRequested, WorkerError


def enter_stage(
    conn,
    job_id: str,
    worker_id: str,
    stage: str,
    progress: int,
    shutdown_event: threading.Event | None = None,
) -> None:
    if shutdown_event is not None and shutdown_event.is_set():
        raise ShutdownRequested(f"shutdown requested before stage {stage}")
    if db.set_stage(conn, job_id, worker_id, stage, progress) == 0:
        raise WorkerError(
            "lost_ownership", f"lock lost at {stage}", ErrorKind.TRANSIENT, stage=stage
        )
