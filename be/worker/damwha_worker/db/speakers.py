"""화자 등록(enroll_speaker) 결과 영속화와 실패 마킹."""

from psycopg.types.json import Jsonb

from .core import _Abort, _vec


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
