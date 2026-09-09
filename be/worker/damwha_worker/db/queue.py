"""job 테이블 생애주기 — claim, 진행 보고, 반납, 수확.

도메인 테이블은 건드리지 않는다. 예외는 `mark_processing` 하나로, claim 직후 회의를
processing으로 넘기는 같은 전이의 반쪽이라 여기 있다.
"""

from psycopg.types.json import Jsonb


def claim(conn, worker_id: str) -> dict | None:
    """queued job 하나를 잠근다. live_session은 사람이 회의 중이라 밀린 job보다 먼저 집는다
    (API의 JobsRepository.claim과 같은 정렬)."""
    return conn.execute(
        """
        UPDATE job SET status='running', locked_by=%s, locked_at=now(),
               attempts = attempts + 1, next_attempt_at=NULL, updated_at=now()
        WHERE id IN (
          SELECT id FROM job
          WHERE status='queued'
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
          ORDER BY (type = 'live_session') DESC, next_attempt_at NULLS FIRST, created_at
          FOR UPDATE SKIP LOCKED LIMIT 1
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
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               next_attempt_at=now() + least(power(2, attempts - 1), 60) * interval '1 second',
               updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def requeue_for_shutdown(conn, job_id: str, worker_id: str) -> int:
    # graceful shutdown은 job의 잘못이 아니다 — claim이 올린 attempts를 되돌린다.
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               attempts = greatest(attempts - 1, 0), next_attempt_at=NULL, updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount


def reap_stale(conn, stale_minutes: float) -> tuple[int, int]:
    row = conn.execute(
        """
        WITH stale AS (
          SELECT id, type, meeting_id, attempts, max_attempts, stage
          FROM job
          WHERE status='running'
            AND locked_at < now() - (%s || ' minutes')::interval
          FOR UPDATE SKIP LOCKED
        ),
        -- live_session은 재queue 대상이 아니다 (설계 §2.2·§4.2). 다시 claim해 봐야 다음
        -- 워커는 이미 지나간 오디오를 앞에서부터 다시 전사한다. max_attempts=1이 보통
        -- 그것을 보장하지만, 남는 attempts를 가진 라이브 행이 생겨도 여기서 failed로 간다 —
        -- 두 집합이 정확히 반대라야 stale live job이 running에 영원히 남지 않는다.
        requeued AS (
          UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
                 next_attempt_at=NULL, updated_at=now()
          WHERE id IN (
            SELECT id FROM stale WHERE attempts < max_attempts AND type <> 'live_session'
          )
          RETURNING id
        ),
        failed AS (
          UPDATE job j SET status='failed', updated_at=now(),
            error = jsonb_build_object('code','stale_worker',
                                       'message','worker lock expired',
                                       'stage', j.stage)
          WHERE id IN (
            SELECT id FROM stale WHERE attempts >= max_attempts OR type = 'live_session'
          )
          RETURNING id, type, meeting_id, error
        ),
        fail_lens_extraction_runs AS (
          UPDATE lens_extraction_run r SET status='failed', error=f.error, finished_at=now()
          FROM failed f
          WHERE r.job_id=f.id AND f.type='extract_lenses'
          RETURNING r.id
        ),
        fail_summaries AS (
          UPDATE meeting_summary s SET status='failed', error=f.error, updated_at=now()
          FROM failed f
          WHERE s.job_id=f.id AND f.type='summarize_meeting'
          RETURNING s.meeting_id
        ),
        -- live_session은 일부러 빠져 있다. 워커가 캡처자였을 때는 "워커를 잃음 = 녹음을
        -- 잃음"이었지만, 브라우저 캡처로 옮긴 뒤로는 아니다 — 오디오는 브라우저가 API로
        -- 보내고 API가 파일에 쓰므로 워커가 죽어도 녹음은 계속된다 (설계 §4.1의
        -- OOM/SIGKILL 행). 여기서 회의를 failed로 만들면 아직 업로드 중인 멀쩡한 녹음을
        -- 죽인다. job은 그대로 failed가 되고, 마무리는 stop이나 orphan 스위퍼가 API
        -- 경로로 맡는다. TypeScript의 JobsRepository.reapStale과 같은 계약이다.
        fail_meetings AS (
          UPDATE meeting m SET status='failed',
            error = jsonb_build_object('code','stale_worker','message','processing worker lost')
          WHERE m.id IN (
            SELECT meeting_id FROM failed WHERE type = 'process_meeting'
          )
          RETURNING m.id
        ),
        fail_speakers AS (
          UPDATE speaker s SET enrollment_status='failed',
            enrollment_error = jsonb_build_object(
              'code','stale_worker','message','enroll worker lost'
            )
          WHERE s.current_job_id IN (SELECT id FROM failed WHERE type='enroll_speaker')
          RETURNING s.id
        )
        SELECT (SELECT count(*) FROM requeued) AS requeued,
               (SELECT count(*) FROM failed) AS failed
        """,
        (str(stale_minutes),),
    ).fetchone()
    return int(row["requeued"]), int(row["failed"])


def fail_job(conn, job_id: str, worker_id: str, error: dict) -> bool:
    cur = conn.execute(
        "UPDATE job SET status='failed', error=%s, updated_at=now() "
        "WHERE id=%s AND locked_by=%s AND status='running'",
        (Jsonb(error), job_id, worker_id),
    )
    return cur.rowcount > 0


def peek_queued(conn) -> bool:
    """큐에 처리 대기 job이 있는지 읽기 전용 확인. 어떤 행도 claim하지 않는다."""
    return conn.execute("SELECT 1 FROM job WHERE status='queued' LIMIT 1").fetchone() is not None
