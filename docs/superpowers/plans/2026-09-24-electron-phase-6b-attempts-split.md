# Electron Phase 6b-3 — `attempts` 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 강제 종료·크래시로 회수된 실행이 TRANSIENT 재시도 예산을 먹지 않게 `job.interruptions`를 따로 세고, 그 김에 회수 전파·재시도 배너의 기존 결함 셋을 고친다.

**Architecture:** 마이그레이션 `026`이 `interruptions`·`max_interruptions`를 더한다. 회수 CTE 세 벌(TS `reclaimOrphaned`·`reapStale`, Python `_REAP_SQL`)만 `interruptions`를 올리고 그것으로 상한을 판정한다. worker의 재시도 판정·백오프는 `failures = attempts − interruptions`를 쓴다. 두 언어 회수가 같은 규칙인지는 `be/test/fixtures/job-reap/grid.json` 한 벌을 양쪽이 읽어 고정한다. API는 `retry.failures`·`retry.interruptions`를 내고 화면은 재시도 대기를 stage보다 앞세운다.

**Tech Stack:** NestJS 10 + raw SQL(`pg`), jest + testcontainers(`damwha/postgres-bigm:pg16`); Python 3.12 worker + psycopg 3, pytest + testcontainers; React 19 + vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-electron-phase-6b-attempts-split-design.md` — 계획은 스펙을 근거로 한다. 실행자는 둘 다 읽는다.

## Global Constraints

- 새 컬럼: `interruptions int NOT NULL DEFAULT 0 CHECK (interruptions >= 0)`, `max_interruptions int NOT NULL DEFAULT 3 CHECK (max_interruptions >= 1)`. 파일 이름 `be/src/database/migrations/026_job_interruptions.sql`.
- 회수 판정(비-live): `interruptions + 1 < max_interruptions` → `queued`, 아니면 `failed`. **두 분기 모두 `interruptions = interruptions + 1`.** live는 언제나 `failed`이고 `interruptions + 1`. 회수는 **`attempts`를 읽지도 바꾸지도 않는다.**
- `failures = attempts − interruptions`. 재시도: `TRANSIENT and failures < max_attempts`. 백오프: `least(30 * power(2, attempts − interruptions − 1), 900)`초.
- claim 두 벌(`queue.py` `claim`, `jobs.repository.ts` `claim`)과 `requeue_for_shutdown`은 **바꾸지 않는다.**
- 오류 코드 불변: 기동 회수 `app_restarted`, reaper `stale_worker`. 기동 회수의 비-live 소진 메시지만 `the app was interrupted N times while running this job`(N = 새 `interruptions`).
- 세 벌의 `fail_meetings`는 `m.current_job_id = f.id`를 함께 본다(스펙 §6.1).
- `findStatus`의 `retry` 키: `failures`, `max_attempts`, `interruptions`, `next_attempt_at`, `error`. `attempts` 키는 없앤다.
- 배너 우선순위: 다운로드 문구 > 재시도 대기 > stage 라벨 > "대기 중". 문구 `재시도 대기 · {failures}/{max_attempts}회차 · 약 N분 뒤[ · 마지막 오류: X][ · 중단 N회]`, `· 중단 N회`는 `interruptions > 0`일 때만.
- `db.requeue(conn, job_id, worker_id, error)` — 소유권 가드 그대로, `error`를 함께 쓴다.
- DB 제약으로 `interruptions <= attempts`를 걸지 않는다(스펙 §4.1).
- 명령은 저장소 루트에서. be 단일 파일: `pnpm --filter damwha-be exec jest <path>`. worker: `pnpm worker:test` (단일 파일은 `uv run --directory be/worker pytest tests/<file> -q`). fe 단일 파일: `pnpm --filter damwha-fe exec vitest run <path>`. **`pnpm be exec …`·`pnpm fe exec …`·`pnpm desktop exec …`를 쓰지 않는다** — `run`으로 펼쳐져 아무 테스트도 돌리지 않고 exit 0으로 끝난다.
- `git add -A` 금지. 추적되지 않은 `docs/images/2026-09-20/`은 무관하다. 파일을 이름으로 add한다.
- 커밋 메시지는 기존 관례: `feat(be): …`, `feat(worker): …`, `feat(fe): …`, `fix(…): …`, `test(…): …`, `docs(phase6b): …`, 한국어 본문. 코드를 바꾼 커밋 뒤에는 `graphify update .`.

---

## File Structure

| 파일 | 책임 |
| --- | --- |
| `be/src/database/migrations/026_job_interruptions.sql` (신규) | 두 컬럼 |
| `be/src/jobs/jobs.types.ts` (수정) | `JobRow.interruptions`·`max_interruptions` |
| `be/src/jobs/jobs.repository.ts` (수정) | `reclaimOrphaned`·`reapStale`의 새 판정, 회의 가드, 반환값 이름 |
| `be/src/jobs/reaper.service.ts` (수정) | 로그의 `failedInterrupted` |
| `be/src/meetings/meetings.repository.ts` (수정) | `findStatus`의 `retry` 모양 |
| `be/test/fixtures/job-reap/grid.json` (신규) | 두 언어 공유 격자 — 회수 `reap`, 재시도·백오프 `retry` |
| `be/test/reap-grid.spec.ts` (신규) | TS 회수 둘이 `reap` 격자를 통과 |
| `be/test/migration.spec.ts`, `reclaim.spec.ts`, `reaper.spec.ts`, `jobs.repository.spec.ts`, `reclaim-bootstrap.spec.ts`, `reclaim-races.spec.ts`, `status-retry.spec.ts` (수정) | 새 규칙 |
| `be/worker/damwha_worker/db/queue.py` (수정) | `_REAP_SQL`의 새 판정·회의 가드, `requeue`의 백오프·오류 |
| `be/worker/damwha_worker/dispatch.py` (수정) | `failures()`와 재시도 판정·로그 |
| `be/worker/damwha_worker/jobs.py` (수정) | `requeue`에 `error` 전달, `_requeue_or` 시그니처 |
| `be/worker/tests/conftest.py` (수정) | `seed_job`의 `interruptions`·`max_interruptions` |
| `be/worker/tests/test_reap_grid.py` (신규) | Python 회수 둘이 `reap` 격자, dispatch·백오프가 `retry` 격자를 통과 |
| `be/worker/tests/test_db_lifecycle.py`, `test_summarize_meeting.py`, `test_worker_loop.py` (수정) | 새 규칙·전이 시퀀스·오류 저장 |
| `fe/src/features/meeting/api/types.ts`, `fe/src/pages/meeting.tsx`, `fe/src/pages/meeting.test.tsx` (수정) | `failures`·`interruptions`, 우선순위 |
| `desktop/CLAUDE.md`, `be/docs/backlog.md` (수정) | 문서 |
| `docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md` (신규) | 변이·실측 결과 |
| `docs/electron-migration-roadmap.md` (수정) | 상태 문단 |

---

### Task 1: 마이그레이션 `026`과 `JobRow`

**Files:**
- Create: `be/src/database/migrations/026_job_interruptions.sql`
- Modify: `be/src/jobs/jobs.types.ts:21-22` (다음 줄에 두 필드)
- Test: `be/test/migration.spec.ts` (끝에 케이스 둘)

**Interfaces:**
- Produces: 컬럼 `job.interruptions`(기본 0)·`job.max_interruptions`(기본 3). `JobRow.interruptions: number`, `JobRow.max_interruptions: number`. 이후 모든 Task가 이 컬럼을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `be/test/migration.spec.ts`의 `describe('migration', …)` 안 끝에 더한다. 파일 머리의 `fs`·`path`·`Pool`·`PostgreSqlContainer` import는 이미 있다.

```ts
  it('026 adds interruptions (default 0) and max_interruptions (default 3) with CHECKs', async () => {
    const cols = await db.pool.query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_name='job' AND column_name IN ('interruptions','max_interruptions')
        ORDER BY column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: 'interruptions', column_default: '0', is_nullable: 'NO' },
      { column_name: 'max_interruptions', column_default: '3', is_nullable: 'NO' },
    ]);
    const m = (await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
    await expect(db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, interruptions) VALUES('process_meeting',$1,'{}',-1)`, [m],
    )).rejects.toThrow(/check constraint/i);
    await expect(db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, max_interruptions) VALUES('process_meeting',$1,'{}',0)`, [m],
    )).rejects.toThrow(/check constraint/i);
  });

  it('026 keeps rows that pre-date it: attempts and max_attempts untouched, counters defaulted', async () => {
    // 0.3.1 → 새 판 업그레이드의 모양 — 025까지 적용된 DB에 행이 있고 그 위에 026이 온다.
    const legacy = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
    const pool = new Pool({ connectionString: legacy.getConnectionUri() });
    try {
      const dir = path.join(__dirname, '..', 'src', 'database', 'migrations');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files.filter((f) => f < '026')) {
        await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
      const m = (await pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
      const j = (await pool.query(
        `INSERT INTO job(type, meeting_id, payload, status, attempts, max_attempts, next_attempt_at)
         VALUES('process_meeting',$1,'{}','queued',2,3, now() + interval '1 minute') RETURNING id`, [m],
      )).rows[0].id;

      await pool.query(fs.readFileSync(path.join(dir, '026_job_interruptions.sql'), 'utf8'));

      const row = (await pool.query(
        `SELECT status, attempts, max_attempts, interruptions, max_interruptions FROM job WHERE id=$1`, [j],
      )).rows[0];
      expect(row).toEqual({
        status: 'queued', attempts: 2, max_attempts: 3, interruptions: 0, max_interruptions: 3,
      });
    } finally {
      await pool.end();
      await legacy.stop();
    }
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/migration.spec.ts -t 026`
Expected: FAIL — 첫 케이스는 `cols.rows`가 `[]`, 둘째는 `ENOENT … 026_job_interruptions.sql`.

- [ ] **Step 3: 마이그레이션을 쓴다** — `be/src/database/migrations/026_job_interruptions.sql`

```sql
-- Phase 6b-3 (스펙 2026-09-24-electron-phase-6b-attempts-split-design.md §4).
--
-- attempts 한 컬럼이 크래시 회수와 일시 실패 재시도를 함께 셌다 — 강제 종료 N번이
-- 재시도 5회 중 N회를 먹었다. 회수(기동 회수·30분 reaper·worker 자기 고아 회수)만
-- interruptions를 올리고, 회수의 상한은 max_interruptions로 판정한다. attempts의 뜻은
-- 그대로다(claim +1, 정상 반납 −1). 재시도 예산 소비량은 attempts − interruptions.
--
-- **기존 행은 고치지 않는다.** 이 마이그레이션 전에 크래시로 먹은 시도는 구분할 정보가
-- 없어 예산 소비로 남는다 — 재시도를 더 얹지 않는 보수적 해석이다(025와 같은 규칙).
--
-- 불변식 0 ≤ interruptions ≤ attempts, running이면 interruptions < attempts 는 제약으로
-- 걸지 않는다. 회수 CTE 한가운데서 위반이 나면 기동 회수 전체가 실패하고 그 실패는 로그만
-- 남기고 삼켜진다(Phase 5 스펙 §4.5). 테스트가 고정한다.
ALTER TABLE job
  ADD COLUMN interruptions     int NOT NULL DEFAULT 0 CHECK (interruptions >= 0),
  ADD COLUMN max_interruptions int NOT NULL DEFAULT 3 CHECK (max_interruptions >= 1);
```

- [ ] **Step 4: `JobRow`에 필드를 더한다** — `be/src/jobs/jobs.types.ts`의 `max_attempts: number;` 다음 줄:

```ts
  /** 회수(기동 회수·reaper·worker 자기 고아 회수)가 센 중단 횟수 (마이그레이션 026). */
  interruptions: number;
  /** 중단 한도. 기본 3 — 이 횟수째 중단에서 failed (마이그레이션 026). */
  max_interruptions: number;
```

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/migration.spec.ts test/migrate-status.spec.ts`
Expected: PASS (전체).

- [ ] **Step 6: 커밋**

```bash
git add be/src/database/migrations/026_job_interruptions.sql be/src/jobs/jobs.types.ts be/test/migration.spec.ts
git commit -m "feat(be): 마이그레이션 026 — job.interruptions·max_interruptions"
graphify update .
```

---

### Task 2: 공유 격자와 TS 회수 둘

**Files:**
- Create: `be/test/fixtures/job-reap/grid.json`
- Create: `be/test/reap-grid.spec.ts`
- Modify: `be/src/jobs/jobs.repository.ts:98-212` (`reclaimOrphaned` 주석·SQL·반환), `:214-292` (`reapStale` SQL)
- Modify: `be/src/jobs/reaper.service.ts:26-29`
- Modify: `be/test/reclaim.spec.ts`, `be/test/reaper.spec.ts`, `be/test/jobs.repository.spec.ts:97-117`, `be/test/reclaim-bootstrap.spec.ts:15`, `be/test/reclaim-races.spec.ts`

**Interfaces:**
- Consumes: Task 1의 컬럼.
- Produces:
  - `JobsRepository.reclaimOrphaned(exec, workerId): Promise<{ requeued: number; failedLive: number; failedInterrupted: number }>`
  - `JobsRepository.reapStale(exec, staleMinutes): Promise<{ requeued: number; failed: number }>` (모양 불변)
  - `be/test/fixtures/job-reap/grid.json` — Task 3·4가 읽는다. 모양은 아래 Step 1.

- [ ] **Step 1: 격자 fixture를 쓴다** — `be/test/fixtures/job-reap/grid.json`

규칙: `reap`의 모든 케이스는 `status='running'`이고 `interruptions < attempts`(스펙 §4.1). `max_interruptions`가 없으면 DEFAULT를 탄다. `expect.dependent`는 딸린 행의 최종 상태 — `process_meeting`은 회의(`processing` 유지 또는 `failed`), `summarize_meeting`은 `meeting_summary`, `extract_lenses`는 `lens_extraction_run`, `enroll_speaker`는 `speaker.enrollment_status`, `live_session`은 회의(`recording` 유지).

```json
{
  "reap": [
    { "name": "first interruption requeues", "type": "process_meeting", "attempts": 1, "max_attempts": 5, "interruptions": 0,
      "expect": { "status": "queued", "interruptions": 1, "dependent": "processing" } },
    { "name": "spent attempts no longer decide a reclaim", "type": "process_meeting", "attempts": 5, "max_attempts": 5, "interruptions": 0,
      "expect": { "status": "queued", "interruptions": 1, "dependent": "processing" } },
    { "name": "second interruption requeues", "type": "process_meeting", "attempts": 2, "max_attempts": 5, "interruptions": 1,
      "expect": { "status": "queued", "interruptions": 2, "dependent": "processing" } },
    { "name": "third interruption fails under the default limit", "type": "process_meeting", "attempts": 3, "max_attempts": 5, "interruptions": 2,
      "expect": { "status": "failed", "interruptions": 3, "dependent": "failed" } },
    { "name": "an explicit higher limit keeps requeueing", "type": "process_meeting", "attempts": 3, "max_attempts": 5, "interruptions": 2, "max_interruptions": 5,
      "expect": { "status": "queued", "interruptions": 3, "dependent": "processing" } },
    { "name": "limit 1 fails on the first interruption", "type": "process_meeting", "attempts": 1, "max_attempts": 5, "interruptions": 0, "max_interruptions": 1,
      "expect": { "status": "failed", "interruptions": 1, "dependent": "failed" } },
    { "name": "summary requeues with its row untouched", "type": "summarize_meeting", "attempts": 1, "max_attempts": 3, "interruptions": 0,
      "expect": { "status": "queued", "interruptions": 1, "dependent": "running" } },
    { "name": "summary exhausted fails its row", "type": "summarize_meeting", "attempts": 3, "max_attempts": 3, "interruptions": 2,
      "expect": { "status": "failed", "interruptions": 3, "dependent": "failed" } },
    { "name": "lens exhausted fails its run", "type": "extract_lenses", "attempts": 3, "max_attempts": 5, "interruptions": 2,
      "expect": { "status": "failed", "interruptions": 3, "dependent": "failed" } },
    { "name": "enroll exhausted fails the speaker", "type": "enroll_speaker", "attempts": 3, "max_attempts": 5, "interruptions": 2,
      "expect": { "status": "failed", "interruptions": 3, "dependent": "failed" } },
    { "name": "live always fails and leaves the meeting recording", "type": "live_session", "attempts": 1, "max_attempts": 1, "interruptions": 0,
      "expect": { "status": "failed", "interruptions": 1, "dependent": "recording" } }
  ],
  "retry": [
    { "attempts": 1, "interruptions": 0, "max_attempts": 5, "failures": 1, "retry": true,  "backoff_seconds": 30 },
    { "attempts": 2, "interruptions": 0, "max_attempts": 5, "failures": 2, "retry": true,  "backoff_seconds": 60 },
    { "attempts": 3, "interruptions": 1, "max_attempts": 5, "failures": 2, "retry": true,  "backoff_seconds": 60 },
    { "attempts": 4, "interruptions": 1, "max_attempts": 5, "failures": 3, "retry": true,  "backoff_seconds": 120 },
    { "attempts": 5, "interruptions": 0, "max_attempts": 5, "failures": 5, "retry": false, "backoff_seconds": 480 },
    { "attempts": 5, "interruptions": 1, "max_attempts": 5, "failures": 4, "retry": true,  "backoff_seconds": 240 },
    { "attempts": 7, "interruptions": 1, "max_attempts": 9, "failures": 6, "retry": true,  "backoff_seconds": 900 }
  ]
}
```

(`retry`의 `backoff_seconds`는 `retry=false`여도 `requeue`를 직접 부르면 나올 값이다 — SQL 식만 고정한다.)

- [ ] **Step 2: TS 격자 테스트를 쓴다** — `be/test/reap-grid.spec.ts`

```ts
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
```

`enroll_speaker`의 미실패 상태를 `running`으로 정규화하는 이유: 화자 행은 `provisional`로 시드하고, 격자는 "건드리지 않았다"만 본다. 격자에는 `enroll_speaker`의 requeue 케이스가 없으니 이 분기는 `failed`만 나온다 — 정규화는 방어적이다.

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/reap-grid.spec.ts`
Expected: FAIL — `interruptions`가 기대값에 못 미친다(현재 SQL은 올리지 않는다). "spent attempts no longer decide a reclaim"은 `status: 'failed'`로 실패한다.

- [ ] **Step 4: `reclaimOrphaned`를 고친다** — `be/src/jobs/jobs.repository.ts`. 주석(`/** 앞 실행이 남긴 …` 블록)의 둘째·셋째 문단을 아래로 바꾼다.

```ts
  /**
   * 앞 실행이 남긴 `running` job을 되돌린다. 기동 시 1회만 부른다 (ReaperService).
   *
   * **중단을 센다 — `interruptions`를 +1 하고 그것으로 상한을 판정한다** (Phase 6b-3 스펙 §4.2).
   * `attempts`는 읽지도 바꾸지도 않는다. 실행 중이던 job은 재시도 예산이 남아 있다 — 다 썼다면
   * dispatch가 이미 failed로 닫았다. 그래서 `attempts = max_attempts`로 실행 중이던 행도 중단
   * 예산이 남으면 queued로 간다. 앱을 세 번(기본 `max_interruptions`) 죽이는 job은 failed다 —
   * 그 job이 앱을 죽이고 있을 수 있다(Phase 5 스펙 §4.1의 정직성은 그대로, 셈만 따로).
   *
   * 분기가 셋이다. 회수가 `locked_at=NULL`로 지우므로 30분 reaper는 이 행을 다시 보지 못한다 —
   * 상한 분기가 여기 없으면 앱을 죽이는 job은 기동마다 되살아나 영원히 돈다.
   *
   * 상한을 태운 행은 `reapStale`과 **같은 방식으로** 딸린 행까지 닫는다
   * (`lens_extraction_run`·`meeting_summary`·`meeting`·`speaker`). 회의는 그 job이 **아직 회의의
   * 현재 job일 때만** 닫는다(스펙 §6.1) — 동시 재처리로 밀려난 옛 job이 새 실행의 회의를 덮지 않게.
   *
   * 잠금은 `reapStale`과 같은 `FOR UPDATE SKIP LOCKED`다. 이 메서드는 Nest가 HTTP 리슨
   * **전에** 기다리는 `onApplicationBootstrap`에서 돌고, 잠금 대기는 예외가 아니라서
   * 호출부의 try/catch가 잡지 못한다 — 맨 행 잠금이면 기동이 통째로 멈춘다
   * (Phase 5 스펙 §4.5: "회수 SQL이 실패하면 기동을 막지 않는다"). 지금 잠긴 행은 살아 있는
   * 누군가의 것이니 건너뛰는 것이 맞고, 놓친 행은 30분 reaper가 같은 규칙으로 본다.
   */
  async reclaimOrphaned(
    exec: Queryable,
    workerId: string,
  ): Promise<{ requeued: number; failedLive: number; failedInterrupted: number }> {
    const { rows } = await exec.query<{ requeued: string; failed_live: string; failed_interrupted: string }>(
      `WITH orphaned AS (
         SELECT id, type, meeting_id, interruptions, max_interruptions, stage
         FROM job
         WHERE status='running'
           AND locked_by LIKE $1 || '%'
           AND locked_by <> $2
         FOR UPDATE SKIP LOCKED
       ),
       requeued AS (
         UPDATE job
            SET status='queued', interruptions = interruptions + 1,
                locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE id IN (
            SELECT id FROM orphaned
             WHERE interruptions + 1 < max_interruptions AND type <> 'live_session'
          )
          RETURNING id
       ),
       -- 끊긴 라이브는 재queue하지 않는다 (기존 reaper와 같은 규칙). job만 닫는다 —
       -- 회의·확정·봉인 경계·파일은 건드리지 않고, 봉인과 마무리는 LiveOrphanService가
       -- 한다(live-orphan.service.ts). 이 회수가 하는 일은 그 경로를 30분 reaper 대신
       -- 즉시 여는 것뿐이다. 중단은 세되 판정에는 쓰지 않는다.
       failed_live AS (
         UPDATE job j
            SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
                error = jsonb_build_object(
                  'code','app_restarted',
                  'message','the app restarted while this live session was running',
                  'stage', j.stage)
          WHERE id IN (SELECT id FROM orphaned WHERE type='live_session')
          RETURNING id
       ),
       -- 중단 한도를 태운 비-live 행. 아래 네 CTE가 reapStale의 failed 분기와 같은 짝을 닫는다.
       failed_interrupted AS (
         UPDATE job j
            SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
                error = jsonb_build_object(
                  'code','app_restarted',
                  'message', format('the app was interrupted %s times while running this job',
                                    j.interruptions + 1),
                  'stage', j.stage)
          WHERE id IN (
            SELECT id FROM orphaned
             WHERE interruptions + 1 >= max_interruptions AND type <> 'live_session'
          )
          RETURNING id, type, meeting_id, error
       ),
       fail_lens_extraction_runs AS (
         UPDATE lens_extraction_run r SET status='failed', error=f.error, finished_at=now()
         FROM failed_interrupted f
         WHERE r.job_id=f.id AND f.type='extract_lenses'
         RETURNING r.id
       ),
       fail_summaries AS (
         UPDATE meeting_summary s SET status='failed', error=f.error, updated_at=now()
         FROM failed_interrupted f
         WHERE s.job_id=f.id AND f.type='summarize_meeting'
         RETURNING s.meeting_id
       ),
       -- live_session은 여기 없다 — failed_interrupted가 비-live만 담으므로 구조적으로 빠진다.
       -- 브라우저가 오디오를 보내는 한 녹음은 계속되고, 마무리는 LiveOrphanService가 한다.
       -- current_job_id 가드: 밀려난 옛 job이 새 실행의 회의를 덮지 않는다 (스펙 §6.1).
       fail_meetings AS (
         UPDATE meeting m SET status='failed',
           error = jsonb_build_object('code','app_restarted',
                                      'message','the app restarted repeatedly while processing this meeting')
         FROM failed_interrupted f
         WHERE m.id = f.meeting_id AND m.current_job_id = f.id AND f.type = 'process_meeting'
         RETURNING m.id
       ),
       fail_speakers AS (
         UPDATE speaker s SET enrollment_status='failed',
           enrollment_error = jsonb_build_object('code','app_restarted',
                                                 'message','the app restarted repeatedly while enrolling')
         WHERE s.current_job_id IN (SELECT id FROM failed_interrupted WHERE type='enroll_speaker')
         RETURNING s.id
       )
       SELECT (SELECT count(*) FROM requeued)           AS requeued,
              (SELECT count(*) FROM failed_live)        AS failed_live,
              (SELECT count(*) FROM failed_interrupted) AS failed_interrupted`,
      [APP_WORKER_PREFIX, workerId],
    );
    return {
      requeued: Number(rows[0].requeued),
      failedLive: Number(rows[0].failed_live),
      failedInterrupted: Number(rows[0].failed_interrupted),
    };
  }
```

- [ ] **Step 5: `reapStale`을 고친다** — 같은 파일. 바뀌는 CTE만 보인다. `stale`의 SELECT 목록, `requeued`·`failed`의 SET·WHERE, `fail_meetings`의 WHERE. 나머지(`fail_lens_extraction_runs`·`fail_summaries`·`fail_speakers`·주석·최종 SELECT)는 그대로 둔다.

```sql
      `WITH stale AS (
         SELECT id, type, meeting_id, interruptions, max_interruptions, stage
         FROM job
         WHERE status='running'
           AND locked_at < now() - ($1 || ' minutes')::interval
         FOR UPDATE SKIP LOCKED
       ),
       -- (기존 live_session 주석 유지)
       -- 30분간 heartbeat 성공이 없었다 = 중단 한 번 (Phase 6b-3 스펙 §4.2). attempts는 보지 않는다.
       requeued AS (
         UPDATE job SET status='queued', interruptions = interruptions + 1,
           locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
         WHERE id IN (
           SELECT id FROM stale
            WHERE interruptions + 1 < max_interruptions AND type <> 'live_session'
         )
         RETURNING id
       ),
       failed AS (
         UPDATE job j SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
           error = jsonb_build_object('code','stale_worker',
                                       'message','worker lock expired',
                                       'stage', j.stage)
         WHERE id IN (
           SELECT id FROM stale
            WHERE interruptions + 1 >= max_interruptions OR type = 'live_session'
         )
         RETURNING id, type, meeting_id, error
       ),
```

그리고 `fail_meetings`:

```sql
       fail_meetings AS (
         UPDATE meeting m SET status='failed',
           error = jsonb_build_object('code','stale_worker','message','processing worker lost')
         FROM failed f
         WHERE m.id = f.meeting_id AND m.current_job_id = f.id AND f.type = 'process_meeting'
         RETURNING m.id
       ),
```

- [ ] **Step 6: `ReaperService` 로그** — `be/src/jobs/reaper.service.ts`의 `onApplicationBootstrap`:

```ts
      const res = await this.jobs.reclaimOrphaned(this.db.pool, workerId);
      if (res.requeued || res.failedLive || res.failedInterrupted) {
        this.logger.warn(
          `reclaim: requeued=${res.requeued} failedLive=${res.failedLive} failedInterrupted=${res.failedInterrupted}`,
        );
      }
```

- [ ] **Step 7: 격자 통과를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/reap-grid.spec.ts`
Expected: PASS (22 케이스).

- [ ] **Step 8: 기존 스펙을 새 규칙으로 고친다.**

`be/test/reclaim.spec.ts`:
- `runningJob` 헬퍼에 `interruptions?: number` 옵션을 더하고 INSERT에 `interruptions` 컬럼(`opts.interruptions ?? 0`)을 넣는다.
- `'does not roll attempts back — …'`는 그대로 두고 단언을 `expect(rows[0]).toMatchObject({ attempts: 2, interruptions: 1 })`로(SELECT에 `interruptions` 추가). 이름을 `'counts the interruption and leaves attempts where claim put them'`으로.
- `'fails a job whose attempts are spent instead of requeueing it forever'` → 이름 `'fails a job on its third interruption instead of requeueing it forever'`, 시드 `{ lockedBy: 'desktop-old', attempts: 3, interruptions: 2 }`, 기대 `{ requeued: 0, failedLive: 0, failedInterrupted: 1 }`, 추가 단언 `expect(rows[0].error.message).toBe('the app was interrupted 3 times while running this job')`(SELECT에 `error` 이미 있음).
- `'closes the meeting of an exhausted job, …'` 시드를 `{ lockedBy: 'desktop-old', attempts: 3, interruptions: 2 }`로.
- `'requeues the job that has attempts left and fails only the spent one'` → 이름 `'requeues the job with interruptions left and fails only the exhausted one'`, `left = { attempts: 5, maxAttempts: 5, interruptions: 0 }`(재시도 예산을 다 써도 중단 예산이 남으면 queued — 이 Phase가 바꾼 동작), `spent = { attempts: 3, interruptions: 2 }`, 기대 `{ requeued: 1, failedLive: 0, failedInterrupted: 1 }`.
- `'fails the linked lens extraction run when an exhausted extract job is reclaimed'`: INSERT의 `attempts, max_attempts`를 `attempts, max_attempts, interruptions` / `3, 5, 2`로, `res.failedSpent` → `res.failedInterrupted`.
- 새 케이스 둘을 `describe` 끝에 더한다:

```ts
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
```

- 라이브 케이스(`'closes a previous run’s live session as failed with app_restarted'`)에 `interruptions` 단언을 더한다: SELECT에 `interruptions`를 넣고 `expect(rows[0].interruptions).toBe(1)`.

`be/test/reaper.spec.ts`:
- `runningJob` 헬퍼에 `interruptions?: number`(기본 0)를 INSERT에 더한다.
- `'fails a stale job out of attempts and marks the meeting failed'` → 이름 `'fails a stale job on its third interruption and marks the meeting failed'`, 시드 `{ minutesAgo: 45, attempts: 3, maxAttempts: 3, interruptions: 2 }`.
- 새 케이스:

```ts
  it('requeues a stale job whose retry budget is spent but whose interruptions are not', async () => {
    const { jobId } = await runningJob({ minutesAgo: 45, attempts: 3, maxAttempts: 3 });
    expect(await repo.reapStale(db.pool, 30)).toEqual({ requeued: 1, failed: 0 });
    const { rows } = await db.pool.query('SELECT status, attempts, interruptions FROM job WHERE id=$1', [jobId]);
    expect(rows[0]).toEqual({ status: 'queued', attempts: 3, interruptions: 1 });
  });

  it('does not fail a meeting whose current job is a newer one (spec §6.1)', async () => {
    const { jobId, meetingId } = await runningJob({ minutesAgo: 45, attempts: 3, maxAttempts: 5, interruptions: 2 });
    const newer = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status) VALUES('process_meeting',$1,'{}','queued') RETURNING id`,
      [meetingId]);
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [newer.rows[0].id, meetingId]);

    expect(await repo.reapStale(db.pool, 30)).toEqual({ requeued: 0, failed: 1 });
    const job = await db.pool.query('SELECT status FROM job WHERE id=$1', [jobId]);
    expect(job.rows[0].status).toBe('failed');
    const mt = await db.pool.query('SELECT status FROM meeting WHERE id=$1', [meetingId]);
    expect(mt.rows[0].status).toBe('processing');
  });
```

- `'fails the linked lens extraction run when an exhausted extract job is stale'`: INSERT에 `interruptions` 컬럼, 값 `3, 3, 2`(attempts, max_attempts, interruptions).
- `'never requeues a stale live_session, even with attempts left'`: 그대로 통과해야 한다(live는 판정과 무관).

`be/test/jobs.repository.spec.ts:97` `'reapStale이 요약 잡 실패 시 요약 행도 failed로 넘긴다'`: INSERT 컬럼에 `interruptions`, 값 `3, 3, 2`.

`be/test/reclaim-bootstrap.spec.ts:15`: 목을 `{ requeued: 2, failedLive: 1, failedInterrupted: 0 }`으로. 같은 파일에 `failedSpent`가 더 있으면 모두 바꾼다(`grep -n failedSpent be/test be/src`가 비어야 한다).

`be/test/reclaim-races.spec.ts`:
- `'reclaim → claim: …'`의 SELECT에 `interruptions`, 기대에 `interruptions: 1`.
- 새 케이스(겹침):

```ts
  it('reclaim and the stale reaper racing on one row count one interruption', async () => {
    const { jobId } = await orphanJob();
    await db.pool.query(`UPDATE job SET locked_at = now() - interval '45 minutes' WHERE id=$1`, [jobId]);
    const a = new Client({ connectionString: db.url });
    const b = new Client({ connectionString: db.url });
    await a.connect(); await b.connect();
    try {
      await a.query('BEGIN');
      await jobs.reclaimOrphaned(a, 'desktop-new');          // 행을 잠근 채 열어 둔다
      const reaping = jobs.reapStale(b, 30);                 // SKIP LOCKED — 기다리지 않는다
      const reaped = await reaping;
      await a.query('COMMIT');
      expect(reaped).toEqual({ requeued: 0, failed: 0 });
      const again = await jobs.reapStale(db.pool, 30);       // 커밋 뒤: running이 아니다
      expect(again).toEqual({ requeued: 0, failed: 0 });
      const { rows } = await db.pool.query('SELECT status, interruptions FROM job WHERE id=$1', [jobId]);
      expect(rows[0]).toEqual({ status: 'queued', interruptions: 1 });
    } finally { await a.end(); await b.end(); }
  });
```

- [ ] **Step 9: be 전체를 돌린다**

Run: `pnpm --filter damwha-be exec jest test/reclaim.spec.ts test/reaper.spec.ts test/jobs.repository.spec.ts test/reclaim-bootstrap.spec.ts test/reclaim-races.spec.ts test/reap-grid.spec.ts`
Expected: PASS. 그다음 `pnpm be test` 전체 PASS. `grep -rn "failedSpent" be/src be/test`가 아무것도 내지 않는다.

- [ ] **Step 10: 커밋**

```bash
git add be/test/fixtures/job-reap/grid.json be/test/reap-grid.spec.ts be/src/jobs/jobs.repository.ts be/src/jobs/reaper.service.ts \
  be/test/reclaim.spec.ts be/test/reaper.spec.ts be/test/jobs.repository.spec.ts be/test/reclaim-bootstrap.spec.ts be/test/reclaim-races.spec.ts
git commit -m "feat(be): 회수가 attempts 대신 interruptions로 세고 판정한다 — 회의 전파에 current_job_id 가드"
graphify update .
```

---

### Task 3: Python 회수 (`_REAP_SQL`)와 전이 불변식

**Files:**
- Modify: `be/worker/damwha_worker/db/queue.py:108-176` (`_REAP_SQL`)
- Modify: `be/worker/tests/conftest.py:105-127` (`seed_job`)
- Create: `be/worker/tests/test_reap_grid.py`
- Modify: `be/worker/tests/test_db_lifecycle.py:110-146`, `be/worker/tests/test_summarize_meeting.py:228-252`

**Interfaces:**
- Consumes: Task 1 컬럼, Task 2의 `be/test/fixtures/job-reap/grid.json`(`reap` 배열).
- Produces: `seed_job(conn, *, …, interruptions=0, max_interruptions=None)` — `None`이면 컬럼을 넣지 않아 DEFAULT. Task 4가 쓴다. `reap_stale`·`reap_own_orphans`의 반환 모양은 `(requeued, failed)` 그대로.

- [ ] **Step 1: `seed_job`을 넓힌다** — `be/worker/tests/conftest.py`

```python
def seed_job(
    conn,
    *,
    type="process_meeting",
    meeting_id=None,
    payload=None,
    status="queued",
    locked_by=None,
    attempts=0,
    max_attempts=3,
    locked_minutes_ago=None,
    interruptions=0,
    max_interruptions=None,
):
    locked_at = (
        None if locked_minutes_ago is None else f"now() - interval '{locked_minutes_ago} minutes'"
    )
    cols = "type, meeting_id, payload, status, locked_by, attempts, max_attempts, interruptions"
    vals = "%s,%s,%s,%s,%s,%s,%s,%s"
    params = [type, meeting_id, Jsonb(payload or {}), status, locked_by, attempts, max_attempts,
              interruptions]
    # None이면 컬럼을 빼 DEFAULT(026의 3)를 탄다 — 격자의 "한도 생략" 케이스가 그 값을 고정한다.
    if max_interruptions is not None:
        cols += ", max_interruptions"
        vals += ",%s"
        params.append(max_interruptions)
    sql = (
        f"INSERT INTO job({cols}, locked_at) "
        f"VALUES ({vals},{locked_at or 'NULL'}) RETURNING id"
    )
    return conn.execute(sql, params).fetchone()["id"]
```

- [ ] **Step 2: Python 격자 테스트를 쓴다** — `be/worker/tests/test_reap_grid.py`

```python
"""회수 격자 — be/test/fixtures/job-reap/grid.json을 TS(be/test/reap-grid.spec.ts)와 함께 읽는다.

스펙 §8.1. 선택자만 다르다: reap_stale은 오래된 locked_at, reap_own_orphans는 자기 신분.
"""

import json
from pathlib import Path

import pytest

from damwha_worker import db
from tests.conftest import seed_job, seed_meeting

GRID = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-reap" / "grid.json").read_text()
)


def _seed(conn, c, *, locked_by, locked_minutes_ago):
    meeting_status = {"live_session": "recording", "process_meeting": "processing"}.get(c["type"], "done")
    mid = seed_meeting(conn, status=meeting_status)
    jid = seed_job(
        conn,
        type=c["type"],
        meeting_id=mid,
        status="running",
        locked_by=locked_by,
        attempts=c["attempts"],
        max_attempts=c["max_attempts"],
        interruptions=c["interruptions"],
        max_interruptions=c.get("max_interruptions"),
        locked_minutes_ago=locked_minutes_ago,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    if c["type"] == "summarize_meeting":
        conn.execute(
            "INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status) "
            "VALUES (%s, 0, %s, 'model', 'running')",
            (mid, jid),
        )
    elif c["type"] == "extract_lenses":
        conn.execute(
            "INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model, job_id) "
            "VALUES (%s, 0, 'running', 'model', %s)",
            (mid, jid),
        )
    elif c["type"] == "enroll_speaker":
        conn.execute(
            "INSERT INTO speaker(name, enrollment_status, current_job_id) VALUES ('s','provisional',%s)",
            (jid,),
        )
    return jid, mid


def _dependent(conn, c, jid, mid):
    if c["type"] == "summarize_meeting":
        return conn.execute("SELECT status FROM meeting_summary WHERE job_id=%s", (jid,)).fetchone()["status"]
    if c["type"] == "extract_lenses":
        return conn.execute(
            "SELECT status FROM lens_extraction_run WHERE job_id=%s", (jid,)
        ).fetchone()["status"]
    if c["type"] == "enroll_speaker":
        s = conn.execute(
            "SELECT enrollment_status FROM speaker WHERE current_job_id=%s", (jid,)
        ).fetchone()["enrollment_status"]
        return "failed" if s == "failed" else "running"
    return conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]


def _check(conn, c, jid, mid):
    row = conn.execute(
        "SELECT status, attempts, interruptions, locked_by, locked_at FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == c["expect"]["status"]
    assert row["attempts"] == c["attempts"]
    assert row["interruptions"] == c["expect"]["interruptions"]
    if c["expect"]["status"] == "queued":
        assert row["locked_by"] is None and row["locked_at"] is None
    assert _dependent(conn, c, jid, mid) == c["expect"]["dependent"]


@pytest.mark.parametrize("c", GRID["reap"], ids=[c["name"] for c in GRID["reap"]])
def test_reap_stale_grid(conn, c):
    jid, mid = _seed(conn, c, locked_by="dead-worker", locked_minutes_ago=31)
    db.reap_stale(conn, 30)
    _check(conn, c, jid, mid)


@pytest.mark.parametrize("c", GRID["reap"], ids=[c["name"] for c in GRID["reap"]])
def test_reap_own_orphans_grid(conn, c):
    jid, mid = _seed(conn, c, locked_by="w1", locked_minutes_ago=0)
    db.reap_own_orphans(conn, "w1")
    _check(conn, c, jid, mid)
```

`meeting_summary`·`lens_extraction_run`이 `conn` fixture의 TRUNCATE 목록(`job, utterance, meeting_cluster, voiceprint, meeting, speaker … CASCADE`)으로 비워지는지 먼저 확인한다 — 둘 다 `meeting`을 FK로 참조하므로 CASCADE로 비워진다. 안 비워지면 TRUNCATE 목록에 더한다.

- [ ] **Step 3: 실패를 확인한다**

Run: `uv run --directory be/worker pytest tests/test_reap_grid.py -q`
Expected: FAIL — `interruptions` 불일치, "spent attempts no longer decide a reclaim"은 status `failed`.

- [ ] **Step 4: `_REAP_SQL`을 고친다** — `be/worker/damwha_worker/db/queue.py`. 바뀌는 부분:

```python
_REAP_SQL = """
        WITH stale AS (
          SELECT id, type, meeting_id, interruptions, max_interruptions, stage
          FROM job
          WHERE {selector}
          FOR UPDATE SKIP LOCKED
        ),
        -- (기존 live_session 주석 유지)
        -- 회수는 중단 한 번이다 (Phase 6b-3 스펙 §4.2). interruptions를 +1 하고 그것으로
        -- 상한을 판정한다. attempts는 읽지도 바꾸지도 않는다 — 실행 중이던 job은 재시도
        -- 예산이 남아 있다(다 썼다면 dispatch가 이미 failed로 닫았다).
        requeued AS (
          UPDATE job SET status='queued', interruptions = interruptions + 1,
                 locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE id IN (
            SELECT id FROM stale
             WHERE interruptions + 1 < max_interruptions AND type <> 'live_session'
          )
          RETURNING id
        ),
        failed AS (
          UPDATE job j SET status='failed', interruptions = j.interruptions + 1, updated_at=now(),
            error = jsonb_build_object('code','stale_worker',
                                       'message','worker lock expired',
                                       'stage', j.stage)
          WHERE id IN (
            SELECT id FROM stale
             WHERE interruptions + 1 >= max_interruptions OR type = 'live_session'
          )
          RETURNING id, type, meeting_id, error
        ),
```

`fail_meetings`:

```python
        -- current_job_id 가드: 밀려난 옛 job이 새 실행의 회의를 덮지 않는다 (스펙 §6.1).
        fail_meetings AS (
          UPDATE meeting m SET status='failed',
            error = jsonb_build_object('code','stale_worker','message','processing worker lost')
          FROM failed f
          WHERE m.id = f.meeting_id AND m.current_job_id = f.id AND f.type = 'process_meeting'
          RETURNING m.id
        ),
```

나머지 CTE와 최종 SELECT는 그대로.

- [ ] **Step 5: 격자 통과를 확인한다**

Run: `uv run --directory be/worker pytest tests/test_reap_grid.py -q`
Expected: 22 passed.

- [ ] **Step 6: 기존 테스트를 고치고 전이 시퀀스를 더한다** — `be/worker/tests/test_db_lifecycle.py`

- `test_reap_stale_fails_exhausted_process_meeting_and_entity`: `seed_job`에 `interruptions=2`를 더한다(attempts=3, max_attempts=3 그대로 — 한도는 중단 쪽).
- 새 테스트들을 파일 끝에 더한다:

```python
def test_reap_stale_requeues_a_job_whose_retry_budget_is_spent(conn):
    """재시도 예산(attempts=max_attempts)을 다 써도 중단 예산이 남으면 queued (스펙 §4.2)."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn, meeting_id=mid, status="running", locked_by="dead", attempts=3, max_attempts=3,
        locked_minutes_ago=31,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    assert db.reap_stale(conn, 30) == (1, 0)
    row = conn.execute("SELECT status, attempts, interruptions FROM job WHERE id=%s", (jid,)).fetchone()
    assert (row["status"], row["attempts"], row["interruptions"]) == ("queued", 3, 1)


def test_reap_stale_leaves_a_meeting_whose_current_job_is_newer(conn):
    """스펙 §6.1 — 밀려난 옛 job의 소진 회수가 새 실행의 회의를 덮지 않는다."""
    mid = seed_meeting(conn, status="processing")
    old = seed_job(
        conn, meeting_id=mid, status="running", locked_by="dead", attempts=3, max_attempts=5,
        interruptions=2, locked_minutes_ago=31,
    )
    newer = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (newer, mid))
    assert db.reap_stale(conn, 30) == (0, 1)
    assert conn.execute("SELECT status FROM job WHERE id=%s", (old,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "processing"


def _counters(conn, jid):
    r = conn.execute(
        "SELECT status, attempts, interruptions FROM job WHERE id=%s", (jid,)
    ).fetchone()
    # 스펙 §4.1의 두 불변식 — 매 전이 뒤에 선다.
    assert 0 <= r["interruptions"] <= r["attempts"]
    if r["status"] == "running":
        assert r["interruptions"] < r["attempts"]
    return r["status"], r["attempts"], r["interruptions"]


def test_transitions_keep_the_counter_invariants(conn):
    """도달 가능한 전이만으로: claim → 회수 → claim → 정상 반납 → claim → 회수 → claim → 회수(소진)."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(conn, meeting_id=mid, max_attempts=5)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    db.claim(conn, "w1")
    assert _counters(conn, jid) == ("running", 1, 0)
    assert db.reap_own_orphans(conn, "w1") == (1, 0)
    assert _counters(conn, jid) == ("queued", 1, 1)
    db.claim(conn, "w1")
    assert _counters(conn, jid) == ("running", 2, 1)
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert _counters(conn, jid) == ("queued", 1, 1)
    db.claim(conn, "w1")
    assert db.reap_own_orphans(conn, "w1") == (1, 0)
    assert _counters(conn, jid) == ("queued", 2, 2)
    db.claim(conn, "w1")
    assert db.reap_own_orphans(conn, "w1") == (0, 1)
    assert _counters(conn, jid) == ("failed", 3, 3)


def test_a_late_shutdown_from_the_old_owner_is_refused_after_reclaim(conn):
    """회수 뒤 옛 소유자의 늦은 반납은 소유권 가드에 막혀 0행 — attempts가 두 번 내려가지 않는다."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(conn, meeting_id=mid, max_attempts=5)
    db.claim(conn, "w-old")
    conn.execute("UPDATE job SET locked_at = now() - interval '31 minutes' WHERE id=%s", (jid,))
    assert db.reap_stale(conn, 30) == (1, 0)
    db.claim(conn, "w-new")
    assert db.requeue_for_shutdown(conn, jid, "w-old") == 0
    assert _counters(conn, jid) == ("running", 2, 1)


def test_requeue_for_shutdown_leaves_interruptions_alone(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid, attempts=1, interruptions=1)
    db.claim(conn, "w1")  # attempts 1→2
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert _counters(conn, jid) == ("queued", 1, 1)
```

`be/worker/tests/test_summarize_meeting.py`의 `test_reaper_fails_summary_row_when_worker_lock_expires`: `seed_job`에 `interruptions=2`를 더한다.

- [ ] **Step 7: worker 전체를 돌린다**

Run: `pnpm worker:test`
Expected: PASS. 실패가 있으면 그 테스트가 "attempts 소진 → 회수 failed"를 가정하는지 보고 `interruptions=max_interruptions-1`로 시드를 옮긴다(규칙을 바꾸지 말 것).

- [ ] **Step 8: 커밋**

```bash
git add be/worker/damwha_worker/db/queue.py be/worker/tests/conftest.py be/worker/tests/test_reap_grid.py \
  be/worker/tests/test_db_lifecycle.py be/worker/tests/test_summarize_meeting.py
git commit -m "feat(worker): 회수가 interruptions로 세고 판정한다 — TS와 같은 격자, 전이 불변식"
graphify update .
```

---

### Task 4: 재시도 판정·백오프·오류 저장 (worker)

**Files:**
- Modify: `be/worker/damwha_worker/dispatch.py:19-46` (`failures()` 신설, 재시도 판정·로그)
- Modify: `be/worker/damwha_worker/db/queue.py:79-93` (`requeue`)
- Modify: `be/worker/damwha_worker/jobs.py:135-155` (`on_failure`·`_requeue_or`) 및 `_requeue_or` 호출처 넷(`:192`, `:217`, `:267`, `:289`)
- Modify: `be/worker/tests/test_reap_grid.py` (끝에 `retry` 격자)
- Modify: `be/worker/tests/test_db_lifecycle.py:54-76`, `be/worker/tests/test_worker_loop.py:71-80`

**Interfaces:**
- Consumes: Task 3의 `seed_job(interruptions=…)`, grid의 `retry` 배열.
- Produces: `damwha_worker.dispatch.failures(job: dict) -> int`, `db.requeue(conn, job_id: str, worker_id: str, error: dict) -> int`, `_requeue_or(conn, job, ctx, error, *, retry, close) -> str`.

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `be/worker/tests/test_reap_grid.py` 끝에:

```python
from damwha_worker.dispatch import failures  # noqa: E402


@pytest.mark.parametrize(
    "c", GRID["retry"], ids=[f"a{c['attempts']}-i{c['interruptions']}" for c in GRID["retry"]]
)
def test_retry_grid_failures_and_backoff(conn, c):
    """failures()와 requeue의 백오프가 같은 식인지 (스펙 §4.3). requeue는 running 행에서 부른다."""
    assert failures({"attempts": c["attempts"], "interruptions": c["interruptions"]}) == c["failures"]
    assert (failures(c) < c["max_attempts"]) == c["retry"]

    mid = seed_meeting(conn)
    jid = seed_job(
        conn, meeting_id=mid, status="running", locked_by="w1", attempts=c["attempts"],
        max_attempts=c["max_attempts"], interruptions=c["interruptions"], locked_minutes_ago=0,
    )
    assert db.requeue(conn, jid, "w1", {"code": "x", "kind": "TRANSIENT", "stage": None}) == 1
    row = conn.execute(
        "SELECT extract(epoch FROM next_attempt_at - updated_at) AS s FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert round(float(row["s"])) == c["backoff_seconds"]
```

(`next_attempt_at`과 `updated_at`은 같은 문장의 `now()`라 DB 시각 기준 간격이 정확히 백오프다.)

`be/worker/tests/test_db_lifecycle.py`의 `test_requeue_clears_lock`·`test_requeue_sets_delay_from_claimed_attempt`는 `db.requeue(conn, j["id"], "w1")` → `db.requeue(conn, j["id"], "w1", {"code": "x", "kind": "TRANSIENT", "stage": None})`로. 그리고:

```python
def test_requeue_stores_the_error_it_retries_for(conn):
    """스펙 §6.3 — 재시도 대기 중 "마지막 오류"의 원천. 지금까지는 쓰지 않았다."""
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    err = {"code": "model_download_failed", "kind": "TRANSIENT", "stage": "stt", "message": "reset"}
    assert db.requeue(conn, jid, "w1", err) == 1
    assert conn.execute("SELECT error FROM job WHERE id=%s", (jid,)).fetchone()["error"] == err


def test_requeue_is_still_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.requeue(conn, jid, "w2", {"code": "x"}) == 0
    row = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "running" and row["error"] is None
```

`be/worker/tests/test_worker_loop.py`의 `test_transient_error_requeues_when_attempts_left` 끝에 오류가 실제 경로로 저장되는지 단언을 더하고, 새 테스트를 둔다:

```python
    err = conn.execute("SELECT error FROM job WHERE id=%s", (jid,)).fetchone()["error"]
    assert err["code"] == "io_error" and err["kind"] == "TRANSIENT"


def test_transient_error_requeues_when_only_interruptions_used_the_budget(conn, tmp_path, monkeypatch):
    """attempts=max여도 그중 중단이 있으면 재시도 예산이 남는다 (스펙 §4.3, 변이 M7)."""
    _stub_ffmpeg(monkeypatch)
    mid, jid = _enqueue_pm(conn)
    conn.execute("UPDATE job SET attempts=2, max_attempts=3, interruptions=1 WHERE id=%s", (jid,))
    job = db.claim(conn, "w1")  # attempts 3, interruptions 1 → failures 2 < 3
    boom = _models()
    boom.diarizer = _RaisingDiarizer(WorkerError("io_error", "x", ErrorKind.TRANSIENT))
    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", build_models=lambda: boom)
    assert out == "requeued"
```

그리고 findStatus까지의 실제 경로는 Task 5의 be 테스트가 아니라 여기서 SQL로 본다 — `findStatus`와 같은 식으로 읽는다:

```python
    row = conn.execute(
        "SELECT attempts - interruptions AS failures, interruptions, error FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["failures"] == 2 and row["interruptions"] == 1 and row["error"]["code"] == "io_error"
```

(이 세 줄을 위 테스트 끝에 붙인다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `uv run --directory be/worker pytest tests/test_reap_grid.py tests/test_db_lifecycle.py tests/test_worker_loop.py -q`
Expected: FAIL — `ImportError: cannot import name 'failures'`, `requeue() takes 3 positional arguments but 4 were given`.

- [ ] **Step 3: `requeue`를 고친다** — `be/worker/damwha_worker/db/queue.py`

```python
def requeue(conn, job_id: str, worker_id: str, error: dict) -> int:
    # 30초 기준·15분 상한. 1·2초였을 때는 세 번이 3초에 다 타서 3분짜리 네트워크 끊김이
    # job을 영구 실패로 만들었다 (Phase 4 결과 §12.6-12). max_attempts 기본값 5(025)와 함께
    # 시도 시각이 0 · 30s · 90s · 210s · 450s가 된다.
    #
    # 지수는 재시도 예산 소비량(attempts − interruptions) − 1이다 — 크래시 회수가 백오프를
    # 부풀리지 않는다 (Phase 6b-3 스펙 §4.3). dispatch.failures()와 같은 식이고
    # be/test/fixtures/job-reap/grid.json의 retry 격자가 둘을 함께 고정한다.
    #
    # error를 함께 쓴다 — 재시도 대기 중 화면의 "마지막 오류"가 여기서 온다(스펙 §6.3).
    # 다음 claim은 지우지 않는다: 재시도 중인 job의 마지막 오류로 남는다.
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL, error=%s,
               next_attempt_at=now()
                 + least(30 * power(2, attempts - interruptions - 1), 900) * interval '1 second',
               updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (Jsonb(error), job_id, worker_id),
    )
    return cur.rowcount
```

- [ ] **Step 4: `failures()`와 판정** — `be/worker/damwha_worker/dispatch.py`. `run_job` 위에:

```python
def failures(job: dict) -> int:
    """재시도 예산 소비량 = attempts − interruptions (Phase 6b-3 스펙 §4.1).

    "스스로 낸 실패 수"가 아니다 — 실행 중이면 지금 실행을, 성공했으면 그 실행을 포함한다.
    회수(크래시·heartbeat 부재)로 끝난 실행만 빠진다. db.requeue의 백오프 지수와 같은 식이다.
    """
    return job["attempts"] - job["interruptions"]
```

`run_job`의 `except Exception` 블록:

```python
        werr = classify(exc)
        error_json = werr.to_json(stage=job.get("stage"))
        spent = failures(job)
        log.warning(
            "job %s type=%s failed: code=%s kind=%s attempt=%s/%s interruptions=%s",
            job["id"],
            job["type"],
            werr.code,
            werr.kind.value,
            spent,
            job["max_attempts"],
            job["interruptions"],
        )
        retry = werr.kind is ErrorKind.TRANSIENT and spent < job["max_attempts"]
        return handler.on_failure(conn, job, ctx, error_json, retry=retry)
```

- [ ] **Step 5: `error`를 넘긴다** — `be/worker/damwha_worker/jobs.py`

```python
    def on_failure(self, conn, job: dict, ctx: JobContext, error: dict, *, retry: bool) -> str:
        """기본: 재시도 여지가 있으면 반납, 없으면 job만 failed로 닫는다.

        `retry`는 dispatch가 계산한다 — TRANSIENT이면서 재시도 예산 소비량
        (attempts − interruptions)이 max에 못 미칠 때만 참.
        """
        if retry:
            return "requeued" if db.requeue(conn, job["id"], ctx.worker_id, error) else "lost"
        return "failed" if db.fail_job(conn, job["id"], ctx.worker_id, error) else "lost"
```

```python
def _requeue_or(conn, job, ctx, error, *, retry: bool, close) -> str:
    """`retry`면 반납하고(마지막 오류를 남긴다), 아니면 `close`가 정한 방식으로 닫는다."""
    if retry:
        return "requeued" if db.requeue(conn, job["id"], ctx.worker_id, error) else "lost"
    return close()
```

호출처 넷(`ProcessMeetingHandler`·`EnrollSpeakerHandler`·`IndexMeetingHandler`(:267)·`SummarizeMeetingHandler`(:289))은 모두 `on_failure(self, conn, job, ctx, error, *, retry)` 안이다. 각각 `_requeue_or(conn, job, ctx, retry=…` → `_requeue_or(conn, job, ctx, error, retry=…`로 바꾼다. `grep -n "_requeue_or(" be/worker/damwha_worker/jobs.py`로 넷 모두 바뀐 것을 확인한다. `grep -rn "db.requeue(\|\.requeue(" be/worker/damwha_worker be/worker/tests`에 인자 셋짜리 호출이 남지 않아야 한다.

- [ ] **Step 6: 통과를 확인한다**

Run: `pnpm worker:test`
Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add be/worker/damwha_worker/dispatch.py be/worker/damwha_worker/db/queue.py be/worker/damwha_worker/jobs.py \
  be/worker/tests/test_reap_grid.py be/worker/tests/test_db_lifecycle.py be/worker/tests/test_worker_loop.py
git commit -m "feat(worker): 재시도 판정·백오프를 attempts − interruptions로, requeue가 마지막 오류를 남긴다"
graphify update .
```

---

### Task 5: `findStatus`의 `retry` 모양

**Files:**
- Modify: `be/src/meetings/meetings.repository.ts:123-137`
- Modify: `be/test/status-retry.spec.ts`

**Interfaces:**
- Consumes: Task 1 컬럼.
- Produces: `findStatus(...).retry: { failures: number; max_attempts: number; interruptions: number; next_attempt_at: string | null; error: object | null } | null`. Task 6(fe)이 이 모양을 받는다.

- [ ] **Step 1: 실패하는 테스트** — `be/test/status-retry.spec.ts`의 `queuedRetry` 헬퍼를 바꾼다:

```ts
  async function queuedRetry(error?: object, interruptions = 0) {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const mid = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, attempts, max_attempts, interruptions, next_attempt_at, error)
       VALUES('process_meeting',$1,'{}','queued',2,5,$3, now() + interval '90 seconds', $2::jsonb) RETURNING id`,
      [mid, error === undefined ? null : JSON.stringify(error), interruptions],
    );
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);
    return mid;
  }
```

첫 케이스(`'reports attempts, max_attempts and the next attempt time'`)를 아래 첫 케이스로 바꾸고 둘째를 더한다:

```ts
  it('reports failures (attempts − interruptions), max_attempts, interruptions and the next attempt time', async () => {
    const mid = await queuedRetry(undefined, 1);   // attempts 2, interruptions 1
    const row = await repo.findStatus(db.pool, mid);
    expect(row.retry).toMatchObject({ failures: 1, max_attempts: 5, interruptions: 1 });
    expect(row.retry).not.toHaveProperty('attempts');
    expect(row.retry.next_attempt_at).not.toBeNull();
  });

  it('reports zero interruptions for a job that was never reclaimed', async () => {
    const mid = await queuedRetry();
    const row = await repo.findStatus(db.pool, mid);
    expect(row.retry).toMatchObject({ failures: 2, interruptions: 0 });
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/status-retry.spec.ts`
Expected: FAIL — `failures` 없음.

- [ ] **Step 3: SQL을 고친다** — `be/src/meetings/meetings.repository.ts`의 `retry` 부분:

```sql
              -- j.error는 m.error와 다른 사실이다 (Phase 5 스펙 §6). 재시도 대기 중인 회의는
              -- 아직 실패하지 않았으므로 m.error가 null이고, 화면이 "왜 기다리는지"를
              -- 말하려면 마지막 시도가 남긴 job 쪽 오류가 필요하다.
              -- failures는 재시도 예산 소비량이다 (Phase 6b-3 스펙 §4.1·§5.1). attempts라는
              -- 이름으로 뜻을 몰래 바꾸지 않으려고 키 이름째 바꿨다.
              CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
                'failures', j.attempts - j.interruptions,
                'max_attempts', j.max_attempts,
                'interruptions', j.interruptions,
                'next_attempt_at', j.next_attempt_at,
                'error', j.error
              ) END AS retry,
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/status-retry.spec.ts` → PASS. `pnpm be test` 전체 PASS. `grep -rn "retry.*attempts\b\|'attempts'," be/src/meetings`에 옛 키가 남지 않는다.

- [ ] **Step 5: 커밋**

```bash
git add be/src/meetings/meetings.repository.ts be/test/status-retry.spec.ts
git commit -m "feat(be): 회의 상태의 retry가 failures·interruptions를 낸다"
graphify update .
```

---

### Task 6: 처리 배너 (fe)

**Files:**
- Modify: `fe/src/features/meeting/api/types.ts:186-196`
- Modify: `fe/src/pages/meeting.tsx:122-140`
- Modify: `fe/src/pages/meeting.test.tsx:1114-1190` (기존 셋의 `retry` 픽스처) + 새 케이스 셋

**Interfaces:**
- Consumes: Task 5의 `retry` 모양.
- Produces: 없음.

- [ ] **Step 1: 타입** — `fe/src/features/meeting/api/types.ts`

```ts
/** 재시도 대기 상태. job이 없으면 null. */
export type RetryStatus = {
  /** 재시도 예산 소비량 = attempts − interruptions (Phase 6b-3 스펙 §4.1). */
  failures: number;
  max_attempts: number;
  /** 크래시·강제 종료·heartbeat 부재로 회수된 횟수. 재시도 예산과 따로 센다. */
  interruptions: number;
  next_attempt_at: string | null;
  /**
   * 마지막 시도가 남긴 **job의** 오류. `MeetingStatusResponse.error`(회의의 오류)와 다른
   * 사실이다 — 재시도 대기 중인 회의는 아직 실패하지 않아 그쪽이 null이다.
   */
  error: JsonError | null;
};
```

- [ ] **Step 2: 기존 테스트 픽스처를 바꾸고 새 케이스를 쓴다** — `fe/src/pages/meeting.test.tsx`. 기존 재시도 테스트 셋의 `retry: { attempts: N, … }`를 `retry: { failures: N, interruptions: 0, … }`로(다른 값은 그대로). 그 셋 뒤에:

```tsx
test("중단이 있었으면 재시도 배너 끝에 중단 횟수를 붙인다", async () => {
  fx.setStatus({
    stage: null,
    progress: null,
    retry: {
      failures: 1,
      max_attempts: 5,
      interruptions: 2,
      next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
      error: null,
    },
  });
  renderShell("/meetings/m3");
  await screen.findByText(/회의를 처리하고 있어요/);
  expect(await screen.findByText(/1\/5회차/)).toBeInTheDocument();
  expect(screen.getByText(/중단 2회/)).toBeInTheDocument();
});

test("중단이 없으면 중단 문구를 붙이지 않는다", async () => {
  fx.setStatus({
    stage: null,
    progress: null,
    retry: {
      failures: 2,
      max_attempts: 5,
      interruptions: 0,
      next_attempt_at: new Date(Date.now() + 90_000).toISOString(),
      error: null,
    },
  });
  renderShell("/meetings/m3");
  await screen.findByText(/재시도 대기/);
  // "녹음이 중단됐어요" 같은 다른 문구와 겹치지 않게 모양까지 본다.
  expect(screen.queryByText(/중단 \d+회/)).toBeNull();
});

test("앞 시도의 stage가 남아 있어도 재시도 대기가 이긴다 (스펙 §6.2)", async () => {
  // requeue는 stage를 지우지 않는다 — 전사 도중의 일시 실패는 재시도 대기 내내 stage='stt'다.
  fx.setStatus({
    stage: "stt",
    progress: 40,
    retry: {
      failures: 1,
      max_attempts: 5,
      interruptions: 0,
      next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
      error: { code: "model_download_failed", message: "reset" },
    },
  });
  renderShell("/meetings/m3");
  await screen.findByText(/회의를 처리하고 있어요/);
  expect(await screen.findByText(/재시도 대기/)).toBeInTheDocument();
  expect(screen.getByText(/마지막 오류: model_download_failed/)).toBeInTheDocument();
});
```

"모델을 받는 중이면 재시도 문구 대신 다운로드 문구만 뜬다"는 `stage: null` 그대로 두고, 같은 케이스를 `stage: "stt"`로 한 벌 더 복사해 다운로드가 여전히 이기는지 본다(이름 끝에 ` — stage가 있어도`).

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/pages/meeting.test.tsx`
Expected: FAIL — "N/5회차"가 `undefined/5회차`, 중단 문구 없음, stage 케이스는 "전사" 라벨이 이김. (`pnpm fe exec tsc --noEmit` 대신 vitest가 타입 오류로 실패할 수도 있다 — 어느 쪽이든 빨간불.)

- [ ] **Step 4: 배너를 고친다** — `fe/src/pages/meeting.tsx`. `retryErrorCode` 정의 다음부터 `stageLabel`까지를 바꾼다:

```tsx
  const retryErrorCode = status?.retry?.error?.code ?? null;
  const retryInterruptions = status?.retry?.interruptions ?? 0;
  // 재시도 대기가 stage보다 앞선다 (Phase 6b-3 스펙 §6.2). requeue는 stage를 지우지 않으므로
  // stage를 먼저 쓰면 전사 도중의 일시 실패가 재시도 대기 내내 "전사 중"으로 보였다.
  // 다운로드 문구는 여전히 이긴다 — showRetry가 이미 그 조건을 담고 있다.
  const stageLabel = showRetry
    ? `재시도 대기 · ${status!.retry!.failures}/${status!.retry!.max_attempts}회차 · 약 ${Math.max(1, Math.round(retryMs! / 60000))}분 뒤${retryErrorCode ? ` · 마지막 오류: ${retryErrorCode}` : ""}${retryInterruptions > 0 ? ` · 중단 ${retryInterruptions}회` : ""}`
    : status?.stage
      ? (STAGE_LABELS[status.stage] ?? "처리 중")
      : "대기 중";
```

`// 백오프가 30초·90초·…` 주석 블록은 그대로 둔다.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/pages/meeting.test.tsx` → PASS. `pnpm fe test`·`pnpm fe lint`·`pnpm fe build` PASS(타입 확인 포함).

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/meeting/api/types.ts fe/src/pages/meeting.tsx fe/src/pages/meeting.test.tsx
git commit -m "feat(fe): 재시도 배너가 failures·중단 횟수를 말하고 옛 stage를 이긴다"
graphify update .
```

---

### Task 7: 문서 — `desktop/CLAUDE.md`, backlog

**Files:**
- Modify: `desktop/CLAUDE.md` "중단된 작업의 회수 — 층이 넷" 절의 `attempts` 두 항목, "재시도 — 0 · 30초 · …" 절
- Modify: `be/docs/backlog.md` (끝에 항목 둘)

- [ ] **Step 1: `desktop/CLAUDE.md`를 고친다.**

"중단된 작업의 회수" 절의 셋째 항목(`- 기동 회수는 \`attempts\`를 **되돌리지 않고** 세 갈래로 간다: …`)을 다음으로 바꾼다:

```markdown
- 회수는 **중단을 센다** — `job.interruptions`를 +1 하고 그것으로 상한을 판정한다(마이그레이션 `026`,
  Phase 6b-3 스펙 §4.2). `attempts`는 읽지도 바꾸지도 않는다. 세 갈래: 중단 예산이 남은 비-live는
  `queued`로, 다 쓴(`interruptions + 1 >= max_interruptions`, 기본 3) 비-live는 `failed`(`app_restarted`)로 —
  딸린 `meeting`·요약·렌즈 run·화자까지 함께 닫되 **회의는 그 job이 아직 `current_job_id`일 때만** —
  `live_session`은 언제나 `failed`로. 앱을 세 번 강제 종료하면 그 job은 실패한다. 그것이 정직하다
  (그 job이 앱을 죽이고 있을 수 있다). 라이브의 봉인·마무리는 회수가 아니라 API의
  `LiveOrphanService`가 한다 — 회수는 그 경로를 30분 기다리지 않고 여는 것뿐이다.
```

같은 절의 `- 자기 고아 회수도 \`attempts\`를 **되돌리지 않고** …` 항목:

```markdown
- 자기 고아 회수도 같은 규칙이다(`reap_stale`과 SQL 한 벌을 공유한다) — `interruptions` +1, 상한이면
  `failed`. 재현 회차(Phase 5)에서는 옛 규칙이라 `attempts`가 1에서 2가 됐다. 지금은 `attempts`가 claim의
  +1로만 오르고 회수는 `interruptions`만 올린다.
```

"재시도" 절의 첫 문단 식을 바꾼다: `next_attempt_at = now() + least(30 * 2^(attempts-1), 900)초` → `next_attempt_at = now() + least(30 * 2^(attempts − interruptions − 1), 900)초`. 그리고 마지막 항목(`- **강제 종료 N번은 재시도 5회 중 N회를 먹는다** …`)을 다음으로 바꾼다:

```markdown
- **강제 종료는 재시도 예산을 먹지 않는다** (Phase 6b-3). 재시도 판정은 `attempts − interruptions`
  (재시도 예산 소비량 — 성공한 실행도 1이다) `< max_attempts`이고, 회수는 `interruptions`만 올린다.
  두 한도(재시도 5, 중단 3)는 독립이고 먼저 닿는 쪽이 job을 끝낸다. 30분 reaper가 보는 것은 "30분간
  heartbeat 성공 없음"이다 — 긴 job은 heartbeat가 살아 있는 한 회수되지 않는다.
- 화면의 재시도 문구는 stage보다 앞선다 — `requeue`가 stage를 지우지 않아서다. `· 중단 N회`는
  중단이 있을 때만. "마지막 오류"는 `requeue`가 쓰는 `job.error`다(6b-3 전에는 비어 있었다).
- `026` 전에 만들어진 job은 `interruptions=0`이다 — 그 전에 크래시로 먹은 시도는 예산 소비로 남는다.
```

- [ ] **Step 2: backlog 항목 둘** — `be/docs/backlog.md` 끝에:

```markdown
## 재처리의 상태 확인이 트랜잭션 밖이다 (등록 2026-09-24, P3)

Phase 6b-3 코덱스 스펙 리뷰 #1의 앞 절반. `MeetingsService.reprocess`
(`be/src/meetings/meetings.service.ts:223`)는 회의가 `done`/`failed`인지 트랜잭션 **밖에서** 보고,
`bumpVersionForReprocess`(`meetings.repository.ts:215`)는 상태를 다시 보지 않는다. 재처리 요청 둘이
동시에 들어오면 job 둘이 enqueue되고 늦은 쪽이 `current_job_id`가 된다. 밀려난 job은 끝까지 돈다.

- 6b-3이 막은 것은 그 경합의 **끝** 하나다 — 밀려난 job이 중단 한도를 태울 때 회수가 새 실행의
  회의를 `failed`로 덮던 것(세 벌의 `fail_meetings`에 `current_job_id` 가드, 스펙 §6.1).
- 남은 것: 중복 enqueue 자체, 밀려난 job의 결과 쓰기(`processing_version` 가드가 막는지 확인 필요).
- 고칠 방향: 트랜잭션 안에서 `SELECT … FOR UPDATE`로 상태를 다시 보거나, `bumpVersionForReprocess`가
  `WHERE status IN ('done','failed')`를 걸고 0행이면 409.

## `--once` 스캔이 실패해도 worker를 재시작한다 — 같은 신분의 자식 둘 (등록 2026-09-24, P3)

Phase 6b-3 코덱스 스펙 리뷰 #2. `desktop/src/services/supervisor.ts:544`의 `reapOwnOnceBefore`는 스캔
실패·예외에도 재시작을 계속한다(Phase 5의 의도 — 스캔은 재시작을 막지 않는다). `WORKER_ID`는 앱 실행
내내 같으므로(`config.ts`의 `RUN_WORKER_ID`), 옛 supervisor의 `--once` 자식이 살아남은 채 새
supervisor가 뜨면 새 supervisor의 자기 고아 회수(`__main__.py:132`)가 그 자식의 job을 거둔다
(`interruptions` +1). 새 자식이 재claim한 뒤 옛 자식의 늦은 heartbeat·stage·실패·반납은 신분이 같아
소유권 가드(`locked_by=%s AND status='running'`)를 통과한다.

- 6b-3이 키우지 않았다 — 옛 규칙에서도 같은 겹침이 `attempts`를 먹었다.
- 고칠 방향: 스캔 실패 시 재시작을 막거나(가용성 비용), 실행별 펜싱(claim이 발급하는 토큰을 모든 소유권
  가드에 더한다).
```

- [ ] **Step 3: 커밋**

```bash
git add desktop/CLAUDE.md be/docs/backlog.md
git commit -m "docs(phase6b): 회수·재시도 규칙을 interruptions로 고치고 backlog 둘을 남긴다"
```

---

### Task 8: 전 패키지 검증과 변이 (P6b3-C5·C7·C8)

**Files:**
- Create: `docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md` (§1 변이)

- [ ] **Step 1: 전 패키지 초록을 확인한다**

Run: `pnpm test && pnpm lint && pnpm worker:test`
Expected: 셋 다 exit 0. 출력에서 be·fe 테스트 수가 0이 아닌지 본다(거짓 초록불 방지).

- [ ] **Step 2: 변이를 하나씩 넣는다.** 각 변이는 작업 트리에서만 하고 **커밋하지 않는다.** 넣고 → 표의 테스트를 돌리고 → 빨간불을 기록하고 → `git checkout -- <파일>`로 되돌린다. 되돌린 뒤 `git status --short`가 결과 문서 말고는 깨끗한지 매번 본다.

| # | 파일·변이 | 돌릴 것 |
| --- | --- | --- |
| M1 | `jobs.repository.ts` `reclaimOrphaned`의 `requeued` WHERE `interruptions + 1 < max_interruptions` → `<=` | `jest test/reap-grid.spec.ts` |
| M2 | `reapStale`의 같은 자리 `<` → `<=` | 같음 |
| M3 | `queue.py` `_REAP_SQL`의 같은 자리 `<` → `<=` | `pytest tests/test_reap_grid.py` |
| M4a | `reclaimOrphaned` `requeued`의 `interruptions = interruptions + 1` 삭제 | `jest test/reap-grid.spec.ts test/reclaim.spec.ts` |
| M4b | `reapStale` `requeued`의 같은 삭제 | `jest test/reap-grid.spec.ts test/reaper.spec.ts` |
| M4c | `_REAP_SQL` `requeued`의 같은 삭제 | `pytest tests/test_reap_grid.py tests/test_db_lifecycle.py` |
| M5a | `reclaimOrphaned` 판정 둘을 `attempts < max_attempts`/`>=`로 되돌림(`orphaned`에 `attempts, max_attempts`를 다시 SELECT) | `jest test/reap-grid.spec.ts` |
| M5b | `reapStale` 같은 되돌림 | 같음 |
| M5c | `_REAP_SQL` 같은 되돌림 | `pytest tests/test_reap_grid.py` |
| M6 | `failed_interrupted`(TS)의 `interruptions = j.interruptions + 1` 삭제 | `jest test/reap-grid.spec.ts` |
| M7 | `dispatch.py` 재시도 판정 `spent < …` → `job["attempts"] < …` | `pytest tests/test_worker_loop.py` |
| M8 | `requeue` 백오프의 `- interruptions` 삭제 | `pytest tests/test_reap_grid.py` |
| M9 | `requeue_for_shutdown`에 `interruptions = greatest(interruptions - 1, 0),` 추가 | `pytest tests/test_db_lifecycle.py` |
| M10 | `findStatus`의 `'failures', j.attempts - j.interruptions` → `'failures', j.attempts` | `jest test/status-retry.spec.ts` |
| M11 | 배너의 `retryInterruptions > 0 ?` 조건 제거(항상 붙임) | `vitest run src/pages/meeting.test.tsx` |
| M12 | `026`의 `DEFAULT 3` → `DEFAULT 5` | `jest test/migration.spec.ts test/reap-grid.spec.ts` |
| M13a | `reclaimOrphaned` `fail_meetings`의 `AND m.current_job_id = f.id` 삭제 | `jest test/reclaim.spec.ts` |
| M13b | `reapStale` 같은 삭제 | `jest test/reaper.spec.ts` |
| M13c | `_REAP_SQL` 같은 삭제 | `pytest tests/test_db_lifecycle.py` |
| M14 | 배너 삼항을 stage 먼저로 되돌림 | `vitest run src/pages/meeting.test.tsx` |
| M15 | `requeue`의 `error=%s,` 삭제(인자 튜플도 맞춘다) | `pytest tests/test_db_lifecycle.py tests/test_worker_loop.py` |

변이가 초록이면 **테스트 결손이다** — 그 변이를 잡는 테스트를 더해 커밋한 뒤 다시 돌린다(규칙은 고치지 않는다). 동치 변이로 판정하면 사유를 적는다.

- [ ] **Step 3: 결과 문서를 쓴다** — `docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md`

```markdown
# Electron Phase 6b-3 — `attempts` 분리 (결과)

스펙: [2026-09-24-electron-phase-6b-attempts-split-design.md](../specs/2026-09-24-electron-phase-6b-attempts-split-design.md)
계획: [2026-09-24-electron-phase-6b-attempts-split.md](../plans/2026-09-24-electron-phase-6b-attempts-split.md)
브랜치: `feat/electron-migration-phase-6b-attempts`

## 1. 변이 검증 (P6b3-C7)

| # | 변이 | 돌린 테스트 | 결과 (빨간불을 낸 테스트 이름) |
| --- | --- | --- | --- |
| M1 | … | … | … |

(M1~M15 전 행. 초록이었던 변이와 보강한 테스트, 동치 판정 사유를 표 아래에 적는다.)

## 2. 완료 기준 판정

(Task 9 뒤에 채운다.)
```

표는 실제로 돌린 결과로 채운다 — 추정으로 채우지 않는다.

- [ ] **Step 4: 커밋**

```bash
git add docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md
# 보강한 테스트가 있으면 그 파일도 이름으로 add
git commit -m "test(phase6b): 6b-3 변이 M1~M15를 돌려 기록한다"
```

---

### Task 9: packaged 실측 (P6b3-C1~C4) — 사람과 함께

GUI 조작(설치·업로드·설정 변경·대화상자 닫기)은 사용자가 한다. 에이전트는 명령·psql·로그 판독·기록을 맡는다. 스펙 §8.2를 그대로 따른다 — 아래는 순서와 기록 형식만 정한다.

**Files:**
- Modify: `docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md` (§2~)

- [ ] **Step 1: 준비 (스펙 §8.2-0)**
  1. `pgrep -fl "Damwha.app/Contents|Electron.app/Contents/MacOS/Electron|electron/cli.js|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"`가 빈지 확인. 비어 있지 않으면 사용자에게 끄게 한다(`osascript -e 'quit app "Damwha"'`가 `User canceled`면 대화상자가 떠 있다 — 사용자가 닫는다).
  2. `STAMP=$(date +%Y%m%dT%H%M%S); rsync -a --exclude models --exclude Cache --exclude 'Code Cache' --exclude GPUCache "$HOME/Library/Application Support/Damwha/" "$HOME/damwha-6b3-recovery-$STAMP/"` — 끝난 뒤 `du -sh`로 크기를 기록.
  3. `pnpm desktop package:desktop` → `ditto desktop/out/mac-arm64/Damwha.app ~/damwha-builds/Damwha-6b3-$(git rev-parse --short HEAD).app`.
  4. `gh release download desktop-v0.3.1 --repo Yjason-K/Damwha --pattern '*.dmg' --dir ~/damwha-builds/`.
- [ ] **Step 2: C1 업그레이드 보존** — 스펙 §8.2-1의 1~4. 전 기준선 SQL(0.3.1이 떠 있는 동안, 상태 창의 psql 명령으로):

```sql
SELECT name FROM _migrations ORDER BY name DESC LIMIT 1;                         -- 025_job_retry_policy.sql
SELECT count(*) FROM information_schema.columns
 WHERE table_name='job' AND column_name='interruptions';                        -- 0
SELECT id, status, processing_version, audio_key FROM meeting ORDER BY id;
SELECT meeting_id, md5(string_agg(id || ':' || coalesce(text,'') || ':' || coalesce(speaker_id,''), '|' ORDER BY id))
  FROM utterance GROUP BY meeting_id ORDER BY meeting_id;
SELECT meeting_id, md5(content::text) FROM meeting_summary ORDER BY meeting_id;   -- 컬럼 이름은 \d meeting_summary로 확인
SELECT id, name FROM speaker ORDER BY id;
SELECT value FROM app_setting WHERE key='processing_defaults';
SELECT id, type, status, attempts, max_attempts FROM job ORDER BY id;
```

파일: `find "<userData>/data/storage" -type f -exec shasum -a 256 {} + | sort -k2 > before-files.txt`, `shasum -a 256 "<userData>/config.json" "<userData>/hf-token.bin"`, `ls "<userData>/backups"`. 새 빌드 기동 뒤 같은 것을 다시 뜨고(`interruptions` 컬럼 확인 SQL은 `SELECT id, attempts, interruptions, max_interruptions FROM job`), `supervisor.log`의 `적용 전 백업` 줄과 `_migrations`의 `026` `applied_at`을 기록. 화면 확인(재생·전사·요약·설정)은 사용자.
- [ ] **Step 3: C2 중단** — 스펙 §8.2-2의 2a·2b. `--once` 자식 특정:

```bash
psql … -c "SELECT id, locked_by, attempts, interruptions FROM job WHERE status='running'"
pgrep -fl "damwha_worker.*--once"
```

회차마다 `SELECT status, attempts, interruptions, error->>'code' FROM job WHERE id='<id>'`를 kill 직후·재claim 뒤 두 번 기록. 2b는 `pkill -9 -f "Damwha.app/Contents/Resources/python"` 뒤 `pkill -9 -f "Damwha.app/Contents/MacOS/Damwha"` — **postgres에는 보내지 않는다.**
- [ ] **Step 4: C3** — 스펙 §8.2-3. 할 수 없으면 생략 사유를 기록.
- [ ] **Step 5: C4 되돌림 거부** — 스펙 §8.2-4. `ls backups` 전후 동일, `supervisor.log`의 `migrationUnknown` 줄, 새 판 재설치 뒤 정상 기동.
- [ ] **Step 6: 정리** — 스펙 §8.2-5. 사용자에게 묻고 그대로 한다.
- [ ] **Step 7: 결과 문서 §2 판정표** — P6b3-C1~C8 각 행에 충족/미충족/한계와 근거(명령 출력 인용·로그 줄·시각). 로드맵의 Phase 6b 절에 6b-3 상태 문단(스펙·결과·브랜치 링크, "6b-3 먼저, 6b-2는 그 병합 뒤" 결정)을 더한다.

```bash
git add docs/superpowers/reports/2026-09-24-electron-phase-6b-attempts-split-results.md docs/electron-migration-roadmap.md
git commit -m "docs(phase6b): 6b-3 packaged 실측 결과를 기록하고 로드맵을 갱신한다"
```

---

## Self-Review

- **스펙 커버리지.** §4.1 불변식 → Task 3 Step 6. §4.2 회수 세 벌 → Task 2(TS 둘)·Task 3(Python). 메시지·반환 이름 → Task 2 Step 4·6. §4.3 → Task 4. §4.4 → Task 1. §5.1 → Task 5. §5.2 → Task 6. §6.1 → Task 2·3(+M13). §6.2 → Task 6. §6.3 → Task 4. §7 한계·§10 backlog·문서 → Task 7. §8.1 격자·변이 → Task 2~4·8. §8.2 → Task 9. §9 C1~C8 → Task 8·9. 로드맵 → Task 9 Step 7.
- **자리표시자.** 결과 문서의 표 행은 실행 결과로 채우라는 지시이고 추정값을 적지 말라는 제약이다.
- **이름 일치.** `failedInterrupted`(Task 2·7), `failures()`(Task 4), `requeue(conn, job_id, worker_id, error)`(Task 4 전역), `seed_job(interruptions=, max_interruptions=)`(Task 3·4), grid 키 `reap`/`retry`(Task 2·3·4), `retry.failures`/`retry.interruptions`(Task 5·6).

## 계획 검증 기록 (코덱스)

(검증 뒤 채운다.)
