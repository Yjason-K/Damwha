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

  describe('GET /meetings card fields', () => {
    const addMeeting = async (pv = 0) => (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,processing_version) VALUES('k','done',$1) RETURNING id`, [pv],
    )).rows[0].id as string;
    const addSpeaker = async (name: string, isMe = false) => (await db.pool.query(
      `INSERT INTO speaker(name, enrollment_status, is_me) VALUES($1,'ready',$2) RETURNING id`, [name, isMe],
    )).rows[0].id as string;
    const addCluster = (mid: string, label: string, pv: number, speakerId: string | null = null) =>
      db.pool.query(
        `INSERT INTO meeting_cluster(meeting_id,diar_label,resolved_speaker_id,processing_version)
         VALUES($1,$2,$3,$4)`,
        [mid, label, speakerId, pv],
      );
    const addLens = (
      mid: string,
      o: {
        kind: string; text: string; lifecycle?: string; completion?: string;
        assignee?: string | null; due?: string | null; createdAt?: string;
      },
    ) => db.pool.query(
      `INSERT INTO lens_item(meeting_id,kind,text,source,user_modified,lifecycle_status,completion_status,
                             assignee_speaker_id,due_at,created_at)
       VALUES($1,$2,$3,'user',true,$4,$5,$6,$7,$8)`,
      [mid, o.kind, o.text, o.lifecycle ?? 'active', o.completion ?? 'open', o.assignee ?? null,
        o.due ?? null, o.createdAt ?? '2026-10-01T00:00:00Z'],
    );
    const addSaved = (mid: string, text: string) => db.pool.query(
      `INSERT INTO saved_utterance(meeting_id,text_snapshot,start_ms_snapshot) VALUES($1,$2,0)`, [mid, text],
    );
    const addSummary = (mid: string, status: string, segments: unknown) => db.pool.query(
      `INSERT INTO meeting_summary(meeting_id,processing_version,model,status,segments)
       VALUES($1,0,'m',$2,$3::jsonb)`,
      [mid, status, JSON.stringify(segments)],
    );
    const listRow = async (mid: string) =>
      (await request(srv()).get('/meetings').expect(200)).body.find((m: any) => m.id === mid);

    it('a meeting with nothing attached carries zero counts and null previews', async () => {
      const mid = await addMeeting();
      expect(await listRow(mid)).toMatchObject({
        participant_count: 0, decision_count: 0, action_count: 0, saved_count: 0, has_me: false,
        preview_decision: null, preview_action: null, preview_summary: null,
      });
    });

    it('counts current-version clusters and active lens items only, as ints', async () => {
      const mid = await addMeeting(1);
      await addCluster(mid, 'OLD0', 0);
      await addCluster(mid, 'OLD1', 0);
      await addCluster(mid, 'S0', 1);
      await addCluster(mid, 'S1', 1);
      await addCluster(mid, 'S2', 1);
      await addLens(mid, { kind: 'decision', text: 'd1' });
      await addLens(mid, { kind: 'decision', text: 'd2' });
      await addLens(mid, { kind: 'decision', text: 'd-archived', lifecycle: 'archived' });
      await addLens(mid, { kind: 'action', text: 'a1', completion: 'done' });
      await addLens(mid, { kind: 'action', text: 'a-archived', lifecycle: 'archived' });
      await addLens(mid, { kind: 'promise', text: 'p1' });
      await addSaved(mid, '저장 1');
      await addSaved(mid, '저장 2');
      // 다른 회의의 행은 섹이지 않는다
      const other = await addMeeting();
      await addLens(other, { kind: 'decision', text: 'other' });
      await addSaved(other, '다른 회의');

      const row = await listRow(mid);
      expect(row).toMatchObject({ participant_count: 3, decision_count: 2, action_count: 1, saved_count: 2 });
      for (const k of ['participant_count', 'decision_count', 'action_count', 'saved_count']) {
        expect(typeof row[k]).toBe('number');
      }
    });

    it('has_me is true only when a current-version cluster resolves to the me speaker', async () => {
      const me = await addSpeaker('나', true);
      const other = await addSpeaker('남');
      const current = await addMeeting(1);
      await addCluster(current, 'S0', 1, me);
      // 나는 이전 처리 결과에만 있고 현재 결과에는 남만 있다
      const stale = await addMeeting(1);
      await addCluster(stale, 'OLD0', 0, me);
      await addCluster(stale, 'S0', 1, other);
      const notMe = await addMeeting();
      await addCluster(notMe, 'S0', 0, other);

      expect((await listRow(current)).has_me).toBe(true);
      expect((await listRow(stale)).has_me).toBe(false);
      expect((await listRow(notMe)).has_me).toBe(false);

      // 나 지정을 풀면 false
      await request(srv()).delete(`/speakers/${me}/me`).expect(204);
      expect((await listRow(current)).has_me).toBe(false);
    });

    it('preview_decision is the earliest active decision', async () => {
      const mid = await addMeeting();
      await addLens(mid, { kind: 'decision', text: '나중 결정', createdAt: '2026-10-02T00:00:00Z' });
      await addLens(mid, { kind: 'decision', text: '보관된 결정', lifecycle: 'archived', createdAt: '2026-09-01T00:00:00Z' });
      await addLens(mid, { kind: 'decision', text: '첫 결정', createdAt: '2026-10-01T00:00:00Z' });
      expect((await listRow(mid)).preview_decision).toBe('첫 결정');
    });

    it('preview_action prefers an open action over an earlier done one, with assignee and due date', async () => {
      const mid = await addMeeting();
      const sid = await addSpeaker('민수');
      await addLens(mid, { kind: 'action', text: '끝난 일', completion: 'done', createdAt: '2026-09-01T00:00:00Z' });
      await addLens(mid, { kind: 'action', text: '보관된 일', lifecycle: 'archived', createdAt: '2026-09-02T00:00:00Z' });
      await addLens(mid, {
        kind: 'action', text: '남은 일', assignee: sid, due: '2026-10-10', createdAt: '2026-10-01T00:00:00Z',
      });
      await addLens(mid, { kind: 'action', text: '더 늦은 남은 일', createdAt: '2026-10-03T00:00:00Z' });
      expect((await listRow(mid)).preview_action).toEqual({
        text: '남은 일', assignee_name: '민수', due_at: '2026-10-10', done: false,
      });
    });

    it('preview_action falls back to a done action when nothing is open', async () => {
      const mid = await addMeeting();
      await addLens(mid, { kind: 'action', text: '다 한 일', completion: 'done' });
      expect((await listRow(mid)).preview_action).toEqual({
        text: '다 한 일', assignee_name: null, due_at: null, done: true,
      });
    });

    it('preview_summary is the first bullet of the first segment, only when the summary is done', async () => {
      const segments = [
        { title: '도입', bullets: ['첫 문장', '둘째 문장'] },
        { title: '본론', bullets: ['다른 문장'] },
      ];
      const done = await addMeeting();
      await addSummary(done, 'done', segments);
      const running = await addMeeting();
      await addSummary(running, 'running', segments);
      const empty = await addMeeting();
      await addSummary(empty, 'done', []);

      expect((await listRow(done)).preview_summary).toBe('첫 문장');
      expect((await listRow(running)).preview_summary).toBeNull();
      expect((await listRow(empty)).preview_summary).toBeNull();
    });

    it('keeps the list ordered by created_at DESC', async () => {
      const older = await addMeeting();
      await db.pool.query(`UPDATE meeting SET created_at = now() - interval '1 day' WHERE id=$1`, [older]);
      const newer = await addMeeting();
      const ids = (await request(srv()).get('/meetings').expect(200)).body.map((m: any) => m.id);
      expect(ids).toEqual([newer, older]);
    });
  });
});
