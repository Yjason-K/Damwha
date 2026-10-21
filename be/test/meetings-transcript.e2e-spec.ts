import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';

describe('GET /meetings/:id/transcript', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
        gpu_eligible: true, recommended_preset: 'standard',
      })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const mkMeeting = async (version = 0) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,processing_version) VALUES('k','done',$1) RETURNING id`, [version],
    )).rows[0].id as string;
  const mkUtt = async (mid: string, order: number, version = 0, text = `t${order}`) =>
    db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'S',$2,$3,$4,'ok',$5,$6)`, [mid, order * 1000, order * 1000 + 500, text, order, version],
    );
  const seed5 = async () => {
    const mid = await mkMeeting();
    for (let i = 0; i < 5; i++) await mkUtt(mid, i);
    return mid;
  };

  it('paginates with next_offset', async () => {
    const mid = await seed5();
    const res = await request(srv()).get(`/meetings/${mid}/transcript?offset=0&limit=2`).expect(200);
    expect(res.body).toMatchObject({
      meeting_id: mid, processing_version: 0, total: 5, offset: 0, limit: 2, next_offset: 2,
    });
    expect(res.body.utterances.map((u: { text: string }) => u.text)).toEqual(['t0', 't1']);
    expect(Object.keys(res.body.utterances[0]).sort()).toEqual(
      ['end_ms', 'id', 'speaker_id', 'speaker_name', 'start_ms', 'text'],
    );
  });

  it('last page next_offset null', async () => {
    const mid = await seed5();
    const res = await request(srv()).get(`/meetings/${mid}/transcript?offset=4&limit=2`).expect(200);
    expect(res.body.utterances).toHaveLength(1);
    expect(res.body.next_offset).toBeNull();
  });

  it('caps limit at 500', async () => {
    const mid = await seed5();
    const res = await request(srv()).get(`/meetings/${mid}/transcript?limit=9999`).expect(200);
    expect(res.body.limit).toBe(500);
  });

  it('defaults limit to 200', async () => {
    const mid = await seed5();
    const res = await request(srv()).get(`/meetings/${mid}/transcript`).expect(200);
    expect(res.body).toMatchObject({ offset: 0, limit: 200, total: 5, next_offset: null });
  });

  it('excludes older processing_version', async () => {
    const mid = await mkMeeting(1);
    await mkUtt(mid, 0, 0, 'old');
    await mkUtt(mid, 0, 1, 'new');
    const res = await request(srv()).get(`/meetings/${mid}/transcript`).expect(200);
    expect(res.body.processing_version).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.utterances.map((u: { text: string }) => u.text)).toEqual(['new']);
  });

  it('unknown meeting 404', async () => {
    await request(srv()).get('/meetings/mtg_999999/transcript').expect(404);
  });

  it.each(['offset=-1', 'limit=-1', 'limit=0', 'offset=abc', 'limit=1.5'])('rejects %s with 400', async (q) => {
    const mid = await seed5();
    await request(srv()).get(`/meetings/${mid}/transcript?${q}`).expect(400);
  });
});
