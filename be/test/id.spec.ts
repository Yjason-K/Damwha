import { Pool } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { nextId } from '../src/common/id';

describe('nextId', () => {
  let db: StartedTestDb; let pool: Pool;
  beforeAll(async () => { db = await startTestDb(); pool = db.pool; });
  afterAll(async () => { await db.stop(); });

  it('generates sequential prefixed ids', async () => {
    const a = await nextId(pool, 'meeting');
    const b = await nextId(pool, 'meeting');
    expect(a).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(Number(b.slice(4))).toBe(Number(a.slice(4)) + 1);
    expect(await nextId(pool, 'speaker')).toMatch(/^spk_[1-9][0-9]*$/);
  });
});
