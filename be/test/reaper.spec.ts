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

  it('makes a reaped stale retry immediately eligible', async () => {
    const { jobId } = await runningJob({ minutesAgo: 45, attempts: 1, maxAttempts: 3 });
    await db.pool.query(`UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=$1`, [jobId]);

    await repo.reapStale(db.pool, 30);

    const { rows } = await db.pool.query('SELECT status, next_attempt_at FROM job WHERE id=$1', [jobId]);
    expect(rows[0]).toMatchObject({ status: 'queued', next_attempt_at: null });
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

  it('fails the linked lens extraction run when an exhausted extract job is stale', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('lens-stale','done') RETURNING id`,
    );
    const meetingId = m.rows[0].id as string;
    const job = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
       VALUES('extract_lenses',$1,'{}','running','w', now() - interval '45 minutes', 3, 3)
       RETURNING id`,
      [meetingId],
    );
    const jobId = job.rows[0].id as string;
    const run = await db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model, job_id)
       VALUES($1, 1, 'running', 'test-model', $2) RETURNING id`,
      [meetingId, jobId],
    );

    const res = await repo.reapStale(db.pool, 30);

    expect(res.failed).toBe(1);
    const staleJob = await db.pool.query('SELECT error FROM job WHERE id=$1', [jobId]);
    const extractionRun = await db.pool.query(
      'SELECT status, error, finished_at FROM lens_extraction_run WHERE id=$1',
      [run.rows[0].id],
    );
    expect(extractionRun.rows[0]).toMatchObject({
      status: 'failed',
      error: staleJob.rows[0].error,
    });
    expect(extractionRun.rows[0].finished_at).not.toBeNull();
  });

  it('leaves fresh running jobs alone', async () => {
    await runningJob({ minutesAgo: 5, attempts: 1, maxAttempts: 3 });
    const res = await repo.reapStale(db.pool, 30);
    expect(res).toEqual({ requeued: 0, failed: 0 });
  });

  it('fails a stale live_session outright and marks its meeting failed (max_attempts=1)', async () => {
    const m = await db.pool.query(`INSERT INTO meeting(audio_key, status) VALUES('k','recording') RETURNING id`);
    const mid = m.rows[0].id;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts, stage)
       VALUES('live_session',$1,'{}','running','w', now() - interval '45 minutes', 1, 1, 'capture') RETURNING id`,
      [mid],
    );
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);

    const res = await repo.reapStale(db.pool, 30);
    expect(res).toEqual({ requeued: 0, failed: 1 });
    const job = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [j.rows[0].id]);
    expect(job.rows[0].status).toBe('failed');
    expect(job.rows[0].error.code).toBe('stale_worker');
    const meeting = await db.pool.query('SELECT status, error FROM meeting WHERE id=$1', [mid]);
    expect(meeting.rows[0].status).toBe('failed');
    expect(meeting.rows[0].error.code).toBe('stale_worker');
  });
});
