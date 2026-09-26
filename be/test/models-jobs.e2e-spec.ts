import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { MODEL_JOB_LOCK_NS } from '../src/models/model-jobs';
import { modelKey } from '../src/models/models-view';

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

  // 위 "동시 받기" 테스트는 같은 프로세스·같은 testcontainer 안에서 4개 요청이 실제로
  // 겹치는지 보장하지 않는다 — lockModelKey를 지워도 통과할 수 있다(20회 재현 시도, 20회 모두
  // 통과 — task-5-report.md 기록). 그래서 별도 pg 클라이언트로 advisory lock을 먼저 쥔 채
  // download()를 fire-and-forget으로 걸어 두고, 그 요청이 실제로 lock 대기자로 pg_locks에
  // 나타나는지 결정적으로 확인한다.
  it('download은 advisory lock을 실제로 기다린다 (결정적 검증)', async () => {
    const key = modelKey('summary', 'mlx-community/Qwen3.5-27B-8bit', null);
    const lockClient = await db.pool.connect();
    let committed = false;
    // sawWaiter 단언(또는 그 밖의 무엇)이 COMMIT 전에 던지면, 이 커넥션은 트랜잭션이 열린 채
    // — advisory lock과 아직 커밋 안 된 INSERT를 쥔 채 — 아래 finally로 온다. node-postgres는
    // release()에서 자동 롤백하지 않으므로, 그냥 release()하면 "idle in transaction" 커넥션이
    // 풀에 그대로 돌아가 이 lock을 다음에 요청하는 모든 것(이 download() 포함, 뒤이은 pending도
    // 포함)을 영원히 막는다 — 정확히 이 테스트가 잡으려는 회귀와 같은 모양으로 스위트 전체가
    // 멈춘다. 그래서 실패 경로에서는 커밋 여부를 보고 ROLLBACK(그 자체가 실패하면 커넥션이
    // 이미 못 쓰게 됐다고 보고 release(true)로 버린다)한 뒤에만 release한다.
    let pending: Promise<request.Response> | undefined;
    let destroyConnection = false;
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [MODEL_JOB_LOCK_NS, key]);
      const seeded = await lockClient.query(
        `INSERT INTO job(type, payload) VALUES('download_model', $1::jsonb) RETURNING id`,
        [JSON.stringify({ schema_version: 1, role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit' })],
      );
      const seededId: string = seeded.rows[0].id;

      // supertest의 Test는 thenable이라 .then()/.end()를 부르기 전엔 실제로 요청을 보내지
      // 않는다 — 여기서 await하지 않고도 즉시 실행을 걸기 위해 .then()으로 dispatch만 강제한다.
      pending = request(srv())
        .post('/models/download')
        .send({ role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit' })
        .then((r) => r);

      let sawWaiter = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const r = await db.pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
        if (r.rows.length > 0) {
          sawWaiter = true;
          break;
        }
        await new Promise((res) => setTimeout(res, 20));
      }
      // download()의 lockModelKey가 실제로 이 lock에서 막혀 pg_locks에 대기자로 잡혀야 한다.
      expect(sawWaiter).toBe(true);

      await lockClient.query('COMMIT');
      committed = true;
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.job.id).toBe(seededId);
      expect(await jobs()).toHaveLength(1);
    } finally {
      if (!committed) {
        // lock을 풀어야 막혀 있던 pending download()가 풀려 응답을 낸다 — 그래야 아래에서
        // 드레인할 수 있다. 롤백 자체가 실패하면(커넥션이 이미 끊어졌다면) 재사용하지 않는다.
        try {
          await lockClient.query('ROLLBACK');
        } catch {
          destroyConnection = true;
        }
      }
      // 실패 경로에서 아직 await하지 않은 pending이 있으면 반드시 드레인한다 — 안 그러면
      // 이 요청이 다음 테스트들이 도는 동안에도 살아 있다가 뒤늦게 끼어들 수 있다.
      if (pending) await pending.catch(() => {});
      lockClient.release(destroyConnection);
    }
  }, 10000);

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

  it('cancel — attempts>0인 queued는 직접 닫지 않고 worker에게 넘긴다 (TRANSIENT 백오프)', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    await db.pool.query(`UPDATE job SET attempts=1, next_attempt_at=now() + interval '30 seconds' WHERE id=$1`, [a.body.job.id]);
    const c = await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id });
    expect(c.status).toBe(200);
    expect(c.body.job.status).toBe('queued');
    const row = (await db.pool.query(`SELECT status, stop_requested_at, next_attempt_at FROM job WHERE id=$1`, [a.body.job.id])).rows[0];
    expect(row.status).toBe('queued');
    expect(row.stop_requested_at).not.toBeNull();
    expect(row.next_attempt_at).toBeNull();
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

  it('GET /models — deletable는 실제 job 참조를 본다: 쓰는 모델은 false, 안 쓰는 설치된 모델은 true', async () => {
    const value = {
      scanned_at: '2026-09-25T10:00:00.000000Z',
      repos: {
        'mlx-community/Qwen3.5-27B-8bit': { size_bytes: 27_000_000_000, complete: true },
        'mlx-community/Qwen3.5-9B-8bit': { size_bytes: 9_000_000_000, complete: true },
      },
      resolved: [],
      approx: {},
      worker_llm: { lens_model: null, summary_fallback: null },
    };
    await db.pool.query(`INSERT INTO app_setting(key, value) VALUES('model_inventory', $1)`, [JSON.stringify(value)]);
    // 27B를 쓰는 queued summarize_meeting — model_job_refs의 세 번째 갈래(§5.4).
    await db.pool.query(
      `INSERT INTO job(type, payload) VALUES('summarize_meeting', $1::jsonb)`,
      [JSON.stringify({ schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' })],
    );
    const res = await request(srv()).get('/models');
    const find = (name: string) =>
      res.body.models.find((m: { role: string; name: string }) => m.role === 'summary' && m.name === name);
    // 27B: 설치돼 있고 job이 참조하므로 deletable false — "modelRefs를 무시" 회귀를 잡는다.
    expect(find('mlx-community/Qwen3.5-27B-8bit')).toMatchObject({ installed: 'yes', deletable: false });
    // 9B: 설치돼 있고 아무 job·설정도 안 쓰므로 deletable true — "항상 error-fallback으로
    // 전부 in-use 취급" 회귀를 잡는다(그러면 이 행도 false가 된다).
    expect(find('mlx-community/Qwen3.5-9B-8bit')).toMatchObject({ installed: 'yes', deletable: true });
  });
});
