import { startTestDb, StartedTestDb } from './db';

describe('lens extraction execution history schema', () => {
  let db: StartedTestDb;

  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('allows one queued or running run per meeting version, while preserving done history', async () => {
    const { rows: [meeting] } = await db.pool.query(
      `INSERT INTO meeting(audio_key,status) VALUES('audio','done') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id,processing_version,status)
       VALUES($1,0,'queued')`, [meeting.id],
    );
    await expect(db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id,processing_version,status)
       VALUES($1,0,'queued')`, [meeting.id],
    )).rejects.toThrow(/duplicate key|unique/i);
    await db.pool.query(
      `UPDATE lens_extraction_run SET status='done'
       WHERE meeting_id=$1 AND processing_version=0`, [meeting.id],
    );
    await expect(db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id,processing_version,status)
       VALUES($1,0,'done')`, [meeting.id],
    )).resolves.toBeDefined();
  });
});
