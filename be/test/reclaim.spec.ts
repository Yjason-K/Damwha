import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('reclaimOrphaned', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function runningJob(opts: { lockedBy: string; attempts?: number }) {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`,
    );
    const meetingId = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
       VALUES('process_meeting',$1,'{}','running',$2, now(), $3, 5) RETURNING id`,
      [meetingId, opts.lockedBy, opts.attempts ?? 1],
    );
    const jobId = j.rows[0].id as string;
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [jobId, meetingId]);
    return { jobId, meetingId };
  }

  it('requeues a job left running by a previous app run', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-old', attempts: 2 });
    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');
    expect(res.requeued).toBe(1);
    const { rows } = await db.pool.query(
      'SELECT status, locked_by, locked_at, next_attempt_at, attempts FROM job WHERE id=$1', [jobId]);
    expect(rows[0]).toMatchObject({
      status: 'queued', locked_by: null, locked_at: null, next_attempt_at: null,
    });
  });

  it('does not roll attempts back — a job that kills the app must still reach max_attempts', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-old', attempts: 2 });
    await repo.reclaimOrphaned(db.pool, 'desktop-new');
    const { rows } = await db.pool.query('SELECT attempts FROM job WHERE id=$1', [jobId]);
    expect(rows[0].attempts).toBe(2);
  });

  it('leaves this run’s own job alone', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-new' });
    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');
    expect(res.requeued).toBe(0);
    const { rows } = await db.pool.query('SELECT status FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('running');
  });

  it('leaves an external terminal worker’s job alone', async () => {
    const { jobId } = await runningJob({ lockedBy: 'worker-1' });
    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');
    expect(res.requeued).toBe(0);
    const { rows } = await db.pool.query('SELECT status, locked_by FROM job WHERE id=$1', [jobId]);
    expect(rows[0]).toMatchObject({ status: 'running', locked_by: 'worker-1' });
  });

  async function runningLiveJob(lockedBy: string) {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('live','recording') RETURNING id`,
    );
    const meetingId = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at,
                       attempts, max_attempts, committed_bytes, last_input_at)
       VALUES('live_session',$1,'{}','running',$2, now(), 1, 1, 1024, now()) RETURNING id`,
      [meetingId, lockedBy],
    );
    const jobId = j.rows[0].id as string;
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [jobId, meetingId]);
    return { jobId, meetingId };
  }

  it('closes a previous run’s live session as failed with app_restarted', async () => {
    const { jobId } = await runningLiveJob('desktop-old');
    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');
    expect(res.failedLive).toBe(1);
    expect(res.requeued).toBe(0);
    const { rows } = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('app_restarted');
  });

  it('does not touch the meeting or the byte boundaries of a reclaimed live session', async () => {
    const { jobId, meetingId } = await runningLiveJob('desktop-old');
    await repo.reclaimOrphaned(db.pool, 'desktop-new');
    const job = await db.pool.query(
      'SELECT committed_bytes, sealed_bytes FROM job WHERE id=$1', [jobId]);
    expect(job.rows[0].committed_bytes).toBe('1024');
    expect(job.rows[0].sealed_bytes).toBeNull();
    const mt = await db.pool.query('SELECT status, capture_error FROM meeting WHERE id=$1', [meetingId]);
    expect(mt.rows[0]).toMatchObject({ status: 'recording', capture_error: null });
  });

  it('leaves an external live session alone', async () => {
    const { jobId } = await runningLiveJob('worker-1');
    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');
    expect(res.failedLive).toBe(0);
    const { rows } = await db.pool.query('SELECT status FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('running');
  });
});
