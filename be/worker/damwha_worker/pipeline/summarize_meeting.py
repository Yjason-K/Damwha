import threading

from .. import db
from ..contracts import SummarizeMeetingPayload
from ..errors import LLM_INVALID_RESPONSE, ErrorKind, WorkerError
from .stage import enter_stage


def _resolve_segments(segments, rows) -> list[dict]:
    """LLM이 지목한 경계 utterance를 DB 행에 맞춰 검증하고 시간을 채운다.

    LLM은 id만 신뢰 대상이다 — start_ms/end_ms는 여기서 DB 값으로 파생시켜
    모델이 타임스탬프를 지어내는 실패 모드를 원천 차단한다.
    """
    order = {row["id"]: index for index, row in enumerate(rows)}
    by_id = {row["id"]: row for row in rows}
    resolved: list[dict] = []
    previous_end = -1
    for segment in segments:
        start = by_id.get(segment.start_utterance_id)
        end = by_id.get(segment.end_utterance_id)
        if start is None or end is None:
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segment cites an utterance outside the meeting: "
                f"{segment.start_utterance_id}..{segment.end_utterance_id}",
                ErrorKind.PERMANENT,
            )
        if order[start["id"]] > order[end["id"]]:
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segment boundaries are reversed: {start['id']}..{end['id']}",
                ErrorKind.PERMANENT,
            )
        if order[start["id"]] <= previous_end:
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segments are not in transcript order at {start['id']}",
                ErrorKind.PERMANENT,
            )
        previous_end = order[end["id"]]
        resolved.append(
            {
                "start_utterance_id": start["id"],
                "end_utterance_id": end["id"],
                "start_ms": start["start_ms"],
                "end_ms": end["end_ms"],
                "title": segment.title,
                "bullets": list(segment.bullets),
            }
        )
    return resolved


def run_summarize_meeting(
    conn,
    job: dict,
    payload: SummarizeMeetingPayload,
    client,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
) -> str:
    outcome = db.mark_summary_running(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
    )
    if outcome != "running":
        return outcome
    enter_stage(conn, job["id"], worker_id, "summarize_meeting", 30, shutdown_event)
    rows = conn.execute(
        """SELECT u.id, u.speaker_id, s.name AS speaker_name, u.text, u.start_ms, u.end_ms
           FROM utterance u
           LEFT JOIN speaker s ON s.id = u.speaker_id
           WHERE u.meeting_id=%s AND u.processing_version=%s
             AND u.status='ok' AND u.text IS NOT NULL
           ORDER BY u.order_index, u.id""",
        (payload.meeting_id, payload.processing_version),
    ).fetchall()
    response = client.summarize(model=payload.model, utterances=[dict(row) for row in rows])
    segments = _resolve_segments(response.segments, [dict(row) for row in rows])
    enter_stage(conn, job["id"], worker_id, "persist_summary", 80, shutdown_event)
    return db.persist_summary(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
        topics=list(response.topics),
        segments=segments,
    )
