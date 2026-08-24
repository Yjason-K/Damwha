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
        """SELECT u.id, u.speaker_id, s.name AS speaker_name, u.text, u.start_ms, u.end_ms
           FROM utterance u
           LEFT JOIN speaker s ON s.id = u.speaker_id
           WHERE u.meeting_id=%s AND u.processing_version=%s
             AND u.status='ok' AND u.text IS NOT NULL
           ORDER BY u.order_index, u.id""",
        (payload.meeting_id, payload.processing_version),
    ).fetchall()
    candidates = client.extract(model=payload.model, utterances=[dict(row) for row in rows])
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
