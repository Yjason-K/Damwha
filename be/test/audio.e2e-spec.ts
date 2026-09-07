import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
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

  // normalized는 STT용 16 kHz mono다. 재생은 원본을 흘려야 한다 — normalize()가
  // 리샘플만 하고 잘라내지 않아 길이가 같으므로 타임스탬프는 그대로 맞는다.
  it('prefers the original over normalized, and keeps its content type', async () => {
    const created = await request(app.getHttpServer())
      .post('/meetings').attach('audio', Buffer.from('original-bytes'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    const mid = created.body.id;

    const normalizedKey = `meetings/${mid}/normalized.flac`;
    const full = path.join(db.storageRoot, normalizedKey);
    await fs.promises.writeFile(full, 'normalized');
    await db.pool.query('UPDATE meeting SET normalized_key=$2 WHERE id=$1', [mid, normalizedKey]);

    const res = await request(app.getHttpServer()).get(`/meetings/${mid}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('original-bytes');
    expect(res.headers['content-type']).toContain('audio/mp4');
  });

  it('falls back to normalized when the original is gone', async () => {
    const created = await request(app.getHttpServer())
      .post('/meetings').attach('audio', Buffer.from('original-bytes'), { filename: 'a.m4a', contentType: 'audio/mp4' });
    const mid = created.body.id;

    const normalizedKey = `meetings/${mid}/normalized.flac`;
    await fs.promises.writeFile(path.join(db.storageRoot, normalizedKey), 'normalized');
    await db.pool.query('UPDATE meeting SET normalized_key=$2 WHERE id=$1', [mid, normalizedKey]);
    await fs.promises.unlink(path.join(db.storageRoot, `meetings/${mid}/original.m4a`));

    const res = await request(app.getHttpServer()).get(`/meetings/${mid}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('normalized');
    expect(res.headers['content-type']).toContain('audio/flac');
  });

  // 회의 행은 있는데 파일이 없는 상태. stat의 ENOENT를 그대로 흘리면 500이 된다.
  it('answers 404 — not 500 — when the meeting row outlives its audio', async () => {
    const created = await request(app.getHttpServer())
      .post('/meetings').attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await fs.promises.rm(path.join(db.storageRoot, 'meetings', mid), { recursive: true, force: true });

    const res = await request(app.getHttpServer()).get(`/meetings/${mid}/audio`);
    expect(res.status).toBe(404);
  });
});
