import { Test } from '@nestjs/testing';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { SummaryService } from '../src/summary/summary.service';
import { LensExtractionService } from '../src/lenses/lens-extraction.service';

/**
 * 이슈 #80 — 요약·렌즈 취소와 워커가 같은 job·meeting 행을 반대 순서로 잠그면 40P01.
 * 워커는 job을 먼저 잠근다(`db/summaries.py`, `db/lenses.py`). 여기서는 워커 트랜잭션을
 * job 잠금 직후 멈춰 두고 취소를 끼워 넣은 뒤, 워커가 나머지 행을 잠그게 한다.
 */
describe('후속 작업 취소와 워커의 잠금 순서', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let summary: SummaryService;
  let lens: LensExtractionService;

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
    summary = app.get(SummaryService);
    lens = app.get(LensExtractionService);
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const WORKER = 'w-test';

  async function seedRunningJob(type: string): Promise<{ meetingId: string; jobId: string }> {
    const meetingId = (await db.pool.query(
      `INSERT INTO meeting(audio_key, status, processing_version) VALUES('k','done',0) RETURNING id`,
    )).rows[0].id as string;
    const jobId = (await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts)
       VALUES($1,$2,'{}','running',$3, now(), 1) RETURNING id`,
      [type, meetingId, WORKER],
    )).rows[0].id as string;
    return { meetingId, jobId };
  }

  async function seedSummary() {
    const ids = await seedRunningJob('summarize_meeting');
    await db.pool.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, model, status, topics, segments, job_id)
       VALUES($1, 0, 'm', 'queued', '[]'::jsonb, '[]'::jsonb, $2)`,
      [ids.meetingId, ids.jobId],
    );
    return ids;
  }

  async function seedLens() {
    const ids = await seedRunningJob('extract_lenses');
    const runId = (await db.pool.query(
      `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model, job_id)
       VALUES($1, 0, 'queued', 'm', $2) RETURNING id`,
      [ids.meetingId, ids.jobId],
    )).rows[0].id as string;
    return { ...ids, runId };
  }

  /** 다른 백엔드가 행 잠금을 기다릴 때까지 기다린다 — 취소가 확실히 끼어든 상태를 만든다. */
  async function waitForLockWaiter(workerPid: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.pool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND pid <> $1 AND datname = current_database()`,
        [workerPid],
      );
      if (rows.length > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('cancel never waited on a lock');
  }

  /** 워커 트랜잭션: job 잠금 → (취소가 끼어듦) → rest(나머지 잠금·쓰기) → COMMIT. */
  async function workerAround(
    jobId: string,
    cancel: () => Promise<unknown>,
    rest: (c: Client) => Promise<void>,
  ) {
    const w = new Client({ connectionString: db.url });
    await w.connect();
    try {
      const pid = (await w.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await w.query('BEGIN');
      await w.query(
        `SELECT 1 FROM job WHERE id=$1 AND locked_by=$2 AND status='running' FOR UPDATE`,
        [jobId, WORKER],
      );
      const cancelling = cancel().then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      await waitForLockWaiter(pid);
      let workerError: unknown = null;
      try {
        await rest(w);
        await w.query('COMMIT');
      } catch (e) {
        workerError = e;
        await w.query('ROLLBACK');
      }
      return { workerError, cancelled: await cancelling };
    } finally {
      await w.end();
    }
  }

  describe('요약', () => {
    it('워커가 running으로 넘기는 중 취소가 겹쳐도 교착 없이 취소가 이긴다', async () => {
      const { meetingId, jobId } = await seedSummary();

      const { workerError, cancelled } = await workerAround(
        jobId,
        () => summary.cancel(meetingId),
        async (w) => {
          // mark_summary_running과 같은 순서: job 다음 meeting
          await w.query(`SELECT processing_version FROM meeting WHERE id=$1 FOR UPDATE`, [meetingId]);
          await w.query(
            `UPDATE meeting_summary SET status='running', updated_at=now()
              WHERE meeting_id=$1 AND processing_version=0`,
            [meetingId],
          );
        },
      );

      expect(workerError).toBeNull();
      expect(cancelled).toEqual({ ok: true, v: { job_id: jobId, status: 'failed' } });
      const job = (await db.pool.query(`SELECT status, error FROM job WHERE id=$1`, [jobId])).rows[0];
      expect(job.status).toBe('failed');
      expect(job.error).toMatchObject({ code: 'cancelled' });
      const row = (await db.pool.query(
        `SELECT status FROM meeting_summary WHERE meeting_id=$1`, [meetingId])).rows[0];
      expect(row.status).toBe('failed');
    });

    it('취소가 기다리는 사이 워커가 결과를 저장하면 취소는 409, 결과는 그대로다', async () => {
      const { meetingId, jobId } = await seedSummary();

      const { workerError, cancelled } = await workerAround(
        jobId,
        () => summary.cancel(meetingId),
        async (w) => {
          // persist_summary와 같은 순서
          await w.query(`SELECT processing_version FROM meeting WHERE id=$1 FOR UPDATE`, [meetingId]);
          await w.query(
            `UPDATE meeting_summary SET status='done', updated_at=now()
              WHERE meeting_id=$1 AND processing_version=0`,
            [meetingId],
          );
          await w.query(`UPDATE job SET status='done', updated_at=now() WHERE id=$1`, [jobId]);
        },
      );

      expect(workerError).toBeNull();
      expect(cancelled.ok).toBe(false);
      expect((cancelled as { e: unknown }).e).toBeInstanceOf(ConflictException);
      const job = (await db.pool.query(`SELECT status FROM job WHERE id=$1`, [jobId])).rows[0];
      expect(job.status).toBe('done');
      const row = (await db.pool.query(
        `SELECT status FROM meeting_summary WHERE meeting_id=$1`, [meetingId])).rows[0];
      expect(row.status).toBe('done');
    });
  });

  describe('렌즈', () => {
    it('워커가 run을 running으로 넘기는 중 취소가 겹쳐도 교착 없이 취소가 이긴다', async () => {
      const { meetingId, jobId, runId } = await seedLens();

      const { workerError, cancelled } = await workerAround(
        jobId,
        () => lens.cancel(meetingId),
        async (w) => {
          // mark_lens_run_running의 FOR UPDATE OF j, r, m — job은 이미 쥐었다
          await w.query(`SELECT 1 FROM lens_extraction_run WHERE id=$1 FOR UPDATE`, [runId]);
          await w.query(`SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE`, [meetingId]);
          await w.query(`UPDATE lens_extraction_run SET status='running' WHERE id=$1`, [runId]);
        },
      );

      expect(workerError).toBeNull();
      expect(cancelled).toEqual({ ok: true, v: { job_id: jobId, status: 'failed' } });
      const job = (await db.pool.query(`SELECT status FROM job WHERE id=$1`, [jobId])).rows[0];
      expect(job.status).toBe('failed');
      const run = (await db.pool.query(
        `SELECT status, error FROM lens_extraction_run WHERE id=$1`, [runId])).rows[0];
      expect(run.status).toBe('failed');
      expect(run.error).toMatchObject({ code: 'cancelled' });
    });

    it('취소가 기다리는 사이 워커가 run을 끝내면 취소는 409, run은 done이다', async () => {
      const { meetingId, jobId, runId } = await seedLens();

      const { workerError, cancelled } = await workerAround(
        jobId,
        () => lens.cancel(meetingId),
        async (w) => {
          await w.query(`SELECT 1 FROM lens_extraction_run WHERE id=$1 FOR UPDATE`, [runId]);
          await w.query(`SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE`, [meetingId]);
          await w.query(
            `UPDATE lens_extraction_run SET status='done', finished_at=now() WHERE id=$1`, [runId]);
          await w.query(`UPDATE job SET status='done', updated_at=now() WHERE id=$1`, [jobId]);
        },
      );

      expect(workerError).toBeNull();
      expect(cancelled.ok).toBe(false);
      expect((cancelled as { e: unknown }).e).toBeInstanceOf(ConflictException);
      const run = (await db.pool.query(
        `SELECT status FROM lens_extraction_run WHERE id=$1`, [runId])).rows[0];
      expect(run.status).toBe('done');
    });
  });
});
