import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { LiveAudioService } from '../src/storage/live-audio.service';

const CHUNK = 32768;
const chunk = (fill: number) => Buffer.alloc(CHUNK, fill);

describe('live audio append', () => {
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
  afterEach(async () => { jest.restoreAllMocks(); await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const start = (body: object = {}) => request(srv()).post('/meetings/live').send(body);

  const send = (id: string, offset: number, body: Buffer, elapsed?: number) => {
    let req = request(srv()).post(`/meetings/${id}/live/audio`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset));
    if (elapsed !== undefined) req = req.set('X-Capture-Elapsed', String(elapsed));
    return req.send(body);
  };

  it('accepts sequential chunks and reports the next expected offset', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200)
      .expect((r) => expect(r.body).toEqual({ accepted_offset: CHUNK, expected_offset: CHUNK }));
    await send(m.id, CHUNK, chunk(2)).expect(200)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK * 2));
  });

  it('409 carries expected_offset so a lost ACK can resync', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    // 클라이언트가 200을 못 받고 같은 청크를 다시 보낸다
    await send(m.id, 0, chunk(1)).expect(409)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
    // 그 값으로 재동기화하면 이어진다
    await send(m.id, CHUNK, chunk(2)).expect(200);
  });

  it('409 on a gap — a skipped chunk never becomes a silent hole', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, CHUNK * 5, chunk(1)).expect(409)
      .expect((r) => expect(r.body.expected_offset).toBe(0));
  });

  it('400 on odd offset, wrong body length — before touching file or DB', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 1, chunk(1)).expect(400);
    await send(m.id, 0, Buffer.alloc(100)).expect(400);
    // 아무것도 안 쓰였다
    await send(m.id, 0, chunk(1)).expect(200)
      .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
  });

  it('the first chunk stamps recorded_at', async () => {
    const { body: m } = await start().expect(201);
    const before = await db.pool.query(`SELECT recorded_at FROM meeting WHERE id=$1`, [m.id]);
    await send(m.id, 0, chunk(1)).expect(200);
    const after = await db.pool.query(`SELECT recorded_at FROM meeting WHERE id=$1`, [m.id]);
    expect(after.rows[0].recorded_at.getTime()).toBeGreaterThanOrEqual(before.rows[0].recorded_at.getTime());
  });

  it('every accepted chunk advances last_input_at', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const { rows } = await db.pool.query(
      `SELECT j.last_input_at FROM job j JOIN meeting m ON m.current_job_id=j.id WHERE m.id=$1`, [m.id]);
    expect(rows[0].last_input_at).not.toBeNull();
  });

  it('records a capture gap when elapsed runs ahead of the audio', async () => {
    const { body: m } = await start().expect(201);
    // 1.024초치 오디오인데 클라이언트는 10초가 흘렀다고 말한다 — 맥이 잤다
    await send(m.id, 0, chunk(1), 10_000).expect(200);
    const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].capture_error?.code).toBe('capture_gap');
  });

  it('rejects appends after the session is sealed', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await db.pool.query(
      `UPDATE job SET sealed_bytes=$2 WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`,
      [m.id, CHUNK]);
    await send(m.id, CHUNK, chunk(2)).expect(409);
  });

  it('two concurrent appends at the same offset — exactly one wins', async () => {
    const { body: m } = await start().expect(201);
    const [a, b] = await Promise.all([send(m.id, 0, chunk(1)), send(m.id, 0, chunk(2))]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [m.id]);
    const size = fs.statSync(path.join(db.storageRoot, rows[0].audio_key)).size;
    expect(size).toBe(44 + CHUNK);   // 둘 다 쓰였으면 44 + 65536이다
  });

  // 브리프에는 없는 회귀 테스트. appendAudio의 io_error 분기는 실패 마킹(job.fail +
  // meeting.markFailed)을 append 트랜잭션 *밖의* 새 트랜잭션에서 커밋해야 한다 — 안에서
  // 하고 던지면 그 트랜잭션 자체가 롤백돼 마킹이 통째로 사라진다(원래 브리프의 버그).
  // 이 테스트는 append(디스크 쓰기)가 실패하는 정확히 그 경로를 때려, 507과 함께
  // job/meeting이 실제로 failed로 커밋됐는지 직접 확인한다.
  it('507 on a disk write failure — job and meeting are actually marked failed, not rolled back', async () => {
    const { body: m } = await start().expect(201);
    jest.spyOn(app.get(LiveAudioService), 'append').mockRejectedValueOnce(new Error('ENOSPC'));
    await send(m.id, 0, chunk(1)).expect(507)
      .expect((r) => expect(r.body).toEqual({ code: 'io_error' }));
    const { rows } = await db.pool.query(
      `SELECT m.status AS meeting_status, m.error AS meeting_error,
              j.status AS job_status, j.error AS job_error
       FROM meeting m JOIN job j ON j.id = m.current_job_id WHERE m.id=$1`, [m.id]);
    expect(rows[0].meeting_status).toBe('failed');
    expect(rows[0].meeting_error.code).toBe('io_error');
    expect(rows[0].job_status).toBe('failed');
    expect(rows[0].job_error.code).toBe('io_error');
    // 세션이 닫혔으니 재시도는 더 이상 recording이 아니라 409다 — 워커가 영원히 tail하지 않는다
    await send(m.id, 0, chunk(1)).expect(409);
  });

  it('closes the session when the audio file cannot be created', async () => {
    jest.spyOn(app.get(LiveAudioService), 'create').mockRejectedValueOnce(new Error('ENOSPC'));
    await start().expect(500);
    const { rows } = await db.pool.query(
      `SELECT status, error FROM meeting WHERE status IN ('recording','failed') ORDER BY created_at DESC LIMIT 1`);
    // recording으로 갇히지 않는다 — 다음 녹음이 막히면 안 된다
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('io_error');
  });

  it('a failed start does not block the next recording', async () => {
    jest.spyOn(app.get(LiveAudioService), 'create').mockRejectedValueOnce(new Error('ENOSPC'));
    await start().expect(500);
    await start().expect(201);   // meeting_single_recording_idx에 걸리지 않는다
  });
});
