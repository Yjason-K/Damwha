import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES, WORKER_CAPABILITIES_KEY } from '../src/system/capabilities';

const CONTAINER_VIEW = {
  platform: 'linux', arch: 'x64', chip: null, memory_gb: 8,
  gpu_eligible: false, recommended_preset: null,
};

describe('system', () => {
  let db: StartedTestDb;
  let app: INestApplication;

  const boot = async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue(CONTAINER_VIEW)
      .compile();
    const a = mod.createNestApplication();
    await a.init();
    return a;
  };

  beforeAll(async () => {
    db = await startTestDb();
    app = await boot();
  });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  it('GET /system/capabilities → 200 + typed shape (CI-agnostic)', async () => {
    const res = await request(app.getHttpServer()).get('/system/capabilities');
    expect(res.status).toBe(200);
    expect(typeof res.body.platform).toBe('string');
    expect(typeof res.body.arch).toBe('string');
    expect(typeof res.body.gpu_eligible).toBe('boolean');
    expect(typeof res.body.memory_gb).toBe('number');
    expect(res.body).toHaveProperty('chip');
    expect(res.body).toHaveProperty('recommended_preset');
  });

  it('워커 보고가 없으면 이 프로세스가 감지한 값을 그대로 돌려준다', async () => {
    const res = await request(app.getHttpServer()).get('/system/capabilities');
    expect(res.body).toEqual(CONTAINER_VIEW);
  });

  it('워커가 보고를 남기면 컨테이너 뷰 대신 호스트 실측이 나간다', async () => {
    // 워커(Python)가 app_setting에 쓰는 것과 같은 행. 새 앱 인스턴스로 띄우는 것은
    // CapabilitiesService의 TTL 캐시가 위 케이스에서 이미 "보고 없음"을 잡았기 때문.
    await db.pool.query('INSERT INTO app_setting(key, value) VALUES($1, $2)', [
      WORKER_CAPABILITIES_KEY,
      JSON.stringify({
        worker_id: 'worker-1', platform: 'darwin', arch: 'arm64',
        chip: 'Apple M2 Pro', memory_gb: 64, gpu_eligible: true,
        gpu_probe: 'mps_available',
      }),
    ]);
    const withWorker = await boot();
    try {
      const res = await request(withWorker.getHttpServer()).get('/system/capabilities');
      expect(res.body).toEqual({
        platform: 'darwin', arch: 'arm64', chip: 'Apple M2 Pro', memory_gb: 64,
        gpu_eligible: true, recommended_preset: 'quality',
      });
    } finally {
      await withWorker.close();
    }
  });

  it('워커가 gpu_eligible=false로 보고하면 GPU 프리셋 저장이 400으로 막힌다', async () => {
    // env는 gpu를 허용해도(CAPABILITIES_* 주입) 실측이 아니라고 하면 게이트가 닫힌다 —
    // Rosetta python 워커가 잡 실행 도중 gpu_unavailable로 죽는 대신 여기서 걸린다.
    await db.reset();
    await db.pool.query('INSERT INTO app_setting(key, value) VALUES($1, $2)', [
      WORKER_CAPABILITIES_KEY,
      JSON.stringify({
        worker_id: 'worker-1', platform: 'darwin', arch: 'arm64',
        chip: 'Apple M2', memory_gb: 16, gpu_eligible: false,
        gpu_probe: 'mps_unavailable',
      }),
    ]);
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({ ...CONTAINER_VIEW, platform: 'darwin', arch: 'arm64', gpu_eligible: true })
      .compile();
    const rosetta = mod.createNestApplication();
    await rosetta.init();
    try {
      const res = await request(rosetta.getHttpServer())
        .put('/settings/processing')
        .send({ preset: 'standard', language: 'ko' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/gpu is not available/);
    } finally {
      await rosetta.close();
    }
  });
});
