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

  // 이 회의의 **현재** processing_version에서 마지막으로 만들어진 run의 상태.
  // 행이 아예 없으면 null — "추출한 적 없음"과 "추출했는데 0건"을 구분하는 값이라
  // 상태 없음을 실패로 뭉뚱그리지 않는다. 재처리로 버전이 올라가면 그 버전의 run이
  // 생기기 전까지 다시 null이 된다.
  async findLatestRunStatusForCurrentVersion(
    exec: Queryable, meetingId: string,
  ): Promise<LensExtractionRunRow['status'] | null> {
    const { rows } = await exec.query<{ status: LensExtractionRunRow['status'] | null }>(
      `SELECT r.status
         FROM meeting m
         LEFT JOIN LATERAL (
           SELECT status FROM lens_extraction_run
            WHERE meeting_id = m.id AND processing_version = m.processing_version
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         ) r ON true
        WHERE m.id = $1`,
      [meetingId],
    );
    return rows[0]?.status ?? null;
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

  async aggregateStatus(exec: Queryable): Promise<{
    running: number;
    failed: { meeting_id: string; title: string | null }[];
  }> {
    const { rows } = await exec.query<{ running: number; failed: unknown }>(
      `WITH latest AS (
         SELECT DISTINCT ON (meeting_id) meeting_id, status
         FROM lens_extraction_run
         ORDER BY meeting_id, created_at DESC, id DESC
       )
       SELECT
         (SELECT count(*)::int FROM lens_extraction_run
           WHERE status IN ('queued','running')) AS running,
         COALESCE(
           json_agg(json_build_object('meeting_id', l.meeting_id, 'title', m.title)
                    ORDER BY l.meeting_id)
             FILTER (WHERE l.status = 'failed'),
           '[]'
         ) AS failed
       FROM latest l JOIN meeting m ON m.id = l.meeting_id`,
    );
    const row = rows[0];
    return {
      running: row?.running ?? 0,
      failed: (row?.failed as { meeting_id: string; title: string | null }[]) ?? [],
    };
  }
}
