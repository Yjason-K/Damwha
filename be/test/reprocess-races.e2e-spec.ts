import { Test } from '@nestjs/testing';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { MeetingsService } from '../src/meetings/meetings.service';

/**
 * 이슈 #81 — 같은 done/failed 상태를 읽은 재처리 요청 둘이 모두 성공해 버전을 두 번 올리고
 * 작업을 둘 만들던 경쟁. 회의 행을 잠가 두 요청이 상태 확인을 통과한 뒤 같은 행 앞에서
 * 기다리게 만든다.
 */
describe('동시 재처리', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let meetings: MeetingsService;

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
        gpu_eligible: true, recommended_preset: 'standard',
      })
      .compile();
    app = mod.createNestApplication();
    await app.init();
    meetings = app.get(MeetingsService);
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  async function waitForLockWaiters(n: number, holderPid: number): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND pid <> $1 AND datname = current_database()`,
        [holderPid],
      );
      if (rows[0].n >= n) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`expected ${n} lock waiters`);
  }

  it.each(['done', 'failed'])('%s 회의에 동시에 온 두 요청 중 하나만 새 작업을 만든다', async (status) => {
    const meetingId = (await db.pool.query(
      `INSERT INTO meeting(audio_key, status, processing_version) VALUES('k',$1,0) RETURNING id`,
      [status],
    )).rows[0].id as string;

    const holder = new Client({ connectionString: db.url });
    await holder.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE`, [meetingId]);
      const both = Promise.allSettled([meetings.reprocess(meetingId), meetings.reprocess(meetingId)]);
      await waitForLockWaiters(2, pid);
      await holder.query('COMMIT');
      results = await both;
    } finally {
      await holder.end();
    }

    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    const m = (await db.pool.query(
      `SELECT processing_version, status, current_job_id FROM meeting WHERE id=$1`, [meetingId])).rows[0];
    expect(m.processing_version).toBe(1);
    expect(m.status).toBe('uploaded');
    const jobs = (await db.pool.query(
      `SELECT id FROM job WHERE meeting_id=$1 AND type='process_meeting'`, [meetingId])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(m.current_job_id);
  });
});
