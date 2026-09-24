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


def mark_processing(
    conn, meeting_id: str, job_id: str, processing_version: int, worker_id: str
) -> int:
    """회의를 `processing`으로 올린다. meeting 가드 **와** job 가드를 함께 건다.

    job 가드가 없던 동안 취소와 경합했다: 취소는 job.status 와 meeting.status 만 바꾸고
    `current_job_id`·`processing_version` 은 그대로 두므로 meeting 가드를 그냥 통과했고,
    그러면 이 UPDATE 가 `markCancelled` 가 쓴 `failed` 를 `processing` 으로 되돌렸다.
    그 뒤 회의는 **도달 불가**가 된다 — 취소는 409(진행 중인 job 이 없다), 재처리도
    409(status 가 done/failed 가 아니다). 창이 넓은 이유는 `jobs.py` 의 `build_models()`
    가 이 호출보다 앞이라, 모델을 받아야 하면 claim~여기가 분 단위로 벌어지기 때문이다.

    소유권 가드가 늦게 붙었다. status='running'만 보던 동안, 기동 회수가 앞 실행의 job을
    되돌리고 새 worker가 같은 job을 재claim한 뒤 **이전 worker의 늦은 호출**이 도착하면
    그대로 통과했다 — 자기 것이 아닌 job의 상태 전이다. set_stage·heartbeat와 같은 가드를
    쓴다. 0행이면 이 워커는 더 쓸 것이 없다.
    """
    cur = conn.execute(
        """
        UPDATE meeting SET status='processing'
        WHERE id=%s AND current_job_id=%s AND processing_version=%s
          AND EXISTS (SELECT 1 FROM job WHERE id=%s AND status='running' AND locked_by=%s)
        """,
        (meeting_id, job_id, processing_version, job_id, worker_id),
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


def requeue(conn, job_id: str, worker_id: str, error: dict) -> int:
    # 30초 기준·15분 상한. 1·2초였을 때는 세 번이 3초에 다 타서 3분짜리 네트워크 끊김이
    # job을 영구 실패로 만들었다 (Phase 4 결과 §12.6-12). max_attempts 기본값 5(025)와 함께
    # 시도 시각이 0 · 30s · 90s · 210s · 450s가 된다.
    #
    # 지수는 재시도 예산 소비량(attempts − interruptions) − 1이다 — 크래시 회수가 백오프를
    # 부풀리지 않는다 (Phase 6b-3 스펙 §4.3). dispatch.failures()와 같은 식이고
    # be/test/fixtures/job-reap/grid.json의 retry 격자가 둘을 함께 고정한다.
    #
    # error를 함께 쓴다 — 재시도 대기 중 화면의 "마지막 오류"가 여기서 온다(스펙 §6.3).
    # 다음 claim은 지우지 않는다: 재시도 중인 job의 마지막 오류로 남는다.
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, error=%s,
               next_attempt_at=now()
                 + least(30 * power(2, attempts - interruptions - 1), 900) * interval '1 second',
               updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (Jsonb(error), job_id, worker_id),
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


# 회수 계약은 한 벌이고 `stale`의 **선택자만** 다르다 — 시간 기반(reap_stale)과 소유자 기반
# (reap_own_orphans). 두 벌로 두면 live_session·소진·딸린 행 정리 중 한쪽만 고쳐질 자리다.
_REAP_SQL = """
        WITH stale AS (
          SELECT id, type, meeting_id, interruptions, max_interruptions, stage
          FROM job
          WHERE {selector}
          FOR UPDATE SKIP LOCKED
        ),
        -- live_session은 재queue 대상이 아니다 (설계 §2.2·§4.2). 다시 claim해 봐야 다음
        -- 워커는 이미 지나간 오디오를 앞에서부터 다시 전사한다. max_attempts=1이 보통
        -- 그것을 보장하지만, 남는 attempts를 가진 라이브 행이 생겨도 여기서 failed로 간다 —
        -- 두 집합이 정확히 반대라야 stale live job이 running에 영원히 남지 않는다.
        -- 회수는 중단 한 번이다 (Phase 6b-3 스펙 §4.2). interruptions를 +1 하고 그것으로
        -- 상한을 판정한다. attempts는 읽지도 바꾸지도 않는다 — 실행 중이던 job은 재시도
        -- 예산이 남아 있다(다 썼다면 dispatch가 이미 failed로 닫았다).
        requeued AS (
          UPDATE job SET status='queued', interruptions = interruptions + 1,
                 locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE id IN (
            SELECT id FROM stale
             WHERE interruptions + 1 < max_interruptions AND type <> 'live_session'
          )
          RETURNING id
        ),
        failed AS (
          UPDATE job j SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
            error = jsonb_build_object('code','stale_worker',
                                       'message','worker lock expired',
                                       'stage', j.stage)
          WHERE id IN (
            SELECT id FROM stale
             WHERE interruptions + 1 >= max_interruptions OR type = 'live_session'
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
        -- current_job_id 가드: 밀려난 옛 job이 새 실행의 회의를 덮지 않는다 (스펙 §6.1).
        fail_meetings AS (
          UPDATE meeting m SET status='failed',
            error = jsonb_build_object('code','stale_worker','message','processing worker lost')
          FROM failed f
          WHERE m.id = f.meeting_id AND m.current_job_id = f.id AND f.type = 'process_meeting'
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
"""


def _reap(conn, selector: str, params: tuple) -> tuple[int, int]:
    row = conn.execute(_REAP_SQL.format(selector=selector), params).fetchone()
    return int(row["requeued"]), int(row["failed"])


def reap_stale(conn, stale_minutes: float) -> tuple[int, int]:
    return _reap(
        conn,
        "status='running' AND locked_at < now() - (%s || ' minutes')::interval",
        (str(stale_minutes),),
    )


def reap_own_orphans(conn, worker_id: str) -> tuple[int, int]:
    """자기 신분으로 잠긴 `running` 행을 **시간을 기다리지 않고** 되돌린다.

    부르는 쪽이 "지금 내 `--once` 자식은 하나도 살아 있지 않다"를 보장할 때만 옳다.
    supervisor는 자식을 한 번에 하나만 띄우고 `_wait_child`로 회수하므로 그 자리가 셋이다 —
    기동 직후, 자식을 거둔 직후, DB 재접속 직후. 그 순간 내 신분으로 잠긴 행은 전부 고아다.

    이것이 없으면 DB가 죽어 자식이 함께 죽었을 때 회수 세 층이 모두 비켜 간다 — 기동
    회수는 **앞 실행**의 행만 보고, supervisor의 `--once` 스캔은 supervisor가 재시작해야
    돌기 때문이다. 남는 것은 30분 reaper뿐이고 그동안 화면은 "처리하고 있어요"라는
    거짓을 말한다 (Phase 5 결과 §5, P5-C8).
    """
    return _reap(conn, "status='running' AND locked_by=%s", (worker_id,))


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
