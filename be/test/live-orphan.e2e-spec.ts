import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import * as fs from 'fs';
import { Client } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { LiveOrphanService } from '../src/live/live-orphan.service';
import { LiveRepository } from '../src/live/live.repository';
import { LiveAudioService } from '../src/storage/live-audio.service';
import { StorageService } from '../src/storage/storage.service';
import { Queryable } from '../src/jobs/jobs.types';

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
    // AppModule은 ScheduleModule.forRoot()를 등록하므로 LiveOrphanService.sweepScheduled가
    // 실제로 30초마다 돈다. 이 스위트의 장벽 테스트는 job 잠금을 1~2초 실제 시간 동안
    // 쥐고 있으므로, 그 사이 스케줄된 스윕이 끼어들어 잠금을 먼저 얻으면 아래에서 명시적으로
    // 부르는 orphans.sweep()의 반환값(예: toBe(1))이 조용히 어긋난다. 이 스위트는 sweep()을
    // 직접, 결정적으로 부르는 것이 전부이므로 백그라운드 스케줄은 여기서 끈다.
    app.get(SchedulerRegistry).getCronJobs().forEach((job) => job.stop());
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

  const liveJobId = async (meetingId: string) => {
    const { rows } = await db.pool.query(
      `SELECT id FROM job WHERE meeting_id=$1 AND type='live_session'`, [meetingId]);
    return rows[0].id as string;
  };

  const audioPath = async (meetingId: string) => {
    const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [meetingId]);
    return app.get(StorageService).resolve(rows[0].audio_key);
  };

  const processJobs = async (meetingId: string) => {
    const { rows } = await db.pool.query(
      `SELECT 1 FROM job WHERE meeting_id=$1 AND type='process_meeting'`, [meetingId]);
    return rows.length;
  };

  /**
   * 별도 커넥션이 job 행을 잠근 채 fn을 돌린다. 잠금 획득 순서를 강제하는 유일한 수단이다 —
   * 임의 sleep으로 승자를 가정하지 않는다. fn이 던지든 말든 finally에서 반드시 반납한다.
   */
  const withBarrier = async <T>(
    jobId: string, fn: (barrier: Client, barrierPid: number) => Promise<T>,
  ): Promise<T> => {
    const barrier = new Client({ connectionString: db.url });
    await barrier.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query(`SELECT id FROM job WHERE id=$1 FOR UPDATE`, [jobId]);
      return await fn(barrier, await pidOf(barrier));
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      await barrier.end();
    }
  };

  /** 그 커넥션을 서비스하는 백엔드 pid. "누가 누구를 막는가"를 정확히 지목하는 데 쓴다. */
  const pidOf = async (exec: Queryable): Promise<number> => {
    const { rows } = await exec.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`);
    return rows[0].pid;
  };

  /**
   * 잠금 보유자 `holderPid` 뒤에 줄 선 백엔드가 n개가 될 때까지 기다린다. sleep이 아니라
   * `pg_blocking_pids`가 판정한다 — `test_db_live.py`의 `_wait_until_blocked`와 같은 취지로
   * **그 백엔드**를 지목한다.
   *
   * 클러스터 전체의 `pg_locks WHERE NOT granted`를 세면 안 된다: 무관한 백엔드 하나만
   * 막혀 있어도 조건이 차서, 정작 기다리던 대기자가 큐에 들어가기 전에 테스트가 진행된다.
   * 그러면 경합 테스트가 엉뚱한 이유로 통과하고 순서를 고정한다는 목적 자체가 사라진다.
   *
   * 재귀인 이유: 같은 행의 두 번째 대기자는 보유자가 아니라 **첫 번째 대기자**가 쥔 tuple
   * 잠금에서 막힌다. `pg_blocking_pids`는 직접 차단자만 주므로, 줄 전체를 세려면 사슬을
   * 따라가야 한다.
   */
  const awaitWaiters = async (n: number, holderPid: number) => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const { rows } = await db.pool.query<{ n: number }>(
        `WITH RECURSIVE queue AS (
           SELECT a.pid FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))
           UNION
           SELECT a.pid FROM pg_stat_activity a, queue q WHERE q.pid = ANY(pg_blocking_pids(a.pid))
         )
         SELECT count(*)::int AS n FROM queue WHERE pid <> $1`, [holderPid]);
      if (rows[0].n >= n) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${n} backend(s) queued behind pid ${holderPid}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /** 주어진 입력 시각이 DB 시계로 seconds를 넘길 때까지 기다린다. */
  const untilStale = async (at: Date, seconds: number) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const { rows } = await db.pool.query(
        `SELECT clock_timestamp() > $1::timestamptz + ($2||' seconds')::interval AS stale`,
        [at.toISOString(), String(seconds)]);
      if (rows[0].stale) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the input to go stale');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

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

  // 후보 조회는 힌트일 뿐이다 (설계 §5). 조회와 잠금 사이에 정상 append가 끼면 그 세션은
  // 살아 있으므로, 잠근 뒤 DB 시계로 생존 조건을 다시 봐야 한다.
  it("rechecks input freshness after selecting an orphan candidate", async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await age(m.id, 120, true);
    const repo = app.get(LiveRepository);
    const original = repo.findOrphanCandidates.bind(repo);
    jest
      .spyOn(repo, "findOrphanCandidates")
      .mockImplementationOnce(async (exec, seconds) => {
        const candidates = await original(exec, seconds);
        await send(m.id, CHUNK, chunk(2)).expect(200);
        return candidates;
      });
    expect(await orphans.sweep()).toBe(0);
    const { rows } = await db.pool.query(
      "SELECT status FROM meeting WHERE id=$1",
      [m.id],
    );
    expect(rows[0].status).toBe("recording");
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

  // 봉인은 됐는데 job이 아직 queued인 세션 — 4시간 상한을 걸친 append가 prefix만 봉인하고
  // finalize 없이 끝냈을 때의 상태다 (설계 §4.2). 이 job을 끝낼 워커는 존재하지 않으므로
  // 스위퍼가 후보로 집어야 한다. findOrphanCandidates의 (b) 갈래가 'failed'가 아니라
  // status <> 'running'인 이유이고, stop이 'stopping'으로 답한 세션이 방치되지 않는 근거다.
  it('finalizes a sealed session that no worker ever claimed', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await db.pool.query(
      `UPDATE job SET stop_requested_at=now(), sealed_bytes=committed_bytes WHERE id=$1`,
      [await liveJobId(m.id)]);

    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT status, duration_ms, capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].duration_ms).toBe(CHUNK / 32);
    // 잃은 워커가 없다 — queued는 한 번도 claim되지 않았다는 뜻이다.
    expect(rows[0].capture_error).toBeNull();
    expect(await processJobs(m.id)).toBe(1);
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

  // 0바이트에서 봉인된 채 마무리할 워커가 없는 상태. finalize할 녹음이 없다고 그냥 두면
  // 회의가 영원히 recording이고 meeting_single_recording_idx가 다음 녹음을 전부 막는다.
  //
  // 이 상태를 사용자 stop으로 만들지 않는 이유: 설계 §3.4대로 0바이트 사용자 stop은 워커
  // 상태와 무관하게 회의를 **폐기**하므로(live-audio.e2e-spec.ts가 그것을 고정한다) 더는
  // 이 상태에 도달하지 못한다. 남은 도달 경로는 SQL로 직접 만든 봉인 — 스캐너 자신이 남긴
  // 봉인이나 옛 writer가 남긴 행이다. 검사 대상(스위퍼가 이 상태를 닫는가)은 그대로다.
  it('closes a session sealed at zero bytes whose worker never finished it', async () => {
    const { body: m } = await start().expect(201);
    await claim(m.id);
    await db.pool.query(
      `UPDATE job SET stop_requested_at=now(), committed_bytes=0, sealed_bytes=0
       WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`, [m.id]);
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

  // ── 봉인 길이의 근거 (설계 §3.4) ──────────────────────────────────────

  // orphan 봉인은 파일 크기가 아니라 committed_bytes다. 크래시가 남긴 미확정 꼬리를 먼저
  // 잘라낸 뒤 확정 경계에서 봉인한다 — 파일을 stat해 봉인하면 그 꼬리가 정본 길이가 되고,
  // duration이 floor(sealed_bytes/32)이므로 회의 길이까지 조용히 늘어난다.
  it('seals at the committed boundary and truncates the uncommitted tail', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    fs.appendFileSync(await audioPath(m.id), Buffer.alloc(777, 9)); // 크래시가 남긴 꼬리
    await age(m.id, 120, true);

    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT m.status, m.duration_ms, j.sealed_bytes, j.committed_bytes
       FROM meeting m JOIN job j ON j.meeting_id=m.id AND j.type='live_session'
       WHERE m.id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(Number(rows[0].sealed_bytes)).toBe(CHUNK);
    expect(Number(rows[0].committed_bytes)).toBe(CHUNK);
    expect(rows[0].duration_ms).toBe(CHUNK / 32);
    expect(fs.statSync(await audioPath(m.id)).size).toBe(44 + CHUNK);
  });

  // 파일이 확정 경계보다 짧으면 봉인·finalize하지 않고 I/O 실패로 끝낸다 (설계 §3.4).
  // 0으로 메워 넣지도, 파일 길이로 물러서지도 않는다 — 확정했다고 답한 바이트를 잃었다.
  it('ends a session whose file is shorter than its committed boundary as an I/O failure', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    fs.truncateSync(await audioPath(m.id), 44 + CHUNK - 100);
    await age(m.id, 120, true);

    expect(await orphans.sweep()).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT m.status, m.error, j.status AS job_status, j.error AS job_error, j.sealed_bytes
       FROM meeting m JOIN job j ON j.meeting_id=m.id AND j.type='live_session'
       WHERE m.id=$1`, [m.id]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('io_error');
    expect(rows[0].job_status).toBe('failed');
    // 회의에는 읽을 문장이, job에는 원인이 남는다.
    expect(rows[0].job_error.code).toBe('io_error');
    expect(rows[0].job_error.message).toMatch(/committed 32768/);
    expect(rows[0].sealed_bytes).toBeNull();
    expect(await processJobs(m.id)).toBe(0);
    // 회의가 recording을 벗어났으므로 다음 녹음이 막히지 않는다.
    await start().expect(201);
  });

  // ── 경합 (설계 §5) ────────────────────────────────────────────────────

  // append ↔ sweep. 후보를 집은 뒤 job 잠금을 기다리는 동안 브라우저가 정상 append를
  // 커밋했다 — 잠금을 얻은 스위퍼는 그것을 보고 아무것도 하지 않아야 한다.
  it('an append that commits while the sweeper waits for the job lock leaves the session alive', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await age(m.id, 120, true);
    const jobId = await liveJobId(m.id);
    const { rows: keys } = await db.pool.query(
      `SELECT audio_key FROM meeting WHERE id=$1`, [m.id]);

    await withBarrier(jobId, async (barrier, barrierPid) => {
      const sweeping = orphans.sweep();   // 후보를 집고 job 잠금에서 멈춘다
      await awaitWaiters(1, barrierPid);  // 장벽이 막고 있는 백엔드가 하나임을 확인한다
      // 장벽 커넥션이 정상 append의 효과를 그대로 커밋한다 — 실제 저장소/리포지토리다.
      await app.get(LiveAudioService).writeAt(keys[0].audio_key, CHUNK, chunk(2));
      await app.get(LiveRepository).setCommitted(barrier, jobId, CHUNK * 2);
      await barrier.query('COMMIT');
      expect(await sweeping).toBe(0);
    });

    const { rows } = await db.pool.query(
      `SELECT m.status, j.sealed_bytes, j.committed_bytes
       FROM meeting m JOIN job j ON j.id=$2 WHERE m.id=$1`, [m.id, jobId]);
    expect(rows[0].status).toBe('recording');
    expect(rows[0].sealed_bytes).toBeNull();
    expect(Number(rows[0].committed_bytes)).toBe(65536);
  });

  // 설계 §5 ②: 판정 기준은 트랜잭션 시작 시각(now())이 아니라 잠금을 얻은 뒤의
  // clock_timestamp()다. 스위퍼가 잠금을 기다리는 동안 producer가 조용해지면 그 둘이
  // 갈라진다 — now()로 보면 TX 시작 시점 기준이라 아직 신선하다고 답한다.
  it('judges freshness by the clock after the lock, not by the transaction start', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await age(m.id, 120, true);
    const jobId = await liveJobId(m.id);

    await withBarrier(jobId, async (barrier, barrierPid) => {
      const sweeping = orphans.sweep();
      await awaitWaiters(1, barrierPid);
      // 스위퍼의 TX가 시작된 **뒤**의 입력이다. TX 시작 시각으로 재면 영원히 신선하다.
      const { rows } = await barrier.query(
        `UPDATE job SET last_input_at = clock_timestamp() - interval '89 seconds'
         WHERE id=$1 RETURNING last_input_at`, [jobId]);
      await untilStale(rows[0].last_input_at as Date, 90);
      await barrier.query('COMMIT');
      expect(await sweeping).toBe(1);
    });

    const { rows } = await db.pool.query(
      `SELECT status, capture_error FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].capture_error.code).toBe('producer_abandoned');
  });

  // API sweep 둘이 같은 후보를 집었다. 같은 job 행에서 직렬화되고, 진 쪽은 잠금을 얻은
  // 뒤 recording이 아님을 보고 아무것도 바꾸지 않는다 — process job은 하나다.
  it('two sweepers on the same candidate produce exactly one process job', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    await age(m.id, 120, true);
    const jobId = await liveJobId(m.id);

    const results = await withBarrier(jobId, async (barrier, barrierPid) => {
      const a = orphans.sweep();
      const b = orphans.sweep();
      await awaitWaiters(2, barrierPid);  // 둘 다 이 장벽 뒤에서 대기한다
      await barrier.query('ROLLBACK');
      return Promise.all([a, b]);
    });

    expect(results.slice().sort()).toEqual([0, 1]);
    expect(await processJobs(m.id)).toBe(1);
    const { rows } = await db.pool.query(
      `SELECT status, duration_ms FROM meeting WHERE id=$1`, [m.id]);
    expect(rows[0].status).toBe('uploaded');
    expect(rows[0].duration_ms).toBe(CHUNK / 32);
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
