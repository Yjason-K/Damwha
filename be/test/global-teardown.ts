import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as { __damwhaTestPg?: StartedPostgreSqlContainer }).__damwhaTestPg?.stop();
}
