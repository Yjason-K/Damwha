import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { PRESET_REVISION } from '../src/settings/presets';
import { CAPABILITIES } from '../src/system/capabilities';

describe('settings', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let appNoGpu: INestApplication;
  const srv = () => app.getHttpServer();
  const srvNoGpu = () => appNoGpu.getHttpServer();

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

    const modNoGpu = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'linux', arch: 'x64', chip: null, memory_gb: 32,
        gpu_eligible: false, recommended_preset: null,
      })
      .compile();
    appNoGpu = modNoGpu.createNestApplication();
    await appNoGpu.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await appNoGpu?.close(); await db?.stop(); });

  it('GET → 행 없음이면 env 폴백 resolved 뷰', async () => {
    const res = await request(srv()).get('/settings/processing');
    expect(res.status).toBe(200);
    expect(res.body.preset).toBe('custom');
    expect(res.body.whisper_model).toBe('large-v3-turbo');
  });

  it('PUT 이름 프리셋 → resolved 반환, DB엔 이름만', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'light', language: 'ko' });
    expect(res.status).toBe(200);
    expect(res.body.whisper_model).toBe('small');
    expect(res.body.preset_revision).toBe(PRESET_REVISION);
  });

  it('PUT 이름 프리셋 + 개별 노브 혼합 → 400 (spec §3)', async () => {
    const res = await request(srv()).put('/settings/processing')
      .send({ preset: 'light', language: 'ko', whisper_model: 'medium' });
    expect(res.status).toBe(400);
  });

  it('PUT custom 필드 누락 → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'custom', language: 'ko' });
    expect(res.status).toBe(400);
  });

  it('PUT 빈 language → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'light', language: '  ' });
    expect(res.status).toBe(400);
  });

  it('gpu_eligible=false면 gpu 포함 custom PUT → 400', async () => {
    const res = await request(srvNoGpu()).put('/settings/processing').send({
      preset: 'custom', language: 'ko', whisper_model: 'small',
      devices: { diarization: 'gpu', stt: 'cpu' },
    });
    expect(res.status).toBe(400);
  });

  it('gpu_eligible=false면 이름 프리셋 PUT도 400 — light도 diarization gpu 포함 (spec §3)', async () => {
    const res = await request(srvNoGpu()).put('/settings/processing')
      .send({ preset: 'light', language: 'ko' });
    expect(res.status).toBe(400);
  });

  it('PUT custom에 summary_model 누락 → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({
      preset: 'custom', language: 'ko', whisper_model: 'small',
      devices: { diarization: 'gpu', stt: 'cpu' },
    });
    expect(res.status).toBe(400);
  });

  it('PUT 이름 프리셋에 summary_model 혼입 → 400', async () => {
    const res = await request(srv()).put('/settings/processing').send({
      preset: 'light', language: 'ko', summary_model: 'qwen3.5:4b-mlx',
    });
    expect(res.status).toBe(400);
  });
});
