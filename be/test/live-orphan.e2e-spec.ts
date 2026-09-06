import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { LiveOrphanService } from '../src/live/live-orphan.service';

const CHUNK = 32768;
const chunk = (fill: number) => Buffer.alloc(CHUNK, fill);

describe('live orphan sweeper', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let orphans: LiveOrphanService;
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
    orphans = app.get(LiveOrphanService);
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

  const stop = (id: string, offset: number, final: number, body = Buffer.alloc(0)) =>
    request(srv()).post(`/meetings/${id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset))
      .set('X-Final-Offset', String(final))
      .send(body);

  const age = (meetingId: string, seconds: number, hasInput: boolean) =>
    db.pool.query(
      `UPDATE job SET last_input_at = CASE WHEN $3 THEN now() - ($2||' seconds')::interval ELSE NULL END,
                      created_at = now() - ($2||' seconds')::interval
       WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`,
      [meetingId, String(seconds), hasInput]);

  it('seals an abandoned session and marks producer_abandoned', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await age(m.id, 120, true);

    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT status, duration_ms, capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].duration_ms).toBe(CHUNK / 32);
    expect(rows[0].capture_error.code).toBe('producer_abandoned');
  });

  it('catches a session that died before its first chunk (last_input_at IS NULL)', async () => {
    const { body: m } = await start().expect(201);
    await age(m.id, 120, false);
    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(`SELECT status, error FROM meeting WHERE id=$1`, [m.id]);
    // 0바이트는 finalize하지 않는다 — 넘길 녹음이 없다
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('producer_never_started');
  });

  it('does not delete the meeting — a scanner never destroys user data', async () => {
    const { body: m } = await start().expect(201);
    await age(m.id, 120, false);
    await orphans.sweep();
    const { rows } = await db.pool.query(`SELECT 1 FROM meeting WHERE id=$1`, [m.id]);
    expect(rows).toHaveLength(1);
  });

  it('leaves a live session alone', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    expect(await orphans.sweep()).toBe(0);
    const { rows } = await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('recording');
  });

  it('leaves an already-sealed session alone', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200);
    await age(m.id, 120, true);
    expect(await orphans.sweep()).toBe(0);
  });

  /** 워커의 claim을 SQL로 흉내 낸다. */
  const claim = (id: string) =>
    db.pool.query(
      `UPDATE job SET status='running', locked_by='w1', locked_at=now(), attempts=1, stage='capture'
       WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`, [id]);
  /** reaper가 그 워커를 잃었다고 판정한 상태. */
  const reap = (id: string) =>
    db.pool.query(
      `UPDATE job SET status='failed', error='{"code":"stale_worker"}'::jsonb
       WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`, [id]);

  // 워커가 죽어 봉인만 되고 아무도 마무리하지 않는 상태를 스위퍼가 집어낸다. 이걸 안
  // 집으면 회의가 'recording'에 영원히 갇히고 부분 유일 인덱스가 다음 녹음까지 막는다.
  it('finalizes a sealed session whose worker was lost', async () => {
    const { body: m } = await start().expect(201);
    await claim(m.id);
    await send(m.id, 0, chunk(1)).expect(200);
    // 워커가 살아 있다고 믿고 봉인만 하고 넘긴다.
    const res = await stop(m.id, CHUNK, CHUNK).expect(200);
    expect(res.body.outcome).toBe('stopping');
    expect((await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id])).rows[0].status)
      .toBe('recording');

    await reap(m.id); // 그 워커는 없었다

    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT status, duration_ms, capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].duration_ms).toBe(CHUNK / 32);
    // jobs.complete가 job.error를 덮으므로 그 사실은 capture_error로 옮겨진다.
    expect(rows[0].capture_error.code).toBe('preview_worker_lost');
    const { rows: next } = await db.pool.query(
      `SELECT type FROM job WHERE meeting_id=$1 AND type='process_meeting'`, [m.id]);
    expect(next).toHaveLength(1);
  });

  it('leaves a sealed session to the worker while the job is still running', async () => {
    const { body: m } = await start().expect(201);
    await claim(m.id);
    await send(m.id, 0, chunk(1)).expect(200);
    await stop(m.id, CHUNK, CHUNK).expect(200);
    expect(await orphans.sweep()).toBe(0);
    expect((await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id])).rows[0].status)
      .toBe('recording');
  });

  // reaper가 job을 내린 뒤 사용자가 종료를 누른 경우 — 마무리할 워커가 없으므로 API가 한다.
  it('stop finalizes when the reaper already failed the job', async () => {
    const { body: m } = await start().expect(201);
    await claim(m.id);
    await send(m.id, 0, chunk(1)).expect(200);
    await reap(m.id);

    const res = await stop(m.id, CHUNK, CHUNK).expect(200);
    expect(res.body.outcome).toBe('finalized');
    const { rows } = await db.pool.query(
      `SELECT status, capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].capture_error.code).toBe('preview_worker_lost');
  });

  // 시작 직후 종료 + 워커 죽음. stop이 running job을 0바이트에서 봉인하고 워커에게
  // 맡기는데 그 워커가 없다. finalize할 녹음이 없다고 그냥 두면 회의가 영원히
  // recording이고 meeting_single_recording_idx가 다음 녹음을 전부 막는다.
  it('closes a session sealed at zero bytes whose worker never finished it', async () => {
    const { body: m } = await start().expect(201);
    await claim(m.id);
    await stop(m.id, 0, 0).expect(200); // 오디오를 한 번도 안 보냈다
    await reap(m.id);

    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(`SELECT status, error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('producer_never_started');
    // reaper가 이미 내린 job의 error는 덮지 않는다 — 그 job에 실제로 일어난 일이다.
    const { rows: j } = await db.pool.query(
      `SELECT error FROM job WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`, [m.id]);
    expect(j[0].error.code).toBe('stale_worker');

    // 그리고 다음 녹음이 실제로 시작된다 — 이 테스트의 진짜 목적이다.
    await start().expect(201);
  });

  // 브라우저가 보낸 구체적인 사유가 API의 일반적인 사유보다 우선한다.
  it('does not overwrite a capture error the browser already reported', async () => {
    const { body: m } = await start().expect(201);
    await claim(m.id);
    await send(m.id, 0, chunk(1)).expect(200);
    await reap(m.id);

    await request(srv()).post(`/meetings/${m.id}/live/stop`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(CHUNK)).set('X-Final-Offset', String(CHUNK))
      .set('X-Capture-Error', 'device_ended')
      .send(Buffer.alloc(0)).expect(200);

    const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].capture_error.code).toBe('device_ended');
  });
});
