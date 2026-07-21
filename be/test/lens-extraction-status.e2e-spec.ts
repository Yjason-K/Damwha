import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('GET /lenses/extraction-status', () => {
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

  const mkMeeting = async (title: string) => (await db.pool.query(
    `INSERT INTO meeting(audio_key,status,title) VALUES('a','done',$1) RETURNING id`, [title],
  )).rows[0].id as string;

  const mkRun = async (meetingId: string, status: string, pv = 0) => db.pool.query(
    `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model)
     VALUES($1,$2,$3,'qwen')`, [meetingId, pv, status],
  );

  it('counts running/queued runs and lists meetings whose latest run failed', async () => {
    const m1 = await mkMeeting('진행중 회의');
    const m2 = await mkMeeting('실패 회의');
    const m3 = await mkMeeting('해소된 회의');
    await mkRun(m1, 'running');
    await mkRun(m2, 'failed');
    // m3: 예전엔 실패했지만 최신 run은 done → failed 목록에서 제외
    await mkRun(m3, 'failed', 0);
    await mkRun(m3, 'done', 1);

    const res = await request(app.getHttpServer()).get('/lenses/extraction-status').expect(200);
    expect(res.body.running).toBe(1);
    expect(res.body.failed).toEqual([{ meeting_id: m2, title: '실패 회의' }]);
  });

  it('returns zeros when there are no runs', async () => {
    const res = await request(app.getHttpServer()).get('/lenses/extraction-status').expect(200);
    expect(res.body).toEqual({ running: 0, failed: [] });
  });
});
