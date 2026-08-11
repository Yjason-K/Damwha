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
      .expect(201);
    expect(res.body.status).toBe('queued');
    const jobs = await db.pool.query(
      `SELECT type FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('이미 진행 중이면 잡을 중복 큐잉하지 않는다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(201);
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(201);
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
});
