# 읽기 쉬운 엔티티 ID (UUID → `prefix_n`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시스템 전반의 UUID PK/FK를 읽기 쉬운 순번 ID(`mtg_42`, `spk_3`, `utt_1820`, `clu_5`, `vp_11`, `ue_1820`, `job_8`)로 교체하고, DB·계약 양쪽에서 형식을 강제한다.

**Architecture:** 각 테이블에 Postgres `SEQUENCE` + 인라인 `DEFAULT '<prefix>_' || nextval(...)` + prefix별 `CHECK`. 워커가 INSERT하는 행은 DB DEFAULT로 자동 채번(런타임 코드 무변경). meeting/speaker는 API가 파일 저장 전 트랜잭션 밖에서 `nextId(this.db.pool, ...)`로 선할당. job 페이로드 계약은 zod·pydantic 양쪽에서 prefix 정규식으로 검증.

**Tech Stack:** NestJS(TypeScript) + raw SQL(`pg`), Python 워커(pydantic v2 + psycopg3 `dict_row`), Postgres(pgvector), Jest(testcontainers), pytest.

## Global Constraints

- DB 리셋 가능(운영 데이터 없음) → 데이터 마이그레이션 없음. `001_init.sql`/`002_search.sql`을 **직접 수정**(적용된 마이그레이션 수정 금지 규칙의 의도적 예외).
- ID 정규식은 **세 경계 모두 `^<prefix>_[1-9][0-9]*$`** — `\d` 금지(Python `re`의 `\d`는 유니코드 숫자 허용 → DB `[0-9]`·JS와 어긋남). `mtg_0`·`mtg_001`·UUID 모두 불허.
- API/워커 분리 유지: `src/`에 ML/네트워크 추가 금지. 워커 런타임 코드는 변경하지 않음(smoke 스크립트·pydantic 계약만).
- prefix 매핑: meeting=`mtg`, speaker=`spk`, utterance=`utt`, meeting_cluster=`clu`, voiceprint=`vp`, utterance_embedding=`ue`, job=`job`.
- 스토리지 키는 슬래시 없는 단일 세그먼트 유지(`meetings/<id>/...`) → `StorageService.resolve()` 안전성 불변.
- **커밋 단위 = "never-broken"**: TS 변경(스키마+계약+생성기+컨트롤러+모든 TS 테스트)은 원자적 단위이므로 **Task 1에서 한 번만 커밋**한다. 부분 커밋 금지(중간 상태는 `npm test` 실패). 워커 계약/smoke/docs는 각각 독립적으로 green이므로 별도 커밋.
- 워커 DB 연결은 `dict_row`(`worker/damwha_worker/db.py:7`) → `RETURNING id` 결과는 `fetchone()["id"]`(절대 `[0]` 아님).
- Node 22 (`nvm use`), 테스트는 Docker 필요(testcontainers). 워커는 `cd worker && uv run`.

---

## File Structure

- **Modify** `src/database/migrations/001_init.sql`, `002_search.sql` — 시퀀스/text PK/DEFAULT/CHECK/OWNED BY.
- **Create** `src/common/id.ts` — `nextId` 헬퍼.
- **Modify** `src/meetings/meetings.service.ts`, `src/speakers/speakers.service.ts` — `crypto.randomUUID()` → `nextId`.
- **Modify** `src/meetings/meetings.controller.ts`, `src/speakers/speakers.controller.ts`, `src/meetings/clusters.controller.ts`, `src/search/search.controller.ts` — `ParseUUIDPipe` + Swagger uuid 주석 제거.
- **Modify** `src/search/search.repository.ts` — `::uuid[]` → `::text[]`.
- **Modify** `src/contracts/job-payload.schema.ts` — zod `.uuid()` → prefix 정규식.
- **Create** `test/migration.spec.ts`, `test/id.spec.ts`.
- **Modify** tests `test/job-payload.spec.ts`, `test/contract-fixtures.spec.ts`, `test/storage.spec.ts`, `test/meetings.e2e-spec.ts`, `test/speakers.e2e-spec.ts`.
- **Modify/Create** fixtures `test/fixtures/job-payloads/*.json` (+ `process_meeting.invalid_id.json`).
- **Modify** `worker/damwha_worker/contracts.py`, `worker/tests/test_contracts.py`.
- **Modify** smoke `worker/scripts/smoke_process_meeting.py`, `worker/scripts/smoke_enroll_identify.py`.
- **Modify** living docs `CLAUDE.md`, `AGENTS.md`, `docs/backlog.md`.

---

## Task 1: TypeScript 원자적 변경 (스키마 + 채번 + 계약 + 컨트롤러 + 전 TS 테스트) — 단일 커밋

이 Task는 TDD 순서(테스트 작성 → red → 구현 → green)로 진행하되 **커밋은 마지막 Step 한 번만** 한다. 중간 상태는 `npm test`가 깨지는 것이 정상이며 커밋하지 않는다.

**Files:** 위 File Structure의 `src/**`, `test/**`(워커 제외), 마이그레이션.

**Interfaces:**
- Produces:
  - DB: 모든 PK/FK `text`, DEFAULT `'<prefix>_' || nextval('<prefix>_id_seq')`, `CHECK (id ~ '^<prefix>_[1-9][0-9]*$')`.
  - `nextId(q: Queryable, t: 'meeting' | 'speaker'): Promise<string>` — `Queryable = Pool | PoolClient`. 반환 `mtg_<n>`/`spk_<n>`.
  - zod: `meeting_id`→`/^mtg_[1-9][0-9]*$/`, `speaker_id`→`/^spk_[1-9][0-9]*$/`.

### 1A. 스키마 (TDD: 마이그레이션 테스트 먼저)

- [ ] **Step 1: `test/migration.spec.ts` 작성 (실패 테스트)**

```ts
import { Pool } from 'pg';
import { startTestDb, StartedTestDb } from './db';

describe('migration: readable id defaults + CHECK', () => {
  let db: StartedTestDb; let pool: Pool;
  beforeAll(async () => { db = await startTestDb(); pool = db.pool; });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await db.reset(); });

  const v192 = `[${Array(192).fill(0).join(',')}]`;
  const v1024 = `[${Array(1024).fill(0).join(',')}]`;

  it('generates prefixed ids by DEFAULT for all 7 tables', async () => {
    const spk = (await pool.query(`INSERT INTO speaker(name) VALUES('n') RETURNING id`)).rows[0].id;
    const mtg = (await pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
    const job = (await pool.query(`INSERT INTO job(type,payload) VALUES('process_meeting','{}'::jsonb) RETURNING id`)).rows[0].id;
    const vp = (await pool.query(`INSERT INTO voiceprint(speaker_id,embedding,model,dimension) VALUES($1,$2::vector,'m',192) RETURNING id`, [spk, v192])).rows[0].id;
    const clu = (await pool.query(`INSERT INTO meeting_cluster(meeting_id,diar_label,processing_version) VALUES($1,'S',0) RETURNING id`, [mtg])).rows[0].id;
    const utt = (await pool.query(`INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version) VALUES($1,'S',0,1,0,0) RETURNING id`, [mtg])).rows[0].id;
    const ue = (await pool.query(`INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version) VALUES($1,$2::vector,'m',1024,0) RETURNING id`, [utt, v1024])).rows[0].id;
    expect(spk).toMatch(/^spk_[1-9][0-9]*$/);
    expect(mtg).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(job).toMatch(/^job_[1-9][0-9]*$/);
    expect(vp).toMatch(/^vp_[1-9][0-9]*$/);
    expect(clu).toMatch(/^clu_[1-9][0-9]*$/);
    expect(utt).toMatch(/^utt_[1-9][0-9]*$/);
    expect(ue).toMatch(/^ue_[1-9][0-9]*$/);
  });

  it('rejects explicit non-conforming ids via CHECK (all 7 tables)', async () => {
    const spk = (await pool.query(`INSERT INTO speaker(name) VALUES('n') RETURNING id`)).rows[0].id;
    const mtg = (await pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`)).rows[0].id;
    const utt = (await pool.query(`INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,order_index,processing_version) VALUES($1,'S',0,1,0,0) RETURNING id`, [mtg])).rows[0].id;
    const bad = 'ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca';
    const cases: [string, any[]][] = [
      [`INSERT INTO speaker(id,name) VALUES($1,'n')`, [bad]],
      [`INSERT INTO meeting(id,audio_key) VALUES($1,'k')`, [bad]],
      [`INSERT INTO job(id,type,payload) VALUES($1,'process_meeting','{}'::jsonb)`, [bad]],
      [`INSERT INTO voiceprint(id,speaker_id,embedding,model,dimension) VALUES($1,$2,$3::vector,'m',192)`, [bad, spk, v192]],
      [`INSERT INTO meeting_cluster(id,meeting_id,diar_label,processing_version) VALUES($1,$2,'S',0)`, [bad, mtg]],
      [`INSERT INTO utterance(id,meeting_id,diar_label,start_ms,end_ms,order_index,processing_version) VALUES($1,$2,'S',0,1,1,0)`, [bad, mtg]],
      [`INSERT INTO utterance_embedding(id,utterance_id,embedding,model,dimension,processing_version) VALUES($1,$2,$3::vector,'m',1024,0)`, [bad, utt, v1024]],
    ];
    for (const [sql, params] of cases) {
      await expect(pool.query(sql, params)).rejects.toThrow(/check constraint/);
    }
    await expect(pool.query(`INSERT INTO meeting(id,audio_key) VALUES('mtg_0','k')`)).rejects.toThrow(/check constraint/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest test/migration.spec.ts`
Expected: FAIL — 현재 스키마는 `gen_random_uuid()`라 DEFAULT id가 `mtg_*`가 아니고(UUID), CHECK도 없어 UUID INSERT가 거부되지 않음.

- [ ] **Step 3: `001_init.sql` 전체 재작성**

`src/database/migrations/001_init.sql` 전체를 아래로 교체:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SEQUENCE spk_id_seq;
CREATE TABLE speaker (
  id                text PRIMARY KEY DEFAULT 'spk_' || nextval('spk_id_seq')
                      CHECK (id ~ '^spk_[1-9][0-9]*$'),
  name              text NOT NULL,
  enrollment_status text NOT NULL DEFAULT 'pending'
                      CHECK (enrollment_status IN ('pending','ready','failed')),
  current_job_id    text,
  enrollment_error  jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE spk_id_seq OWNED BY speaker.id;

CREATE SEQUENCE vp_id_seq;
CREATE TABLE voiceprint (
  id                 text PRIMARY KEY DEFAULT 'vp_' || nextval('vp_id_seq')
                       CHECK (id ~ '^vp_[1-9][0-9]*$'),
  speaker_id         text NOT NULL REFERENCES speaker(id) ON DELETE CASCADE,
  embedding          vector(192) NOT NULL,
  model              text NOT NULL,
  dimension          int NOT NULL,
  sample_duration_ms int,
  quality_score      real,
  source             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE vp_id_seq OWNED BY voiceprint.id;
CREATE INDEX voiceprint_model_dim_idx ON voiceprint (model, dimension);
CREATE INDEX voiceprint_embedding_idx ON voiceprint USING hnsw (embedding vector_cosine_ops);

CREATE SEQUENCE mtg_id_seq;
CREATE TABLE meeting (
  id                 text PRIMARY KEY DEFAULT 'mtg_' || nextval('mtg_id_seq')
                       CHECK (id ~ '^mtg_[1-9][0-9]*$'),
  title              text,
  original_filename  text,
  audio_key          text NOT NULL,
  normalized_key     text,
  recorded_at        timestamptz,
  duration_ms        int,
  status             text NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded','processing','done','failed')),
  current_job_id     text,
  processing_version int NOT NULL DEFAULT 0,
  error              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE mtg_id_seq OWNED BY meeting.id;

CREATE SEQUENCE clu_id_seq;
CREATE TABLE meeting_cluster (
  id                  text PRIMARY KEY DEFAULT 'clu_' || nextval('clu_id_seq')
                        CHECK (id ~ '^clu_[1-9][0-9]*$'),
  meeting_id          text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  diar_label          text NOT NULL,
  centroid            vector(192),
  resolved_speaker_id text REFERENCES speaker(id),
  processing_version  int NOT NULL,
  job_id              text,
  UNIQUE (meeting_id, diar_label)
);
ALTER SEQUENCE clu_id_seq OWNED BY meeting_cluster.id;

CREATE SEQUENCE utt_id_seq;
CREATE TABLE utterance (
  id                 text PRIMARY KEY DEFAULT 'utt_' || nextval('utt_id_seq')
                       CHECK (id ~ '^utt_[1-9][0-9]*$'),
  meeting_id         text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  speaker_id         text REFERENCES speaker(id),
  diar_label         text NOT NULL,
  start_ms           int NOT NULL,
  end_ms             int NOT NULL,
  text               text,
  confidence         real,
  status             text NOT NULL DEFAULT 'ok'
                       CHECK (status IN ('ok','silence','transcribe_failed')),
  transcript_error   jsonb,
  order_index        int NOT NULL,
  processing_version int NOT NULL,
  job_id             text,
  UNIQUE (meeting_id, order_index)
);
ALTER SEQUENCE utt_id_seq OWNED BY utterance.id;

CREATE SEQUENCE job_id_seq;
CREATE TABLE job (
  id           text PRIMARY KEY DEFAULT 'job_' || nextval('job_id_seq')
                 CHECK (id ~ '^job_[1-9][0-9]*$'),
  type         text NOT NULL CHECK (type IN ('process_meeting','enroll_speaker')),
  meeting_id   text REFERENCES meeting(id) ON DELETE CASCADE,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed')),
  stage        text CHECK (stage IN
                 ('vad','diarize','identify','stt','align','persist',
                  'extract_embedding','enroll_persist')),
  progress     smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  locked_by    text,
  locked_at    timestamptz,
  error        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE job_id_seq OWNED BY job.id;
CREATE INDEX job_status_created_idx ON job (status, created_at);

ALTER TABLE meeting         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE speaker         ADD FOREIGN KEY (current_job_id) REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE meeting_cluster ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
ALTER TABLE utterance       ADD FOREIGN KEY (job_id)         REFERENCES job(id) ON DELETE SET NULL;
```

- [ ] **Step 4: `002_search.sql`의 utterance_embedding 수정**

`CREATE EXTENSION IF NOT EXISTS pg_bigm;` 다음의 `utterance_embedding` 정의 블록을 아래로 교체(나머지 인덱스·job CHECK ALTER 블록은 그대로):

```sql
CREATE SEQUENCE ue_id_seq;
CREATE TABLE utterance_embedding (
  id                 text PRIMARY KEY DEFAULT 'ue_' || nextval('ue_id_seq')
                       CHECK (id ~ '^ue_[1-9][0-9]*$'),
  utterance_id       text NOT NULL REFERENCES utterance(id) ON DELETE CASCADE,
  embedding          vector(1024) NOT NULL,
  model              text NOT NULL,
  dimension          int  NOT NULL,
  processing_version int  NOT NULL,
  job_id             text REFERENCES job(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utterance_id, model)
);
ALTER SEQUENCE ue_id_seq OWNED BY utterance_embedding.id;
```

- [ ] **Step 5: 마이그레이션 테스트 통과 확인**

Run: `npx jest test/migration.spec.ts`
Expected: PASS (7테이블 DEFAULT prefix + CHECK 거부).

### 1B. 채번 헬퍼 (TDD)

- [ ] **Step 6: `test/id.spec.ts` 작성 (실패 테스트)**

```ts
import { Pool } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { nextId } from '../src/common/id';

describe('nextId', () => {
  let db: StartedTestDb; let pool: Pool;
  beforeAll(async () => { db = await startTestDb(); pool = db.pool; });
  afterAll(async () => { await db.stop(); });

  it('generates sequential prefixed ids', async () => {
    const a = await nextId(pool, 'meeting');
    const b = await nextId(pool, 'meeting');
    expect(a).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(Number(b.slice(4))).toBe(Number(a.slice(4)) + 1);
    expect(await nextId(pool, 'speaker')).toMatch(/^spk_[1-9][0-9]*$/);
  });
});
```

- [ ] **Step 7: 실패 확인**

Run: `npx jest test/id.spec.ts`
Expected: FAIL — `../src/common/id` 모듈 없음(컴파일/임포트 에러).

- [ ] **Step 8: `src/common/id.ts` 구현**

```ts
import { Pool, PoolClient } from 'pg';

export type Queryable = Pool | PoolClient;

const SEQ = { meeting: 'mtg', speaker: 'spk' } as const;

/**
 * 시퀀스에서 사람이 읽기 쉬운 엔티티 id를 채번한다.
 * meeting/speaker는 파일 저장 전 id가 필요하므로 트랜잭션 밖(pool)에서 선할당한다.
 * prefix는 리터럴 맵에서만 오므로 SQL 인젝션 위험 없음.
 */
export async function nextId(q: Queryable, t: keyof typeof SEQ): Promise<string> {
  const p = SEQ[t];
  const { rows } = await q.query<{ id: string }>(`SELECT '${p}_' || nextval('${p}_id_seq') AS id`);
  return rows[0].id;
}
```

- [ ] **Step 9: 통과 확인**

Run: `npx jest test/id.spec.ts`
Expected: PASS.

### 1C. zod 계약 + 픽스처 (TDD)

- [ ] **Step 10: `test/job-payload.spec.ts` 갱신 (실패 테스트)**

UUID 리터럴을 새 형식으로 치환:
- `meetingId: '11111111-1111-1111-1111-111111111111'` → `meetingId: 'mtg_1'` (line 22, 48, 84)
- `meeting_id: '11111111-1111-1111-1111-111111111111'` → `meeting_id: 'mtg_1'` (line 59)
- `speakerId: '22222222-2222-2222-2222-222222222222'` → `speakerId: 'spk_1'` (line 39, 74)

거부 테스트 추가(완전한 valid payload에서 `meeting_id`만 변경 → id가 유일한 실패 원인):

```ts
it('rejects UUID, zero, and unicode-digit ids', () => {
  const base = buildProcessMeetingPayload({
    meetingId: 'mtg_1', audioKey: 'meetings/mtg_1/o.wav', processingVersion: 0, reprocess: false,
  });
  for (const bad of ['ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca', 'mtg_0', 'mtg_1٢']) { // 마지막은 유니코드 숫자
    expect(() => ProcessMeetingPayloadSchema.parse({ ...base, meeting_id: bad })).toThrow();
  }
});
```

- [ ] **Step 11: 픽스처 갱신 + invalid 픽스처 생성**

- `test/fixtures/job-payloads/process_meeting.valid.json`: `meeting_id` → `"mtg_1"`, `audio_key` → `"meetings/mtg_1/original.m4a"`
- `process_meeting.no_version.json`: `meeting_id` → `"mtg_1"`, `audio_key` → `"meetings/mtg_1/original.m4a"`
- `enroll_speaker.valid.json`: `speaker_id` → `"spk_1"`, `audio_key` → `"speakers/spk_1/sample.wav"`
- `index_meeting.valid.json`: `meeting_id` → `"mtg_1"`
- 새 파일 `test/fixtures/job-payloads/process_meeting.invalid_id.json`:

```json
{
  "schema_version": 1,
  "meeting_id": "ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca",
  "audio_key": "meetings/ca8e8f66/original.m4a",
  "processing_version": 2,
  "reprocess": true,
  "models": {
    "whisper_model": "large-v3-turbo",
    "device": "mps",
    "language": "ko",
    "diarization": { "model": "pyannote/speaker-diarization-3.1", "min_speakers": null, "max_speakers": null },
    "embedding": { "model": "speechbrain/spkrec-ecapa-voxceleb", "dimension": 192 }
  },
  "identify": { "threshold": 0.7 }
}
```

- [ ] **Step 12: `test/contract-fixtures.spec.ts`에 거부 케이스 추가**

describe 안에 추가:

```ts
it('rejects process_meeting.invalid_id.json (UUID meeting_id)', () => {
  expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.invalid_id.json'))).toThrow();
});
```

- [ ] **Step 13: 실패 확인**

Run: `npx jest test/job-payload.spec.ts test/contract-fixtures.spec.ts`
Expected: FAIL — 현재 `z.string().uuid()`라 (1) `mtg_1` 빌드 payload가 거부되고, (2) UUID 거부 테스트의 UUID 케이스는 `.uuid()`가 통과시켜 `.toThrow()` 실패.

- [ ] **Step 14: zod 스키마에 prefix 정규식 적용**

`src/contracts/job-payload.schema.ts`:
- line 18 `meeting_id: z.string().uuid(),` → `meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),`
- line 28 `speaker_id: z.string().uuid(),` → `speaker_id: z.string().regex(/^spk_[1-9][0-9]*$/),`
- line 35 `meeting_id: z.string().uuid(),` → `meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),`

- [ ] **Step 15: 통과 확인**

Run: `npx jest test/job-payload.spec.ts test/contract-fixtures.spec.ts`
Expected: PASS.

### 1D. API 서비스 생성기 + 컨트롤러 + 검색

- [ ] **Step 16: `meetings.service.ts` 적용**

- 상단 import 추가: `import { nextId } from '../common/id';`
- line 37 `const meetingId = crypto.randomUUID();` → `const meetingId = await nextId(this.db.pool, 'meeting');`
- `crypto`가 더 이상 안 쓰이면 `import * as crypto from 'crypto';` 제거.

- [ ] **Step 17: `speakers.service.ts` 적용**

- 상단 import 추가: `import { nextId } from '../common/id';`
- line 35 `const speakerId = crypto.randomUUID();` → `const speakerId = await nextId(this.db.pool, 'speaker');`
- `crypto`가 더 이상 안 쓰이면 제거.

- [ ] **Step 18: 컨트롤러 ParseUUIDPipe + Swagger 제거**

- `meetings.controller.ts`: line 2 import에서 `ParseUUIDPipe,` 제거; `@Param('id', ParseUUIDPipe) id: string` → `@Param('id') id: string`(43,47,51,55,60,70,77); line 74 `@ApiParam({ name: 'id', format: 'uuid' })` → `@ApiParam({ name: 'id' })`.
- `speakers.controller.ts`: line 2 `ParseUUIDPipe,` 제거; line 38 `@Param('id') id: string`.
- `clusters.controller.ts`: line 1 import에서 `ParseUUIDPipe` 제거; line 16 `speaker_id` 정의에서 `format: 'uuid',` 제거; line 23/24 `@Param(... ParseUUIDPipe)` → `@Param('id')`/`@Param('clusterId')`.
- `search.controller.ts`: line 27/28 `items: { type: 'string', format: 'uuid' }` → `items: { type: 'string' }`.

- [ ] **Step 19: `search.repository.ts` 캐스팅**

line 31-32: `::uuid[]`(4곳) → `::text[]`. line 26 주석 `(uuid[])` → `(text[])`.

### 1E. 나머지 TS 테스트 + E2E prefix 단언

- [ ] **Step 20: `test/storage.spec.ts` 갱신**

line 20-24 블록 교체:

```ts
  it('builds id-based keys, ignoring untrusted filename', () => {
    expect(svc.meetingKey('mtg_1', '../../evil.MP3')).toBe('meetings/mtg_1/original.mp3');
    expect(svc.speakerKey('spk_1', 'no-ext')).toBe('speakers/spk_1/sample');
  });
```

- [ ] **Step 21: `test/meetings.e2e-spec.ts` 갱신**

- line 27 `expect(res.body.audio_key).toMatch(/^meetings\/.+\/original\.m4a$/);` → 다음 두 줄로 교체(정확한 prefix·키 검증):
```ts
    expect(res.body.id).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(res.body.audio_key).toMatch(/^meetings\/mtg_[1-9][0-9]*\/original\.m4a$/);
```
- line 28 `expect(res.body.current_job_id).toBeTruthy();` → `expect(res.body.current_job_id).toMatch(/^job_[1-9][0-9]*$/);`
- line 161 `const unknown = '99999999-9999-9999-9999-999999999999';` → `const unknown = 'mtg_999999';`
- line 166-171 블록(malformed UUID → 400)을 교체:
```ts
  it('favorite PUT/DELETE → 404 for malformed id', async () => {
    // ParseUUIDPipe 제거: 형식 검증 없음 → 존재하지 않는 id는 404 (400 아님)
    expect((await request(srv()).put('/meetings/not-an-id/favorite')).status).toBe(404);
    expect((await request(srv()).delete('/meetings/not-an-id/favorite')).status).toBe(404);
  });
```
- line 198 `meeting_id=ANY($1::uuid[])` → `meeting_id=ANY($1::text[])`.

- [ ] **Step 22: `test/speakers.e2e-spec.ts` 갱신**

line 26 `expect(res.body.current_job_id).toBeTruthy();` 뒤(또는 교체)로 prefix 단언 추가:
```ts
    expect(res.body.id).toMatch(/^spk_[1-9][0-9]*$/);
    expect(res.body.current_job_id).toMatch(/^job_[1-9][0-9]*$/);
```

### 1F. 통합 검증 + 단일 커밋

- [ ] **Step 23: 전체 TS 스위트 + 타입체크**

Run: `npm test && npx tsc --noEmit -p tsconfig.build.json`
Expected: 전 스위트 PASS + 타입 에러 없음.

- [ ] **Step 24: 단일 커밋**

```bash
git add src/database/migrations/001_init.sql src/database/migrations/002_search.sql \
        src/common/id.ts src/contracts/job-payload.schema.ts \
        src/meetings/meetings.service.ts src/speakers/speakers.service.ts \
        src/meetings/meetings.controller.ts src/speakers/speakers.controller.ts \
        src/meetings/clusters.controller.ts src/search/search.controller.ts src/search/search.repository.ts \
        test/migration.spec.ts test/id.spec.ts test/job-payload.spec.ts test/contract-fixtures.spec.ts \
        test/storage.spec.ts test/meetings.e2e-spec.ts test/speakers.e2e-spec.ts \
        test/fixtures/job-payloads
git commit -m "feat(ids): replace UUID with readable text ids (schema+nextId+contracts+pipes), enforced by CHECK"
```

---

## Task 2: 워커 pydantic 계약 패턴

Task 1 이후 `worker/` pytest는 여전히 green이다(픽스처는 `mtg_1`이고 pydantic은 아직 plain `str`라 통과). 이 Task가 패턴을 추가한다.

**Files:**
- Modify: `worker/damwha_worker/contracts.py`
- Modify: `worker/tests/test_contracts.py`

**Interfaces:**
- Consumes: Task 1의 픽스처(`mtg_1`/`spk_1`, `process_meeting.invalid_id.json`).
- Produces: `ProcessMeetingPayload.meeting_id`/`IndexMeetingPayload.meeting_id` 패턴 `^mtg_[1-9][0-9]*$`, `EnrollSpeakerPayload.speaker_id` 패턴 `^spk_[1-9][0-9]*$`.

- [ ] **Step 1: 실패 테스트 작성**

`worker/tests/test_contracts.py` 끝에 추가:

```python
def test_rejects_uuid_meeting_id():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", load("process_meeting.invalid_id.json"))


def test_rejects_unicode_digit_id():
    from pydantic import ValidationError
    data = load("process_meeting.valid.json") | {"meeting_id": "mtg_1٢"}  # mtg_1٢
    with pytest.raises(ValidationError):
        parse_payload("process_meeting", data)
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/test_contracts.py -k "uuid or unicode" -q`
Expected: FAIL — 현재 `meeting_id: str`라 UUID·유니코드 숫자 모두 통과.

- [ ] **Step 3: pydantic 패턴 적용**

`worker/damwha_worker/contracts.py`:
- import 수정: `from typing import Annotated, Literal`, `from pydantic import BaseModel, StringConstraints`.
- 클래스들 앞에 타입 별칭 추가:
```python
MeetingId = Annotated[str, StringConstraints(pattern=r"^mtg_[1-9][0-9]*$")]
SpeakerId = Annotated[str, StringConstraints(pattern=r"^spk_[1-9][0-9]*$")]
```
- `ProcessMeetingPayload.meeting_id: str` → `meeting_id: MeetingId`
- `EnrollSpeakerPayload.speaker_id: str` → `speaker_id: SpeakerId`
- `IndexMeetingPayload.meeting_id: str` → `meeting_id: MeetingId`

> `\d` 금지 — Python `re`의 `\d`는 유니코드 숫자를 허용한다. 반드시 `[0-9]`.

- [ ] **Step 4: 통과 + 전체 워커 스위트**

Run: `cd worker && uv run pytest -q`
Expected: PASS (새 거부 테스트 + 기존 픽스처 파싱).

- [ ] **Step 5: ruff + Commit**

```bash
cd worker && uv run ruff check . && uv run ruff format .
cd /Users/gim-yeongjae/project/daewha/be
git add worker/damwha_worker/contracts.py worker/tests/test_contracts.py
git commit -m "feat(worker-contracts): enforce prefix id pattern in pydantic ([0-9], not backslash-d)"
```

---

## Task 3: 워커 smoke 스크립트

UUID를 PK로 직접 INSERT하던 부분을 DB DEFAULT 채번(`RETURNING id`)으로 교체. **연결은 `dict_row`이므로 `fetchone()["id"]`**.

**Files:**
- Modify: `worker/scripts/smoke_process_meeting.py`
- Modify: `worker/scripts/smoke_enroll_identify.py`

- [ ] **Step 1: `smoke_process_meeting.py` 채번 교체**

현재(83-92행 부근):
```python
        meeting_id = str(uuid.uuid4())
        audio_key = f"meetings/{meeting_id}/original{audio.suffix.lower()}"
        dst = Path(storage.resolve(audio_key))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(audio, dst)

        conn.execute(
            "INSERT INTO meeting(id, audio_key, status, processing_version) "
            "VALUES (%s,%s,'uploaded',0)",
            (meeting_id, audio_key),
        )
```
교체:
```python
        # id는 DB가 채번 → RETURNING으로 받는다 (UUID 직접 삽입은 CHECK 위반). dict_row → ["id"].
        meeting_id = conn.execute(
            "INSERT INTO meeting(audio_key, status, processing_version) "
            "VALUES ('', 'uploaded', 0) RETURNING id"
        ).fetchone()["id"]
        audio_key = f"meetings/{meeting_id}/original{audio.suffix.lower()}"
        dst = Path(storage.resolve(audio_key))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(audio, dst)
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (audio_key, meeting_id))
```
파일에서 `import uuid`가 더 이상 안 쓰이면 제거.

- [ ] **Step 2: `smoke_enroll_identify.py` — line 117 더미 payload id**

`models = build_models(_process_payload(str(uuid.uuid4()), "x", device), settings)` → `models = build_models(_process_payload("mtg_1", "x", device), settings)` (pydantic 패턴 통과 필요).

- [ ] **Step 3: `smoke_enroll_identify.py` — speaker 채번 (line 121~)**

현재:
```python
        spk_id = str(uuid.uuid4())
        enroll_key = f"speakers/{spk_id}/sample{enroll_audio.suffix.lower()}"
        _copy_into(storage, enroll_key, enroll_audio)
        conn.execute(
            "INSERT INTO speaker(id, name, enrollment_status) VALUES (%s,'Enrolled-A','pending')",
```
(이 INSERT 문 포함 블록을) 교체:
```python
        spk_id = conn.execute(
            "INSERT INTO speaker(name, enrollment_status) VALUES ('Enrolled-A','pending') RETURNING id"
        ).fetchone()["id"]
        enroll_key = f"speakers/{spk_id}/sample{enroll_audio.suffix.lower()}"
        _copy_into(storage, enroll_key, enroll_audio)
```
> 기존 `INSERT INTO speaker(id, name, enrollment_status) VALUES (%s,...)` 문과 그 파라미터를 위 RETURNING으로 대체(중복 INSERT 제거).

- [ ] **Step 4: `smoke_enroll_identify.py` — meeting 채번 (line 169~)**

현재:
```python
        mid = str(uuid.uuid4())
        mkey = f"meetings/{mid}/original{meeting_audio.suffix.lower()}"
        _copy_into(storage, mkey, meeting_audio)
        conn.execute(
            "INSERT INTO meeting(id, audio_key, status, processing_version) "
            "VALUES (%s,%s,'uploaded',0)",
            (mid, mkey),
        )
```
교체:
```python
        mid = conn.execute(
            "INSERT INTO meeting(audio_key, status, processing_version) "
            "VALUES ('', 'uploaded', 0) RETURNING id"
        ).fetchone()["id"]
        mkey = f"meetings/{mid}/original{meeting_audio.suffix.lower()}"
        _copy_into(storage, mkey, meeting_audio)
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (mkey, mid))
```

- [ ] **Step 5: `smoke_enroll_identify.py` — 비교 주석 정리 (line 213)**

현재:
```python
        # psycopg returns uuid columns as uuid.UUID; spk_id is str → compare via str()
        cross_match = any(str(r["speaker_id"]) == spk_id for r in ident if r["speaker_id"])
```
교체(id가 text → 직접 비교):
```python
        cross_match = any(r["speaker_id"] == spk_id for r in ident if r["speaker_id"])
```

- [ ] **Step 6: `smoke_enroll_identify.py` — alice 채번 (line 230~)**

현재:
```python
            alice = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO speaker(id, name, enrollment_status) VALUES (%s,'Alice','ready')",
                (alice,),
            )
            conn.execute(
                "INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source) "
                "VALUES (%s,%s::vector,%s,192,'enroll')",
                (alice, target["centroid"], EMB_MODEL),
            )
```
교체:
```python
            alice = conn.execute(
                "INSERT INTO speaker(name, enrollment_status) VALUES ('Alice','ready') RETURNING id"
            ).fetchone()["id"]
            conn.execute(
                "INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source) "
                "VALUES (%s,%s::vector,%s,192,'enroll')",
                (alice, target["centroid"], EMB_MODEL),
            )
```
파일에서 `import uuid`가 더 이상 안 쓰이면 제거.

- [ ] **Step 7: ruff 정리**

Run: `cd worker && uv run ruff check scripts/ && uv run ruff format scripts/`
Expected: 통과(미사용 `import uuid` 제거 확인).

> 주의: smoke는 실모델·게이트가 필요해 CI에서 실행하지 않는다(`worker/SMOKE.md`). 자동 검증은 ruff/임포트까지. 실 동작은 모델 환경에서 수동 확인(Final Verification).

- [ ] **Step 8: Commit**

```bash
cd /Users/gim-yeongjae/project/daewha/be
git add worker/scripts/smoke_process_meeting.py worker/scripts/smoke_enroll_identify.py
git commit -m "fix(worker-smoke): use DB-generated readable ids (dict_row fetchone[id]) instead of uuid4"
```

---

## Task 4: Living docs

**Files:** `CLAUDE.md`, `AGENTS.md`, `docs/backlog.md`.

- [ ] **Step 1: CLAUDE.md / AGENTS.md 불변식 갱신**

두 파일의 Storage path safety 항목에서 `the DB stores only relative keys (\`meetings/<uuid>/...\`)` → `(\`meetings/<meeting_id>/...\`)`로 치환(두 파일 동일 문장).

- [ ] **Step 2: docs/backlog.md S5 갱신**

S5 행의 `잘못된 날짜·UUID가 DB 오류로 전파 가능` → `잘못된 날짜·ID 형식이 DB 오류로 전파 가능`, 대응 컬럼의 `... ISO 날짜, UUID, 배열 ...` → `... ISO 날짜, ID 형식(^mtg_[1-9][0-9]* 등), 배열 ...`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/backlog.md
git commit -m "docs: reflect readable entity ids in living docs"
```

---

## Final Verification

- [ ] `npm test` 전체 PASS (migration.spec: 7테이블 DEFAULT/CHECK, e2e: `mtg_`/`spk_`/`job_` prefix + 스토리지 키 검증 포함).
- [ ] `npx tsc --noEmit -p tsconfig.build.json` PASS.
- [ ] `cd worker && uv run pytest -q` PASS, `uv run ruff check .` PASS.
- [ ] 각 커밋이 그 시점에 green인지 확인(Task 1 단일 커밋 후 `npm test` green; Task 2 후 pytest green).
- [ ] (실모델 환경, 선택) `smoke_process_meeting.py`/`smoke_enroll_identify.py` 새 형식으로 정상 동작.
