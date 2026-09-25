import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('POST /models/*', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  // 기본 처리 설정(env 폴백): large-v3-turbo · devices.stt는 env WHISPER_DEVICE(mps→gpu). 렌즈 = 4B.
  async function currentBackend(): Promise<'mlx' | 'faster'> {
    const r = await request(srv()).get('/settings/processing');
    return r.body.devices.stt === 'gpu' ? 'mlx' : 'faster';
  }
  const jobs = async () => (await db.pool.query(`SELECT id, type, status, payload FROM job ORDER BY id`)).rows;

  it('download → 201과 job 한 개, payload는 논리 키', async () => {
    const res = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ type: 'download_model', status: 'queued' });
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ schema_version: 1, role: 'stt', name: 'small', backend: 'faster' });
  });

  it('같은 받기를 다시 누르면 새 job 없이 200으로 기존 job', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    const b = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    expect(b.status).toBe(200);
    expect(b.body.job.id).toBe(a.body.job.id);
    expect(await jobs()).toHaveLength(1);
  });

  it('동시 받기 요청은 job 하나만 넣는다', async () => {
    const body = { role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit' };
    const rs = await Promise.all([1, 2, 3, 4].map(() => request(srv()).post('/models/download').send(body)));
    expect(new Set(rs.map((r) => r.body.job.id)).size).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });

  it.each([
    [{ role: 'stt', name: 'small' }, 'backend'],
    [{ role: 'stt', name: 'huge', backend: 'mlx' }, 'name'],
    [{ role: 'summary', name: 'org/unknown' }, 'name'],
    [{ role: 'diarization', name: 'someone/else' }, 'name'],
    [{ role: 'nope', name: 'x' }, 'role'],
  ])('400: %j — 필드와 허용 값을 적는다', async (body, field) => {
    const res = await request(srv()).post('/models/download').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
    expect(res.body.message).toContain(field);
  });

  it('목록 밖이어도 렌즈 모델(BE env)은 받을 수 있다', async () => {
    const lens = process.env.LENS_LLM_MODEL ?? 'mlx-community/Qwen3.5-4B-8bit';
    const res = await request(srv()).post('/models/download').send({ role: 'summary', name: lens });
    expect(res.status).toBe(201);
  });

  it('409 model_not_deletable — 고정 역할', async () => {
    const res = await request(srv()).post('/models/delete').send({ role: 'search_embedding', name: 'BAAI/bge-m3' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ statusCode: 409, code: 'model_not_deletable' });
  });

  it('409 model_in_use_by_settings — 현재 전사 모델, 렌즈 모델', async () => {
    const be = await currentBackend();
    const stt = await request(srv()).post('/models/delete').send({ role: 'stt', name: 'large-v3-turbo', backend: be });
    expect(stt.body.code).toBe('model_in_use_by_settings');
    const lens = await request(srv()).post('/models/delete').send({ role: 'summary', name: 'mlx-community/Qwen3.5-4B-8bit' });
    expect(lens.body.code).toBe('model_in_use_by_settings');
  });

  it('409 model_in_use_by_job — queued job이 쓴다', async () => {
    await db.pool.query(
      `INSERT INTO job(type, payload) VALUES('summarize_meeting', $1::jsonb)`,
      [JSON.stringify({ schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' })],
    );
    const res = await request(srv()).post('/models/delete').send({ role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('model_in_use_by_job');
  });

  it('409 model_busy — 받는 중인 모델 삭제, 삭제 중인 모델 받기', async () => {
    await request(srv()).post('/models/download').send({ role: 'stt', name: 'tiny', backend: 'faster' });
    const del = await request(srv()).post('/models/delete').send({ role: 'stt', name: 'tiny', backend: 'faster' });
    expect(del.body.code).toBe('model_busy');
    await request(srv()).post('/models/delete').send({ role: 'stt', name: 'base', backend: 'faster' });
    const dl = await request(srv()).post('/models/download').send({ role: 'stt', name: 'base', backend: 'faster' });
    expect(dl.body.code).toBe('model_busy');
  });

  it('cancel — queued는 바로 failed(download_cancelled)', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    const c = await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id });
    expect(c.status).toBe(200);
    const row = (await db.pool.query(`SELECT status, error, stop_requested_at FROM job WHERE id=$1`, [a.body.job.id])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.error.code).toBe('download_cancelled');
  });

  it('cancel — running은 stop_requested_at만 찍는다', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    await db.pool.query(`UPDATE job SET status='running', locked_by='w', attempts=1 WHERE id=$1`, [a.body.job.id]);
    const c = await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id });
    expect(c.status).toBe(200);
    const row = (await db.pool.query(`SELECT status, stop_requested_at FROM job WHERE id=$1`, [a.body.job.id])).rows[0];
    expect(row.status).toBe('running');
    expect(row.stop_requested_at).not.toBeNull();
  });

  it('cancel — 끝난 job은 409 job_not_active, download 아닌 job은 400', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    await db.pool.query(`UPDATE job SET status='done' WHERE id=$1`, [a.body.job.id]);
    expect((await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id })).body.code).toBe('job_not_active');
    const d = await request(srv()).post('/models/delete').send({ role: 'stt', name: 'small', backend: 'faster' });
    expect((await request(srv()).post('/models/cancel').send({ jobId: d.body.job.id })).status).toBe(400);
  });

  it('GET /models — 행에 마지막 job, 활성 모델 job이 있으면 pending', async () => {
    const be = await currentBackend();
    await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: be });
    const v = (await request(srv()).get('/models')).body;
    expect(v.pending).toBe(true);
    const row = v.models.find((m: { name: string; backend: string | null }) => m.name === 'small' && m.backend === be);
    expect(row.job).toEqual({ id: expect.any(String), type: 'download_model', status: 'queued', error: null });
  });
});
