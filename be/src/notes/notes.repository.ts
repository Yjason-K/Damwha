import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

type Exec = Pool | PoolClient;

export type NoteRow = { body_md: string; updated_at: Date };

@Injectable()
export class NotesRepository {
  async meetingExists(exec: Exec, meetingId: string): Promise<boolean> {
    const { rowCount } = await exec.query('SELECT 1 FROM meeting WHERE id=$1', [meetingId]);
    return rowCount === 1;
  }

  async find(exec: Exec, meetingId: string): Promise<NoteRow | null> {
    const { rows } = await exec.query<NoteRow>(
      'SELECT body_md, updated_at FROM meeting_note WHERE meeting_id=$1',
      [meetingId],
    );
    return rows[0] ?? null;
  }

  // 회의당 1행이 UNIQUE로 보장되므로 업서트는 단일 문장이면 충분하다 —
  // 읽고-쓰는 트랜잭션이 필요 없다.
  async upsert(exec: Exec, meetingId: string, bodyMd: string): Promise<NoteRow> {
    const { rows } = await exec.query<NoteRow>(
      `INSERT INTO meeting_note(meeting_id, body_md) VALUES($1,$2)
       ON CONFLICT (meeting_id)
       DO UPDATE SET body_md=EXCLUDED.body_md, updated_at=now()
       RETURNING body_md, updated_at`,
      [meetingId, bodyMd],
    );
    return rows[0];
  }

  async remove(exec: Exec, meetingId: string): Promise<void> {
    await exec.query('DELETE FROM meeting_note WHERE meeting_id=$1', [meetingId]);
  }
}
