import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('manual lens extraction', () => {
  let db: StartedTestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
        gpu_eligible: true, recommended_preset: 'standard',
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const activeRunCount = async (meetingId: string, processingVersion: number) => Number((await db.pool.query(
    `SELECT count(*) FROM lens_extraction_run
     WHERE meeting_id=$1 AND processing_version=$2 AND status IN ('queued', 'running')`,
    [meetingId, processingVersion],
  )).rows[0].count);

  const createMeeting = async (status = 'done') => (await db.pool.query(
    `INSERT INTO meeting(audio_key,status) VALUES('audio',$1) RETURNING id`, [status],
  )).rows[0].id as string;

  it('reuses the active run for duplicate requests', async () => {
    const meetingId = await createMeeting();
    const first = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/lenses/extract`).expect(202);
    const second = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/lenses/extract`).expect(202);

    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      run_id: expect.stringMatching(/^ler_[1-9][0-9]*$/),
      job_id: expect.stringMatching(/^job_[1-9][0-9]*$/),
      status: 'queued', processing_version: 0,
    });
    expect(await activeRunCount(meetingId, 0)).toBe(1);
    const { rows: [job] } = await db.pool.query('SELECT * FROM job WHERE id=$1', [first.body.job_id]);
    expect(job).toMatchObject({ type: 'extract_lenses', meeting_id: meetingId, status: 'queued' });
    expect(job.payload).toMatchObject({
      schema_version: 1, meeting_id: meetingId, processing_version: 0,
      extraction_run_id: first.body.run_id, model: 'qwen2.5:14b-instruct',
    });
  });

  it('rejects a non-done meeting', async () => {
    const meetingId = await createMeeting('processing');
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/lenses/extract`).expect(409);
  });

  it('includes the latest lens extraction result in meeting status', async () => {
    const meetingId = await createMeeting();
    const extraction = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/lenses/extract`).expect(202);
    await db.pool.query(
      `UPDATE lens_extraction_run
       SET status='failed', error=$2::jsonb, finished_at='2026-07-14T01:02:03Z'
       WHERE id=$1`,
      [extraction.body.run_id, JSON.stringify({ code: 'model_error' })],
    );

    const status = await request(app.getHttpServer()).get(`/meetings/${meetingId}/status`).expect(200);
    expect(status.body).toMatchObject({
      status: 'done', lens_extraction: {
        status: 'failed', model: 'qwen2.5:14b-instruct', error: { code: 'model_error' },
        finished_at: expect.any(String),
      },
    });
  });
});
