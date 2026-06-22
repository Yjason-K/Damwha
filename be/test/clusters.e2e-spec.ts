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
});
