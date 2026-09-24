import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('reclaimOrphaned', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function runningJob(
    opts: { lockedBy: string; attempts?: number; maxAttempts?: number; interruptions?: number },
  ) {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`,
    );
    const meetingId = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts, interruptions)
       VALUES('process_meeting',$1,'{}','running',$2, now(), $3, $4, $5) RETURNING id`,
      [meetingId, opts.lockedBy, opts.attempts ?? 1, opts.maxAttempts ?? 5, opts.interruptions ?? 0],
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

  it('counts the interruption and leaves attempts where claim put them', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-old', attempts: 2 });
    await repo.reclaimOrphaned(db.pool, 'desktop-new');
    const { rows } = await db.pool.query('SELECT attempts, interruptions FROM job WHERE id=$1', [jobId]);
    expect(rows[0]).toMatchObject({ attempts: 2, interruptions: 1 });
  });

  /**
   * Phase 6b-3 스펙 §4.2 — 앱을 세 번(기본 `max_interruptions`) 죽이는 job은 `failed`가 된다.
   * 그것이 정직하다 — 그 job이 앱을 죽이고 있을 수 있다(Phase 5 스펙 §4.1의 정직성은 그대로,
   * 셈만 attempts에서 interruptions로 옮겼다). 회수가 `locked_at`을 지우므로 30분 reaper는
   * 이 행을 두 번 다시 보지 못한다. 상한 분기가 여기 없으면 그 job은 기동마다 되살아나 영원히 돈다.
   */
  it('fails a job on its third interruption instead of requeueing it forever', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-old', attempts: 3, interruptions: 2 });
    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');
    expect(res).toEqual({ requeued: 0, failedLive: 0, failedInterrupted: 1 });
    const { rows } = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('app_restarted');
    expect(rows[0].error.message).toBe('the app was interrupted 3 times while running this job');
  });

  /**
   * P5-C10 ①("`meeting.status='processing'`인데 그 job이 `running`·`queued` 아님")은 job만
   * 닫으면 이 분기가 도는 순간 깨진다. reapStale의 failed 분기와 같은 짝을 닫는다.
   */
  it('closes the meeting of an exhausted job, like the stale reaper does', async () => {
    const { meetingId } = await runningJob({ lockedBy: 'desktop-old', attempts: 3, interruptions: 2 });
    await repo.reclaimOrphaned(db.pool, 'desktop-new');
    const { rows } = await db.pool.query('SELECT status, error FROM meeting WHERE id=$1', [meetingId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('app_restarted');
    const inconsistent = await db.pool.query(
      `SELECT count(*)::int AS n FROM meeting m JOIN job j ON j.id=m.current_job_id
        WHERE m.status='processing' AND j.status NOT IN ('running','queued')`,
    );
    expect(inconsistent.rows[0].n).toBe(0);
  });

  it('requeues the job with interruptions left and fails only the exhausted one', async () => {
    const left = await runningJob({ lockedBy: 'desktop-old', attempts: 5, maxAttempts: 5, interruptions: 0 });
    const spent = await runningJob({ lockedBy: 'desktop-old', attempts: 3, interruptions: 2 });

    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');

    expect(res).toEqual({ requeued: 1, failedLive: 0, failedInterrupted: 1 });
    const { rows } = await db.pool.query(
      'SELECT id, status FROM job WHERE id = ANY($1)', [[left.jobId, spent.jobId]]);
    expect(rows.find((r) => r.id === left.jobId).status).toBe('queued');
    expect(rows.find((r) => r.id === spent.jobId).status).toBe('failed');
    const mt = await db.pool.query('SELECT status FROM meeting WHERE id=$1', [left.meetingId]);
    expect(mt.rows[0].status).toBe('processing');
  });

  it('fails the linked lens extraction run when an exhausted extract job is reclaimed', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('lens','done') RETURNING id`);
    const meetingId = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts, interruptions)
       VALUES('extract_lenses',$1,'{}','running','desktop-old', now(), 3, 5, 2) RETURNING id`,
      [meetingId]);
    const jobId = j.rows[0].id as string;
    const run = await db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model, job_id)
       VALUES($1, 1, 'running', 'test-model', $2) RETURNING id`,
      [meetingId, jobId]);

    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');

    expect(res.failedInterrupted).toBe(1);
    const job = await db.pool.query('SELECT error FROM job WHERE id=$1', [jobId]);
    const extraction = await db.pool.query(
      'SELECT status, error, finished_at FROM lens_extraction_run WHERE id=$1', [run.rows[0].id]);
    expect(extraction.rows[0]).toMatchObject({ status: 'failed', error: job.rows[0].error });
    expect(extraction.rows[0].finished_at).not.toBeNull();
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
    const { rows } = await db.pool.query('SELECT status, error, interruptions FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('app_restarted');
    expect(rows[0].interruptions).toBe(1);
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

  it('does not fail a meeting whose current job is a newer one (spec §6.1)', async () => {
    const { jobId: oldJob, meetingId } = await runningJob({ lockedBy: 'desktop-old', attempts: 3, interruptions: 2 });
    const newer = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status) VALUES('process_meeting',$1,'{}','queued') RETURNING id`,
      [meetingId]);
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [newer.rows[0].id, meetingId]);

    const res = await repo.reclaimOrphaned(db.pool, 'desktop-new');

    expect(res.failedInterrupted).toBe(1);
    const job = await db.pool.query('SELECT status FROM job WHERE id=$1', [oldJob]);
    expect(job.rows[0].status).toBe('failed');
    const mt = await db.pool.query('SELECT status FROM meeting WHERE id=$1', [meetingId]);
    expect(mt.rows[0].status).toBe('processing');
  });

  it('a second reclaim after commit finds nothing — one interruption is counted once', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-old', attempts: 1 });
    await repo.reclaimOrphaned(db.pool, 'desktop-new');
    const again = await repo.reclaimOrphaned(db.pool, 'desktop-newer');
    expect(again).toEqual({ requeued: 0, failedLive: 0, failedInterrupted: 0 });
    const { rows } = await db.pool.query('SELECT interruptions FROM job WHERE id=$1', [jobId]);
    expect(rows[0].interruptions).toBe(1);
  });
});
