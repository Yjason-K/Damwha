import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { ADMIN_URL_ENV, TEMPLATE_DB } from './global-setup';

export interface StartedTestDb {
  pool: Pool;
  url: string;
  /** 이 스위트 전용 임시 STORAGE_ROOT. 앱은 process.env.STORAGE_ROOT로 같은 값을 본다. */
  storageRoot: string;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const adminUrl = process.env[ADMIN_URL_ENV];
  if (!adminUrl) throw new Error(`${ADMIN_URL_ENV} 없음 — jest globalSetup(test/global-setup.ts)이 돌지 않았다`);
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** 마이그레이션까지 적용된 스위트 전용 DB. 컨테이너는 globalSetup이 띄운 하나를 같이 쓴다. */
export async function startTestDb(): Promise<StartedTestDb> {
  const name = `t_${randomUUID().replace(/-/g, '')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`));
  const u = new URL(process.env[ADMIN_URL_ENV]!);
  u.pathname = `/${name}`;
  const url = u.toString();
  process.env.DATABASE_URL = url; // AppModule / DatabaseService read this
  // STORAGE_ROOT를 잡지 않으면 StorageService가 기본값 ./storage — 개발자의 실제
  // 스토리지 — 에 쓴다. 테스트 DB는 id가 mtg_1부터 다시 시작하므로 업로드 e2e가
  // 실제 mtg_1/original.m4a를 'fake-audio' 몇 바이트로 덮어쓴 사고가 있었다(2026-09-02).
  // StorageService는 생성자에서 경로를 고정하니 앱을 만들기 전인 여기서 잡는다.
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-test-storage-'));
  process.env.STORAGE_ROOT = storageRoot;
  const pool = new Pool({ connectionString: url });
  return {
    pool,
    url,
    storageRoot,
    stop: async () => {
      await pool.end();
      // 앱이 닫히며 남긴 연결이 있어도 지운다. 다음 스위트는 다른 이름의 DB를 받는다.
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
    reset: async () => {
      await pool.query(
        `TRUNCATE meeting_share, job, lens_evidence, lens_item, lens_extraction_run, utterance, meeting_cluster, voiceprint, meeting, speaker, tag, app_setting RESTART IDENTITY CASCADE`,
      );
      await pool.query(`ALTER SEQUENCE speaker_default_seq RESTART`);
      // 기본 폴더는 마이그레이션이 만든 행이라 TRUNCATE하지 않고 남긴다.
      await pool.query(`DELETE FROM folder WHERE NOT is_default`);
    },
  };
}
