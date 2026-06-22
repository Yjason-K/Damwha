import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('reapStale', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  // helper: create a running job whose lock is `minutesAgo` old, with given attempts
  async function runningJob(opts: { minutesAgo: number; attempts: number; maxAttempts: number }) {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const mid = m.rows[0].id;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
       VALUES('process_meeting',$1,'{}','running','w',
              now() - ($2 || ' minutes')::interval, $3, $4) RETURNING id`,
      [mid, String(opts.minutesAgo), opts.attempts, opts.maxAttempts],
    );
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);
    return { jobId: j.rows[0].id as string, meetingId: mid as string };
  }

  it('requeues a stale job that has attempts left', async () => {
    const { jobId } = await runningJob({ minutesAgo: 45, attempts: 1, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res.requeued).toBe(1);
    const { rows } = await db.pool.query('SELECT status, locked_by FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].locked_by).toBeNull();
  });

  it('fails a stale job out of attempts and marks the meeting failed', async () => {
    const { jobId, meetingId } = await runningJob({ minutesAgo: 45, attempts: 3, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res.failed).toBe(1);
    const job = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [jobId]);
    expect(job.rows[0].status).toBe('failed');
    expect(job.rows[0].error.code).toBe('stale_worker');
    const mt = await db.pool.query('SELECT status FROM meeting WHERE id=$1', [meetingId]);
    expect(mt.rows[0].status).toBe('failed');
  });

  it('leaves fresh running jobs alone', async () => {
    await runningJob({ minutesAgo: 5, attempts: 1, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res).toEqual({ requeued: 0, failed: 0 });
  });
});
