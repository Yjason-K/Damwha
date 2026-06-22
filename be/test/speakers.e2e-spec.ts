import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('speakers', () => {
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

  it('POST /speakers creates pending speaker + enroll_speaker job', async () => {
    const res = await request(srv())
      .post('/speakers').field('name', '김영재')
      .attach('audio', Buffer.from('sample'), { filename: 'voice.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('김영재');
    expect(res.body.enrollment_status).toBe('pending');
    expect(res.body.current_job_id).toBeTruthy();
    const job = await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].type).toBe('enroll_speaker');
    expect(job.rows[0].payload.speaker_id).toBe(res.body.id);
  });

  it('POST /speakers requires name and audio', async () => {
    expect((await request(srv()).post('/speakers').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' })).status).toBe(400);
    expect((await request(srv()).post('/speakers').field('name', 'x')).status).toBe(400);
  });

  it('GET /speakers/:id returns enrollment_status', async () => {
    const created = await request(srv()).post('/speakers').field('name', 'A').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const res = await request(srv()).get(`/speakers/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.enrollment_status).toBe('pending');
  });
});
