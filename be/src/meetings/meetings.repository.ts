import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface MeetingRow {
  id: string; title: string | null; original_filename: string | null;
  audio_key: string; normalized_key: string | null; recorded_at: Date | null;
  duration_ms: number | null; status: string; is_favorite: boolean; current_job_id: string | null;
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
  async setFavorite(exec: Queryable, id: string, value: boolean): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(
      `UPDATE meeting SET is_favorite=$2 WHERE id=$1 RETURNING *`,
      [id, value],
    );
    return rows[0] ?? null;
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
      `SELECT u.*, s.name AS speaker_name, s.enrollment_status AS speaker_status
       FROM utterance u LEFT JOIN speaker s ON s.id = u.speaker_id
       WHERE u.meeting_id=$1 ORDER BY u.order_index ASC`,
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

  async findClusterInMeeting(exec: Queryable, meetingId: string, clusterId: string) {
    const { rows } = await exec.query(
      `SELECT id, meeting_id, diar_label, (centroid IS NOT NULL) AS has_centroid
       FROM meeting_cluster WHERE id=$1 AND meeting_id=$2`,
      [clusterId, meetingId],
    );
    return rows[0] ?? null;
  }
  async setClusterResolved(exec: Queryable, clusterId: string, speakerId: string) {
    await exec.query(`UPDATE meeting_cluster SET resolved_speaker_id=$2 WHERE id=$1`, [clusterId, speakerId]);
  }
  async bulkAssignSpeaker(exec: Queryable, meetingId: string, diarLabel: string, speakerId: string): Promise<number> {
    const res = await exec.query(
      `UPDATE utterance SET speaker_id=$3 WHERE meeting_id=$1 AND diar_label=$2`,
      [meetingId, diarLabel, speakerId],
    );
    return res.rowCount ?? 0;
  }
  // copy the cluster centroid into a voiceprint (vector stays in SQL, no JS round-trip)
  async voiceprintFromClusterCentroid(
    exec: Queryable, clusterId: string, speakerId: string, model: string, dimension: number,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source)
       SELECT $2, centroid, $3, $4, 'cluster_resolve'
       FROM meeting_cluster WHERE id=$1 AND centroid IS NOT NULL`,
      [clusterId, speakerId, model, dimension],
    );
  }

  async findReindexableMeetingIds(
    exec: Queryable, model: string, dim: number,
  ): Promise<{ id: string; processing_version: number }[]> {
    const { rows } = await exec.query<{ id: string; processing_version: number }>(
      `SELECT m.id, m.processing_version FROM meeting m
       WHERE m.status='done'
         AND NOT EXISTS (
           SELECT 1 FROM job j WHERE j.meeting_id=m.id AND j.type='index_meeting'
             AND j.status IN ('queued','running'))
         AND EXISTS (
           SELECT 1 FROM utterance u
           WHERE u.meeting_id=m.id AND u.status='ok' AND u.text IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM utterance_embedding e
               WHERE e.utterance_id=u.id AND e.model=$1 AND e.dimension=$2))`,
      [model, dim],
    );
    return rows;
  }
}
