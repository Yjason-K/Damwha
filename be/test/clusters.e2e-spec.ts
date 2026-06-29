import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

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

  it('404 when speaker_id is a valid but unknown UUID', async () => {
    const { mid, clusterId } = await seedProvisional();
    const res = await request(srv()).post(`/meetings/${mid}/clusters/${clusterId}/resolve`)
      .send({ speaker_id: '11111111-1111-1111-1111-111111111111' });
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
