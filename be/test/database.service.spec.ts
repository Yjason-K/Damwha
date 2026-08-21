import { Pool } from 'pg';
import { Logger } from '@nestjs/common';
import { DatabaseService } from '../src/database/database.service';
import * as migrate from '../src/database/migrate';
import { listPendingMigrations } from '../src/database/migrate';
import { startTestDb, StartedTestDb } from './db';

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
