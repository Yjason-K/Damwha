# 라이브 녹음 브라우저 캡처 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실시간 녹음의 오디오 획득을 워커 Mac의 마이크에서 브라우저로 옮긴다. API가 WAV의 writer가 되고 워커는 자라는 파일을 tail한다.

**Architecture:** 브라우저가 `getUserMedia` + `AudioWorklet`으로 16 kHz mono int16 PCM을 뽑아 1.024초(32768바이트)씩 API에 POST한다. API가 `meetings/<id>/live.wav`에 append하고, 워커의 `TailSource`가 그 파일을 따라 읽어 기존 미리보기 파이프라인(`LiveSegmenter` → whisper → ECAPA → `live_utterance`)에 먹인다. 봉인의 권위는 `job.sealed_bytes`이고, 모든 라이브 변경은 DB 트랜잭션의 `job → meeting` FOR UPDATE 안에서 일어난다.

**Tech Stack:** NestJS 10 + raw SQL(pg), Python 3.12(uv), React 19 + Vite 8, Web Audio API(AudioWorklet), Postgres 16.

**Spec:** [docs/superpowers/specs/2026-09-05-live-recording-browser-capture-design.md](../specs/2026-09-05-live-recording-browser-capture-design.md)

## Global Constraints

- **오프셋은 언제나 PCM 바이트다.** 44바이트 WAV 헤더를 뺀 값이고 파일 위치는 `44 + offset`이다. `X-Audio-Offset`, `X-Final-Offset`, `expected_offset`, `job.sealed_bytes`가 전부 이 기준이다. (스펙 §3.3)
- **프레임은 16 kHz mono int16 512샘플 = 1024바이트.** 청크는 32프레임 = **32768바이트 = 1.024초**. 상수는 `SR=16000`, `FRAME_SAMPLES=512`, `FRAME_BYTES=1024`, `FRAME_MS=32`, `HEADER_LEN=44`. 바이트↔ms는 **32 bytes/ms**. (스펙 §3.3)
- **모든 라이브 상태 변경은 DB 트랜잭션 안에서 `job FOR UPDATE` → `meeting FOR UPDATE` 순서.** 메모리 mutex 금지. 200 응답은 커밋 뒤에만. (스펙 §2.6, §4.3)
- **저장소 규칙:** 루트에서 패키지를 직접 실행하지 않는다. `pnpm be <script>` / `pnpm fe <script>` / `pnpm worker*`를 쓴다. `be/`에서 `npm install` 금지. (root CLAUDE.md)
- **계약은 늘 셋을 같이 바꾼다:** `be/src/contracts/job-payload.schema.ts`, `be/worker/damwha_worker/contracts.py`, `be/test/fixtures/job-payloads/`.
- **e2e 테스트는 `/api` prefix가 없다.** `setGlobalPrefix('api')`는 `main.ts`에만 있고 테스트는 `createTestingModule`로 앱을 만든다. 테스트 경로는 `/meetings/...` 그대로.
- **되돌릴 수 있는 상수** (전부 모듈 상단 named constant로, 매직 넘버 금지): orphan 임계 90초, drift seek 30초, `ENOENT` grace 60초, 클라이언트 버퍼 상한 60초, 청크 32768바이트.

## 독립적으로 출하 가능한 부분

**Task 3(cancel 잠금 순서 통일)은 이 기능과 무관하게 혼자 선다.** 기존 `MeetingsService.cancel()`의 meeting→job 순서가 이미 `LiveService.stop`·`finalize_live_session`의 job→meeting과 어긋나 있고, 이 플랜은 그 창을 넓힐 뿐이다. 브랜치를 나누고 싶으면 Task 3만 먼저 머지해도 된다. 나머지 Task는 순서대로 의존한다.

## File Structure

**신규**

| 파일 | 책임 |
|---|---|
| `be/src/database/migrations/023_live_browser_capture.sql` | `job.sealed_bytes`, `job.last_input_at`, `meeting.capture_error` |
| `be/src/storage/live-audio.service.ts` | 라이브 WAV의 생성·append·봉인·크기 조회. fsync 정책이 여기 한 곳에 산다 |
| `be/src/live/live-orphan.service.ts` | 버려진 producer 스캐너 (주기 실행) |
| `be/worker/damwha_worker/audio/tail_source.py` | 자라는 WAV를 따라 읽는 `AudioSource` 구현체 + 드리프트 seek |
| `be/worker/tests/test_tail_source.py` | 위의 결정적 테스트 |
| `be/test/live-audio.e2e-spec.ts` | append/stop 계약, 정렬 검증, crash 재개, 동시성 |
| `be/test/live-orphan.e2e-spec.ts` | orphan 스캐너 |
| `fe/src/features/meeting/lib/pcm-worklet.ts` | AudioWorkletProcessor. 렌더 퀀텀 무관하게 512샘플 누적 |
| `fe/src/features/meeting/lib/pcm-convert.ts` | Float32 → int16, 프레임 배칭 (순수 함수) |
| `fe/src/features/meeting/lib/live-recorder.ts` | getUserMedia·게이트·링 버퍼·업로더 |
| `fe/src/features/meeting/lib/pcm-convert.test.ts`, `live-recorder.test.ts` | 위의 테스트 |

**수정**

| 파일 | 무엇을 |
|---|---|
| `be/src/storage/storage.service.ts` | `liveKey()` 추가 (`meetings/<id>/live.wav`) |
| `be/src/live/live.repository.ts` | `lockJobById`, `markInput`, `seal`, `findOrphanCandidates` |
| `be/src/live/live.service.ts` | `appendAudio`, `stop` 확장, API-actor finalize |
| `be/src/live/live.controller.ts` | append 라우트 + raw body 미들웨어 |
| `be/src/live/live.module.ts` | `NestModule.configure`로 `express.raw` 등록 (main·테스트 양쪽에 걸리게) |
| `be/src/meetings/meetings.service.ts` | `cancel()`을 job → meeting 순서로 |
| `be/src/contracts/job-payload.schema.ts` | `source: 'mic' \| 'browser'` |
| `be/worker/damwha_worker/contracts.py` | 같은 값 |
| `be/worker/damwha_worker/pipeline/live_segmenter.py` | `skip_to()` |
| `be/worker/damwha_worker/pipeline/live_session.py` | writer 경로 제거, `TailSource` 소비, `sealed_bytes`까지 읽고 finalize |
| `be/worker/damwha_worker/db.py` | `get_stop_requested`가 `sealed_bytes` 동반 반환, finalize actor-aware |
| `be/worker/damwha_worker/__main__.py` | `build_live_source`가 payload의 `source`로 분기 |
| `fe/src/features/meeting/api/live.ts` | append/stop 호출 |
| `fe/src/features/meeting/ui/new-meeting-dialog.tsx` | 시작 전 게이트 |

---

## Task 1: 마이그레이션 023

**Files:**
- Create: `be/src/database/migrations/023_live_browser_capture.sql`
- Test: `be/test/migration.spec.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `job.sealed_bytes bigint`, `job.last_input_at timestamptz`, `meeting.capture_error jsonb`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/migration.spec.ts`에 추가한다. 기존 테스트가 어떻게 DB를 세우는지 파일 위쪽을 먼저 읽고 같은 방식을 쓴다.

```ts
it('023 adds live browser capture columns', async () => {
  const { rows } = await db.pool.query(`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE (table_name='job'     AND column_name IN ('sealed_bytes','last_input_at'))
       OR (table_name='meeting' AND column_name='capture_error')
    ORDER BY table_name, column_name`);
  expect(rows).toEqual([
    { table_name: 'job', column_name: 'last_input_at', data_type: 'timestamp with time zone' },
    { table_name: 'job', column_name: 'sealed_bytes', data_type: 'bigint' },
    { table_name: 'meeting', column_name: 'capture_error', data_type: 'jsonb' },
  ]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- migration.spec`
Expected: FAIL — 컬럼이 없어 `rows`가 빈 배열이다.

- [ ] **Step 3: 마이그레이션을 쓴다**

```sql
-- 봉인된 최종 PCM 바이트 수(헤더 제외). 워커가 tail을 끝낼 유일한 근거다 (설계 §2.7).
-- 파일 크기가 아니라 이 값이 EOF를 정하는 이유: 파일 append·헤더 재작성·DB commit은
-- 한 트랜잭션이 될 수 없어서, 셋 중 무엇이 진실인지 정해야 하기 때문이다.
ALTER TABLE job ADD COLUMN sealed_bytes bigint;

-- producer(브라우저) 생존 신호. append 커밋마다 갱신한다. 워커 heartbeat(locked_at)는
-- tail 대기 중에도 계속 뛰므로 브라우저 생존의 증거가 될 수 없다 (설계 §4.7).
ALTER TABLE job ADD COLUMN last_input_at timestamptz;

-- 캡처 이력. meeting.error와 다르다 — error는 "이 회의의 처리가 실패했는가"이고
-- 이것은 "이 녹음이 어떻게 얻어졌는가"다. finalize와 최종 persist가 error=NULL로
-- 덮으므로 캡처 사건을 error에 넣으면 조용히 지워진다 (설계 §2.10).
ALTER TABLE meeting ADD COLUMN capture_error jsonb;
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- migration.spec`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/src/database/migrations/023_live_browser_capture.sql be/test/migration.spec.ts
git commit -m "feat(be): 브라우저 캡처용 컬럼 셋을 더한다

sealed_bytes는 봉인의 권위다. 파일 append·헤더 재작성·DB commit이 한 트랜잭션이
될 수 없으므로 EOF를 파일 크기가 아니라 DB가 정한다. last_input_at은 producer
생존 신호로, 워커 heartbeat는 tail 대기 중에도 뛰어 브라우저 생존을 증명하지
못한다. capture_error를 error와 나눈 이유는 finalize와 persist가 error=NULL로
덮어 캡처 이력이 조용히 지워지기 때문이다."
```

---

## Task 2: 라이브 WAV 파일 원시 연산

**Files:**
- Create: `be/src/storage/live-audio.service.ts`
- Create: `be/test/live-audio.service.spec.ts`
- Modify: `be/src/storage/storage.service.ts` (`liveKey` 추가)
- Modify: `be/src/storage/storage.module.ts` (provider 등록)

**Interfaces:**
- Consumes: `StorageService.resolve(key)`
- Produces:
  - `StorageService.liveKey(meetingId: string): string` → `meetings/<id>/live.wav`
  - `LiveAudioService.create(key: string): Promise<void>`
  - `LiveAudioService.pcmSize(key: string): Promise<number>` — 없으면 `-1`
  - `LiveAudioService.append(key: string, pcm: Buffer): Promise<number>` — 새 PCM 크기 반환
  - `LiveAudioService.seal(key: string, pcmBytes: number): Promise<void>`

**왜 별도 서비스인가:** `StorageService.save()`는 `fs.promises.writeFile`이라 **truncate**다. append 경로에서 그걸 쓰면 매 청크가 앞 청크를 덮어써 정본이 마지막 1초만 남는다. 그 오용이 물리적으로 불가능하도록 라이브 전용 연산을 다른 클래스에 둔다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/live-audio.service.spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveAudioService, HEADER_LEN, STREAMING_SIZE } from '../src/storage/live-audio.service';
import { StorageService } from '../src/storage/storage.service';

describe('LiveAudioService', () => {
  let root: string; let storage: StorageService; let svc: LiveAudioService;
  const KEY = 'meetings/mtg_1/live.wav';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damwha-live-'));
    process.env.STORAGE_ROOT = root;
    storage = new StorageService();
    svc = new LiveAudioService(storage);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const head = () => fs.readFileSync(path.join(root, KEY)).subarray(0, HEADER_LEN);

  it('create writes a 44-byte streaming header', async () => {
    await svc.create(KEY);
    const h = head();
    expect(h.length).toBe(HEADER_LEN);
    expect(h.subarray(0, 4).toString()).toBe('RIFF');
    expect(h.subarray(8, 12).toString()).toBe('WAVE');
    expect(h.subarray(36, 40).toString()).toBe('data');
    expect(h.readUInt32LE(4)).toBe(STREAMING_SIZE);
    expect(h.readUInt32LE(40)).toBe(STREAMING_SIZE);
    expect(h.readUInt32LE(24)).toBe(16000); // sample rate
  });

  it('pcmSize is -1 before create and 0 after', async () => {
    expect(await svc.pcmSize(KEY)).toBe(-1);
    await svc.create(KEY);
    expect(await svc.pcmSize(KEY)).toBe(0);
  });

  it('append accumulates instead of truncating', async () => {
    await svc.create(KEY);
    expect(await svc.append(KEY, Buffer.alloc(32768, 1))).toBe(32768);
    expect(await svc.append(KEY, Buffer.alloc(32768, 2))).toBe(65536);
    expect(await svc.pcmSize(KEY)).toBe(65536);
    const body = fs.readFileSync(path.join(root, KEY)).subarray(HEADER_LEN);
    expect(body[0]).toBe(1);
    expect(body[32768]).toBe(2);
  });

  it('seal writes the real sizes into the header', async () => {
    await svc.create(KEY);
    await svc.append(KEY, Buffer.alloc(1024, 7));
    await svc.seal(KEY, 1024);
    expect(head().readUInt32LE(40)).toBe(1024);
    expect(head().readUInt32LE(4)).toBe(36 + 1024);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- live-audio.service`
Expected: FAIL — `Cannot find module '../src/storage/live-audio.service'`

- [ ] **Step 3: 구현한다**

`be/src/storage/storage.service.ts`의 `meetingKey` 아래에 한 줄 추가한다.

```ts
  // 라이브 녹음 파일. meetingKey와 달리 확장자가 고정이다 — 브라우저가 항상 raw PCM을 올린다.
  liveKey(meetingId: string): string {
    return `meetings/${meetingId}/live.wav`;
  }
```

`be/src/storage/live-audio.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storage.service';

export const SR = 16000;
export const CHANNELS = 1;
export const SAMPLE_WIDTH = 2;
export const HEADER_LEN = 44;
/** ffmpeg가 seek 불가 출력에 쓰는 "길이 미정" 관례. 0이나 실제보다 작은 값과 달리
 *  ffmpeg가 EOF까지 읽는다 — 어느 순간 죽어도 디스크에 닿은 프레임까지 살아 있다. */
export const STREAMING_SIZE = 0xffffffff;

function header(dataSize: number, riffSize: number): Buffer {
  const b = Buffer.alloc(HEADER_LEN);
  b.write('RIFF', 0); b.writeUInt32LE(riffSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(CHANNELS, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * CHANNELS * SAMPLE_WIDTH, 28);
  b.writeUInt16LE(CHANNELS * SAMPLE_WIDTH, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataSize, 40);
  return b;
}

/**
 * 라이브 녹음 WAV의 파일 연산. StorageService.save()가 writeFile(=truncate)이라
 * append 경로에서 쓰면 매 청크가 앞 청크를 덮어쓴다. 그 오용이 불가능하도록 분리했다.
 *
 * 모든 쓰기는 fdatasync 뒤에 반환한다. API가 200을 돌려준 오디오는 전원 장애에도
 * 남아야 한다 — 원 설계가 fsync를 뺀 근거("프로세스 crash에서는 page cache가 산다")는
 * API가 writer가 되면서 생긴 사용자 약속을 덮지 못한다 (설계 §2.8).
 */
@Injectable()
export class LiveAudioService {
  constructor(private readonly storage: StorageService) {}

  /** 헤더만 있는 파일을 만든다. temp write → fsync → rename → 디렉터리 sync. */
  async create(key: string): Promise<void> {
    const full = this.storage.resolve(key);
    const dir = path.dirname(full);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${full}.tmp`;
    const fh = await fs.promises.open(tmp, 'w');
    try {
      await fh.write(header(STREAMING_SIZE, STREAMING_SIZE));
      await fh.datasync();
    } finally { await fh.close(); }
    await fs.promises.rename(tmp, full);
    const dh = await fs.promises.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  }

  /** PCM 바이트 수(헤더 제외). 파일이 없으면 -1 — "0바이트 녹음"과 구별해야 한다. */
  async pcmSize(key: string): Promise<number> {
    const st = await this.storage.statOrNull(key);
    return st === null ? -1 : st.size - HEADER_LEN;
  }

  /** 이어 붙이고 fdatasync한 뒤 새 PCM 크기를 돌려준다. */
  async append(key: string, pcm: Buffer): Promise<number> {
    const fh = await fs.promises.open(this.storage.resolve(key), 'r+');
    try {
      const { size } = await fh.stat();
      await fh.write(pcm, 0, pcm.length, size);
      await fh.datasync();
      return size + pcm.length - HEADER_LEN;
    } finally { await fh.close(); }
  }

  /** 헤더를 실제 크기로 확정한다. 봉인 커밋 뒤 best-effort로 부른다 (설계 §4.4 ④). */
  async seal(key: string, pcmBytes: number): Promise<void> {
    const fh = await fs.promises.open(this.storage.resolve(key), 'r+');
    try {
      await fh.write(header(pcmBytes, 36 + pcmBytes), 0, HEADER_LEN, 0);
      await fh.datasync();
    } finally { await fh.close(); }
  }
}
```

`be/src/storage/storage.module.ts`의 providers·exports에 `LiveAudioService`를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- live-audio.service`
Expected: PASS (4 tests)

- [ ] **Step 5: 커밋**

```bash
git add be/src/storage/live-audio.service.ts be/src/storage/storage.service.ts \
        be/src/storage/storage.module.ts be/test/live-audio.service.spec.ts
git commit -m "feat(be): 라이브 WAV의 생성·append·봉인을 별도 서비스로 둔다

StorageService.save()는 writeFile이라 truncate다. append 경로에서 그걸 쓰면 매
청크가 앞 청크를 덮어써 정본이 마지막 1초만 남는다. 그 오용이 물리적으로 불가능하도록
라이브 전용 연산을 다른 클래스에 뒀다.

모든 쓰기가 fdatasync 뒤에 반환한다. 원 설계가 fsync를 뺀 근거는 프로세스 crash였고,
API가 writer가 되면서 생긴 '200을 돌려줬다'는 약속은 전원 장애까지 덮어야 한다."
```

---

## Task 3: cancel의 잠금 순서를 job → meeting으로 통일한다

**이 Task는 라이브와 독립이다.** 혼자 머지해도 된다.

**Files:**
- Modify: `be/src/meetings/meetings.service.ts` (`cancel`)
- Test: `be/test/meetings-management.e2e-spec.ts` (기존 cancel 테스트가 회귀를 잡는다)

**Interfaces:**
- Consumes: `LiveRepository.lockJobById` 없이 인라인 SQL로 충분하다 (Task 4에서 repository로 옮기지 않는다 — cancel은 라이브 전용이 아니다)
- Produces: 없음 (동작 불변, 잠금 순서만 바뀐다)

**왜:** `MeetingsService.cancel()`은 `meetings.lockById`로 meeting을 먼저 잠근 뒤 job을 읽는다. `LiveService.stop`과 워커의 `finalize_live_session`은 job → meeting이다. **두 순서가 이미 어긋나 있고**, 이 플랜이 초당 한 번 job → meeting 락을 잡으면서 교차 deadlock의 창을 극적으로 넓힌다. Postgres의 deadlock rollback에 맡기면 사용자에게 500이 뜬다.

- [ ] **Step 1: 잠금 순서를 검증하는 테스트를 쓴다**

`be/test/meetings-management.e2e-spec.ts`에 추가한다. 기존 cancel 테스트 근처에 둔다.

```ts
it('cancel locks the job before the meeting (job → meeting order)', async () => {
  // 회의 + running job을 만든다 (기존 헬퍼가 있으면 그것을 쓴다)
  const meetingId = await seedProcessingMeeting();
  const { rows: [job] } = await db.pool.query(`SELECT * FROM meeting m JOIN job j ON j.id=m.current_job_id WHERE m.id=$1`, [meetingId]);

  // 다른 커넥션이 job 행을 먼저 잠근 채 붙들고 있으면, cancel은 meeting이 아니라
  // job에서 막혀야 한다. meeting을 먼저 잠그는 구현이면 cancel이 meeting 락을 쥔 채
  // job을 기다려 교차 deadlock의 재료가 된다.
  const holder = await db.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM job WHERE id=$1 FOR UPDATE', [job.id]);

    const cancelling = request(srv()).post(`/meetings/${meetingId}/cancel`).send();
    // cancel이 job에서 막혀 있는 동안 meeting 행은 여전히 잠기지 않아야 한다.
    const probe = await db.pool.query(
      `SELECT 1 FROM meeting WHERE id=$1 FOR UPDATE NOWAIT`, [meetingId],
    ).then(() => 'free').catch(() => 'locked');
    expect(probe).toBe('free');

    await holder.query('ROLLBACK');
    await cancelling.expect(200);
  } finally { holder.release(); }
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- meetings-management`
Expected: FAIL — `expect(probe).toBe('free')`가 `'locked'`를 받는다. 지금 구현이 meeting을 먼저 잠근다.

- [ ] **Step 3: 순서를 뒤집는다**

`be/src/meetings/meetings.service.ts`의 `cancel`을 바꾼다.

```ts
  /**
   * 처리 취소 (POST /meetings/:id/cancel). 현재 job이 queued/running이면 failed(cancelled)로
   * 닫고 회의도 failed(cancelled)로 — 그러면 reprocess 가드(done|failed)를 그대로 통과해
   * 다시 돌릴 수 있다. 워커는 다음 stage 경계 또는 heartbeat에서 소유권 상실을 보고 멈춘다.
   *
   * 잠금은 job → meeting 순서다. LiveService.stop과 워커의 finalize_live_session이 같은
   * 순서라, 여기만 meeting을 먼저 잠그면 교차 deadlock이 난다. current_job_id는 잠그지 않은
   * 조회로 얻고, job을 잠근 뒤 meeting을 잠그고, 그 사이 current_job_id가 바뀌지 않았는지
   * 다시 확인한다.
   */
  async cancel(id: string): Promise<{ meeting_id: string; job_id: string; status: 'failed' }> {
    return this.db.withTransaction(async (c) => {
      const probe = await this.meetings.findById(c, id);
      if (!probe) throw new NotFoundException('meeting not found');
      const jobId = probe.current_job_id;
      const job = jobId
        ? (await c.query<JobRow>(`SELECT * FROM job WHERE id=$1 FOR UPDATE`, [jobId])).rows[0] ?? null
        : null;
      const meeting = await this.meetings.lockById(c, id);
      if (!meeting) throw new NotFoundException('meeting not found');
      // job을 잠그는 사이 회의가 다른 job으로 옮겨갔으면 방금 잠근 job은 무의미하다.
      if (!job || meeting.current_job_id !== job.id
          || (job.status !== 'queued' && job.status !== 'running')) {
        throw new ConflictException('no processing in progress to cancel');
      }
      const error = JobsRepository.cancelledError(job.stage);
      await this.jobs.cancel(c, job.id, error);
      await this.meetings.markCancelled(c, id, error);
      return { meeting_id: id, job_id: job.id, status: 'failed' };
    });
  }
```

`JobRow`를 `../jobs/jobs.types`에서 import한다.

- [ ] **Step 4: 통과와 회귀를 확인한다**

Run: `pnpm be test -- meetings-management`
Expected: PASS. 기존 cancel 테스트(취소 성공, 진행 중 아님 409, 없는 회의 404)도 전부 통과해야 한다.

- [ ] **Step 5: 커밋**

```bash
git add be/src/meetings/meetings.service.ts be/test/meetings-management.e2e-spec.ts
git commit -m "fix(be): cancel의 잠금 순서를 job → meeting으로 통일한다

cancel은 meeting을 먼저 잠근 뒤 job을 읽는데 LiveService.stop과 워커의
finalize_live_session은 job → meeting이다. 두 순서가 이미 어긋나 있어 교차
deadlock이 가능하고, Postgres의 rollback에 맡기면 사용자에게 500이 뜬다.

브라우저 캡처가 초당 한 번 job → meeting 락을 잡으면 그 창이 극적으로 넓어지므로
먼저 맞춘다. current_job_id는 잠그지 않은 조회로 얻고, job을 잠근 뒤 meeting을
잠그고, 그 사이 회의가 다른 job으로 옮겨가지 않았는지 다시 확인한다."
```

---

## Task 4: 계약에 `browser` source를 더한다

**Files:**
- Modify: `be/src/contracts/job-payload.schema.ts:154,262`
- Modify: `be/worker/damwha_worker/contracts.py:363,384`
- Modify: `be/test/fixtures/job-payloads/live_session.valid.json`
- Test: `be/test/job-payload.spec.ts`, `be/test/contract-fixtures.spec.ts`, `be/worker/tests/test_contracts_live.py`

**Interfaces:**
- Consumes: 없음
- Produces: `source`가 `'mic' | 'browser'`이고 `buildLiveSessionPayload`가 `'browser'`를 만든다

**순서가 중요하다.** 워커의 `browser` 수용이 API의 `browser` 생성보다 먼저 배포돼야 한다. 이 Task는 양쪽을 같은 커밋에 넣되 **API는 아직 `browser`를 만들지 않는다** — `buildLiveSessionPayload`의 기본값 변경은 Task 12(feature flag)에서 한다. 여기서는 스키마가 둘 다 받아들이게만 넓힌다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_contracts_live.py`에 추가:

```python
def test_browser_source_is_accepted():
    data = _valid_live_payload()          # 이 파일 위쪽의 기존 헬퍼를 쓴다
    data["source"] = "browser"
    p = parse_payload("live_session", data)
    assert p.source == "browser"


def test_unknown_source_is_rejected():
    data = _valid_live_payload()
    data["source"] = "system"
    with pytest.raises(Exception):
        parse_payload("live_session", data)
```

`be/test/job-payload.spec.ts`에 추가:

```ts
it('live_session accepts both mic and browser sources', () => {
  const base = { schema_version: 1 as const, meeting_id: 'mtg_1', audio_key: 'meetings/mtg_1/live.wav', process: validProcessV5 };
  expect(LiveSessionPayloadSchema.parse({ ...base, source: 'mic' }).source).toBe('mic');
  expect(LiveSessionPayloadSchema.parse({ ...base, source: 'browser' }).source).toBe('browser');
  expect(() => LiveSessionPayloadSchema.parse({ ...base, source: 'system' })).toThrow();
});
```

`validProcessV5`는 같은 파일의 기존 v5 픽스처를 쓴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_contracts_live.py` 그리고 `pnpm be test -- job-payload`
Expected: 둘 다 FAIL — `browser`가 `Literal["mic"]`/`z.literal('mic')`에 걸린다.

- [ ] **Step 3: 스키마를 넓힌다**

`be/src/contracts/job-payload.schema.ts:154`:

```ts
  // source는 오디오를 누가 잡는가다. 'browser'가 기본 경로이고, 'mic'은 나중에 시스템
  // 오디오 구현체가 들어올 자리의 참조 구현으로 남는다 (설계 §2.1).
  source: z.enum(['mic', 'browser']),
```

`be/worker/damwha_worker/contracts.py`의 두 곳(`LiveSessionPayloadWire`, `LiveSessionPayload`):

```python
    source: Literal["mic", "browser"]
```

`be/test/fixtures/job-payloads/live_session.valid.json`의 `"source"`를 `"browser"`로 바꾼다. 이 파일은 양쪽이 같이 검증하므로 한 번 바꾸면 두 테스트가 같이 움직인다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_contracts_live.py tests/test_dispatch_live.py` 그리고 `pnpm be test -- job-payload contract-fixtures`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add be/src/contracts/job-payload.schema.ts be/worker/damwha_worker/contracts.py \
        be/test/fixtures/job-payloads/live_session.valid.json be/test/job-payload.spec.ts \
        be/worker/tests/test_contracts_live.py
git commit -m "feat(contracts): live_session의 source에 browser를 더한다

스키마 버전은 올리지 않는다. 이 기능이 아직 머지 전이라 live_session payload가 실제로
존재한 적이 없어서, v1을 넓히는 것이 정직하다.

워커의 수용이 API의 생성보다 먼저다. 순서가 뒤집히면 옛 워커가 browser payload를
unsupported_payload_version으로 영구 실패시킨다. 여기서는 스키마만 넓히고
buildLiveSessionPayload는 아직 mic을 만든다."
```

---

## Task 5: `TailSource` — 자라는 WAV를 따라 읽는다

**Files:**
- Create: `be/worker/damwha_worker/audio/tail_source.py`
- Create: `be/worker/tests/test_tail_source.py`

**Interfaces:**
- Consumes: `be/worker/damwha_worker/audio/source.py`의 `AudioSource`, `FRAME_BYTES`, `SR`
- Produces:
  - `TailSource(path: str, *, sealed_bytes: Callable[[], int | None], grace_seconds: float = 60.0, drift_bytes: int = 960_000, poll_seconds: float = 0.05, sleep=time.sleep, clock=time.monotonic)`
  - `.frames() -> Iterator[bytes]` — 1024바이트 프레임
  - `.position_ms -> int` — **yield된** 바이트 기준. `bytes_yielded // 32`
  - `.skips -> int` — 드리프트 seek 횟수
  - `.stop() -> None`
  - 모듈 상수 `ENOENT_GRACE_SECONDS = 60.0`, `DRIFT_BYTES = 960_000`, `BYTES_PER_MS = 32`

**핵심 성질 넷** (스펙 §2.7, §6):
1. EOF는 "끝"이 아니라 "따라잡음"이다. 진짜 EOF는 `sealed_bytes()`가 값을 주고 거기 도달했을 때만.
2. WAV 헤더의 크기 필드를 **읽지 않는다**. 봉인 전환 중에 그 값을 믿으면 파일을 조기 종료한다.
3. short read는 EOF가 아니라 재시도다. 나머지 버퍼를 들고 완성된 프레임만 낸다.
4. `ENOENT`는 grace 안에서만 대기다. 무한 대기는 hang이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_tail_source.py`:

```python
import os
import struct
import threading

import pytest

from damwha_worker.audio.source import FRAME_BYTES
from damwha_worker.audio.tail_source import BYTES_PER_MS, DRIFT_BYTES, TailSource
from damwha_worker.errors import IO_ERROR, WorkerError

HEADER = b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE" + b"fmt " + struct.pack(
    "<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16
) + b"data" + struct.pack("<I", 0xFFFFFFFF)


def _wav(tmp_path, pcm=b""):
    p = tmp_path / "live.wav"
    p.write_bytes(HEADER + pcm)
    return str(p)


class Clock:
    """결정적 시계. sleep이 시간을 앞으로 민다 — 실제로 자지 않는다."""
    def __init__(self): self.t = 0.0
    def __call__(self): return self.t
    def sleep(self, s): self.t += s


def _src(path, sealed=None, **kw):
    c = kw.pop("clock", None) or Clock()
    return TailSource(path, sealed_bytes=lambda: sealed, clock=c, sleep=c.sleep, **kw), c


def test_yields_only_complete_frames(tmp_path):
    # 프레임 하나 반 → 한 프레임만 나오고, 봉인되면 나머지 반쪽은 버려진다
    path = _wav(tmp_path, b"\x01" * (FRAME_BYTES + 500))
    src, _ = _src(path, sealed=FRAME_BYTES + 500)
    out = list(src.frames())
    assert len(out) == 1
    assert out[0] == b"\x01" * FRAME_BYTES
    assert src.position_ms == FRAME_BYTES // BYTES_PER_MS


def test_eof_is_catch_up_not_end(tmp_path):
    # 봉인이 없으면 파일 끝에서 끝나지 않고 기다린다. 다른 스레드가 더 쓰면 이어서 읽는다.
    path = _wav(tmp_path, b"\x01" * FRAME_BYTES)
    src, _ = _src(path, sealed=None)
    got = []
    def consume():
        for f in src.frames():
            got.append(f)
    t = threading.Thread(target=consume, daemon=True); t.start()
    while len(got) < 1: pass
    with open(path, "ab") as f: f.write(b"\x02" * FRAME_BYTES)
    while len(got) < 2: pass
    src.stop(); t.join(timeout=5)
    assert got[1] == b"\x02" * FRAME_BYTES


def test_ends_exactly_at_sealed_bytes(tmp_path):
    # 파일에 3프레임이 있어도 sealed가 2프레임이면 2개만 낸다
    path = _wav(tmp_path, b"\x03" * (FRAME_BYTES * 3))
    src, _ = _src(path, sealed=FRAME_BYTES * 2)
    assert len(list(src.frames())) == 2


def test_ignores_header_size_fields(tmp_path):
    # 헤더가 "data 크기 0"이라고 말해도 실제 PCM을 전부 읽는다.
    # 봉인 전환 중 헤더를 믿으면 파일을 조기 종료한다.
    path = _wav(tmp_path, b"\x04" * FRAME_BYTES)
    with open(path, "r+b") as f:
        f.seek(40); f.write(struct.pack("<I", 0))
    src, _ = _src(path, sealed=FRAME_BYTES)
    assert len(list(src.frames())) == 1


def test_enoent_waits_within_grace_then_fails(tmp_path):
    missing = str(tmp_path / "nope.wav")
    src, clock = _src(missing, sealed=None, grace_seconds=1.0, poll_seconds=0.5)
    with pytest.raises(WorkerError) as e:
        list(src.frames())
    assert e.value.code == IO_ERROR
    assert clock.t >= 1.0        # 곧바로 죽지 않고 grace 동안 기다렸다


def test_enoent_recovers_if_file_appears_within_grace(tmp_path):
    path = str(tmp_path / "late.wav")
    src, clock = _src(path, sealed=FRAME_BYTES, grace_seconds=5.0, poll_seconds=0.1)
    frames = src.frames()
    # 첫 next() 전에 파일을 만든다 — grace 안이므로 정상 대기 후 읽는다
    with open(path, "wb") as f: f.write(HEADER + b"\x05" * FRAME_BYTES)
    assert next(frames) == b"\x05" * FRAME_BYTES


def test_drift_seek_jumps_forward_and_reports_position(tmp_path):
    # DRIFT_BYTES보다 훨씬 앞선 파일 → 첫 프레임부터 뒤쪽으로 건너뛴다
    pcm = bytes(DRIFT_BYTES + FRAME_BYTES * 10)
    path = _wav(tmp_path, pcm)
    src, _ = _src(path, sealed=len(pcm))
    first = next(src.frames())
    assert first is not None
    assert src.skips == 1
    # target = floor((available - DRIFT_BYTES) / FRAME_BYTES) * FRAME_BYTES
    target = ((len(pcm) - DRIFT_BYTES) // FRAME_BYTES) * FRAME_BYTES
    # 첫 프레임을 이미 하나 냈으므로 position은 target + 한 프레임
    assert src.position_ms == (target + FRAME_BYTES) // BYTES_PER_MS


def test_no_drift_seek_when_within_threshold(tmp_path):
    path = _wav(tmp_path, b"\x06" * (FRAME_BYTES * 4))
    src, _ = _src(path, sealed=FRAME_BYTES * 4)
    list(src.frames())
    assert src.skips == 0


def test_short_read_is_retried_not_treated_as_eof(tmp_path):
    # 프레임 경계 중간까지만 쓰인 파일에 나머지가 나중에 온다
    path = _wav(tmp_path, b"\x07" * 500)
    src, _ = _src(path, sealed=None)
    got = []
    t = threading.Thread(target=lambda: got.extend(src.frames()), daemon=True); t.start()
    with open(path, "ab") as f: f.write(b"\x07" * (FRAME_BYTES - 500))
    while not got: pass
    src.stop(); t.join(timeout=5)
    assert got[0] == b"\x07" * FRAME_BYTES
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_tail_source.py`
Expected: FAIL — `ModuleNotFoundError: damwha_worker.audio.tail_source`

- [ ] **Step 3: 구현한다**

`be/worker/damwha_worker/audio/tail_source.py`:

```python
"""자라는 WAV를 따라 읽는 AudioSource — 브라우저가 올리고 API가 쓰는 파일의 소비자.

FileSource와 결정적으로 다른 점은 **EOF가 "끝"이 아니라 "따라잡음"**이라는 것이다.
진짜 EOF는 sealed_bytes()가 값을 주고 읽기 오프셋이 거기 닿았을 때만 성립한다.
파일 크기가 아니라 DB의 sealed_bytes가 권위인 이유: 파일 append·헤더 재작성·DB commit이
한 트랜잭션이 될 수 없어서 셋 중 무엇이 진실인지 정해야 하기 때문이다 (설계 §2.7).

WAV 헤더의 크기 필드는 읽지 않는다. 봉인 순간 API가 그 두 필드를 seek/write로 고치는데,
전환 중의 값을 믿으면 파일을 조기 종료한다 (설계 §6).
"""

import logging
import os
import time
from collections.abc import Callable, Iterator

from ..errors import IO_ERROR, ErrorKind, WorkerError
from .source import FRAME_BYTES

log = logging.getLogger("damwha_worker")

HEADER_LEN = 44
BYTES_PER_MS = 32  # 16000 samples/s * 2 bytes = 32000 bytes/s
#: 미리보기가 이만큼 뒤처지면 따라잡는다. 30초 = 30 * 32000.
DRIFT_BYTES = 960_000
#: 파일이 아직 없어도 되는 기간. 워커가 브라우저의 첫 POST보다 먼저 claim할 수 있다.
#: 무한 대기는 hang이므로 상한을 둔다 (설계 §4.1).
ENOENT_GRACE_SECONDS = 60.0
POLL_SECONDS = 0.05


class TailSource:
    def __init__(
        self,
        path: str,
        *,
        sealed_bytes: Callable[[], int | None],
        grace_seconds: float = ENOENT_GRACE_SECONDS,
        drift_bytes: int = DRIFT_BYTES,
        poll_seconds: float = POLL_SECONDS,
        sleep=time.sleep,
        clock=time.monotonic,
    ) -> None:
        self._path = path
        self._sealed = sealed_bytes
        self._grace = grace_seconds
        self._drift = drift_bytes
        self._poll = poll_seconds
        self._sleep = sleep
        self._clock = clock
        self._stopped = False
        self._yielded = 0          # yield한 PCM 바이트 (position의 근거)
        self._rest = b""           # 아직 프레임을 못 채운 나머지
        self.skips = 0

    @property
    def position_ms(self) -> int:
        """yield한 바이트 기준의 절대 위치. 시간의 근거가 프레임 카운터가 아니라
        파일 오프셋이므로, 건너뛰어도 이 값은 진실을 말한다 (설계 §6.1)."""
        return self._yielded // BYTES_PER_MS

    def stop(self) -> None:
        self._stopped = True

    def _open(self):
        deadline = self._clock() + self._grace
        while not self._stopped:
            try:
                return open(self._path, "rb")  # noqa: SIM115 — 수명이 frames()까지다
            except FileNotFoundError:
                if self._clock() >= deadline:
                    raise WorkerError(
                        IO_ERROR,
                        f"live audio file never appeared within {self._grace}s: {self._path}",
                        ErrorKind.PERMANENT,
                        stage="capture",
                    ) from None
                self._sleep(self._poll)
        return None

    def _available(self, sealed: int | None) -> int:
        pcm = os.path.getsize(self._path) - HEADER_LEN
        return pcm if sealed is None else min(pcm, sealed)

    def frames(self) -> Iterator[bytes]:
        f = self._open()
        if f is None:
            return
        try:
            while not self._stopped:
                sealed = self._sealed()
                available = self._available(sealed)
                if self._yielded + len(self._rest) >= available:
                    # 따라잡았다. 봉인됐고 거기 도달했으면 진짜 끝이다.
                    if sealed is not None and self._yielded >= sealed:
                        return
                    self._sleep(self._poll)
                    continue
                behind = available - self._yielded
                if behind > self._drift:
                    # 미리보기가 너무 뒤처졌다 — 뒤쪽으로 건너뛴다. 파일은 온전하고
                    # 미리보기만 구간을 못 본다. 나머지 버퍼를 버려야 프레임 경계가 맞는다.
                    target = ((available - self._drift) // FRAME_BYTES) * FRAME_BYTES
                    self._rest = b""
                    self._yielded = target
                    f.seek(HEADER_LEN + target)
                    self.skips += 1
                    log.warning(
                        "live preview %d ms behind — skipped to %d ms",
                        behind // BYTES_PER_MS, self.position_ms,
                    )
                    continue
                want = available - self._yielded - len(self._rest)
                chunk = f.read(want)
                if not chunk:
                    # short read. EOF가 아니라 아직 안 쓰인 것이다.
                    self._sleep(self._poll)
                    continue
                self._rest += chunk
                while len(self._rest) >= FRAME_BYTES and not self._stopped:
                    frame, self._rest = self._rest[:FRAME_BYTES], self._rest[FRAME_BYTES:]
                    self._yielded += FRAME_BYTES
                    yield frame
        finally:
            f.close()
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_tail_source.py -v`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/audio/tail_source.py be/worker/tests/test_tail_source.py
git commit -m "feat(worker): 자라는 WAV를 따라 읽는 TailSource를 더한다

FileSource와 결정적으로 다른 점은 EOF가 끝이 아니라 따라잡음이라는 것이다. 진짜 끝은
sealed_bytes가 값을 주고 거기 도달했을 때만 성립한다 — 파일 크기가 아니라 DB가 권위인
이유는 append·헤더 재작성·DB commit이 한 트랜잭션이 될 수 없기 때문이다.

WAV 헤더의 크기 필드는 읽지 않는다. 봉인 순간 API가 그 두 필드를 고치는데 전환 중의
값을 믿으면 파일을 조기 종료한다. short read도 EOF가 아니라 재시도다.

드리프트 seek이 preview 큐의 프레임 드롭을 대신한다. 큐에서는 프레임을 버리면
LiveSegmenter._pos_ms가 밀려 이후 타임스탬프가 전부 어긋났는데, 여기서는 시간의 근거가
카운터가 아니라 파일 오프셋이라 건너뛰어도 position이 진실을 말한다.

ENOENT는 grace 안에서만 대기다. 워커가 브라우저의 첫 POST보다 먼저 claim할 수 있어
기다려야 하지만, 무한 대기는 hang이다."
```

---

## Task 6: `LiveSegmenter.skip_to()`

**Files:**
- Modify: `be/worker/damwha_worker/pipeline/live_segmenter.py`
- Test: `be/worker/tests/test_live_segmenter.py` (기존 파일에 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `LiveSegmenter.skip_to(pos_ms: int) -> None`

**왜:** `TailSource`가 건너뛰면 `_pos_ms`(프레임 카운터)와 실제 파일 위치가 어긋난다. `skip_to`가 `_pos_ms`를 **절대값으로 다시 놓고**, pre-roll을 비우고, 열려 있던 세그먼트를 버리고(방금 구멍을 냈으므로), VAD 상태를 리셋한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_live_segmenter.py`에 추가한다. 기존 테스트가 `FakeStreamingVAD`를 어떻게 쓰는지 파일 위쪽을 먼저 읽는다.

```python
def test_skip_to_sets_absolute_position():
    seg = LiveSegmenter(FakeStreamingVAD([]))
    seg.push(b"\x00" * FRAME_BYTES)          # _pos_ms = 32
    seg.skip_to(600_000)                      # 10분 지점으로 건너뛴다
    vad = FakeStreamingVAD([("start", 0)])
    seg._vad = vad
    seg.push(b"\x00" * FRAME_BYTES)
    out = seg.push(b"\x00" * FRAME_BYTES)     # 아직 end가 없어 비어 있다
    assert out == []
    # 열린 세그먼트의 시작이 건너뛴 위치 이후여야 한다
    assert seg._cur_start_ms >= 600_000


def test_skip_to_drops_open_segment_and_pre_roll():
    seg = LiveSegmenter(FakeStreamingVAD([("start", 0)]))
    seg.push(b"\x01" * FRAME_BYTES)           # 세그먼트가 열린다
    assert seg._cur is not None
    seg.skip_to(600_000)
    assert seg._cur is None                   # 구멍을 냈으므로 버린다
    assert len(seg._pre_roll) == 0


def test_skip_to_resets_vad_when_supported():
    class ResettableVAD(FakeStreamingVAD):
        def __init__(self): super().__init__([]); self.resets = 0
        def reset(self): self.resets += 1
    vad = ResettableVAD()
    seg = LiveSegmenter(vad)
    seg.skip_to(1000)
    assert vad.resets == 1


def test_flush_after_skip_uses_new_position():
    seg = LiveSegmenter(FakeStreamingVAD([("start", 0)]))
    seg.skip_to(600_000)
    seg.push(b"\x02" * FRAME_BYTES)
    s = seg.flush()
    assert s is not None
    assert s.start_ms >= 600_000
    assert s.end_ms > s.start_ms
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_live_segmenter.py`
Expected: FAIL — `AttributeError: 'LiveSegmenter' object has no attribute 'skip_to'`

- [ ] **Step 3: 구현한다**

`be/worker/damwha_worker/pipeline/live_segmenter.py`의 `flush()` 위에 추가한다.

```python
    def skip_to(self, pos_ms: int) -> None:
        """미리보기가 뒤처져 TailSource가 건너뛰었다 — 절대 위치를 다시 심는다.

        _pos_ms는 push된 프레임을 세는 상대 카운터라, 건너뛴 만큼 실제 시각보다 밀린다.
        그대로 두면 이후 모든 live_utterance.start_ms/end_ms가 어긋난다. 발화 점프가 이
        제품의 핵심이라 화면에 틀린 시각이 뜨는 것 자체가 결함이다 (설계 §6.1).

        열려 있던 세그먼트는 버린다 — 방금 그 한가운데에 구멍을 냈으므로 이어 붙이면
        없는 오디오를 하나의 발화로 만든다. pre-roll도 같은 이유로 비운다.
        """
        self._pos_ms = pos_ms
        self._cur = None
        self._pre_roll.clear()
        reset = getattr(self._vad, "reset", None)
        if callable(reset):
            reset()
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_live_segmenter.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/pipeline/live_segmenter.py be/worker/tests/test_live_segmenter.py
git commit -m "feat(worker): LiveSegmenter에 skip_to를 더한다

_pos_ms는 push된 프레임을 세는 상대 카운터다. TailSource가 드리프트로 건너뛰면 그만큼
실제 시각보다 밀리고, 이후 모든 live_utterance 타임스탬프가 어긋난다. 절대 위치를 다시
심어 파일 오프셋을 시간의 근거로 만든다.

열린 세그먼트와 pre-roll을 버린다 — 방금 그 한가운데에 구멍을 냈으므로 이어 붙이면
없는 오디오가 하나의 발화가 된다."
```

---

## Task 7: 워커 DB — 봉인 신호와 actor-aware finalize

**Files:**
- Modify: `be/worker/damwha_worker/db.py` (`get_stop_requested`, `finalize_live_session`)
- Test: `be/worker/tests/test_db_live.py` (기존 파일에 추가)

**Interfaces:**
- Consumes: Task 1의 `job.sealed_bytes`
- Produces:
  - `get_stop_requested(conn, job_id, worker_id) -> tuple[str | None, int | None]` — `(signal, sealed_bytes)`. signal은 `'stop' | 'lost' | None`
  - `finalize_live_session(...)`의 시그니처는 그대로. **`capture_error`를 건드리지 않는다**는 것만 보장한다

**왜 튜플인가:** 워커는 stop을 본 뒤 `sealed_bytes`까지 읽어야 finalize할 수 있다(설계 §4.5). 두 값이 같은 행에 있으므로 두 번 조회하면 그 사이 값이 바뀔 수 있고, 무엇보다 왕복이 하나 는다. 한 SELECT로 같이 읽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_db_live.py`에 추가한다. 기존 `seed_job`/`seed_meeting` 헬퍼를 쓴다.

```python
def test_get_stop_requested_returns_sealed_bytes(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, mid, type="live_session", status="running", locked_by="w1")
    assert db.get_stop_requested(conn, jid, "w1") == (None, None)

    conn.execute(
        "UPDATE job SET stop_requested_at=now(), sealed_bytes=%s WHERE id=%s", (65536, jid)
    )
    assert db.get_stop_requested(conn, jid, "w1") == ("stop", 65536)


def test_get_stop_requested_lost_carries_no_bytes(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, mid, type="live_session", status="running", locked_by="w1")
    assert db.get_stop_requested(conn, jid, "other") == ("lost", None)


def test_finalize_preserves_capture_error(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, mid, type="live_session", status="running", locked_by="w1")
    conn.execute("UPDATE meeting SET current_job_id=%s, capture_error=%s WHERE id=%s",
                 (jid, Jsonb({"code": "producer_abandoned"}), mid))
    db.finalize_live_session(
        conn, job_id=jid, worker_id="w1", meeting_id=mid,
        duration_ms=1000, process_payload=_process_wire(mid),
    )
    row = conn.execute("SELECT status, error, capture_error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] == "uploaded"
    assert row["error"] is None
    # 처리 실패 error는 지워도 캡처 이력은 남아야 한다 — 설계 §2.10
    assert row["capture_error"] == {"code": "producer_abandoned"}
```

`_process_wire(mid)`는 이 파일의 기존 헬퍼를 쓴다. 없으면 `test_live_session.py`의 `_payload(mid)["process"]`를 복사한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_db_live.py`
Expected: FAIL — `get_stop_requested`가 문자열을 돌려주므로 튜플 비교가 깨진다.

- [ ] **Step 3: 구현한다**

`be/worker/damwha_worker/db.py`의 `get_stop_requested`를 바꾼다.

```python
def get_stop_requested(conn, job_id: str, worker_id: str) -> tuple[str | None, int | None]:
    """루프가 1초마다 읽는 종료 신호와 봉인 길이.

    ('stop', sealed_bytes) = API가 봉인을 끝냈다. 워커는 그 바이트까지 읽고 finalize한다.
    ('lost', None) = 소유권 상실 (cancel·reaper). (None, None) = 계속.

    둘을 한 SELECT로 읽는 이유: 봉인은 stop_requested_at과 sealed_bytes를 같은 트랜잭션에서
    쓰므로 따로 읽으면 그 사이 값이 바뀐 것을 볼 수 있다 (설계 §4.4 ③).
    """
    row = conn.execute(
        "SELECT status, locked_by, stop_requested_at, sealed_bytes FROM job WHERE id=%s",
        (job_id,),
    ).fetchone()
    if row is None or row["locked_by"] != worker_id or row["status"] != "running":
        return "lost", None
    if row["stop_requested_at"] is not None:
        return "stop", row["sealed_bytes"]
    return None, None
```

`finalize_live_session`의 meeting UPDATE는 그대로 둔다 — `capture_error`를 SET 목록에 넣지 않으므로 이미 보존된다. 다만 그것이 **의도**임을 주석으로 못 박는다.

```python
            cur = conn.execute(
                """
                UPDATE meeting SET status='uploaded', duration_ms=%s, error=NULL
                WHERE id=%s AND status='recording' AND current_job_id=%s
                """,
                (duration_ms, meeting_id, job_id),
            )
            # capture_error는 일부러 SET 목록에 없다. error는 "이 회의의 처리가 실패했는가"이고
            # capture_error는 "이 녹음이 어떻게 얻어졌는가"다. 최종 패스가 성공해도 "40분 중
            # 30분만 녹음됐다"는 계속 보여야 한다 (설계 §2.10).
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_db_live.py -v`
Expected: PASS. `test_live_session.py`는 아직 깨진다(Task 8에서 고친다) — 여기서는 `test_db_live.py`만 본다.

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/db.py be/worker/tests/test_db_live.py
git commit -m "feat(worker): stop 신호가 봉인 길이를 함께 나른다

워커는 stop을 본 뒤 sealed_bytes까지 읽어야 finalize할 수 있다. 봉인은 두 컬럼을 같은
트랜잭션에서 쓰므로 따로 조회하면 그 사이 값이 바뀐 것을 볼 수 있다. 한 SELECT로 읽는다.

finalize의 meeting UPDATE에 capture_error가 없는 것이 의도임을 주석으로 못 박았다.
error는 처리 실패이고 capture_error는 녹음 이력이라 최종 패스가 성공해도 남아야 한다."
```

---

## Task 8: `live_session.py` — writer를 걷어내고 tail을 먹인다

**Files:**
- Modify: `be/worker/damwha_worker/pipeline/live_session.py`
- Modify: `be/worker/damwha_worker/__main__.py` (`build_live_source` 분기)
- Modify: `be/worker/tests/test_live_session.py`, `be/worker/tests/fakes.py`
- Test: 위 두 테스트 파일

**Interfaces:**
- Consumes: `TailSource`(Task 5), `LiveSegmenter.skip_to`(Task 6), `get_stop_requested` 튜플(Task 7)
- Produces: `run_live_session(...)` 시그니처 불변. 내부만 바뀐다

**사라지는 것:** `WavWriter`, `run_writer_thread`, `writer_q`, `Capture`의 이중 큐 분기, `writer_thread.error` 판정, `frames_written == 0` 정리, `finally`의 조인 순서 로직. `repair_streaming_header`는 남는다(설계 §4.4 ④의 그물).

**큐가 유계인 이유:** 미리보기가 느리면 큐가 차고 → capture 스레드가 `put`에서 막히고 → `TailSource`가 전진을 멈추고 → 파일은 계속 자라고 → 다음 읽기에서 `behind > DRIFT_BYTES`를 보고 건너뛴다. 무계 큐면 이 backpressure가 없어 드리프트가 큐 안에 쌓인다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/fakes.py`에 추가:

```python
class GrowingFileSource:
    """TailSource를 흉내 내는 fake. 프레임과 절대 위치를 같이 낸다."""

    def __init__(self, frames, *, skip_after=None, skip_to_ms=None):
        self._frames = list(frames)
        self._skip_after = skip_after
        self._skip_to_ms = skip_to_ms
        self._i = 0
        self.position_ms = 0
        self.skips = 0
        self.stopped = False

    def frames(self):
        for i, f in enumerate(self._frames):
            if self.stopped:
                return
            if self._skip_after is not None and i == self._skip_after:
                self.position_ms = self._skip_to_ms
                self.skips += 1
            self.position_ms += 32
            yield f

    def stop(self):
        self.stopped = True
```

`be/worker/tests/test_live_session.py`에 추가:

```python
def test_reads_until_sealed_bytes_then_finalizes(conn, tmp_path, storage):
    """봉인 길이에 닿아야 끝난다. duration_ms는 sealed_bytes에서 나온다."""
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, mid, type="live_session", status="running", locked_by="w1")
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    sealed = FRAME_BYTES * 10
    conn.execute("UPDATE job SET stop_requested_at=now(), sealed_bytes=%s WHERE id=%s", (sealed, jid))

    src = GrowingFileSource([b"\x00" * FRAME_BYTES] * 10)
    outcome = run_live_session(
        conn, _job(conn, jid), parse_payload("live_session", _payload(mid)),
        _models(), storage, src, worker_id="w1",
    )
    assert outcome == "committed"
    row = conn.execute("SELECT status, duration_ms FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] == "uploaded"
    assert row["duration_ms"] == sealed // 32       # 32 bytes/ms


def test_skip_reseeds_segmenter_position(conn, tmp_path, storage):
    """소스가 건너뛰면 세그먼터의 절대 위치가 따라가야 한다 — 안 그러면 발화 시각이 밀린다."""
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, mid, type="live_session", status="running", locked_by="w1")
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    conn.execute("UPDATE job SET stop_requested_at=now(), sealed_bytes=%s WHERE id=%s",
                 (FRAME_BYTES * 6, jid))

    # 3프레임 뒤에 10분 지점으로 건너뛴다. 그 뒤 VAD가 발화 하나를 낸다.
    src = GrowingFileSource([b"\x01" * FRAME_BYTES] * 6, skip_after=3, skip_to_ms=600_000)
    models = _models(vad=FakeStreamingVAD([None, None, None, ("start", 0), None, ("end", 0)]))
    run_live_session(
        conn, _job(conn, jid), parse_payload("live_session", _payload(mid)),
        models, storage, src, worker_id="w1",
    )
    rows = conn.execute("SELECT start_ms FROM live_utterance WHERE meeting_id=%s ORDER BY seq", (mid,)).fetchall()
    assert rows, "발화가 하나는 나와야 한다"
    assert rows[0]["start_ms"] >= 600_000, "건너뛴 뒤의 발화가 건너뛰기 전 시각으로 기록됐다"


def test_does_not_write_the_audio_file(conn, tmp_path, storage):
    """워커는 이제 reader다. 파일을 만들거나 쓰지 않는다."""
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(conn, mid, type="live_session", status="running", locked_by="w1")
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    conn.execute("UPDATE job SET stop_requested_at=now(), sealed_bytes=%s WHERE id=%s", (FRAME_BYTES, jid))
    payload = parse_payload("live_session", _payload(mid))
    path = storage.resolve(payload.audio_key)

    run_live_session(conn, _job(conn, jid), payload, _models(), storage,
                     GrowingFileSource([b"\x00" * FRAME_BYTES]), worker_id="w1")
    assert not os.path.exists(path), "워커가 오디오 파일을 만들었다 — API가 writer다"
```

기존 테스트 중 `WavWriter`·`Capture` 이중 큐·`frames_written == 0`을 검증하던 것들은 **삭제한다**. 그 동작이 더는 없다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_live_session.py`
Expected: FAIL — `get_stop_requested`가 튜플이라 기존 비교가 깨지고, 새 테스트는 파일이 생겨서 실패한다.

- [ ] **Step 3: `live_session.py`를 고친다**

모듈 docstring과 상수를 바꾼다.

```python
"""라이브 세션 — API가 쓰는 WAV를 따라 읽어 미리보기를 만든다.

[capture thread]  source.frames() ──▶ 유계 큐 (pos_ms, pcm)
[main loop]       큐 ──▶ (위치 불연속이면 segmenter.skip_to)
                      ──▶ LiveSegmenter ──segment──▶ temp wav
                      ──▶ transcribe ──▶ text (비면 건너뜀)
                      ──▶ embed ──▶ identify_embedding(suggest_threshold)
                      ──▶ insert_live_utterance(seq++)
                  매 1초: get_stop_requested, shutdown_event, 상한 시간

워커는 이제 **reader**다. 파일은 API가 쓴다 (설계 §2.2). 그래서 원 설계 §2.9의 이중 큐와
writer 스레드가 통째로 없다 — "추론이 멈춰도 파일 쓰기는 디스크 속도로"는 캡처가 브라우저로
간 순간 이미 성립한다. API의 append는 whisper와 아예 다른 프로세스다.

큐가 유계인 이유는 backpressure다. 미리보기가 느리면 큐가 차고 → capture 스레드가 put에서
막히고 → TailSource가 전진을 멈추고 → 파일은 계속 자라고 → 다음 읽기에서 드리프트를 보고
건너뛴다. 무계 큐면 드리프트가 큐 안에 쌓여 seek이 영영 안 일어난다.

오류는 전부 PERMANENT — 끊긴 녹음은 이어 붙일 수 없다 (§2.6).
"""
```

```python
#: 2초. backpressure를 만들 만큼 작고, 전사 한 번의 지터를 흡수할 만큼은 크다.
PREVIEW_QUEUE_MAX_FRAMES = 2000 // FRAME_MS
BYTES_PER_MS = 32
```

`Capture` 클래스를 단일 큐로 바꾼다.

```python
class Capture:
    """capture thread: 소스의 프레임을 (위치, pcm)으로 유계 큐에 넣는다.

    큐가 차면 put에서 막힌다. 그것이 TailSource에 backpressure를 주는 유일한 장치다.
    소스가 끝나거나 죽으면 None을 넣어 소비자를 깨운다.
    """

    def __init__(self, source, q: "queue.Queue", *, stop_poll_seconds: float) -> None:
        self._source = source
        self._q = q
        self._poll = stop_poll_seconds
        self._stopped = threading.Event()
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="live-capture", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: float | None = None) -> None:
        self._thread.join(timeout)

    def _put(self, item) -> bool:
        """stop을 인지하는 blocking put. 소비자가 영영 안 먹어도 종료할 수 있어야 한다."""
        while not self._stopped.is_set():
            try:
                self._q.put(item, timeout=self._poll)
                return True
            except queue.Full:
                continue
        return False

    def stop(self) -> None:
        self._stopped.set()

    def _run(self) -> None:
        try:
            for pcm in self._source.frames():
                if not self._put((self._source.position_ms, pcm)):
                    return
        except BaseException as exc:  # noqa: BLE001 — 메인 루프가 다시 던진다
            self.error = exc
        finally:
            try:
                self._q.put_nowait(None)
            except queue.Full:
                pass
```

`run_live_session`의 본문을 바꾼다. 요지는 넷이다.

1. **writer를 만들지 않는다.** `WavWriter`, `writer_q`, `writer_thread`, `set_recording_started` 호출 전부 삭제. 소유권 확인은 첫 `get_stop_requested`가 한다.
2. **`sealed_bytes`를 캐시하고 소스에 넘긴다.**
3. **위치 불연속에서 `skip_to`.**
4. **`duration_ms`를 `sealed_bytes`에서 만든다.**

```python
    job_id = job["id"]
    meeting_id = payload.meeting_id
    ctx = f"job={job_id} meeting={meeting_id}"
    enter_stage(conn, job_id, worker_id, "capture", 0, shutdown_event)
    signal, sealed = db.get_stop_requested(conn, job_id, worker_id)
    if signal == "lost":
        log.info("%s live_session lost ownership before capture", ctx)
        return "lost"

    # TailSource가 매 읽기마다 부른다. DB를 그 빈도로 때리지 않도록 1초 폴링이 갱신하는
    # 값을 돌려준다. None이면 "아직 봉인 안 됨 = 계속 기다려라"다.
    sealed_box = {"bytes": sealed}
    q: queue.Queue = queue.Queue(maxsize=preview_max_frames)
    capture = Capture(source, q, stop_poll_seconds=stop_poll_seconds)
    segmenter = LiveSegmenter(models.vad)
    tmpdir = tempfile.TemporaryDirectory(prefix="damwha-live-")
    state = {"seq": 0, "failures": 0}
    started = clock()
    last_poll = started
    next_pos_ms = 0
    stop_reason: str | None = None
    log.info("%s live_session capture start", ctx)
```

`handle(seg)`는 그대로 둔다. 메인 루프를 바꾼다.

```python
    try:
        capture.start()
        while True:
            try:
                item = q.get(timeout=stop_poll_seconds)
            except queue.Empty:
                item = _NO_FRAME
            if item is None:
                stop_reason = "source_ended"
                break
            if item is not _NO_FRAME:
                pos_ms, pcm = item
                # 소스가 건너뛰었으면 세그먼터의 절대 위치를 다시 심는다. 이 프레임의 끝이
                # pos_ms이므로 시작은 pos_ms - FRAME_MS다 (설계 §6.1).
                if pos_ms != next_pos_ms:
                    segmenter.skip_to(pos_ms - FRAME_MS)
                next_pos_ms = pos_ms + FRAME_MS
                for seg in segmenter.push(pcm):
                    handle(seg)
            now = clock()
            if now - last_poll >= stop_poll_seconds:
                last_poll = now
                if capture.error is not None:
                    stop_reason = "capture_error"
                    break
                try:
                    signal, sealed = db.get_stop_requested(conn, job_id, worker_id)
                    sealed_box["bytes"] = sealed
                except Exception:  # noqa: BLE001 — DB가 잠깐 죽어도 미리보기는 계속
                    log.warning("%s stop poll failed — continuing", ctx, exc_info=True)
                    signal = None
                if signal == "lost":
                    stop_reason = "lost"
                    break
                if signal == "stop":
                    # 즉시 끝내지 않는다. 소스가 sealed_bytes에 닿으면 스스로 끝난다
                    # (TailSource가 sealed를 보고 EOF를 낸다) — 그때 None이 큐에 온다.
                    # 여기서는 상한 시간만 계속 본다 (설계 §4.5).
                    pass
                if shutdown_event is not None and shutdown_event.is_set():
                    stop_reason = "shutdown"
                    break
                if now - started >= max_minutes * 60:
                    stop_reason = "max_duration"
                    break
```

종료·finalize 블록을 바꾼다.

```python
        source.stop()
        capture.stop()
        capture.join(timeout=10)
        if capture.error is not None:
            raise capture.error
        sealed = sealed_box["bytes"]
        log.info(
            "%s live_session capture end reason=%s sealed_bytes=%s rows=%d skips=%d",
            ctx, stop_reason, sealed, state["seq"], getattr(source, "skips", 0),
        )
        if stop_reason == "lost":
            return "lost"
        if sealed is None:
            # 봉인 없이 소스가 끝났다 — API가 아직 stop을 처리하지 않았다. 여기서
            # finalize하면 자라는 중인 파일로 duration을 정하고 배치 패스를 큐에 넣는다.
            raise WorkerError(
                IO_ERROR,
                f"live source ended before seal (reason={stop_reason})",
                ErrorKind.PERMANENT,
                stage="capture",
            )
        if sealed == 0:
            # 한 바이트도 안 왔다. 넘길 녹음이 없다.
            raise WorkerError(
                AUDIO_DEVICE_FAILED,
                "captured no audio — nothing to hand off",
                ErrorKind.PERMANENT,
                stage="capture",
            )
        last = segmenter.flush()
        if last is not None:
            handle(last)
        if db.set_stage(conn, job_id, worker_id, "finalize", 100) == 0:
            return "lost"
        return db.finalize_live_session(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            meeting_id=meeting_id,
            duration_ms=sealed // BYTES_PER_MS,
            process_payload=payload.process_wire,
        )
    finally:
        source.stop()
        capture.stop()
        capture.join(timeout=10)
        tmpdir.cleanup()
```

`run_live_session`의 시그니처에 `preview_max_frames` 기본값을 `PREVIEW_QUEUE_MAX_FRAMES`로 두고, `sealed_box`를 소스가 볼 수 있도록 **호출자가 `TailSource`를 만들 때 클로저를 넘긴다**(Task 8 Step 4). 파일 상단 import에서 `WavWriter`, `run_writer_thread`, `wave`를 지운다 — `_write_clip`은 `wave`를 쓰므로 그것만 남긴다.

- [ ] **Step 4: dispatch를 잇는다**

`be/worker/damwha_worker/__main__.py`의 `build_live_source` 기본 구현을 payload로 분기시킨다.

```python
def _default_live_source(payload, storage, sealed_box):
    """payload의 source로 구현체를 고른다.

    'browser'는 API가 쓰는 파일을 따라 읽고, 'mic'은 이 Mac의 입력 장치를 연다.
    mic은 나중에 시스템 오디오가 들어올 자리의 참조 구현으로 남는다 (설계 §2.1).
    """
    if payload.source == "browser":
        from .audio.tail_source import TailSource

        return TailSource(
            storage.resolve(payload.audio_key),
            sealed_bytes=lambda: sealed_box["bytes"],
        )
    from .audio.source import MicSource

    return MicSource()
```

`dispatch`의 `live_session` 분기에서 `sealed_box`를 만들어 `run_live_session`에 같이 넘긴다. `run_live_session`의 인자에 `sealed_box: dict | None = None`을 더하고, 없으면 자체 생성한다(기존 테스트가 fake source를 직접 넘기므로 필요하다).

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_live_session.py tests/test_dispatch_live.py -v`
Expected: PASS. 삭제한 테스트를 뺀 나머지가 전부 통과한다.

Run: `pnpm worker:test`
Expected: 전체 PASS

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/pipeline/live_session.py be/worker/damwha_worker/__main__.py \
        be/worker/tests/test_live_session.py be/worker/tests/fakes.py
git commit -m "feat(worker): 라이브 세션이 파일을 쓰지 않고 따라 읽는다

워커가 writer에서 reader가 된다. WavWriter·WriterThread·이중 큐·조인 순서 로직이 통째로
사라진다 — '추론이 멈춰도 파일 쓰기는 디스크 속도로'라는 원 설계 §2.9의 장치는 캡처가
브라우저로 간 순간 이미 성립한다. API의 append는 whisper와 아예 다른 프로세스다.

큐를 유계로 만든 것이 유일하게 새로 생긴 장치다. 미리보기가 느리면 큐가 차고 capture
스레드가 put에서 막히고 TailSource가 전진을 멈추고 파일은 계속 자라, 다음 읽기에서
드리프트를 보고 건너뛴다. 무계 큐면 드리프트가 큐 안에 쌓여 seek이 영영 안 일어난다.

위치 불연속에서 segmenter.skip_to를 부른다. 큐에 (pos_ms, pcm)을 실어 소스의 절대 위치가
소비자까지 도달하게 했다 — 프레임을 세는 방식으로는 건너뛴 만큼 시각이 밀린다.

duration_ms는 sealed_bytes에서 나온다. 자라는 중인 파일의 크기로 정하면 배치 패스가
잘린 파일과 틀린 duration을 완료된 회의로 받는다."
```

---

## Task 9: append 엔드포인트 — offset/ACK 계약과 잠금 규율

**Files:**
- Modify: `be/src/live/live.repository.ts`, `be/src/live/live.service.ts`, `be/src/live/live.controller.ts`, `be/src/live/live.module.ts`
- Create: `be/test/live-audio.e2e-spec.ts`
- Modify: `docs/superpowers/specs/2026-09-05-live-recording-browser-capture-design.md` (§3.3.2 — 아래 이유)

**Interfaces:**
- Consumes: `LiveAudioService`(Task 2), `job.sealed_bytes`/`last_input_at`(Task 1)
- Produces:
  - `LiveRepository.findLiveJob(exec, meetingId): Promise<{ job_id: string } | null>` — 잠그지 않는 사전 조회
  - `LiveRepository.lockJobById(exec, jobId): Promise<JobRow | null>`
  - `LiveRepository.markInput(exec, jobId): Promise<void>`
  - `LiveRepository.setCaptureError(exec, meetingId, err: object): Promise<void>`
  - `LiveService.appendAudio(id, headers, body): Promise<{ accepted_offset: number; expected_offset: number }>`
  - 모듈 상수 `CHUNK_BYTES = 32768`, `GAP_THRESHOLD_MS = 2000`

**스펙 §3.3.2를 고친다.** 스펙은 `X-Capture-Time`(절대 시각)을 싣고 서버가 이전 청크와의 델타를 본다고 썼는데, 그러려면 이전 캡처 시각을 어딘가 저장해야 한다(컬럼 하나 더). **`X-Capture-Elapsed`(캡처 시작부터 이 청크 끝까지 경과한 ms, 클라이언트 측정)로 바꾸면 상태가 필요 없다** — 서버가 같은 요청 안에서 `elapsed`와 `offset / 32`를 비교하면 끝이다. 델타만 쓴다는 성질도, 클라이언트 절대 시계를 안 믿는다는 성질도 그대로다. Step 6에서 스펙을 같이 고친다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/live-audio.e2e-spec.ts`. `live.e2e-spec.ts`의 `beforeAll`/`afterEach` 골격을 그대로 복사해 시작한다.

```ts
const CHUNK = 32768;
const chunk = (fill: number) => Buffer.alloc(CHUNK, fill);

const send = (id: string, offset: number, body: Buffer, elapsed?: number) => {
  let req = request(srv()).post(`/meetings/${id}/live/audio`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Audio-Offset', String(offset));
  if (elapsed !== undefined) req = req.set('X-Capture-Elapsed', String(elapsed));
  return req.send(body);
};

it('accepts sequential chunks and reports the next expected offset', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200)
    .expect((r) => expect(r.body).toEqual({ accepted_offset: CHUNK, expected_offset: CHUNK }));
  await send(m.id, CHUNK, chunk(2)).expect(200)
    .expect((r) => expect(r.body.expected_offset).toBe(CHUNK * 2));
});

it('409 carries expected_offset so a lost ACK can resync', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  // 클라이언트가 200을 못 받고 같은 청크를 다시 보낸다
  await send(m.id, 0, chunk(1)).expect(409)
    .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
  // 그 값으로 재동기화하면 이어진다
  await send(m.id, CHUNK, chunk(2)).expect(200);
});

it('409 on a gap — a skipped chunk never becomes a silent hole', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, CHUNK * 5, chunk(1)).expect(409)
    .expect((r) => expect(r.body.expected_offset).toBe(0));
});

it('400 on odd offset, wrong body length — before touching file or DB', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 1, chunk(1)).expect(400);
  await send(m.id, 0, Buffer.alloc(100)).expect(400);
  // 아무것도 안 쓰였다
  await send(m.id, 0, chunk(1)).expect(200)
    .expect((r) => expect(r.body.expected_offset).toBe(CHUNK));
});

it('the first chunk stamps recorded_at', async () => {
  const { body: m } = await start().expect(201);
  const before = await db.pool.query(`SELECT recorded_at FROM meeting WHERE id=$1`, [m.id]);
  await send(m.id, 0, chunk(1)).expect(200);
  const after = await db.pool.query(`SELECT recorded_at FROM meeting WHERE id=$1`, [m.id]);
  expect(after.rows[0].recorded_at.getTime()).toBeGreaterThanOrEqual(before.rows[0].recorded_at.getTime());
});

it('every accepted chunk advances last_input_at', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  const { rows } = await db.pool.query(
    `SELECT j.last_input_at FROM job j JOIN meeting m ON m.current_job_id=j.id WHERE m.id=$1`, [m.id]);
  expect(rows[0].last_input_at).not.toBeNull();
});

it('records a capture gap when elapsed runs ahead of the audio', async () => {
  const { body: m } = await start().expect(201);
  // 1.024초치 오디오인데 클라이언트는 10초가 흘렀다고 말한다 — 맥이 잤다
  await send(m.id, 0, chunk(1), 10_000).expect(200);
  const { rows } = await db.pool.query(`SELECT capture_error FROM meeting WHERE id=$1`, [m.id]);
  expect(rows[0].capture_error?.code).toBe('capture_gap');
});

it('rejects appends after the session is sealed', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  await db.pool.query(
    `UPDATE job SET sealed_bytes=$2 WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`,
    [m.id, CHUNK]);
  await send(m.id, CHUNK, chunk(2)).expect(409);
});

it('two concurrent appends at the same offset — exactly one wins', async () => {
  const { body: m } = await start().expect(201);
  const [a, b] = await Promise.all([send(m.id, 0, chunk(1)), send(m.id, 0, chunk(2))]);
  const codes = [a.status, b.status].sort();
  expect(codes).toEqual([200, 409]);
  const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [m.id]);
  const size = fs.statSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key)).size;
  expect(size).toBe(44 + CHUNK);   // 둘 다 쓰였으면 44 + 65536이다
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- live-audio.e2e`
Expected: FAIL — 라우트가 없어 404.

- [ ] **Step 3: raw body 미들웨어를 모듈에 등록한다**

`main.ts`가 아니라 **모듈**에 거는 것이 중요하다. `useBodyParser`는 `main.ts`에만 있고 e2e 테스트는 `createTestingModule`로 앱을 만들어 그 설정을 못 받는다. 미들웨어로 걸면 양쪽에 다 걸린다.

`be/src/live/live.module.ts`:

```ts
import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import * as express from 'express';
import { CHUNK_BYTES } from './live.service';

@Module({ /* 기존 imports/controllers/providers 유지 */ })
export class LiveModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // octet-stream 본문을 Buffer로 받는다. main.ts의 useBodyParser는 e2e 테스트 앱에
    // 걸리지 않으므로 여기에 둔다. 상한은 청크 하나 + 여유.
    consumer
      .apply(express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES + 1024 }))
      .forRoutes(
        { path: 'meetings/:id/live/audio', method: RequestMethod.POST },
        { path: 'meetings/:id/live/stop', method: RequestMethod.POST },
      );
  }
}
```

- [ ] **Step 4: repository를 늘린다**

`be/src/live/live.repository.ts`:

```ts
  /** 잠그지 않는 사전 조회. 잠금 순서가 job → meeting이라 job id를 먼저 알아야 한다. */
  async findLiveJob(exec: Queryable, meetingId: string): Promise<{ job_id: string } | null> {
    const { rows } = await exec.query<{ job_id: string }>(
      `SELECT j.id AS job_id FROM job j JOIN meeting m ON m.current_job_id = j.id
       WHERE m.id=$1 AND j.type='live_session'`, [meetingId]);
    return rows[0] ?? null;
  }

  async lockJobById(exec: Queryable, jobId: string): Promise<JobRow | null> {
    const { rows } = await exec.query<JobRow>(`SELECT * FROM job WHERE id=$1 FOR UPDATE`, [jobId]);
    return rows[0] ?? null;
  }

  /** producer 생존 신호. 워커 heartbeat(locked_at)는 tail 대기 중에도 뛰므로 별개다. */
  async markInput(exec: Queryable, jobId: string): Promise<void> {
    await exec.query(`UPDATE job SET last_input_at=now(), updated_at=now() WHERE id=$1`, [jobId]);
  }

  async setCaptureError(exec: Queryable, meetingId: string, err: object): Promise<void> {
    await exec.query(`UPDATE meeting SET capture_error=$2::jsonb WHERE id=$1`,
      [meetingId, JSON.stringify(err)]);
  }
```

- [ ] **Step 5: 서비스와 컨트롤러를 쓴다**

`be/src/live/live.service.ts`에 추가한다.

```ts
/** 청크 하나 = 512샘플 프레임 32개 = 1.024초. 청크가 고정 크기라야 offset 산술이 정확하다. */
export const CHUNK_BYTES = 32768;
/** 오디오 재생 시간보다 캡처 경과가 이만큼 앞서면 시간이 사라진 것으로 본다. */
export const GAP_THRESHOLD_MS = 2000;
const BYTES_PER_MS = 32;

  private intHeader(v: unknown, field: string): number {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new BadRequestException(`${field} must be a non-negative integer`);
    return Number(v);
  }

  /**
   * PCM 청크를 이어 붙인다.
   *
   * 잠금은 job → meeting 순서다 (설계 §4.3). 메모리 mutex를 쓰지 않는 이유: API 재시작·
   * 두 인스턴스에서 무력하고, 그러면 append 둘이 같은 expected offset을 보고 둘 다 쓴다.
   * 파일 I/O 동안 DB 행 락을 잡는 대가는 의도적이다 — 초당 1회, 32 KiB다.
   *
   * 200은 커밋 뒤에만 나간다. append+fsync는 됐는데 last_input_at 커밋 전에 죽으면 파일은
   * 전진했는데 liveness가 낡아, orphan 스캐너가 살아 있는 producer를 봉인한다.
   */
  async appendAudio(id: string, headers: Record<string, unknown>, body: Buffer) {
    const offset = this.intHeader(headers['x-audio-offset'], 'X-Audio-Offset');
    if (offset % 2 !== 0) throw new BadRequestException('X-Audio-Offset must be even');
    if (body?.length !== CHUNK_BYTES) throw new BadRequestException(`body must be exactly ${CHUNK_BYTES} bytes`);
    const elapsed = headers['x-capture-elapsed'] === undefined
      ? null : this.intHeader(headers['x-capture-elapsed'], 'X-Capture-Elapsed');

    return this.db.withTransaction(async (c) => {
      const probe = await this.live.findLiveJob(c, id);
      if (!probe) throw new NotFoundException('no live session for this meeting');
      const job = await this.live.lockJobById(c, probe.job_id);
      const meeting = await this.meetings.lockById(c, id);
      if (!job || !meeting || meeting.status !== 'recording' || meeting.current_job_id !== job.id) {
        throw new ConflictException('meeting is not recording');
      }
      if (job.sealed_bytes !== null) throw new ConflictException({ code: 'sealed', expected_offset: Number(job.sealed_bytes) });

      const expected = await this.liveAudio.pcmSize(meeting.audio_key);
      if (expected < 0) throw new ConflictException({ code: 'io_error', message: 'live audio file is missing' });
      if (offset !== expected) throw new ConflictException({ expected_offset: expected });

      let accepted: number;
      try {
        accepted = await this.liveAudio.append(meeting.audio_key, body);
      } catch (e) {
        // 디스크 참 등. 종결자는 API 하나다 — 워커의 get_stop_requested는 job.error를
        // 보지 않으므로 error만 넣으면 워커가 계속 tail한다 (설계 §7).
        await this.jobs.fail(c, job.id, { code: 'io_error', kind: 'PERMANENT', stage: 'capture', message: String(e) });
        await this.meetings.markFailed(c, id, { code: 'io_error', message: 'could not write live audio' });
        throw new HttpException({ code: 'io_error' }, 507);
      }
      await this.live.markInput(c, job.id);
      if (offset === 0) await this.meetings.setRecordedAt(c, id);

      if (elapsed !== null) {
        const gap = elapsed - accepted / BYTES_PER_MS;
        if (gap > GAP_THRESHOLD_MS) {
          await this.live.setCaptureError(c, id, { code: 'capture_gap', gap_ms: Math.round(gap) });
        }
      }
      return { accepted_offset: accepted, expected_offset: accepted };
    });
  }
```

`MeetingsRepository`에 `setRecordedAt(exec, id)`(`UPDATE meeting SET recorded_at=now() WHERE id=$1 AND status='recording'`)와, 없으면 `markFailed`를 더한다. 기존 `markCancelled`를 본보기로 삼는다.

컨트롤러:

```ts
  @Post(':id/live/audio')
  @ApiOperation({
    summary: '라이브 PCM 청크 append',
    description:
      '16 kHz mono int16 raw PCM 32768바이트(1.024초)를 이어 붙인다. X-Audio-Offset은 PCM 바이트 '
      + '오프셋(헤더 44바이트 제외). 불일치는 409 + expected_offset이라 ACK가 유실돼도 재동기화된다. '
      + '동시에 하나만 in-flight로 보내야 한다 — HTTP 완료 순서는 전송 순서를 보장하지 않는다.',
  })
  @HttpCode(200)
  append(@Param('id') id: string, @Req() req: { headers: Record<string, unknown>; body: Buffer }) {
    return this.service.appendAudio(id, req.headers, req.body);
  }
```

- [ ] **Step 6: `start()`가 파일을 만들고, 실패하면 세션을 닫는다**

`LiveService.start`의 트랜잭션이 커밋된 **뒤** 파일을 만든다. 워커가 브라우저의 첫 POST보다
먼저 job을 claim할 수 있어서 그때 tail 대상이 존재해야 한다(설계 §4.1).

DB 커밋과 파일 생성은 원자적이지 않다. 커밋 후 생성 실패면 `recording` + queued job이
남고 `TailSource`가 grace 동안 기다리다 `io_error`로 죽는다 — 그때까지 사용자는 아무것도
못 하고, `meeting_single_recording_idx`가 다음 녹음을 막는다. 같은 요청 안에서 닫는다.

```ts
    // 트랜잭션 밖. 커밋된 뒤에 만들어야 rollback이 orphan 파일을 남기지 않는다.
    try {
      await this.liveAudio.create(audioKey);
    } catch (e) {
      // 파일을 못 만들었다. recording + queued를 남기면 회의가 갇힌다 (설계 §4.1).
      const err = { code: 'io_error', message: 'could not create the live audio file' };
      await this.db.withTransaction(async (c) => {
        const probe = await this.live.findLiveJob(c, meetingId);
        if (probe) await this.jobs.fail(c, probe.job_id, { ...err, kind: 'PERMANENT', stage: 'capture' });
        await this.meetings.markFailed(c, meetingId, err);
      });
      throw new HttpException(err, 500);
    }
    return meeting;
```

`start()`가 지금 트랜잭션의 반환값을 그대로 돌려주므로, 그 값을 변수에 받아 두고 위 블록
뒤에 반환하도록 바꾼다.

테스트를 `be/test/live-audio.e2e-spec.ts`에 더한다.

```ts
it('closes the session when the audio file cannot be created', async () => {
  jest.spyOn(app.get(LiveAudioService), 'create').mockRejectedValueOnce(new Error('ENOSPC'));
  const res = await start().expect(500);
  const { rows } = await db.pool.query(
    `SELECT status, error FROM meeting WHERE status IN ('recording','failed') ORDER BY created_at DESC LIMIT 1`);
  // recording으로 갇히지 않는다 — 다음 녹음이 막히면 안 된다
  expect(rows[0].status).toBe('failed');
  expect(rows[0].error.code).toBe('io_error');
});

it('a failed start does not block the next recording', async () => {
  jest.spyOn(app.get(LiveAudioService), 'create').mockRejectedValueOnce(new Error('ENOSPC'));
  await start().expect(500);
  await start().expect(201);   // meeting_single_recording_idx에 걸리지 않는다
});
```

- [ ] **Step 7: 스펙 §3.3.2를 고친다**

`docs/superpowers/specs/2026-09-05-live-recording-browser-capture-design.md`의 §3.3 헤더 목록과 §3.3.2에서 `X-Capture-Time`을 `X-Capture-Elapsed: <캡처 시작부터 이 청크 끝까지 경과한 ms>`로 바꾸고, 마지막 문단을 다음으로 교체한다.

```markdown
서버는 같은 요청 안에서 `X-Capture-Elapsed`와 그 청크까지의 오디오 재생 시간
(`accepted_offset / 32` ms)을 비교한다. 전자가 `GAP_THRESHOLD_MS`(2초)보다 앞서면 그만큼
시간이 사라진 것이고, `meeting.capture_error`에 남긴다. 이전 청크의 캡처 시각을 저장할
필요가 없다 — 클라이언트가 자기 경과를 들고 오므로 서버는 두 수를 빼기만 한다. 클라이언트
시계를 절대 시각으로 믿지 않는다는 성질도 그대로다.
```

`§3.4`의 stop 헤더 목록도 `X-Capture-Elapsed`로 바꾼다.

- [ ] **Step 8: 통과를 확인한다**

Run: `pnpm be test -- live-audio.e2e`
Expected: PASS (9 tests). 특히 마지막 동시성 테스트가 파일 크기 `44 + 32768`을 봐야 한다.

- [ ] **Step 9: 커밋**

```bash
git add be/src/live be/src/meetings/meetings.repository.ts be/test/live-audio.e2e-spec.ts \
        docs/superpowers/specs/2026-09-05-live-recording-browser-capture-design.md
git commit -m "feat(be): 라이브 PCM append 엔드포인트를 더한다

409가 expected_offset을 싣는 것이 이 계약의 핵심이다. append가 성공했는데 응답이 유실되면
클라이언트는 재전송할지 다음을 보낼지 알 수 없다. 다음 요청의 409가 진실을 알려주므로
중복도 결번도 조용히 지나갈 수 없다.

잠금은 job → meeting이고 메모리 mutex를 쓰지 않는다. API 재시작·두 인스턴스에서 무력해
append 둘이 같은 expected offset을 보고 둘 다 쓴다. 파일 I/O 동안 행 락을 잡는 대가는
초당 1회·32 KiB라 감수한다. 200은 커밋 뒤에만 — 파일은 전진했는데 last_input_at이 낡으면
orphan 스캐너가 살아 있는 producer를 봉인한다.

정렬 검증은 파일·DB를 건드리기 전에 한다. repair_streaming_header가 홀수 바이트를 샘플
경계로 잘라내므로 그런 파일이 아예 안 만들어지게 입구에서 막는다.

디스크 참의 종결자는 API 하나로 정했다. 워커의 get_stop_requested는 job.error를 보지 않아
error만 넣으면 계속 tail한다.

raw body 미들웨어를 main.ts가 아니라 모듈에 걸었다. useBodyParser는 e2e 테스트 앱에
걸리지 않는다.

스펙 §3.3.2의 X-Capture-Time을 X-Capture-Elapsed로 바꿨다. 절대 시각은 이전 청크의 시각을
저장해야 델타가 나오는데, 경과 시간을 실으면 서버가 같은 요청 안에서 빼기만 하면 된다."
```

---

## Task 10: stop — 봉인 세 경우와 API-actor finalize

**Files:**
- Modify: `be/src/live/live.repository.ts` (`seal`), `be/src/live/live.service.ts` (`stop`), `be/src/live/live.controller.ts`
- Modify: `be/test/live.e2e-spec.ts` (기존 `queued → discarded` 테스트를 뒤집는다)
- Modify: `be/test/live-audio.e2e-spec.ts` (봉인 케이스 추가)

**Interfaces:**
- Consumes: Task 9의 전부
- Produces:
  - `LiveRepository.seal(exec, jobId, sealedBytes): Promise<void>`
  - `LiveService.stop(id, headers, body)` — 시그니처 확장
  - `LiveService.finalizeByApi(c, job, meeting, sealedBytes): Promise<void>` — Task 11이 재사용한다

**세 경우** (설계 §3.4). 이것이 §4.4 ③ 직전 크래시를 복구 가능하게 만드는 규칙 전부다.

| 조건 | 처리 |
|---|---|
| `expected === X-Audio-Offset` | 정상. body append + fsync 후 봉인 커밋 |
| `expected === X-Final-Offset` | 꼬리가 이미 파일에 있다(③ 전 크래시 후 재시도). **append 없이** 봉인 커밋만 재개 |
| 그 외 | `missing_chunk` 409 |

이미 `sealed_bytes`가 있고 `X-Final-Offset`과 같으면 200 멱등. 다르면 409.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/live-audio.e2e-spec.ts`에 추가:

```ts
const stop = (id: string, offset: number, final: number, body = Buffer.alloc(0)) =>
  request(srv()).post(`/meetings/${id}/live/stop`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Audio-Offset', String(offset))
    .set('X-Final-Offset', String(final))
    .send(body);

it('stop appends the tail, seals, and rewrites the header', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  const tail = Buffer.alloc(1024, 9);
  await stop(m.id, CHUNK, CHUNK + 1024, tail).expect(200)
    .expect((r) => expect(r.body.sealed_bytes).toBe(CHUNK + 1024));

  const { rows } = await db.pool.query(
    `SELECT j.sealed_bytes, j.stop_requested_at, m.audio_key FROM job j
     JOIN meeting m ON m.current_job_id=j.id WHERE m.id=$1`, [m.id]);
  expect(Number(rows[0].sealed_bytes)).toBe(CHUNK + 1024);
  expect(rows[0].stop_requested_at).not.toBeNull();
  const buf = fs.readFileSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key));
  expect(buf.readUInt32LE(40)).toBe(CHUNK + 1024);   // 헤더가 확정됐다
});

it('stop resumes the seal when the tail is already on disk (crash before commit)', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  const tail = Buffer.alloc(1024, 9);
  // ③ 직전 크래시를 흉내 낸다: 꼬리는 파일에 있고 DB는 아직 봉인 전
  const { rows } = await db.pool.query(`SELECT audio_key FROM meeting WHERE id=$1`, [m.id]);
  fs.appendFileSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key), tail);

  // 재시도 stop은 원래 offset을 보낸다. append 없이 봉인만 재개해야 한다.
  await stop(m.id, CHUNK, CHUNK + 1024, tail).expect(200);
  const size = fs.statSync(path.join(process.env.STORAGE_ROOT!, rows[0].audio_key)).size;
  expect(size).toBe(44 + CHUNK + 1024);   // 꼬리가 두 번 붙지 않았다
});

it('stop is idempotent once sealed, and 409s on a different final offset', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  await stop(m.id, CHUNK, CHUNK).expect(200);
  await stop(m.id, CHUNK, CHUNK).expect(200);
  await stop(m.id, CHUNK, CHUNK + 2).expect(409);
});

it('stop 409s when chunks are missing', async () => {
  const { body: m } = await start().expect(201);
  await stop(m.id, CHUNK * 3, CHUNK * 3).expect(409)
    .expect((r) => expect(r.body.code).toBe('missing_chunk'));
});

it('the API finalizes itself when the worker never claimed the job', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  await stop(m.id, CHUNK, CHUNK).expect(200)
    .expect((r) => expect(r.body.outcome).toBe('finalized'));

  const { rows } = await db.pool.query(
    `SELECT status, duration_ms FROM meeting WHERE id=$1`, [m.id]);
  expect(rows[0].status).toBe('uploaded');
  expect(rows[0].duration_ms).toBe(CHUNK / 32);
  const { rows: jobs } = await db.pool.query(
    `SELECT type, status FROM job WHERE meeting_id=$1 ORDER BY created_at`, [m.id]);
  expect(jobs.map((j) => `${j.type}:${j.status}`)).toEqual(['live_session:done', 'process_meeting:queued']);
});

it('a running worker gets stopping, not finalized', async () => {
  const { body: m } = await start().expect(201);
  const { rows } = await db.pool.query(`SELECT current_job_id FROM meeting WHERE id=$1`, [m.id]);
  await claim(rows[0].current_job_id);
  await send(m.id, 0, chunk(1)).expect(200);
  await stop(m.id, CHUNK, CHUNK).expect(200)
    .expect((r) => expect(r.body.outcome).toBe('stopping'));
  // 워커가 finalize한다 — 회의는 아직 recording이다
  const after = await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id]);
  expect(after.rows[0].status).toBe('recording');
});
```

`be/test/live.e2e-spec.ts`의 **"queued면 회의를 지운다"는 기존 테스트를 삭제**하고 위의 `finalized` 테스트가 대신한다. 0바이트 stop이 회의를 지우는 테스트는 남긴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- live-audio.e2e live.e2e`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`LiveRepository`:

```ts
  /** 봉인. sealed_bytes와 stop_requested_at을 같은 트랜잭션에서 쓴다 — 워커가 한 SELECT로
   *  둘을 읽으므로 따로 쓰면 신호는 왔는데 길이가 없는 순간이 생긴다 (설계 §4.4). */
  async seal(exec: Queryable, jobId: string, sealedBytes: number): Promise<void> {
    await exec.query(
      `UPDATE job SET sealed_bytes=$2, stop_requested_at=COALESCE(stop_requested_at, now()),
                      updated_at=now() WHERE id=$1`, [jobId, sealedBytes]);
  }
```

`LiveService.stop`을 다시 쓴다.

```ts
  async stop(id: string, headers: Record<string, unknown>, body: Buffer) {
    const offset = this.intHeader(headers['x-audio-offset'], 'X-Audio-Offset');
    const final = this.intHeader(headers['x-final-offset'], 'X-Final-Offset');
    const tail = body ?? Buffer.alloc(0);
    if (offset % 2 !== 0 || final % 2 !== 0) throw new BadRequestException('offsets must be even');
    if (final !== offset + tail.length) throw new BadRequestException('X-Final-Offset must equal X-Audio-Offset + body length');

    const result = await this.db.withTransaction(async (c) => {
      const probe = await this.live.findLiveJob(c, id);
      const job = probe ? await this.live.lockJobById(c, probe.job_id) : null;
      const meeting = await this.meetings.lockById(c, id);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (!job || meeting.status !== 'recording' || meeting.current_job_id !== job.id) {
        throw new ConflictException('meeting is not recording');
      }
      // 이미 봉인됐다 — 같은 길이면 멱등 성공, 다르면 계약 위반이다.
      if (job.sealed_bytes !== null) {
        if (Number(job.sealed_bytes) !== final) throw new ConflictException({ code: 'missing_chunk', expected_offset: Number(job.sealed_bytes) });
        return { meeting_id: id, job_id: job.id, sealed_bytes: final, outcome: 'stopping' as const, job, meeting };
      }
      const expected = await this.liveAudio.pcmSize(meeting.audio_key);
      if (expected === offset) {
        if (tail.length > 0) await this.liveAudio.append(meeting.audio_key, tail);
      } else if (expected !== final) {
        // ③ 전 크래시 후 재시도면 expected가 이미 final이다. 그 외는 결손이다.
        throw new ConflictException({ code: 'missing_chunk', expected_offset: expected });
      }
      await this.live.seal(c, job.id, final);

      if (job.status === 'queued') {
        // 워커가 한 번도 claim하지 않았다. 디스크엔 온전한 녹음이 있으므로 API가 마무리한다.
        // 원 설계의 "녹음된 게 없으니 회의를 지운다"는 파괴적으로 틀리다 (설계 §2.11).
        if (final === 0) {
          await this.meetings.deleteById(c, id);
          return { meeting_id: id, job_id: job.id, sealed_bytes: 0, outcome: 'discarded' as const, job, meeting };
        }
        await this.finalizeByApi(c, job, meeting, final);
        return { meeting_id: id, job_id: job.id, sealed_bytes: final, outcome: 'finalized' as const, job, meeting };
      }
      return { meeting_id: id, job_id: job.id, sealed_bytes: final, outcome: 'stopping' as const, job, meeting };
    });

    if (result.outcome === 'discarded') {
      await this.storage.deleteDir(this.storage.meetingDir(id));
    } else {
      // 헤더 확정은 봉인 커밋 뒤 best-effort다. 실패해도 워커는 sealed_bytes를 보고,
      // repair_streaming_header가 재처리 때 고친다 (설계 §4.4 ④).
      await this.liveAudio.seal(result.meeting.audio_key, result.sealed_bytes).catch(() => undefined);
    }
    const { job, meeting, ...body_ } = result;
    return body_;
  }

  /**
   * API가 finalize하는 경로. 워커의 finalize_live_session과 같은 일을 하되 job 가드가
   * status='queued'다(워커는 running AND locked_by). capture_error는 건드리지 않는다.
   */
  async finalizeByApi(c: Queryable, job: JobRow, meeting: MeetingRow, sealedBytes: number) {
    await this.meetings.markUploaded(c, meeting.id, sealedBytes / 32);
    const processWire = (job.payload as { process: object }).process;
    const next = await this.jobs.enqueue(c, {
      type: 'process_meeting', meetingId: meeting.id, payload: processWire,
    });
    await this.meetings.setCurrentJob(c, meeting.id, next.id);
    await this.jobs.complete(c, job.id);
  }
```

`MeetingsRepository.markUploaded(exec, id, durationMs)`를 더한다 — `UPDATE meeting SET status='uploaded', duration_ms=$2, error=NULL WHERE id=$1 AND status='recording'`. **`capture_error`를 SET 목록에 넣지 않는다.**

컨트롤러의 `stop`이 `req.headers`와 `req.body`를 넘기도록 바꾼다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- live-audio.e2e live.e2e`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add be/src/live be/src/meetings/meetings.repository.ts be/test/live-audio.e2e-spec.ts be/test/live.e2e-spec.ts
git commit -m "feat(be): stop이 꼬리를 싣고 와 봉인한다

봉인과 마지막 청크 사이의 창을 없앤다. 나누면 stop_requested_at을 찍은 뒤 늦게 도착한
append 하나가 그 창으로 조용한 손실을 만든다.

세 경우로 갈리는 것이 ③ 직전 크래시를 복구 가능하게 만드는 규칙 전부다. 꼬리가
append·sync됐는데 DB commit 전에 죽으면 재시도 stop의 expected는 이미 final이다. 그때
409만 주면 봉인이 영원히 진행되지 않는다 — append 없이 봉인만 재개한다.

queued면 API가 직접 finalize한다. 원 설계의 '워커가 마이크를 안 열었으니 녹음된 게 없다,
회의를 지운다'는 새 구조에서 온전한 녹음을 지우는 일이다.

헤더 확정은 봉인 커밋 뒤 best-effort다. 실패해도 워커는 sealed_bytes를 보고 재처리의
repair_streaming_header가 고친다."
```

---

## Task 11: 버려진 producer 스캐너

**Files:**
- Create: `be/src/live/live-orphan.service.ts`
- Create: `be/test/live-orphan.e2e-spec.ts`
- Modify: `be/src/live/live.module.ts`, `be/src/live/live.repository.ts`

**Interfaces:**
- Consumes: Task 10의 `finalizeByApi`, `LiveRepository.seal`
- Produces:
  - `LiveRepository.findOrphanCandidates(exec, seconds): Promise<Array<{ job_id: string; meeting_id: string }>>`
  - `LiveOrphanService.sweep(): Promise<number>` — 봉인한 세션 수
  - 상수 `ORPHAN_SECONDS = 90`

**왜 reaper의 CTE에 못 넣는가:** 봉인이 `duration_ms`를 알아야 하고 그건 파일을 stat해야 나온다. SQL이 못 한다. 그리고 기존 `reapStale`은 `job.locked_at`만 보는데 **tail 대기 중인 워커는 heartbeat를 계속 뛴다** — 워커 생존은 브라우저 생존의 증거가 아니다(설계 §4.7).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/live-orphan.e2e-spec.ts`:

```ts
const age = (meetingId: string, seconds: number, hasInput: boolean) =>
  db.pool.query(
    `UPDATE job SET last_input_at = CASE WHEN $3 THEN now() - ($2||' seconds')::interval ELSE NULL END,
                    created_at = now() - ($2||' seconds')::interval
     WHERE id=(SELECT current_job_id FROM meeting WHERE id=$1)`,
    [meetingId, String(seconds), hasInput]);

it('seals an abandoned session and marks producer_abandoned', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  await age(m.id, 120, true);

  expect(await orphans.sweep()).toBe(1);
  const { rows } = await db.pool.query(
    `SELECT status, duration_ms, capture_error FROM meeting WHERE id=$1`, [m.id]);
  expect(rows[0].status).toBe('uploaded');
  expect(rows[0].duration_ms).toBe(CHUNK / 32);
  expect(rows[0].capture_error.code).toBe('producer_abandoned');
});

it('catches a session that died before its first chunk (last_input_at IS NULL)', async () => {
  const { body: m } = await start().expect(201);
  await age(m.id, 120, false);
  expect(await orphans.sweep()).toBe(1);
  const { rows } = await db.pool.query(`SELECT status, error FROM meeting WHERE id=$1`, [m.id]);
  // 0바이트는 finalize하지 않는다 — 넘길 녹음이 없다
  expect(rows[0].status).toBe('failed');
  expect(rows[0].error.code).toBe('producer_never_started');
});

it('does not delete the meeting — a scanner never destroys user data', async () => {
  const { body: m } = await start().expect(201);
  await age(m.id, 120, false);
  await orphans.sweep();
  const { rows } = await db.pool.query(`SELECT 1 FROM meeting WHERE id=$1`, [m.id]);
  expect(rows).toHaveLength(1);
});

it('leaves a live session alone', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  expect(await orphans.sweep()).toBe(0);
  const { rows } = await db.pool.query(`SELECT status FROM meeting WHERE id=$1`, [m.id]);
  expect(rows[0].status).toBe('recording');
});

it('leaves an already-sealed session alone', async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  await stop(m.id, CHUNK, CHUNK).expect(200);
  await age(m.id, 120, true);
  expect(await orphans.sweep()).toBe(0);
});
```

`orphans`는 `app.get(LiveOrphanService)`로 얻는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test -- live-orphan`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 구현한다**

`LiveRepository`:

```ts
  /**
   * 버려진 producer 후보. 두 번째 갈래가 필수다 — 브라우저가 /meetings/live 성공 뒤
   * 첫 POST 전에 죽으면 last_input_at이 NULL이라 첫 갈래에 영원히 안 걸린다.
   */
  async findOrphanCandidates(exec: Queryable, seconds: number) {
    const { rows } = await exec.query<{ job_id: string; meeting_id: string }>(
      `SELECT j.id AS job_id, m.id AS meeting_id
       FROM job j JOIN meeting m ON m.current_job_id = j.id
       WHERE j.type='live_session' AND m.status='recording' AND j.sealed_bytes IS NULL
         AND ( j.last_input_at <  now() - ($1||' seconds')::interval
            OR (j.last_input_at IS NULL AND j.created_at < now() - ($1||' seconds')::interval) )`,
      [String(seconds)]);
    return rows;
  }
```

`be/src/live/live-orphan.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { LiveAudioService } from '../storage/live-audio.service';
import { LiveRepository } from './live.repository';
import { LiveService } from './live.service';
import { MeetingsRepository } from '../meetings/meetings.repository';

/** 청크 주기가 1초이므로 90번 연속 실패는 재시도로 회복될 상황이 아니고, 실수로 탭을
 *  닫았다 되돌아오기엔 짧다 (설계 §4.7). */
export const ORPHAN_SECONDS = 90;

/**
 * 버려진 producer를 봉인한다.
 *
 * 기존 reaper로는 이것을 볼 수 없다. reapStale의 CTE는 job.locked_at staleness만 보는데
 * tail 대기 중인 워커는 heartbeat를 계속 뛴다 — 워커 생존은 브라우저 생존의 증거가 아니다.
 * 그리고 봉인이 duration_ms를 알아야 해서 파일을 stat해야 하므로 SQL로는 못 한다.
 */
@Injectable()
export class LiveOrphanService {
  private readonly log = new Logger(LiveOrphanService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly live: LiveRepository,
    private readonly liveService: LiveService,
    private readonly liveAudio: LiveAudioService,
    private readonly meetings: MeetingsRepository,
  ) {}

  async sweep(seconds = ORPHAN_SECONDS): Promise<number> {
    const candidates = await this.live.findOrphanCandidates(this.db.pool, seconds);
    let sealed = 0;
    for (const { job_id, meeting_id } of candidates) {
      try {
        const done = await this.db.withTransaction(async (c) => {
          const job = await this.live.lockJobById(c, job_id);
          const meeting = await this.meetings.lockById(c, meeting_id);
          // 잠그는 사이 사용자가 stop을 눌렀을 수 있다.
          if (!job || !meeting || meeting.status !== 'recording'
              || meeting.current_job_id !== job.id || job.sealed_bytes !== null) return false;
          const pcm = await this.liveAudio.pcmSize(meeting.audio_key);
          const bytes = Math.max(pcm, 0);
          await this.live.seal(c, job.id, bytes);
          if (bytes === 0) {
            // 넘길 녹음이 없다. 삭제하지 않는다 — 자동 스캐너가 사용자 데이터를 지우지
            // 않는다. 사용자가 직접 stop을 눌러 0바이트인 경우만 지운다 (설계 §4.7).
            await this.meetings.markFailed(c, meeting.id, {
              code: 'producer_never_started',
              message: 'the browser never sent any audio',
            });
            await this.jobs.fail(c, job.id, {
              code: 'producer_never_started', kind: 'PERMANENT', stage: 'capture',
              message: 'no audio received',
            });
            return true;
          }
          await this.live.setCaptureError(c, meeting.id, {
            code: 'producer_abandoned',
            message: 'the browser stopped sending audio',
            sealed_bytes: bytes,
          });
          if (job.status === 'queued') {
            await this.liveService.finalizeByApi(c, job, meeting, bytes);
          }
          // running이면 워커가 stop_requested_at을 보고 스스로 finalize한다.
          return true;
        });
        if (done) sealed += 1;
      } catch (e) {
        this.log.warn(`orphan sweep failed for ${meeting_id}: ${String(e)}`);
      }
    }
    if (sealed > 0) this.log.log(`sealed ${sealed} abandoned live session(s)`);
    return sealed;
  }
}
```

`jobs`(`JobsRepository`)를 생성자에 더한다. `LiveModule`의 providers·exports에 `LiveOrphanService`를 등록하고, 기존 `ReaperService`가 주기 실행을 어떻게 거는지(`@Interval` 또는 `setInterval`) 확인해 같은 방식으로 `sweep()`을 30초마다 돌린다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm be test -- live-orphan`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add be/src/live be/test/live-orphan.e2e-spec.ts
git commit -m "feat(be): 버려진 producer를 봉인하는 스캐너를 더한다

브라우저가 stop을 못 부르고 죽으면 아무도 봉인하지 않아 회의가 recording에 갇히고
meeting_single_recording_idx가 다음 녹음을 막는다. 기존 reaper로는 못 본다 — reapStale은
job.locked_at만 보는데 tail 대기 중인 워커는 heartbeat를 계속 뛴다. 워커 생존은 브라우저
생존의 증거가 아니다.

reaper의 CTE에 못 넣는 이유는 봉인이 duration_ms를 알아야 하고 그건 파일을 stat해야
나오기 때문이다. SQL이 못 한다.

last_input_at IS NULL 갈래가 필수다. 브라우저가 시작 성공 뒤 첫 POST 전에 죽으면 그
컬럼이 NULL이라 시간 비교에 영원히 안 걸린다.

결과를 정상 종료로 위장하지 않는다. capture_error에 producer_abandoned를 남기고, 0바이트면
producer_never_started로 실패시키되 삭제하지 않는다 — 자동 스캐너가 사용자 데이터를 지우지
않는다."
```

---

## Task 12: PCM 변환과 AudioWorklet

**Files:**
- Create: `fe/src/features/meeting/lib/pcm-convert.ts`, `pcm-convert.test.ts`
- Create: `fe/src/features/meeting/lib/pcm-worklet.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `SR = 16000`, `FRAME_SAMPLES = 512`, `FRAME_BYTES = 1024`, `CHUNK_FRAMES = 32`, `CHUNK_BYTES = 32768`
  - `floatToInt16(input: Float32Array): Int16Array`
  - `class FrameAccumulator { push(samples: Float32Array): Int16Array[] }` — 512샘플 프레임만 낸다
  - `class ChunkAccumulator { push(frame: Int16Array): Uint8Array | null; flush(): Uint8Array }`

**렌더 퀀텀 128을 하드코딩하지 않는다.** 스펙이 보장하는 값이 아니다. `input[0].length`를 기준으로 누적한다(설계 §2.3).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/lib/pcm-convert.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ChunkAccumulator, CHUNK_BYTES, FRAME_SAMPLES, FrameAccumulator, floatToInt16 } from './pcm-convert';

describe('floatToInt16', () => {
  it('maps -1..1 to the int16 range and clamps beyond it', () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe('FrameAccumulator', () => {
  it('emits only complete 512-sample frames regardless of input length', () => {
    const acc = new FrameAccumulator();
    // 렌더 퀀텀이 128이 아니어도 동작해야 한다 — 스펙이 128을 보장하지 않는다
    expect(acc.push(new Float32Array(100))).toHaveLength(0);
    expect(acc.push(new Float32Array(400))).toHaveLength(0);
    const frames = acc.push(new Float32Array(200));   // 누적 700 → 512 하나
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(FRAME_SAMPLES);
  });

  it('emits several frames from one large push', () => {
    expect(new FrameAccumulator().push(new Float32Array(FRAME_SAMPLES * 3))).toHaveLength(3);
  });
});

describe('ChunkAccumulator', () => {
  it('emits a chunk every 32 frames', () => {
    const acc = new ChunkAccumulator();
    const frame = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < 31; i += 1) expect(acc.push(frame)).toBeNull();
    const chunk = acc.push(frame);
    expect(chunk).not.toBeNull();
    expect(chunk!.byteLength).toBe(CHUNK_BYTES);
  });

  it('flush returns the partial tail without padding it', () => {
    const acc = new ChunkAccumulator();
    acc.push(new Int16Array(FRAME_SAMPLES));
    const tail = acc.flush();
    // 정본 WAV는 절대 자르지도 늘리지도 않는다 — 512샘플이 안 되는 꼬리도 그대로 (설계 §4.5)
    expect(tail.byteLength).toBe(1024);
    expect(acc.flush().byteLength).toBe(0);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test -- pcm-convert`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 구현한다**

`fe/src/features/meeting/lib/pcm-convert.ts`:

```ts
/** 워커의 audio/source.py와 같은 값이어야 한다. 바꾸면 양쪽을 같이 바꾼다. */
export const SR = 16000;
export const FRAME_SAMPLES = 512;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
/** 청크 하나 = 32프레임 = 1.024초. 고정 크기라야 서버가 파일 크기만으로 다음 오프셋을 안다. */
export const CHUNK_FRAMES = 32;
export const CHUNK_BYTES = FRAME_BYTES * CHUNK_FRAMES;

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * 임의 길이의 Float32 입력을 512샘플 int16 프레임으로 자른다.
 *
 * AudioWorkletProcessor.process()의 렌더 퀀텀은 통상 128이지만 스펙이 보장하지 않는다.
 * 128을 하드코딩하면 다른 값을 주는 브라우저에서 정본이 조용히 달라진다 (설계 §2.3).
 */
export class FrameAccumulator {
  private rest = new Float32Array(0);

  push(samples: Float32Array): Int16Array[] {
    const buf = new Float32Array(this.rest.length + samples.length);
    buf.set(this.rest); buf.set(samples, this.rest.length);
    const frames: Int16Array[] = [];
    let at = 0;
    while (buf.length - at >= FRAME_SAMPLES) {
      frames.push(floatToInt16(buf.subarray(at, at + FRAME_SAMPLES)));
      at += FRAME_SAMPLES;
    }
    this.rest = buf.slice(at);
    return frames;
  }
}

/** 프레임을 32개씩 묶어 청크로 낸다. flush는 남은 꼬리를 패딩 없이 그대로 준다. */
export class ChunkAccumulator {
  private frames: Int16Array[] = [];

  push(frame: Int16Array): Uint8Array | null {
    this.frames.push(frame);
    return this.frames.length >= CHUNK_FRAMES ? this.take() : null;
  }

  flush(): Uint8Array { return this.take(); }

  private take(): Uint8Array {
    const out = new Uint8Array(this.frames.length * FRAME_BYTES);
    this.frames.forEach((f, i) => out.set(new Uint8Array(f.buffer, f.byteOffset, FRAME_BYTES), i * FRAME_BYTES));
    this.frames = [];
    return out;
  }
}
```

`fe/src/features/meeting/lib/pcm-worklet.ts`:

```ts
/// <reference lib="webworker" />
/**
 * 오디오 스레드에서 도는 프로세서. 512샘플 int16 프레임을 메인 스레드로 보낸다.
 *
 * 여기서 하는 일을 최소로 유지한다 — 이 콜백이 늦으면 오디오가 끊긴다. 청크 묶기와
 * 업로드는 메인 스레드가 한다.
 *
 * addModule()로 로드되는 별도 파일이라 앱 번들의 import를 쓸 수 없다. 상수를 복제하되
 * pcm-convert.ts와 같은 값이어야 한다.
 */
const FRAME_SAMPLES = 512;

class PcmProcessor extends AudioWorkletProcessor {
  private rest = new Float32Array(0);

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // 채널이 여럿이면 downmix한다. 첫 채널만 조용히 쓰면 정본이 달라진다 (설계 §2.3).
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (let ch = 0; ch < input.length; ch += 1) {
      for (let i = 0; i < n; i += 1) mono[i] += input[ch][i] / input.length;
    }
    const buf = new Float32Array(this.rest.length + mono.length);
    buf.set(this.rest); buf.set(mono, this.rest.length);
    let at = 0;
    while (buf.length - at >= FRAME_SAMPLES) {
      const f = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const s = Math.max(-1, Math.min(1, buf[at + i]));
        f[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(f.buffer, [f.buffer]);
      at += FRAME_SAMPLES;
    }
    this.rest = buf.slice(at);
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm fe test -- pcm-convert` 그리고 `pnpm fe build`
Expected: 테스트 PASS, 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/meeting/lib/pcm-convert.ts fe/src/features/meeting/lib/pcm-convert.test.ts \
        fe/src/features/meeting/lib/pcm-worklet.ts
git commit -m "feat(fe): raw PCM 변환과 AudioWorklet 프로세서를 더한다

MediaRecorder를 쓰지 않는다. webm/opus는 손실이고 이 파일이 그대로 정본이 되므로 STT와
화자 임베딩 품질을 되돌릴 수 없게 깎는다.

렌더 퀀텀 128을 하드코딩하지 않는다. 스펙이 보장하는 값이 아니라, 다른 값을 주는
브라우저에서 정본이 조용히 달라진다. input[0].length를 기준으로 누적한다. 채널이 여럿이면
downmix한다 — 첫 채널만 쓰면 같은 문제다.

flush는 꼬리를 패딩 없이 그대로 준다. 정본 WAV는 자르지도 늘리지도 않는다."
```

---

## Task 13: `LiveRecorder` — 게이트·링 버퍼·업로더

**Files:**
- Create: `fe/src/features/meeting/lib/live-recorder.ts`, `live-recorder.test.ts`

**Interfaces:**
- Consumes: Task 12의 `FrameAccumulator`·`ChunkAccumulator`·상수
- Produces:
  - `checkCaptureSupport(): Promise<{ ok: true } | { ok: false; reason: 'insecure' | 'denied' | 'no_device' }>`
  - `class LiveRecorder { start(meetingId, deviceId?): Promise<void>; stop(): Promise<void>; onStatus: (s: RecorderStatus) => void }`
  - `type RecorderStatus = { backlogMs: number; failed: 'buffer_overflow' | 'device_ended' | 'upload_failed' | null }`
  - 상수 `BUFFER_LIMIT_MS = 60_000`, `BACKLOG_WARN_MS = 30_000`

**규칙 셋**(설계 §3.3, §5.2~5.4):
1. **in-flight append는 항상 하나.** HTTP 완료 순서는 전송 순서를 보장하지 않는다.
2. **409의 `expected_offset`으로 재동기화한다.** ACK가 유실돼도 중복도 결번도 안 생긴다.
3. **버퍼에 상한이 있다.** 무한 재시도 큐는 탭 OOM이고 OOM은 조용한 손실이다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/lib/live-recorder.test.ts`. 네트워크는 `vi.fn()`으로 주입한다(생성자에 `postChunk`/`postStop`을 받게 설계한다).

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_BYTES } from './pcm-convert';
import { LiveRecorder } from './live-recorder';

const chunkOf = (n = CHUNK_BYTES) => new Uint8Array(n);

describe('LiveRecorder upload loop', () => {
  it('sends one chunk at a time and advances the offset', async () => {
    const seen: number[] = [];
    const post = vi.fn(async (_id, offset: number) => { seen.push(offset); return { ok: true as const, expected: offset + CHUNK_BYTES }; });
    const r = new LiveRecorder({ postChunk: post });
    r.enqueue(chunkOf()); r.enqueue(chunkOf());
    await r.drain();
    expect(seen).toEqual([0, CHUNK_BYTES]);
  });

  it('never has two uploads in flight', async () => {
    let inFlight = 0; let maxInFlight = 0;
    const post = vi.fn(async (_id, offset: number) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post });
    for (let i = 0; i < 4; i += 1) r.enqueue(chunkOf());
    await r.drain();
    expect(maxInFlight).toBe(1);
  });

  it('resyncs from the expected_offset a 409 carries', async () => {
    const seen: number[] = [];
    let first = true;
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset);
      if (first) { first = false; return { ok: false as const, expected: CHUNK_BYTES }; }
      return { ok: true as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post });
    r.enqueue(chunkOf());
    await r.drain();
    // 첫 시도는 0에서 409 → 서버가 이미 받았다는 뜻이므로 그 청크를 버리고 전진한다
    expect(seen).toEqual([0]);
    expect(r.offset).toBe(CHUNK_BYTES);
  });

  it('retries a network failure without skipping the chunk', async () => {
    const seen: number[] = [];
    let calls = 0;
    const post = vi.fn(async (_id, offset: number) => {
      seen.push(offset); calls += 1;
      if (calls === 1) throw new Error('network');
      return { ok: true as const, expected: offset + CHUNK_BYTES };
    });
    const r = new LiveRecorder({ postChunk: post, retryDelayMs: 0 });
    r.enqueue(chunkOf());
    await r.drain();
    expect(seen).toEqual([0, 0]);
  });

  it('fails visibly when the backlog passes the limit', async () => {
    const post = vi.fn(async () => { throw new Error('down'); });
    const statuses: unknown[] = [];
    const r = new LiveRecorder({ postChunk: post, retryDelayMs: 0, bufferLimitMs: 2000 });
    r.onStatus = (s) => statuses.push(s);
    for (let i = 0; i < 5; i += 1) r.enqueue(chunkOf());   // 5.12초 > 2초
    await r.drain();
    expect(r.status.failed).toBe('buffer_overflow');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test -- live-recorder`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 구현한다**

`fe/src/features/meeting/lib/live-recorder.ts`. 핵심은 업로드 루프다. `start()`는 게이트를 통과한 뒤 `AudioContext`를 만들고 워크릿을 붙여 `enqueue`를 먹인다.

```ts
import { ChunkAccumulator, CHUNK_BYTES, FrameAccumulator, SR } from './pcm-convert';

export const BUFFER_LIMIT_MS = 60_000;
export const BACKLOG_WARN_MS = 30_000;
const CHUNK_MS = 1024;

export type CaptureSupport =
  | { ok: true }
  | { ok: false; reason: 'insecure' | 'denied' | 'no_device' };

/** 회의를 만들기 전에 부른다. 원 설계에서 회의 중간에 audio_device_failed로 터지던 실패를
 *  전부 시작 전으로 옮긴다 (설계 §5.2). */
export async function checkCaptureSupport(): Promise<CaptureSupport> {
  // insecure context에서는 navigator.mediaDevices 자체가 undefined다. localhost는
  // secure context지만 http://192.168.x.x는 아니다 — 기기를 분리하는 날 걸린다.
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: 'insecure' };
  try {
    const st = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    if (st?.state === 'denied') return { ok: false, reason: 'denied' };
  } catch { /* permissions.query를 지원하지 않는 브라우저 — 계속 진행한다 */ }
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.kind === 'audioinput')) return { ok: false, reason: 'no_device' };
  return { ok: true };
}

export type RecorderFailure = 'buffer_overflow' | 'device_ended' | 'upload_failed' | 'sample_rate';
export interface RecorderStatus { backlogMs: number; failed: RecorderFailure | null }
export interface PostResult { ok: boolean; expected: number }

export class LiveRecorder {
  offset = 0;
  status: RecorderStatus = { backlogMs: 0, failed: null };
  onStatus: (s: RecorderStatus) => void = () => {};

  private queue: Uint8Array[] = [];
  private pump: Promise<void> | null = null;
  private meetingId = '';
  private startedAt = 0;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private readonly frames = new FrameAccumulator();
  private readonly chunks = new ChunkAccumulator();

  constructor(private readonly deps: {
    postChunk: (id: string, offset: number, body: Uint8Array, elapsedMs: number) => Promise<PostResult>;
    postStop?: (id: string, offset: number, final: number, body: Uint8Array, elapsedMs: number) => Promise<void>;
    retryDelayMs?: number;
    bufferLimitMs?: number;
  }) {}

  enqueue(chunk: Uint8Array) {
    this.queue.push(chunk);
    this.report();
    if ((this.queue.length * CHUNK_MS) > (this.deps.bufferLimitMs ?? BUFFER_LIMIT_MS)) {
      // 무한 재시도 큐는 탭 OOM으로 끝나고 OOM은 조용한 손실이다 (설계 §2.9).
      this.fail('buffer_overflow');
      return;
    }
    if (!this.pump) this.pump = this.run().finally(() => { this.pump = null; });
  }

  /** 큐가 빌 때까지 (또는 실패까지) 기다린다. 테스트와 stop이 쓴다. */
  async drain(): Promise<void> { while (this.pump) await this.pump; }

  private async run(): Promise<void> {
    while (this.queue.length > 0 && this.status.failed === null) {
      const body = this.queue[0];
      let res: PostResult;
      try {
        res = await this.deps.postChunk(this.meetingId, this.offset, body, this.elapsedMs());
      } catch {
        // 네트워크 실패. 청크를 버리지 않고 그대로 다시 보낸다.
        await new Promise((r) => setTimeout(r, this.deps.retryDelayMs ?? 1000));
        continue;
      }
      // 200이든 409든 서버가 알려준 expected가 진실이다. 409면 이 청크는 이미 서버에
      // 있다는 뜻이므로(ACK 유실) 버리고 전진한다 (설계 §3.3).
      this.offset = res.expected;
      this.queue.shift();
      this.report();
    }
  }

  private elapsedMs(): number { return Math.round(performance.now() - this.startedAt); }

  private report() {
    this.status = { ...this.status, backlogMs: this.queue.length * CHUNK_MS };
    this.onStatus(this.status);
  }

  private fail(reason: RecorderFailure) {
    this.status = { ...this.status, failed: reason };
    this.onStatus(this.status);
    void this.teardown();
  }

  async start(meetingId: string, deviceId?: string): Promise<void> {
    this.meetingId = meetingId;
    this.startedAt = performance.now();
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 셋 다 끈다. AGC와 노이즈 억제는 신호를 변형해 ECAPA 임베딩과 정본 STT를 같이
      // 나쁘게 만든다 (설계 §2.4).
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
               channelCount: 1, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    const ctx = new AudioContext({ sampleRate: SR });
    // 요청한 sampleRate를 user agent가 만족하지 않을 수 있다. 48 kHz PCM에 16 kHz 헤더를
    // 씌우면 느리고 낮아진 정본이 조용히 만들어진다 (설계 §2.3).
    if (ctx.sampleRate !== SR) {
      await ctx.close();
      this.stream.getTracks().forEach((t) => t.stop());
      throw new Error(`browser gave ${ctx.sampleRate} Hz, need ${SR} Hz`);
    }
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.ts', import.meta.url));
    const node = new AudioWorkletNode(ctx, 'pcm-processor');
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const chunk = this.chunks.push(new Int16Array(e.data));
      if (chunk) this.enqueue(chunk);
    };
    ctx.createMediaStreamSource(this.stream).connect(node);
    // ended는 장치 제거·권한 회수다. 이걸 안 보면 워크릿이 무음을 계속 내보내 실제
    // 대화가 무음으로 기록된 채 회의가 정상 완료로 표시된다 (설계 §5.3).
    this.stream.getAudioTracks()[0].addEventListener('ended', () => this.fail('device_ended'));
  }

  async stop(): Promise<void> {
    await this.teardown();
    await this.drain();
    const tail = this.chunks.flush();
    await this.deps.postStop?.(this.meetingId, this.offset, this.offset + tail.byteLength, tail, this.elapsedMs());
  }

  private async teardown() {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
```

`FrameAccumulator`는 워크릿이 이미 프레임을 주므로 이 클래스에서는 쓰지 않는다 — import를 지운다. (`pcm-convert.ts`에는 남긴다. 워크릿 없이 테스트하는 코드가 쓴다.)

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm fe test -- live-recorder pcm-convert`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add fe/src/features/meeting/lib/live-recorder.ts fe/src/features/meeting/lib/live-recorder.test.ts \
        fe/src/features/meeting/lib/pcm-convert.ts
git commit -m "feat(fe): 라이브 녹음 캡처와 업로드 루프를 더한다

in-flight는 항상 하나다. HTTP 완료 순서는 전송 시작 순서를 보장하지 않아, 둘을 동시에
보내면 파일에 뒤바뀐 순서로 붙을 수 있다.

200이든 409든 서버의 expected가 진실이다. 409는 그 청크가 이미 서버에 있다는 뜻(ACK
유실)이므로 버리고 전진한다. 네트워크 실패는 다르다 — 청크를 들고 그대로 다시 보낸다.

버퍼에 상한을 뒀다. 무한 재시도 큐는 Wi-Fi 단절에서 무한히 자라 탭 OOM으로 끝나고 OOM은
조용한 손실이다.

AudioContext.sampleRate를 실측 검증한다. 요청한 16 kHz를 user agent가 만족하지 않을 수
있는데, 48 kHz PCM에 16 kHz 헤더를 씌우면 느리고 낮아진 정본이 조용히 만들어진다.

track ended를 본다. 안 보면 장치가 빠진 뒤에도 워크릿이 무음을 계속 내보내 실제 대화가
무음으로 기록된 채 회의가 정상 완료로 표시된다."
```

---

## Task 14: FE 배선 — API 호출, 시작 게이트, 배너

**Files:**
- Modify: `fe/src/features/meeting/api/live.ts`
- Modify: `fe/src/features/meeting/ui/new-meeting-dialog.tsx`, `live-banner.tsx`
- Modify: `fe/src/features/meeting/ui/new-meeting-dialog.live.test.tsx`, `live-banner.test.tsx`

**Interfaces:**
- Consumes: Task 13의 `LiveRecorder`·`checkCaptureSupport`, Task 9·10의 엔드포인트
- Produces:
  - `postLiveChunk(id, offset, body, elapsedMs): Promise<PostResult>`
  - `postLiveStop(id, offset, final, body, elapsedMs): Promise<void>`
  - 다이얼로그가 `checkCaptureSupport()`를 통과해야만 `POST /meetings/live`를 부른다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/meeting/ui/new-meeting-dialog.live.test.tsx`에 추가:

```tsx
it('blocks recording on an insecure context and never creates a meeting', async () => {
  vi.spyOn(navigator, 'mediaDevices', 'get').mockReturnValue(undefined as never);
  const create = vi.spyOn(liveApi, 'startLive');
  render(<NewMeetingDialog open onOpenChange={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: /녹음/ }));
  expect(await screen.findByText(/HTTPS/)).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
});

it('blocks when the microphone permission is denied', async () => {
  mockMediaDevices({ permission: 'denied' });
  render(<NewMeetingDialog open onOpenChange={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: /녹음/ }));
  expect(await screen.findByText(/마이크 권한/)).toBeInTheDocument();
});

it('offers the input devices returned by enumerateDevices', async () => {
  mockMediaDevices({ devices: [{ kind: 'audioinput', deviceId: 'a', label: '내장 마이크' }] });
  render(<NewMeetingDialog open onOpenChange={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: /녹음/ }));
  expect(await screen.findByText('내장 마이크')).toBeInTheDocument();
});
```

`fe/src/features/meeting/ui/live-banner.test.tsx`에 추가:

```tsx
it('warns when the upload backlog grows', () => {
  render(<LiveBanner meeting={recordingMeeting} status={{ backlogMs: 45_000, failed: null }} />);
  expect(screen.getByText(/업로드가 밀리고/)).toBeInTheDocument();
});

it('shows a visible failure when the buffer overflows', () => {
  render(<LiveBanner meeting={recordingMeeting} status={{ backlogMs: 61_000, failed: 'buffer_overflow' }} />);
  expect(screen.getByText(/녹음이 중단/)).toBeInTheDocument();
});

it('shows the capture history when a recording was abandoned', () => {
  render(<LiveBanner meeting={{ ...doneMeeting, capture_error: { code: 'producer_abandoned' } }} status={null} />);
  expect(screen.getByText(/연결이 끊겨/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm fe test -- new-meeting-dialog.live live-banner`
Expected: FAIL

- [ ] **Step 3: API 클라이언트를 쓴다**

`fe/src/features/meeting/api/live.ts`에 추가한다. 기존 함수들의 fetch 래퍼 패턴을 그대로 따른다.

```ts
export interface PostResult { ok: boolean; expected: number }

/** 200과 409를 둘 다 정상 흐름으로 다룬다. 409의 expected_offset이 재동기화의 근거다. */
export async function postLiveChunk(
  id: string, offset: number, body: Uint8Array, elapsedMs: number,
): Promise<PostResult> {
  const res = await fetch(`${API_BASE}/meetings/${id}/live/audio`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Audio-Offset': String(offset),
      'X-Capture-Elapsed': String(elapsedMs),
    },
    body,
  });
  if (res.status === 200) return { ok: true, expected: (await res.json()).expected_offset };
  if (res.status === 409) return { ok: false, expected: (await res.json()).expected_offset };
  throw new Error(`live chunk upload failed: ${res.status}`);
}

export async function postLiveStop(
  id: string, offset: number, final: number, body: Uint8Array, elapsedMs: number,
): Promise<void> {
  const res = await fetch(`${API_BASE}/meetings/${id}/live/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Audio-Offset': String(offset),
      'X-Final-Offset': String(final),
      'X-Capture-Elapsed': String(elapsedMs),
    },
    body,
  });
  if (!res.ok) throw new Error(`live stop failed: ${res.status}`);
}
```

- [ ] **Step 4: 다이얼로그와 배너를 고친다**

다이얼로그: "녹음" 선택 시 `checkCaptureSupport()`를 먼저 부르고, 실패하면 사유별 문구를 띄우고 **`startLive`를 부르지 않는다**.

| reason | 문구 |
|---|---|
| `insecure` | "HTTPS에서만 녹음할 수 있어요. localhost 또는 인증서가 있는 주소로 접속해 주세요." |
| `denied` | "마이크 권한이 거부돼 있어요. 브라우저의 사이트 설정에서 허용해 주세요." |
| `no_device` | "입력 장치를 찾지 못했어요." |

통과하면 `enumerateDevices()` 결과로 장치 선택을 보여주고, 시작 시 `startLive` → `recorder.start(meetingId, deviceId)` 순서로 부른다. 워커 마이크를 설명하던 기존 문구("워커가 도는 Mac의 마이크로 녹음해요", "워커가 마이크를 열면 발화가 흘러와요")를 브라우저 기준으로 바꾼다.

배너: `status.backlogMs > BACKLOG_WARN_MS`면 "업로드가 밀리고 있어요", `status.failed`가 있으면 사유별로 "녹음이 중단됐어요"를 띄운다. `meeting.capture_error?.code === 'producer_abandoned'`면 "브라우저 연결이 끊겨 여기까지 녹음됐어요"를 회의 상세에 남긴다(회의가 `done`이 된 뒤에도 보여야 한다 — 그것이 `capture_error`를 `error`와 나눈 이유다).

`MeetingDetail`(라이브 상태를 들고 있는 곳)에서 `LiveRecorder`를 만들어 `postLiveChunk`/`postLiveStop`을 주입하고, `onStatus`를 배너에 잇는다. 종료 버튼은 `recorder.stop()`을 부른다 — 그것이 큐를 비우고 stop을 보낸다.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm fe test`
Expected: 전체 PASS. 데모 빌드에서 녹음 버튼이 숨는 기존 테스트도 통과해야 한다.

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/meeting
git commit -m "feat(fe): 브라우저 마이크로 녹음하고 배너에 상태를 띄운다

시작 전 게이트가 원 설계에서 회의 중간에 audio_device_failed로 터지던 실패를 전부 앞으로
옮긴다. insecure context·권한 거부·장치 없음이면 회의를 아예 만들지 않는다.

409를 오류로 던지지 않는다. expected_offset이 재동기화의 근거라 정상 흐름의 일부다.

capture_error를 회의가 done이 된 뒤에도 보여준다. error와 나눈 이유가 그것이다 — 최종
패스가 성공해도 '연결이 끊겨 여기까지 녹음됐다'는 남아야 한다."
```

---

## Task 15: 기본값을 browser로 바꾸고 마이크 경로를 정리한다

**이 Task는 앞의 전부가 통과한 뒤에만 한다.** 실제 모델·실제 브라우저 스모크가 먼저다.

**Files:**
- Modify: `be/src/contracts/job-payload.schema.ts` (`buildLiveSessionPayload`)
- Modify: `be/worker/damwha_worker/audio/source.py` (`MicSource` 주석), `be/worker/SMOKE.md`
- Modify: `be/docs/worker-architecture.md`, `be/docs/backlog.md`
- Modify: `be/worker/scripts/smoke_live_session.py`

**Interfaces:**
- Consumes: 전부
- Produces: `buildLiveSessionPayload`가 `source: 'browser'`를 만든다

- [ ] **Step 1: 실기기 스모크를 돌린다**

브라우저에서 실제로 녹음한다. 코드 변경 전에 한다 — 여기서 막히면 Step 2로 가지 않는다.

```bash
pnpm db:up
pnpm be migrate
pnpm worker            # 별 터미널
pnpm dev               # 별 터미널
```

브라우저에서 `http://localhost:5173` → 녹음 시작 → 1분 말하기 → 종료.

확인할 것:
- 발화가 화면에 흘러온다. 지연을 SMOKE.md에 적는다(설계 §6.1의 재측정 항목).
- `meetings/<id>/live.wav`가 자란다. `ffprobe`로 duration이 실제와 맞는지 본다.
- 종료 후 회의가 `uploaded` → `processing` → `done`으로 간다.
- **크래시 테스트:** 녹음 중 API를 `kill -9`하고 다시 띄운다. 브라우저가 409로 재동기화하고 이어지는지 본다.
- **탭 닫기 테스트:** 녹음 중 탭을 닫고 90초 뒤 회의가 `uploaded` + `capture_error=producer_abandoned`가 되는지 본다.

- [ ] **Step 2: 기본값을 바꾼다**

`be/src/contracts/job-payload.schema.ts:262`의 `source: 'mic'`을 `source: 'browser'`로 바꾼다.

`be/test/live.e2e-spec.ts`에서 payload의 `source`를 검증하는 단언을 `'browser'`로 바꾼다.

- [ ] **Step 3: 문서를 고친다**

`be/worker/SMOKE.md`: "라이브 세션" 절의 마이크 권한 절차(터미널 앱 허용)를 삭제하고 브라우저 절차로 바꾼다. Step 1의 실측 지연을 표에 추가한다. `--mic` 스모크는 남기되 "시스템 오디오 구현체를 붙일 때를 위한 참조 경로"라고 명시한다.

`be/docs/worker-architecture.md`: 라이브 세션 절을 다시 쓴다 — 워커는 이제 reader이고, 파일은 API가 쓰며, `sealed_bytes`가 EOF의 권위다.

`be/docs/backlog.md`에 추가한다.

```markdown
- **라이브 녹음 HTTPS** — 브라우저와 워커 Mac을 분리하면 `http://192.168.x.x`가 secure
  context가 아니라 `navigator.mediaDevices`가 undefined다. mkcert/Caddy 또는 Tailscale.
  (설계 §10.1)
- **라이브 녹음 IndexedDB spool** — 지금은 메모리 버퍼라 탭이 죽으면 미전송분을 잃는다.
  같은 Mac에서는 1~2초라 감수했다. (설계 §2.9)
- **시스템 오디오 멀티 트랙** — 브라우저 마이크와 워커의 시스템 오디오는 clock이 달라 한
  WAV에 append할 수 없다. source별 트랙 + sample-clock 메타데이터가 필요하다. (설계 §10.3)
- **Screen Wake Lock** — 시스템 슬립에서 AudioContext가 멈춘다. (설계 §10.4)
- **청크 해시 receipt** — 지금은 "회의 하나에 producer는 브라우저 하나"를 전제한다.
  다중 클라이언트가 생기면 이 전제부터 다시 본다. (설계 §10.2)
```

`be/worker/scripts/smoke_live_session.py`에 `--tail <path>` 모드를 더한다 — `TailSource`를 파일에 붙여 미리보기만 돌린다. `--mic`은 그대로 둔다.

- [ ] **Step 4: 전체를 돌린다**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add be/src/contracts/job-payload.schema.ts be/test/live.e2e-spec.ts be/worker/SMOKE.md \
        be/docs/worker-architecture.md be/docs/backlog.md be/worker/scripts/smoke_live_session.py
git commit -m "feat: 라이브 녹음의 기본 경로를 브라우저로 바꾼다

실기기 스모크가 끝난 뒤에만 이 커밋을 한다. buildLiveSessionPayload가 browser를 만들기
시작하는 지점이라, 워커의 browser 지원이 배포돼 있지 않으면 여기서 영구 실패가 난다.

MicSource는 지우지 않는다. 시스템 오디오 구현체가 들어올 자리의 참조 구현이고,
AudioSource 프로토콜이 실제로 두 구현을 견디는지 보여주는 테스트 대상이다. 다만 기본
경로가 아니고 문서·스모크에서 앞에 나오지 않는다.

SMOKE.md의 마이크 권한 절차가 사라진다. 그 문서가 '이 환경에 마이크 권한을 부여할 수
없어 실행하지 못했다'고 적어둔 바로 그 절차다."
```

---

## Self-Review

**스펙 커버리지.** 스펙의 각 절이 어느 Task로 가는지.

| 스펙 | Task |
|---|---|
| §2.1 브라우저 캡처 / §2.3 AudioWorklet / §2.4 제약 | 12, 13 |
| §2.2 API가 writer / §6 TailSource | 2, 5, 8 |
| §2.5 초당 POST | 9, 13 |
| §2.6 잠금 규율 / §4.3 | 9, 10, 11 |
| §2.7 sealed_bytes / §4.4 봉인 순서 | 1, 7, 10 |
| §2.8 fsync | 2 |
| §2.9 버퍼 상한 | 13 |
| §2.10 capture_error | 1, 7, 10, 11, 14 |
| §2.11 워커 없어도 녹음 / §4.6 actor-aware finalize | 10 |
| §3.1 마이그레이션 | 1 |
| §3.2 payload | 4, 15 |
| §3.3 청크 계약 / §3.3.1 정렬 / §3.3.2 갭 | 9 |
| §3.4 stop 세 경우 | 10 |
| §4.1 시작·파일 생성 | 2, 9 |
| §4.2 recorded_at | 9 |
| §4.5 워커 종료 | 7, 8 |
| §4.7 orphan | 11 |
| §4.8 cancel 잠금 순서 | 3 |
| §5.2 시작 게이트 / §5.3 실패 표기 / §5.4 종료 절차 | 13, 14 |
| §6.1 드리프트 + skip_to | 5, 6, 8 |
| §7 실패 모드 (507 종결자) | 9 |
| §8 구현 순서 | Task 1→15 순서 자체 |
| §9 테스트 | 각 Task의 Step 1 |
| §10 제약 / §12 하지 않는 것 | 15 (backlog) |

**빠졌다가 채운 것 하나.** 첫 초안에는 스펙 §4.1의 "DB commit 후 파일 생성 실패면 job·meeting을 즉시 failed로 닫는다"가 어느 Task에도 없었다. Task 9 Step 6으로 넣었다 — `start()`의 트랜잭션이 커밋된 뒤 `liveAudio.create()`를 부르고, 실패하면 같은 요청 안에서 세션을 닫는다. 안 그러면 `recording` + queued가 남아 `meeting_single_recording_idx`가 다음 녹음을 영구히 막는다. 파일 생성이 먼저이고 DB rollback이 나는 경우는 `create()`가 트랜잭션 뒤에 있으므로 발생하지 않는다.

**타입 일관성 확인.**
- `pcmSize`는 없는 파일에 `-1`을 돌려준다(Task 2). Task 9의 `if (expected < 0)`가 그 규약을 쓴다. ✓
- `get_stop_requested`는 Task 7부터 `(signal, sealed)` 튜플이다. Task 8의 두 호출부가 튜플로 받는다. ✓
- `LiveRecorder`의 `postChunk`는 `{ ok, expected }`를 돌려준다(Task 13). Task 14의 `postLiveChunk`가 같은 모양이다. ✓
- `finalizeByApi(c, job, meeting, sealedBytes)`는 Task 10이 정의하고 Task 11이 쓴다. ✓
- 바이트↔ms는 전부 `32`다: `duration_ms = sealed // 32`(Task 8), `sealedBytes / 32`(Task 10, 11), `accepted / BYTES_PER_MS`(Task 9), `target_pcm / 32`(Task 5). ✓
- `CHUNK_BYTES = 32768`이 `be/src/live/live.service.ts`(Task 9)와 `fe/.../pcm-convert.ts`(Task 12) 양쪽에 있다. 값이 같아야 한다 — 두 곳 다 주석으로 못 박았다. ✓

**플레이스홀더 스캔.** "TBD"·"적절히 처리"·"비슷하게" 없음. Task 14 Step 4만 UI 문구를 표로 주고 JSX를 안 썼는데, 기존 컴포넌트의 구조를 봐야 정확한 코드가 나오는 자리라 의도적이다 — 문구와 조건은 전부 명시했다.
