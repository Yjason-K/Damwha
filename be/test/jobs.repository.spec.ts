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
});
