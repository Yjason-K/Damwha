import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('GET /models', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); await db.pool.query(`DELETE FROM app_setting WHERE key IN ('model_inventory','model_readiness')`); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('inventory 행이 없으면 scannedAt null, 모든 행 unknown', async () => {
    const res = await request(srv()).get('/models');
    expect(res.status).toBe(200);
    expect(res.body.scannedAt).toBeNull();
    expect(res.body.models.every((m: { installed: string }) => m.installed === 'unknown')).toBe(true);
  });

  it('worker가 쓴 inventory를 읽어 행을 만든다. API는 그 행을 쓰지 않는다', async () => {
    const value = {
      scanned_at: '2026-09-25T10:00:00.000000Z',
      repos: { 'mlx-community/whisper-large-v3-turbo': { size_bytes: 1613979758, complete: true } },
      resolved: [{ role: 'stt', name: 'large-v3-turbo', backend: 'mlx', repo_id: 'mlx-community/whisper-large-v3-turbo' }],
      approx: {},
      worker_llm: { lens_model: null, summary_fallback: null },
    };
    await db.pool.query(`INSERT INTO app_setting(key, value) VALUES('model_inventory', $1)`, [JSON.stringify(value)]);
    const res = await request(srv()).get('/models');
    const turbo = res.body.models.find((m: { name: string; backend: string }) => m.name === 'large-v3-turbo' && m.backend === 'mlx');
    expect(turbo).toMatchObject({ installed: 'yes', sizeBytes: 1613979758 });
    const after = await db.pool.query(`SELECT value FROM app_setting WHERE key='model_inventory'`);
    expect(after.rows[0].value).toEqual(value);
  });

  it('망가진 inventory 행에도 200이다', async () => {
    await db.pool.query(`INSERT INTO app_setting(key, value) VALUES('model_inventory', '"junk"')`);
    const res = await request(srv()).get('/models');
    expect(res.status).toBe(200);
    expect(res.body.scannedAt).toBeNull();
  });
});
