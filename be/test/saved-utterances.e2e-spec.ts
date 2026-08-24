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
  const mkMeeting = async (title = '회의') =>
    (await db.pool.query(
      `INSERT INTO meeting(audio_key,status,title) VALUES('audio','done',$1) RETURNING id`,
      [title],
    )).rows[0].id as string;
  const mkUtterance = async (
    meetingId: string,
    orderIndex: number,
    startMs: number,
    text = '원본 발언',
    status = 'ok',
  ) =>
    (await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',$2,$3,$4,$5,$6,0) RETURNING id`,
      [meetingId, startMs, startMs + 500, text, status, orderIndex],
    )).rows[0].id as string;

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
