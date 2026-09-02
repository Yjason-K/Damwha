import threading
from zoneinfo import ZoneInfo

from .. import db
from ..contracts import ExtractLensesPayload
from .stage import enter_stage
from .timing import timed_stage


def run_extract_lenses(
    conn,
    job: dict,
    payload: ExtractLensesPayload,
    client,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
    meeting_timezone: str = "Asia/Seoul",
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
    # payload가 아니라 DB에서 읽는다 — recorded_at은 enqueue 시점의 결정이 아니라
    # 사실이고, 사용자가 PATCH로 고친 뒤 재추출하면 고친 값이 반영돼야 한다.
    # 021 이후 NOT NULL이라 None 분기가 없다.
    recorded_at = conn.execute(
        "SELECT recorded_at FROM meeting WHERE id=%s", (payload.meeting_id,)
    ).fetchone()["recorded_at"]
    meeting_date = recorded_at.astimezone(ZoneInfo(meeting_timezone)).date()
    # LLM 호출은 긴 회의에서 수 분 — timed_stage가 진행 중 tick과 완료 시간을 남긴다
    with timed_stage("extract_lenses", f"job={job['id']} meeting={payload.meeting_id}") as t:
        candidates = client.extract(
            model=payload.model,
            utterances=[dict(row) for row in rows],
            meeting_date=meeting_date,
        )
        t["detail"] = f"utterances={len(rows)} candidates={len(candidates)}"
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
