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

  it('PATCH /speakers/:id renames; pending stays pending', async () => {
    const created = await request(srv()).post('/speakers').field('name', 'A')
      .attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const res = await request(srv()).patch(`/speakers/${created.body.id}`).send({ name: '새이름' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('새이름');
    expect(res.body.enrollment_status).toBe('pending');
  });

  it('PATCH promotes provisional → ready', async () => {
    const sp = await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('Speaker_001','provisional') RETURNING id`);
    const res = await request(srv()).patch(`/speakers/${sp.rows[0].id}`).send({ name: '홍길동' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('홍길동');
    expect(res.body.enrollment_status).toBe('ready');
  });

  it('PATCH leaves ready/failed status unchanged', async () => {
    const ready = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('R','ready') RETURNING id`);
    const r1 = await request(srv()).patch(`/speakers/${ready.rows[0].id}`).send({ name: 'R2' });
    expect(r1.body.enrollment_status).toBe('ready');
    const failed = await db.pool.query(`INSERT INTO speaker(name,enrollment_status) VALUES('F','failed') RETURNING id`);
    const r2 = await request(srv()).patch(`/speakers/${failed.rows[0].id}`).send({ name: 'F2' });
    expect(r2.body.enrollment_status).toBe('failed');
  });

  it('PATCH validation: 404 unknown, 400 bad name', async () => {
    expect((await request(srv()).patch('/speakers/11111111-1111-1111-1111-111111111111').send({ name: 'x' })).status).toBe(404);
    const sp = await db.pool.query(`INSERT INTO speaker(name) VALUES('S') RETURNING id`);
    const id = sp.rows[0].id;
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: '' })).status).toBe(400);
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: '   ' })).status).toBe(400);
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: 123 })).status).toBe(400);
    expect((await request(srv()).patch(`/speakers/${id}`).send({ name: 'a'.repeat(101) })).status).toBe(400);
  });
});
