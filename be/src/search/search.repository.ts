import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface SearchFilters {
  dateFrom: string | null;
  dateTo: string | null;
  speakerIds: string[] | null;
  meetingIds: string[] | null;
}

export interface SearchRow {
  utterance_id: string;
  meeting_id: string;
  meeting_title: string | null;
  recorded_at: Date | null;
  speaker_id: string | null;
  speaker_name: string | null;
  diar_label: string;
  start_ms: number;
  end_ms: number;
  text: string | null;
  score: number;
}

// 모든 arm/browse가 공유하는 필터 WHERE. $base 이후 4개 파라미터를 소비.
// f1=dateFrom f2=dateTo f3=speakerIds(text[]) f4=meetingIds(text[])
function filterSql(alias: string, f1: number, f2: number, f3: number, f4: number): string {
  return `
    AND ($${f1}::timestamptz IS NULL OR m.recorded_at >= $${f1}::timestamptz)
    AND ($${f2}::timestamptz IS NULL OR m.recorded_at <  $${f2}::timestamptz)
    AND ($${f3}::text[] IS NULL OR ${alias}.speaker_id = ANY($${f3}::text[]))
    AND ($${f4}::text[] IS NULL OR ${alias}.meeting_id = ANY($${f4}::text[]))`;
}

const SELECT_COLS = `
  u.id AS utterance_id, u.meeting_id, m.title AS meeting_title, m.recorded_at,
  u.speaker_id, s.name AS speaker_name, u.diar_label, u.start_ms, u.end_ms, u.text`;

@Injectable()
export class SearchRepository {
  async hybrid(
    exec: Queryable,
    args: { q: string; qvec: number[] | null; filters: SearchFilters; limit: number; candK: number; rrfK: number; model: string; dim: number },
  ): Promise<SearchRow[]> {
    const f = args.filters;
    const vec = args.qvec ? '[' + args.qvec.join(',') + ']' : null;
    // params: 1=q 2=candK 3=qvec 4=model 5=dim 6=rrfK 7=limit+1 8..11=filters
    const sql = `
      WITH kw AS (
        SELECT u.id AS utterance_id,
               row_number() OVER (ORDER BY bigm_similarity(u.text, $1) DESC) AS rnk
        FROM utterance u JOIN meeting m ON m.id = u.meeting_id
        WHERE u.status='ok' AND u.text IS NOT NULL AND u.text LIKE likequery($1)
              ${filterSql('u', 8, 9, 10, 11)}
        ORDER BY bigm_similarity(u.text, $1) DESC LIMIT $2
      ),
      sem AS (
        SELECT u.id AS utterance_id,
               row_number() OVER (ORDER BY e.embedding <=> $3::vector) AS rnk
        FROM utterance_embedding e
        JOIN utterance u ON u.id = e.utterance_id
        JOIN meeting m ON m.id = u.meeting_id
        WHERE e.model=$4 AND e.dimension=$5 AND u.status='ok'
              AND $3::text IS NOT NULL
              ${filterSql('u', 8, 9, 10, 11)}
        ORDER BY e.embedding <=> $3::vector LIMIT $2
      ),
      fused AS (
        SELECT COALESCE(kw.utterance_id, sem.utterance_id) AS utterance_id,
               COALESCE(1.0/($6 + kw.rnk), 0) + COALESCE(1.0/($6 + sem.rnk), 0) AS score
        FROM kw FULL OUTER JOIN sem USING (utterance_id)
      )
      SELECT ${SELECT_COLS}, f.score
      FROM fused f
      JOIN utterance u ON u.id = f.utterance_id
      JOIN meeting m ON m.id = u.meeting_id
      LEFT JOIN speaker s ON s.id = u.speaker_id
      ORDER BY f.score DESC, u.meeting_id, u.order_index
      LIMIT $7`;
    const { rows } = await exec.query<SearchRow>(sql, [
      args.q, args.candK, vec, args.model, args.dim, args.rrfK, args.limit + 1,
      f.dateFrom, f.dateTo, f.speakerIds, f.meetingIds,
    ]);
    return rows;
  }

  async keyword(
    exec: Queryable, args: { q: string; filters: SearchFilters; limit: number; candK: number },
  ): Promise<SearchRow[]> {
    const f = args.filters;
    // candK is accepted for caller symmetry with hybrid() but unused here:
    // standalone keyword has a single ranking, so it fetches limit+1 directly
    // (no candidate over-fetch + re-rank stage like the fused hybrid path).
    // params: 1=q 2=limit+1 3..6=filters
    const sql = `
      SELECT ${SELECT_COLS}, bigm_similarity(u.text, $1) AS score
      FROM utterance u
      JOIN meeting m ON m.id = u.meeting_id
      LEFT JOIN speaker s ON s.id = u.speaker_id
      WHERE u.status='ok' AND u.text IS NOT NULL AND u.text LIKE likequery($1)
            ${filterSql('u', 3, 4, 5, 6)}
      ORDER BY bigm_similarity(u.text, $1) DESC, u.meeting_id, u.order_index
      LIMIT $2`;
    const { rows } = await exec.query<SearchRow>(sql, [
      args.q, args.limit + 1, f.dateFrom, f.dateTo, f.speakerIds, f.meetingIds,
    ]);
    return rows;
  }

  async browse(
    exec: Queryable, args: { filters: SearchFilters; limit: number },
  ): Promise<SearchRow[]> {
    const f = args.filters;
    // params: 1=limit+1 2..5=filters
    const sql = `
      SELECT ${SELECT_COLS}, 0::float8 AS score
      FROM utterance u
      JOIN meeting m ON m.id = u.meeting_id
      LEFT JOIN speaker s ON s.id = u.speaker_id
      WHERE u.status='ok' AND u.text IS NOT NULL
            ${filterSql('u', 2, 3, 4, 5)}
      ORDER BY m.recorded_at DESC NULLS LAST, m.created_at DESC, u.order_index
      LIMIT $1`;
    const { rows } = await exec.query<SearchRow>(sql, [
      args.limit + 1, f.dateFrom, f.dateTo, f.speakerIds, f.meetingIds,
    ]);
    return rows;
  }
}
