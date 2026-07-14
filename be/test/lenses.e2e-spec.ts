import { startTestDb, StartedTestDb } from './db';

describe('lenses schema', () => {
  let db: StartedTestDb;

  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('creates constrained lens records that cascade with the meeting', async () => {
    const { rows: [meeting] } = await db.pool.query(
      `INSERT INTO meeting(audio_key,status) VALUES('audio','done') RETURNING id`,
    );
    const { rows: [item] } = await db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified)
       VALUES($1,'action','문서 작성','user',true) RETURNING id`, [meeting.id],
    );
    expect(item.id).toMatch(/^lens_[1-9][0-9]*$/);
    await expect(db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified)
       VALUES($1,'topic','x','user',true)`, [meeting.id],
    )).rejects.toThrow();
    await db.pool.query(`DELETE FROM meeting WHERE id=$1`, [meeting.id]);
    expect((await db.pool.query(`SELECT 1 FROM lens_item WHERE id=$1`, [item.id])).rowCount).toBe(0);
  });
});
