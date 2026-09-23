import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('reclaim on API bootstrap', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let ids: { orphan: string; mine: string; external: string };

  beforeAll(async () => {
    db = await startTestDb();
    const mk = async (lockedBy: string) => {
      const m = await db.pool.query(
        `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
      const j = await db.pool.query(
        `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
         VALUES('process_meeting',$1,'{}','running',$2, now(), 1, 5) RETURNING id`,
        [m.rows[0].id, lockedBy]);
      return j.rows[0].id as string;
    };
    ids = { orphan: await mk('desktop-old'), mine: await mk('desktop-new'), external: await mk('worker-1') };

    process.env.WORKER_ID = 'desktop-new';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { delete process.env.WORKER_ID; await app?.close(); await db?.stop(); });

  it('requeues the previous run’s job, leaves this run’s and the external one', async () => {
    const { rows } = await db.pool.query(
      'SELECT id, status, locked_by FROM job WHERE id = ANY($1)',
      [[ids.orphan, ids.mine, ids.external]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[ids.orphan]).toMatchObject({ status: 'queued', locked_by: null });
    expect(by[ids.mine]).toMatchObject({ status: 'running', locked_by: 'desktop-new' });
    expect(by[ids.external]).toMatchObject({ status: 'running', locked_by: 'worker-1' });
  });
});
