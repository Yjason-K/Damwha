import { startTestDb, StartedTestDb } from './db';
import { MeetingsRepository } from '../src/meetings/meetings.repository';

describe('findStatus retry', () => {
  let db: StartedTestDb;
  let repo: MeetingsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new MeetingsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function queuedRetry(error?: object) {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const mid = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, attempts, max_attempts, next_attempt_at, error)
       VALUES('process_meeting',$1,'{}','queued',2,5, now() + interval '90 seconds', $2::jsonb) RETURNING id`,
      [mid, error === undefined ? null : JSON.stringify(error)],
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

  /**
   * 스펙 §6 — 화면은 "재시도 대기"와 **마지막 오류 요약**을 함께 말한다. 같은 SELECT의
   * `m.error`는 회의의 오류라 재시도 대기 중에는 null이다 — 대신 쓸 수 없다.
   */
  it('reports the last attempt’s job error, which meeting.error does not carry', async () => {
    const mid = await queuedRetry({ code: 'model_download_failed', kind: 'TRANSIENT', stage: 'stt' });
    const row = await repo.findStatus(db.pool, mid);
    expect(row.retry.error).toMatchObject({ code: 'model_download_failed' });
    expect(row.error).toBeNull();
  });

  it('reports a null retry error when the job has not failed yet', async () => {
    const mid = await queuedRetry();
    const row = await repo.findStatus(db.pool, mid);
    expect(row.retry.error).toBeNull();
  });

  it('reports retry as null when the meeting has no current job', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','uploaded') RETURNING id`);
    const row = await repo.findStatus(db.pool, m.rows[0].id);
    expect(row.retry).toBeNull();
  });
});
