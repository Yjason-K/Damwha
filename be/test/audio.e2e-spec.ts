import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('audio streaming', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('serves full body (200) and a byte range (206)', async () => {
    const created = await request(app.getHttpServer())
      .post('/meetings').attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;

    const full = await request(app.getHttpServer()).get(`/meetings/${mid}/audio`);
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.body.toString()).toBe('0123456789');

    const part = await request(app.getHttpServer())
      .get(`/meetings/${mid}/audio`).set('Range', 'bytes=2-5');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.body.toString()).toBe('2345');
  });
});
