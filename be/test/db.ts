import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrate';

export interface StartedTestDb {
  pool: Pool;
  url: string;
  /** 이 스위트 전용 임시 STORAGE_ROOT. 앱은 process.env.STORAGE_ROOT로 같은 값을 본다. */
  storageRoot: string;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

let container: StartedPostgreSqlContainer;

export async function startTestDb(): Promise<StartedTestDb> {
  container = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url; // AppModule / DatabaseService read this
  // STORAGE_ROOT를 잡지 않으면 StorageService가 기본값 ./storage — 개발자의 실제
  // 스토리지 — 에 쓴다. 테스트 DB는 id가 mtg_1부터 다시 시작하므로 업로드 e2e가
  // 실제 mtg_1/original.m4a를 'fake-audio' 몇 바이트로 덮어쓴 사고가 있었다(2026-09-02).
  // StorageService는 생성자에서 경로를 고정하니 앱을 만들기 전인 여기서 잡는다.
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-test-storage-'));
  process.env.STORAGE_ROOT = storageRoot;
  const pool = new Pool({ connectionString: url });
  await runMigrations(pool);
  return {
    pool,
    url,
    storageRoot,
    stop: async () => {
      await pool.end();
      await container.stop();
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
    reset: async () => {
      await pool.query(
        `TRUNCATE job, lens_evidence, lens_item, lens_extraction_run, utterance, meeting_cluster, voiceprint, meeting, speaker, app_setting RESTART IDENTITY CASCADE`,
      );
      await pool.query(`ALTER SEQUENCE speaker_default_seq RESTART`);
    },
  };
}
