import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
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

  it('005: utterance_embedding.dimension CHECK enforces literal 1024', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    const u = await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'안녕','ok',0,0) RETURNING id`,
      [m.rows[0].id],
    );
    const vec = '[' + Array(1024).fill(0.1).join(',') + ']';
    // dimension=1024 → 허용
    await expect(
      db.pool.query(
        `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
         VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`,
        [u.rows[0].id, vec],
      ),
    ).resolves.toBeDefined();
    // dimension=999 (벡터는 1024차원, 다른 model이라 UNIQUE 충돌 아님) → CHECK 위반 거부
    await expect(
      db.pool.query(
        `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
         VALUES($1,$2::vector,'other',999,0)`,
        [u.rows[0].id, vec],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('005: succeeds on a DB that already holds legacy non-1024 rows (cleans them first)', async () => {
    // Fresh container migrated only through 004, so the pre-005 schema still
    // allows a mis-dimensioned utterance_embedding row (as an old misconfig would).
    const legacy = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
    const pool = new Pool({ connectionString: legacy.getConnectionUri() });
    try {
      const dir = path.join(__dirname, '..', 'src', 'database', 'migrations');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.filter((f) => f < '005')) {
        await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
      const m = (await pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
      const u = (await pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
         VALUES($1,'SPEAKER_00',0,1000,'안녕','ok',0,0) RETURNING id`, [m],
      )).rows[0].id;
      const vec = '[' + Array(1024).fill(0.1).join(',') + ']';
      // vector column is fixed vector(1024); only the dimension META column is wrong (512)
      await pool.query(
        `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
         VALUES($1,$2::vector,'legacy',512,0)`, [u, vec],
      );
      expect((await pool.query(`SELECT 1 FROM utterance_embedding WHERE dimension<>1024`)).rowCount).toBe(1);

      // migration 005 must succeed despite the legacy row, and remove it
      const sql005 = fs.readFileSync(path.join(dir, '005_search_hardening.sql'), 'utf8');
      await expect(pool.query(sql005)).resolves.toBeDefined();
      expect((await pool.query(`SELECT 1 FROM utterance_embedding WHERE dimension<>1024`)).rowCount).toBe(0);

      // and the CHECK is now enforced
      await expect(
        pool.query(
          `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
           VALUES($1,$2::vector,'other',512,0)`, [u, vec],
        ),
      ).rejects.toThrow(/check constraint/i);
    } finally {
      await pool.end();
      await legacy.stop();
    }
  });

  it('006: deletes zero-vector voiceprints and fails ready speakers left without any voiceprint', async () => {
    const legacy = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
    const pool = new Pool({ connectionString: legacy.getConnectionUri() });
    try {
      const dir = path.join(__dirname, '..', 'src', 'database', 'migrations');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.filter((f) => f < '006')) {
        await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
      const zero = '[' + Array(192).fill(0).join(',') + ']';
      const ok = '[' + Array(192).fill(0.1).join(',') + ']';
      const seedSpeaker = async (name: string, vec: string) => {
        const sp = await pool.query(
          `INSERT INTO speaker(name, enrollment_status) VALUES($1,'ready') RETURNING id`,
          [name],
        );
        await pool.query(
          `INSERT INTO voiceprint(speaker_id, embedding, model, dimension)
           VALUES($1, $2::vector, 'm', 192)`,
          [sp.rows[0].id, vec],
        );
        return sp.rows[0].id;
      };
      // zero voiceprint만 가진 ready speaker → 006 후 voiceprint 삭제 + failed 전이
      const broken = await seedSpeaker('broken', zero);
      // non-zero voiceprint를 가진 ready speaker → 그대로 유지
      const healthy = await seedSpeaker('healthy', ok);

      // 레거시 all-short 클러스터: zero centroid + provisional speaker + auto_cluster zero voiceprint
      const mtg = (await pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
      const prov = (
        await pool.query(`INSERT INTO speaker(name, enrollment_status) VALUES('prov','provisional') RETURNING id`)
      ).rows[0].id;
      const zeroClu = (
        await pool.query(
          `INSERT INTO meeting_cluster(meeting_id, diar_label, centroid, resolved_speaker_id, processing_version)
           VALUES($1,'S0',$2::vector,$3,0) RETURNING id`,
          [mtg, zero, prov],
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source, source_cluster_id)
         VALUES($1, $2::vector, 'm', 192, 'auto_cluster', $3)`,
        [prov, zero, zeroClu],
      );
      // non-zero centroid 클러스터 → 006이 건드리면 안 됨
      const okClu = (
        await pool.query(
          `INSERT INTO meeting_cluster(meeting_id, diar_label, centroid, processing_version)
           VALUES($1,'S1',$2::vector,0) RETURNING id`,
          [mtg, ok],
        )
      ).rows[0].id;

      const sql006 = fs.readFileSync(path.join(dir, '006_delete_zero_voiceprints.sql'), 'utf8');
      await pool.query(sql006);
      await expect(pool.query(sql006)).resolves.toBeDefined(); // 재실행 멱등

      expect(
        (await pool.query(`SELECT 1 FROM voiceprint WHERE speaker_id=$1`, [broken])).rowCount,
      ).toBe(0);
      const b = (
        await pool.query(`SELECT enrollment_status, enrollment_error FROM speaker WHERE id=$1`, [broken])
      ).rows[0];
      expect(b.enrollment_status).toBe('failed');
      expect(b.enrollment_error.code).toBe('sample_too_short');

      expect(
        (await pool.query(`SELECT 1 FROM voiceprint WHERE speaker_id=$1`, [healthy])).rowCount,
      ).toBe(1);
      expect(
        (await pool.query(`SELECT enrollment_status FROM speaker WHERE id=$1`, [healthy])).rows[0]
          .enrollment_status,
      ).toBe('ready');

      // provisional speaker: zero voiceprint는 삭제, speaker 행은 유지
      // (failed 전이 UPDATE는 ready만 대상이므로 provisional은 그대로)
      expect(
        (await pool.query(`SELECT 1 FROM voiceprint WHERE speaker_id=$1`, [prov])).rowCount,
      ).toBe(0);
      expect(
        (await pool.query(`SELECT enrollment_status FROM speaker WHERE id=$1`, [prov])).rows[0]
          .enrollment_status,
      ).toBe('provisional');

      // zero centroid는 NULL로 비워지되 행은 유지 — 위의 재실행 멱등 체크가
      // vector_norm(NULL) IS NULL → WHERE 자동 제외 가정도 함께 검증한다
      const zc = await pool.query(`SELECT centroid FROM meeting_cluster WHERE id=$1`, [zeroClu]);
      expect(zc.rowCount).toBe(1);
      expect(zc.rows[0].centroid).toBeNull();
      // non-zero centroid는 보존
      expect(
        (await pool.query(`SELECT centroid FROM meeting_cluster WHERE id=$1`, [okClu])).rows[0].centroid,
      ).not.toBeNull();
    } finally {
      await pool.end();
      await legacy.stop();
    }
  });

  it('generates prefixed ids by DEFAULT for all 7 tables', async () => {
    const v192 = `[${Array(192).fill(0).join(',')}]`;
    const v1024 = `[${Array(1024).fill(0).join(',')}]`;
    const spk = (await db.pool.query(`INSERT INTO speaker(name) VALUES('n') RETURNING id`)).rows[0].id;
    const mtg = (await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
    const job = (await db.pool.query(`INSERT INTO job(type,payload) VALUES('process_meeting','{}'::jsonb) RETURNING id`)).rows[0].id;
    const vp = (await db.pool.query(`INSERT INTO voiceprint(speaker_id,embedding,model,dimension) VALUES($1,$2::vector,'m',192) RETURNING id`, [spk, v192])).rows[0].id;
    const clu = (await db.pool.query(`INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version) VALUES($1,'S',0) RETURNING id`, [mtg])).rows[0].id;
    const utt = (await db.pool.query(`INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version) VALUES($1,'S',0,1,0,0) RETURNING id`, [mtg])).rows[0].id;
    const ue = (await db.pool.query(`INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version) VALUES($1,$2::vector,'m',1024,0) RETURNING id`, [utt, v1024])).rows[0].id;
    expect(spk).toMatch(/^spk_[1-9][0-9]*$/);
    expect(mtg).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(job).toMatch(/^job_[1-9][0-9]*$/);
    expect(vp).toMatch(/^vp_[1-9][0-9]*$/);
    expect(clu).toMatch(/^clu_[1-9][0-9]*$/);
    expect(utt).toMatch(/^utt_[1-9][0-9]*$/);
    expect(ue).toMatch(/^ue_[1-9][0-9]*$/);
  });

  it('rejects explicit non-conforming ids via CHECK (all 7 tables)', async () => {
    const v192 = `[${Array(192).fill(0).join(',')}]`;
    const v1024 = `[${Array(1024).fill(0).join(',')}]`;
    const spk = (await db.pool.query(`INSERT INTO speaker(name) VALUES('n') RETURNING id`)).rows[0].id;
    const mtg = (await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
    const utt = (await db.pool.query(`INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version) VALUES($1,'S',0,1,0,0) RETURNING id`, [mtg])).rows[0].id;
    const bad = 'ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca';
    const cases: [string, any[]][] = [
      [`INSERT INTO speaker(id,name) VALUES($1,'n')`, [bad]],
      [`INSERT INTO meeting(id,audio_key) VALUES($1,'k')`, [bad]],
      [`INSERT INTO job(id,type,payload) VALUES($1,'process_meeting','{}'::jsonb)`, [bad]],
      [`INSERT INTO voiceprint(id,speaker_id,embedding,model,dimension) VALUES($1,$2,$3::vector,'m',192)`, [bad, spk, v192]],
      [`INSERT INTO meeting_cluster(id,meeting_id,diar_label,processing_version) VALUES($1,$2,'S',0)`, [bad, mtg]],
      [`INSERT INTO utterance(id,meeting_id,diar_label,start_ms,end_ms,order_index,processing_version) VALUES($1,$2,'S',0,1,1,0)`, [bad, mtg]],
      [`INSERT INTO utterance_embedding(id,utterance_id,embedding,model,dimension,processing_version) VALUES($1,$2,$3::vector,'m',1024,0)`, [bad, utt, v1024]],
    ];
    for (const [sql, params] of cases) {
      await expect(db.pool.query(sql, params)).rejects.toThrow(/check constraint/);
    }
    // leading-zero / zero 도 거부
    await expect(db.pool.query(`INSERT INTO meeting(id,audio_key) VALUES('mtg_0','k')`)).rejects.toThrow(/check constraint/);
    await expect(db.pool.query(`INSERT INTO meeting(id,audio_key) VALUES('mtg_001','k')`)).rejects.toThrow(/check constraint/);
  });
});
