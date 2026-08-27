import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface MeetingRow {
  id: string; title: string | null; original_filename: string | null;
  audio_key: string; normalized_key: string | null; recorded_at: Date | null;
  duration_ms: number | null; status: string; is_favorite: boolean; current_job_id: string | null;
  processing_version: number; error: any; created_at: Date;
}

export interface ClusterRow {
  id: string; diar_label: string; resolved_speaker_id: string | null;
  speaker_name: string | null; speaker_status: string | null;
  // Set when identification scored a known speaker inside the too-close-to-call
  // band: the cluster still has its own speaker, and this is the merge the user
  // is being offered. Null once resolved.
  suggested_speaker_id: string | null; suggested_speaker_name: string | null;
  suggested_similarity: number | null;
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
  // Partial update of title/recorded_at. Only keys present in `patch` are written;
  // an empty patch falls back to a plain SELECT (so 404 detection still works).
  async update(
    exec: Queryable,
    id: string,
    patch: { title?: string | null; recorded_at?: string | null },
  ): Promise<MeetingRow | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    if ('title' in patch) {
      params.push(patch.title);
      sets.push(`title=$${params.length}`);
    }
    if ('recorded_at' in patch) {
      params.push(patch.recorded_at);
      sets.push(`recorded_at=$${params.length}`);
    }
    if (sets.length === 0) {
      const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting WHERE id=$1`, [id]);
      return rows[0] ?? null;
    }
    const { rows } = await exec.query<MeetingRow>(
      `UPDATE meeting SET ${sets.join(', ')} WHERE id=$1 RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  }
  // Cascade (001/002/003 schema) removes clusters/utterances/embeddings/jobs.
  async deleteById(exec: Queryable, id: string): Promise<boolean> {
    const res = await exec.query(`DELETE FROM meeting WHERE id=$1`, [id]);
    return (res.rowCount ?? 0) > 0;
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
       FROM utterance u
       JOIN meeting m ON m.id = u.meeting_id
       LEFT JOIN speaker s ON s.id = u.speaker_id
       WHERE u.meeting_id=$1 AND u.processing_version=m.processing_version
       ORDER BY u.order_index ASC`,
      [meetingId],
    );
    return rows;
  }
  // Clusters for the meeting at its CURRENT processing_version (older reprocess
  // rounds are hidden). LEFT JOIN speaker so unresolved clusters yield null
  // speaker fields. These carry the clu_<n> ids the resolve endpoint needs.
  async findClusters(exec: Queryable, meetingId: string): Promise<ClusterRow[]> {
    const { rows } = await exec.query<ClusterRow>(
      `SELECT c.id, c.diar_label, c.resolved_speaker_id,
              s.name AS speaker_name, s.enrollment_status AS speaker_status,
              c.suggested_speaker_id, c.suggested_similarity,
              sg.name AS suggested_speaker_name
       FROM meeting_cluster c
       JOIN meeting m ON m.id = c.meeting_id
       LEFT JOIN speaker s ON s.id = c.resolved_speaker_id
       LEFT JOIN speaker sg ON sg.id = c.suggested_speaker_id
       WHERE c.meeting_id=$1 AND c.processing_version = m.processing_version
       ORDER BY c.diar_label ASC`,
      [meetingId],
    );
    return rows;
  }
  async findStatus(exec: Queryable, id: string) {
    const { rows } = await exec.query(
      `SELECT m.status, j.stage, j.progress, m.error,
              CASE WHEN ler.id IS NULL THEN NULL ELSE jsonb_build_object(
                'status', ler.status,
                'model', ler.model,
                'error', ler.error,
                'finished_at', ler.finished_at
              ) END AS lens_extraction,
              CASE WHEN ij.id IS NULL THEN NULL ELSE jsonb_build_object(
                'status', ij.status,
                'error', ij.error,
                'updated_at', ij.updated_at
              ) END AS search_index
       FROM meeting m
       LEFT JOIN job j ON j.id = m.current_job_id
       LEFT JOIN LATERAL (
         SELECT id, status, model, error, finished_at
         FROM lens_extraction_run
         WHERE meeting_id=m.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) ler ON true
       LEFT JOIN LATERAL (
         SELECT id, status, error, updated_at
         FROM job
         WHERE meeting_id=m.id AND type='index_meeting'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) ij ON true
       WHERE m.id=$1`,
      [id],
    );
    return rows[0] ?? null;
  }
  // reprocess: bump version + reset status, return new version (single short tx via caller)
  async lockById(exec: Queryable, id: string): Promise<MeetingRow | null> {
    const { rows } = await exec.query<MeetingRow>(`SELECT * FROM meeting WHERE id=$1 FOR UPDATE`, [id]);
    return rows[0] ?? null;
  }

  /** 운영자 취소 — 워커의 fail 경로는 job 소유권 가드에 막혀 회의 상태를 못 바꾸므로 API가 직접 닫는다. */
  async markCancelled(exec: Queryable, id: string, error: object): Promise<void> {
    await exec.query(
      `UPDATE meeting SET status='failed', error=$2::jsonb WHERE id=$1`,
      [id, JSON.stringify(error)],
    );
  }

  async bumpVersionForReprocess(exec: Queryable, id: string): Promise<number> {
    const { rows } = await exec.query<{ processing_version: number }>(
      `UPDATE meeting SET processing_version = processing_version + 1, status='uploaded', error=NULL
       WHERE id=$1 RETURNING processing_version`,
      [id],
    );
    return rows[0].processing_version;
  }

  async lockClusterInMeeting(exec: Queryable, meetingId: string, clusterId: string) {
    const { rows } = await exec.query(
      `SELECT id, meeting_id, diar_label, resolved_speaker_id, (centroid IS NOT NULL) AS has_centroid
       FROM meeting_cluster WHERE id=$1 AND meeting_id=$2 FOR UPDATE`,
      [clusterId, meetingId],
    );
    return rows[0] ?? null;
  }

  async lockSpeakers(
    exec: Queryable,
    ids: string[],
  ): Promise<{ id: string; enrollment_status: string }[]> {
    if (ids.length === 0) return [];
    const { rows } = await exec.query<{ id: string; enrollment_status: string }>(
      `SELECT id, enrollment_status FROM speaker WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    return rows;
  }

  async createReadySpeaker(exec: Queryable, name: string): Promise<string> {
    const { rows } = await exec.query<{ id: string }>(
      `INSERT INTO speaker(name, enrollment_status) VALUES($1,'ready') RETURNING id`,
      [name],
    );
    return rows[0].id;
  }

  async promoteProvisional(exec: Queryable, id: string, name: string): Promise<void> {
    await exec.query(
      `UPDATE speaker SET name=$2, enrollment_status='ready'
       WHERE id=$1 AND enrollment_status='provisional'`,
      [id, name],
    );
  }

  // Resolving answers whatever the suggestion was asking, so it clears with the
  // binding — leaving it would re-offer a merge the user has just decided.
  async setClusterResolved(exec: Queryable, clusterId: string, speakerId: string) {
    await exec.query(
      `UPDATE meeting_cluster
       SET resolved_speaker_id=$2, suggested_speaker_id=NULL, suggested_similarity=NULL
       WHERE id=$1`,
      [clusterId, speakerId],
    );
  }
  async bulkAssignSpeaker(exec: Queryable, meetingId: string, diarLabel: string, speakerId: string): Promise<number> {
    const res = await exec.query(
      `UPDATE utterance SET speaker_id=$3 WHERE meeting_id=$1 AND diar_label=$2`,
      [meetingId, diarLabel, speakerId],
    );
    return res.rowCount ?? 0;
  }

  // reattach (or insert) the single cluster-derived voiceprint to the final speaker (idempotent)
  async upsertClusterVoiceprint(
    exec: Queryable, clusterId: string, speakerId: string, model: string, dimension: number,
  ): Promise<void> {
    await exec.query(
      `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source, source_cluster_id)
       SELECT $2, centroid, $3, $4, 'cluster_resolve', id
       FROM meeting_cluster WHERE id=$1 AND centroid IS NOT NULL
       ON CONFLICT (source_cluster_id) WHERE source_cluster_id IS NOT NULL
       DO UPDATE SET speaker_id = EXCLUDED.speaker_id`,
      [clusterId, speakerId, model, dimension],
    );
  }

  async deleteOrphanProvisional(exec: Queryable, speakerId: string): Promise<boolean> {
    const res = await exec.query(
      `DELETE FROM speaker s
       WHERE s.id=$1 AND s.enrollment_status='provisional'
         AND NOT EXISTS (SELECT 1 FROM utterance WHERE speaker_id=s.id)
         AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id=s.id)
         AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE suggested_speaker_id=s.id)`,
      [speakerId],
    );
    return (res.rowCount ?? 0) > 0;
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
