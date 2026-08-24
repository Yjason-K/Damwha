import { Injectable } from '@nestjs/common';
import { PoolClient, Pool } from 'pg';
import {
  EvidenceRelation, EvidenceRow, ExistingLensForMerge, LensCursor, LensItemRow, LensListFilters,
} from './lens.types';

type Exec = Pool | PoolClient;

const ITEM_COLUMNS = `
  li.id, li.meeting_id, li.kind, li.text, li.assignee_speaker_id,
  li.due_at::text AS due_at, li.completion_status, li.source,
  li.user_modified, li.lifecycle_status, li.created_at, li.updated_at,
  m.title AS meeting_title`;

@Injectable()
export class LensesRepository {
  async findById(exec: Exec, id: string): Promise<LensItemRow | null> {
    const { rows } = await exec.query<LensItemRow>(
      `SELECT ${ITEM_COLUMNS}
       FROM lens_item li JOIN meeting m ON m.id = li.meeting_id
       WHERE li.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  // Keyset-paginated list. `filters` are already validated/defaulted by the
  // service; `cursor` (if present) is the decoded { updated_at, id } tuple.
  // Fetches limit+1 so the caller can tell whether a next page exists.
  async list(
    exec: Exec,
    filters: Required<Pick<LensListFilters, 'completion_status' | 'lifecycle_status' | 'limit'>> &
      Pick<LensListFilters, 'kind' | 'meeting_id' | 'speaker_id' | 'date_from' | 'date_to'>,
    cursor: LensCursor | null,
  ): Promise<LensItemRow[]> {
    const params: unknown[] = [filters.lifecycle_status, filters.completion_status];
    const where: string[] = ['li.lifecycle_status = $1', 'li.completion_status = $2'];
    if (filters.kind) { params.push(filters.kind); where.push(`li.kind = $${params.length}`); }
    if (filters.meeting_id) { params.push(filters.meeting_id); where.push(`li.meeting_id = $${params.length}`); }
    if (filters.speaker_id) { params.push(filters.speaker_id); where.push(`li.assignee_speaker_id = $${params.length}`); }
    if (filters.date_from) { params.push(filters.date_from); where.push(`li.due_at >= $${params.length}::date`); }
    if (filters.date_to) { params.push(filters.date_to); where.push(`li.due_at <= $${params.length}::date`); }
    if (cursor) {
      params.push(cursor.updated_at);
      const u = params.length;
      params.push(cursor.id);
      const i = params.length;
      where.push(`(li.updated_at, li.id) < ($${u}::timestamptz, $${i}::text)`);
    }
    params.push(filters.limit + 1);
    const { rows } = await exec.query<LensItemRow>(
      `SELECT ${ITEM_COLUMNS}
       FROM lens_item li JOIN meeting m ON m.id = li.meeting_id
       WHERE ${where.join(' AND ')}
       ORDER BY li.updated_at DESC, li.id DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async listActiveForMeeting(exec: Exec, meetingId: string): Promise<LensItemRow[]> {
    const { rows } = await exec.query<LensItemRow>(
      `SELECT ${ITEM_COLUMNS}
       FROM lens_item li JOIN meeting m ON m.id = li.meeting_id
       WHERE li.meeting_id = $1 AND li.lifecycle_status = 'active'
       ORDER BY li.updated_at DESC, li.id DESC`,
      [meetingId],
    );
    return rows;
  }

  // The meeting's lens items with the utterance currently in each primary slot,
  // reduced to the fields classifyAiMerge needs to decide eligibility and match.
  async listForMerge(exec: Exec, meetingId: string): Promise<ExistingLensForMerge[]> {
    const { rows } = await exec.query<ExistingLensForMerge>(
      `SELECT li.id, li.kind, li.source, li.user_modified, li.lifecycle_status, li.completion_status,
         (SELECT le.utterance_id FROM lens_evidence le
          WHERE le.lens_item_id = li.id AND le.relation = 'primary') AS primary_utterance_id
       FROM lens_item li
       WHERE li.meeting_id = $1`,
      [meetingId],
    );
    return rows;
  }

  // Evidence for the given items, primary first then by utterance start.
  async findEvidence(exec: Exec, itemIds: string[]): Promise<EvidenceRow[]> {
    if (itemIds.length === 0) return [];
    const { rows } = await exec.query<EvidenceRow>(
      `SELECT le.lens_item_id, le.relation,
         json_build_object(
           'id', u.id, 'start_ms', u.start_ms, 'text', u.text, 'speaker_id', u.speaker_id
         ) AS utterance
       FROM lens_evidence le JOIN utterance u ON u.id = le.utterance_id
       WHERE le.lens_item_id = ANY($1::text[])
       ORDER BY le.lens_item_id, (le.relation <> 'primary'), u.start_ms, u.id`,
      [itemIds],
    );
    return rows;
  }

  async insert(
    exec: Exec,
    args: { meetingId: string; kind: string; text: string; assigneeSpeakerId: string | null; dueAt: string | null },
  ): Promise<string> {
    const { rows } = await exec.query<{ id: string }>(
      `INSERT INTO lens_item(meeting_id, kind, text, source, user_modified, assignee_speaker_id, due_at)
       VALUES($1,$2,$3,'user',true,$4,$5) RETURNING id`,
      [args.meetingId, args.kind, args.text, args.assigneeSpeakerId, args.dueAt],
    );
    return rows[0].id;
  }

  // Insert an AI-extracted item: source='ai', unmodified, active, open.
  async insertAi(
    exec: Exec,
    args: { meetingId: string; kind: string; text: string; assigneeSpeakerId: string | null; dueAt: string | null },
  ): Promise<string> {
    const { rows } = await exec.query<{ id: string }>(
      `INSERT INTO lens_item(meeting_id, kind, text, source, user_modified, assignee_speaker_id, due_at,
                             completion_status, lifecycle_status)
       VALUES($1,$2,$3,'ai',false,$4,$5,'open','active') RETURNING id`,
      [args.meetingId, args.kind, args.text, args.assigneeSpeakerId, args.dueAt],
    );
    return rows[0].id;
  }

  // Refresh a matched AI item's content from the extractor. Keeps source/lifecycle/
  // completion/user_modified as-is (the item stays an active, unmodified AI item).
  async updateAiFields(
    exec: Exec,
    id: string,
    args: { kind: string; text: string; assigneeSpeakerId: string | null; dueAt: string | null },
  ): Promise<void> {
    await exec.query(
      `UPDATE lens_item SET kind=$2, text=$3, assignee_speaker_id=$4, due_at=$5, updated_at=now() WHERE id=$1`,
      [id, args.kind, args.text, args.assigneeSpeakerId, args.dueAt],
    );
  }

  // Archive an AI item the merge dropped: flips lifecycle only, leaving evidence
  // and user_modified untouched (unlike the user-facing archive()).
  async archiveAi(exec: Exec, id: string): Promise<void> {
    await exec.query(`UPDATE lens_item SET lifecycle_status='archived', updated_at=now() WHERE id=$1`, [id]);
  }

  // Partial content edit. Stamps source='edited', user_modified=true when an
  // editable field is present. A no-op patch (no editable field) leaves the row —
  // including provenance and updated_at — untouched. Returns false when the item
  // does not exist.
  async update(
    exec: Exec,
    id: string,
    patch: { text?: string; kind?: string; assignee_speaker_id?: string | null; due_at?: string | null },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of ['text', 'kind', 'assignee_speaker_id', 'due_at'] as const) {
      if (key in patch) { params.push(patch[key]); sets.push(`${key}=$${params.length}`); }
    }
    if (sets.length === 0) {
      const res = await exec.query(`SELECT 1 FROM lens_item WHERE id=$1`, [id]);
      return (res.rowCount ?? 0) > 0;
    }
    sets.unshift(`source='edited'`, `user_modified=true`, `updated_at=now()`);
    const res = await exec.query(`UPDATE lens_item SET ${sets.join(', ')} WHERE id=$1`, params);
    return (res.rowCount ?? 0) > 0;
  }

  async setCompletion(exec: Exec, id: string, status: string): Promise<boolean> {
    const res = await exec.query(
      `UPDATE lens_item SET completion_status=$2, user_modified=true, updated_at=now() WHERE id=$1`,
      [id, status],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteById(exec: Exec, id: string): Promise<boolean> {
    const res = await exec.query(`DELETE FROM lens_item WHERE id=$1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async touch(exec: Exec, id: string): Promise<void> {
    await exec.query(`UPDATE lens_item SET user_modified=true, updated_at=now() WHERE id=$1`, [id]);
  }

  // The utterance_id currently holding the item's primary evidence slot, or null if none.
  async findPrimaryEvidenceUtteranceId(exec: Exec, lensId: string): Promise<string | null> {
    const { rows } = await exec.query<{ utterance_id: string }>(
      `SELECT utterance_id FROM lens_evidence WHERE lens_item_id=$1 AND relation='primary'`,
      [lensId],
    );
    return rows[0]?.utterance_id ?? null;
  }

  async upsertEvidence(exec: Exec, lensId: string, utteranceId: string, relation: EvidenceRelation): Promise<void> {
    await exec.query(
      `INSERT INTO lens_evidence(lens_item_id, utterance_id, relation) VALUES($1,$2,$3)
       ON CONFLICT (lens_item_id, utterance_id) DO UPDATE SET relation = EXCLUDED.relation`,
      [lensId, utteranceId, relation],
    );
  }

  // Drop all evidence for an item, used to replace a merged AI item's evidence set.
  async deleteAllEvidence(exec: Exec, lensId: string): Promise<void> {
    await exec.query(`DELETE FROM lens_evidence WHERE lens_item_id=$1`, [lensId]);
  }

  async deleteEvidence(exec: Exec, lensId: string, utteranceId: string): Promise<EvidenceRelation | null> {
    const { rows } = await exec.query<{ relation: EvidenceRelation }>(
      `DELETE FROM lens_evidence WHERE lens_item_id=$1 AND utterance_id=$2 RETURNING relation`,
      [lensId, utteranceId],
    );
    return rows[0]?.relation ?? null;
  }

  async meetingExists(exec: Exec, meetingId: string): Promise<boolean> {
    const { rowCount } = await exec.query(`SELECT 1 FROM meeting WHERE id=$1`, [meetingId]);
    return (rowCount ?? 0) > 0;
  }

  async speakerHasUtteranceInMeeting(exec: Exec, meetingId: string, speakerId: string): Promise<boolean> {
    const { rowCount } = await exec.query(
      `SELECT 1 FROM utterance WHERE meeting_id=$1 AND speaker_id=$2 LIMIT 1`,
      [meetingId, speakerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async utteranceInMeeting(exec: Exec, meetingId: string, utteranceId: string): Promise<boolean> {
    const { rowCount } = await exec.query(
      `SELECT 1 FROM utterance WHERE id=$1 AND meeting_id=$2`,
      [utteranceId, meetingId],
    );
    return (rowCount ?? 0) > 0;
  }
}
