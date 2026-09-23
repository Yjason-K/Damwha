import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { migrationStatus, runCli, runMigrations } from '../src/database/migrate';

const FILES = fs
  .readdirSync(path.join(__dirname, '..', 'src', 'database', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('migrate — status, runner lock, CLI line', () => {
  let db: StartedTestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db?.stop();
  });

  /** startTestDb의 DB는 이미 적용돼 있다. 빈 DB가 필요한 테스트는 같은 컨테이너에 새로 만든다. */
  async function freshDatabase(name: string): Promise<{ url: string; pool: Pool }> {
    await db.pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(db.url);
    url.pathname = `/${name}`;
    return { url: url.toString(), pool: new Pool({ connectionString: url.toString() }) };
  }

  it('reports every file as pending on a database without _migrations', async () => {
    const { pool } = await freshDatabase('status_fresh');
    try {
      expect(await migrationStatus(pool)).toEqual({ applied: 0, pending: FILES, unknown: [] });
    } finally {
      await pool.end();
    }
  });

  it('reports nothing pending once everything is applied', async () => {
    expect(await migrationStatus(db.pool)).toEqual({ applied: FILES.length, pending: [], unknown: [] });
  });

  it('lists applied names the bundle does not know as unknown', async () => {
    // 데스크톱 게이트가 "더 새 버전의 앱이 올린 DB"를 거부하는 근거다 (스펙 §6.5-2).
    const { pool } = await freshDatabase('status_unknown');
    try {
      await runMigrations(pool);
      await pool.query(`INSERT INTO _migrations(name) VALUES ('999_from_future.sql')`);
      expect(await migrationStatus(pool)).toEqual({
        applied: FILES.length + 1,
        pending: [],
        unknown: ['999_from_future.sql'],
      });
    } finally {
      await pool.end();
    }
  });

  it('lets two overlapping runners both succeed and applies each file once', async () => {
    // 락이 없으면 둘 다 같은 파일을 미적용으로 보고 늦은 쪽이 already exists로 실패한다 — 적용은 끝났는데
    // 게이트가 실패를 띄운다 (스펙 §6.5-4).
    const { url, pool: a } = await freshDatabase('status_overlap');
    const b = new Pool({ connectionString: url });
    try {
      await Promise.all([runMigrations(a), runMigrations(b)]);
      const { rows } = await a.query<{ n: number }>('SELECT count(*)::int AS n FROM _migrations');
      expect(rows[0].n).toBe(FILES.length);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('prints exactly one JSON line — the state alone with --status, the state after applying without it', async () => {
    const { pool } = await freshDatabase('status_cli');
    const lines: string[] = [];
    try {
      await runCli(['--status'], pool, (l) => lines.push(l));
      await runCli([], pool, (l) => lines.push(l));
      expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        { applied: 0, pending: FILES, unknown: [] },
        { applied: FILES.length, pending: [], unknown: [] },
      ]);
    } finally {
      await pool.end();
    }
  });
});
