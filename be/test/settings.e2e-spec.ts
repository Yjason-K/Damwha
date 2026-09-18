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

  // Phase 4 스펙 §6.9 — worker·embed가 쓰고 API는 읽기만 하는 두 번째 공유 행.
  it('GET → model_readiness가 없으면 빈 modelReadiness를 얹는다', async () => {
    const res = await request(srv()).get('/settings/processing');
    expect(res.body.modelReadiness).toEqual({ updatedAt: null, entries: [] });
  });

  it('GET → worker가 쓴 행을 camelCase로 펴서 얹는다. API는 그 행을 쓰지 않는다', async () => {
    await db.pool.query(
      `INSERT INTO app_setting(key, value) VALUES('model_readiness', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          updated_at: '2026-09-18T01:02:03.456789Z',
          entries: {
            'BAAI/bge-m3': {
              state: 'downloading',
              bytes_done: 1024,
              bytes_total: 4096,
              writer: 'embed',
              attempt: 1,
              started_at: '2026-09-18T01:00:00.000000Z',
              updated_at: '2026-09-18T01:02:03.456789Z',
              error: null,
              error_kind: null,
            },
          },
        }),
      ],
    );
    const res = await request(srv()).get('/settings/processing');
    expect(res.body.modelReadiness.entries).toEqual([
      {
        key: 'BAAI/bge-m3',
        state: 'downloading',
        bytesDone: 1024,
        bytesTotal: 4096,
        writer: 'embed',
        attempt: 1,
        startedAt: '2026-09-18T01:00:00.000000Z',
        updatedAt: '2026-09-18T01:02:03.456789Z',
        error: null,
        errorKind: null,
      },
    ]);
    // 읽기 전용이다 — 조회가 그 행을 건드리지 않았다.
    const after = await db.pool.query(`SELECT value FROM app_setting WHERE key='model_readiness'`);
    expect(after.rows[0].value.entries['BAAI/bge-m3'].bytes_done).toBe(1024);
  });

  it('PUT 응답에는 modelReadiness가 없다 — 쓰기의 결과는 저장된 설정뿐이다', async () => {
    const res = await request(srv()).put('/settings/processing').send({ preset: 'light', language: 'ko' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('modelReadiness');
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
      preset: 'light', language: 'ko', summary_model: 'mlx-community/Qwen3.5-4B-8bit',
    });
    expect(res.status).toBe(400);
  });
});
