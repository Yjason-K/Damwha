import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';

describe('health', () => {
  let db: StartedTestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('GET /health → 200 with a live DB probe', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', instance: null });
  });

  // 요청마다 loadEnv()를 읽으므로 같은 앱에서 env만 바꿔 확인한다.
  describe('instance nonce', () => {
    const saved = process.env.DAMWHA_INSTANCE;
    afterEach(() => {
      if (saved === undefined) delete process.env.DAMWHA_INSTANCE;
      else process.env.DAMWHA_INSTANCE = saved;
    });

    it('returns instance from DAMWHA_INSTANCE', async () => {
      process.env.DAMWHA_INSTANCE = 'abc';
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.body.instance).toBe('abc');
    });

    it('returns null instance when unset', async () => {
      delete process.env.DAMWHA_INSTANCE;
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.body.instance).toBeNull();
    });
  });
});

describe('health when the DB is down', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // DB 연결 없이도 부팅되도록 DatabaseService를 통째로 대역으로 바꾼다
    process.env.DATABASE_URL ??= 'postgres://u:p@127.0.0.1:1/nodb';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ query: () => Promise.reject(new Error('connection refused')) })
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); });

  it('GET /health → 503 unreachable', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', db: 'unreachable' });
  });
});
