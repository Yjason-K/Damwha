# 렌즈 추출 상태 집계 엔드포인트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 전역 렌즈 대시보드 배너용 `GET /lenses/extraction-status`를 추가해 진행 중 추출 수와 실패 회의 목록을 반환한다.

**Architecture:** 기존 `lenses` 도메인(NestJS, raw SQL)에 읽기 전용 집계 하나를 추가한다. `lens_extraction_run`을 회의별 최신 run으로 축약해 실패 회의를 뽑고, 전체 queued/running run 수를 진행 카운트로 센다. 재시도는 기존 `POST /meetings/:id/lenses/extract`를 재사용하므로 신규 쓰기 경로는 없다.

**Tech Stack:** NestJS, TypeScript, pg (raw SQL), Jest + Testcontainers(e2e).

## Global Constraints

- Node 22 (`nvm use`). 테스트는 Docker 필요(Testcontainers).
- ORM 없음. SQL은 `*.repository.ts`, 오케스트레이션은 `*.service.ts`, HTTP는 `*.controller.ts`.
- 기존 렌즈 계약(작업 1·2)의 필드·라우트를 변경하지 않는다. 추가만 한다.
- "최신 run" 판정 정렬은 반드시 `created_at DESC, id DESC`(동시각 tie-breaker).
- 상태 enum 값은 `queued|running|done|failed`(`lens_extraction_run` CHECK).

---

### Task 1: `GET /lenses/extraction-status` 집계 엔드포인트

**Files:**
- Modify: `src/lenses/lens-extraction.repository.ts` (집계 쿼리 추가)
- Modify: `src/lenses/lenses.service.ts` (서비스 위임 메서드 추가)
- Modify: `src/lenses/lenses.controller.ts` (라우트 추가)
- Test: `test/lens-extraction-status.e2e-spec.ts` (신규)

**Interfaces:**
- Consumes: 기존 `LensExtractionRepository`, `LensesService`(생성자 주입), `lens_extraction_run`/`meeting` 테이블.
- Produces:
  - `LensExtractionRepository.aggregateStatus(exec): Promise<{ running: number; failed: { meeting_id: string; title: string | null }[] }>`
  - `LensesService.extractionStatus(): Promise<{ running: number; failed: { meeting_id: string; title: string | null }[] }>`
  - HTTP `GET /lenses/extraction-status` → `{ running: number, failed: [{ meeting_id, title }] }`

- [x] **Step 1: Write the failing e2e test**

Create `test/lens-extraction-status.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CAPABILITIES } from '../src/system/capabilities';
import { startTestDb, StartedTestDb } from './db';

describe('GET /lenses/extraction-status', () => {
  let db: StartedTestDb;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDb();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAPABILITIES)
      .useValue({
        platform: 'darwin', arch: 'arm64', chip: 'test', memory_gb: 32,
        gpu_eligible: true, recommended_preset: 'standard',
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  const mkMeeting = async (title: string) => (await db.pool.query(
    `INSERT INTO meeting(audio_key,status,title) VALUES('a','done',$1) RETURNING id`, [title],
  )).rows[0].id as string;

  const mkRun = async (meetingId: string, status: string, pv = 0) => db.pool.query(
    `INSERT INTO lens_extraction_run(meeting_id, processing_version, status, model)
     VALUES($1,$2,$3,'qwen')`, [meetingId, pv, status],
  );

  it('counts running/queued runs and lists meetings whose latest run failed', async () => {
    const m1 = await mkMeeting('진행중 회의');
    const m2 = await mkMeeting('실패 회의');
    const m3 = await mkMeeting('해소된 회의');
    await mkRun(m1, 'running');
    await mkRun(m2, 'failed');
    // m3: 예전엔 실패했지만 최신 run은 done → failed 목록에서 제외
    await mkRun(m3, 'failed', 0);
    await mkRun(m3, 'done', 1);

    const res = await request(app.getHttpServer()).get('/lenses/extraction-status').expect(200);
    expect(res.body.running).toBe(1);
    expect(res.body.failed).toEqual([{ meeting_id: m2, title: '실패 회의' }]);
  });

  it('returns zeros when there are no runs', async () => {
    const res = await request(app.getHttpServer()).get('/lenses/extraction-status').expect(200);
    expect(res.body).toEqual({ running: 0, failed: [] });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest test/lens-extraction-status.e2e-spec.ts --runInBand`
Expected: FAIL — route `GET /lenses/extraction-status`가 없어 404(또는 `extractionStatus` 미정의).

- [x] **Step 3: Add the aggregate repository method**

In `src/lenses/lens-extraction.repository.ts`, add a method to the `LensExtractionRepository` class:

```ts
  async aggregateStatus(exec: Queryable): Promise<{
    running: number;
    failed: { meeting_id: string; title: string | null }[];
  }> {
    const { rows } = await exec.query<{ running: number; failed: unknown }>(
      `WITH latest AS (
         SELECT DISTINCT ON (meeting_id) meeting_id, status
         FROM lens_extraction_run
         ORDER BY meeting_id, created_at DESC, id DESC
       )
       SELECT
         (SELECT count(*)::int FROM lens_extraction_run
           WHERE status IN ('queued','running')) AS running,
         COALESCE(
           json_agg(json_build_object('meeting_id', l.meeting_id, 'title', m.title)
                    ORDER BY l.meeting_id)
             FILTER (WHERE l.status = 'failed'),
           '[]'
         ) AS failed
       FROM latest l JOIN meeting m ON m.id = l.meeting_id`,
    );
    const row = rows[0];
    return {
      running: row?.running ?? 0,
      failed: (row?.failed as { meeting_id: string; title: string | null }[]) ?? [],
    };
  }
```

- [x] **Step 4: Add the service method**

In `src/lenses/lenses.service.ts`, the constructor already injects the repositories. Confirm `LensExtractionRepository` is injected (it is a provider in `LensesModule`); if the service does not yet reference it, add it to the constructor:

```ts
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: LensesRepository,
    private readonly extraction: LensExtractionRepository,
  ) {}
```

Then add:

```ts
  extractionStatus() {
    return this.extraction.aggregateStatus(this.db.pool);
  }
```

Import `LensExtractionRepository` at the top if not already imported.

- [x] **Step 5: Add the controller route**

In `src/lenses/lenses.controller.ts`, add a route to `LensesController` (place it above the `Post('lenses')` handler; it does not conflict with the parameterless `Get('lenses')`):

```ts
  @Get('lenses/extraction-status')
  @ApiOperation({ summary: '전역 렌즈 추출 상태 집계 (진행중 수 + 실패 회의)' })
  extractionStatus() {
    return this.service.extractionStatus();
  }
```

- [x] **Step 6: Run the test to verify it passes**

Run: `npx jest test/lens-extraction-status.e2e-spec.ts --runInBand`
Expected: PASS (both cases).

- [x] **Step 7: Full verification**

Run:

```bash
npm test -- --runInBand
npx tsc --noEmit -p tsconfig.build.json
npm run build
git diff --check
```

Expected: 모두 exit 0, 렌즈 기존 스위트 회귀 없음.

- [x] **Step 8: Commit**

```bash
git add src/lenses/lens-extraction.repository.ts src/lenses/lenses.service.ts \
        src/lenses/lenses.controller.ts test/lens-extraction-status.e2e-spec.ts
git commit -m "feat: add global lens extraction status endpoint"
```

## Plan Self-Review

- Spec coverage: 설계 §4.2(집계 엔드포인트) + §7 BE 테스트(진행중 카운트, 최신 run 실패만, tie-breaker)를 Task 1이 모두 덮는다. §4.1(projection)은 변경 없음이 결론이라 BE 작업 없음.
- Placeholder: 없음. 모든 스텝에 실제 SQL/TS/명령 포함.
- Type consistency: `aggregateStatus`/`extractionStatus` 반환형이 repo→service→controller에서 동일 `{ running, failed:[{meeting_id,title}] }`.
- tie-breaker: `DISTINCT ON ... ORDER BY meeting_id, created_at DESC, id DESC`로 명시.
