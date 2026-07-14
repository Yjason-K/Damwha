import threading

from .. import db
from ..contracts import ExtractLensesPayload
from .stage import enter_stage


def run_extract_lenses(
    conn,
    job: dict,
    payload: ExtractLensesPayload,
    client,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
) -> str:
    outcome = db.mark_lens_run_running(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
        run_id=payload.extraction_run_id,
    )
    if outcome != "running":
        return outcome
    enter_stage(conn, job["id"], worker_id, "extract_lenses", 30, shutdown_event)
    rows = conn.execute(
        """SELECT id, speaker_id, text, start_ms, end_ms FROM utterance
           WHERE meeting_id=%s AND processing_version=%s AND status='ok' AND text IS NOT NULL
           ORDER BY order_index, id""",
        (payload.meeting_id, payload.processing_version),
    ).fetchall()
    candidates = client.extract(utterances=[dict(row) for row in rows])
    enter_stage(conn, job["id"], worker_id, "persist_lenses", 80, shutdown_event)
    return db.persist_lens_extraction(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
        run_id=payload.extraction_run_id,
        candidates=candidates,
    )
