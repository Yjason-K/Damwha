import 'dotenv/config';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../config/env';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * 러너끼리의 상호 배제 키(pg_advisory_lock). 값에 뜻은 없다 — 다른 advisory lock과 겹치지 않는 고정값이면 된다.
 *
 * 데스크톱 앱은 러너를 자식으로 띄우는데, 앱 main이 죽으면 그 러너가 살아남고 다음 실행이 러너를 또 띄운다
 * (Electron Phase 3 스펙 §6.5-4). 락이 없으면 둘 다 같은 파일을 미적용으로 보고 늦은 쪽이 `already exists`로
 * 실패해, 적용은 끝났는데 실패가 보고된다.
 */
const MIGRATION_LOCK_KEY = 4_815_162_342;

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export interface MigrationStatus {
  /** `_migrations` 행 수. 테이블이 없으면 0. */
  applied: number;
  /** 아직 적용되지 않은 파일명(정렬). */
  pending: string[];
  /** `_migrations`에는 있는데 이 트리에 `.sql`이 없는 이름(정렬) — 더 새 코드가 올린 스키마다. */
  unknown: string[];
}

export async function migrationStatus(pool: Pool): Promise<MigrationStatus> {
  const files = migrationFiles();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('_migrations') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return { applied: 0, pending: files, unknown: [] };
  const applied = (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name);
  const done = new Set(applied);
  const known = new Set(files);
  return {
    applied: applied.length,
    pending: files.filter((f) => !done.has(f)),
    unknown: applied.filter((n) => !known.has(n)).sort(),
  };
}

/** 아직 `_migrations`에 기록되지 않은 파일명(정렬). 테이블 자체가 없으면 전부. */
export async function listPendingMigrations(pool: Pool): Promise<string[]> {
  return (await migrationStatus(pool)).pending;
}

export async function runMigrations(pool: Pool): Promise<void> {
  // 세션 단위 락이라 한 연결에서 쥐고, 같은 연결로 미적용을 다시 계산하고 적용한다.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS _migrations (
           name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const file of migrationFiles()) {
        const done = await client.query('SELECT 1 FROM _migrations WHERE name=$1', [file]);
        if (done.rowCount) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations(name) VALUES($1)', [file]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      // 연결이 이미 끊겼으면 락도 함께 풀렸다. 여기서 던지면 원래 오류를 덮는다.
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * CLI 본문. `--status`면 상태만, 아니면 적용한 **뒤의** 상태를 한 줄 JSON으로 쓴다. 데스크톱 앱의 실행 게이트는
 * 이 줄을 파싱할 수 있어야 통과한다 — 러너가 아무것도 하지 않고 exit 0으로 끝나는 경우를 성공으로 읽지 않기
 * 위해서다 (Electron Phase 3 스펙 §10).
 */
export async function runCli(argv: readonly string[], pool: Pool, write: (line: string) => void): Promise<void> {
  if (!argv.includes('--status')) await runMigrations(pool);
  write(`${JSON.stringify(await migrationStatus(pool))}\n`);
}

if (require.main === module) {
  const pool = new Pool({ connectionString: loadEnv().DATABASE_URL });
  runCli(process.argv.slice(2), pool, (line) => process.stdout.write(line))
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
