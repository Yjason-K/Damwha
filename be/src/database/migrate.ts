import 'dotenv/config';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../config/env';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** 아직 `_migrations`에 기록되지 않은 파일명(정렬). 테이블 자체가 없으면 전부. */
export async function listPendingMigrations(pool: Pool): Promise<string[]> {
  const files = migrationFiles();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('_migrations') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return files;
  const applied = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  const done = new Set(applied.rows.map((r) => r.name));
  return files.filter((f) => !done.has(f));
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const files = migrationFiles();
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM _migrations WHERE name=$1', [file]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  const pool = new Pool({ connectionString: loadEnv().DATABASE_URL });
  runMigrations(pool)
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
