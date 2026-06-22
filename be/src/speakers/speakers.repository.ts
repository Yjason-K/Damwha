import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface SpeakerRow {
  id: string; name: string; enrollment_status: string;
  current_job_id: string | null; enrollment_error: any; created_at: Date;
}

@Injectable()
export class SpeakersRepository {
  async create(exec: Queryable, id: string, name: string): Promise<SpeakerRow> {
    const { rows } = await exec.query<SpeakerRow>(
      `INSERT INTO speaker(id, name, enrollment_status) VALUES($1,$2,'pending') RETURNING *`,
      [id, name],
    );
    return rows[0];
  }
  async setCurrentJob(exec: Queryable, id: string, jobId: string): Promise<SpeakerRow> {
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker SET current_job_id=$2 WHERE id=$1 RETURNING *`, [id, jobId],
    );
    return rows[0];
  }
  async list(exec: Queryable): Promise<SpeakerRow[]> {
    const { rows } = await exec.query<SpeakerRow>(`SELECT * FROM speaker ORDER BY created_at DESC`);
    return rows;
  }
  async findById(exec: Queryable, id: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(`SELECT * FROM speaker WHERE id=$1`, [id]);
    return rows[0] ?? null;
  }
}
