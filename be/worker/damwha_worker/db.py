import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, row_factory=dict_row, autocommit=True)


def claim(conn, worker_id: str) -> dict | None:
    return conn.execute(
        """
        UPDATE job SET status='running', locked_by=%s, locked_at=now(),
               attempts = attempts + 1, updated_at=now()
        WHERE id IN (
          SELECT id FROM job WHERE status='queued'
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING *
        """,
        (worker_id,),
    ).fetchone()


def mark_processing(conn, meeting_id: str, job_id: str, processing_version: int) -> int:
    cur = conn.execute(
        """
        UPDATE meeting SET status='processing'
        WHERE id=%s AND current_job_id=%s AND processing_version=%s
        """,
        (meeting_id, job_id, processing_version),
    )
    return cur.rowcount


def set_stage(conn, job_id: str, worker_id: str, stage: str, progress: int) -> int:
    cur = conn.execute(
        """
        UPDATE job SET stage=%s, progress=%s, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (stage, progress, job_id, worker_id),
    )
    return cur.rowcount


def heartbeat(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET locked_at=now(), updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def requeue(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def fail_process_meeting(conn, job_id: str, worker_id: str, meeting_id: str, error: dict) -> bool:
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            conn.execute(
                "UPDATE meeting SET status='failed', error=%s WHERE id=%s AND current_job_id=%s",
                (Jsonb({"code": error["code"], "message": error["message"]}), meeting_id, job_id),
            )
        return True
    except _Abort:
        return False


def fail_enroll(conn, job_id: str, worker_id: str, speaker_id: str, error: dict) -> bool:
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            conn.execute(
                "UPDATE speaker SET enrollment_status='failed', enrollment_error=%s "
                "WHERE id=%s AND current_job_id=%s",
                (Jsonb({"code": error["code"], "message": error["message"]}), speaker_id, job_id),
            )
        return True
    except _Abort:
        return False


class _Abort(Exception):
    """Internal: rollback a guarded transaction when ownership is lost."""


def _vec(values):
    return "[" + ",".join(repr(float(x)) for x in values) + "]"


def persist_process_meeting(
    conn,
    *,
    job_id,
    worker_id,
    meeting_id,
    processing_version,
    normalized_key,
    duration_ms,
    utterances,
    clusters,
) -> str:
    try:
        with conn.transaction():
            # (1) job ownership
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort

            # (2) meeting guard
            cur = conn.execute(
                """
                UPDATE meeting SET status='done', error=NULL,
                       normalized_key=%s, duration_ms=%s
                WHERE id=%s AND processing_version=%s AND current_job_id=%s
                """,
                (normalized_key, duration_ms, meeting_id, processing_version, job_id),
            )
            if cur.rowcount == 0:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (
                        Jsonb(
                            {
                                "code": "discarded_by_stale_guard",
                                "message": (
                                    "meeting superseded by newer "
                                    "processing_version/current_job_id"
                                ),
                                "stage": "persist",
                                "kind": None,
                            }
                        ),
                        job_id,
                    ),
                )
                return "discarded"

            # fresh: replace results
            conn.execute("DELETE FROM utterance WHERE meeting_id=%s", (meeting_id,))
            conn.execute("DELETE FROM meeting_cluster WHERE meeting_id=%s", (meeting_id,))
            for u in utterances:
                conn.execute(
                    """
                    INSERT INTO utterance(meeting_id, speaker_id, diar_label,
                        start_ms, end_ms, text, confidence, status,
                        transcript_error, order_index, processing_version, job_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        meeting_id,
                        u["speaker_id"],
                        u["diar_label"],
                        u["start_ms"],
                        u["end_ms"],
                        u["text"],
                        u["confidence"],
                        u["status"],
                        Jsonb(u["transcript_error"]) if u["transcript_error"] is not None else None,
                        u["order_index"],
                        processing_version,
                        job_id,
                    ),
                )
            for c in clusters:
                centroid = _vec(c["centroid"]) if c["centroid"] is not None else None
                conn.execute(
                    """
                    INSERT INTO meeting_cluster(meeting_id, diar_label, centroid,
                        resolved_speaker_id, processing_version, job_id)
                    VALUES (%s,%s,%s::vector,%s,%s,%s)
                    """,
                    (
                        meeting_id,
                        c["diar_label"],
                        centroid,
                        c["resolved_speaker_id"],
                        processing_version,
                        job_id,
                    ),
                )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def persist_enroll(
    conn,
    *,
    job_id,
    worker_id,
    speaker_id,
    embedding,
    model,
    dimension,
    sample_duration_ms,
    quality_score,
) -> str:
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            cur = conn.execute(
                """
                UPDATE speaker SET enrollment_status='ready', enrollment_error=NULL
                WHERE id=%s AND current_job_id=%s
                """,
                (speaker_id, job_id),
            )
            if cur.rowcount == 0:
                raise _Abort  # speaker superseded by a newer enroll job
            conn.execute(
                """
                INSERT INTO voiceprint(speaker_id, embedding, model, dimension,
                    sample_duration_ms, quality_score, source)
                VALUES (%s,%s::vector,%s,%s,%s,%s,'enroll')
                """,
                (speaker_id, _vec(embedding), model, dimension, sample_duration_ms, quality_score),
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"
