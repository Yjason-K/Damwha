import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('system', () => {
  let db: StartedTestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
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
});
