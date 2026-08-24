import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('saved utterances api', () => {
  let db: StartedTestDb;
  let app: INestApplication;

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
  });

  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const mkMeeting = async (title = '회의', recordedAt: string | null = null) =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title,recorded_at) VALUES('audio','done',$1,$2::timestamptz) RETURNING id`,
      [title, recordedAt],
    )).rows[0].id as string;
  const mkUtterance = async (
    meetingId: string,
    orderIndex: number,
    startMs: number,
    text = '원본 발언',
    status = 'ok',
    speakerId: string | null = null,
  ) =>
    (await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version,speaker_id)
       VALUES($1,'SPEAKER_00',$2,$3,$4,$5,$6,0,$7) RETURNING id`,
      [meetingId, startMs, startMs + 500, text, status, orderIndex, speakerId],
    )).rows[0].id as string;

  // Saves one utterance and back-dates the save so tests can interleave saves
  // across meetings without depending on wall-clock ordering.
  let seq = 0;
  const mkSaved = async (meetingId: string, createdAt: string) => {
    seq += 1;
    const utteranceId = await mkUtterance(meetingId, seq, seq * 1000, `발언 ${seq}`);
    const { body } = await request(srv())
      .put(`/saved-utterances/${utteranceId}`)
      .send({ text_snapshot: `발언 ${seq}` });
    await db.pool.query('UPDATE saved_utterance SET created_at=$2::timestamptz WHERE id=$1', [body.id, createdAt]);
    return body.id as string;
  };

  it('groups saves by meeting, newest meeting first', async () => {
    const older = await mkMeeting('예전 회의', '2026-07-01T00:00:00Z');
    const newer = await mkMeeting('최근 회의', '2026-07-10T00:00:00Z');
    // created_at is interleaved across the two meetings, so a flat created_at
    // ordering would alternate between them.
    const olderMid = await mkSaved(older, '2026-08-04T00:00:00Z');
    const newerOld = await mkSaved(newer, '2026-08-03T00:00:00Z');
    const olderOld = await mkSaved(older, '2026-08-02T00:00:00Z');
    const newerNew = await mkSaved(newer, '2026-08-05T00:00:00Z');

    const res = await request(srv()).get('/saved-utterances');
    expect(res.body.items.map((i: any) => i.id)).toEqual([newerNew, newerOld, olderMid, olderOld]);
  });

  it('keeps a meeting together across a keyset page boundary', async () => {
    const older = await mkMeeting('예전 회의', '2026-07-01T00:00:00Z');
    const newer = await mkMeeting('최근 회의', '2026-07-10T00:00:00Z');
    const olderMid = await mkSaved(older, '2026-08-04T00:00:00Z');
    const newerOld = await mkSaved(newer, '2026-08-03T00:00:00Z');
    const olderOld = await mkSaved(older, '2026-08-02T00:00:00Z');
    const newerNew = await mkSaved(newer, '2026-08-05T00:00:00Z');

    // limit=3 splits the older meeting's run across the boundary.
    const p1 = await request(srv()).get('/saved-utterances?limit=3');
    expect(p1.body.items.map((i: any) => i.id)).toEqual([newerNew, newerOld, olderMid]);

    const p2 = await request(srv()).get(`/saved-utterances?limit=3&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
    expect(p2.body.items.map((i: any) => i.id)).toEqual([olderOld]);
    expect(p2.body.next_cursor).toBeNull();
  });

  it('sorts a meeting with no recorded_at by when the meeting was created', async () => {
    const dated = await mkMeeting('오래된 녹음', '2020-01-01T00:00:00Z');
    const undated = await mkMeeting('녹음 날짜 없음');
    // The dated meeting's save is the more recent one, so a flat created_at
    // ordering would put it first.
    const datedSave = await mkSaved(dated, '2026-08-05T00:00:00Z');
    const undatedSave = await mkSaved(undated, '2026-08-01T00:00:00Z');

    const res = await request(srv()).get('/saved-utterances');
    expect(res.body.items.map((i: any) => i.id)).toEqual([undatedSave, datedSave]);
  });

  it('drops no rows when timestamps carry sub-millisecond precision', async () => {
    // Postgres timestamps hold microseconds; a JS Date (and so an encoded
    // cursor) only holds milliseconds. The keyset must not round past a row.
    const meetingId = await mkMeeting();
    const first = await mkSaved(meetingId, '2026-08-02T00:00:00.000123Z');
    const second = await mkSaved(meetingId, '2026-08-02T00:00:00.000456Z');

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
      const res = await request(srv()).get(`/saved-utterances${query}`);
      seen.push(...res.body.items.map((i: any) => i.id));
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }

    expect(seen.slice().sort()).toEqual([first, second].sort());
  });

  it('saves a visible snapshot and reports the saved source ID', async () => {
    const meetingId = await mkMeeting('로드맵 회의');
    const utteranceId = await mkUtterance(meetingId, 0, 65_000, '원문 첫 문장');

    const saved = await request(srv())
      .put(`/saved-utterances/${utteranceId}`)
      .send({ text_snapshot: '원문 첫 문장 두 번째 문장' });

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      utterance_id: utteranceId,
      text: '원문 첫 문장 두 번째 문장',
      start_ms: 65_000,
      meeting: { id: meetingId, title: '로드맵 회의' },
    });
    expect(
      (await request(srv()).get(`/saved-utterances/ids?utterance_ids=${utteranceId}`)).body,
    ).toEqual({ utterance_ids: [utteranceId] });
  });

  it('reports the live speaker_id so the client can tint the speaker', async () => {
    const speakerId = (await db.pool.query(
      `INSERT INTO speaker(name,enrollment_status) VALUES('조승연','ready') RETURNING id`,
    )).rows[0].id as string;
    const meetingId = await mkMeeting();
    const utteranceId = await mkUtterance(meetingId, 0, 3_000, '발언', 'ok', speakerId);
    await request(srv()).put(`/saved-utterances/${utteranceId}`).send({ text_snapshot: '발언' });

    const listed = (await request(srv()).get('/saved-utterances')).body.items[0];
    expect(listed).toMatchObject({ speaker_id: speakerId, speaker_name: '조승연' });
  });

  it('reports a null speaker_id once the source utterance is gone', async () => {
    const meetingId = await mkMeeting();
    const utteranceId = await mkUtterance(meetingId, 0, 0);
    await request(srv()).put(`/saved-utterances/${utteranceId}`).send({ text_snapshot: '남은 기록' });
    await db.pool.query('DELETE FROM utterance WHERE id=$1', [utteranceId]);

    expect((await request(srv()).get('/saved-utterances')).body.items[0]).toMatchObject({
      speaker_id: null, text: '남은 기록',
    });
  });

  it('is idempotent and preserves the first snapshot', async () => {
    const utteranceId = await mkUtterance(await mkMeeting(), 0, 0);
    const first = await request(srv())
      .put(`/saved-utterances/${utteranceId}`)
      .send({ text_snapshot: '처음 저장한 문장' });
    const repeated = await request(srv())
      .put(`/saved-utterances/${utteranceId}`)
      .send({ text_snapshot: '나중에 보낸 문장' });

    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({ id: first.body.id, text: '처음 저장한 문장' });
    expect((await db.pool.query('SELECT * FROM saved_utterance')).rowCount).toBe(1);
  });

  it('accepts repeated utterance_ids query values', async () => {
    const meetingId = await mkMeeting();
    const firstId = await mkUtterance(meetingId, 0, 0);
    const secondId = await mkUtterance(meetingId, 1, 1000);
    await request(srv()).put(`/saved-utterances/${firstId}`).send({ text_snapshot: '첫 문장' });
    await request(srv()).put(`/saved-utterances/${secondId}`).send({ text_snapshot: '두 문장' });

    const result = await request(srv())
      .get('/saved-utterances/ids')
      .query({ utterance_ids: [firstId, secondId] });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ utterance_ids: [firstId, secondId] });
  });

  it('keeps a historical snapshot but removes it with its meeting', async () => {
    const meetingId = await mkMeeting();
    const utteranceId = await mkUtterance(meetingId, 0, 0);
    await request(srv())
      .put(`/saved-utterances/${utteranceId}`)
      .send({ text_snapshot: '되짚을 문장' });

    await db.pool.query('DELETE FROM utterance WHERE id=$1', [utteranceId]);
    expect((await request(srv()).get('/saved-utterances')).body.items[0]).toMatchObject({
      utterance_id: null,
      text: '되짚을 문장',
      meeting: { id: meetingId },
    });

    await db.pool.query('DELETE FROM meeting WHERE id=$1', [meetingId]);
    expect((await request(srv()).get('/saved-utterances')).body.items).toEqual([]);
  });

  it('rejects stale and failed utterances, then deletes idempotently', async () => {
    const meetingId = await mkMeeting();
    const staleId = await mkUtterance(meetingId, 0, 0);
    const failedId = await mkUtterance(meetingId, 1, 1000, '실패', 'transcribe_failed');
    await db.pool.query('UPDATE meeting SET processing_version=1 WHERE id=$1', [meetingId]);

    expect((await request(srv()).put(`/saved-utterances/${staleId}`).send({ text_snapshot: 'x' })).status).toBe(404);
    expect((await request(srv()).put(`/saved-utterances/${failedId}`).send({ text_snapshot: 'x' })).status).toBe(404);
    expect((await request(srv()).delete('/saved-utterances/utt_999')).status).toBe(204);
  });
});
