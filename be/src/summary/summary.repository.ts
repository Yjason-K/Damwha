import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Queryable } from '../jobs/jobs.types';
import { SummaryRow } from './summary.types';

@Injectable()
export class SummaryRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 현재 processing_version의 요약만 돌려준다 — 재처리로 버전이 오르면 없음 취급. */
  async findCurrent(meetingId: string): Promise<SummaryRow | null> {
    const { rows } = await this.db.query<SummaryRow>(
      `SELECT s.meeting_id, s.processing_version, s.status, s.model,
              s.topics, s.segments, s.error
         FROM meeting_summary s
         JOIN meeting m ON m.id = s.meeting_id
        WHERE s.meeting_id = $1 AND s.processing_version = m.processing_version`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async lockMeeting(exec: Queryable, meetingId: string) {
    const { rows } = await exec.query<{ id: string; status: string; processing_version: number }>(
      `SELECT id, status, processing_version FROM meeting WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findActive(exec: Queryable, meetingId: string, processingVersion: number) {
    const { rows } = await exec.query<{ status: string; job_id: string | null; model: string }>(
      `SELECT status, job_id, model FROM meeting_summary
        WHERE meeting_id = $1 AND processing_version = $2
          AND status IN ('queued','running')`,
      [meetingId, processingVersion],
    );
    return rows[0] ?? null;
  }

  /** 취소 — 진행 중(queued/running) 요약 행만 failed로. 끝난 행은 건드리지 않는다. */
  async markCancelled(exec: Queryable, meetingId: string, error: object): Promise<boolean> {
    const { rowCount } = await exec.query(
      `UPDATE meeting_summary SET status='failed', error=$2::jsonb, updated_at=now()
        WHERE meeting_id = $1 AND status IN ('queued','running')`,
      [meetingId, JSON.stringify(error)],
    );
    return (rowCount ?? 0) > 0;
  }

  /** 재생성 — 이전 결과를 지우고 queued로 되돌린다(읽기 전용이라 머지가 없다). */
  async upsertQueued(
    exec: Queryable,
    args: { meetingId: string; processingVersion: number; jobId: string; model: string },
  ) {
    await exec.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
       VALUES ($1, $2, $3, $4, 'queued')
       ON CONFLICT (meeting_id) DO UPDATE
         SET processing_version = EXCLUDED.processing_version,
             job_id = EXCLUDED.job_id, model = EXCLUDED.model, status = 'queued',
             topics = '[]'::jsonb, segments = '[]'::jsonb, error = NULL, updated_at = now()`,
      [args.meetingId, args.processingVersion, args.jobId, args.model],
    );
  }
}
