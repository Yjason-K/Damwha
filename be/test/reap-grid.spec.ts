import * as fs from 'fs';
import * as path from 'path';
import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

type ReapCase = {
  name: string; type: string; attempts: number; max_attempts: number; interruptions: number;
  max_interruptions?: number;
  expect: { status: 'queued' | 'failed'; interruptions: number; dependent: string };
};
const grid = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'job-reap', 'grid.json'), 'utf8'),
) as { reap: ReapCase[] };

/**
 * 스펙 §8.1 — TS 회수 둘과 Python 회수 둘(be/worker/tests/test_reap_grid.py)이 같은 파일을
 * 읽는다. 선택자만 다르다: 기동 회수는 앞 실행 신분, reaper는 오래된 locked_at.
 */
describe('reap grid (shared with the Python worker)', () => {
  let db: StartedTestDb;
  const repo = new JobsRepository();
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function seed(c: ReapCase, lockedBy: string, lockedAgo: string) {
    const meetingStatus = c.type === 'live_session' ? 'recording'
      : c.type === 'process_meeting' ? 'processing' : 'done';
    const meetingId = (await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k', $1) RETURNING id`, [meetingStatus],
    )).rows[0].id as string;
    const cols = ['type', 'meeting_id', 'payload', 'status', 'locked_by',
      'attempts', 'max_attempts', 'interruptions'];
    const vals: unknown[] = [c.type, meetingId, '{}', 'running', lockedBy, c.attempts, c.max_attempts, c.interruptions];
    // 한도를 생략한 케이스는 컬럼을 빼 DEFAULT(026의 3)를 탄다 — 변이 M12가 여기서 잡힌다.
    if (c.max_interruptions !== undefined) { cols.push('max_interruptions'); vals.push(c.max_interruptions); }
    const placeholders = vals.map((_, i) => `$${i + 1}`);
    // locked_at은 식이라 자리표시자 밖, 맨 끝에 붙인다. lockedAgo는 이 파일의 상수 둘뿐이다.
    const jobId = (await db.pool.query(
      `INSERT INTO job(${cols.join(',')}, locked_at)
       VALUES(${placeholders.join(',')}, now() - interval '${lockedAgo}') RETURNING id`, vals,
    )).rows[0].id as string;
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [jobId, meetingId]);
    if (c.type === 'summarize_meeting') {
      await db.pool.query(
        `INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
         VALUES($1, 0, $2, 'model', 'running')`, [meetingId, jobId]);
    } else if (c.type === 'extract_lenses') {
      await db.pool.query(
        `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model, job_id)
         VALUES($1, 0, 'running', 'model', $2)`, [meetingId, jobId]);
    } else if (c.type === 'enroll_speaker') {
      await db.pool.query(
        `INSERT INTO speaker(name, enrollment_status, current_job_id) VALUES('s','provisional',$1)`, [jobId]);
    }
    return { jobId, meetingId };
  }

  async function dependent(c: ReapCase, jobId: string, meetingId: string): Promise<string> {
    if (c.type === 'summarize_meeting') {
      return (await db.pool.query(`SELECT status FROM meeting_summary WHERE job_id=$1`, [jobId])).rows[0].status;
    }
    if (c.type === 'extract_lenses') {
      return (await db.pool.query(`SELECT status FROM lens_extraction_run WHERE job_id=$1`, [jobId])).rows[0].status;
    }
    if (c.type === 'enroll_speaker') {
      const s = (await db.pool.query(`SELECT enrollment_status FROM speaker WHERE current_job_id=$1`, [jobId])).rows[0];
      return s.enrollment_status === 'failed' ? 'failed' : 'running';
    }
    return (await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [meetingId])).rows[0].status;
  }

  async function check(c: ReapCase, jobId: string, meetingId: string) {
    const row = (await db.pool.query(
      `SELECT status, attempts, interruptions, locked_by, locked_at FROM job WHERE id=$1`, [jobId],
    )).rows[0];
    expect(row).toMatchObject({
      status: c.expect.status, attempts: c.attempts, interruptions: c.expect.interruptions,
    });
    if (c.expect.status === 'queued') expect(row).toMatchObject({ locked_by: null, locked_at: null });
    expect(await dependent(c, jobId, meetingId)).toBe(c.expect.dependent);
  }

  describe.each(grid.reap.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('reclaimOrphaned', async () => {
      const { jobId, meetingId } = await seed(c, 'desktop-old', '1 second');
      await repo.reclaimOrphaned(db.pool, 'desktop-new');
      await check(c, jobId, meetingId);
    });
    it('reapStale', async () => {
      const { jobId, meetingId } = await seed(c, 'w', '45 minutes');
      await repo.reapStale(db.pool, 30);
      await check(c, jobId, meetingId);
    });
  });
});
