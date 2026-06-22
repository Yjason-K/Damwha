import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('meetings', () => {
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

  it('POST /meetings stores file, creates meeting + queued job + current_job_id', async () => {
    const res = await request(srv())
      .post('/meetings')
      .field('title', '기획회의')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('uploaded');
    expect(res.body.title).toBe('기획회의');
    expect(res.body.audio_key).toMatch(/^meetings\/.+\/original\.m4a$/);
    expect(res.body.current_job_id).toBeTruthy();

    const job = await db.pool.query('SELECT * FROM job WHERE id=$1', [res.body.current_job_id]);
    expect(job.rows[0].type).toBe('process_meeting');
    expect(job.rows[0].status).toBe('queued');
    expect(job.rows[0].payload.audio_key).toBe(res.body.audio_key);
    expect(job.rows[0].payload.processing_version).toBe(0);
  });

  it('POST /meetings rejects non-audio mime', async () => {
    const res = await request(srv())
      .post('/meetings')
      .attach('audio', Buffer.from('x'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('GET /meetings/:id returns meeting with ordered utterances', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES ($1,NULL,'SPEAKER_00',1000,2000,'두번째','ok',1,0),
              ($1,NULL,'SPEAKER_00',0,900,'첫번째','ok',0,0)`,
      [mid],
    );
    const res = await request(srv()).get(`/meetings/${mid}`);
    expect(res.status).toBe(200);
    expect(res.body.utterances.map((u: any) => u.text)).toEqual(['첫번째', '두번째']);
  });

  it('GET /meetings/:id → 404 for unknown id', async () => {
    const res = await request(srv()).get('/meetings/99999999-9999-9999-9999-999999999999');
    expect(res.status).toBe(404);
  });

  it('GET /meetings/:id/status reflects job stage/progress', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(
      `UPDATE job SET status='running', stage='stt', progress=60 WHERE id=$1`,
      [created.body.current_job_id],
    );
    const res = await request(srv()).get(`/meetings/${mid}/status`);
    expect(res.body).toMatchObject({ status: 'uploaded', stage: 'stt', progress: 60 });
  });

  it('POST /meetings/:id/reprocess bumps version + enqueues new job (done only)', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    // not allowed while uploaded
    expect((await request(srv()).post(`/meetings/${mid}/reprocess`)).status).toBe(409);
    await db.pool.query(`UPDATE meeting SET status='done' WHERE id=$1`, [mid]);
    const res = await request(srv()).post(`/meetings/${mid}/reprocess`);
    expect(res.status).toBe(202);
    const mt = await db.pool.query('SELECT processing_version, current_job_id, status FROM meeting WHERE id=$1', [mid]);
    expect(mt.rows[0].processing_version).toBe(1);
    expect(mt.rows[0].status).toBe('uploaded');
    const job = await db.pool.query('SELECT payload, status FROM job WHERE id=$1', [mt.rows[0].current_job_id]);
    expect(job.rows[0].payload.processing_version).toBe(1);
    expect(job.rows[0].payload.reprocess).toBe(true);
  });
});
