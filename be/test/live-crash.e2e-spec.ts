import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { StorageService } from '../src/storage/storage.service';
import type { ChildCommand, ChildMessage, CrashPoint } from './fixtures/live-crash-child';

const CHUNK = 32768;
const chunk = (fill: number) => Buffer.alloc(CHUNK, fill);
const FIXTURE = path.join(__dirname, 'fixtures', 'live-crash-child.ts');

/**
 * 진짜 SIGKILL로 검증하는 부분 쓰기 복구 (설계 §3.4의 크래시 표).
 *
 * 예외를 정상적으로 catch하는 경로(live-audio.e2e-spec.ts)와는 다른 것을 본다. 프로세스가
 * 통째로 사라지면 finally도 ROLLBACK도 실행되지 않는다 — 열린 트랜잭션은 커넥션이 끊길 때
 * 서버가 죽이고, 파일에는 fdatasync가 닿은 만큼만 남는다. 그 상태에서 **같은 요청을 그대로
 * 재전송했을 때 정본 바이트가 정확히 일치하는가**가 이 스위트의 전부다.
 *
 * 크래시 지점은 운영 코드가 아니라 자식 fixture에만 주입한다 — 프로덕션 fault injection
 * 엔드포인트를 만들지 않기 위해서다. 자식은 부모의 Testcontainers DB와 임시 STORAGE_ROOT를
 * 그대로 물려받으므로, 부모·크래시 자식·재기동 자식 셋이 같은 DB와 같은 파일을 본다.
 */
describe('live audio crash recovery', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let storage: StorageService;

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
    storage = app.get(StorageService);
    // live-orphan.e2e-spec.ts와 같은 이유 — 이 부모 앱도 AppModule을 통째로 띄우므로
    // LiveOrphanService.sweepScheduled가 30초마다 실제로 돈다. 크래시 자식들이 부모와
    // 같은 job 행·파일을 공유하므로 배경 스윕이 끼어들면 committed_bytes 어서션이 흔들린다.
    app.get(SchedulerRegistry).getCronJobs().forEach((job) => job.stop());
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const srv = () => app.getHttpServer();
  const start = () => request(srv()).post('/meetings/live').send({});
  const send = (id: string, offset: number, body: Buffer) =>
    request(srv()).post(`/meetings/${id}/live/audio`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Audio-Offset', String(offset))
      .send(body);

  const audioPath = async (id: string) => {
    const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [id]);
    return storage.resolve(rows[0].audio_key);
  };
  const liveJob = async (id: string) => {
    const { rows } = await db.pool.query(
      `SELECT committed_bytes, sealed_bytes, last_input_at FROM job
       WHERE meeting_id=$1 AND type='live_session'`, [id]);
    return rows[0] as { committed_bytes: string | null; sealed_bytes: string | null; last_input_at: Date | null };
  };
  const pcm = async (id: string) => fs.readFileSync(await audioPath(id)).subarray(44);

  /** 자식별 누적 stderr. crashAt·replay가 실패 메시지에 실어 보낼 수 있도록 fork 시점부터
   *  child 하나당 하나씩 채워 둔다. */
  const stderrOf = new WeakMap<ChildProcess, { text: string }>();
  const readStderr = (child: ChildProcess) => stderrOf.get(child)?.text || '(no stderr captured)';

  /**
   * 살아 있으면 SIGKILL하고 exit까지 기다린다. 이미 죽었으면 아무것도 하지 않는다.
   *
   * `child.exitCode === null` 확인과 `kill()` 사이에 자식이 먼저 죽으면(레이스) `kill()`이
   * 신호를 보내지 못했다는 뜻으로 `false`를 돌려준다 — 그 경우 이미 지나간 'exit'를
   * `once`로 기다리며 영원히 멈추지 않도록 그 자리에서 끝낸다.
   */
  async function killIfAlive(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      if (!child.kill('SIGKILL')) resolve();
    });
  }

  /** 자식 하나를 띄우고 ready를 기다린다. 어떤 경로로 끝나든 부모가 반드시 죽인다. */
  async function withChild<T>(point: CrashPoint, fn: (child: ChildProcess) => Promise<T>): Promise<T> {
    const child = fork(FIXTURE, [], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: { ...process.env, DATABASE_URL: db.url, STORAGE_ROOT: db.storageRoot, CRASH_POINT: point },
      // stdout은 버린다 — 자식의 Nest 부팅 로그가 jest 출력을 덮으면 진짜 실패가 안 보인다.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const captured = { text: '' };
    stderrOf.set(child, captured);
    child.stderr?.on('data', (d: Buffer) => { captured.text += d.toString(); });
    // fork 자체가 실패하면(스폰 불가, IPC 채널 오류 등) 'error'가 뜬다. 리스너가 하나도
    // 없으면 EventEmitter가 처리되지 않은 예외로 던져 jest 워커 전체를 죽인다 — 그러면
    // 실패 사유도 stderr도 안 보이는 채로 스위트가 통째로 사라진다. 이 리스너는 child의
    // 수명 내내 유지해 그 상황을 막고, 활성 대기가 있으면 아래 각 단계의 onError가 그
    // 대기를 개별적으로 reject한다.
    child.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const onMessage = (m: ChildMessage) => { if (m.type === 'ready') { cleanup(); resolve(); } };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(
            `crash child (${point}) exited (code=${code}, signal=${signal}) before ready: ${readStderr(child)}`));
        };
        const onError = (e: Error) => {
          cleanup();
          reject(new Error(`crash child (${point}) failed to start: ${e.message}`));
        };
        const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
        child.on('message', onMessage);
        child.on('exit', onExit);
        child.on('error', onError);
      });
      return await fn(child);
    } finally {
      await killIfAlive(child);
    }
  }

  /** 자식에게 요청을 시키고 크래시 지점 도달을 기다린 뒤 SIGKILL한다. */
  async function crashAt(child: ChildProcess, point: CrashPoint, cmd: ChildCommand): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onMessage = (m: ChildMessage) => {
        if (m.type === 'barrier' && m.point === point) { cleanup(); resolve(); }
        if (m.type === 'result') {
          cleanup();
          reject(new Error(`child answered ${m.status} instead of stopping at ${point}`));
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(
          `crash child (${point}) exited (code=${code}, signal=${signal}) before reaching the barrier: ${readStderr(child)}`));
      };
      const onError = (e: Error) => {
        cleanup();
        reject(new Error(`crash child (${point}) errored before reaching the barrier: ${e.message}`));
      };
      const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
      child.on('message', onMessage);
      child.on('exit', onExit);
      child.on('error', onError);
      child.send(cmd);
    });
    await killIfAlive(child);
  }

  /** 재기동 자식에게 **동일한** 요청을 다시 보낸다. */
  function replay(child: ChildProcess, cmd: ChildCommand): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const onMessage = (m: ChildMessage) => {
        if (m.type === 'result') { cleanup(); resolve({ status: m.status, body: m.body }); }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(
          `replay child exited (code=${code}, signal=${signal}) before answering: ${readStderr(child)}`));
      };
      const onError = (e: Error) => {
        cleanup();
        reject(new Error(`replay child errored before answering: ${e.message}`));
      };
      const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
      child.on('message', onMessage);
      child.on('exit', onExit);
      child.on('error', onError);
      child.send(cmd);
    });
  }

  // ① PCM 일부 쓰기 중 — DB 경계는 이전 값. 미확정 꼬리는 잘리고 요청 전체가 재전송된다.
  it('an append killed mid-write leaves an unconfirmed tail that the replay overwrites', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const cmd: ChildCommand = { type: 'append', id: m.id, offset: CHUNK, fill: 2 };

    await withChild('partial_write', (c) => crashAt(c, 'partial_write', cmd));

    // 401바이트가 디스크에 닿았지만 확정 경계는 한 바이트도 전진하지 않았다
    expect(fs.statSync(await audioPath(m.id)).size).toBe(44 + CHUNK + 401);
    expect(Number((await liveJob(m.id)).committed_bytes)).toBe(CHUNK);

    const res = await withChild('none', (c) => replay(c, cmd));
    expect(res.status).toBe(200);
    expect(res.body.expected_offset).toBe(CHUNK * 2);
    expect(await pcm(m.id)).toEqual(Buffer.concat([chunk(1), chunk(2)]));
  });

  // ② PCM sync 후 commit 전 — 디스크에 전부 있어도 미확정이다. 같은 재전송으로 회복된다.
  it('an append killed after the sync but before the commit is still not acknowledged', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const cmd: ChildCommand = { type: 'append', id: m.id, offset: CHUNK, fill: 2 };

    await withChild('after_sync', (c) => crashAt(c, 'after_sync', cmd));

    // 바이트는 전부 디스크에 있다 — 그런데도 경계는 이전 값이다
    expect(fs.statSync(await audioPath(m.id)).size).toBe(44 + CHUNK * 2);
    expect(Number((await liveJob(m.id)).committed_bytes)).toBe(CHUNK);

    const res = await withChild('none', (c) => replay(c, cmd));
    expect(res.status).toBe(200);
    expect(res.body.expected_offset).toBe(CHUNK * 2);
    expect(await pcm(m.id)).toEqual(Buffer.concat([chunk(1), chunk(2)]));
  });

  // ③ commit 후 응답 전 — 경계는 새 값. 재전송은 중복 ACK(409)이고 바이트는 그대로다.
  it('an append killed after the commit answers the replay with a duplicate ACK', async () => {
    const { body: m } = await start().expect(201);
    const cmd: ChildCommand = { type: 'append', id: m.id, offset: 0, fill: 1 };

    await withChild('after_commit', (c) => crashAt(c, 'after_commit', cmd));

    const before = await liveJob(m.id);
    expect(Number(before.committed_bytes)).toBe(CHUNK);

    const res = await withChild('none', (c) => replay(c, cmd));
    expect(res.status).toBe(409);
    expect(res.body.expected_offset).toBe(CHUNK);
    // 중복 ACK는 생존 시각을 갱신한다 — 재전송하는 producer는 분명히 살아 있다 (설계 §3.3)
    const after = await liveJob(m.id);
    expect(after.last_input_at!.getTime()).toBeGreaterThan(before.last_input_at!.getTime());
    // 청크가 두 번 붙지 않았다
    expect(await pcm(m.id)).toEqual(chunk(1));
  });

  // stop도 같은 복구를 쓴다 — 꼬리 일부만 쓰고 죽어도 재전송이 정확히 그 꼬리를 만든다.
  it('a stop killed mid-write seals on the replay with the exact tail', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const cmd: ChildCommand = {
      type: 'stop', id: m.id, offset: CHUNK, final: CHUNK + 1000, fill: 2, length: 1000,
    };

    await withChild('partial_write', (c) => crashAt(c, 'partial_write', cmd));
    const killed = await liveJob(m.id);
    expect(Number(killed.committed_bytes)).toBe(CHUNK);
    expect(killed.sealed_bytes).toBeNull();   // 봉인은 일어나지 않았다

    const res = await withChild('none', (c) => replay(c, cmd));
    expect(res.status).toBe(200);
    expect(res.body.sealed_bytes).toBe(CHUNK + 1000);
    expect(await pcm(m.id)).toEqual(Buffer.concat([chunk(1), Buffer.alloc(1000, 2)]));
  });

  // ③의 stop 판. 봉인 commit은 끝났고 응답만 유실됐다 — 같은 final의 재전송은 멱등 200이다.
  it('a stop killed after the seal commit answers the replay idempotently', async () => {
    const { body: m } = await start().expect(201);
    await send(m.id, 0, chunk(1)).expect(200);
    const cmd: ChildCommand = {
      type: 'stop', id: m.id, offset: CHUNK, final: CHUNK + 1000, fill: 2, length: 1000,
    };

    await withChild('after_commit', (c) => crashAt(c, 'after_commit', cmd));
    expect(Number((await liveJob(m.id)).sealed_bytes)).toBe(CHUNK + 1000);

    const res = await withChild('none', (c) => replay(c, cmd));
    expect(res.status).toBe(200);
    expect(res.body.sealed_bytes).toBe(CHUNK + 1000);
    expect(await pcm(m.id)).toEqual(Buffer.concat([chunk(1), Buffer.alloc(1000, 2)]));
  });
});
