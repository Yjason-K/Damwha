import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export type TagRow = { id: string; name: string };
export type TagSummaryRow = TagRow & { meeting_count: number };

export function meetingTagsJson(meetingAlias: string): string {
  return `COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) ORDER BY lower(t.name) COLLATE "C")
    FROM meeting_tag mt JOIN tag t ON t.id = mt.tag_id
    WHERE mt.meeting_id = ${meetingAlias}.id
  ), '[]'::jsonb)`;
}

@Injectable()
export class TagsRepository {
  async listInUse(exec: Queryable): Promise<TagSummaryRow[]> {
    const { rows } = await exec.query<TagSummaryRow>(
      `SELECT t.id, t.name, count(*)::int AS meeting_count
       FROM tag t JOIN meeting_tag mt ON mt.tag_id = t.id
       GROUP BY t.id
       ORDER BY lower(t.name) COLLATE "C"`,
    );
    return rows;
  }

  async lockMeeting(exec: Queryable, meetingId: string): Promise<boolean> {
    const { rowCount } = await exec.query(`SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE`, [meetingId]);
    return rowCount === 1;
  }

  /** 이름들을 태그 id로 — 없는 이름은 만든다. 이미 있는 태그는 처음 만든 표기를 유지한다. */
  async ensure(exec: Queryable, names: string[]): Promise<TagRow[]> {
    if (names.length === 0) return [];
    await exec.query(
      `INSERT INTO tag(name) SELECT unnest($1::text[])
       ON CONFLICT ((lower(name))) DO NOTHING`,
      [names],
    );
    const { rows } = await exec.query<TagRow>(
      `SELECT id, name FROM tag WHERE lower(name) = ANY(SELECT lower(unnest($1::text[])))`,
      [names],
    );
    return rows;
  }

  async replaceMeetingTags(exec: Queryable, meetingId: string, tagIds: string[]): Promise<void> {
    await exec.query(
      `DELETE FROM meeting_tag WHERE meeting_id=$1 AND NOT (tag_id = ANY($2::text[]))`,
      [meetingId, tagIds],
    );
    await exec.query(
      `INSERT INTO meeting_tag(meeting_id, tag_id) SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [meetingId, tagIds],
    );
  }

  async deleteUnused(exec: Queryable): Promise<void> {
    await exec.query(
      `DELETE FROM tag t WHERE NOT EXISTS (SELECT 1 FROM meeting_tag mt WHERE mt.tag_id = t.id)`,
    );
  }

  async findForMeeting(exec: Queryable, meetingId: string): Promise<TagRow[]> {
    const { rows } = await exec.query<{ tags: TagRow[] }>(
      `SELECT ${meetingTagsJson('m')} AS tags FROM meeting m WHERE m.id=$1`,
      [meetingId],
    );
    return rows[0]?.tags ?? [];
  }
}
