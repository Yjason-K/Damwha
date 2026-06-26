import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migrate';

export interface StartedTestDb {
  pool: Pool;
  url: string;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

let container: StartedPostgreSqlContainer;

export async function startTestDb(): Promise<StartedTestDb> {
  container = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
  const url = container.getConnectionUri();
  process.env.DATABASE_URL = url; // AppModule / DatabaseService read this
  const pool = new Pool({ connectionString: url });
  await runMigrations(pool);
  return {
    pool,
    url,
    stop: async () => { await pool.end(); await container.stop(); },
    reset: async () => {
      await pool.query(
        `TRUNCATE job, utterance, meeting_cluster, voiceprint, meeting, speaker RESTART IDENTITY CASCADE`,
      );
    },
  };
}
