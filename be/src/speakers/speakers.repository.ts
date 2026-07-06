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
  async rename(exec: Queryable, id: string, name: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(
      `UPDATE speaker
       SET name=$2,
           enrollment_status = CASE WHEN enrollment_status='provisional' THEN 'ready'
                                    ELSE enrollment_status END
       WHERE id=$1 RETURNING *`,
      [id, name],
    );
    return rows[0] ?? null;
  }
  async lockById(exec: Queryable, id: string): Promise<SpeakerRow | null> {
    const { rows } = await exec.query<SpeakerRow>(`SELECT * FROM speaker WHERE id=$1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }
  // True while the speaker's current enroll job is queued/running (no FK job→speaker,
  // so we join via speaker.current_job_id).
  async hasActiveEnrollJob(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(
      `SELECT 1 FROM speaker s JOIN job j ON j.id = s.current_job_id
       WHERE s.id=$1 AND j.type='enroll_speaker' AND j.status IN ('queued','running')`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }
  // True while ANY process_meeting job is queued/running. Broad by design: the
  // worker's identify stage can bind THIS speaker to utterances minutes before
  // persist inserts them, so we cannot tell in advance which speaker a running
  // pipeline will pick. Deleting mid-pipeline would FK-violate at persist and
  // trigger a retry storm. Acceptable for a single-user tool.
  async hasActiveProcessMeetingJob(exec: Queryable): Promise<boolean> {
    const res = await exec.query(
      `SELECT 1 FROM job WHERE type='process_meeting' AND status IN ('queued','running') LIMIT 1`,
    );
    return (res.rowCount ?? 0) > 0;
  }
  // NO ACTION FKs (utterance.speaker_id, meeting_cluster.resolved_speaker_id) block a
  // raw DELETE, so clear them first; voiceprints then cascade on DELETE speaker.
  async unreferenceUtterances(exec: Queryable, id: string): Promise<void> {
    await exec.query(`UPDATE utterance SET speaker_id=NULL WHERE speaker_id=$1`, [id]);
  }
  async unreferenceClusters(exec: Queryable, id: string): Promise<void> {
    await exec.query(`UPDATE meeting_cluster SET resolved_speaker_id=NULL WHERE resolved_speaker_id=$1`, [id]);
  }
  async deleteById(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(`DELETE FROM speaker WHERE id=$1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
