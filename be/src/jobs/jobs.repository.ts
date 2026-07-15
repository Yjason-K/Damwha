import { Injectable, Logger } from '@nestjs/common';
import { JobRow, JobType, Queryable } from './jobs.types';

@Injectable()
export class JobsRepository {
  private readonly logger = new Logger(JobsRepository.name);

  async enqueue(
    exec: Queryable,
    args: { type: JobType; meetingId: string | null; payload: unknown },
  ): Promise<JobRow> {
    const { rows } = await exec.query<JobRow>(
      `INSERT INTO job(type, meeting_id, payload)
       VALUES($1, $2, $3::jsonb) RETURNING *`,
      [args.type, args.meetingId, JSON.stringify(args.payload)],
    );
    this.logger.log(`enqueued job ${rows[0].id} type=${args.type} meeting=${args.meetingId ?? '-'}`);
    return rows[0];
  }

  async claim(exec: Queryable, workerId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(
      `UPDATE job SET status='running', locked_by=$1, locked_at=now(),
                      attempts = attempts + 1, updated_at=now()
       WHERE id IN (
         SELECT id FROM job WHERE status='queued'
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [workerId],
    );
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

  async fail(exec: Queryable, jobId: string, error: object): Promise<void> {
    await exec.query(
      `UPDATE job SET status='failed', error=$2::jsonb, updated_at=now() WHERE id=$1`,
      [jobId, JSON.stringify(error)],
    );
  }

  async reapStale(
    exec: Queryable,
    staleMinutes: number,
  ): Promise<{ requeued: number; failed: number }> {
    const { rows } = await exec.query<{ requeued: string; failed: string }>(
      `WITH stale AS (
         SELECT id, type, meeting_id, attempts, max_attempts, stage
         FROM job
         WHERE status='running'
           AND locked_at < now() - ($1 || ' minutes')::interval
         FOR UPDATE SKIP LOCKED
       ),
       requeued AS (
         UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=now()
         WHERE id IN (SELECT id FROM stale WHERE attempts < max_attempts)
         RETURNING id
       ),
       failed AS (
         UPDATE job j SET status='failed', updated_at=now(),
           error = jsonb_build_object('code','stale_worker',
                                       'message','worker lock expired',
                                       'stage', j.stage)
         WHERE id IN (SELECT id FROM stale WHERE attempts >= max_attempts)
         RETURNING id, type, meeting_id, error
       ),
       fail_lens_extraction_runs AS (
         UPDATE lens_extraction_run r SET status='failed', error=f.error, finished_at=now()
         FROM failed f
         WHERE r.job_id=f.id AND f.type='extract_lenses'
         RETURNING r.id
       ),
       fail_meetings AS (
         UPDATE meeting m SET status='failed',
           error = jsonb_build_object('code','stale_worker','message','processing worker lost')
         WHERE m.id IN (SELECT meeting_id FROM failed WHERE type='process_meeting')
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
