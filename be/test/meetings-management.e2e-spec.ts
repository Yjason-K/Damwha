import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('meetings management (PATCH / DELETE)', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let storageRoot: string;

  beforeAll(async () => {
    // StorageService canonicalizes STORAGE_ROOT in its constructor, so set it
    // BEFORE the app is built. A fresh temp dir keeps disk assertions isolated.
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-mtg-mgmt-'));
    process.env.STORAGE_ROOT = storageRoot;
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  const srv = () => app.getHttpServer();
  const meetingDir = (id: string) => path.join(storageRoot, 'meetings', id);

  const upload = async () =>
    request(srv())
      .post('/meetings')
      .field('title', '원래 제목')
      .attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });

  it('PATCH /meetings/:id updates title + recorded_at and returns the row', async () => {
    const mid = (await upload()).body.id;
    const res = await request(srv())
      .patch(`/meetings/${mid}`)
      .send({ title: '새 제목', recorded_at: '2026-07-03T09:00:00Z' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(mid);
    expect(res.body.title).toBe('새 제목');
    expect(new Date(res.body.recorded_at).toISOString()).toBe('2026-07-03T09:00:00.000Z');

    const row = await db.pool.query('SELECT title, recorded_at FROM meeting WHERE id=$1', [mid]);
    expect(row.rows[0].title).toBe('새 제목');
    expect(row.rows[0].recorded_at).not.toBeNull();
  });

  it('PATCH /meetings/:id accepts a date-only recorded_at and null clears', async () => {
    const mid = (await upload()).body.id;
    const dateOnly = await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: '2026-07-03' });
    expect(dateOnly.status).toBe(200);
    expect(dateOnly.body.recorded_at).not.toBeNull();

    const cleared = await request(srv())
      .patch(`/meetings/${mid}`)
      .send({ title: null, recorded_at: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.title).toBeNull();
    expect(cleared.body.recorded_at).toBeNull();
  });

  it('PATCH /meetings/:id → 400 for invalid recorded_at / title', async () => {
    const mid = (await upload()).body.id;
    expect((await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: 'not-a-date' })).status).toBe(400);
    expect((await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: '2026-13-40' })).status).toBe(400);
    expect((await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: 12345 })).status).toBe(400);
    expect((await request(srv()).patch(`/meetings/${mid}`).send({ title: 123 })).status).toBe(400);
    // unchanged after rejected patches
    const row = await db.pool.query('SELECT title FROM meeting WHERE id=$1', [mid]);
    expect(row.rows[0].title).toBe('원래 제목');
  });

  it('PATCH /meetings/:id → 404 for unknown id', async () => {
    const res = await request(srv()).patch('/meetings/mtg_999999').send({ title: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /meetings/:id cascades child rows, removes files, returns 204', async () => {
    const created = await upload();
    const mid = created.body.id;
    // audio file was written to disk by the upload
    expect(fs.existsSync(meetingDir(mid))).toBe(true);

    // extra child rows across every cascade path
    const cluster = await db.pool.query(
      `INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version) VALUES($1,'S0',0) RETURNING id`,
      [mid],
    );
    const utt = await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'S0',0,1000,'안녕','ok',0,0) RETURNING id`,
      [mid],
    );
    const zeros = '[' + Array(1024).fill(0).join(',') + ']';
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`,
      [utt.rows[0].id, zeros],
    );
    await db.pool.query(
      `INSERT INTO job(type,meeting_id,payload,status) VALUES('index_meeting',$1,'{}'::jsonb,'queued')`,
      [mid],
    );

    const res = await request(srv()).delete(`/meetings/${mid}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const q = async (sql: string, p: unknown[]) => (await db.pool.query(sql, p)).rowCount;
    expect(await q('SELECT 1 FROM meeting WHERE id=$1', [mid])).toBe(0);
    expect(await q('SELECT 1 FROM meeting_cluster WHERE id=$1', [cluster.rows[0].id])).toBe(0);
    expect(await q('SELECT 1 FROM utterance WHERE id=$1', [utt.rows[0].id])).toBe(0);
    expect(await q('SELECT 1 FROM utterance_embedding WHERE utterance_id=$1', [utt.rows[0].id])).toBe(0);
    expect(await q('SELECT 1 FROM job WHERE meeting_id=$1', [mid])).toBe(0);
    // on-disk directory removed
    expect(fs.existsSync(meetingDir(mid))).toBe(false);
  });

  it('DELETE /meetings/:id → 404 for unknown id', async () => {
    const res = await request(srv()).delete('/meetings/mtg_999999');
    expect(res.status).toBe(404);
  });
});
