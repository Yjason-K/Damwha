import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';

// 설계 §3.6 — DEMO_READ_ONLY=true 인 앱은 변경 요청을 403으로 닫고 읽기(GET, POST /search)는 연다.
describe('demo read-only (e2e)', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DEMO_READ_ONLY = 'true';
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({ platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32, gpu_eligible: true, recommended_preset: 'standard' })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    delete process.env.DEMO_READ_ONLY;
    await app?.close();
    await db?.stop();
  });
  const srv = () => app.getHttpServer();

  it('GET /meetings is open', async () => {
    expect((await request(srv()).get('/meetings')).status).toBe(200);
  });

  it('POST /meetings is closed with the demo code and creates nothing', async () => {
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('x'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEMO_READ_ONLY');
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM meeting');
    expect(rows[0].n).toBe(0);
  });

  it('POST /search stays open', async () => {
    const res = await request(srv()).post('/search').send({ q: '출시' });
    expect(res.status).not.toBe(403);
  });

  it('live start/stop are closed in demo mode', async () => {
    expect((await request(srv()).post('/meetings/live').send({})).status).toBe(403);
    expect((await request(srv()).post('/meetings/mtg_1/live/stop')).status).toBe(403);
    expect((await request(srv()).get('/meetings/mtg_1/live')).status).not.toBe(403);
  });
});
