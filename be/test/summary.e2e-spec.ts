import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { SummarySegment, SummaryStatus } from '../src/summary/summary.types';

describe('요약 API', () => {
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

  const seedMeeting = async (
    opts: { status: string; processingVersion: number },
  ): Promise<string> =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key, status, processing_version) VALUES('k', $1, $2) RETURNING id`,
      [opts.status, opts.processingVersion],
    )).rows[0].id;

  const seedSummary = async (
    meetingId: string,
    opts: {
      processingVersion: number;
      status: SummaryStatus;
      topics: string[];
      segments?: SummarySegment[];
    },
  ) =>
    db.pool.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, model, status, topics, segments)
       VALUES($1, $2, 'test-model', $3, $4::jsonb, $5::jsonb)`,
      [
        meetingId, opts.processingVersion, opts.status,
        JSON.stringify(opts.topics), JSON.stringify(opts.segments ?? []),
      ],
    );

  const seedSummaryWithModel = async (
    meetingId: string,
    opts: { processingVersion: number; status: SummaryStatus; model: string },
  ) =>
    db.pool.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, model, status, topics, segments)
       VALUES($1, $2, $3, $4, '[]'::jsonb, '[]'::jsonb)`,
      [meetingId, opts.processingVersion, opts.model, opts.status],
    );

  it('처리되지 않은 회의는 summary가 null이다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    const res = await request(app.getHttpServer()).get(`/meetings/${meetingId}`).expect(200);
    expect(res.body.summary).toBeNull();
  });

  it('저장된 요약을 상세 응답에 실어 준다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummary(meetingId, {
      processingVersion: 0,
      status: 'done',
      topics: ['주제'],
      segments: [{
        start_utterance_id: 'utt_1', end_utterance_id: 'utt_2',
        start_ms: 0, end_ms: 3000, title: '제목', bullets: ['불릿'],
      }],
    });
    const res = await request(app.getHttpServer()).get(`/meetings/${meetingId}`).expect(200);
    expect(res.body.summary.topics).toEqual(['주제']);
    expect(res.body.summary.segments[0].end_ms).toBe(3000);
  });

  it('재처리로 버전이 올라간 요약은 숨긴다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 1 });
    await seedSummary(meetingId, { processingVersion: 0, status: 'done', topics: ['옛날'] });
    const res = await request(app.getHttpServer()).get(`/meetings/${meetingId}`).expect(200);
    expect(res.body.summary).toBeNull();
  });

  it('재생성 요청이 summarize_meeting 잡을 큐잉한다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .expect(202);
    expect(res.body.status).toBe('queued');
    const jobs = await db.pool.query(
      `SELECT type FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('실패한 요약을 재생성하면 이전 결과를 지우고 queued로 되돌린다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummary(meetingId, {
      processingVersion: 0,
      status: 'failed',
      topics: ['옛 주제'],
      segments: [{
        start_utterance_id: 'utt_1', end_utterance_id: 'utt_2',
        start_ms: 0, end_ms: 3000, title: '옛 제목', bullets: ['옛 불릿'],
      }],
    });
    await db.pool.query(
      `UPDATE meeting_summary SET error=$1::jsonb WHERE meeting_id=$2`,
      [JSON.stringify({ code: 'llm_invalid_response', message: '이전 실패' }), meetingId],
    );

    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .expect(202);
    expect(res.body.status).toBe('queued');

    const jobs = await db.pool.query(
      `SELECT id FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(jobs.rows).toHaveLength(1);

    const row = (await db.pool.query(
      `SELECT status, topics, segments, error, job_id FROM meeting_summary WHERE meeting_id=$1`,
      [meetingId],
    )).rows[0];
    expect(row.status).toBe('queued');
    expect(row.topics).toEqual([]);
    expect(row.segments).toEqual([]);
    expect(row.error).toBeNull();
    expect(row.job_id).toBe(jobs.rows[0].id);
  });

  it('이미 진행 중이면 잡을 중복 큐잉하지 않는다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(202);
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(202);
    const jobs = await db.pool.query(
      `SELECT id FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('처리 중인 회의의 재생성 요청은 409다', async () => {
    const meetingId = await seedMeeting({ status: 'processing', processingVersion: 0 });
    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .expect(409);
  });

  it('상태 엔드포인트가 요약 상태를 함께 반환한다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummary(meetingId, { processingVersion: 0, status: 'running', topics: [] });
    const res = await request(app.getHttpServer())
      .get(`/meetings/${meetingId}/status`)
      .expect(200);
    expect(res.body.summary_status).toBe('running');
  });

  it('body 없음 → 전역 설정의 summary_model로 큐잉된다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .put('/settings/processing').send({ preset: 'quality', language: 'ko' }).expect(200);

    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`).expect(202);

    const row = await db.pool.query(
      `SELECT model FROM meeting_summary WHERE meeting_id=$1`, [meetingId],
    );
    expect(row.rows[0].model).toBe('qwen3.5:14b-mlx');
    const job = await db.pool.query(
      `SELECT payload FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(job.rows[0].payload.model).toBe('qwen3.5:14b-mlx');
  });

  it('body override → 그 모델로 큐잉되고 전역 설정은 바뀌지 않는다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .put('/settings/processing').send({ preset: 'light', language: 'ko' }).expect(200);

    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'qwen3.5:14b-mlx' })
      .expect(202);

    const row = await db.pool.query(
      `SELECT model FROM meeting_summary WHERE meeting_id=$1`, [meetingId],
    );
    expect(row.rows[0].model).toBe('qwen3.5:14b-mlx');
    const settings = await request(app.getHttpServer()).get('/settings/processing').expect(200);
    expect(settings.body.summary_model).toBe('qwen3.5:4b-mlx'); // 저장되지 않는다
  });

  it('목록 밖 모델 → 400', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'gpt-9' })
      .expect(400);
  });

  it('진행 중 요약과 다른 모델로 재요청 → 409', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummaryWithModel(meetingId, {
      processingVersion: 0, status: 'running', model: 'qwen3.5:4b-mlx',
    });
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'qwen3.5:14b-mlx' });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('qwen3.5:4b-mlx');
  });

  it('진행 중 요약과 같은 모델로 재요청 → 기존 상태 반환 (멱등)', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummaryWithModel(meetingId, {
      processingVersion: 0, status: 'running', model: 'qwen3.5:14b-mlx',
    });
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .send({ summary_model: 'qwen3.5:14b-mlx' })
      .expect(202);
    expect(res.body.status).toBe('running');
    const jobs = await db.pool.query(
      `SELECT count(*)::int AS n FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`,
      [meetingId],
    );
    expect(jobs.rows[0].n).toBe(0); // 재큐잉 없음
  });
});
