import { Injectable, Logger } from '@nestjs/common';
import { JobRow, JobType, Queryable } from './jobs.types';
import { APP_WORKER_PREFIX } from './worker-identity';

@Injectable()
export class JobsRepository {
  private readonly logger = new Logger(JobsRepository.name);

  async enqueue(
    exec: Queryable,
    args: { type: JobType; meetingId: string | null; payload: unknown; maxAttempts?: number },
  ): Promise<JobRow> {
    // maxAttempts를 안 주면 컬럼 DEFAULT(5)를 그대로 쓴다 — 상수를 여기 복제하지 않는다.
    const { rows } = args.maxAttempts === undefined
      ? await exec.query<JobRow>(
          `INSERT INTO job(type, meeting_id, payload)
           VALUES($1, $2, $3::jsonb) RETURNING *`,
          [args.type, args.meetingId, JSON.stringify(args.payload)],
        )
      : await exec.query<JobRow>(
          `INSERT INTO job(type, meeting_id, payload, max_attempts)
           VALUES($1, $2, $3::jsonb, $4) RETURNING *`,
          [args.type, args.meetingId, JSON.stringify(args.payload), args.maxAttempts],
        );
    this.logger.log(`enqueued job ${rows[0].id} type=${args.type} meeting=${args.meetingId ?? '-'}`);
    return rows[0];
  }

  async claim(exec: Queryable, workerId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(
      `UPDATE job SET status='running', locked_by=$1, locked_at=now(),
                      attempts = attempts + 1, next_attempt_at=NULL, updated_at=now()
       WHERE id IN (
         SELECT id FROM job
         WHERE status='queued'
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         -- 라이브 세션은 사람이 회의 중이다 — 밀린 색인·요약보다 먼저 집는다 (설계 §3.3).
         ORDER BY (type = 'live_session') DESC, next_attempt_at NULLS FIRST, created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [workerId],
    );
    return rows[0] ?? null;
  }

  async findById(exec: Queryable, jobId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(`SELECT * FROM job WHERE id=$1`, [jobId]);
    return rows[0] ?? null;
  }

  async heartbeat(exec: Queryable, jobId: string, workerId: string): Promise<void> {
    await exec.query(
      `UPDATE job SET locked_at=now(), updated_at=now()
       WHERE id=$1 AND locked_by=$2 AND status='running'`,
      [jobId, workerId],
    );
  }

  async setStage(exec: Queryable, jobId: string, stage: string, progress: number): Promise<void> {
    await exec.query(
      `UPDATE job SET stage=$2, progress=$3, updated_at=now() WHERE id=$1`,
      [jobId, stage, progress],
    );
  }

  async complete(exec: Queryable, jobId: string): Promise<void> {
    await exec.query(
      `UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=$1`,
      [jobId],
    );
  }

  /** 운영자 취소 에러 본문 — 워커의 WorkerError JSON과 같은 모양(code/message/stage). */
  static cancelledError(stage: string | null) {
    return { code: 'cancelled', kind: 'PERMANENT', stage, message: 'cancelled by operator' };
  }

  /**
   * 운영자 취소 — 아직 끝나지 않은(queued/running) 잡만 failed로 돌린다.
   * 워커 쪽 persist/requeue/fail은 전부 `status='running'` 소유권 가드를 타므로
   * 여기서 상태를 바꾸면 진행 중이던 결과는 `lost`로 버려지고, heartbeat는
   * rowcount 0을 보고 LLM 서버를 내린다. 이미 끝난 잡이면 null.
   */
  async cancel(exec: Queryable, jobId: string, error: object): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(
      `UPDATE job SET status='failed', error=$2::jsonb, updated_at=now()
       WHERE id=$1 AND status IN ('queued','running')
       RETURNING *`,
      [jobId, JSON.stringify(error)],
    );
    return rows[0] ?? null;
  }

  async fail(exec: Queryable, jobId: string, error: object): Promise<void> {
    await exec.query(
      `UPDATE job SET status='failed', error=$2::jsonb, updated_at=now() WHERE id=$1`,
      [jobId, JSON.stringify(error)],
    );
  }

  /**
   * 앞 실행이 남긴 `running` job을 되돌린다. 기동 시 1회만 부른다 (ReaperService).
   *
   * **중단을 센다 — `interruptions`를 +1 하고 그것으로 상한을 판정한다** (Phase 6b-3 스펙 §4.2).
   * `attempts`는 읽지도 바꾸지도 않는다. 실행 중이던 job은 재시도 예산이 남아 있다 — 다 썼다면
   * dispatch가 이미 failed로 닫았다. 그래서 `attempts = max_attempts`로 실행 중이던 행도 중단
   * 예산이 남으면 queued로 간다. 앱을 세 번(기본 `max_interruptions`) 죽이는 job은 failed다 —
   * 그 job이 앱을 죽이고 있을 수 있다(Phase 5 스펙 §4.1의 정직성은 그대로, 셈만 따로).
   *
   * 분기가 셋이다. 회수가 `locked_at=NULL`로 지우므로 30분 reaper는 이 행을 다시 보지 못한다 —
   * 상한 분기가 여기 없으면 앱을 죽이는 job은 기동마다 되살아나 영원히 돈다.
   *
   * 상한을 태운 행은 `reapStale`과 **같은 방식으로** 딸린 행까지 닫는다
   * (`lens_extraction_run`·`meeting_summary`·`meeting`·`speaker`). 회의는 그 job이 **아직 회의의
   * 현재 job일 때만** 닫는다(스펙 §6.1) — 동시 재처리로 밀려난 옛 job이 새 실행의 회의를 덮지 않게.
   *
   * 잠금은 `reapStale`과 같은 `FOR UPDATE SKIP LOCKED`다. 이 메서드는 Nest가 HTTP 리슨
   * **전에** 기다리는 `onApplicationBootstrap`에서 돌고, 잠금 대기는 예외가 아니라서
   * 호출부의 try/catch가 잡지 못한다 — 맨 행 잠금이면 기동이 통째로 멈춘다
   * (Phase 5 스펙 §4.5: "회수 SQL이 실패하면 기동을 막지 않는다"). 지금 잠긴 행은 살아 있는
   * 누군가의 것이니 건너뛰는 것이 맞고, 놓친 행은 30분 reaper가 같은 규칙으로 본다.
   */
  async reclaimOrphaned(
    exec: Queryable,
    workerId: string,
  ): Promise<{ requeued: number; failedLive: number; failedInterrupted: number }> {
    const { rows } = await exec.query<{ requeued: string; failed_live: string; failed_interrupted: string }>(
      `WITH orphaned AS (
         SELECT id, type, meeting_id, interruptions, max_interruptions, stage
         FROM job
         WHERE status='running'
           AND locked_by LIKE $1 || '%'
           AND locked_by <> $2
         FOR UPDATE SKIP LOCKED
       ),
       requeued AS (
         UPDATE job
            SET status='queued', interruptions = interruptions + 1,
                locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE id IN (
            SELECT id FROM orphaned
             WHERE interruptions + 1 < max_interruptions AND type <> 'live_session'
          )
          RETURNING id
       ),
       -- 끊긴 라이브는 재queue하지 않는다 (기존 reaper와 같은 규칙). job만 닫는다 —
       -- 회의·확정·봉인 경계·파일은 건드리지 않고, 봉인과 마무리는 LiveOrphanService가
       -- 한다(live-orphan.service.ts). 이 회수가 하는 일은 그 경로를 30분 reaper 대신
       -- 즉시 여는 것뿐이다. 중단은 세되 판정에는 쓰지 않는다.
       failed_live AS (
         UPDATE job j
            SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
                error = jsonb_build_object(
                  'code','app_restarted',
                  'message','the app restarted while this live session was running',
                  'stage', j.stage)
          WHERE id IN (SELECT id FROM orphaned WHERE type='live_session')
          RETURNING id
       ),
       -- 중단 한도를 태운 비-live 행. 아래 네 CTE가 reapStale의 failed 분기와 같은 짝을 닫는다.
       failed_interrupted AS (
         UPDATE job j
            SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
                error = jsonb_build_object(
                  'code','app_restarted',
                  'message', format('the app was interrupted %s times while running this job',
                                    j.interruptions + 1),
                  'stage', j.stage)
          WHERE id IN (
            SELECT id FROM orphaned
             WHERE interruptions + 1 >= max_interruptions AND type <> 'live_session'
          )
          RETURNING id, type, meeting_id, error
       ),
       fail_lens_extraction_runs AS (
         UPDATE lens_extraction_run r SET status='failed', error=f.error, finished_at=now()
         FROM failed_interrupted f
         WHERE r.job_id=f.id AND f.type='extract_lenses'
         RETURNING r.id
       ),
       fail_summaries AS (
         UPDATE meeting_summary s SET status='failed', error=f.error, updated_at=now()
         FROM failed_interrupted f
         WHERE s.job_id=f.id AND f.type='summarize_meeting'
         RETURNING s.meeting_id
       ),
       -- live_session은 여기 없다 — failed_interrupted가 비-live만 담으므로 구조적으로 빠진다.
       -- 브라우저가 오디오를 보내는 한 녹음은 계속되고, 마무리는 LiveOrphanService가 한다.
       -- current_job_id 가드: 밀려난 옛 job이 새 실행의 회의를 덮지 않는다 (스펙 §6.1).
       fail_meetings AS (
         UPDATE meeting m SET status='failed',
           error = jsonb_build_object('code','app_restarted',
                                      'message','the app restarted repeatedly while processing this meeting')
         FROM failed_interrupted f
         WHERE m.id = f.meeting_id AND m.current_job_id = f.id AND f.type = 'process_meeting'
         RETURNING m.id
       ),
       fail_speakers AS (
         UPDATE speaker s SET enrollment_status='failed',
           enrollment_error = jsonb_build_object('code','app_restarted',
                                                 'message','the app restarted repeatedly while enrolling')
         WHERE s.current_job_id IN (SELECT id FROM failed_interrupted WHERE type='enroll_speaker')
         RETURNING s.id
       )
       SELECT (SELECT count(*) FROM requeued)           AS requeued,
              (SELECT count(*) FROM failed_live)        AS failed_live,
              (SELECT count(*) FROM failed_interrupted) AS failed_interrupted`,
      [APP_WORKER_PREFIX, workerId],
    );
    return {
      requeued: Number(rows[0].requeued),
      failedLive: Number(rows[0].failed_live),
      failedInterrupted: Number(rows[0].failed_interrupted),
    };
  }

  async reapStale(
    exec: Queryable,
    staleMinutes: number,
  ): Promise<{ requeued: number; failed: number }> {
    const { rows } = await exec.query<{ requeued: string; failed: string }>(
      `WITH stale AS (
         SELECT id, type, meeting_id, interruptions, max_interruptions, stage
         FROM job
         WHERE status='running'
           AND locked_at < now() - ($1 || ' minutes')::interval
         FOR UPDATE SKIP LOCKED
       ),
       -- live_session은 재queue 대상이 아니다 (설계 §2.2·§4.2). 다시 claim해 봐야 다음 워커는
       -- 이미 지나간 오디오를 앞에서부터 다시 전사한다. max_attempts=1이 보통 그것을 보장하지만,
       -- 남는 attempts를 가진 라이브 행이 생겨도 여기서 failed로 간다 — 두 집합이 정확히
       -- 반대라야 stale live job이 running에 영원히 남지 않는다.
       -- 30분간 heartbeat 성공이 없었다 = 중단 한 번 (Phase 6b-3 스펙 §4.2). attempts는 보지 않는다.
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
       -- 보내고 API가 파일에 쓰므로 워커가 죽어도 녹음은 계속된다 (설계 §2.11, §7의
       -- "녹음은 계속. 미리보기만 없고"). 여기서 회의를 failed로 만들면 브라우저가 아직
       -- 업로드 중인 멀쩡한 녹음을 죽인다. job은 그대로 failed가 되고(그 워커는 실제로
       -- 사라졌다), 마무리는 stop이나 LiveOrphanService가 API 경로로 맡는다.
       -- 워커의 db.reap_stale도 같은 계약이다 — 두 CTE는 함께 고친다.
       fail_meetings AS (
         UPDATE meeting m SET status='failed',
           error = jsonb_build_object('code','stale_worker','message','processing worker lost')
         FROM failed f
         WHERE m.id = f.meeting_id AND m.current_job_id = f.id AND f.type = 'process_meeting'
         RETURNING m.id
       ),
       fail_speakers AS (
         UPDATE speaker s SET enrollment_status='failed',
           enrollment_error = jsonb_build_object('code','stale_worker','message','enroll worker lost')
         WHERE s.current_job_id IN (SELECT id FROM failed WHERE type='enroll_speaker')
         RETURNING s.id
       )
       SELECT (SELECT count(*) FROM requeued) AS requeued,
              (SELECT count(*) FROM failed)   AS failed`,
      [String(staleMinutes)],
    );
    return { requeued: Number(rows[0].requeued), failed: Number(rows[0].failed) };
  }
}
