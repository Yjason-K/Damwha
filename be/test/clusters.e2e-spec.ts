import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { once } from 'events';
import type { PoolClient } from 'pg';

describe('cluster resolve', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });
  const srv = () => app.getHttpServer();

  // seed: meeting + one unidentified cluster (with centroid) + two utterances on that label
  async function seed() {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const vec = '[' + Array(192).fill(0.2).join(',') + ']';
    const c = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,centroid,processing_version)
       VALUES($1,'SPEAKER_00',$2::vector,0) RETURNING id`, [mid, vec]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1,0,0),($1,'SPEAKER_00',2,3,1,0)`, [mid]);
    return { mid, clusterId: c.rows[0].id as string };
  }

  it('resolves to a NEW speaker (ready), bulk-updates utterances, stores a voiceprint', async () => {
    const { mid, clusterId } = await seed();
    const res = await request(srv())
      .post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: '박지원' });
    expect(res.status).toBe(200);
    expect(res.body.updated_utterances).toBe(2);

    const sp = await db.pool.query('SELECT * FROM speaker WHERE id=$1', [res.body.speaker_id]);
    expect(sp.rows[0].enrollment_status).toBe('ready');
    expect(sp.rows[0].name).toBe('박지원');

    const utt = await db.pool.query('SELECT speaker_id FROM utterance WHERE meeting_id=$1', [mid]);
    expect(utt.rows.every((u) => u.speaker_id === res.body.speaker_id)).toBe(true);

    const vp = await db.pool.query('SELECT source FROM voiceprint WHERE speaker_id=$1', [res.body.speaker_id]);
    expect(vp.rows.length).toBe(1);
    expect(vp.rows[0].source).toBe('cluster_resolve');

    const cl = await db.pool.query('SELECT resolved_speaker_id FROM meeting_cluster WHERE id=$1', [clusterId]);
    expect(cl.rows[0].resolved_speaker_id).toBe(res.body.speaker_id);
  });

  it('resolves to an EXISTING speaker', async () => {
    const { mid, clusterId } = await seed();
    const ex = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('기존','ready') RETURNING id`);
    const res = await request(srv())
      .post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: ex.rows[0].id });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(ex.rows[0].id);
    expect(res.body.updated_utterances).toBe(2);
  });

  it('confirming a suggested merge binds the candidate and clears the suggestion', async () => {
    // This is the whole point of the band: identify parks a candidate, the user
    // accepts it through the normal resolve endpoint, and the question is settled
    // so the next page load does not re-offer a merge already answered.
    const { mid, clusterId } = await seed();
    const cand = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('이수민','ready') RETURNING id`);
    await db.pool.query(
      `UPDATE meeting_cluster SET suggested_speaker_id=$2, suggested_similarity=0.72 WHERE id=$1`,
      [clusterId, cand.rows[0].id]);

    const res = await request(srv())
      .post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: cand.rows[0].id });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(cand.rows[0].id);

    const row = await db.pool.query(
      'SELECT resolved_speaker_id, suggested_speaker_id, suggested_similarity FROM meeting_cluster WHERE id=$1',
      [clusterId]);
    expect(row.rows[0].resolved_speaker_id).toBe(cand.rows[0].id);
    expect(row.rows[0].suggested_speaker_id).toBeNull();
    expect(row.rows[0].suggested_similarity).toBeNull();
  });

  it('rejecting a suggestion by resolving elsewhere also clears it', async () => {
    const { mid, clusterId } = await seed();
    const cand = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('오답','ready') RETURNING id`);
    await db.pool.query(
      `UPDATE meeting_cluster SET suggested_speaker_id=$2, suggested_similarity=0.61 WHERE id=$1`,
      [clusterId, cand.rows[0].id]);

    const res = await request(srv())
      .post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: '정답' });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).not.toBe(cand.rows[0].id);

    const row = await db.pool.query(
      'SELECT suggested_speaker_id, suggested_similarity FROM meeting_cluster WHERE id=$1', [clusterId]);
    expect(row.rows[0].suggested_speaker_id).toBeNull();
    expect(row.rows[0].suggested_similarity).toBeNull();
  });

  it('404 when cluster does not belong to meeting', async () => {
    const { clusterId } = await seed();
    const other = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k2','done') RETURNING id`);
    const res = await request(srv())
      .post(`/meetings/${other.rows[0].id}/clusters/${clusterId}/resolve`).send({ new_name: 'x' });
    expect(res.status).toBe(404);
  });

  it('400 when neither speaker_id nor new_name provided', async () => {
    const { mid, clusterId } = await seed();
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({});
    expect(res.status).toBe(400);
  });

  // seed a meeting with an auto-created provisional speaker for one cluster (mirrors persist)
  async function seedProvisional() {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key,status) VALUES('k','done') RETURNING id`);
    const mid = m.rows[0].id;
    const vec = '[' + Array(192).fill(0.2).join(',') + ']';
    const sp = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Speaker_001','provisional') RETURNING id`);
    const spId = sp.rows[0].id as string;
    const c = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,centroid,resolved_speaker_id,processing_version)
       VALUES($1,'SPEAKER_00',$2::vector,$3,0) RETURNING id`, [mid, vec, spId]);
    const cid = c.rows[0].id as string;
    await db.pool.query(
      `INSERT INTO voiceprint(speaker_id,embedding,model,dimension,source,source_cluster_id)
       VALUES($1,$2::vector,'m',192,'auto_cluster',$3)`, [spId, vec, cid]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,speaker_id,start_ms,end_ms,order_index,processing_version)
       VALUES($1,'SPEAKER_00',$2,0,1,0,0),($1,'SPEAKER_00',$2,2,3,1,0)`, [mid, spId]);
    return { mid, clusterId: cid, provisionalId: spId };
  }

  it('assigns only the current version and preserves historical lens evidence and its provisional speaker (#77)', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    await db.pool.query(`UPDATE meeting SET processing_version=1 WHERE id=$1`, [mid]);
    await db.pool.query(`UPDATE meeting_cluster SET processing_version=1 WHERE id=$1`, [clusterId]);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,speaker_id,start_ms,end_ms,order_index,processing_version)
       VALUES($1,'SPEAKER_00',$2,0,1,0,1),($1,'SPEAKER_00',$2,2,3,1,1),
             ($1,'SPEAKER_01',NULL,4,5,2,1)`, [mid, provisionalId]);
    const lens = await db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source) VALUES($1,'decision','Historical decision','user')
       RETURNING id`, [mid]);
    await db.pool.query(
      `INSERT INTO lens_evidence(lens_item_id,utterance_id,relation)
       SELECT $2,id,'primary' FROM utterance
       WHERE meeting_id=$1 AND processing_version=0 AND order_index=0`, [mid, lens.rows[0].id]);
    const historical = await db.pool.query(
      `SELECT u.* FROM lens_evidence e JOIN utterance u ON u.id=e.utterance_id WHERE e.lens_item_id=$1`,
      [lens.rows[0].id]);
    const target = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Corrected','ready') RETURNING id`);

    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: target.rows[0].id });

    expect(res.status).toBe(200);
    expect(res.body.updated_utterances).toBe(2);
    expect(res.body.merged_speaker_deleted).toBe(false);
    expect((await db.pool.query(
      `SELECT u.* FROM lens_evidence e JOIN utterance u ON u.id=e.utterance_id WHERE e.lens_item_id=$1`,
      [lens.rows[0].id])).rows).toEqual(historical.rows);
    expect((await db.pool.query(
      `SELECT processing_version,diar_label,speaker_id FROM utterance
       WHERE meeting_id=$1 ORDER BY processing_version,order_index`, [mid])).rows).toEqual([
      { processing_version: 0, diar_label: 'SPEAKER_00', speaker_id: provisionalId },
      { processing_version: 0, diar_label: 'SPEAKER_00', speaker_id: provisionalId },
      { processing_version: 1, diar_label: 'SPEAKER_00', speaker_id: target.rows[0].id },
      { processing_version: 1, diar_label: 'SPEAKER_00', speaker_id: target.rows[0].id },
      { processing_version: 1, diar_label: 'SPEAKER_01', speaker_id: null },
    ]);
    expect((await db.pool.query(
      `SELECT speaker_id FROM voiceprint WHERE source_cluster_id=$1`, [clusterId])).rows)
      .toEqual([{ speaker_id: target.rows[0].id }]);
    expect((await db.pool.query(
      `SELECT enrollment_status FROM speaker WHERE id=$1`, [provisionalId])).rows)
      .toEqual([{ enrollment_status: 'provisional' }]);
  });

  it.each(['new_name', 'speaker_id'] as const)('rejects a stale cluster after reprocess without %s side effects (#77)', async (field) => {
    const { mid, clusterId } = await seedProvisional();
    const target = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Target','ready') RETURNING id`);
    const reprocess = await request(srv()).post(`/meetings/${mid}/reprocess`).send({});
    expect(reprocess.status).toBe(202);
    expect(reprocess.body.processing_version).toBe(1);
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1,0,1)`, [mid]);
    const before = await db.pool.query(
      `SELECT row_to_json(c) AS cluster,
              (SELECT jsonb_agg(u ORDER BY u.id) FROM utterance u WHERE u.meeting_id=c.meeting_id) AS utterances,
              (SELECT jsonb_agg(s ORDER BY s.id) FROM speaker s) AS speakers,
              (SELECT jsonb_agg(v ORDER BY v.id) FROM voiceprint v) AS voiceprints
       FROM meeting_cluster c WHERE c.id=$1`, [clusterId]);

    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send(field === 'new_name' ? { new_name: 'Stale rename' } : { speaker_id: target.rows[0].id });

    expect(res.status).toBe(409);
    expect((await db.pool.query(
      `SELECT row_to_json(c) AS cluster,
              (SELECT jsonb_agg(u ORDER BY u.id) FROM utterance u WHERE u.meeting_id=c.meeting_id) AS utterances,
              (SELECT jsonb_agg(s ORDER BY s.id) FROM speaker s) AS speakers,
              (SELECT jsonb_agg(v ORDER BY v.id) FROM voiceprint v) AS voiceprints
       FROM meeting_cluster c WHERE c.id=$1`, [clusterId])).rows).toEqual(before.rows);
  });

  it('rejects an old cluster request begun during an uncommitted version change (#77)', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const writer = await db.pool.connect();
    let response: Promise<request.Response> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE meeting SET processing_version=1 WHERE id=$1`, [mid]);
      const acquired = once(app.get(DatabaseService).pool, 'acquire', { signal: AbortSignal.timeout(5000) });
      response = request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
        .send({ new_name: 'Stale rename' }).then((res) => res);
      // The HTTP request has entered its real DB transaction while the writer
      // still owns the meeting lock. No timer decides which operation wins.
      await acquired;
      await writer.query('COMMIT');

      expect((await response).status).toBe(409);
      expect((await db.pool.query(
        `SELECT name,enrollment_status FROM speaker WHERE id=$1`, [provisionalId])).rows)
        .toEqual([{ name: 'Speaker_001', enrollment_status: 'provisional' }]);
      expect((await db.pool.query(
        `SELECT speaker_id FROM utterance WHERE meeting_id=$1 ORDER BY order_index`, [mid])).rows)
        .toEqual([{ speaker_id: provisionalId }, { speaker_id: provisionalId }]);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await response;
    }
  });

  it('holds the meeting lock through assignment before concurrent HTTP reprocess (#77)', async () => {
    const { mid, clusterId } = await seed();
    const gate = await db.pool.connect();
    const pool = app.get(DatabaseService).pool;
    const notices = new AbortController();
    let response: Promise<request.Response> | undefined;
    let reprocess: Promise<request.Response> | undefined;
    const onAcquire = (client: PoolClient) => {
      client.once('notice', (notice) => {
        if (notice.message === 'cluster_assignment_barrier') notices.abort();
      });
    };
    try {
      await gate.query(`SELECT pg_advisory_lock(770077)`);
      await gate.query(
        `CREATE FUNCTION cluster_assignment_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           RAISE NOTICE 'cluster_assignment_barrier';
           PERFORM pg_advisory_xact_lock(770077);
           RETURN NEW;
         END $$;
         CREATE TRIGGER cluster_assignment_barrier BEFORE UPDATE ON utterance
         FOR EACH ROW EXECUTE FUNCTION cluster_assignment_barrier()`);
      pool.once('acquire', onAcquire);
      const assigning = once(notices.signal, 'abort', { signal: AbortSignal.timeout(5000) });
      response = request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
        .send({ new_name: 'Assigned before reprocess' }).then((res) => res);
      await assigning;

      // The real SQL update has entered its trigger and is parked at our
      // advisory gate. NOWAIT observes the row lock without polling or sleeps.
      await expect(gate.query(`SELECT id FROM meeting WHERE id=$1 FOR UPDATE NOWAIT`, [mid]))
        .rejects.toMatchObject({ code: '55P03' });
      reprocess = request(srv()).post(`/meetings/${mid}/reprocess`).send({}).then((res) => res);
      await gate.query(`SELECT pg_advisory_unlock(770077)`);

      expect((await response).status).toBe(200);
      const next = await reprocess;
      expect(next.status).toBe(202);
      expect(next.body.processing_version).toBe(1);
    } finally {
      pool.removeListener('acquire', onAcquire);
      await gate.query(`SELECT pg_advisory_unlock(770077)`);
      await response;
      await reprocess;
      await gate.query(
        `DROP TRIGGER IF EXISTS cluster_assignment_barrier ON utterance;
         DROP FUNCTION IF EXISTS cluster_assignment_barrier()`);
      gate.release();
    }
  });

  it('merges provisional into existing ready speaker; deletes orphan + reattaches voiceprint', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const T = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('김영재','ready') RETURNING id`)).rows[0].id;
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(T);
    expect(res.body.updated_utterances).toBe(2);
    expect(res.body.merged_speaker_deleted).toBe(true);
    expect((await db.pool.query('SELECT 1 FROM speaker WHERE id=$1', [provisionalId])).rowCount).toBe(0);
    const vp = await db.pool.query('SELECT speaker_id FROM voiceprint WHERE source_cluster_id=$1', [clusterId]);
    expect(vp.rows.length).toBe(1);
    expect(vp.rows[0].speaker_id).toBe(T);
    const utt = await db.pool.query('SELECT speaker_id FROM utterance WHERE meeting_id=$1', [mid]);
    expect(utt.rows.every((u) => u.speaker_id === T)).toBe(true);
  });

  it('new_name on a provisional cluster renames+promotes it (no new speaker)', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const before = (await db.pool.query('SELECT count(*)::int c FROM speaker')).rows[0].c;
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: '박지원' });
    expect(res.status).toBe(200);
    expect(res.body.speaker_id).toBe(provisionalId);
    expect((await db.pool.query('SELECT count(*)::int c FROM speaker')).rows[0].c).toBe(before);
    const sp = await db.pool.query('SELECT name, enrollment_status FROM speaker WHERE id=$1', [provisionalId]);
    expect(sp.rows[0].name).toBe('박지원');
    expect(sp.rows[0].enrollment_status).toBe('ready');
  });

  it('repeated resolve to same target does not duplicate the cluster voiceprint', async () => {
    const { mid, clusterId } = await seedProvisional();
    const T = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('R','ready') RETURNING id`)).rows[0].id;
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T });
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T });
    const vp = await db.pool.query('SELECT count(*)::int c FROM voiceprint WHERE source_cluster_id=$1', [clusterId]);
    expect(vp.rows[0].c).toBe(1);
  });

  it('reassign ready A → ready B moves voiceprint to B and keeps A', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'A' }); // promote → ready
    const B = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('B','ready') RETURNING id`)).rows[0].id;
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: B });
    expect(res.status).toBe(200);
    expect(res.body.merged_speaker_deleted).toBe(false);
    expect((await db.pool.query('SELECT enrollment_status FROM speaker WHERE id=$1', [provisionalId])).rows[0].enrollment_status).toBe('ready');
    const vp = await db.pool.query('SELECT speaker_id FROM voiceprint WHERE source_cluster_id=$1', [clusterId]);
    expect(vp.rows.length).toBe(1);
    expect(vp.rows[0].speaker_id).toBe(B);
  });

  it('rejects bad resolve inputs (both / malformed uuid / pending target)', async () => {
    const { mid, clusterId } = await seedProvisional();
    expect((await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: '00000000-0000-0000-0000-000000000000', new_name: 'x' })).status).toBe(400);
    expect((await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: 'not-a-uuid' })).status).toBe(400);
    const pend = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('P','pending') RETURNING id`)).rows[0].id;
    expect((await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: pend })).status).toBe(409);
  });

  it('404 when speaker_id is a valid format but unknown', async () => {
    const { mid, clusterId } = await seedProvisional();
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: 'spk_999999' });
    expect(res.status).toBe(404);
  });

  it('concurrent new_name resolve and PATCH-promote on the same provisional end consistently', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const [patchRes, resolveRes] = await Promise.allSettled([
      request(srv()).patch(`/speakers/${provisionalId}`).send({ name: 'PatchName' }),
      request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'ResolveName' }),
    ]);
    // promoted in place, no new speaker
    const sp = await db.pool.query('SELECT enrollment_status, name FROM speaker WHERE id=$1', [provisionalId]);
    expect(sp.rowCount).toBe(1);
    expect(sp.rows[0].enrollment_status).toBe('ready');
    expect(['PatchName', 'ResolveName']).toContain(sp.rows[0].name);
    // exactly one race name won; no duplicate speaker created (scoped → isolation-independent)
    const raceCount = await db.pool.query(
      `SELECT count(*)::int c FROM speaker WHERE name IN ('PatchName','ResolveName')`,
    );
    expect(raceCount.rows[0].c).toBe(1);
    const cl = await db.pool.query('SELECT resolved_speaker_id FROM meeting_cluster WHERE id=$1', [clusterId]);
    expect(cl.rows[0].resolved_speaker_id).toBe(provisionalId);
    // PATCH always 200 (renames, never deletes); resolve won (200) or 409'd (PATCH promoted to ready first)
    const patchStatus = patchRes.status === 'fulfilled' ? (patchRes.value as { status: number }).status : 0;
    const resolveStatus = resolveRes.status === 'fulfilled' ? (resolveRes.value as { status: number }).status : 0;
    expect(patchStatus).toBe(200);
    expect([200, 409]).toContain(resolveStatus);
  });

  it('409 on new_name when cluster already resolved to a ready speaker', async () => {
    const { mid, clusterId } = await seedProvisional();
    await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'A' });
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ new_name: 'B' });
    expect(res.status).toBe(409);
  });

  it('concurrent PATCH(promote) and resolve(merge) end consistently (no torn state)', async () => {
    const { mid, clusterId, provisionalId } = await seedProvisional();
    const T = (await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('T','ready') RETURNING id`)).rows[0].id;
    await Promise.allSettled([
      request(srv()).patch(`/speakers/${provisionalId}`).send({ name: 'Named' }),
      request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`).send({ speaker_id: T }),
    ]);
    expect((await db.pool.query('SELECT resolved_speaker_id FROM meeting_cluster WHERE id=$1', [clusterId])).rows[0].resolved_speaker_id).toBe(T);
    const vp = await db.pool.query('SELECT count(*)::int c FROM voiceprint WHERE source_cluster_id=$1 AND speaker_id=$2', [clusterId, T]);
    expect(vp.rows[0].c).toBe(1);
    const a = await db.pool.query('SELECT enrollment_status FROM speaker WHERE id=$1', [provisionalId]);
    if (a.rowCount === 1) expect(a.rows[0].enrollment_status).toBe('ready'); // patch-first; never still provisional
  });
});
