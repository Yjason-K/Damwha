# 읽기 쉬운 엔티티 ID (UUID → `prefix_n`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시스템 전반의 UUID PK/FK를 읽기 쉬운 순번 ID(`mtg_42`, `spk_3`, `utt_1820`, `clu_5`, `vp_11`, `ue_1820`, `job_8`)로 교체하고, DB·계약 양쪽에서 형식을 강제한다.

**Architecture:** 각 테이블에 Postgres `SEQUENCE` + 인라인 `DEFAULT '<prefix>_' || nextval(...)` + prefix별 `CHECK`. 워커가 INSERT하는 행은 DB DEFAULT로 자동 채번(코드 무변경). meeting/speaker는 API가 파일 저장 전 트랜잭션 밖에서 `nextId(this.db.pool, ...)`로 선할당. job 페이로드 계약은 zod·pydantic 양쪽에서 prefix 정규식으로 검증.

**Tech Stack:** NestJS(TypeScript) + raw SQL(`pg`), Python 워커(pydantic v2 + psycopg3), Postgres(pgvector), Jest(testcontainers), pytest.

## Global Constraints

- DB 리셋 가능(운영 데이터 없음) → 데이터 마이그레이션 없음. `001_init.sql`/`002_search.sql`을 **직접 수정**(적용된 마이그레이션 수정 금지 규칙의 의도적 예외).
- ID 정규식은 **세 경계 모두 `^<prefix>_[1-9][0-9]*$`** — `\d` 금지(Python `re`의 `\d`는 유니코드 숫자 허용 → DB `[0-9]`·JS와 어긋남). `mtg_0`·`mtg_001`·UUID 모두 불허.
- API/워커 분리 유지: `src/`에 ML/네트워크 추가 금지. 워커 런타임 코드는 변경하지 않음(smoke 스크립트·pydantic 계약만).
- prefix 매핑: meeting=`mtg`, speaker=`spk`, utterance=`utt`, meeting_cluster=`clu`, voiceprint=`vp`, utterance_embedding=`ue`, job=`job`.
- 스토리지 키는 슬래시 없는 단일 세그먼트 유지(`meetings/<id>/...`) → `StorageService.resolve()` 안전성 불변.
- Node 22 (`nvm use`), 테스트는 Docker 필요(testcontainers). 워커는 `cd worker && uv run`.

---

## File Structure

- **Modify** `src/database/migrations/001_init.sql` — 시퀀스/text PK/DEFAULT/CHECK/OWNED BY.
- **Modify** `src/database/migrations/002_search.sql` — `utterance_embedding` 동일 처리.
- **Create** `src/common/id.ts` — `nextId` 헬퍼.
- **Modify** `src/meetings/meetings.service.ts`, `src/speakers/speakers.service.ts` — `crypto.randomUUID()` → `nextId`.
- **Modify** `src/meetings/meetings.controller.ts`, `src/speakers/speakers.controller.ts`, `src/meetings/clusters.controller.ts` — `ParseUUIDPipe` 제거 + Swagger uuid 주석 제거.
- **Modify** `src/search/search.controller.ts` — Swagger uuid 주석 제거.
- **Modify** `src/search/search.repository.ts` — `::uuid[]` → `::text[]`.
- **Modify** `src/contracts/job-payload.schema.ts` — zod `.uuid()` → prefix 정규식.
- **Modify** `worker/damwha_worker/contracts.py` — pydantic prefix 패턴.
- **Modify** fixtures `test/fixtures/job-payloads/*.json` + 추가 invalid 픽스처.
- **Modify** tests `test/job-payload.spec.ts`, `test/storage.spec.ts`, `test/meetings.e2e-spec.ts`, `test/contract-fixtures.spec.ts`, `worker/tests/test_contracts.py`.
- **Modify** smoke `worker/scripts/smoke_process_meeting.py`, `worker/scripts/smoke_enroll_identify.py`.
- **Modify** living docs `CLAUDE.md`, `AGENTS.md`, `docs/backlog.md`.

---

## Task 1: 스키마 마이그레이션 (001 + 002)

**Files:**
- Modify: `src/database/migrations/001_init.sql`
- Modify: `src/database/migrations/002_search.sql`

**Interfaces:**
- Produces: 모든 PK/FK가 `text`. 채번은 DB DEFAULT(`'<prefix>_' || nextval('<prefix>_id_seq')`). 각 PK에 `CHECK (id ~ '^<prefix>_[1-9][0-9]*$')`.

- [ ] **Step 1: 001_init.sql 전체 재작성**

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

> 변경 요약: 모든 `uuid`→`text`, `gen_random_uuid()`→인라인 DEFAULT, 각 PK에 CHECK, 시퀀스+OWNED BY 추가. CHECK/UNIQUE/인덱스/FK 관계는 동일. (`002_search.sql`이 `ALTER TABLE job ... type IN (... 'index_meeting')`로 확장하므로 001의 job_type_check은 그대로 둔다.)

- [ ] **Step 2: 002_search.sql의 utterance_embedding 수정**

`src/database/migrations/002_search.sql`에서 `utterance_embedding` 블록(현재 line 4~14)을 아래로 교체하고, `CREATE EXTENSION IF NOT EXISTS pg_bigm;` 다음 줄에 시퀀스를 추가:

```sql
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- 의미검색 임베딩 (voiceprint 패턴 미러). 차원 고정 1024 (Phase 2).
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

> 파일의 나머지(인덱스, `utterance_text_bigm_idx`, job CHECK 재정의 ALTER 블록)는 타입과 무관하므로 변경하지 않는다.

- [ ] **Step 3: 깨끗한 DB에 마이그레이션 적용**

```bash
cd /Users/gim-yeongjae/project/daewha/be
docker compose up -d
docker compose exec -T postgres psql -U postgres -d damwha -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
npm run migrate
```
Expected: 모든 마이그레이션이 에러 없이 적용(`001`, `002`, `003`). (DATABASE_URL/사용자명은 `.env` 기준으로 조정.)

- [ ] **Step 4: 채번·CHECK 동작 수동 검증**

```bash
docker compose exec -T postgres psql -U postgres -d damwha -c \
  "INSERT INTO meeting(audio_key) VALUES ('k') RETURNING id;"
docker compose exec -T postgres psql -U postgres -d damwha -c \
  "INSERT INTO meeting(id, audio_key) VALUES ('ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca','k');"
```
Expected: 첫 INSERT는 `mtg_1` 반환. 둘째(UUID)는 `new row ... violates check constraint "meeting_id_check"` 에러로 거부.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/001_init.sql src/database/migrations/002_search.sql
git commit -m "feat(db): readable text IDs via per-table sequences + prefix CHECK"
```

---

## Task 2: zod 계약 + 픽스처 + TS 계약 테스트

**Files:**
- Modify: `src/contracts/job-payload.schema.ts:18,28,35`
- Modify: `test/fixtures/job-payloads/process_meeting.valid.json`, `process_meeting.no_version.json`, `enroll_speaker.valid.json`, `index_meeting.valid.json`
- Create: `test/fixtures/job-payloads/process_meeting.invalid_id.json`
- Modify: `test/job-payload.spec.ts`, `test/contract-fixtures.spec.ts`

**Interfaces:**
- Produces: `ProcessMeetingPayloadSchema`/`IndexMeetingPayloadSchema`의 `meeting_id`는 `/^mtg_[1-9][0-9]*$/`, `EnrollSpeakerPayloadSchema`의 `speaker_id`는 `/^spk_[1-9][0-9]*$/`만 통과.

- [ ] **Step 1: 실패 테스트 작성 (job-payload.spec.ts 갱신)**

`test/job-payload.spec.ts`에서 UUID 리터럴을 새 형식으로 바꾸고 거부 케이스를 추가. 변경할 값:
- `meetingId: '11111111-1111-1111-1111-111111111111'` → `meetingId: 'mtg_1'` (line 22, 48, 84)
- `meeting_id: '11111111-1111-1111-1111-111111111111'` → `meeting_id: 'mtg_1'` (line 59)
- `speakerId: '22222222-2222-2222-2222-222222222222'` → `speakerId: 'spk_1'` (line 39, 74)

그리고 거부 케이스 추가(파일 끝 describe 안). **완전한 valid payload에서 `meeting_id`만 바꿔** id 자체가 유일한 실패 원인이 되게 한다(누락 필드로 인한 가짜 통과 방지):

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

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest test/job-payload.spec.ts`
Expected: FAIL — 현재 `z.string().uuid()`라 (1) `mtg_1`로 바꾼 빌드 헬퍼 테스트가 `.uuid()`에 걸려 throw하고, (2) 새 거부 테스트의 UUID 케이스는 `.uuid()`가 통과시켜 `.toThrow()`가 실패한다.

- [ ] **Step 3: zod 스키마에 prefix 정규식 적용**

`src/contracts/job-payload.schema.ts`:
- line 18: `meeting_id: z.string().uuid(),` → `meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),`
- line 28: `speaker_id: z.string().uuid(),` → `speaker_id: z.string().regex(/^spk_[1-9][0-9]*$/),`
- line 35: `meeting_id: z.string().uuid(),` → `meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),`

- [ ] **Step 4: 픽스처를 새 형식으로 교체**

각 파일에서 UUID 리터럴을 치환:
- `process_meeting.valid.json`: `meeting_id` → `"mtg_1"`, `audio_key` → `"meetings/mtg_1/original.m4a"`
- `process_meeting.no_version.json`: 동일 (`meeting_id` → `"mtg_1"`, `audio_key` → `"meetings/mtg_1/original.m4a"`)
- `enroll_speaker.valid.json`: `speaker_id` → `"spk_1"`, `audio_key` → `"speakers/spk_1/sample.wav"`
- `index_meeting.valid.json`: `meeting_id` → `"mtg_1"`

새 invalid 픽스처 `test/fixtures/job-payloads/process_meeting.invalid_id.json` (양쪽 거부 검증용 — UUID id):

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

- [ ] **Step 5: contract-fixtures.spec.ts에 거부 케이스 추가**

`test/contract-fixtures.spec.ts`의 describe 안에 추가:

```ts
it('rejects process_meeting.invalid_id.json (UUID meeting_id)', () => {
  expect(() => ProcessMeetingPayloadSchema.parse(read('process_meeting.invalid_id.json'))).toThrow();
});
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx jest test/job-payload.spec.ts test/contract-fixtures.spec.ts`
Expected: PASS (전부).

- [ ] **Step 7: Commit**

```bash
git add src/contracts/job-payload.schema.ts test/fixtures/job-payloads test/job-payload.spec.ts test/contract-fixtures.spec.ts
git commit -m "feat(contracts): enforce prefix id regex in zod + update fixtures"
```

---

## Task 3: pydantic 계약 패턴 + Python 계약 테스트

**Files:**
- Modify: `worker/damwha_worker/contracts.py`
- Modify: `worker/tests/test_contracts.py`

**Interfaces:**
- Consumes: Task 2의 픽스처(`mtg_1`/`spk_1` 및 `process_meeting.invalid_id.json`).
- Produces: `ProcessMeetingPayload.meeting_id`/`IndexMeetingPayload.meeting_id`는 `^mtg_[1-9][0-9]*$`, `EnrollSpeakerPayload.speaker_id`는 `^spk_[1-9][0-9]*$` 패턴.

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

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/test_contracts.py -k "uuid or unicode" -q`
Expected: FAIL — 현재 `meeting_id: str`라 UUID·유니코드 숫자 모두 통과.

- [ ] **Step 3: pydantic 패턴 적용**

`worker/damwha_worker/contracts.py`:
- 상단 import에 추가: `from typing import Annotated` (이미 `from typing import Literal` 존재 → 같은 줄에 합치거나 별도 줄), `from pydantic import BaseModel, StringConstraints`.
- 타입 별칭 추가(클래스들 앞):

```python
MeetingId = Annotated[str, StringConstraints(pattern=r"^mtg_[1-9][0-9]*$")]
SpeakerId = Annotated[str, StringConstraints(pattern=r"^spk_[1-9][0-9]*$")]
```

- `ProcessMeetingPayload.meeting_id: str` → `meeting_id: MeetingId`
- `EnrollSpeakerPayload.speaker_id: str` → `speaker_id: SpeakerId`
- `IndexMeetingPayload.meeting_id: str` → `meeting_id: MeetingId`

> `\d` 금지 — Python `re`의 `\d`는 유니코드 숫자를 허용한다. 반드시 `[0-9]`.

- [ ] **Step 4: 테스트 통과 + 기존 픽스처 검증**

Run: `cd worker && uv run pytest tests/test_contracts.py tests/test_contracts_index.py -q`
Expected: PASS (새 거부 테스트 + 기존 `mtg_1`/`spk_1` 픽스처 파싱).

- [ ] **Step 5: ruff + Commit**

```bash
cd worker && uv run ruff check . && uv run ruff format .
cd /Users/gim-yeongjae/project/daewha/be
git add worker/damwha_worker/contracts.py worker/tests/test_contracts.py
git commit -m "feat(worker-contracts): enforce prefix id pattern in pydantic ([0-9], not \\d)"
```

---

## Task 4: API ID 생성 (nextId 헬퍼 + 서비스)

**Files:**
- Create: `src/common/id.ts`
- Modify: `src/meetings/meetings.service.ts:37`
- Modify: `src/speakers/speakers.service.ts:35`
- Test: `test/id.spec.ts` (create)

**Interfaces:**
- Produces: `nextId(q: Queryable, t: 'meeting' | 'speaker'): Promise<string>` — `q`는 `{ query(text, params?) }`를 만족하는 `Pool` 또는 `PoolClient`. 반환은 `mtg_<n>`/`spk_<n>`.

- [ ] **Step 1: 헬퍼 구현 작성**

`src/common/id.ts` 생성:

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

- [ ] **Step 2: 단위 테스트 작성**

`test/id.spec.ts` 생성 (testcontainers 패턴은 기존 `test/db.ts` 헬퍼 사용 — 기존 repository spec 참고):

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
    expect(b).toMatch(/^mtg_[1-9][0-9]*$/);
    expect(Number(b.slice(4))).toBe(Number(a.slice(4)) + 1);
    expect(await nextId(pool, 'speaker')).toMatch(/^spk_[1-9][0-9]*$/);
  });
});
```

> `test/db.ts`는 `startTestDb(): Promise<StartedTestDb>`를 export하고 `StartedTestDb`는 `{ pool, url, stop(), reset() }`. 기존 `test/jobs.repository.spec.ts`와 동일 패턴.

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx jest test/id.spec.ts`
Expected: FAIL — `nextId` 미존재 또는 시퀀스 없음. (구현 추가 후 통과)

- [ ] **Step 4: meetings.service.ts 적용**

`src/meetings/meetings.service.ts`:
- 상단 import 추가: `import { nextId } from '../common/id';`
- line 37 `const meetingId = crypto.randomUUID();` → `const meetingId = await nextId(this.db.pool, 'meeting');`
- 파일에서 `crypto`가 더 이상 안 쓰이면 `import * as crypto from 'crypto';` 제거(다른 사용처 없으면).

- [ ] **Step 5: speakers.service.ts 적용**

`src/speakers/speakers.service.ts`:
- 상단 import 추가: `import { nextId } from '../common/id';`
- line 35 `const speakerId = crypto.randomUUID();` → `const speakerId = await nextId(this.db.pool, 'speaker');`
- `crypto` import가 더 이상 안 쓰이면 제거.

- [ ] **Step 6: 테스트 통과 + 타입체크**

Run: `npx jest test/id.spec.ts && npx tsc --noEmit -p tsconfig.build.json`
Expected: PASS + 타입 에러 없음.

- [ ] **Step 7: Commit**

```bash
git add src/common/id.ts test/id.spec.ts src/meetings/meetings.service.ts src/speakers/speakers.service.ts
git commit -m "feat(api): pre-allocate readable ids via nextId() outside transaction"
```

---

## Task 5: 컨트롤러 파이프/Swagger + 검색 캐스팅

**Files:**
- Modify: `src/meetings/meetings.controller.ts`
- Modify: `src/speakers/speakers.controller.ts`
- Modify: `src/meetings/clusters.controller.ts`
- Modify: `src/search/search.controller.ts`
- Modify: `src/search/search.repository.ts:31-32`

**Interfaces:**
- Produces: 라우트 파라미터가 평범한 `string`(형식 검증 없음). 존재하지 않는 id는 서비스가 404 처리. 검색 필터 배열 캐스팅은 `::text[]`.

- [ ] **Step 1: meetings.controller.ts — ParseUUIDPipe + Swagger 제거**

`src/meetings/meetings.controller.ts`:
- line 2 import에서 `ParseUUIDPipe,` 토큰 제거.
- 모든 `@Param('id', ParseUUIDPipe) id: string` → `@Param('id') id: string` (line 43,47,51,55,60,70,77).
- line 74 `@ApiParam({ name: 'id', format: 'uuid' })` → `@ApiParam({ name: 'id' })` (또는 줄 삭제).

- [ ] **Step 2: speakers.controller.ts**

- line 2 import에서 `ParseUUIDPipe,` 제거.
- line 38 `@Param('id', ParseUUIDPipe) id: string` → `@Param('id') id: string`.

- [ ] **Step 3: clusters.controller.ts**

- line 1 import에서 `ParseUUIDPipe` 제거(`{ Body, Controller, HttpCode, Param, Post }`).
- line 16 `speaker_id: { type: 'string', format: 'uuid', description: '연결할 기존 화자 ID' }` → `format: 'uuid'` 제거: `{ type: 'string', description: '연결할 기존 화자 ID' }`.
- line 23 `@Param('id', ParseUUIDPipe) meetingId: string` → `@Param('id') meetingId: string`.
- line 24 `@Param('clusterId', ParseUUIDPipe) clusterId: string` → `@Param('clusterId') clusterId: string`.

- [ ] **Step 4: search.controller.ts Swagger**

- line 27 `speakerIds: { type: 'array', items: { type: 'string', format: 'uuid' } }` → `items: { type: 'string' }`.
- line 28 `meetingIds` 동일하게 `format: 'uuid'` 제거.

- [ ] **Step 5: search.repository.ts 캐스팅**

`src/search/search.repository.ts` line 31-32:
- `$${f3}::uuid[]` (2곳) → `$${f3}::text[]`
- `$${f4}::uuid[]` (2곳) → `$${f4}::text[]`
- line 26 주석 `f3=speakerIds(uuid[]) f4=meetingIds(uuid[])` → `(text[])`로 갱신.

- [ ] **Step 6: 타입체크**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: 에러 없음(미사용 `ParseUUIDPipe` import 제거 확인).

- [ ] **Step 7: Commit**

```bash
git add src/meetings/meetings.controller.ts src/speakers/speakers.controller.ts src/meetings/clusters.controller.ts src/search/search.controller.ts src/search/search.repository.ts
git commit -m "refactor(api): drop ParseUUIDPipe/uuid swagger, cast search filters as text[]"
```

---

## Task 6: 나머지 TS 테스트 갱신 (storage + e2e)

**Files:**
- Modify: `test/storage.spec.ts:22`
- Modify: `test/meetings.e2e-spec.ts` (line 161, 166-171, 198)

**Interfaces:**
- Consumes: Task 1(스키마), Task 4(채번), Task 5(파이프 제거).

- [ ] **Step 1: storage.spec.ts 새 id로 변경**

`test/storage.spec.ts` line 22: `meetingKey` 입력/기대값의 UUID를 새 형식으로. 입력 id 인자를 `'mtg_1'`로 바꾸고 기대값을:
`.toBe('meetings/mtg_1/original.mp3')`
(line 38의 traversal 거부 테스트 `meetings/../../secret`는 그대로 둔다 — 키 안전성과 무관하게 유지.)

- [ ] **Step 2: e2e — malformed-id 테스트를 404로 변경**

`test/meetings.e2e-spec.ts` line 166-171 블록을 교체:

```ts
it('favorite PUT/DELETE → 404 for malformed id', async () => {
  // ParseUUIDPipe 제거: 형식 검증 없음 → 존재하지 않는 id는 404 (400 아님)
  expect((await request(srv()).put('/meetings/not-an-id/favorite')).status).toBe(404);
  expect((await request(srv()).delete('/meetings/not-an-id/favorite')).status).toBe(404);
});
```

line 161 `const unknown = '99999999-9999-9999-9999-999999999999';` → `const unknown = 'mtg_999999';` (의미 명확화; 두 unknown 테스트 모두 404 유지).

- [ ] **Step 3: e2e — ::uuid[] 캐스팅 변경**

`test/meetings.e2e-spec.ts` line 198: `meeting_id=ANY($1::uuid[])` → `meeting_id=ANY($1::text[])`.

- [ ] **Step 4: 전체 스위트 실행**

Run: `npm test`
Expected: PASS (전 스위트). e2e 업로드 흐름에서 meeting id가 `mtg_<n>`, job이 `job_<n>`으로 생성됨.

- [ ] **Step 5: Commit**

```bash
git add test/storage.spec.ts test/meetings.e2e-spec.ts
git commit -m "test: update storage/e2e for readable ids (malformed → 404, text[] cast)"
```

---

## Task 7: 워커 smoke 스크립트

**Files:**
- Modify: `worker/scripts/smoke_process_meeting.py:83`
- Modify: `worker/scripts/smoke_enroll_identify.py:117,121,170,230` (+ line 213 주석/비교)

**Interfaces:**
- Consumes: Task 1 스키마(UUID PK INSERT는 CHECK로 거부됨), Task 3 pydantic 패턴(payload의 더미 id도 유효해야 함).

- [ ] **Step 1: smoke_process_meeting.py — DB DEFAULT로 채번**

`worker/scripts/smoke_process_meeting.py` line 83-92 영역에서, 미리 만든 `meeting_id`로 `audio_key`를 구성하던 흐름을 "INSERT 후 RETURNING id"로 변경(파일 저장은 id 확정 후). 교체:

```python
        # id는 DB가 채번 → RETURNING으로 받는다 (UUID 직접 삽입은 CHECK 위반)
        meeting_id = conn.execute(
            "INSERT INTO meeting(audio_key, status, processing_version) "
            "VALUES ('', 'uploaded', 0) RETURNING id"
        ).fetchone()[0]
        audio_key = f"meetings/{meeting_id}/original{audio.suffix.lower()}"
        dst = Path(storage.resolve(audio_key))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(audio, dst)
        conn.execute("UPDATE meeting SET audio_key=%s WHERE id=%s", (audio_key, meeting_id))
        payload = _payload(meeting_id, audio_key, device)
```

상단 `import uuid`가 이 파일에서 더 이상 안 쓰이면 제거.

- [ ] **Step 2: smoke_enroll_identify.py — 새 형식 id**

`worker/scripts/smoke_enroll_identify.py`:
- line 117 `build_models(_process_payload(str(uuid.uuid4()), "x", device), settings)` → `build_models(_process_payload("mtg_1", "x", device), settings)` (pydantic 패턴 통과 필요).
- line 121 `spk_id = str(uuid.uuid4())` → speaker는 INSERT 후 RETURNING:
```python
        spk_id = conn.execute(
            "INSERT INTO speaker(name, enrollment_status) VALUES ('Enrolled-A','pending') RETURNING id"
        ).fetchone()[0]
        enroll_key = f"speakers/{spk_id}/sample{enroll_audio.suffix.lower()}"
        _copy_into(storage, enroll_key, enroll_audio)
```
  (기존 line 124~ 의 `INSERT INTO speaker(id, name, ...)`는 위 RETURNING으로 대체되므로 제거.)
- line 170 `mid = str(uuid.uuid4())` → meeting INSERT 후 RETURNING id로 변경(Step 1과 동일 패턴).
- line 230 `alice = str(uuid.uuid4())` → 해당 행의 용도(speaker INSERT 추정)에 맞춰 RETURNING id 또는 유효 형식(`spk_2`)으로. 실제 사용처를 읽고 RETURNING으로 통일.
- line 213 주석("psycopg returns uuid columns as uuid.UUID; spk_id is str → compare via str()") 및 그 비교 로직: id가 `text`가 되어 psycopg가 `str`로 반환하므로 `str()` 래핑 제거 가능 → 단순 `==` 비교로 정리.

- [ ] **Step 3: ruff 정리**

Run: `cd worker && uv run ruff check scripts/ && uv run ruff format scripts/`
Expected: 통과(미사용 `import uuid` 제거 확인).

> 주의: smoke는 실모델·게이트가 필요해 CI에서 실행하지 않는다(`worker/SMOKE.md`). 자동 검증은 ruff/임포트까지. 실 동작은 모델 환경에서 수동 확인(전역 성공 기준 참조).

- [ ] **Step 4: Commit**

```bash
cd /Users/gim-yeongjae/project/daewha/be
git add worker/scripts/smoke_process_meeting.py worker/scripts/smoke_enroll_identify.py
git commit -m "fix(worker-smoke): use DB-generated readable ids instead of uuid4"
```

---

## Task 8: Living docs

**Files:**
- Modify: `CLAUDE.md:34`
- Modify: `AGENTS.md:34`
- Modify: `docs/backlog.md` (S5 행)

**Interfaces:** 없음(문서).

- [ ] **Step 1: CLAUDE.md / AGENTS.md 불변식 갱신**

두 파일의 Storage path safety 항목에서 `the DB stores only relative keys (\`meetings/<uuid>/...\`)` → `(\`meetings/<meeting_id>/...\`)`로 교체. (양 파일의 해당 문장이 동일하므로 같은 치환.)

- [ ] **Step 2: docs/backlog.md S5 갱신**

S5 행의 설명 `잘못된 날짜·UUID가 DB 오류로 전파 가능` 및 대응 `... ISO 날짜, UUID, 배열 ...`에서 "UUID"를 새 ID 형식 검증으로 수정. 예: `잘못된 날짜·ID 형식이 DB 오류로 전파 가능` / `... ISO 날짜, ID 형식(^mtg_[1-9][0-9]*$ 등), 배열 ...`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/backlog.md
git commit -m "docs: reflect readable entity ids in living docs"
```

---

## Final Verification

- [ ] `npm test` 전체 PASS.
- [ ] `npx tsc --noEmit -p tsconfig.build.json` PASS.
- [ ] `cd worker && uv run pytest -q` PASS, `uv run ruff check .` PASS.
- [ ] 깨끗한 DB에 `npm run migrate` 성공 + UUID INSERT가 CHECK로 거부됨(Task 1 Step 4).
- [ ] (실모델 환경, 선택) `smoke_process_meeting.py`/`smoke_enroll_identify.py` 새 형식으로 정상 동작.
