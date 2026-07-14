import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface ExtractionMeetingRow {
  id: string;
  status: string;
  processing_version: number;
}

export interface LensExtractionRunRow {
  id: string;
  meeting_id: string;
  processing_version: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  job_id: string | null;
  model: string | null;
  error: unknown;
  created_at: Date;
  finished_at: Date | null;
}

export async function findLatestExtractionRun(exec: Queryable, meetingId: string): Promise<LensExtractionRunRow | null> {
  const { rows } = await exec.query<LensExtractionRunRow>(
    `SELECT * FROM lens_extraction_run
     WHERE meeting_id=$1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [meetingId],
  );
  return rows[0] ?? null;
}

@Injectable()
export class LensExtractionRepository {
  async lockMeeting(exec: Queryable, meetingId: string): Promise<ExtractionMeetingRow | null> {
    const { rows } = await exec.query<ExtractionMeetingRow>(
      `SELECT id, status, processing_version FROM meeting WHERE id=$1 FOR UPDATE`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findActiveRun(
    exec: Queryable, meetingId: string, processingVersion: number,
  ): Promise<LensExtractionRunRow | null> {
    const { rows } = await exec.query<LensExtractionRunRow>(
      `SELECT * FROM lens_extraction_run
       WHERE meeting_id=$1 AND processing_version=$2 AND status IN ('queued','running')
       FOR UPDATE`,
      [meetingId, processingVersion],
    );
    return rows[0] ?? null;
  }

  async createQueuedRun(
    exec: Queryable, args: { meetingId: string; processingVersion: number; model: string },
  ): Promise<LensExtractionRunRow> {
    const { rows } = await exec.query<LensExtractionRunRow>(
      `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model)
       VALUES($1,$2,'queued',$3) RETURNING *`,
      [args.meetingId, args.processingVersion, args.model],
    );
    return rows[0];
  }

  async setJobId(exec: Queryable, runId: string, jobId: string): Promise<LensExtractionRunRow> {
    const { rows } = await exec.query<LensExtractionRunRow>(
      `UPDATE lens_extraction_run SET job_id=$2 WHERE id=$1 RETURNING *`,
      [runId, jobId],
    );
    return rows[0];
  }
}
