import { startTestDb, StartedTestDb } from './db';

describe('job retry policy', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('defaults max_attempts to 5 for newly enqueued jobs', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','uploaded') RETURNING id`);
    const { rows } = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload) VALUES('process_meeting',$1,'{}')
       RETURNING max_attempts`, [m.rows[0].id]);
    expect(rows[0].max_attempts).toBe(5);
  });

  it('keeps an explicit max_attempts — live sessions stay at 1', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('live','recording') RETURNING id`);
    const { rows } = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, max_attempts)
       VALUES('live_session',$1,'{}',1) RETURNING max_attempts`, [m.rows[0].id]);
    expect(rows[0].max_attempts).toBe(1);
  });
});
