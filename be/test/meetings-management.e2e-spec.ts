import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('meetings management (PATCH / DELETE)', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let storageRoot: string;

  beforeAll(async () => {
    db = await startTestDb();
    storageRoot = db.storageRoot; // startTestDb가 잡은 스위트 전용 임시 디렉터리
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

  it('PATCH /meetings/:id accepts a date-only recorded_at', async () => {
    const mid = (await upload()).body.id;
    const dateOnly = await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: '2026-07-03' });
    expect(dateOnly.status).toBe(200);
    expect(dateOnly.body.recorded_at).not.toBeNull();

    const cleared = await request(srv()).patch(`/meetings/${mid}`).send({ title: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.title).toBeNull();
  });

  it('PATCH /meetings/:id → 400 when recorded_at is null', async () => {
    // 모든 회의는 기준일시를 갖는다 — 해제할 수단을 남기면 NOT NULL이 뚫린다.
    const mid = (await upload()).body.id;
    const res = await request(srv()).patch(`/meetings/${mid}`).send({ recorded_at: null });
    expect(res.status).toBe(400);
    const row = await db.pool.query('SELECT recorded_at FROM meeting WHERE id=$1', [mid]);
    expect(row.rows[0].recorded_at).not.toBeNull();
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

  describe('folder_id', () => {
    const defaultId = async () =>
      (await db.pool.query(`SELECT id FROM folder WHERE is_default`)).rows[0].id as string;
    const mkFolder = async (name: string) =>
      (await request(srv()).post('/folders').send({ name }).expect(201)).body.id as string;
    const uploadTo = (folderId?: string) => {
      const req = request(srv()).post('/meetings');
      if (folderId !== undefined) req.field('folder_id', folderId);
      return req.attach('audio', Buffer.from('fake-audio'), { filename: 'rec.m4a', contentType: 'audio/mp4' });
    };
    const meetingDirs = () => {
      const root = path.join(storageRoot, 'meetings');
      return fs.existsSync(root) ? fs.readdirSync(root) : [];
    };

    it('upload without folder_id (or empty) lands in the default folder', async () => {
      const def = await defaultId();
      const omitted = await uploadTo().expect(201);
      expect(omitted.body.folder_id).toBe(def);
      const empty = await uploadTo('').expect(201);
      expect(empty.body.folder_id).toBe(def);
    });

    it('upload with folder_id lands in that folder, visible on GET list and detail', async () => {
      const fid = await mkFolder('프로젝트');
      const res = await uploadTo(fid).expect(201);
      expect(res.body.folder_id).toBe(fid);
      const list = await request(srv()).get('/meetings').expect(200);
      expect(list.body.find((m: any) => m.id === res.body.id).folder_id).toBe(fid);
      const detail = await request(srv()).get(`/meetings/${res.body.id}`).expect(200);
      expect(detail.body.folder_id).toBe(fid);
    });

    it('upload with a nonexistent or malformed folder_id → 400 and leaves no storage dir or row', async () => {
      const before = meetingDirs();
      const missing = await uploadTo('fld_999').expect(400);
      expect(missing.body.message).toBe('folder not found');
      await uploadTo('nope').expect(400);
      expect(meetingDirs()).toEqual(before);
      expect((await db.pool.query('SELECT count(*)::int AS n FROM meeting')).rows[0].n).toBe(0);
    });

    it('PATCH { folder_id } moves the meeting', async () => {
      const mid = (await upload()).body.id;
      const fid = await mkFolder('옮길 곳');
      const res = await request(srv()).patch(`/meetings/${mid}`).send({ folder_id: fid }).expect(200);
      expect(res.body.folder_id).toBe(fid);
      const row = await db.pool.query('SELECT folder_id FROM meeting WHERE id=$1', [mid]);
      expect(row.rows[0].folder_id).toBe(fid);
    });

    it('PATCH { folder_id: null | nonexistent | malformed } → 400 and leaves the folder', async () => {
      const mid = (await upload()).body.id;
      const def = await defaultId();
      await request(srv()).patch(`/meetings/${mid}`).send({ folder_id: null }).expect(400);
      const missing = await request(srv()).patch(`/meetings/${mid}`).send({ folder_id: 'fld_999' }).expect(400);
      expect(missing.body.message).toBe('folder not found');
      await request(srv()).patch(`/meetings/${mid}`).send({ folder_id: 'nope' }).expect(400);
      await request(srv()).patch(`/meetings/${mid}`).send({ folder_id: 7 }).expect(400);
      const row = await db.pool.query('SELECT folder_id FROM meeting WHERE id=$1', [mid]);
      expect(row.rows[0].folder_id).toBe(def);
    });
  });
});
