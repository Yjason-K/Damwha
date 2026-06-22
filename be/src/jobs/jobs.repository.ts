import { Injectable } from '@nestjs/common';
import { JobRow, JobType, Queryable } from './jobs.types';

@Injectable()
export class JobsRepository {
  async enqueue(
    exec: Queryable,
    args: { type: JobType; meetingId: string | null; payload: unknown },
  ): Promise<JobRow> {
    const { rows } = await exec.query<JobRow>(
      `INSERT INTO job(type, meeting_id, payload)
       VALUES($1, $2, $3::jsonb) RETURNING *`,
      [args.type, args.meetingId, JSON.stringify(args.payload)],
    );
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
}
