import { startTestDb, StartedTestDb } from './db';

describe('migration', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db?.stop(); });

  it('creates all tables', async () => {
    const { rows } = await db.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'job', 'meeting', 'meeting_cluster', 'speaker', 'utterance', 'voiceprint',
      ]),
    );
  });

  it('enables pgvector and accepts a 192-dim vector', async () => {
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('t') RETURNING id`);
    const vec = '[' + Array(192).fill(0.1).join(',') + ']';
    await expect(
      db.pool.query(
        `INSERT INTO voiceprint(speaker_id, embedding, model, dimension)
         VALUES($1, $2::vector, 'm', 192)`,
        [sp.rows[0].id, vec],
      ),
    ).resolves.toBeDefined();
  });

  it('enforces utterance UNIQUE(meeting_id, order_index)', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`,
    );
    const mid = m.rows[0].id;
    const ins = (i: number) =>
      db.pool.query(
        `INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, order_index, processing_version)
         VALUES($1,'SPEAKER_00',0,1,$2,0)`,
        [mid, i],
      );
    await ins(0);
    await expect(ins(0)).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects invalid job.status via CHECK', async () => {
    await expect(
      db.pool.query(`INSERT INTO job(type, payload, status) VALUES('process_meeting','{}','bogus')`),
    ).rejects.toThrow(/check constraint/i);
  });
});
