import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface MeetingRow {
  id: string; title: string | null; original_filename: string | null;
  audio_key: string; normalized_key: string | null; recorded_at: Date | null;
  duration_ms: number | null; status: string; current_job_id: string | null;
  processing_version: number; error: any; created_at: Date;
}

@Injectable()
export class MeetingsRepository {
  async create(
    exec: Queryable,
    args: { audioKey: string; title: string | null; originalFilename: string | null; recordedAt: string | null },
  ): Promise<MeetingRow> {
    const { rows } = await exec.query<MeetingRow>(
      `INSERT INTO meeting(title, original_filename, audio_key, recorded_at, status)
       VALUES($1,$2,$3,$4,'uploaded') RETURNING *`,
      [args.title, args.originalFilename, args.audioKey, args.recordedAt],
    );
    return rows[0];
  }
  async setCurrentJob(exec: Queryable, meetingId: string, jobId: string): Promise<MeetingRow> {
    const { rows } = await exec.query<MeetingRow>(
      `UPDATE meeting SET current_job_id=$2 WHERE id=$1 RETURNING *`,
      [meetingId, jobId],
    );
    return rows[0];
  }
  async list(exec: Queryable): Promise<MeetingRow[]> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting ORDER BY created_at DESC`);
    return rows;
  }
  async findById(exec: Queryable, id: string): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
  async findUtterances(exec: Queryable, meetingId: string) {
    const { rows } = await exec.query(
      `SELECT * FROM utterance WHERE meeting_id=$1 ORDER BY order_index ASC`,
      [meetingId],
    );
    return rows;
  }
  async findStatus(exec: Queryable, id: string) {
    const { rows } = await exec.query(
      `SELECT m.status, j.stage, j.progress, m.error
       FROM meeting m LEFT JOIN job j ON j.id = m.current_job_id
       WHERE m.id=$1`,
      [id],
    );
    return rows[0] ?? null;
  }
  // reprocess: bump version + reset status, return new version (single short tx via caller)
  async bumpVersionForReprocess(exec: Queryable, id: string): Promise<number> {
    const { rows } = await exec.query<{ processing_version: number }>(
      `UPDATE meeting SET processing_version = processing_version + 1, status='uploaded', error=NULL
       WHERE id=$1 RETURNING processing_version`,
      [id],
    );
    return rows[0].processing_version;
  }
}
