import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { SavedCursor, SavedUtteranceRow } from './saved-utterances.types';

type Exec = Pool | PoolClient;

// Both keys are truncated to milliseconds because that is all a JS Date — and
// so an encoded cursor — can carry. Comparing an untruncated column against a
// millisecond cursor rounds past rows and silently drops a page of results.
const MEETING_KEY = `date_trunc('milliseconds', COALESCE(m.recorded_at, m.created_at))`;
const ITEM_KEY = `date_trunc('milliseconds', su.created_at)`;

// Meetings run newest-recorded first and saves sort within their meeting. All
// four keys descend, so the keyset predicate is a single row-wise comparison
// over the same tuple the ORDER BY uses.
const LIST_KEYSET = `(${MEETING_KEY}, su.meeting_id, ${ITEM_KEY}, su.id)`;
const LIST_ORDER = `${MEETING_KEY} DESC, su.meeting_id DESC, ${ITEM_KEY} DESC, su.id DESC`;

const COLUMNS = `
  su.id, su.utterance_id, su.text_snapshot AS text,
  u.speaker_id, COALESCE(s.name, su.speaker_name_snapshot) AS speaker_name,
  COALESCE(u.start_ms, su.start_ms_snapshot) AS start_ms,
  su.created_at, m.id AS meeting_id, m.title AS meeting_title, m.recorded_at,
  ${MEETING_KEY} AS meeting_sort_at`;

@Injectable()
export class SavedUtterancesRepository {
  async findSaveCandidate(exec: Exec, utteranceId: string) {
    const { rows } = await exec.query<{ id: string; meeting_id: string; start_ms: number; speaker_name: string | null }>(
      `SELECT u.id, u.meeting_id, u.start_ms, s.name AS speaker_name
       FROM utterance u JOIN meeting m ON m.id=u.meeting_id
       LEFT JOIN speaker s ON s.id=u.speaker_id
       WHERE u.id=$1 AND u.status='ok' AND u.processing_version=m.processing_version`,
      [utteranceId],
    );
    return rows[0] ?? null;
  }

  async save(exec: Exec, args: { utteranceId: string; meetingId: string; text: string; speakerName: string | null; startMs: number }) {
    const { rows } = await exec.query<{ id: string }>(
      `INSERT INTO saved_utterance(utterance_id, meeting_id, text_snapshot, speaker_name_snapshot, start_ms_snapshot)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (utterance_id) DO UPDATE SET utterance_id=EXCLUDED.utterance_id
       RETURNING id`,
      [args.utteranceId, args.meetingId, args.text, args.speakerName, args.startMs],
    );
    return rows[0].id;
  }

  async findById(exec: Exec, id: string): Promise<SavedUtteranceRow | null> {
    const { rows } = await exec.query<SavedUtteranceRow>(
      `SELECT ${COLUMNS} FROM saved_utterance su JOIN meeting m ON m.id=su.meeting_id
       LEFT JOIN utterance u ON u.id=su.utterance_id LEFT JOIN speaker s ON s.id=u.speaker_id WHERE su.id=$1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async list(exec: Exec, limit: number, cursor: SavedCursor | null): Promise<SavedUtteranceRow[]> {
    const params: unknown[] = [];
    let where = '';
    if (cursor) {
      params.push(cursor.meeting_at, cursor.meeting_id, cursor.created_at, cursor.id);
      where = `WHERE ${LIST_KEYSET} < ($1::timestamptz,$2::text,$3::timestamptz,$4::text)`;
    }
    params.push(limit + 1);
    const { rows } = await exec.query<SavedUtteranceRow>(
      `SELECT ${COLUMNS} FROM saved_utterance su JOIN meeting m ON m.id=su.meeting_id
       LEFT JOIN utterance u ON u.id=su.utterance_id LEFT JOIN speaker s ON s.id=u.speaker_id
       ${where} ORDER BY ${LIST_ORDER} LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  // Keyed by meeting, not by an id list: a transcript can hold thousands of
  // utterances, and asking "which of these are saved?" one id at a time put
  // every one of them in the query string.
  async savedIdsByMeeting(exec: Exec, meetingId: string) {
    const { rows } = await exec.query<{ utterance_id: string }>(
      `SELECT utterance_id FROM saved_utterance WHERE meeting_id=$1`, [meetingId],
    );
    return rows.map((row) => row.utterance_id);
  }

  async remove(exec: Exec, utteranceId: string) {
    await exec.query(`DELETE FROM saved_utterance WHERE utterance_id=$1`, [utteranceId]);
  }
}
