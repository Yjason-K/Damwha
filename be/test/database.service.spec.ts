import { Pool, PoolClient } from 'pg';
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../src/database/database.service';
import * as migrate from '../src/database/migrate';
import { listPendingMigrations } from '../src/database/migrate';
import { startTestDb, StartedTestDb } from './db';

/** warn 스파이가 호출될 때까지 짧게 폴링한다 — 에러 이벤트는 비동기로 도착한다. */
async function waitForWarn(warn: jest.SpyInstance, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (warn.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('DatabaseService 부팅 검사', () => {
  const originalUrl = process.env.DATABASE_URL;
  afterEach(() => { process.env.DATABASE_URL = originalUrl; });

  it('DB에 닿지 못하면 onModuleInit이 원인을 담아 실패한다 (fail-fast)', async () => {
    // 포트 1은 아무것도 듣지 않는다 → ECONNREFUSED가 즉시 온다
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/nodb';
    const svc = new DatabaseService();
    try {
      await expect(svc.onModuleInit()).rejects.toThrow(/database unreachable/);
    } finally {
      await svc.onModuleDestroy();
    }
  });
});

describe('listPendingMigrations', () => {
  let db: StartedTestDb;
  let pool: Pool;
  beforeAll(async () => {
    db = await startTestDb();
    pool = new Pool({ connectionString: db.url });
  });
  afterAll(async () => { await pool.end(); await db.stop(); });

  it('전부 적용됐으면 빈 배열, _migrations에서 빠진 파일만 돌려준다', async () => {
    expect(await listPendingMigrations(pool)).toEqual([]);
    await pool.query(`DELETE FROM _migrations WHERE name='002_search.sql'`);
    expect(await listPendingMigrations(pool)).toEqual(['002_search.sql']);
  });

  it('마이그레이션 목록을 못 읽어도(예: dist에 .sql 없음) 부팅은 막지 않고 경고만 낸다', async () => {
    process.env.DATABASE_URL = db.url;
    const spy = jest.spyOn(migrate, 'listPendingMigrations')
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, scandir '/x/dist/database/migrations'"), { code: 'ENOENT' }));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new DatabaseService();
    try {
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pending migration check skipped.*ENOENT/));
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      await svc.onModuleDestroy();
    }
  });

  it('DatabaseService.onModuleInit은 연결되면 통과한다', async () => {
    process.env.DATABASE_URL = db.url;
    const svc = new DatabaseService();
    try {
      await expect(svc.onModuleInit()).resolves.toBeUndefined();
    } finally {
      await svc.onModuleDestroy();
    }
  });
});

// P2-C11: 부팅 뒤 DB가 커넥션을 끊어도 API 프로세스는 죽지 않고 살아남아야 한다.
// pg-pool은 idle 클라이언트의 에러를, pg Client는 트랜잭션 중인 클라이언트의 소켓
// 에러를 각각 'error'로 emit한다 — 리스너가 없으면 Node가 프로세스를 죽인다.
describe('DatabaseService 연결 끊김 복원력 (P2-C11)', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });

  it('idle 상태 커넥션이 서버 쪽에서 끊겨도 pool은 경고만 남기고 살아남는다', async () => {
    process.env.DATABASE_URL = db.url;
    const svc = new DatabaseService();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const killer = new Pool({ connectionString: db.url });
    try {
      // 쿼리를 한 번 실행해 커넥션 하나를 만들고 idle 상태로 pool에 반납시킨다
      const { rows } = await svc.query<{ pid: number }>('SELECT pg_backend_pid() as pid');
      const pid = rows[0].pid;
      // 별도의 Pool에서 그 백엔드를 강제 종료 — 서버가 커넥션을 끊는 상황을 재현한다
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);

      await waitForWarn(warn);
      expect(warn).toHaveBeenCalled();

      // 죽은 idle 클라이언트는 버려지고, 다음 쿼리는 새 커넥션으로 성공해야 한다
      await expect(svc.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      warn.mockRestore();
      await svc.onModuleDestroy();
      await killer.end();
    }
  });

  it('트랜잭션 도중 커넥션이 끊기면 트랜잭션만 실패하고 프로세스는 살아남는다', async () => {
    process.env.DATABASE_URL = db.url;
    const svc = new DatabaseService();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const killer = new Pool({ connectionString: db.url });
    let capturedClient: PoolClient | undefined;
    let listenerCountAtEntry = -1;
    try {
      await expect(
        svc.withTransaction(async (client) => {
          capturedClient = client;
          listenerCountAtEntry = client.listenerCount('error');
          const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() as pid');
          // 트랜잭션이 fn 안에 있는 도중 백엔드를 끊는다 — checkout된 클라이언트가 대상
          await killer.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
          await waitForWarn(warn);
        }),
      ).rejects.toThrow();

      expect(warn).toHaveBeenCalled();
      // pg-pool은 release() 때 자신의 idleListener를 무조건 다시 붙인다 — finally에서
      // 우리 리스너를 먼저 떼어냈다면 최종 카운트는 checkout 진입 시점(우리 리스너 하나)과
      // 같아야 한다. 떼어내지 않았다면 그 위에 쌓여 하나 더 많이 남는다 — public
      // API(listenerCount)로만 확인.
      if (capturedClient) {
        expect(capturedClient.listenerCount('error')).toBe(listenerCountAtEntry);
      }

      // 커넥션이 끊긴 클라이언트는 pool에 반납되지 않고 버려지므로, 다음 쿼리는 새
      // 커넥션으로 성공해야 한다
      await expect(svc.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      warn.mockRestore();
      await svc.onModuleDestroy();
      await killer.end();
    }
  });
});
