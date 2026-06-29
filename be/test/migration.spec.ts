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

  it('004: accepts provisional, rejects bogus enrollment_status', async () => {
    await expect(
      db.pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('p','provisional')`),
    ).resolves.toBeDefined();
    await expect(
      db.pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('b','bogus')`),
    ).rejects.toThrow(/check constraint/i);
  });

  it('004: speaker_default_seq yields increasing values', async () => {
    const a = await db.pool.query(`SELECT nextval('speaker_default_seq')::int AS n`);
    const b = await db.pool.query(`SELECT nextval('speaker_default_seq')::int AS n`);
    expect(b.rows[0].n).toBeGreaterThan(a.rows[0].n);
  });

  it('004: source_cluster_id is unique when non-null, many NULL allowed', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('s') RETURNING id`);
    const c = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version)
       VALUES($1,'S0',0) RETURNING id`,
      [m.rows[0].id],
    );
    const vec = '[' + Array(192).fill(0.1).join(',') + ']';
    const insVp = (clusterId: string | null) =>
      db.pool.query(
        `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source_cluster_id)
         VALUES($1,$2::vector,'m',192,$3)`,
        [sp.rows[0].id, vec, clusterId],
      );
    await insVp(null);
    await expect(insVp(null)).resolves.toBeDefined(); // multiple NULL ok
    await insVp(c.rows[0].id);
    await expect(insVp(c.rows[0].id)).rejects.toThrow(/duplicate key|unique/i); // dup non-null
  });

  it('002: utterance_embedding + bigm index + job index_meeting/embed allowed', async () => {
    // utterance_embedding 테이블과 인덱스 존재
    const tbl = await db.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name='utterance_embedding'`,
    );
    expect(tbl.rowCount).toBe(1);
    const bigm = await db.pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='utterance_text_bigm_idx'`);
    expect(bigm.rowCount).toBe(1);
    const hnsw = await db.pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='utterance_embedding_hnsw_idx'`);
    expect(hnsw.rowCount).toBe(1);

    // job이 index_meeting type + embed stage를 받아들임
    const m = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    const job = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, stage) VALUES('index_meeting',$1,'{}'::jsonb,'embed') RETURNING type, stage`,
      [m.rows[0].id],
    );
    expect(job.rows[0].type).toBe('index_meeting');
    expect(job.rows[0].stage).toBe('embed');

    // vector(1024) 임베딩 insert 가능
    const u = await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'안녕','ok',0,0) RETURNING id`,
      [m.rows[0].id],
    );
    const vec = '[' + Array(1024).fill(0.1).join(',') + ']';
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`,
      [u.rows[0].id, vec],
    );
    const cnt = await db.pool.query(
      `SELECT count(*)::int c FROM utterance_embedding WHERE utterance_id=$1`,
      [u.rows[0].id],
    );
    expect(cnt.rows[0].c).toBe(1);
  });
});
