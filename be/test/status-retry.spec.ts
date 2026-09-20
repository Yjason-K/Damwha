import { startTestDb, StartedTestDb } from './db';
import { MeetingsRepository } from '../src/meetings/meetings.repository';

describe('findStatus retry', () => {
  let db: StartedTestDb;
  let repo: MeetingsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new MeetingsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function queuedRetry() {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const mid = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, attempts, max_attempts, next_attempt_at)
       VALUES('process_meeting',$1,'{}','queued',2,5, now() + interval '90 seconds') RETURNING id`,
      [mid],
    );
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);
    return mid;
  }

  it('reports attempts, max_attempts and the next attempt time', async () => {
    const mid = await queuedRetry();
    const row = await repo.findStatus(db.pool, mid);
    expect(row.retry).toMatchObject({ attempts: 2, max_attempts: 5 });
    expect(row.retry.next_attempt_at).not.toBeNull();
  });

  it('reports retry as null when the meeting has no current job', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','uploaded') RETURNING id`);
    const row = await repo.findStatus(db.pool, m.rows[0].id);
    expect(row.retry).toBeNull();
  });
});
