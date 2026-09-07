import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('JobsRepository', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function seedMeeting() {
    const r = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    return r.rows[0].id as string;
  }

  it('enqueues a queued job', async () => {
    const mid = await seedMeeting();
    const job = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: { a: 1 } });
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.stage).toBeNull();
  });

  it('claim transitions to running and increments attempts', async () => {
    const mid = await seedMeeting();
    await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    const claimed = await repo.claim(db.pool, 'worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('running');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.locked_by).toBe('worker-1');
    expect(claimed!.stage).toBeNull(); // claim does not set stage
  });

  it('two concurrent claims never get the same job', async () => {
    const mid = await seedMeeting();
    await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    const [a, b] = await Promise.all([
      repo.claim(db.pool, 'w-a'),
      repo.claim(db.pool, 'w-b'),
    ]);
    const claimedIds = [a, b].filter(Boolean).map((j) => j!.id);
    expect(claimedIds.length).toBe(1); // only one wins
  });

  it('claim returns null when queue empty', async () => {
    expect(await repo.claim(db.pool, 'w')).toBeNull();
  });

  it('does not claim a queued job scheduled for the future', async () => {
    const mid = await seedMeeting();
    const job = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    await db.pool.query(`UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=$1`, [job.id]);

    expect(await repo.claim(db.pool, 'worker-1')).toBeNull();
  });

  it('claims an immediately eligible job ahead of an older delayed job', async () => {
    const delayedMeeting = await seedMeeting();
    const delayed = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: delayedMeeting, payload: {} });
    await db.pool.query(`UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=$1`, [delayed.id]);
    const readyMeeting = await seedMeeting();
    const ready = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: readyMeeting, payload: {} });

    expect((await repo.claim(db.pool, 'worker-1'))!.id).toBe(ready.id);
  });

  it('setStage, complete, fail update fields', async () => {
    const mid = await seedMeeting();
    const job = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    await repo.claim(db.pool, 'w');
    await repo.setStage(db.pool, job.id, 'diarize', 40);
    await repo.fail(db.pool, job.id, { code: 'x', message: 'boom' });
    const { rows } = await db.pool.query('SELECT * FROM job WHERE id=$1', [job.id]);
    expect(rows[0].stage).toBe('diarize');
    expect(rows[0].progress).toBe(40);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toEqual({ code: 'x', message: 'boom' });
  });

  it('summarize_meeting 잡을 큐잉하고 다시 읽어온다', async () => {
    const mid = await seedMeeting();
    const job = await repo.enqueue(db.pool, {
      type: 'summarize_meeting',
      meetingId: mid,
      payload: {
        schema_version: 1,
        meeting_id: mid,
        processing_version: 0,
        model: 'model',
      },
    });
    const { rows } = await db.pool.query(`SELECT type FROM job WHERE id = $1`, [job.id]);
    expect(rows[0].type).toBe('summarize_meeting');
  });

  it('reapStale이 요약 잡 실패 시 요약 행도 failed로 넘긴다', async () => {
    const meetingId = await seedMeeting();
    const { rows: jobRows } = await db.pool.query<{ id: string }>(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at,
                       attempts, max_attempts)
       VALUES ('summarize_meeting', $1, '{}'::jsonb, 'running', 'w',
               now() - interval '30 minutes', 3, 3)
       RETURNING id`,
      [meetingId],
    );
    await db.pool.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
       VALUES ($1, 0, $2, 'model', 'running')`,
      [meetingId, jobRows[0].id],
    );

    await repo.reapStale(db.pool, 5);

    const { rows } = await db.pool.query(
      `SELECT status FROM meeting_summary WHERE meeting_id = $1`, [meetingId],
    );
    expect(rows[0].status).toBe('failed');
  });

  it('enqueue honors maxAttempts and leaves the column default otherwise', async () => {
    const mid = await seedMeeting();
    const one = await repo.enqueue(db.pool, { type: 'live_session', meetingId: mid, payload: {}, maxAttempts: 1 });
    const def = await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    expect(one.max_attempts).toBe(1);
    expect(def.max_attempts).toBe(3);
    expect(one.stop_requested_at).toBeNull();
  });

  it('claims a queued live_session ahead of an older queued process_meeting', async () => {
    const mid = await seedMeeting();
    await repo.enqueue(db.pool, { type: 'process_meeting', meetingId: mid, payload: {} });
    await repo.enqueue(db.pool, { type: 'index_meeting', meetingId: mid, payload: {} });
    const live = await repo.enqueue(db.pool, { type: 'live_session', meetingId: mid, payload: {}, maxAttempts: 1 });
    const claimed = await repo.claim(db.pool, 'w');
    expect(claimed!.id).toBe(live.id);
  });
});
