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
});
