# Electron Phase 5 — 운영 안정화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱이 죽거나 맥이 자거나 디스크가 차도 job의 소유권·상태 전이가 정합하고, 복구가 사람 개입 없이 끝나게 만든다.

**Architecture:** 회수는 세 층이다 — (1) API 기동 시 `reclaimOrphaned`가 **앞 실행이 남긴** `running` job을 즉시 되돌리고, (2) 기존 30분 reaper가 **이번 실행 중에** 죽은 worker를 맡고, (3) desktop이 supervisor 재시작 전에 `--once` 고아 프로세스를 거둔다. 여기에 재시도 백오프를 30초 기준으로 늘리고, 늘어난 대기를 화면이 말하게 하는 관측 계약을 더한다.

**Tech Stack:** NestJS 10 + 생 SQL(pg), Python 3.12 worker(psycopg), React 19 + TanStack Query, Electron(TypeScript). 테스트는 jest(be, testcontainers Postgres), pytest(worker), vitest(fe·desktop).

**Spec:** `docs/superpowers/specs/2026-09-19-electron-phase-5-operational-hardening-design.md`

## Global Constraints

- **명령은 항상 저장소 루트에서 `pnpm` 스크립트로 돌린다.** 패키지 디렉터리에서 직접 띄우지 않는다 — `be`는 `.env`를 dotenv로 읽고 `STORAGE_ROOT=./storage`를 `process.cwd()` 기준으로 푼다.
- **`be/`에서 `npm install` 금지.** 미선언 의존을 다시 가린다.
- 테스트 명령: `pnpm be test` / `pnpm worker:test` / `pnpm fe test` / `pnpm desktop test`.
- 마이그레이션 파일은 `be/src/database/migrations/NNN_<name>.sql`, 세 자리 연번. 다음 번호는 **025**.
- **확정된 스펙·계획은 사후 편집하지 않는다.** 실제가 갈리면 결과 문서에 적는다.
- 앱이 띄운 worker의 신분은 `WORKER_ID=desktop-<uuid>`, 터미널 worker는 `worker-1`, 웹 배포판은 `WORKER_ID` 없음.
- 결과 문서: `docs/superpowers/reports/2026-09-19-electron-phase-5-operational-hardening-results.md`. Task 1이 만들고 각 Task가 덧쓴다.

---

## File Structure

| 파일 | 책임 | Task |
| --- | --- | --- |
| `be/src/jobs/worker-identity.ts` (신규) | 앱 worker 신분의 접두사 상수와 판정 하나 | 2 |
| `be/src/jobs/jobs.repository.ts` (수정) | `reclaimOrphaned` 추가 — 비-live 되돌리기 + live 닫기 | 2·3 |
| `be/src/jobs/reaper.service.ts` (수정) | 부트스트랩 1회 회수 배선 | 4 |
| `be/src/config/env.ts` (수정) | `WORKER_ID` 선택 키 | 2 |
| `be/src/database/migrations/025_job_retry_policy.sql` (신규) | `max_attempts` 기본값 5 | 5 |
| `be/worker/damwha_worker/db/queue.py` (수정) | 백오프 30초 기준, `mark_processing` 소유권 가드 | 5·6 |
| `be/worker/damwha_worker/pipeline/process_meeting.py` (수정) | `mark_processing`에 `worker_id` 전달 | 6 |
| `be/src/meetings/meetings.repository.ts` (수정) | `findStatus`에 `retry` 객체 | 7 |
| `fe/src/features/meeting/api/types.ts` (수정) | `RetryStatus` 타입 | 7 |
| `fe/src/pages/meeting.tsx` (수정) | 재시도 대기 문구 | 7 |
| `desktop/src/process/orphans.ts` (수정) | `ReapPlan.only` 필터, `reapOwnOnceChildren` | 8 |
| `desktop/src/services/supervisor.ts` (수정) | `reapOwnOnce` 훅 — **크래시 재시작 타이머**와 `restartOnce` 둘 다 | 8 |
| `desktop/src/config/config.ts` (수정) | `APP_WORKER_PREFIX` export (BE 상수와 같은 문자열) | 8 |
| `desktop/src/main.ts` (수정) | `reapOwnOnce` 훅 배선 | 8 |
| `be/test/jobs.repository.spec.ts` (수정) | 기본값 3을 기대하던 단언을 5로 | 5 |
| `be/test/reclaim-bootstrap.e2e-spec.ts` (신규) | AppModule 기동 뒤 행 불변 (P5-C2) | 4 |

---

## Task 1: 디스크 부족 주입 방법 실증 (스파이크 — 제품 코드 없음)

스펙 §12의 미확정 항목이다. **이 Task는 코드를 만들지 않는다.** 뒤 Task의 순서를 바꾸지 않으므로 Task 2와 병행해도 되지만, Task 10의 절차가 이 결과에 달려 있다.

**Files:**
- Create: `docs/superpowers/reports/2026-09-19-electron-phase-5-operational-hardening-results.md`

**Interfaces:**
- Consumes: 없음
- Produces: 결과 문서 §1에 "디스크 부족 주입 방법: 후보 1 성립 / 후보 2 성립 / 둘 다 불가" 중 하나와 재현 명령.

- [ ] **Step 1: 512MB sparse image를 만들고 마운트한다**

```bash
hdiutil create -size 512m -type SPARSE -fs APFS -volname DamwhaDiskFull /tmp/damwha-diskfull
hdiutil attach /tmp/damwha-diskfull.sparseimage
ls -la /Volumes/DamwhaDiskFull
```

- [ ] **Step 2: packaged 앱을 그 볼륨의 userData로 띄운다**

앱이 이미 빌드돼 있지 않으면 먼저 `pnpm desktop:build`.

```bash
"/Users/gim-yeongjae/project/daewha/desktop/out/mac-arm64/Damwha.app/Contents/MacOS/Damwha" \
  --user-data-dir=/Volumes/DamwhaDiskFull/Damwha 2>&1 | tee /tmp/diskfull-probe.log &
sleep 60
ls -la /Volumes/DamwhaDiskFull/Damwha
```

기대: `/Volumes/DamwhaDiskFull/Damwha/data/postgres`에 클러스터가 생긴다. 생기지 않거나 앱이 기존 `~/Library/Application Support/Damwha`를 열면 **후보 1 탈락**이다.

- [ ] **Step 3: 후보 1이 탈락하면 후보 2를 본다**

앱을 끄고, 기존 `data/storage`를 볼륨으로 옮긴 뒤 심볼릭 링크를 건다. **원본은 지우지 않는다 — 옮기고 링크만 건다.**

**데이터를 옮기는 절차다. 복구를 셸 설명에 맡기지 않고 `trap`으로 건다** — 중단·마운트 실패·앱 기동 실패 어디서 끊겨도 원본이 제자리로 돌아와야 한다.

```bash
cat > /tmp/diskfull-candidate2.sh <<'SH'
set -euo pipefail
UD="$HOME/Library/Application Support/Damwha"
SRC="$UD/data/storage"
BACKUP="$UD/data/storage.probe-backup"

restore() {
  # 링크를 먼저 지운다 — 남아 있으면 mv가 링크 안으로 들어간다.
  [ -L "$SRC" ] && rm -f "$SRC"
  if [ -d "$BACKUP" ] && [ ! -d "$SRC" ]; then
    mv "$BACKUP" "$SRC"
    echo "restored: $SRC"
  fi
  [ -d "$SRC" ] || echo "RESTORE FAILED — $SRC 가 없다. $BACKUP 를 손으로 되돌려라"
}
trap restore EXIT INT TERM

test -d /Volumes/DamwhaDiskFull || { echo "볼륨이 없다"; exit 1; }
test -d "$SRC" || { echo "$SRC 가 없다"; exit 1; }
test -e "$BACKUP" && { echo "$BACKUP 가 이미 있다 — 앞 회차가 안 끝났다"; exit 1; }

ditto "$SRC" /Volumes/DamwhaDiskFull/storage
mv "$SRC" "$BACKUP"
ln -s /Volumes/DamwhaDiskFull/storage "$SRC"
echo "링크 걸었다. 지금 앱을 켜서 기동이 거부되는지 본 뒤 이 창에서 Enter를 눌러라."
read -r _
SH
bash /tmp/diskfull-candidate2.sh
```

앱을 켜고 기동이 거부되는지 본다(`.damwha-cluster` 마커 페어링). 거부되면 **후보 2도 탈락**이다. 스크립트가 끝나거나 죽으면 `trap`이 링크를 지우고 원본을 되돌린다.

- [ ] **Step 3b: 원본이 제자리에 있는지 눈으로 확인한다**

```bash
UD="$HOME/Library/Application Support/Damwha"
ls -ld "$UD/data/storage"; ls -d "$UD/data/storage.probe-backup" 2>/dev/null || echo "backup 없음 (정상)"
```

기대: `data/storage`가 **디렉터리**(`d`로 시작, `l` 아님)이고 `storage.probe-backup`은 없다. 아니면 다음 Step으로 넘어가지 않는다.

- [ ] **Step 4: 결과 문서를 만들고 §1에 판정을 적는다**

```bash
cat > docs/superpowers/reports/2026-09-19-electron-phase-5-operational-hardening-results.md <<'EOF'
# Electron Phase 5 — 운영 안정화 실행 결과

스펙: [2026-09-19-electron-phase-5-operational-hardening-design.md](../specs/2026-09-19-electron-phase-5-operational-hardening-design.md)
계획: [2026-09-19-electron-phase-5-operational-hardening.md](../plans/2026-09-19-electron-phase-5-operational-hardening.md)

## 1. 검증 준비 — 디스크 부족 주입 방법 (Task 1)

판정: <후보 1 성립 | 후보 2 성립 | 둘 다 불가 → P5-C6 미판정>

재현 명령과 관찰한 것:

<여기에 실제 명령과 출력>
EOF
```

- [ ] **Step 5: 마운트를 정리한다**

```bash
hdiutil detach /Volumes/DamwhaDiskFull
rm -f /tmp/damwha-diskfull.sparseimage
```

- [ ] **Step 6: 커밋**

```bash
git add docs/superpowers/reports/2026-09-19-electron-phase-5-operational-hardening-results.md
git commit -m "docs(phase5): 디스크 부족 주입 방법을 실증하고 결과 문서를 연다"
```

**Verify:** 결과 문서 §1에 판정 한 줄과 실제 명령이 있다. `/Volumes/DamwhaDiskFull`이 남아 있지 않다. `~/Library/Application Support/Damwha/data/storage`가 심볼릭 링크가 아닌 원래 디렉터리다.

**Review:** 후보 2를 시도했다면 `data/storage`가 제자리로 돌아왔는지 `ls -la`로 확인했는가. 원본을 **복사**가 아니라 **이동**했으므로 되돌리지 않으면 데이터가 볼륨과 함께 사라진다.

---

## Task 2: `reclaimOrphaned` — 비-live job 되돌리기

**Files:**
- Create: `be/src/jobs/worker-identity.ts`
- Create: `be/test/reclaim.spec.ts`
- Modify: `be/src/config/env.ts` (EnvSchema에 키 하나)
- Modify: `be/src/jobs/jobs.repository.ts` (메서드 하나 추가)

**Interfaces:**
- Consumes: `startTestDb()`, `StartedTestDb` — `be/test/db.ts`
- Produces:
  - `APP_WORKER_PREFIX: 'desktop-'` — `be/src/jobs/worker-identity.ts`
  - `JobsRepository.reclaimOrphaned(exec: Queryable, workerId: string): Promise<{ requeued: number; failedLive: number }>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/reclaim.spec.ts`:

```ts
import { startTestDb, StartedTestDb } from './db';
import { JobsRepository } from '../src/jobs/jobs.repository';

describe('reclaimOrphaned', () => {
  let db: StartedTestDb;
  let repo: JobsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new JobsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function runningJob(opts: { lockedBy: string; attempts?: number }) {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`,
    );
    const meetingId = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
       VALUES('process_meeting',$1,'{}','running',$2, now(), $3, 5) RETURNING id`,
      [meetingId, opts.lockedBy, opts.attempts ?? 1],
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

  it('does not roll attempts back — a job that kills the app must still reach max_attempts', async () => {
    const { jobId } = await runningJob({ lockedBy: 'desktop-old', attempts: 2 });
    await repo.reclaimOrphaned(db.pool, 'desktop-new');
    const { rows } = await db.pool.query('SELECT attempts FROM job WHERE id=$1', [jobId]);
    expect(rows[0].attempts).toBe(2);
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
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- reclaim.spec.ts`
Expected: FAIL — `repo.reclaimOrphaned is not a function`

- [ ] **Step 3: 신분 상수를 만든다**

`be/src/jobs/worker-identity.ts`:

```ts
/**
 * 앱(Electron)이 띄운 worker의 신분 접두사. `desktop/src/config/config.ts`의 `RUN_WORKER_ID`가
 * `desktop-<uuid>`를 만들고, 앱은 그 값을 모든 자식 env(`WORKER_ID`)에 얹는다.
 *
 * 회수가 이 접두사로 경계를 긋는 이유: 터미널 `pnpm worker`(`worker-1`)와 웹 배포판의 job을
 * 앱이 뺏지 않기 위해서다 (Phase 2의 "외부 서비스와 앱 소유를 구분한다").
 */
export const APP_WORKER_PREFIX = 'desktop-';

/** 이 신분이 앱이 띄운 worker의 것인가. */
export function isAppWorkerId(workerId: string): boolean {
  return workerId.startsWith(APP_WORKER_PREFIX);
}
```

- [ ] **Step 4: `WORKER_ID`를 env 스키마에 더한다**

`be/src/config/env.ts`의 `EnvSchema` 안, `REAPER_STALE_MINUTES` 줄 다음에:

```ts
  // 앱(Electron)이 자식 env에 얹는 이번 실행의 worker 신분. 기본값을 두지 않는다 —
  // **없음이 곧 "앱이 띄운 API가 아니다"**라는 신호이고, 그때 기동 회수는 돌지 않는다.
  WORKER_ID: z.string().optional(),
```

- [ ] **Step 5: `reclaimOrphaned`를 구현한다**

`be/src/jobs/jobs.repository.ts`의 `reapStale` **앞**에 추가하고, 파일 머리에 `import { APP_WORKER_PREFIX } from './worker-identity';`를 더한다.

```ts
  /**
   * 앞 실행이 남긴 `running` job을 되돌린다. 기동 시 1회만 부른다 (ReaperService).
   *
   * `attempts`는 **되돌리지 않는다.** claim이 +1 하고 여기서 -1 하면 앱을 죽이는 job이
   * `attempts >= max_attempts` 분기에 영영 닿지 못한다 — 무한 재시도가 된다.
   * 정상 종료의 attempts 복원은 worker의 `requeue_for_shutdown`이 따로 한다.
   */
  async reclaimOrphaned(
    exec: Queryable,
    workerId: string,
  ): Promise<{ requeued: number; failedLive: number }> {
    const { rows } = await exec.query<{ requeued: string }>(
      `UPDATE job
          SET status='queued',
              locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
        WHERE status='running'
          AND locked_by LIKE $1 || '%'
          AND locked_by <> $2
          AND type <> 'live_session'
        RETURNING id`,
      [APP_WORKER_PREFIX, workerId],
    );
    return { requeued: rows.length, failedLive: 0 };
  }
```

- [ ] **Step 6: 테스트가 통과하는지 본다**

Run: `pnpm be test -- reclaim.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: 커밋**

```bash
git add be/src/jobs/worker-identity.ts be/src/jobs/jobs.repository.ts be/src/config/env.ts be/test/reclaim.spec.ts
git commit -m "feat(be): 앞 실행이 남긴 running job을 기동 시 되돌린다"
```

**Verify:** `pnpm be test -- reclaim.spec.ts` 4건 통과. `pnpm be lint` 통과.

**Review:** SQL이 `type <> 'live_session'`을 빠뜨리지 않았는가. `attempts`를 건드리는 절이 없는가(있으면 스펙 §4.1 위반). `locked_by LIKE $1 || '%'`가 상수를 파라미터로 받는가 — 문자열 보간이면 거부한다.

---

## Task 3: `reclaimOrphaned` — live_session 닫기

**Files:**
- Modify: `be/src/jobs/jobs.repository.ts` (`reclaimOrphaned`에 두 번째 UPDATE)
- Modify: `be/test/reclaim.spec.ts` (케이스 추가)

**Interfaces:**
- Consumes: Task 2의 `reclaimOrphaned` 시그니처
- Produces: 같은 메서드가 `failedLive`를 실제 값으로 채운다. live job의 `error.code = 'app_restarted'`.

- [ ] **Step 1: 실패하는 테스트를 더한다**

`be/test/reclaim.spec.ts`의 `describe` 안에 추가:

```ts
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
    const { rows } = await db.pool.query('SELECT status, error FROM job WHERE id=$1', [jobId]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error.code).toBe('app_restarted');
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- reclaim.spec.ts`
Expected: FAIL — `expect(received).toBe(1)` / received `0`

- [ ] **Step 3: live 분기를 구현한다**

`reclaimOrphaned`의 본문을 두 UPDATE를 한 문장으로 묶은 CTE로 바꾼다.

```ts
    const { rows } = await exec.query<{ kind: string }>(
      `WITH requeued AS (
         UPDATE job
            SET status='queued',
                locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
          WHERE status='running'
            AND locked_by LIKE $1 || '%'
            AND locked_by <> $2
            AND type <> 'live_session'
          RETURNING id
       ),
       -- 끊긴 라이브는 재queue하지 않는다 (기존 reaper와 같은 규칙). job만 닫는다 —
       -- 회의·확정·봉인 경계·파일은 건드리지 않고, 봉인과 마무리는 LiveOrphanService가
       -- 한다(live-orphan.service.ts). 이 회수가 하는 일은 그 경로를 30분 reaper 대신
       -- 즉시 여는 것뿐이다.
       failed_live AS (
         UPDATE job j
            SET status='failed', updated_at=now(),
                error = jsonb_build_object(
                  'code','app_restarted',
                  'message','the app restarted while this live session was running',
                  'stage', j.stage)
          WHERE j.status='running'
            AND j.locked_by LIKE $1 || '%'
            AND j.locked_by <> $2
            AND j.type='live_session'
          RETURNING id
       )
       SELECT 'requeued' AS kind FROM requeued
       UNION ALL
       SELECT 'failed_live' AS kind FROM failed_live`,
      [APP_WORKER_PREFIX, workerId],
    );
    return {
      requeued: rows.filter((r) => r.kind === 'requeued').length,
      failedLive: rows.filter((r) => r.kind === 'failed_live').length,
    };
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- reclaim.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 기존 live 스위트가 깨지지 않았는지 본다**

Run: `pnpm be test -- live-orphan.e2e-spec.ts live-crash.e2e-spec.ts`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add be/src/jobs/jobs.repository.ts be/test/reclaim.spec.ts
git commit -m "feat(be): 앞 실행의 라이브 세션을 닫아 봉인 경로를 즉시 연다"
```

**Verify:** `pnpm be test -- reclaim.spec.ts live-orphan.e2e-spec.ts live-crash.e2e-spec.ts` 전부 통과.

**Review:** live 분기가 `meeting`·`committed_bytes`·`sealed_bytes`·`capture_error`를 건드리지 않는가. 두 UPDATE가 **한 문장**인가 — 나뉘면 사이에 claim이 끼어 같은 행이 두 번 처리될 수 있다.

---

## Task 4: 기동 시 1회 회수 배선

**Files:**
- Modify: `be/src/jobs/reaper.service.ts`
- Create: `be/test/reclaim-bootstrap.spec.ts`
- Create: `be/test/reclaim-bootstrap.e2e-spec.ts` (P5-C2 — AppModule을 실제로 띄운다)

**Interfaces:**
- Consumes: `JobsRepository.reclaimOrphaned` (Task 2·3), `isAppWorkerId` (Task 2), `loadEnv()` — `be/src/config/env.ts`
- Produces: `ReaperService implements OnApplicationBootstrap`; `onApplicationBootstrap()`이 `WORKER_ID`가 있을 때만 회수를 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/reclaim-bootstrap.spec.ts`:

```ts
import { ReaperService } from '../src/jobs/reaper.service';

describe('ReaperService.onApplicationBootstrap', () => {
  const pool = {} as never;
  const db = { pool } as never;
  const original = process.env.WORKER_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.WORKER_ID;
    else process.env.WORKER_ID = original;
  });

  it('reclaims with this run’s worker id when the app launched the API', async () => {
    process.env.WORKER_ID = 'desktop-abc';
    const jobs = { reclaimOrphaned: jest.fn().mockResolvedValue({ requeued: 2, failedLive: 1 }) };
    const svc = new ReaperService(db, jobs as never);
    await svc.onApplicationBootstrap();
    expect(jobs.reclaimOrphaned).toHaveBeenCalledWith(pool, 'desktop-abc');
  });

  it('does nothing when WORKER_ID is absent (web deployment)', async () => {
    delete process.env.WORKER_ID;
    const jobs = { reclaimOrphaned: jest.fn() };
    const svc = new ReaperService(db, jobs as never);
    await svc.onApplicationBootstrap();
    expect(jobs.reclaimOrphaned).not.toHaveBeenCalled();
  });

  it('does nothing when WORKER_ID is not an app worker id', async () => {
    // 경계를 한 군데(`isAppWorkerId`)에서만 정한다. 터미널 worker의 신분으로 뜬 API가
    // 앱이 남긴 desktop-* 행을 건드리지 않는다.
    process.env.WORKER_ID = 'worker-1';
    const jobs = { reclaimOrphaned: jest.fn() };
    const svc = new ReaperService(db, jobs as never);
    await svc.onApplicationBootstrap();
    expect(jobs.reclaimOrphaned).not.toHaveBeenCalled();
  });

  it('does not stop startup when the reclaim query fails', async () => {
    process.env.WORKER_ID = 'desktop-abc';
    const jobs = { reclaimOrphaned: jest.fn().mockRejectedValue(new Error('boom')) };
    const svc = new ReaperService(db, jobs as never);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
```

`loadEnv()`가 `DATABASE_URL`을 필수로 요구하면 테스트 머리에서 `process.env.DATABASE_URL ??= 'postgres://x/y'`를 잡아 준다. 실패 메시지를 보고 필요할 때만 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- reclaim-bootstrap.spec.ts`
Expected: FAIL — `svc.onApplicationBootstrap is not a function`

- [ ] **Step 3: 구현한다**

`be/src/jobs/reaper.service.ts`:

```ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from './jobs.repository';
import { isAppWorkerId } from './worker-identity';
import { loadEnv } from '../config/env';

@Injectable()
export class ReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReaperService.name);
  constructor(private readonly db: DatabaseService, private readonly jobs: JobsRepository) {}

  /**
   * 앞 실행이 남긴 job 회수 — 기동 시 1회. 크론 `reap()`과 역할이 갈린다:
   * 이쪽은 "앞 실행이 남긴 것", 저쪽은 "이번 실행 중에 죽은 것"이다.
   *
   * 실패해도 기동을 막지 않는다. 회수는 복구 가속이지 기동 조건이 아니며,
   * 실패하면 30분 reaper가 같은 일을 한다.
   */
  async onApplicationBootstrap(): Promise<void> {
    const workerId = loadEnv().WORKER_ID;
    // 값이 있어도 **앱이 띄운 신분일 때만** 돈다. 회수 SQL도 `desktop-` 행만 고르지만,
    // 경계를 한 군데서만 정해야 나중에 접두사가 바뀔 때 두 곳이 갈라지지 않는다.
    if (workerId === undefined || !isAppWorkerId(workerId)) return;
    try {
      const res = await this.jobs.reclaimOrphaned(this.db.pool, workerId);
      if (res.requeued || res.failedLive) {
        this.logger.warn(`reclaim: requeued=${res.requeued} failedLive=${res.failedLive}`);
      }
    } catch (e) {
      this.logger.error(`reclaim failed, leaving it to the stale reaper: ${String(e)}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reap() {
    const res = await this.jobs.reapStale(this.db.pool, loadEnv().REAPER_STALE_MINUTES);
    if (res.requeued || res.failed) {
      this.logger.warn(`reaper: requeued=${res.requeued} failed=${res.failed}`);
    }
  }
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- reclaim-bootstrap.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: API 기동이 실제 DB 행에 하는 일을 고정한다 (P5-C2)**

`be/test/reclaim-bootstrap.e2e-spec.ts` — 목이 아니라 **AppModule을 실제로 띄워** 행을 본다. `app.init()`이 `onApplicationBootstrap`을 부른다.

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('reclaim on API bootstrap', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  let ids: { orphan: string; mine: string; external: string };

  beforeAll(async () => {
    db = await startTestDb();
    const mk = async (lockedBy: string) => {
      const m = await db.pool.query(
        `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
      const j = await db.pool.query(
        `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at, attempts, max_attempts)
         VALUES('process_meeting',$1,'{}','running',$2, now(), 1, 5) RETURNING id`,
        [m.rows[0].id, lockedBy]);
      return j.rows[0].id as string;
    };
    ids = { orphan: await mk('desktop-old'), mine: await mk('desktop-new'), external: await mk('worker-1') };

    process.env.WORKER_ID = 'desktop-new';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { delete process.env.WORKER_ID; await app?.close(); await db?.stop(); });

  it('requeues the previous run’s job, leaves this run’s and the external one', async () => {
    const { rows } = await db.pool.query(
      'SELECT id, status, locked_by FROM job WHERE id = ANY($1)',
      [[ids.orphan, ids.mine, ids.external]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[ids.orphan]).toMatchObject({ status: 'queued', locked_by: null });
    expect(by[ids.mine]).toMatchObject({ status: 'running', locked_by: 'desktop-new' });
    expect(by[ids.external]).toMatchObject({ status: 'running', locked_by: 'worker-1' });
  });
});
```

Run: `pnpm be test -- reclaim-bootstrap.e2e-spec.ts`
Expected: PASS

- [ ] **Step 6: 앱 전체 스위트로 회귀를 본다**

Run: `pnpm be test`
Expected: PASS

- [ ] **Step 7: 커밋**

```bash
git add be/src/jobs/reaper.service.ts be/test/reclaim-bootstrap.spec.ts be/test/reclaim-bootstrap.e2e-spec.ts
git commit -m "feat(be): 기동 시 한 번 앞 실행의 job을 회수한다"
```

**Verify:** `pnpm be test` 전체 통과.

**Review:** 회수 실패가 예외로 새어 나가 기동을 막지 않는가. `WORKER_ID` 없는 경로에서 SQL이 **발행되지 않는가**(호출 0회를 단언해야 한다 — 결과가 0이라는 단언으로 대체하지 않는다).

---

## Task 5: 재시도 정책 — 백오프 30초 기준, `max_attempts` 기본값 5

**Files:**
- Create: `be/src/database/migrations/025_job_retry_policy.sql`
- Modify: `be/worker/damwha_worker/db/queue.py` (`requeue`의 백오프 식)
- Modify: `be/src/jobs/jobs.repository.ts:12` 주석의 숫자
- Modify: `be/test/jobs.repository.spec.ts:121-127` — `expect(def.max_attempts).toBe(3)`이 기본값을 명시적으로 기대한다. **이것을 고치지 않으면 `pnpm be test`가 실패한다.** `reaper.spec.ts`처럼 행에 `max_attempts`를 직접 넣는 테스트는 기존 행 동작이라 그대로 둔다
- Modify: `be/worker/tests/test_db_lifecycle.py` (백오프 테스트 추가)
- Create: `be/test/retry-policy.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `job.max_attempts` 컬럼 기본값 5. worker `requeue`의 `next_attempt_at`이 `least(30 * power(attempts-1 제곱), 900)`초 뒤.

- [ ] **Step 1: 실패하는 BE 테스트를 쓴다**

`be/test/retry-policy.spec.ts`:

```ts
import { startTestDb, StartedTestDb } from './db';

describe('job retry policy', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  it('defaults max_attempts to 5 for newly enqueued jobs', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','uploaded') RETURNING id`);
    const { rows } = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload) VALUES('process_meeting',$1,'{}')
       RETURNING max_attempts`, [m.rows[0].id]);
    expect(rows[0].max_attempts).toBe(5);
  });

  it('keeps an explicit max_attempts — live sessions stay at 1', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('live','recording') RETURNING id`);
    const { rows } = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, max_attempts)
       VALUES('live_session',$1,'{}',1) RETURNING max_attempts`, [m.rows[0].id]);
    expect(rows[0].max_attempts).toBe(1);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- retry-policy.spec.ts`
Expected: FAIL — `expect(received).toBe(5)` / received `3`

- [ ] **Step 3: 마이그레이션을 쓴다**

`be/src/database/migrations/025_job_retry_policy.sql`:

```sql
-- 재시도 상한을 3에서 5로. 백오프가 30초 기준으로 길어졌으므로(worker db/queue.py의 requeue)
-- 3회는 90초 만에 소진돼 그보다 긴 네트워크 끊김이 job을 영구 실패로 만든다.
-- 시도 시각은 claim 직후 실패 기준으로 0 · 30s · 90s · 210s · 450s다.
--
-- **기존 행은 고치지 않는다.** 이미 max_attempts=3으로 적힌 job은 계속 3회에서 실패하고
-- reaper도 그 저장된 값을 본다. 새 기본값은 이 마이그레이션 이후 enqueue되는 job에만 붙는다.
-- live_session은 live.service.ts가 maxAttempts=1을 명시하므로 영향이 없다.
ALTER TABLE job ALTER COLUMN max_attempts SET DEFAULT 5;
```

- [ ] **Step 4: BE 테스트가 통과하는지 본다**

Run: `pnpm be test -- retry-policy.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 실패하는 worker 테스트를 쓴다**

`be/worker/tests/test_db_lifecycle.py` 끝에 추가:

```python
def test_requeue_backs_off_thirty_seconds_on_the_first_retry(conn):
    mid, jid = _meeting_with_running_job(conn, worker_id="w")
    assert db.requeue(conn, jid, "w") == 1
    row = conn.execute(
        "SELECT extract(epoch from (next_attempt_at - now())) AS secs FROM job WHERE id=%s",
        (jid,),
    ).fetchone()
    # attempts=1 → 30 * 2^0 = 30초. 앞뒤 1초는 실행 시간이다.
    assert 29 <= row["secs"] <= 31


def test_requeue_backoff_is_capped_at_fifteen_minutes(conn):
    mid, jid = _meeting_with_running_job(conn, worker_id="w")
    conn.execute("UPDATE job SET attempts=20 WHERE id=%s", (jid,))
    assert db.requeue(conn, jid, "w") == 1
    row = conn.execute(
        "SELECT extract(epoch from (next_attempt_at - now())) AS secs FROM job WHERE id=%s",
        (jid,),
    ).fetchone()
    assert 899 <= row["secs"] <= 901
```

`_meeting_with_running_job`이 그 파일에 없으면, 같은 파일의 기존 픽스처(예: `test_mark_processing_guarded_by_meeting`이 쓰는 준비 코드)를 그대로 본떠 위 두 테스트 **앞**에 헬퍼로 뽑아 둔다. 새 헬퍼는 `(meeting_id, job_id)`를 돌려주고 job은 `status='running'`, `locked_by=worker_id`, `attempts=1`이어야 한다.

- [ ] **Step 6: 실패를 확인한다**

Run: `pnpm worker:test -- -k requeue_backs_off`
Expected: FAIL — 실제 값 1초

- [ ] **Step 7: 백오프를 고친다**

`be/worker/damwha_worker/db/queue.py`의 `requeue` 안, `next_attempt_at` 식을 바꾼다.

```python
               next_attempt_at=now() + least(30 * power(2, attempts - 1), 900) * interval '1 second',
```

바로 위에 주석을 남긴다.

```python
    # 30초 기준·15분 상한. 1·2초였을 때는 세 번이 3초에 다 타서 3분짜리 네트워크 끊김이
    # job을 영구 실패로 만들었다 (Phase 4 결과 §12.6-12). max_attempts 기본값 5(025)와 함께
    # 시도 시각이 0 · 30s · 90s · 210s · 450s가 된다.
```

- [ ] **Step 8: worker 테스트가 통과하는지 본다**

Run: `pnpm worker:test -- -k "requeue"`
Expected: PASS

- [ ] **Step 9: 기본값 3을 기대하던 기존 테스트와 주석을 맞춘다**

`be/test/jobs.repository.spec.ts`의 `enqueue honors maxAttempts and leaves the column default otherwise`에서:

```ts
    expect(def.max_attempts).toBe(5);
```

`be/src/jobs/jobs.repository.ts:12`의 `// maxAttempts를 안 주면 컬럼 DEFAULT(3)를 그대로 쓴다` 에서 `(3)`을 `(5)`로.

- [ ] **Step 10: 두 스위트를 함께 돌린다**

Run: `pnpm be test && pnpm worker:test`
Expected: PASS

- [ ] **Step 11: 커밋**

```bash
git add be/src/database/migrations/025_job_retry_policy.sql be/worker/damwha_worker/db/queue.py \
        be/worker/tests/test_db_lifecycle.py be/test/retry-policy.spec.ts be/test/jobs.repository.spec.ts \
        be/src/jobs/jobs.repository.ts
git commit -m "feat: 재시도가 3분보다 긴 끊김을 넘기게 백오프와 상한을 올린다"
```

**Verify:** `pnpm be test && pnpm worker:test` 통과. 마이그레이션이 025 하나만 새로 생겼다.

**Review:** 마이그레이션이 기존 행의 `max_attempts`를 `UPDATE`하지 않는가(하면 스펙 §5.2 위반). 백오프 상한 900이 reaper의 30분보다 **작은가** — 크면 job이 백오프 대기 중에 stale로 걷힌다.

---

## Task 6: `mark_processing` 소유권 가드

**Files:**
- Modify: `be/worker/damwha_worker/db/queue.py` (`mark_processing` 시그니처·SQL)
- Modify: `be/worker/damwha_worker/pipeline/process_meeting.py:66` (호출부)
- Modify: `be/worker/tests/test_db_lifecycle.py` (케이스 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `db.mark_processing(conn, meeting_id, job_id, processing_version, worker_id) -> int` — **인자가 하나 늘어난다.**
- 프로덕션 호출부는 `process_meeting.py:66` 하나이고, 그 함수(`run_process_meeting`)는 **이미 `worker_id`를 키워드 인자로 받는다**(`process_meeting.py:41`). `jobs.py`가 `ctx.worker_id`로 넘기므로 상위 시그니처는 바뀌지 않는다.
- 테스트 호출부는 `be/worker/tests/test_db_lifecycle.py`의 **네 곳**: L46, L47, L303, L315. 하나라도 빠지면 pytest 전체가 `TypeError`로 죽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_db_lifecycle.py`에 추가:

```python
def test_mark_processing_refuses_a_worker_that_no_longer_owns_the_job(conn):
    # 회수(기동 시) → 새 worker의 재claim → **뒤늦게 도착한 이전 worker**의 mark_processing.
    # status='running'만 보면 이 호출이 통과해 자기 것이 아닌 job의 상태를 옮긴다.
    mid, jid = _meeting_with_running_job(conn, worker_id="desktop-old")
    conn.execute(
        "UPDATE job SET locked_by='desktop-new' WHERE id=%s", (jid,)
    )
    assert db.mark_processing(conn, mid, jid, 1, "desktop-old") == 0
    row = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] != "processing"


def test_mark_processing_accepts_the_owning_worker(conn):
    mid, jid = _meeting_with_running_job(conn, worker_id="desktop-new")
    assert db.mark_processing(conn, mid, jid, 1, "desktop-new") == 1
```

두 테스트는 Task 5에서 만든 `_meeting_with_running_job` 헬퍼를 쓴다. 그 헬퍼는 회의를 `uploaded`, `processing_version=1`, `current_job_id=job`으로 만들어야 한다 — 아니면 여기 단언이 이유 없이 0을 받는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- -k mark_processing_refuses_a_worker`
Expected: FAIL — `TypeError: mark_processing() takes 4 positional arguments but 5 were given`

- [ ] **Step 3: 가드를 더한다**

`be/worker/damwha_worker/db/queue.py`:

```python
def mark_processing(
    conn, meeting_id: str, job_id: str, processing_version: int, worker_id: str
) -> int:
```

EXISTS 절을 바꾼다.

```python
          AND EXISTS (SELECT 1 FROM job WHERE id=%s AND status='running' AND locked_by=%s)
```

파라미터는 `(meeting_id, job_id, processing_version, job_id, worker_id)`.

기존 독스트링의 마지막 문단("worker_id 대신 job.status 를 보는 이유는…")을 **고쳐 쓴다**:

```
    소유권 가드가 늦게 붙었다. status='running'만 보던 동안, 기동 회수가 앞 실행의 job을
    되돌리고 새 worker가 같은 job을 재claim한 뒤 **이전 worker의 늦은 호출**이 도착하면
    그대로 통과했다 — 자기 것이 아닌 job의 상태 전이다. set_stage·heartbeat와 같은 가드를
    쓴다. 0행이면 이 워커는 더 쓸 것이 없다.
```

- [ ] **Step 4: 호출부에 `worker_id`를 넘긴다**

`be/worker/damwha_worker/pipeline/process_meeting.py:66`:

```python
    if db.mark_processing(conn, meeting_id, job_id, payload.processing_version, worker_id) == 0:
```

`worker_id`는 `run_process_meeting`의 키워드 인자로 **이미 스코프에 있다**(같은 파일 L41). 새 전역·기본값·상위 시그니처 변경은 없다.

- [ ] **Step 5: 통과를 확인한다**

먼저 기존 네 호출(L46·L47·L303·L315)에 신분을 더한다 — 그 테스트들이 만든 job의 `locked_by` 값과 같아야 한다. 픽스처가 `locked_by`를 안 넣고 있으면 넣는다.

Run: `pnpm worker:test`
Expected: PASS — 새 둘과 기존 넷이 모두 통과한다.

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/db/queue.py be/worker/damwha_worker/pipeline/process_meeting.py be/worker/tests/test_db_lifecycle.py
git commit -m "fix(worker): 소유권을 잃은 워커가 회의를 processing으로 되돌리지 못하게 막는다"
```

**Verify:** `pnpm worker:test` 전체 통과.

**Review:** `worker_id`가 새 전역이나 기본 인자(`worker_id=None`)로 들어오지 않았는가 — 기본값을 주면 가드가 조용히 꺼진다. `grep -n "mark_processing(" be/worker/tests be/worker/damwha_worker`로 남은 4인자 호출이 0인지 확인했는가.

---

## Task 7: 재시도 상태의 관측 계약

**Files:**
- Modify: `be/src/meetings/meetings.repository.ts:123-156` (`findStatus`)
- Create: `be/test/status-retry.spec.ts`
- Modify: `fe/src/features/meeting/api/types.ts:186-193` (`MeetingStatusResponse`)
- Modify: `fe/src/pages/meeting.tsx:122-124` (`stageLabel` 분기)
- Modify: `fe/src/pages/meeting.test.tsx` (케이스 추가)

**Interfaces:**
- Consumes: 없음
- Produces:
  - 와이어: `GET /meetings/:id/status`가 `retry: { attempts: number; max_attempts: number; next_attempt_at: string | null } | null`을 더 준다. 기존 필드는 그대로다.
  - FE 타입: `export type RetryStatus = { attempts: number; max_attempts: number; next_attempt_at: string | null };`

- [ ] **Step 1: 실패하는 BE 테스트를 쓴다**

`be/test/status-retry.spec.ts`:

```ts
import { startTestDb, StartedTestDb } from './db';
import { MeetingsRepository } from '../src/meetings/meetings.repository';

describe('findStatus retry', () => {
  let db: StartedTestDb;
  let repo: MeetingsRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new MeetingsRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function queuedRetry() {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','processing') RETURNING id`);
    const mid = m.rows[0].id as string;
    const j = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, status, attempts, max_attempts, next_attempt_at)
       VALUES('process_meeting',$1,'{}','queued',2,5, now() + interval '90 seconds') RETURNING id`,
      [mid]);
    await db.pool.query(`UPDATE meeting SET current_job_id=$1 WHERE id=$2`, [j.rows[0].id, mid]);
    return mid;
  }

  it('reports attempts, max_attempts and the next attempt time', async () => {
    const mid = await queuedRetry();
    const row = await repo.findStatus(db.pool, mid);
    expect(row.retry).toMatchObject({ attempts: 2, max_attempts: 5 });
    expect(row.retry.next_attempt_at).not.toBeNull();
  });

  it('reports retry as null when the meeting has no current job', async () => {
    const m = await db.pool.query(
      `INSERT INTO meeting(audio_key, status) VALUES('k','uploaded') RETURNING id`);
    const row = await repo.findStatus(db.pool, m.rows[0].id);
    expect(row.retry).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- status-retry.spec.ts`
Expected: FAIL — `retry` undefined

- [ ] **Step 3: `findStatus`에 `retry`를 더한다**

`be/src/meetings/meetings.repository.ts`의 SELECT 목록에서 `m.capture_error,` 다음에 넣는다. 형제인 `lens_extraction`·`search_index`와 같은 모양이다.

```sql
              CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
                'attempts', j.attempts,
                'max_attempts', j.max_attempts,
                'next_attempt_at', j.next_attempt_at
              ) END AS retry,
```

`j`는 이미 `LEFT JOIN job j ON j.id = m.current_job_id`로 들어와 있다 — 새 조인을 더하지 않는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- status-retry.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 실패하는 FE 테스트를 쓴다**

`fe/src/pages/meeting.test.tsx`에 케이스를 더한다. 기존 처리 중 배너 테스트가 쓰는 픽스처 빌더를 그대로 쓰고, status만 바꾼다.

```tsx
test("재시도 대기 중이면 배너가 회차와 남은 시간을 말한다", async () => {
  const status: MeetingStatusResponse = {
    status: "processing",
    stage: null,
    progress: null,
    error: null,
    summary: null,
    search_index: null,
    retry: {
      attempts: 2,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() + 90_000).toISOString(),
    },
  };
  // 이 파일의 다른 테스트와 같은 방식으로 apiClient를 목킹해 이 status를 돌려준다.
  renderMeetingWithStatus(status);

  expect(await screen.findByText(/재시도 대기/)).toBeTruthy();
  expect(screen.getByText(/2\/5회차/)).toBeTruthy();
});

test("모델을 받는 중이면 재시도 문구 대신 다운로드 문구만 뜬다", async () => {
  // 같은 status에 model_readiness의 다운로드 중 항목을 함께 준다. 이 파일이 이미 쓰는
  // ModelReadiness 픽스처를 그대로 쓴다.
  renderMeetingWithStatusAndDownloading(status, [downloadingModelFixture]);

  expect(await screen.findByText(/모델을 받는 중/)).toBeTruthy();
  expect(screen.queryByText(/재시도 대기/)).toBeNull();
});
```

`renderMeetingWithStatus`가 그 파일에 없으면 새로 만들지 말고, 기존 "처리 중 뱃지" 테스트가 쓰는 렌더 절차를 그대로 복사해 이 테스트 안에 편다.

- [ ] **Step 6: 실패를 확인한다**

Run: `pnpm fe test -- meeting.test.tsx`
Expected: FAIL — "재시도 대기" 없음

- [ ] **Step 7: FE 타입과 문구를 고친다**

`fe/src/features/meeting/api/types.ts`:

```ts
/** 재시도 대기 상태. job이 없으면 null. */
export type RetryStatus = {
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
};
```

`MeetingStatusResponse`에 `retry: RetryStatus | null;`을 더한다.

`fe/src/pages/meeting.tsx`의 `stageLabel` 자리:

```tsx
  // 백오프가 30초·90초·210초·450초로 길어졌다 (Phase 5 스펙 §5). 그동안 "대기 중"만 쓰면
  // 정상 재시도와 worker 미기동·DB 장애가 한 얼굴이 된다.
  const retryAt = status?.retry?.next_attempt_at ?? null;
  const retryMs = retryAt === null ? null : new Date(retryAt).getTime() - Date.now();
  // 다운로드 문구가 이긴다. 그쪽은 stageLabel과 **독립된 span**이라(아래 downloading 분기),
  // 여기서 막지 않으면 "재시도 대기"와 "모델을 받는 중"이 같이 뜬다.
  const showRetry = downloading.length === 0 && retryMs !== null && retryMs > 0;
  const stageLabel = status?.stage
    ? (STAGE_LABELS[status.stage] ?? "처리 중")
    : showRetry
      ? `재시도 대기 · ${status!.retry!.attempts}/${status!.retry!.max_attempts}회차 · 약 ${Math.max(1, Math.round(retryMs! / 60000))}분 뒤`
      : "대기 중";
```

- [ ] **Step 8: 통과를 확인한다**

Run: `pnpm fe test -- meeting.test.tsx`
Expected: PASS

- [ ] **Step 9: 두 스위트를 돌린다**

Run: `pnpm be test && pnpm fe test`
Expected: PASS

- [ ] **Step 10: 커밋**

```bash
git add be/src/meetings/meetings.repository.ts be/test/status-retry.spec.ts \
        fe/src/features/meeting/api/types.ts fe/src/pages/meeting.tsx fe/src/pages/meeting.test.tsx
git commit -m "feat: 재시도 대기를 화면이 회차와 남은 시간으로 말한다"
```

**Verify:** `pnpm be test && pnpm fe test` 통과. `pnpm fe lint` 통과.

**Review:** 새 조인을 더하지 않고 기존 `j`를 썼는가. 모델 다운로드 중 문구(Phase 4의 `downloading` 분기)가 여전히 재시도 문구를 이기는가 — 그쪽이 더 구체적이다. `next_attempt_at`이 과거면 "대기 중"으로 떨어지는가.

---

## Task 8: worker 재시작이 이전 `--once` 자식을 거둔다

**배선 지점이 중요하다.** supervisor가 크래시하면 `watchForDeath`(`supervisor.ts:557`)가
`scheduleRestart`를 부르고, 그 타이머가 `background(spec)`를 부른다(`supervisor.ts:539-554`).
`restartOnce`(`supervisor.ts:686`)는 **사람이 버튼을 눌렀을 때만** 지난다. P5-C7이 재현하는 것은
크래시 경로이므로 **둘 다** 거쳐야 한다.

**Files:**
- Modify: `desktop/src/process/orphans.ts` (`ReapPlan.only`, `reapOwnOnceChildren`)
- Modify: `desktop/src/services/supervisor.ts` (`SupervisorHooks.reapOwnOnce`, 자동 재시작 타이머 + `restartOnce`)
- Modify: `desktop/src/config/config.ts` (`APP_WORKER_PREFIX` 상수를 export, `RUN_WORKER_ID`를 그 상수로 만든다)
- Modify: `desktop/src/main.ts` (hook 배선 — `readModelReadiness`를 넘기는 자리와 같은 곳)
- Modify: `desktop/tests/process/orphans.test.ts`
- Modify: `desktop/tests/services/supervisor.test.ts`
- Create: `desktop/tests/config/worker-id-shape.test.ts`

**Interfaces:**
- Consumes: `reapByKind(d: ReapDeps, plan: ReapPlan, signalled?: ReapEntry[])`, `classify`, `DamwhaProcess.once`, 테스트 헬퍼 `fakeKernel({alive, ps, runId, kill})`(`orphans.test.ts:317`), `ctx()`·`spec(id, over)`(`supervisor.test.ts:18`·`33`)
- Produces:
  - `ReapPlan.only?: (p: DamwhaProcess) => boolean`
  - `reapOwnOnceChildren(d: ReapDeps): Promise<{ reaped: number[] } | { failed: true }>`
  - `SupervisorHooks.reapOwnOnce?(): Promise<{ reaped: number[] } | { failed: true }>`
  - `APP_WORKER_PREFIX = "desktop-"` — `desktop/src/config/config.ts`

- [ ] **Step 1: orphans 쪽 실패하는 테스트를 쓴다**

`desktop/tests/process/orphans.test.ts`에 추가한다. 이 파일의 `fakeKernel`과 `PS`·`TREES`·`MINE`
상수를 그대로 쓴다 — 새 픽스처 형식을 만들지 않는다.

```ts
test("reapOwnOnceChildren는 이번 실행의 --once 자식만 내린다", async () => {
  const ps = [
    `  101 /b/python/bin/python3.12 -m damwha_worker --run-id=${MINE}`,
    `  102 /b/python/bin/python3.12 -m damwha_worker --run-id=${MINE} --once`,
    `  103 /b/python/bin/python3.12 -m damwha_worker --run-id=desktop-other --once`,
  ].join("\n");
  const k = fakeKernel({ alive: [101, 102, 103], ps: async () => ps });

  const out = await reapOwnOnceChildren(k.deps);

  expect(out).toEqual({ reaped: [102] });
  expect(k.alive.has(101)).toBe(true);
  expect(k.alive.has(103)).toBe(true);
});
```

`PS` 픽스처의 줄 모양(경로·인터프리터 이름)이 위와 다르면 **그 파일의 모양을 따른다.** 여기서
중요한 것은 세 줄의 구성(내 run-id supervisor / 내 run-id `--once` / 다른 run-id `--once`)이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm desktop test -- orphans`
Expected: FAIL — `reapOwnOnceChildren is not exported`

- [ ] **Step 3: `ReapPlan.only`를 더한다**

`desktop/src/process/orphans.ts`:

```ts
export interface ReapPlan {
  target: Exclude<ProcessKind, "external">;
  words: ReapWords;
  /**
   * 딱지가 맞아도 이 술어가 거짓이면 **건드리지 않는다**(untouchable). worker 재시작이
   * 이번 실행의 `--once` 자식만 거두기 위한 좁힘이다 — 같은 run-id의 supervisor 자신과
   * embed는 재시작 절차가 따로 다룬다.
   */
  only?(p: DamwhaProcess): boolean;
}
```

`reapByKind`의 분류 루프에서:

```ts
    if (kind === plan.target && (plan.only === undefined || plan.only(p))) {
      targets.push(p);
      continue;
    }
```

- [ ] **Step 4: `reapOwnOnceChildren`을 더한다**

`reapOrphans` 아래에:

```ts
const OWN_ONCE_PLAN: ReapPlan = {
  target: "mine",
  only: (p) => p.once,
  words: {
    prefix: "worker 재시작 — ",
    subject: "이번 실행의 --once 자식",
    unreadable: (rows) => [
      `이번 실행의 --once 자식인지 읽을 수 없는 줄이 있어 아무것도 내리지 않았어요 — ${rows
        .map((row) => `pid ${row.pid}: ${clipArgs(row.args)}`)
        .join(" / ")}`,
    ],
    bystander: () => null,
    sent: (entry, how) =>
      entry.root === null
        ? `앞 supervisor의 --once 자손을 내려요 (${how}) — pid ${entry.pid}`
        : `앞 supervisor의 --once 자식을 내려요 (${how}) — ${processLabel(entry.root)}`,
  },
};

/**
 * worker를 다시 띄우기 **전에** 이번 실행의 `--once` 자식을 거둔다 (Phase 5 스펙 §8).
 *
 * 크래시로 사라진 supervisor의 `--once` 자식은 아무도 추적하지 않는다 — `start_new_session=True`라
 * 부모가 먼저 사라지면 자손 SIGKILL이 훑을 트리가 없다(Phase 2 이월). run-id는 **이번 실행**이므로
 * 기동 정리(`reapOrphans`, 대상 `orphan`)는 이 프로세스를 보지 않는다.
 */
export async function reapOwnOnceChildren(d: ReapDeps): Promise<{ reaped: number[] } | { failed: true }> {
  const run = await reapByKind(d, OWN_ONCE_PLAN);
  return run.failed ? { failed: true } : { reaped: run.signalled.map((e) => e.pid) };
}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm desktop test -- orphans`
Expected: PASS — 기존 `reapOrphans`·`reapOwnedOnQuit` 테스트도 그대로 통과한다(`only`가 없으면 동작이 같다).

- [ ] **Step 6: 감독자 쪽 실패하는 테스트를 쓴다 — 크래시 경로가 먼저다**

`desktop/tests/services/supervisor.test.ts`에 추가한다. 이 파일의 `ctx()`·`spec()`을 쓰고,
재시작을 다루는 기존 테스트(`restart: { maxAttempts: 2, backoffMs: [5] }`를 쓰는 것들)가 핸들을
어떻게 흉내 내는지 그대로 따른다.

```ts
it("worker가 크래시로 재시작되면 다시 띄우기 전에 --once 자식을 거둔다", async () => {
  const order: string[] = [];
  let exit: ((code: number | null) => void) | null = null;
  const handle = {
    pid: 1234,
    onExit: (cb: (code: number | null) => void) => { exit = cb; },
    stderrTail: () => "",
  };
  const s = createSupervisor(
    [
      spec("worker", {
        restart: { maxAttempts: 2, backoffMs: [0] },
        launch: async () => { order.push("launch"); return { handle: handle as never, owned: true }; },
      }),
    ],
    ctx(),
    { reapOwnOnce: async () => { order.push("reap"); return { reaped: [102] }; } },
  );
  await s.start();
  exit!(1); // 크래시 — watchForDeath → scheduleRestart

  await vi.waitFor(() => expect(order).toEqual(["launch", "reap", "launch"]));
});

it("사람이 누른 재시작도 같은 회수를 지난다", async () => {
  const order: string[] = [];
  const s = createSupervisor(
    [spec("worker", { launch: async () => { order.push("launch"); return { handle: null, owned: true }; } })],
    ctx(),
    { reapOwnOnce: async () => { order.push("reap"); return { reaped: [] }; } },
  );
  await s.start();
  await s.restartService("worker");
  expect(order).toEqual(["launch", "reap", "launch"]);
});

it("스캔이 실패해도 재시작을 막지 않는다", async () => {
  const order: string[] = [];
  const s = createSupervisor(
    [spec("worker", { launch: async () => { order.push("launch"); return { handle: null, owned: true }; } })],
    ctx(),
    { reapOwnOnce: async () => { order.push("reap"); return { failed: true as const }; } },
  );
  await s.start();
  await s.restartService("worker");
  expect(order).toEqual(["launch", "reap", "launch"]);
});

it("worker가 아닌 서비스의 재시작은 회수를 부르지 않는다", async () => {
  const calls: string[] = [];
  const s = createSupervisor(
    [spec("embed")],
    ctx(),
    { reapOwnOnce: async () => { calls.push("reap"); return { reaped: [] }; } },
  );
  await s.start();
  await s.restartService("embed");
  expect(calls).toEqual([]);
});
```

핸들 모양(`onExit`·`stderrTail`)이 이 파일의 기존 가짜와 다르면 **기존 것을 쓴다.** 첫 테스트가
고정하려는 것은 `onExit → 예약된 재시작` 경로에서 회수가 `launch`보다 **먼저** 불린다는 것이다.

- [ ] **Step 7: 실패를 확인한다**

Run: `pnpm desktop test -- supervisor`
Expected: FAIL — `order`에 `"reap"`이 없다

- [ ] **Step 8: 감독자에 배선한다**

`SupervisorHooks`에 (`readModelReadiness` 옆):

```ts
  /**
   * worker를 다시 띄우기 전에 이번 실행의 `--once` 자식을 거둔다 (Phase 5 스펙 §8).
   * 배선은 main.ts가 한다 — 감독자는 `ps`에 닿는 방법을 몰라야 vitest에서 돈다
   * (`readModelReadiness`와 같은 이유).
   */
  reapOwnOnce?(): Promise<{ reaped: number[] } | { failed: true }>;
```

`createSupervisor` 안에, `scheduleRestart`보다 **위에**:

```ts
  /**
   * 자동 재시작(크래시)과 사람이 누른 재시작 둘 다 여기를 지난다. worker에만 돈다 —
   * `--once` 자식은 worker만 만든다. 스캔 실패·예외는 재시작을 막지 않는다.
   */
  async function reapOwnOnceBefore(id: ServiceId): Promise<void> {
    if (id !== "worker" || hooks.reapOwnOnce === undefined) return;
    try {
      const out = await hooks.reapOwnOnce();
      if ("failed" in out) log(`${id}: --once 자식 스캔에 실패했어요 — 재시작은 계속해요`);
      else if (out.reaped.length > 0) log(`${id}: 앞 실행의 --once 자식 ${out.reaped.length}개를 거뒀어요`);
    } catch (e) {
      log(`${id}: --once 자식 스캔이 던졌어요 — 재시작은 계속해요: ${reason(e)}`);
    }
  }
```

`scheduleRestart`의 타이머를 바꾼다 (`supervisor.ts:549-553`):

```ts
    rt.restartTimer = arm(delay, () => {
      rt.restartTimer = null;
      if (stopping) return;
      void reapOwnOnceBefore(spec.id).then(() => {
        // 스캔 동안 종료가 시작됐을 수 있다. 종료가 치운 것을 되살리지 않는다.
        if (stopping) return;
        background(spec);
      });
    });
```

`restartOnce`에서는 옛 자식을 내린 **뒤**, 새로 띄우는 `bring` 호출 **바로 앞**에 한 줄:

```ts
    await reapOwnOnceBefore(id);
```

`specStop`이 실패해 **다시 띄우지 않고 돌아가는 경로**보다 뒤에 둔다 — 띄우지 않을 것이면 거둘
이유도 없다.

- [ ] **Step 9: 통과를 확인한다**

Run: `pnpm desktop test -- supervisor`
Expected: PASS (4 tests)

- [ ] **Step 10: 접두사를 두 패키지가 같이 쓰는지 고정한다**

`desktop/src/config/config.ts`에서 상수를 꺼내고 `RUN_WORKER_ID`가 그것을 쓰게 한다.

```ts
/**
 * 앱이 띄운 worker의 신분 접두사. BE의 `be/src/jobs/worker-identity.ts`가 같은 문자열로
 * 기동 회수의 경계를 긋는다 — 한쪽만 바꾸면 회수가 조용히 아무것도 하지 않게 된다.
 */
export const APP_WORKER_PREFIX = "desktop-";

const RUN_WORKER_ID = `${APP_WORKER_PREFIX}${randomUUID()}`;
```

`desktop/tests/config/worker-id-shape.test.ts`:

```ts
import { expect, test } from "vitest";
import { APP_WORKER_PREFIX, childEnv } from "../../src/config/config";
import type { LaunchContext } from "../../src/services/types";

function ctx(): LaunchContext {
  return {
    repoRoot: "/r", userData: "/u", packaged: false, databaseMode: "embedded", env: {},
    bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "desktop-test", searchDirs: [], logFile: (id) => `/u/logs/${id}.log`,
    signal: new AbortController().signal,
  };
}

test("자식 env의 WORKER_ID는 BE의 회수가 아는 접두사를 쓴다", () => {
  // be/src/jobs/worker-identity.ts의 APP_WORKER_PREFIX와 같은 문자열이어야 한다.
  expect(APP_WORKER_PREFIX).toBe("desktop-");
  const env = childEnv(ctx(), {});
  expect(env.WORKER_ID.startsWith(APP_WORKER_PREFIX)).toBe(true);
});
```

`ctx()`는 `supervisor.test.ts:18`의 것과 같은 모양이다 — 그 파일에서 복사한다.

- [ ] **Step 11: main.ts에 hook을 배선한다**

`main.ts`가 감독자를 만들며 `readModelReadiness`를 넘기는 곳에 같이 넣는다. `runId`·`trees`·로그는
`reapBeforeStart`를 부를 때 이미 만들어 둔 것을 쓴다(`systemReapDeps`).

```ts
    reapOwnOnce: () => reapOwnOnceChildren(systemReapDeps({ runId, trees, log })),
```

이름이 그 자리에서 다르면 **그 자리의 이름을 쓴다** — 새 `ReapDeps`를 따로 만들지 않는다.

- [ ] **Step 12: 전부 돌린다**

Run: `pnpm desktop test && pnpm desktop lint`
Expected: PASS

- [ ] **Step 13: 커밋**

```bash
git add desktop/src/process/orphans.ts desktop/src/services/supervisor.ts \
        desktop/src/config/config.ts desktop/src/main.ts desktop/tests/
git commit -m "fix(desktop): worker 재시작이 앞 supervisor의 --once 자식을 거둔다"
```

**Verify:** `pnpm desktop test && pnpm desktop lint` 통과. 크래시 경로 테스트가 `["launch","reap","launch"]`를 본다.

**Review:** 회수가 **크래시 경로**(`scheduleRestart`의 타이머)에도 붙었는가 — `restartOnce`에만 붙이면 P5-C7이 재현하는 `kill -9` 회차에서 한 번도 돌지 않는다. `only`가 없는 기존 두 계획(`ORPHAN_PLAN`·`QUIT_PLAN`)의 동작이 그대로인가. `reapOwnOnceChildren`이 supervisor 자신(`once === false`)을 대상에 넣지 않는가. 스캔 실패가 재시작을 막지 않는가. `stopping`을 await 뒤에 다시 보는가.

---

## Task 9: 회수·claim·취소·재처리 경합 회귀 테스트 (P5-C11)

**Files:**
- Create: `be/test/reclaim-races.spec.ts`

**Interfaces:**
- Consumes: `JobsRepository.reclaimOrphaned`·`claim`·`cancel`·`JobsRepository.cancelledError`(정적), `MeetingsRepository.markCancelled`·`bumpVersionForReprocess`·`setCurrentJob`·`enqueue`, `pg`의 `Client`
- Produces: 없음 (회귀 고정만)

**실제 경로를 쓴다.** `locked_by`를 손으로 `UPDATE`해 claim을 흉내 내지 않는다 — 그러면 행 잠금
직렬화를 전혀 시험하지 않는다.

- [ ] **Step 1: 테스트를 쓴다**

`be/test/reclaim-races.spec.ts`:

```ts
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
```

`reclaimOrphaned`·`claim`이 `Queryable`을 받으므로 `pg.Client`를 그대로 넘길 수 있다. 타입이
맞지 않으면 `as never`로 덮지 말고 `Queryable`이 요구하는 모양을 확인한다.

- [ ] **Step 2: 돌린다**

Run: `pnpm be test -- reclaim-races.spec.ts`
Expected: PASS (4 tests) — Task 2·3이 옳게 구현됐으면 그대로 통과한다. 하나라도 실패하면
**구현이 틀린 것이지 테스트가 틀린 것이 아니다.**

- [ ] **Step 3: 커밋**

```bash
git add be/test/reclaim-races.spec.ts
git commit -m "test(be): 회수와 claim·취소·재처리의 경합을 고정한다"
```

**Verify:** `pnpm be test` 전체 통과. 두 연결을 쓰는 테스트가 커넥션을 반드시 닫는다(`finally`).

**Review:** claim을 흉내 내지 않고 **실제 `claim`**을 쓰는가. 취소·재처리도 실제 repository 메서드를
쓰는가. 경합 테스트가 두 결과(SKIP LOCKED / 잡음)를 모두 허용하되 **어느 쪽이든 정합**임을
단언하는가 — 한쪽만 허용하면 스케줄 운에 따라 깜빡인다.

---

## Task 10: 통합 검증과 결과 기록

**Files:**
- Modify: `docs/superpowers/reports/2026-09-19-electron-phase-5-operational-hardening-results.md`
- Modify: `desktop/CLAUDE.md` (회수 세 층을 운영 문서에 반영)
- Modify: `docs/electron-migration-roadmap.md` (Phase 5 상태·판정표)

**Interfaces:**
- Consumes: Task 1~9 전부
- Produces: P5-C1~C12 판정과 증거.

- [ ] **Step 1: 전체 스위트를 돌린다**

Run: `pnpm build && pnpm test && pnpm lint && pnpm worker:test`
Expected: 전부 PASS. 실패가 있으면 **여기서 멈추고 고친다.**

- [ ] **Step 2: packaged 앱을 새로 빌드한다**

```bash
rm -rf desktop/out/mac-arm64
pnpm desktop:build
```

`out/mac-arm64`를 **통째로** 지우는 이유: 파일만 지우면 Finder가 남긴 `.DS_Store` 때문에 `ENOTEMPTY`가 난다.

- [ ] **Step 3: P5-C1 — 분석 중 강제 종료**

업로드를 하나 걸고 `stage`가 붙은 것을 본 뒤:

```bash
pkill -9 -f "Damwha.app/Contents/MacOS/Damwha"
```

`<userData>`의 `SingletonLock`·`Cookies`·`Socket` 잔재를 지우고 앱을 다시 켠다. 재기동 직후와 1분 뒤 psql로:

```sql
SELECT id, status, locked_by, attempts FROM job ORDER BY id DESC LIMIT 5;
```

기대: 그 job이 `queued`(회수 직후) → `running`(새 worker), `attempts`는 죽기 전보다 **1 크다**. 최종적으로 회의가 `done`.

- [ ] **Step 4: P5-C4 — 3분 끊김**

```bash
rm -rf "$HOME/Library/Application Support/Damwha/models/hub/models--BAAI--bge-m3"
```

업로드를 걸고 다운로드가 시작되면 Wi-Fi를 3분 끊는다. 화면이 **"재시도 대기 · N/5회차"**를 말하는지 보고, 복구 후 같은 job이 `done`까지 가는지 본다. `attempts` ≤ 5.

- [ ] **Step 5: P5-C5 — 잠자기 10분**

처리 중에 `pmset sleepnow`, 10분 뒤 깨운다. 60초 안에 job이 (a) `running`이며 `stage` 전진, (b) `queued`, (c) `failed`+사유 중 하나로 정착하는지, 그리고 화면 문구와 `meeting.status`가 같은 말을 하는지 본다.

- [ ] **Step 6: P5-C6 — 디스크 부족**

Task 1이 성립시킨 절차로 돌린다. 둘 다 불가였으면 **미판정**으로 적고 이유를 남긴다. 전후로:

```sql
SELECT (SELECT count(*) FROM meeting) AS meetings, (SELECT count(*) FROM utterance) AS utterances;
```

와 `find "<userData>/data/storage" -type f | wc -l`을 비교한다.

- [ ] **Step 7: P5-C7 — supervisor 크래시**

```bash
/usr/bin/pgrep -f "damwha_worker.*--once" > /tmp/once-before.txt
/usr/bin/pgrep -f "python3.12 -m damwha_worker --run-id" | head -1 | xargs kill -9
sleep 30
/usr/bin/pgrep -f "damwha_worker.*--once" > /tmp/once-after.txt
diff /tmp/once-before.txt /tmp/once-after.txt
```

기대: `once-before`의 pid가 `once-after`에 하나도 없다. 새 `--once`가 떴다면 다른 pid다.

- [ ] **Step 8: P5-C8 — 처리 중 서비스 장애**

embed를 죽이고(`pkill -f damwha_worker.embed_service`), 상태 창이 사유를 말하고 60초 안에 `ok`로 돌아오는지 본다. postgres는 `SIGQUIT`으로 같은 것을 본다.

- [ ] **Step 9: P5-C9 — 녹음 중 강제 종료**

녹음 중 `pkill -9`. 재기동 뒤 2분 안에:

```sql
SELECT id, status, error->>'code' AS code, committed_bytes, sealed_bytes
FROM job WHERE type='live_session' ORDER BY id DESC LIMIT 1;
```

기대: `status='failed'`, `code='app_restarted'`, 2분 안에 `sealed_bytes`가 `committed_bytes`와 같아지고 회의가 마무리로 넘어간다. 오디오 파일이 남아 있고 길이 ≥ `committed_bytes`.

- [ ] **Step 10: P5-C10 — 정합성 질의 넷**

```sql
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='processing' AND j.status NOT IN ('running','queued');
SELECT count(*) FROM job WHERE status='running' AND locked_by IS NULL;
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='done' AND j.status <> 'done';
SELECT count(*) FROM job WHERE status='running' AND locked_by LIKE 'desktop-%'
   AND locked_by <> '<이번 실행의 WORKER_ID>';
```

넷 다 0이어야 한다. 마지막 질의의 신분은 상태 창이나 `supervisor.log`에서 읽는다.

- [ ] **Step 11: 결과 문서에 판정을 적는다**

각 기준마다 **명령·출력·판정**을 적는다. 미판정은 이유와 함께 미판정으로 남긴다 — "아마 될 것"이라고 쓰지 않는다.

- [ ] **Step 12: 운영 문서를 실제와 맞춘다**

`desktop/CLAUDE.md`에 회수 세 층(기동 회수 / 30분 reaper / supervisor 재시작 `--once` 스캔)과 재시도 시각(0·30s·90s·210s·450s)을 적는다. `docs/electron-migration-roadmap.md`의 Phase 5 절에 상태와 완료 기준 판정표를 더한다.

- [ ] **Step 13: 커밋**

```bash
git add docs/superpowers/reports/2026-09-19-electron-phase-5-operational-hardening-results.md \
        desktop/CLAUDE.md docs/electron-migration-roadmap.md
git commit -m "docs(phase5): 통합 검증 결과와 운영 문서를 실제와 맞춘다"
```

**Verify:** 결과 문서에 P5-C1~C12 전부에 판정이 있다(미판정도 판정이다). `pnpm build && pnpm test && pnpm lint && pnpm worker:test` 통과.

**Review:** 돌리지 않은 검증을 성공으로 적지 않았는가. 화면으로 본 것과 DB로만 본 것을 구분해 적었는가. 회차 중에 `be/storage`·`damwha_pgdata`를 건드리지 않았는가.

---

## Self-Review 기록

- **스펙 coverage:** §4(A)→Task 2·3·4, §5(B)→Task 5, §6(C)→Task 7, §7(D)→Task 6, §8(E)→Task 8, §10·§11→Task 10, §11의 P5-C2→Task 4 Step 5(e2e), P5-C11→Task 9, P5-C12→Task 6, §12→Task 1. 빠진 절 없음.
- **Placeholder:** 없음. Task 1의 결과 문서 템플릿 안 `<...>`는 실행자가 실제 관찰로 채울 자리이고, 채우는 방법이 같은 Step에 있다.
- **Type consistency:** `reclaimOrphaned`는 Task 2에서 `{ requeued, failedLive }`로 정의하고 Task 3·4·9가 같은 이름을 쓴다. `mark_processing`의 다섯 번째 인자 `worker_id`는 Task 6에서만 바뀌고 Task 5의 헬퍼(`_meeting_with_running_job`)를 Task 6이 이어 쓴다. `retry`는 BE·FE 양쪽에서 `{ attempts, max_attempts, next_attempt_at }`로 같다.

---

## 리뷰 기록

**계획 검증 1차 — 코덱스 (`gpt-5.6-terra`, effort medium, 읽기 전용), 대상 `1f0dcef`.**

| 지적 | 판정 | 조치 |
| --- | --- | --- |
| Blocker — Task 8의 배선 지점이 크래시 재시작 경로가 아니다. 크래시는 `watchForDeath`→`scheduleRestart`→타이머→`background(spec)`이고 `restartOnce`는 사람이 누를 때만 지난다 | **유효** — `supervisor.ts:539-585`·`662-686` 확인 | Task 8을 다시 썼다. `reapOwnOnceBefore`를 타이머와 `restartOnce` **둘 다**에 붙이고, 크래시 경로(`onExit`→예약 재시작)를 재현하는 테스트를 첫 케이스로 두었다 |
| Blocker — Task 7의 코드가 "다운로드 문구가 이긴다"를 구현하지 않는다. 다운로드 표시는 `stageLabel`과 독립된 span이다 | **유효** | `showRetry`에 `downloading.length === 0`을 넣고, 둘이 같이 뜨지 않는지 보는 FE 테스트를 더했다 |
| Blocker — P5-C11이 실제 경로를 쓰지 않는다(claim을 `UPDATE`로 흉내, 취소·재처리 미검증, 동시 트랜잭션 없음) | **유효** | Task 9를 다시 썼다. 실제 `claim`·`cancel`·`bumpVersionForReprocess`를 쓰고, 두 `pg.Client`로 열린 회수 트랜잭션과 claim을 경합시킨다 |
| Important — `max_attempts` 기본값 변경이 `jobs.repository.spec.ts:121-127`을 깨는데 Task 5가 누락 | **유효** — 그 테스트가 `toBe(3)`을 단언한다 | Task 5의 Files·Step 9·커밋에 그 파일을 넣었다 |
| Important — Task 6이 `mark_processing` 테스트 호출을 셋으로 셌다. 실제 넷(L46·L47·L303·L315) | **유효** | 네 줄을 번호로 적고, 남은 4인자 호출이 0인지 grep으로 확인하는 Review 항목을 더했다. `run_process_meeting`이 이미 `worker_id`를 받는다는 사실도 적었다 |
| Important — Task 4가 `isAppWorkerId`를 만들고 쓰지 않는다 | **유효** | 부트스트랩 가드를 `isAppWorkerId`로 바꾸고 `WORKER_ID=worker-1` 케이스를 더했다 |
| Important — P5-C2가 API 기동 + 행 불변을 함께 보지 않는다 | **유효** | Task 4에 `reclaim-bootstrap.e2e-spec.ts`를 더했다. `AppModule`을 실제로 띄우고 세 행(앞 실행·이번 실행·외부)을 한 번에 본다 |
| Minor — Task 8의 테스트가 없는 이름을 쓴다(`childEnvForTest`·`makeDeps`), `RUN_WORKER_ID`는 private, `config.ts`가 Files에 없다 | **유효** | 실제 이름으로 고쳤다 — `fakeKernel`(`orphans.test.ts:317`), `childEnv(ctx, inherited)`. `APP_WORKER_PREFIX`를 export하고 `config.ts`·`main.ts`를 Files에 넣었다 |
| Minor — Task 1의 복구가 중단 안전하지 않다 | **유효** | `trap restore EXIT INT TERM` 스크립트로 바꾸고, 원본이 디렉터리로 돌아왔는지 눈으로 보는 Step 3b를 더했다 |
| `recorded_at` 픽스처·명령 인자 전달 가정은 문제 없다 | **확인** | 그대로 둔다 |
