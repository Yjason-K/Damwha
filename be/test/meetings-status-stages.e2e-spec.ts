import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';

describe('GET /meetings/:id/status stages', () => {
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
  const mk = async (status: string, version = 1) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,processing_version) VALUES('k',$1,$2) RETURNING id`, [status, version],
    )).rows[0].id as string;
  const mkSummary = (mid: string, status: string, version: number) =>
    db.pool.query(
      `INSERT INTO meeting_summary(meeting_id,processing_version,model,status) VALUES($1,$2,'m',$3)`, [mid, version, status],
    );
  const mkRun = (mid: string, status: string, version: number) =>
    db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id,processing_version,status) VALUES($1,$2,$3)`, [mid, version, status],
    );
  const stages = async (mid: string) =>
    (await request(srv()).get(`/meetings/${mid}/status`).expect(200)).body.stages;

  it('process running -> summary pending, lens pending', async () => {
    const mid = await mk('processing');
    expect(await stages(mid)).toEqual({ process: 'running', summary: 'pending', lens: 'pending' });
  });

  it('stage is skipped when followup deferred', async () => {
    const mid = await mk('done');
    expect(await stages(mid)).toEqual({ process: 'done', summary: 'skipped', lens: 'skipped' });
  });

  it('failed process with no follow-up rows -> skipped', async () => {
    const mid = await mk('failed');
    expect(await stages(mid)).toEqual({ process: 'failed', summary: 'skipped', lens: 'skipped' });
  });

  it('summary row done -> done', async () => {
    const mid = await mk('done');
    await mkSummary(mid, 'done', 1);
    expect(await stages(mid)).toEqual({ process: 'done', summary: 'done', lens: 'skipped' });
  });

  it('lens run of older processing_version is ignored', async () => {
    const mid = await mk('done', 2);
    await mkRun(mid, 'done', 1);
    await mkSummary(mid, 'done', 1);
    expect(await stages(mid)).toEqual({ process: 'done', summary: 'skipped', lens: 'skipped' });
  });

  it('keeps existing status fields', async () => {
    const mid = await mk('done');
    const body = (await request(srv()).get(`/meetings/${mid}/status`).expect(200)).body;
    expect(body).toHaveProperty('status', 'done');
    expect(body).toHaveProperty('lens_extraction');
    expect(body).toHaveProperty('summary');
  });
});
