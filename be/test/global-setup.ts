import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { runMigrations } from '../src/database/migrate';

/**
 * 컨테이너는 실행 전체에서 하나다(이슈 152). 스위트마다 띄우던 때는 DB 스위트 52개가 각자
 * 컨테이너 기동과 마이그레이션 전체에 2.5초 넘게 썼다. 여기서 마이그레이션을 적용한
 * `TEMPLATE_DB`를 만들고, startTestDb()가 그것을 스위트 전용 DB로 복사한다.
 */
export const TEMPLATE_DB = 'damwha_template';
/** startTestDb()가 읽는다. 값은 컨테이너의 관리용 DB URL이다. */
export const ADMIN_URL_ENV = 'DAMWHA_TEST_PG_ADMIN_URL';

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
  const adminUrl = container.getConnectionUri();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${TEMPLATE_DB}`;
  // 템플릿에 연결이 남아 있으면 CREATE DATABASE … TEMPLATE이 거부되므로 여기서 닫는다.
  const pool = new Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  await pool.end();
  process.env[ADMIN_URL_ENV] = adminUrl;
  (globalThis as { __damwhaTestPg?: StartedPostgreSqlContainer }).__damwhaTestPg = container;
}
