import { Client } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';
import { MeetingsRepository } from '../src/meetings/meetings.repository';

describe('reclaimOrphaned races', () => {
  let db: StartedTestDb;
  let jobs: JobsRepository;
  let meetings: MeetingsRepository;
  beforeAll(async () => {
    db = await startTestDb();
    jobs = new JobsRepository();
    meetings = new MeetingsRepository();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function orphanJob() {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const meetingId = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
       VALUES('process_meeting',$1,'{}','running','desktop-old', now(), 1, 5) RETURNING id`,
      [meetingId]);
    const jobId = j.rows[0].id as string;
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [jobId, meetingId]);
    return { jobId, meetingId };
  }

  it('reclaim → claim: the new worker owns it once, attempts advances by one', async () => {
    const { jobId } = await orphanJob();
    await jobs.reclaimOrphaned(db.pool, 'desktop-new');
    const claimed = await jobs.claim(db.pool, 'desktop-new');
    expect(claimed?.id).toBe(jobId);
    const { rows } = await db.pool.query(
      'SELECT status, locked_by, attempts FROM job WHERE id=$1', [jobId]);
    expect(rows[0]).toMatchObject({ status: 'running', locked_by: 'desktop-new', attempts: 2 });
  });

  it('a claim racing an open reclaim transaction converges on one owner', async () => {
    const { jobId } = await orphanJob();
    const a = new Client({ connectionString: db.url });
    const b = new Client({ connectionString: db.url });
    await a.connect(); await b.connect();
    try {
      await a.query('BEGIN');
      await jobs.reclaimOrphaned(a, 'desktop-new');   // 행을 잠근 채 열어 둔다
      const claiming = jobs.claim(b, 'desktop-new');  // 같은 행을 노린다
      await a.query('COMMIT');
      const claimed = await claiming;

      const { rows } = await db.pool.query(
        'SELECT status, locked_by FROM job WHERE id=$1', [jobId]);
      // claim이 SKIP LOCKED로 건너뛰었으면 queued, 잡았으면 running — 둘 중 하나로
      // **수렴**해야 한다. running인데 locked_by가 옛 신분이거나, queued인데 잠긴 채
      // 남는 상태는 없어야 한다.
      if (claimed === null) expect(rows[0]).toMatchObject({ status: 'queued', locked_by: null });
      else expect(rows[0]).toMatchObject({ status: 'running', locked_by: 'desktop-new' });
    } finally { await a.end(); await b.end(); }
  });

  it('cancel → reclaim: a cancelled job is not resurrected', async () => {
    const { jobId, meetingId } = await orphanJob();
    const error = JobsRepository.cancelledError(null);
    await jobs.cancel(db.pool, jobId, error);            // 실제 취소 경로
    await meetings.markCancelled(db.pool, meetingId, error);

    const res = await jobs.reclaimOrphaned(db.pool, 'desktop-new');

    expect(res.requeued).toBe(0);
    const job = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [jobId]);
    expect(job.rows[0].status).toBe('failed');
    expect(job.rows[0].error.code).toBe(error.code);
    const mt = await db.pool.query('SELECT status FROM meeting WHERE id=$1', [meetingId]);
    expect(mt.rows[0].status).toBe('failed');
  });

  it('reprocess → reclaim: the new queued job is untouched and the old one is not revived', async () => {
    const { jobId: oldJobId, meetingId } = await orphanJob();
    const error = JobsRepository.cancelledError(null);
    await jobs.cancel(db.pool, oldJobId, error);
    await meetings.markCancelled(db.pool, meetingId, error);

    // 실제 재처리 경로 — 버전 bump → enqueue → current_job 교체
    const version = await meetings.bumpVersionForReprocess(db.pool, meetingId);
    const fresh = await jobs.enqueue(db.pool, {
      type: 'process_meeting', meetingId, payload: { processing_version: version },
    });
    await meetings.setCurrentJob(db.pool, meetingId, fresh.id);

    const res = await jobs.reclaimOrphaned(db.pool, 'desktop-new');

    expect(res.requeued).toBe(0);
    const { rows } = await db.pool.query(
      'SELECT status, locked_by, attempts FROM job WHERE id=$1', [fresh.id]);
    expect(rows[0]).toMatchObject({ status: 'queued', locked_by: null, attempts: 0 });
    const old = await db.pool.query('SELECT status FROM job WHERE id=$1', [oldJobId]);
    expect(old.rows[0].status).toBe('failed');
  });
});
