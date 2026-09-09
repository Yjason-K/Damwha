"""회의 요약(summarize_meeting) 행의 running/영속/실패 전이."""

from psycopg.types.json import Jsonb

from .core import _Abort


def mark_summary_running(
    conn, *, job_id: str, worker_id: str, meeting_id: str, processing_version: int
) -> str:
    """요약 행을 running으로 넘긴다. 잡 가드 + 회의 가드 둘 다 통과해야 한다."""
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            mrow = conn.execute(
                "SELECT processing_version FROM meeting WHERE id=%s FOR UPDATE", (meeting_id,)
            ).fetchone()
            if mrow is None or mrow["processing_version"] != processing_version:
                stale = Jsonb(
                    {
                        "code": "discarded_by_stale_guard",
                        "message": "meeting superseded by newer processing_version",
                        "stage": "summarize_meeting",
                        "kind": None,
                    }
                )
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (stale, job_id),
                )
                # 주인 잃은 running 행은 reap_stale이 구제하지 못한다(reap된 job에만
                # join) — 여기서 닫지 않으면 재생성이 영구히 막힌다.
                conn.execute(
                    "UPDATE meeting_summary SET status='failed', error=%s, updated_at=now() "
                    "WHERE meeting_id=%s AND processing_version=%s",
                    (stale, meeting_id, processing_version),
                )
                return "discarded"
            conn.execute(
                "UPDATE meeting_summary SET status='running', updated_at=now() "
                "WHERE meeting_id=%s AND processing_version=%s",
                (meeting_id, processing_version),
            )
            return "running"
    except _Abort:
        return "lost"


def persist_summary(
    conn,
    *,
    job_id: str,
    worker_id: str,
    meeting_id: str,
    processing_version: int,
    topics: list,
    segments: list,
) -> str:
    """검증이 끝난 요약으로 기존 행을 덮어쓴다 — 통째 교체라 머지 로직이 없다.

    UPSERT가 아니라 평범한 UPDATE다. 행은 잡을 큐잉한 트랜잭션에서 이미
    queued로 만들어져 있으므로 INSERT 경로가 필요 없다.
    """
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            mrow = conn.execute(
                "SELECT processing_version FROM meeting WHERE id=%s FOR UPDATE", (meeting_id,)
            ).fetchone()
            if mrow is None or mrow["processing_version"] != processing_version:
                stale = Jsonb(
                    {
                        "code": "discarded_by_stale_guard",
                        "message": "meeting superseded by newer processing_version",
                        "stage": "persist_summary",
                        "kind": None,
                    }
                )
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (stale, job_id),
                )
                # 주인 잃은 running 행은 reap_stale이 구제하지 못한다(reap된 job에만
                # join) — 여기서 닫지 않으면 재생성이 영구히 막힌다.
                conn.execute(
                    "UPDATE meeting_summary SET status='failed', error=%s, updated_at=now() "
                    "WHERE meeting_id=%s AND processing_version=%s",
                    (stale, meeting_id, processing_version),
                )
                return "discarded"
            # 요약 행은 큐잉 시점에 이미 만들어져 있다(queued). 여기서는 결과만
            # 덮어쓴다 — 읽기 전용이라 머지할 사람 손댄 값이 없다.
            conn.execute(
                """
                UPDATE meeting_summary
                   SET status='done', job_id=%s, topics=%s, segments=%s,
                       error=NULL, updated_at=now()
                 WHERE meeting_id=%s AND processing_version=%s
                """,
                (job_id, Jsonb(topics), Jsonb(segments), meeting_id, processing_version),
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def fail_summary(conn, job_id: str, worker_id: str, error: dict) -> str:
    """요약 실패는 요약 행과 잡만 건드린다 — meeting은 done을 유지한다.

    meeting_summary는 job_id로 키를 잡는다(reap_stale의 fail_summaries, BE의
    jobs.repository와 동일한 키) — processing_version은 파싱되지 않은 원본
    payload에서 나올 수 있어(예: parse_payload 자체가 실패한 잡) None일 수
    있고, 그러면 (meeting_id, processing_version) 키는 행을 하나도 못 찾아
    요약 행이 queued에 영원히 발이 묶인다.
    """
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            cur = conn.execute(
                "UPDATE meeting_summary SET status='failed', error=%s, updated_at=now() "
                "WHERE job_id=%s",
                (Jsonb(error), job_id),
            )
            if cur.rowcount == 0:
                raise _Abort
        return "failed"
    except _Abort:
        return "lost"
