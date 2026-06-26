# Phase 2 검색(하이브리드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** utterance를 한국어 키워드(pg_bigm) + 의미(bge-m3/pgvector) + 구조화 필터로 찾는 하이브리드 검색을 API에 추가하고, 워커에 임베딩 인덱싱 파이프라인을 추가한다.

**Architecture:** 비동기 인덱싱은 새 `index_meeting` job(워커가 utterance를 bge-m3로 임베딩 → `utterance_embedding`)으로, 동기 쿼리 임베딩은 로컬 embed 서비스(워커 코드베이스, bge-m3 호스트)로 처리한다. 검색 SQL(키워드 arm + 의미 arm + RRF 융합)은 전부 NestJS API에 둔다. 두 런타임은 기존대로 `job` 테이블로 통신하되, **쿼리 임베딩만 API→embed 서비스 localhost RPC(불변식의 단일 예외)**.

**Tech Stack:** NestJS(TypeScript, raw SQL via `pg`) · Python 워커(psycopg3, pydantic v2) · Postgres 16 + pgvector + **pg_bigm** · bge-m3(1024d) · FastAPI(embed 서비스) · Jest+supertest+testcontainers / pytest+testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-26-damwha-search-design.md`

## Global Constraints

- Node 22 (`.nvmrc`). 워커는 Python 3.12 + uv.
- **계약 3중 동기화**: `src/contracts/job-payload.schema.ts`(zod) · `worker/damwha_worker/contracts.py`(pydantic) · `001/002` CHECK · `test/fixtures/job-payloads/`(양측 검증). 페이로드 shape/enum 변경 시 모두 함께 바꾼다.
- **검색 임베딩 config는 voiceprint와 분리**: voiceprint는 `EMBEDDING_MODEL`/`EMBEDDING_DIM`(192, ECAPA), 검색은 `SEARCH_EMBEDDING_MODEL`/`SEARCH_EMBEDDING_DIM`(1024, bge-m3). 페이로드 필드는 voiceprint=`embedding`, 검색=`search_embedding`.
- **`src/`에 ML 금지.** 임베딩(인덱싱·쿼리)은 전부 워커 코드베이스. API는 embed 서비스 localhost RPC만.
- **로컬 온리.** embed 서비스 URL은 loopback만 허용(비-loopback은 명시적 override 없으면 기동 거부).
- **소유권 가드.** 워커의 모든 공유 상태 쓰기는 가드: job 가드(`locked_by=worker AND status='running'`) + 자원 가드(meeting `processing_version`). 0 rows = 소유권 상실 → 로컬 결과 폐기.
- **index_meeting 실패는 job만 영향.** `meeting.status`는 절대 `failed`로 바꾸지 않는다(검색 색인 실패가 done 회의를 오염시키면 안 됨).
- 임베딩 단위 = **utterance 1개당 벡터 1개**(`status='ok' AND text IS NOT NULL`만 대상).
- pg_bigm 확장 이름은 `pg_bigm`, GIN opclass는 `gin_bigm_ops`, 함수는 `likequery()`/`bigm_similarity()`.
- 페이지네이션은 **top-K(offset 없음)**. `cand_k = max(SEARCH_CANDIDATE_K(100), limit*5)`, 결과는 `limit+1` 페치 → `hasMore`. 정확 top-K 아닌 bounded approximation.

---

## File Structure

**인프라/마이그레이션**
- Create `docker/postgres-bigm/Dockerfile` — pgvector/pgvector:pg16 + pg_bigm 빌드.
- Create `src/database/migrations/002_search.sql` — pg_bigm 확장, `utterance_embedding` 테이블+인덱스, `utterance.text` bigm GIN, job `type`/`stage` CHECK 갱신.
- Modify `test/db.ts`, `worker/tests/conftest.py`, `worker/scripts/smoke_process_meeting.py` — PG 이미지 → `damwha/postgres-bigm:pg16`.
- Modify `.env.example`, `worker/.env.example` — 신규 env.

**계약**
- Modify `src/contracts/job-payload.schema.ts` — `IndexMeetingPayloadSchema` + `buildIndexMeetingPayload`.
- Modify `src/jobs/jobs.types.ts` — `JobType += 'index_meeting'`.
- Modify `src/config/env.ts` — 검색/embed 서비스 env.
- Modify `worker/damwha_worker/contracts.py` — `SearchEmbedding` + `IndexMeetingPayload` + `parse_payload`.
- Modify `worker/damwha_worker/config.py` — 검색/embed 서비스 settings.
- Create `test/fixtures/job-payloads/index_meeting.valid.json` — 공유 fixture.
- Modify `test/contract-fixtures.spec.ts`, `test/job-payload.spec.ts` — zod 검증.
- Create `worker/tests/test_contracts_index.py` — pydantic 검증.

**워커 인덱싱**
- Modify `worker/damwha_worker/models/base.py` — `TextEmbedder` 프로토콜.
- Modify `worker/damwha_worker/db.py` — `persist_index_meeting`(2-가드 upsert), `fail_job`(job-only), `persist_process_meeting`에 index 잡 in-TX enqueue.
- Create `worker/damwha_worker/pipeline/index_meeting.py` — `run_index_meeting`.
- Modify `worker/damwha_worker/__main__.py` — dispatch 분기(build) + handle_job index 분기 + 실패 분기.
- Create `worker/damwha_worker/models/bge_embed.py` — 실 bge-m3 어댑터(models extra, smoke-only).
- Modify `worker/damwha_worker/models/registry.py` — `build_text_embedder`.
- Create `worker/damwha_worker/embed_service.py` — FastAPI `/embed`+`/health`(models extra, smoke-only).
- Modify `worker/pyproject.toml` — bge-m3/fastapi/uvicorn(models extra).
- Modify `worker/tests/fakes.py` — `FakeTextEmbedder`.

**API 검색**
- Create `src/search/{search.module,search.controller,search.service,search.repository,embed.client}.ts`.
- Modify `src/app.module.ts` — `SearchModule` 등록.
- Modify `src/meetings/{meetings.controller,meetings.service,meetings.repository}.ts` — `POST /:id/reindex` + reconciler.

**테스트**
- Create `test/embed.client.spec.ts`, `test/search.repository.spec.ts`, `test/search.e2e-spec.ts`.
- Create `worker/tests/test_db_index.py`, `worker/tests/test_index_meeting.py`, `worker/tests/test_dispatch_index.py`.

---

## Task 1: 커스텀 Postgres 이미지(pgvector + pg_bigm) + 테스트 하네스 전환

**Files:**
- Create: `docker/postgres-bigm/Dockerfile`
- Modify: `test/db.ts:15`
- Modify: `worker/tests/conftest.py:23`
- Modify: `worker/scripts/smoke_process_meeting.py:75`

**Interfaces:**
- Produces: 로컬 도커 이미지 태그 `damwha/postgres-bigm:pg16` (pgvector + pg_bigm 둘 다 사용 가능). 이후 모든 DB 테스트가 이 이미지를 쓴다.

- [ ] **Step 1: Dockerfile 작성**

Create `docker/postgres-bigm/Dockerfile`:

```dockerfile
# pgvector + pg_bigm 둘 다 포함하는 Postgres 16 이미지.
# pgvector는 베이스에 이미 있고, pg_bigm은 소스에서 빌드한다.
FROM pgvector/pgvector:pg16

USER root
ARG PG_BIGM_VERSION=1.2-20240606
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential postgresql-server-dev-16 wget ca-certificates; \
    wget -O /tmp/pg_bigm.tar.gz \
        "https://github.com/pgbigm/pg_bigm/archive/refs/tags/v${PG_BIGM_VERSION}.tar.gz"; \
    mkdir -p /tmp/pg_bigm; \
    tar -xzf /tmp/pg_bigm.tar.gz -C /tmp/pg_bigm --strip-components=1; \
    cd /tmp/pg_bigm; \
    make USE_PGXS=1; \
    make USE_PGXS=1 install; \
    apt-get purge -y build-essential postgresql-server-dev-16 wget; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/* /tmp/pg_bigm*
USER postgres
```

- [ ] **Step 2: 이미지 빌드**

Run:
```bash
docker build -t damwha/postgres-bigm:pg16 docker/postgres-bigm
```
Expected: 빌드 성공, 마지막에 `naming to docker.io/damwha/postgres-bigm:pg16`.

- [ ] **Step 3: pg_bigm 동작 수동 검증**

Run:
```bash
docker run --rm -e POSTGRES_PASSWORD=x -d --name bigmtest damwha/postgres-bigm:pg16
sleep 5
docker exec bigmtest psql -U postgres -c \
  "CREATE EXTENSION pg_bigm; SELECT bigm_similarity('기획회의','기획회의에서') AS sim, likequery('UI 개선') AS lq;"
docker rm -f bigmtest
```
Expected: `sim`이 0~1 실수, `lq`가 `%UI 개선%` 형태로 출력(에러 없음).

- [ ] **Step 4: 테스트 하네스 이미지 문자열 교체 (API)**

In `test/db.ts`, line 15, change:
```typescript
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
```
to:
```typescript
  container = await new PostgreSqlContainer('damwha/postgres-bigm:pg16').start();
```

- [ ] **Step 5: 테스트 하네스 이미지 문자열 교체 (워커 conftest + smoke)**

In `worker/tests/conftest.py`, line 23, change:
```python
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
```
to:
```python
    with PostgresContainer("damwha/postgres-bigm:pg16") as pg:
```

In `worker/scripts/smoke_process_meeting.py`, line 75, make the same `pgvector/pgvector:pg16` → `damwha/postgres-bigm:pg16` change.

- [ ] **Step 6: 기존 테스트가 새 이미지로 여전히 통과하는지 확인**

Run:
```bash
npx jest test/jobs.repository.spec.ts
cd worker && uv run pytest tests/test_db_persist.py -q
```
Expected: 둘 다 PASS (새 이미지에서 기존 스키마/SQL 정상).

- [ ] **Step 7: Commit**

```bash
git add docker/postgres-bigm/Dockerfile test/db.ts worker/tests/conftest.py worker/scripts/smoke_process_meeting.py
git commit -m "build: custom postgres image (pgvector + pg_bigm) + switch test harnesses"
```

---

## Task 2: 마이그레이션 002 — utterance_embedding + pg_bigm 인덱스 + job enum 확장

**Files:**
- Create: `src/database/migrations/002_search.sql`
- Test: `test/migration.spec.ts` (modify — append assertions)

**Interfaces:**
- Produces: `utterance_embedding(id, utterance_id, embedding vector(1024), model, dimension, processing_version, job_id, created_at)` + HNSW/`model,dimension` 인덱스; `utterance.text`의 `gin_bigm_ops` GIN 인덱스; `job.type`에 `index_meeting`, `job.stage`에 `embed` 허용.

- [ ] **Step 1: 마이그레이션 테스트 작성 (실패 먼저)**

In `test/migration.spec.ts`, add a test (mirror existing structure — uses `startTestDb`):

```typescript
  it('002: utterance_embedding + bigm index + job index_meeting/embed allowed', async () => {
    // utterance_embedding 테이블과 인덱스 존재
    const tbl = await db.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name='utterance_embedding'`,
    );
    expect(tbl.rowCount).toBe(1);
    const bigm = await db.pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='utterance_text_bigm_idx'`);
    expect(bigm.rowCount).toBe(1);

    // job이 index_meeting type + embed stage를 받아들임
    const m = await db.pool.query(`INSERT INTO meeting(audio_key) VALUES('k') RETURNING id`);
    const job = await db.pool.query(
      `INSERT INTO job(type, meeting_id, payload, stage) VALUES('index_meeting',$1,'{}'::jsonb,'embed') RETURNING type, stage`,
      [m.rows[0].id],
    );
    expect(job.rows[0].type).toBe('index_meeting');
    expect(job.rows[0].stage).toBe('embed');

    // vector(1024) 임베딩 insert 가능
    const u = await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'안녕','ok',0,0) RETURNING id`,
      [m.rows[0].id],
    );
    const vec = '[' + Array(1024).fill(0.1).join(',') + ']';
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`,
      [u.rows[0].id, vec],
    );
    const cnt = await db.pool.query(`SELECT count(*)::int c FROM utterance_embedding`);
    expect(cnt.rows[0].c).toBe(1);
  });
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `npx jest test/migration.spec.ts -t "002"`
Expected: FAIL (002가 아직 없어 `utterance_embedding` 테이블/`utterance_text_bigm_idx`가 부재).

- [ ] **Step 3: 마이그레이션 SQL 작성**

Create `src/database/migrations/002_search.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- 의미검색 임베딩 (voiceprint 패턴 미러). 차원 고정 1024 (Phase 2).
CREATE TABLE utterance_embedding (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance_id       uuid NOT NULL REFERENCES utterance(id) ON DELETE CASCADE,
  embedding          vector(1024) NOT NULL,
  model              text NOT NULL,
  dimension          int  NOT NULL,
  processing_version int  NOT NULL,
  job_id             uuid REFERENCES job(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utterance_id, model)
);
CREATE INDEX utterance_embedding_model_dim_idx ON utterance_embedding (model, dimension);
CREATE INDEX utterance_embedding_hnsw_idx ON utterance_embedding
  USING hnsw (embedding vector_cosine_ops);

-- 키워드 검색 (pg_bigm bigram GIN; 색인·쿼리 대칭).
CREATE INDEX utterance_text_bigm_idx ON utterance USING gin (text gin_bigm_ops);

-- job enum 확장: 새 type/stage 허용 (001의 익명 CHECK 이름은 Postgres 기본 규칙).
ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed'));
```

- [ ] **Step 4: 재실행 — 통과 확인**

`runMigrations`는 `src/database/migrations/*.sql`를 파일명 순서로 적용하므로 002 파일이 있으면 자동 적용된다.
Run: `npx jest test/migration.spec.ts -t "002"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/002_search.sql test/migration.spec.ts
git commit -m "feat(db): 002 search migration — utterance_embedding, bigm index, index_meeting/embed enum"
```

---

## Task 3: 계약(zod) — IndexMeetingPayload + 빌더 + JobType + 검색 env + fixture

**Files:**
- Modify: `src/contracts/job-payload.schema.ts`
- Modify: `src/jobs/jobs.types.ts:4`
- Modify: `src/config/env.ts`
- Create: `test/fixtures/job-payloads/index_meeting.valid.json`
- Modify: `test/contract-fixtures.spec.ts`
- Modify: `test/job-payload.spec.ts`

**Interfaces:**
- Produces (TS): `IndexMeetingPayloadSchema`, `IndexMeetingPayload` 타입, `buildIndexMeetingPayload({meetingId, processingVersion}): IndexMeetingPayload`. env: `SEARCH_EMBEDDING_MODEL`(default `BAAI/bge-m3`), `SEARCH_EMBEDDING_DIM`(default 1024).
- Payload shape (계약): `{ schema_version:1, meeting_id:uuid, processing_version:int, search_embedding:{ model:string, dimension:int } }`.

- [ ] **Step 1: env에 검색 임베딩 변수 추가**

In `src/config/env.ts`, add to `EnvSchema` (after `IDENTIFY_THRESHOLD` line):
```typescript
  SEARCH_EMBEDDING_MODEL: z.string().default('BAAI/bge-m3'),
  SEARCH_EMBEDDING_DIM: z.coerce.number().default(1024),
```

- [ ] **Step 2: JobType 확장**

In `src/jobs/jobs.types.ts`, line 4, change:
```typescript
export type JobType = 'process_meeting' | 'enroll_speaker';
```
to:
```typescript
export type JobType = 'process_meeting' | 'enroll_speaker' | 'index_meeting';
```

- [ ] **Step 3: 공유 fixture 작성**

Create `test/fixtures/job-payloads/index_meeting.valid.json`:
```json
{
  "schema_version": 1,
  "meeting_id": "11111111-1111-1111-1111-111111111111",
  "processing_version": 0,
  "search_embedding": { "model": "BAAI/bge-m3", "dimension": 1024 }
}
```

- [ ] **Step 4: 실패 테스트 — zod 스키마/빌더 검증**

In `test/contract-fixtures.spec.ts`, add import + test:
```typescript
import {
  ProcessMeetingPayloadSchema,
  EnrollSpeakerPayloadSchema,
  IndexMeetingPayloadSchema,
} from '../src/contracts/job-payload.schema';
```
```typescript
  it('validates index_meeting.valid.json', () => {
    expect(() => IndexMeetingPayloadSchema.parse(read('index_meeting.valid.json'))).not.toThrow();
  });
```

In `test/job-payload.spec.ts`, add:
```typescript
import { buildIndexMeetingPayload, IndexMeetingPayloadSchema } from '../src/contracts/job-payload.schema';
```
```typescript
  it('builds + validates an index_meeting payload from ENV', () => {
    process.env.SEARCH_EMBEDDING_MODEL = 'BAAI/bge-m3';
    process.env.SEARCH_EMBEDDING_DIM = '1024';
    const p = buildIndexMeetingPayload({
      meetingId: '11111111-1111-1111-1111-111111111111',
      processingVersion: 3,
    });
    expect(p.schema_version).toBe(1);
    expect(p.processing_version).toBe(3);
    expect(p.search_embedding).toEqual({ model: 'BAAI/bge-m3', dimension: 1024 });
    expect(() => IndexMeetingPayloadSchema.parse(p)).not.toThrow();
  });
```

- [ ] **Step 5: 실행 — 실패 확인**

Run: `npx jest test/contract-fixtures.spec.ts test/job-payload.spec.ts`
Expected: FAIL (`IndexMeetingPayloadSchema`/`buildIndexMeetingPayload` 미정의).

- [ ] **Step 6: zod 스키마 + 빌더 구현**

In `src/contracts/job-payload.schema.ts`, add after `EnrollSpeakerPayloadSchema`:
```typescript
export const IndexMeetingPayloadSchema = z.object({
  schema_version: z.literal(1).default(1),
  meeting_id: z.string().uuid(),
  processing_version: z.number().int().nonnegative(),
  search_embedding: z.object({ model: z.string(), dimension: z.number().int() }),
});

export type IndexMeetingPayload = z.infer<typeof IndexMeetingPayloadSchema>;

export function buildIndexMeetingPayload(args: {
  meetingId: string; processingVersion: number;
}): IndexMeetingPayload {
  const env = loadEnv();
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    processing_version: args.processingVersion,
    search_embedding: { model: env.SEARCH_EMBEDDING_MODEL, dimension: env.SEARCH_EMBEDDING_DIM },
  };
}
```

- [ ] **Step 7: 실행 — 통과 확인**

Run: `npx jest test/contract-fixtures.spec.ts test/job-payload.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/contracts/job-payload.schema.ts src/jobs/jobs.types.ts src/config/env.ts test/fixtures/job-payloads/index_meeting.valid.json test/contract-fixtures.spec.ts test/job-payload.spec.ts
git commit -m "feat(contract): index_meeting payload (zod) + search embedding env + shared fixture"
```

---

## Task 4: 계약(pydantic) — SearchEmbedding + IndexMeetingPayload + parse_payload + 워커 config

**Files:**
- Modify: `worker/damwha_worker/contracts.py`
- Modify: `worker/damwha_worker/config.py`
- Create: `worker/tests/test_contracts_index.py`

**Interfaces:**
- Consumes: `test/fixtures/job-payloads/index_meeting.valid.json` (Task 3).
- Produces (Python): `IndexMeetingPayload(schema_version, meeting_id, processing_version, search_embedding: SearchEmbedding)`; `parse_payload('index_meeting', data) -> IndexMeetingPayload`. Settings: `search_embedding_model`(default `BAAI/bge-m3`), `search_embedding_dim`(default 1024), `embed_service_host`(default `127.0.0.1`), `embed_service_port`(default 8100).

- [ ] **Step 1: 실패 테스트 작성 (공유 fixture를 pydantic으로 검증)**

Create `worker/tests/test_contracts_index.py`:
```python
import json
from pathlib import Path

from damwha_worker.contracts import IndexMeetingPayload, parse_payload

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def _read(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_index_meeting_fixture_validates():
    p = parse_payload("index_meeting", _read("index_meeting.valid.json"))
    assert isinstance(p, IndexMeetingPayload)
    assert p.processing_version == 0
    assert p.search_embedding.model == "BAAI/bge-m3"
    assert p.search_embedding.dimension == 1024
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `cd worker && uv run pytest tests/test_contracts_index.py -q`
Expected: FAIL (`IndexMeetingPayload` import 불가).

- [ ] **Step 3: pydantic 모델 + parse_payload 구현**

In `worker/damwha_worker/contracts.py`, add `SearchEmbedding` + `IndexMeetingPayload` and extend `parse_payload`:
```python
class SearchEmbedding(BaseModel):
    model: str
    dimension: int


class IndexMeetingPayload(BaseModel):
    schema_version: int = 1
    meeting_id: str
    processing_version: int
    search_embedding: SearchEmbedding
```
In `parse_payload`, before the final `raise ValueError`, add:
```python
    if job_type == "index_meeting":
        return IndexMeetingPayload.model_validate(data)
```

- [ ] **Step 4: 워커 config에 검색/embed 서비스 settings 추가**

In `worker/damwha_worker/config.py`, add fields to `Settings` (after `model_cache_dir`):
```python
    search_embedding_model: str = "BAAI/bge-m3"
    search_embedding_dim: int = 1024
    embed_service_host: str = "127.0.0.1"
    embed_service_port: int = 8100
```

- [ ] **Step 5: 실행 — 통과 확인**

Run: `cd worker && uv run pytest tests/test_contracts_index.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/damwha_worker/contracts.py worker/damwha_worker/config.py worker/tests/test_contracts_index.py
git commit -m "feat(worker): index_meeting payload (pydantic) + search/embed config"
```

---

## Task 5: 워커 db — persist_index_meeting (2-가드 upsert) + fail_job (job-only)

**Files:**
- Modify: `worker/damwha_worker/db.py`
- Modify: `worker/tests/fakes.py`
- Create: `worker/tests/test_db_index.py`

**Interfaces:**
- Produces (Python):
  - `persist_index_meeting(conn, *, job_id, worker_id, meeting_id, processing_version, model, dimension, embeddings) -> str` — `embeddings: list[dict]` 각 `{ "utterance_id": str, "embedding": list[float] }`. 반환 `"committed"`/`"discarded"`/`"lost"`.
  - `fail_job(conn, job_id, worker_id, error: dict) -> bool` — job만 `status='failed'`+error (자원 테이블 미터치). 반환 `True`(소유) / `False`(소유 상실).

- [ ] **Step 1: FakeTextEmbedder 추가**

In `worker/tests/fakes.py`, append:
```python
class FakeTextEmbedder:
    def __init__(self, vectors_by_text: dict[str, list[float]] | None = None, dim: int = 1024) -> None:
        self._by_text = vectors_by_text or {}
        self._dim = dim

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._by_text.get(t, [0.0] * self._dim) for t in texts]
```

- [ ] **Step 2: 실패 테스트 작성**

Create `worker/tests/test_db_index.py`:
```python
from damwha_worker import db
from tests.conftest import seed_job, seed_meeting


def _indexable_utterance(conn, meeting_id, *, order_index=0, status="ok", text="안녕", pv=0):
    row = conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,%s,%s,%s,%s) RETURNING id",
        (meeting_id, text, status, order_index, pv),
    ).fetchone()
    return row["id"]


def _claimed_index_job(conn, *, pv=0):
    mid = seed_meeting(conn, status="done", processing_version=pv)
    jid = seed_job(conn, type="index_meeting", meeting_id=mid)
    db.claim(conn, "w1")  # → running, locked_by=w1
    return mid, jid


def test_persist_index_commits_embeddings(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    uid = _indexable_utterance(conn, mid, pv=0)
    out = db.persist_index_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        model="BAAI/bge-m3", dimension=1024,
        embeddings=[{"utterance_id": uid, "embedding": [0.1] * 1024}],
    )
    assert out == "committed"
    n = conn.execute("SELECT count(*) c FROM utterance_embedding WHERE utterance_id=%s", (uid,)).fetchone()["c"]
    assert n == 1
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "done"
    # meeting은 그대로 done
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"


def test_persist_index_discarded_when_meeting_superseded(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    uid = _indexable_utterance(conn, mid, pv=0)
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (mid,))  # 새 reprocess
    out = db.persist_index_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        model="BAAI/bge-m3", dimension=1024,
        embeddings=[{"utterance_id": uid, "embedding": [0.1] * 1024}],
    )
    assert out == "discarded"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0
    j = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert j["status"] == "done" and j["error"]["code"] == "discarded_by_stale_guard"


def test_persist_index_lost_when_job_not_owned(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    uid = _indexable_utterance(conn, mid, pv=0)
    out = db.persist_index_meeting(
        conn, job_id=jid, worker_id="OTHER", meeting_id=mid, processing_version=0,
        model="BAAI/bge-m3", dimension=1024,
        embeddings=[{"utterance_id": uid, "embedding": [0.1] * 1024}],
    )
    assert out == "lost"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0


def test_fail_job_marks_job_only(conn):
    mid, jid = _claimed_index_job(conn, pv=0)
    ok = db.fail_job(conn, jid, "w1", {"code": "model_load_failed", "message": "boom"})
    assert ok is True
    assert conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    # meeting은 절대 failed가 되지 않는다
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"
```

- [ ] **Step 3: 실행 — 실패 확인**

Run: `cd worker && uv run pytest tests/test_db_index.py -q`
Expected: FAIL (`persist_index_meeting`/`fail_job` 미정의).

- [ ] **Step 4: db 함수 구현**

In `worker/damwha_worker/db.py`, add (mirror `persist_process_meeting`의 2-가드 + `_vec`/`Jsonb`/`_Abort` 재사용):
```python
def persist_index_meeting(
    conn, *, job_id, worker_id, meeting_id, processing_version, model, dimension, embeddings
) -> str:
    try:
        with conn.transaction():
            # (1) job ownership guard
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            # (2) meeting stale guard: 더 새 reprocess가 pv를 올렸으면 discard
            mrow = conn.execute(
                "SELECT processing_version FROM meeting WHERE id=%s", (meeting_id,)
            ).fetchone()
            if mrow is None or mrow["processing_version"] != processing_version:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (
                        Jsonb({
                            "code": "discarded_by_stale_guard",
                            "message": "meeting superseded by newer processing_version",
                            "stage": "embed",
                            "kind": None,
                        }),
                        job_id,
                    ),
                )
                return "discarded"
            # upsert embeddings (UNIQUE utterance_id, model)
            for e in embeddings:
                conn.execute(
                    """
                    INSERT INTO utterance_embedding(utterance_id, embedding, model, dimension,
                        processing_version, job_id)
                    VALUES (%s,%s::vector,%s,%s,%s,%s)
                    ON CONFLICT (utterance_id, model)
                    DO UPDATE SET embedding=EXCLUDED.embedding, dimension=EXCLUDED.dimension,
                        processing_version=EXCLUDED.processing_version, job_id=EXCLUDED.job_id,
                        created_at=now()
                    """,
                    (e["utterance_id"], _vec(e["embedding"]), model, dimension, processing_version, job_id),
                )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def fail_job(conn, job_id: str, worker_id: str, error: dict) -> bool:
    cur = conn.execute(
        "UPDATE job SET status='failed', error=%s, updated_at=now() "
        "WHERE id=%s AND locked_by=%s AND status='running'",
        (Jsonb(error), job_id, worker_id),
    )
    return cur.rowcount > 0
```

- [ ] **Step 5: 실행 — 통과 확인**

Run: `cd worker && uv run pytest tests/test_db_index.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/damwha_worker/db.py worker/tests/fakes.py worker/tests/test_db_index.py
git commit -m "feat(worker): persist_index_meeting (2-guard upsert) + fail_job (job-only)"
```

---

## Task 6: 워커 TextEmbedder 프로토콜 + run_index_meeting 파이프라인

**Files:**
- Modify: `worker/damwha_worker/models/base.py`
- Create: `worker/damwha_worker/pipeline/index_meeting.py`
- Create: `worker/tests/test_index_meeting.py`

**Interfaces:**
- Consumes: `db.persist_index_meeting` (Task 5), `db.set_stage`.
- Produces (Python):
  - `TextEmbedder` Protocol: `embed_texts(self, texts: list[str]) -> list[list[float]]`.
  - `run_index_meeting(conn, job, payload: IndexMeetingPayload, text_embedder: TextEmbedder, *, worker_id) -> str` — `"committed"`/`"discarded"`/`"lost"`. (색인 대상 0개도 빈 임베딩으로 동일 2-가드 TX를 타고 `"committed"` — 별도 noop 분기 없음.)

- [ ] **Step 1: TextEmbedder 프로토콜 추가**

In `worker/damwha_worker/models/base.py`, append:
```python
class TextEmbedder(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...
```

- [ ] **Step 2: 실패 테스트 작성**

Create `worker/tests/test_index_meeting.py`:
```python
from damwha_worker import db
from damwha_worker.contracts import IndexMeetingPayload
from damwha_worker.pipeline.index_meeting import run_index_meeting
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeTextEmbedder


def _payload(mid, pv=0):
    return IndexMeetingPayload(
        meeting_id=mid, processing_version=pv,
        search_embedding={"model": "BAAI/bge-m3", "dimension": 1024},
    )


def _seed_utts(conn, mid, rows):
    # rows: list of (order_index, status, text)
    for oi, status, text in rows:
        conn.execute(
            "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
            "VALUES (%s,'SPEAKER_00',0,1000,%s,%s,%s,0)",
            (mid, text, status, oi),
        )


def _claim(conn, mid):
    jid = seed_job(conn, type="index_meeting", meeting_id=mid)
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def test_index_embeds_only_ok_text_utterances(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "ok", "안녕하세요"), (1, "silence", None), (2, "ok", None)])
    job = _claim(conn, mid)
    out = run_index_meeting(conn, job, _payload(mid), FakeTextEmbedder(), worker_id="w1")
    assert out == "committed"
    # status='ok' AND text IS NOT NULL 인 1건만 임베딩
    n = conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"]
    assert n == 1


def test_index_commits_zero_when_no_indexable(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "silence", None)])
    job = _claim(conn, mid)
    out = run_index_meeting(conn, job, _payload(mid), FakeTextEmbedder(), worker_id="w1")
    assert out == "committed"  # 색인 대상 0개도 동일한 2-가드 TX를 타고 job done
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0
    assert conn.execute("SELECT status FROM job WHERE id=%s", (job["id"],)).fetchone()["status"] == "done"


def test_index_discarded_on_stale_pv(conn):
    mid = seed_meeting(conn, status="done", processing_version=0)
    _seed_utts(conn, mid, [(0, "ok", "안녕")])
    job = _claim(conn, mid)
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (mid,))
    out = run_index_meeting(conn, job, _payload(mid, pv=0), FakeTextEmbedder(), worker_id="w1")
    assert out == "discarded"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 0
```

- [ ] **Step 3: 실행 — 실패 확인**

Run: `cd worker && uv run pytest tests/test_index_meeting.py -q`
Expected: FAIL (`run_index_meeting` 모듈 없음).

- [ ] **Step 4: 파이프라인 구현**

Create `worker/damwha_worker/pipeline/index_meeting.py`:
```python
from .. import db
from ..contracts import IndexMeetingPayload
from ..models.base import TextEmbedder


def run_index_meeting(
    conn, job: dict, payload: IndexMeetingPayload, text_embedder: TextEmbedder, *, worker_id: str
) -> str:
    job_id = job["id"]
    meeting_id = payload.meeting_id
    pv = payload.processing_version

    db.set_stage(conn, job_id, worker_id, "embed", 20)

    rows = conn.execute(
        "SELECT id, text FROM utterance "
        "WHERE meeting_id=%s AND status='ok' AND text IS NOT NULL AND processing_version=%s "
        "ORDER BY order_index",
        (meeting_id, pv),
    ).fetchall()

    # 색인 대상이 0개여도 별도 분기를 두지 않는다 — 빈 임베딩으로 persist를 타서
    # 동일한 2-가드(job 소유권 + meeting pv)를 거치게 한다(stale/lost를 noop으로 숨기지 않음).
    embeddings = []
    if rows:
        vectors = text_embedder.embed_texts([r["text"] for r in rows])
        embeddings = [{"utterance_id": r["id"], "embedding": v} for r, v in zip(rows, vectors)]

    return db.persist_index_meeting(
        conn,
        job_id=job_id,
        worker_id=worker_id,
        meeting_id=meeting_id,
        processing_version=pv,
        model=payload.search_embedding.model,
        dimension=payload.search_embedding.dimension,
        embeddings=embeddings,
    )
```

- [ ] **Step 5: 실행 — 통과 확인**

Run: `cd worker && uv run pytest tests/test_index_meeting.py -q`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add worker/damwha_worker/models/base.py worker/damwha_worker/pipeline/index_meeting.py worker/tests/test_index_meeting.py
git commit -m "feat(worker): TextEmbedder protocol + run_index_meeting pipeline"
```

---

## Task 7: persist_process_meeting이 index_meeting 잡을 같은 TX에서 enqueue

**Files:**
- Modify: `worker/damwha_worker/db.py`
- Modify: `worker/damwha_worker/pipeline/process_meeting.py`
- Modify: `worker/tests/test_db_persist.py` (append) 또는 `test_process_meeting.py`

**Interfaces:**
- Consumes: `IndexMeetingPayload` shape.
- Produces: `persist_process_meeting(..., index_search_model: str | None = None, index_search_dim: int | None = None)` — `"committed"` 경로에서 두 값이 모두 주어지면 `index_meeting` job을 같은 TX에 INSERT. `run_process_meeting(..., search_embedding_model: str, search_embedding_dim: int)` 추가 인자로 전달.

- [ ] **Step 1: 실패 테스트 작성 (committed 후 index 잡 enqueue, discarded는 아님)**

In `worker/tests/test_db_persist.py`, add (uses existing `_claimed_pm_job` helper from that file):
```python
def test_persist_enqueues_index_job_on_commit(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    out = db.persist_process_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="k", duration_ms=1, utterances=[], clusters=[],
        index_search_model="BAAI/bge-m3", index_search_dim=1024,
    )
    assert out == "committed"
    row = conn.execute(
        "SELECT type, meeting_id, payload FROM job WHERE type='index_meeting' AND meeting_id=%s", (mid,)
    ).fetchone()
    assert row is not None
    assert row["payload"]["processing_version"] == 0
    assert row["payload"]["search_embedding"] == {"model": "BAAI/bge-m3", "dimension": 1024}


def test_persist_no_index_job_when_discarded(conn):
    mid, jid = _claimed_pm_job(conn, pv=0)
    newer = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET processing_version=1, current_job_id=%s WHERE id=%s", (newer, mid))
    out = db.persist_process_meeting(
        conn, job_id=jid, worker_id="w1", meeting_id=mid, processing_version=0,
        normalized_key="k", duration_ms=1, utterances=[], clusters=[],
        index_search_model="BAAI/bge-m3", index_search_dim=1024,
    )
    assert out == "discarded"
    assert conn.execute(
        "SELECT count(*) c FROM job WHERE type='index_meeting'", ()
    ).fetchone()["c"] == 0
```
(`seed_job` import는 파일 상단에서 `from tests.conftest import seed_job`로 이미 들어와 있지 않으면 추가.)

- [ ] **Step 2: 실행 — 실패 확인**

Run: `cd worker && uv run pytest tests/test_db_persist.py -q -k index`
Expected: FAIL (`index_search_model` 인자 미지원).

- [ ] **Step 3: persist_process_meeting에 enqueue 로직 추가**

In `worker/damwha_worker/db.py`, modify `persist_process_meeting` signature + commit 경로. Change signature to add params:
```python
def persist_process_meeting(
    conn,
    *,
    job_id,
    worker_id,
    meeting_id,
    processing_version,
    normalized_key,
    duration_ms,
    utterances,
    clusters,
    index_search_model=None,
    index_search_dim=None,
) -> str:
```
In the committed branch, **right before** `return "committed"`, after the `UPDATE job SET status='done', progress=100 ...` line, add:
```python
            if index_search_model is not None and index_search_dim is not None:
                conn.execute(
                    "INSERT INTO job(type, meeting_id, payload) VALUES('index_meeting', %s, %s)",
                    (
                        meeting_id,
                        Jsonb({
                            "schema_version": 1,
                            "meeting_id": str(meeting_id),
                            "processing_version": processing_version,
                            "search_embedding": {"model": index_search_model, "dimension": index_search_dim},
                        }),
                    ),
                )
```

- [ ] **Step 4: run_process_meeting이 search embedding 값을 persist로 전달**

In `worker/damwha_worker/pipeline/process_meeting.py`, change `run_process_meeting` signature to add (after `worker_id: str,`):
```python
    search_embedding_model: str | None = None,
    search_embedding_dim: int | None = None,
```
and the final `return db.persist_process_meeting(...)` call: add the two kwargs:
```python
        index_search_model=search_embedding_model,
        index_search_dim=search_embedding_dim,
```

- [ ] **Step 5: 실행 — 통과 확인**

Run: `cd worker && uv run pytest tests/test_db_persist.py -q`
Expected: PASS (기존 + 신규 2건). 기존 호출은 index 인자 없이 → enqueue 생략(하위호환).

- [ ] **Step 6: Commit**

```bash
git add worker/damwha_worker/db.py worker/damwha_worker/pipeline/process_meeting.py worker/tests/test_db_persist.py
git commit -m "feat(worker): atomically enqueue index_meeting in persist TX (commit path only)"
```

---

## Task 8: 실 bge-m3 어댑터 + build_text_embedder + embed 서비스 (models extra, smoke-only)

> 이 태스크는 CI TDD 대상이 아니다 — bge-m3는 무겁다. 이미 테스트된 `TextEmbedder` 프로토콜 뒤에 실구현을 끼우고, 로컬 smoke로만 검증한다(Plan 2 Task 14와 동일 정책). **순서 주의**: 다음 Task 9(dispatch)의 `main()`이 `build_text_embedder`를 참조하므로 이 태스크가 먼저 와야 워커 런타임이 깨지지 않는다.

**Files:**
- Create: `worker/damwha_worker/models/bge_embed.py`
- Modify: `worker/damwha_worker/models/registry.py`
- Create: `worker/damwha_worker/embed_service.py`
- Modify: `worker/pyproject.toml`

**Interfaces:**
- Produces: `BgeM3TextEmbedder(model_name)` implements `TextEmbedder`; `build_text_embedder(settings) -> TextEmbedder`; FastAPI app `embed_service:app` with `POST /embed` and `GET /health`.

- [ ] **Step 1: bge-m3 어댑터**

Create `worker/damwha_worker/models/bge_embed.py`:
```python
"""실 bge-m3 TextEmbedder. models extra에서만 import (테스트는 FakeTextEmbedder 사용)."""


class BgeM3TextEmbedder:
    def __init__(self, model_name: str = "BAAI/bge-m3") -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_name)

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vecs = self._model.encode(
            texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
        )
        return [v.tolist() for v in vecs]
```

- [ ] **Step 2: build_text_embedder**

In `worker/damwha_worker/models/registry.py`, append:
```python
def build_text_embedder(settings: Settings):
    from .bge_embed import BgeM3TextEmbedder

    return BgeM3TextEmbedder(settings.search_embedding_model)
```

- [ ] **Step 3: embed 서비스 (FastAPI)**

Create `worker/damwha_worker/embed_service.py`:
```python
"""쿼리 임베딩 전용 로컬 서비스. API가 localhost로만 호출. ML은 src/ 밖 유지."""

from fastapi import FastAPI
from pydantic import BaseModel

from .config import load_settings
from .models.registry import build_text_embedder

app = FastAPI()
_settings = load_settings()
_embedder = build_text_embedder(_settings)


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    model: str
    dimension: int
    vectors: list[list[float]]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    vectors = _embedder.embed_texts(req.texts)
    return EmbedResponse(
        model=_settings.search_embedding_model,
        dimension=_settings.search_embedding_dim,
        vectors=vectors,
    )
```

- [ ] **Step 4: 의존성 추가**

In `worker/pyproject.toml`, `[project.optional-dependencies] models` 리스트에 추가:
```toml
    "sentence-transformers>=3.0",
    "fastapi>=0.110",
    "uvicorn>=0.29",
```

이어서 lockfile을 갱신한다 — 이 repo는 `worker/uv.lock`을 추적하므로 재현 가능한 설치를 위해 함께 커밋해야 한다:
```bash
cd worker && uv lock
```
(`uv lock`은 의존성 그래프만 재해석하고 무거운 휠을 내려받지 않는다. 변경된 `worker/uv.lock`을 Step 7 커밋에 포함.)

- [ ] **Step 5: 결정성 테스트 스위트가 여전히 통과하는지 확인 (실모델 import 없음)**

Run: `cd worker && uv run pytest -q`
Expected: PASS — `bge_embed`/`embed_service`/`build_text_embedder`는 함수 안에서만 import하므로 기본 `uv sync`로도 영향 없음.

- [ ] **Step 6: 로컬 smoke (수동, CI 아님)**

```bash
cd worker && uv sync --extra models
uv run uvicorn damwha_worker.embed_service:app --host 127.0.0.1 --port 8100 &
sleep 30   # 첫 모델 로드 대기
curl -s localhost:8100/health
curl -s -X POST localhost:8100/embed -H 'content-type: application/json' \
  -d '{"texts":["UI 개선안","점심 메뉴"]}' | python -c "import sys,json; d=json.load(sys.stdin); print(d['model'], d['dimension'], len(d['vectors']), len(d['vectors'][0]))"
```
Expected: `BAAI/bge-m3 1024 2 1024` (모델명, 차원, 벡터 2개, 각 1024d).

- [ ] **Step 7: Commit**

```bash
git add worker/damwha_worker/models/bge_embed.py worker/damwha_worker/models/registry.py worker/damwha_worker/embed_service.py worker/pyproject.toml worker/uv.lock
git commit -m "feat(worker): real bge-m3 TextEmbedder + embed service (models extra, smoke-only)"
```

---

## Task 9: 워커 dispatch — type별 build 분기 + handle_job index 경로 + index 실패는 job만

**Files:**
- Modify: `worker/damwha_worker/__main__.py`
- Create: `worker/tests/test_dispatch_index.py`
- Modify: `worker/tests/test_worker_loop.py` (기존 handle_job 호출부 보정)

**Interfaces:**
- Consumes: `run_index_meeting` (Task 6), `db.fail_job` (Task 5), `build_text_embedder` (Task 8), `FakeTextEmbedder`.
- Produces: `handle_job(conn, job, storage, worker_id, *, models=None, text_embedder=None, search_embedding=None)` — type별 dispatch. `index_meeting`은 `text_embedder`로 `run_index_meeting`, 실패 시 TRANSIENT→`requeue` 그 외→`db.fail_job`(meeting 미터치). `process_meeting`은 `search_embedding`(tuple `(model,dim)`)을 `run_process_meeting`에 전달. `run_once`는 type-agnostic 시그니처(`text_embedder=`/`search_embedding=` 추가)로 갱신 — index job도 처리.

- [ ] **Step 1: 실패 테스트 — index 영구 실패는 job만 failed, meeting은 done 유지**

Create `worker/tests/test_dispatch_index.py`:
```python
from damwha_worker import db
from damwha_worker.__main__ import handle_job, run_once
from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.storage import Storage
from tests.conftest import seed_job, seed_meeting
from tests.fakes import FakeTextEmbedder


class RaisingTextEmbedder:
    def __init__(self, kind=ErrorKind.PERMANENT):
        self._kind = kind

    def embed_texts(self, texts):
        raise WorkerError("model_load_failed", "boom", self._kind, stage="embed")


def _claimed_index_job(conn, mid):
    jid = seed_job(conn, type="index_meeting", meeting_id=mid)
    db.claim(conn, "w1")
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def test_index_permanent_failure_fails_job_only(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,'안녕','ok',0,0)",
        (mid,),
    )
    job = _claimed_index_job(conn, mid)
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        text_embedder=RaisingTextEmbedder(ErrorKind.PERMANENT),
    )
    assert out == "failed"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (job["id"],)).fetchone()["status"] == "failed"
    # 핵심: meeting은 절대 failed가 아니다
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"


def test_index_transient_failure_requeues(conn, tmp_path):
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,'안녕','ok',0,0)",
        (mid,),
    )
    job = _claimed_index_job(conn, mid)
    out = handle_job(
        conn, job, Storage(str(tmp_path)), "w1",
        text_embedder=RaisingTextEmbedder(ErrorKind.TRANSIENT),
    )
    assert out == "requeued"
    assert conn.execute("SELECT status FROM job WHERE id=%s", (job["id"],)).fetchone()["status"] == "queued"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "done"


def test_run_once_handles_index_job(conn, tmp_path):
    # run_once가 text_embedder를 받아 index_meeting을 정상 처리(None이면 깨짐)
    mid = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        "INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version) "
        "VALUES (%s,'SPEAKER_00',0,1000,'안녕','ok',0,0)",
        (mid,),
    )
    seed_job(conn, type="index_meeting", meeting_id=mid)
    out = run_once(conn, "w1", None, Storage(str(tmp_path)), text_embedder=FakeTextEmbedder())
    assert out == "committed"
    assert conn.execute("SELECT count(*) c FROM utterance_embedding", ()).fetchone()["c"] == 1
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `cd worker && uv run pytest tests/test_dispatch_index.py -q`
Expected: FAIL (`handle_job` 새 시그니처/분기 없음).

- [ ] **Step 3: handle_job 재작성 (try/except에 index 분기 추가)**

In `worker/damwha_worker/__main__.py`, replace `handle_job` with the branching version. Import `run_index_meeting` at top:
```python
from .pipeline.index_meeting import run_index_meeting
```
Replace `handle_job`:
```python
def handle_job(
    conn, job: dict, storage: Storage, worker_id: str,
    *, models: Models | None = None, text_embedder=None, search_embedding=None,
) -> str:
    try:
        payload = parse_payload(job["type"], job["payload"])
        if job["type"] == "process_meeting":
            sm, sd = (search_embedding or (None, None))
            return run_process_meeting(
                conn, job, payload, models, storage, worker_id=worker_id,
                search_embedding_model=sm, search_embedding_dim=sd,
            )
        if job["type"] == "enroll_speaker":
            return run_enroll_speaker(
                conn, job, payload, models.embedder, storage, worker_id=worker_id
            )
        if job["type"] == "index_meeting":
            return run_index_meeting(conn, job, payload, text_embedder, worker_id=worker_id)
        raise ValueError(f"unknown job type {job['type']}")
    except Exception as exc:  # noqa: BLE001 — 분류해서 requeue/fail
        werr = classify(exc)
        error_json = werr.to_json(stage=job.get("stage"))
        log.warning(
            "job %s failed: code=%s kind=%s attempt=%s/%s",
            job["id"], werr.code, werr.kind.value, job["attempts"], job["max_attempts"],
        )
        transient_retry = werr.kind is ErrorKind.TRANSIENT and job["attempts"] < job["max_attempts"]
        if job["type"] == "enroll_speaker":
            speaker_id = (job["payload"] or {}).get("speaker_id")
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return "failed" if db.fail_enroll(conn, job["id"], worker_id, speaker_id, error_json) else "lost"
        if job["type"] == "index_meeting":
            # 검색 색인 실패는 job만 — meeting은 done 유지
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return "failed" if db.fail_job(conn, job["id"], worker_id, error_json) else "lost"
        # process_meeting
        meeting_id = job["meeting_id"]
        if transient_retry:
            return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
        return "failed" if db.fail_process_meeting(conn, job["id"], worker_id, meeting_id, error_json) else "lost"
```

- [ ] **Step 4: run_once + 기존 test_worker_loop 호출부 보정 (새 handle_job 시그니처)**

`handle_job` 시그니처가 `(conn, job, storage, worker_id, *, models=None, ...)`로 바뀌었으므로 구형 positional 호출을 keyword 형태로 고친다(보정 안 하면 이 커밋 직후 워커 테스트가 깨진다).

In `worker/damwha_worker/__main__.py`, `run_once`를 type-agnostic 시그니처로 교체(호출자가 job type에 맞는 모델 객체를 넘긴다 — index job엔 `text_embedder`):
```python
def run_once(
    conn, worker_id: str, models: Models | None, storage: Storage,
    *, text_embedder=None, search_embedding=None,
) -> str | None:
    job = db.claim(conn, worker_id)
    if job is None:
        return None
    return handle_job(
        conn, job, storage, worker_id,
        models=models, text_embedder=text_embedder, search_embedding=search_embedding,
    )
```
(기존: `handle_job(conn, job, models, storage, worker_id)` 구형 positional — `__main__.py:56`. process_meeting 테스트의 `run_once(conn, "w1", _models(), Storage(...))`는 그대로 동작.)

In `worker/tests/test_worker_loop.py`, 두 곳(`test_transient_error_requeues_when_attempts_left:73`, `test_permanent_error_fails:86`)의
`handle_job(conn, job, boom, Storage(str(tmp_path)), "w1")`를 교체:
```python
    out = handle_job(conn, job, Storage(str(tmp_path)), "w1", models=boom)
```

- [ ] **Step 5: main() 폴 루프를 type별 build 분기로 수정**

In `worker/damwha_worker/__main__.py`, `main()`의 claim 이후 블록을 교체. Replace the body from `models = build_models(...)` through the heartbeat block with:
```python
        from .heartbeat import Heartbeat
        from .models.registry import build_models, build_text_embedder

        if job["type"] == "index_meeting":
            text_embedder = build_text_embedder(settings)
            with Heartbeat(settings.database_url, job["id"], settings.worker_id, settings.heartbeat_interval_seconds):
                outcome = handle_job(conn, job, storage, settings.worker_id, text_embedder=text_embedder)
        else:
            models = build_models(job["payload"], settings)
            with Heartbeat(settings.database_url, job["id"], settings.worker_id, settings.heartbeat_interval_seconds):
                outcome = handle_job(
                    conn, job, storage, settings.worker_id, models=models,
                    search_embedding=(settings.search_embedding_model, settings.search_embedding_dim),
                )
        log.info("job %s → %s", job["id"], outcome)
        time.sleep(settings.poll_interval_seconds)
```
(`build_text_embedder`는 Task 8에서 registry에 추가됨. main()은 `# pragma: no cover`라 CI 미실행이므로 import는 런타임에만 해석된다.)

- [ ] **Step 6: 실행 — 통과 확인**

Run: `cd worker && uv run pytest tests/test_dispatch_index.py tests/test_worker_loop.py tests/test_process_meeting.py -q`
Expected: PASS — 새 시그니처로 run_once/handle_job 호출이 모두 정합. (test_process_meeting은 `run_process_meeting`만 직접 호출하므로 영향 없음.)

- [ ] **Step 7: Commit**

```bash
git add worker/damwha_worker/__main__.py worker/tests/test_dispatch_index.py worker/tests/test_worker_loop.py
git commit -m "feat(worker): dispatch branch by job type + index failure job-only (fix run_once/test call sites)"
```

---

## Task 10: API embed.client.ts — 쿼리 임베딩 RPC + degrade + loopback 가드

**Files:**
- Create: `src/search/embed.client.ts`
- Modify: `src/config/env.ts`
- Create: `test/embed.client.spec.ts`

**Interfaces:**
- Produces: `EmbedClient` (NestJS `@Injectable`): `embed(text: string): Promise<number[] | null>` — 성공 시 벡터, 장애(timeout/연결실패/non-200/차원 불일치) 시 `null`. 생성 시 `EMBED_SERVICE_URL` 호스트가 loopback인지 검증, 비-loopback이면 `EMBED_SERVICE_ALLOW_NON_LOOPBACK!=='true'`일 때 throw.
- env: `EMBED_SERVICE_URL`(default `http://127.0.0.1:8100`), `EMBED_SERVICE_TIMEOUT_MS`(default 800), `EMBED_SERVICE_ALLOW_NON_LOOPBACK`(default `'false'`), `SEARCH_RRF_K`(default 60), `SEARCH_CANDIDATE_K`(default 100).

- [ ] **Step 1: env 추가**

In `src/config/env.ts`, add to `EnvSchema`:
```typescript
  EMBED_SERVICE_URL: z.string().default('http://127.0.0.1:8100'),
  EMBED_SERVICE_TIMEOUT_MS: z.coerce.number().default(800),
  EMBED_SERVICE_ALLOW_NON_LOOPBACK: z.string().default('false'),
  SEARCH_RRF_K: z.coerce.number().default(60),
  SEARCH_CANDIDATE_K: z.coerce.number().default(100),
```

- [ ] **Step 2: 실패 테스트 작성**

Create `test/embed.client.spec.ts`:
```typescript
import { EmbedClient } from '../src/search/embed.client';

describe('EmbedClient', () => {
  const OLD = process.env;
  afterEach(() => { process.env = { ...OLD }; });

  it('rejects a non-loopback embed URL at construction', () => {
    process.env.EMBED_SERVICE_URL = 'http://10.0.0.5:8100';
    process.env.EMBED_SERVICE_ALLOW_NON_LOOPBACK = 'false';
    expect(() => new EmbedClient()).toThrow(/loopback/i);
  });

  it('allows non-loopback with explicit override', () => {
    process.env.EMBED_SERVICE_URL = 'http://10.0.0.5:8100';
    process.env.EMBED_SERVICE_ALLOW_NON_LOOPBACK = 'true';
    expect(() => new EmbedClient()).not.toThrow();
  });

  it('returns null (degrade) when service is unreachable', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:1'; // nothing listening
    process.env.EMBED_SERVICE_TIMEOUT_MS = '200';
    const c = new EmbedClient();
    expect(await c.embed('hello')).toBeNull();
  });

  it('returns the vector on a 200 with matching dimension', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    process.env.SEARCH_EMBEDDING_DIM = '3';
    const c = new EmbedClient();
    // fetch를 stub: 정상 응답
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'BAAI/bge-m3', dimension: 3, vectors: [[0.1, 0.2, 0.3]] }),
    });
    expect(await c.embed('hello')).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null when dimension mismatches config', async () => {
    process.env.EMBED_SERVICE_URL = 'http://127.0.0.1:8100';
    process.env.SEARCH_EMBEDDING_DIM = '1024';
    const c = new EmbedClient();
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({ model: 'x', dimension: 3, vectors: [[0.1, 0.2, 0.3]] }),
    });
    expect(await c.embed('hello')).toBeNull();
  });
});
```

- [ ] **Step 3: 실행 — 실패 확인**

Run: `npx jest test/embed.client.spec.ts`
Expected: FAIL (`EmbedClient` 없음).

- [ ] **Step 4: EmbedClient 구현**

Create `src/search/embed.client.ts`:
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../config/env';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

@Injectable()
export class EmbedClient {
  private readonly logger = new Logger(EmbedClient.name);
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly expectedDim: number;

  constructor() {
    const env = loadEnv();
    this.url = env.EMBED_SERVICE_URL;
    this.timeoutMs = env.EMBED_SERVICE_TIMEOUT_MS;
    this.expectedDim = env.SEARCH_EMBEDDING_DIM;
    const host = new URL(this.url).hostname;
    if (!LOOPBACK.has(host) && env.EMBED_SERVICE_ALLOW_NON_LOOPBACK !== 'true') {
      throw new Error(
        `EMBED_SERVICE_URL host "${host}" is not loopback; set EMBED_SERVICE_ALLOW_NON_LOOPBACK=true to override`,
      );
    }
  }

  /** 쿼리 텍스트 → 벡터. 장애 시 null(키워드 전용 degrade). */
  async embed(text: string): Promise<number[] | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: [text] }),
        signal: ctrl.signal,
      });
      if (!res.ok) { this.logger.warn(`embed service ${res.status} → degrade`); return null; }
      const body = (await res.json()) as { dimension: number; vectors: number[][] };
      if (body.dimension !== this.expectedDim || !body.vectors?.[0]) {
        this.logger.error(`embed dim ${body.dimension} != ${this.expectedDim} → degrade`);
        return null;
      }
      return body.vectors[0];
    } catch (e) {
      this.logger.warn(`embed service unreachable (${(e as Error).name}) → degrade`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}
```

- [ ] **Step 5: 실행 — 통과 확인**

Run: `npx jest test/embed.client.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/search/embed.client.ts src/config/env.ts test/embed.client.spec.ts
git commit -m "feat(api): embed client (query RPC) with loopback guard + degrade"
```

---

## Task 11: API search.repository.ts — 하이브리드 SQL + browse

**Files:**
- Create: `src/search/search.repository.ts`
- Create: `test/search.repository.spec.ts`

**Interfaces:**
- Produces: `SearchRepository` with
  - `hybrid(exec, args: { q: string; qvec: number[] | null; filters: SearchFilters; limit: number; candK: number; rrfK: number; model: string; dim: number }): Promise<SearchRow[]>`
  - `keyword(exec, args: { q: string; filters: SearchFilters; limit: number; candK: number }): Promise<SearchRow[]>` (의미 degrade 시)
  - `browse(exec, args: { filters: SearchFilters; limit: number }): Promise<SearchRow[]>`
  - 타입: `SearchFilters = { dateFrom: string | null; dateTo: string | null; speakerIds: string[] | null; meetingIds: string[] | null }`; `SearchRow = { utterance_id, meeting_id, meeting_title, recorded_at, speaker_id, speaker_name, diar_label, start_ms, end_ms, text, score }`.
  - 각 메서드는 `limit+1`행을 페치(호출자가 hasMore 판정).

- [ ] **Step 1: 실패 테스트 작성**

Create `test/search.repository.spec.ts`:
```typescript
import { startTestDb, StartedTestDb } from './db';
import { SearchRepository } from '../src/search/search.repository';

const MODEL = 'BAAI/bge-m3';
const DIM = 1024; // embedding 컬럼은 vector(1024) 고정 → 테스트 벡터도 1024차원
const oneHot = (i: number) => { const a = Array(DIM).fill(0); a[i] = 1; return a; };

describe('SearchRepository', () => {
  let db: StartedTestDb;
  let repo: SearchRepository;
  beforeAll(async () => { db = await startTestDb(); repo = new SearchRepository(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db.stop(); });

  async function seedMeeting(title: string, recordedAt: string | null) {
    const r = await db.pool.query(
      `INSERT INTO meeting(title, audio_key, recorded_at, status) VALUES($1,'k',$2,'done') RETURNING id`,
      [title, recordedAt],
    );
    return r.rows[0].id as string;
  }
  async function seedUtterance(
    meetingId: string, oi: number, text: string | null, status: string, speakerId: string | null,
  ) {
    const r = await db.pool.query(
      `INSERT INTO utterance(meeting_id,speaker_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,$2,'SPEAKER_00',0,1000,$3,$4,$5,0) RETURNING id`,
      [meetingId, speakerId, text, status, oi],
    );
    return r.rows[0].id as string;
  }
  async function seedEmbedding(utteranceId: string, vec: number[], dimCol = DIM) {
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,$3,$4,0)`,
      [utteranceId, '[' + vec.join(',') + ']', MODEL, dimCol],
    );
  }
  const noFilters = { dateFrom: null, dateTo: null, speakerIds: null, meetingIds: null };

  it('keyword arm: bigm matches Korean substrings', async () => {
    const m = await seedMeeting('기획회의', '2026-06-20T00:00:00Z');
    await seedUtterance(m, 0, '새 UI 개선안을 논의했다', 'ok', null);
    await seedUtterance(m, 1, '점심 메뉴 이야기', 'ok', null);
    const rows = await repo.keyword(db.pool, { q: 'UI 개선', filters: noFilters, limit: 10, candK: 50 });
    expect(rows.map((r) => r.text)).toContain('새 UI 개선안을 논의했다');
    expect(rows.map((r) => r.text)).not.toContain('점심 메뉴 이야기');
  });

  it('keyword arm excludes silence/null-text utterances', async () => {
    const m = await seedMeeting('m', null);
    await seedUtterance(m, 0, null, 'silence', null);
    const rows = await repo.keyword(db.pool, { q: '회의', filters: noFilters, limit: 10, candK: 50 });
    expect(rows.length).toBe(0);
  });

  it('hybrid RRF fuses keyword + semantic', async () => {
    const m = await seedMeeting('m', '2026-06-20T00:00:00Z');
    const u1 = await seedUtterance(m, 0, '쿠버네티스 배포 전략', 'ok', null);
    const u2 = await seedUtterance(m, 1, '회의록 정리', 'ok', null);
    await seedEmbedding(u1, oneHot(0));
    await seedEmbedding(u2, oneHot(1));
    const rows = await repo.hybrid(db.pool, {
      q: '배포', qvec: oneHot(0), filters: noFilters, limit: 10, candK: 50, rrfK: 60, model: MODEL, dim: DIM,
    });
    expect(rows[0].utterance_id).toBe(u1); // 키워드+의미 둘 다 1등 → 최상위
  });

  it('semantic arm filters by model AND dimension', async () => {
    const m = await seedMeeting('m', null);
    const u = await seedUtterance(m, 0, '내용', 'ok', null);
    await seedEmbedding(u, oneHot(0), 999); // dimension 컬럼만 다르게 (벡터는 1024차원)
    const rows = await repo.hybrid(db.pool, {
      q: 'zzz', qvec: oneHot(0), filters: noFilters, limit: 10, candK: 50, rrfK: 60, model: MODEL, dim: DIM,
    });
    expect(rows.length).toBe(0); // dim 불일치로 의미 arm 제외, 키워드도 미매치
  });

  it('browse orders recorded_at DESC NULLS LAST and excludes non-ok', async () => {
    const m1 = await seedMeeting('dated', '2026-06-20T00:00:00Z');
    const m2 = await seedMeeting('undated', null);
    await seedUtterance(m2, 0, '미상정', 'ok', null);
    await seedUtterance(m1, 0, '최신', 'ok', null);
    await seedUtterance(m1, 1, null, 'silence', null);
    const rows = await repo.browse(db.pool, { filters: noFilters, limit: 10 });
    expect(rows.map((r) => r.text)).toEqual(['최신', '미상정']); // dated first, silence excluded
  });

  it('date + speaker filters apply', async () => {
    const m = await seedMeeting('m', '2026-06-20T00:00:00Z');
    const sp = (await db.pool.query(`INSERT INTO speaker(name) VALUES('김') RETURNING id`)).rows[0].id;
    await seedUtterance(m, 0, '대상 발언', 'ok', sp);
    await seedUtterance(m, 1, '다른 발언', 'ok', null);
    const rows = await repo.keyword(db.pool, {
      q: '발언',
      filters: { dateFrom: '2026-06-01T00:00:00Z', dateTo: '2026-07-01T00:00:00Z', speakerIds: [sp], meetingIds: null },
      limit: 10, candK: 50,
    });
    expect(rows.map((r) => r.text)).toEqual(['대상 발언']);
  });
});
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `npx jest test/search.repository.spec.ts`
Expected: FAIL (`SearchRepository` 없음).

- [ ] **Step 3: SearchRepository 구현**

Create `src/search/search.repository.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { Queryable } from '../jobs/jobs.types';

export interface SearchFilters {
  dateFrom: string | null;
  dateTo: string | null;
  speakerIds: string[] | null;
  meetingIds: string[] | null;
}

export interface SearchRow {
  utterance_id: string;
  meeting_id: string;
  meeting_title: string | null;
  recorded_at: Date | null;
  speaker_id: string | null;
  speaker_name: string | null;
  diar_label: string;
  start_ms: number;
  end_ms: number;
  text: string | null;
  score: number;
}

// 모든 arm/browse가 공유하는 필터 WHERE. $base 이후 4개 파라미터를 소비.
// f1=dateFrom f2=dateTo f3=speakerIds(uuid[]) f4=meetingIds(uuid[])
function filterSql(alias: string, f1: number, f2: number, f3: number, f4: number): string {
  return `
    AND ($${f1}::timestamptz IS NULL OR m.recorded_at >= $${f1}::timestamptz)
    AND ($${f2}::timestamptz IS NULL OR m.recorded_at <  $${f2}::timestamptz)
    AND ($${f3}::uuid[] IS NULL OR ${alias}.speaker_id = ANY($${f3}::uuid[]))
    AND ($${f4}::uuid[] IS NULL OR ${alias}.meeting_id = ANY($${f4}::uuid[]))`;
}

const SELECT_COLS = `
  u.id AS utterance_id, u.meeting_id, m.title AS meeting_title, m.recorded_at,
  u.speaker_id, s.name AS speaker_name, u.diar_label, u.start_ms, u.end_ms, u.text`;

@Injectable()
export class SearchRepository {
  async hybrid(
    exec: Queryable,
    args: { q: string; qvec: number[] | null; filters: SearchFilters; limit: number; candK: number; rrfK: number; model: string; dim: number },
  ): Promise<SearchRow[]> {
    const f = args.filters;
    const vec = args.qvec ? '[' + args.qvec.join(',') + ']' : null;
    // params: 1=q 2=candK 3=qvec 4=model 5=dim 6=rrfK 7=limit+1 8..11=filters
    const sql = `
      WITH kw AS (
        SELECT u.id AS utterance_id,
               row_number() OVER (ORDER BY bigm_similarity(u.text, $1) DESC) AS rnk
        FROM utterance u JOIN meeting m ON m.id = u.meeting_id
        WHERE u.status='ok' AND u.text IS NOT NULL AND u.text LIKE likequery($1)
              ${filterSql('u', 8, 9, 10, 11)}
        ORDER BY bigm_similarity(u.text, $1) DESC LIMIT $2
      ),
      sem AS (
        SELECT u.id AS utterance_id,
               row_number() OVER (ORDER BY e.embedding <=> $3::vector) AS rnk
        FROM utterance_embedding e
        JOIN utterance u ON u.id = e.utterance_id
        JOIN meeting m ON m.id = u.meeting_id
        WHERE e.model=$4 AND e.dimension=$5 AND u.status='ok'
              AND $3::text IS NOT NULL
              ${filterSql('u', 8, 9, 10, 11)}
        ORDER BY e.embedding <=> $3::vector LIMIT $2
      ),
      fused AS (
        SELECT COALESCE(kw.utterance_id, sem.utterance_id) AS utterance_id,
               COALESCE(1.0/($6 + kw.rnk), 0) + COALESCE(1.0/($6 + sem.rnk), 0) AS score
        FROM kw FULL OUTER JOIN sem USING (utterance_id)
      )
      SELECT ${SELECT_COLS}, f.score
      FROM fused f
      JOIN utterance u ON u.id = f.utterance_id
      JOIN meeting m ON m.id = u.meeting_id
      LEFT JOIN speaker s ON s.id = u.speaker_id
      ORDER BY f.score DESC, u.meeting_id, u.order_index
      LIMIT $7`;
    const { rows } = await exec.query<SearchRow>(sql, [
      args.q, args.candK, vec, args.model, args.dim, args.rrfK, args.limit + 1,
      f.dateFrom, f.dateTo, f.speakerIds, f.meetingIds,
    ]);
    return rows;
  }

  async keyword(
    exec: Queryable, args: { q: string; filters: SearchFilters; limit: number; candK: number },
  ): Promise<SearchRow[]> {
    const f = args.filters;
    // params: 1=q 2=limit+1 3..6=filters
    const sql = `
      SELECT ${SELECT_COLS}, bigm_similarity(u.text, $1) AS score
      FROM utterance u
      JOIN meeting m ON m.id = u.meeting_id
      LEFT JOIN speaker s ON s.id = u.speaker_id
      WHERE u.status='ok' AND u.text IS NOT NULL AND u.text LIKE likequery($1)
            ${filterSql('u', 3, 4, 5, 6)}
      ORDER BY bigm_similarity(u.text, $1) DESC, u.meeting_id, u.order_index
      LIMIT $2`;
    const { rows } = await exec.query<SearchRow>(sql, [
      args.q, args.limit + 1, f.dateFrom, f.dateTo, f.speakerIds, f.meetingIds,
    ]);
    return rows;
  }

  async browse(
    exec: Queryable, args: { filters: SearchFilters; limit: number },
  ): Promise<SearchRow[]> {
    const f = args.filters;
    // params: 1=limit+1 2..5=filters
    const sql = `
      SELECT ${SELECT_COLS}, 0::float8 AS score
      FROM utterance u
      JOIN meeting m ON m.id = u.meeting_id
      LEFT JOIN speaker s ON s.id = u.speaker_id
      WHERE u.status='ok' AND u.text IS NOT NULL
            ${filterSql('u', 2, 3, 4, 5)}
      ORDER BY m.recorded_at DESC NULLS LAST, m.created_at DESC, u.order_index
      LIMIT $1`;
    const { rows } = await exec.query<SearchRow>(sql, [
      args.limit + 1, f.dateFrom, f.dateTo, f.speakerIds, f.meetingIds,
    ]);
    return rows;
  }
}
```

- [ ] **Step 4: 실행 — 통과 확인**

Run: `npx jest test/search.repository.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/search/search.repository.ts test/search.repository.spec.ts
git commit -m "feat(api): hybrid search repository (pg_bigm + pgvector + RRF) + browse"
```

---

## Task 12: API search 모듈 — service + controller + 등록 (POST /search)

**Files:**
- Create: `src/search/search.service.ts`
- Create: `src/search/search.controller.ts`
- Create: `src/search/search.module.ts`
- Modify: `src/app.module.ts`
- Create: `test/search.e2e-spec.ts`

**Interfaces:**
- Consumes: `EmbedClient` (Task 10), `SearchRepository` (Task 11), `DatabaseService`.
- Produces: `POST /search` body `{ q?: string; filters?: Partial<SearchFilters>; limit?: number }` → `{ mode, semantic, hasMore, results: SearchResult[] }` (camelCase DTO, nested `speaker`, 스펙 §5.1). `mode`: `'browse'`(q 빔) / `'keyword'`(embed degrade) / `'hybrid'`.

- [ ] **Step 1: 실패 e2e 테스트 작성**

Create `test/search.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';
import { EmbedClient } from '../src/search/embed.client';

describe('search', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  const DIM = 1024;
  const oneHot = (i: number) => { const a = Array(DIM).fill(0); a[i] = 1; return a; };
  const fakeEmbed = { embed: async (_t: string): Promise<number[] | null> => oneHot(0) };

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmbedClient).useValue(fakeEmbed)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); fakeEmbed.embed = async () => oneHot(0); });
  afterAll(async () => { await app?.close(); await db?.stop(); });
  const srv = () => app.getHttpServer();

  async function seed() {
    const m = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,recorded_at,status) VALUES('기획','k','2026-06-20T00:00:00Z','done') RETURNING id`,
    )).rows[0].id;
    const u = (await db.pool.query(
      `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
       VALUES($1,'SPEAKER_00',0,1000,'UI 개선안 논의','ok',0,0) RETURNING id`, [m],
    )).rows[0].id;
    await db.pool.query(
      `INSERT INTO utterance_embedding(utterance_id,embedding,model,dimension,processing_version)
       VALUES($1,$2::vector,'BAAI/bge-m3',1024,0)`, [u, '[' + oneHot(0).join(',') + ']'],
    );
    return { m, u };
  }

  it('POST /search hybrid returns matching utterance', async () => {
    const { u } = await seed();
    const res = await request(srv()).post('/search').send({ q: 'UI 개선' });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('hybrid');
    expect(res.body.semantic).toBe(true);
    expect(res.body.results[0].utteranceId).toBe(u);
    expect(res.body.results[0].meetingTitle).toBe('기획');
  });

  it('degrades to keyword when embed returns null', async () => {
    await seed();
    fakeEmbed.embed = async () => null;
    const res = await request(srv()).post('/search').send({ q: 'UI 개선' });
    expect(res.body.mode).toBe('keyword');
    expect(res.body.semantic).toBe(false);
    expect(res.body.results.length).toBe(1);
  });

  it('browse mode when q empty', async () => {
    await seed();
    const res = await request(srv()).post('/search').send({ filters: {} });
    expect(res.body.mode).toBe('browse');
    expect(res.body.results.length).toBe(1);
  });

  it('hasMore true when more than limit', async () => {
    const m = (await db.pool.query(
      `INSERT INTO meeting(title,audio_key,status) VALUES('m','k','done') RETURNING id`,
    )).rows[0].id;
    for (let i = 0; i < 3; i++) {
      await db.pool.query(
        `INSERT INTO utterance(meeting_id,diar_label,start_ms,end_ms,text,status,order_index,processing_version)
         VALUES($1,'SPEAKER_00',0,1,'회의 ${i}','ok',${i},0)`, [m],
      );
    }
    const res = await request(srv()).post('/search').send({ filters: {}, limit: 2 });
    expect(res.body.results.length).toBe(2);
    expect(res.body.hasMore).toBe(true);
  });
});
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `npx jest test/search.e2e-spec.ts`
Expected: FAIL (search 모듈/라우트 없음).

- [ ] **Step 3: service 구현**

Create `src/search/search.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { loadEnv } from '../config/env';
import { EmbedClient } from './embed.client';
import { SearchFilters, SearchRepository, SearchRow } from './search.repository';

export interface SearchQuery {
  q?: string;
  filters?: Partial<SearchFilters>;
  limit?: number;
}
export interface SearchResult {
  utteranceId: string;
  meetingId: string;
  meetingTitle: string | null;
  recordedAt: Date | null;
  speaker: { id: string; name: string } | null;
  diarLabel: string;
  startMs: number;
  endMs: number;
  text: string | null;
  score: number;
}
export interface SearchResponse {
  mode: 'hybrid' | 'keyword' | 'browse';
  semantic: boolean;
  hasMore: boolean;
  results: SearchResult[];
}

// DB row(snake_case) → API DTO(camelCase, nested speaker). 스펙 §5.1 계약.
function toResult(r: SearchRow): SearchResult {
  return {
    utteranceId: r.utterance_id,
    meetingId: r.meeting_id,
    meetingTitle: r.meeting_title,
    recordedAt: r.recorded_at,
    speaker: r.speaker_id ? { id: r.speaker_id, name: r.speaker_name as string } : null,
    diarLabel: r.diar_label,
    startMs: r.start_ms,
    endMs: r.end_ms,
    text: r.text,
    score: r.score,
  };
}

@Injectable()
export class SearchService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: SearchRepository,
    private readonly embed: EmbedClient,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponse> {
    const env = loadEnv();
    const q = (query.q ?? '').trim();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const candK = Math.max(env.SEARCH_CANDIDATE_K, limit * 5);
    const filters: SearchFilters = {
      dateFrom: query.filters?.dateFrom ?? null,
      dateTo: query.filters?.dateTo ?? null,
      speakerIds: query.filters?.speakerIds ?? null,
      meetingIds: query.filters?.meetingIds ?? null,
    };

    if (q === '') {
      const rows = await this.repo.browse(this.db.pool, { filters, limit });
      return this.shape('browse', false, rows, limit);
    }

    const qvec = await this.embed.embed(q);
    if (qvec === null) {
      const rows = await this.repo.keyword(this.db.pool, { q, filters, limit, candK });
      return this.shape('keyword', false, rows, limit);
    }
    const rows = await this.repo.hybrid(this.db.pool, {
      q, qvec, filters, limit, candK, rrfK: env.SEARCH_RRF_K,
      model: env.SEARCH_EMBEDDING_MODEL, dim: env.SEARCH_EMBEDDING_DIM,
    });
    return this.shape('hybrid', true, rows, limit);
  }

  private shape(
    mode: SearchResponse['mode'], semantic: boolean, rows: SearchRow[], limit: number,
  ): SearchResponse {
    const hasMore = rows.length > limit;
    return { mode, semantic, hasMore, results: rows.slice(0, limit).map(toResult) };
  }
}
```

- [ ] **Step 4: controller + module 구현**

Create `src/search/search.controller.ts`:
```typescript
import { Body, Controller, Post } from '@nestjs/common';
import { SearchQuery, SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Post()
  search(@Body() body: SearchQuery) {
    return this.service.search(body ?? {});
  }
}
```

Create `src/search/search.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { EmbedClient } from './embed.client';

@Module({
  controllers: [SearchController],
  providers: [SearchService, SearchRepository, EmbedClient],
})
export class SearchModule {}
```

- [ ] **Step 5: app.module 등록**

In `src/app.module.ts`, add import + add `SearchModule` to `imports: []`:
```typescript
import { SearchModule } from './search/search.module';
```
(추가 위치: `SpeakersModule` 다음)

- [ ] **Step 6: 실행 — 통과 확인**

Run: `npx jest test/search.e2e-spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/search/search.service.ts src/search/search.controller.ts src/search/search.module.ts src/app.module.ts test/search.e2e-spec.ts
git commit -m "feat(api): POST /search (hybrid/keyword/browse) + module wiring"
```

---

## Task 13: API reindex + reconciler — POST /meetings/:id/reindex

**Files:**
- Modify: `src/meetings/meetings.repository.ts`
- Modify: `src/meetings/meetings.service.ts`
- Modify: `src/meetings/meetings.controller.ts`
- Modify: `test/meetings.e2e-spec.ts` (append)

**Interfaces:**
- Consumes: `buildIndexMeetingPayload` (Task 3), `JobsRepository.enqueue`, `loadEnv`.
- Produces:
  - `MeetingsRepository.findReindexableMeetingIds(exec, model, dim): Promise<string[]>` — done이고 in-flight index 잡 없고 색인 가능 utterance 중 임베딩 누락이 있는 회의.
  - `MeetingsService.reindex(id): Promise<{ meeting_id; processing_version; job_id }>` — 해당 회의에 index_meeting 잡 enqueue.
  - `POST /meetings/:id/reindex` (202).

- [ ] **Step 1: 실패 e2e 테스트 작성**

In `test/meetings.e2e-spec.ts`, add:
```typescript
  it('POST /meetings/:id/reindex enqueues an index_meeting job', async () => {
    const created = await request(srv()).post('/meetings').attach('audio', Buffer.from('a'), { filename: 'a.wav', contentType: 'audio/wav' });
    const mid = created.body.id;
    await db.pool.query(`UPDATE meeting SET status='done', processing_version=2 WHERE id=$1`, [mid]);
    const res = await request(srv()).post(`/meetings/${mid}/reindex`);
    expect(res.status).toBe(202);
    const job = await db.pool.query(
      `SELECT type, payload FROM job WHERE meeting_id=$1 AND type='index_meeting'`, [mid],
    );
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].payload.processing_version).toBe(2);
    expect(job.rows[0].payload.search_embedding.model).toBe('BAAI/bge-m3');
  });

  it('POST /meetings/:id/reindex → 404 for unknown meeting', async () => {
    const res = await request(srv()).post('/meetings/99999999-9999-9999-9999-999999999999/reindex');
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: 실행 — 실패 확인**

Run: `npx jest test/meetings.e2e-spec.ts -t reindex`
Expected: FAIL (라우트 없음 → 404 on the enqueue test).

- [ ] **Step 3: repository에 reconciler 쿼리 추가**

In `src/meetings/meetings.repository.ts`, add method:
```typescript
  async findReindexableMeetingIds(exec: Queryable, model: string, dim: number): Promise<string[]> {
    const { rows } = await exec.query<{ id: string }>(
      `SELECT m.id FROM meeting m
       WHERE m.status='done'
         AND NOT EXISTS (
           SELECT 1 FROM job j WHERE j.meeting_id=m.id AND j.type='index_meeting'
             AND j.status IN ('queued','running'))
         AND EXISTS (
           SELECT 1 FROM utterance u
           WHERE u.meeting_id=m.id AND u.status='ok' AND u.text IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM utterance_embedding e
               WHERE e.utterance_id=u.id AND e.model=$1 AND e.dimension=$2))`,
      [model, dim],
    );
    return rows.map((r) => r.id);
  }
```
(`Queryable`는 파일 상단에서 이미 import; 없으면 `import { Queryable } from '../jobs/jobs.types';` 추가.)

- [ ] **Step 4: service에 reindex 추가**

In `src/meetings/meetings.service.ts`, add import + method. Import:
```typescript
import { buildIndexMeetingPayload } from '../contracts/job-payload.schema';
```
Method:
```typescript
  async reindex(id: string) {
    const meeting = await this.meetings.findById(this.db.pool, id);
    if (!meeting) throw new NotFoundException('meeting not found');
    return this.db.withTransaction(async (c) => {
      const payload = buildIndexMeetingPayload({
        meetingId: id, processingVersion: meeting.processing_version,
      });
      const job = await this.jobs.enqueue(c, { type: 'index_meeting', meetingId: id, payload });
      return { meeting_id: id, processing_version: meeting.processing_version, job_id: job.id };
    });
  }
```

- [ ] **Step 5: controller에 라우트 추가**

In `src/meetings/meetings.controller.ts`, add (after `reprocess`):
```typescript
  @Post(':id/reindex')
  @HttpCode(202)
  reindex(@Param('id', ParseUUIDPipe) id: string) { return this.service.reindex(id); }
```

- [ ] **Step 6: 실행 — 통과 확인**

Run: `npx jest test/meetings.e2e-spec.ts -t reindex`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/meetings/meetings.repository.ts src/meetings/meetings.service.ts src/meetings/meetings.controller.ts test/meetings.e2e-spec.ts
git commit -m "feat(api): POST /meetings/:id/reindex + reconciler query"
```

---

## Task 14: 전체 스위트 검증 + env 예제 + 문서 동기화

**Files:**
- Modify: `.env.example`
- Modify: `worker/.env.example`
- Modify: `worker/SMOKE.md`
- Modify: `CLAUDE.md` (Python worker 섹션에 검색 인덱싱/embed 서비스 현실 1–2줄)

**Interfaces:** 없음(검증 + 문서).

- [ ] **Step 1: .env.example 갱신 (API)**

In `.env.example`, append:
```
SEARCH_EMBEDDING_MODEL=BAAI/bge-m3
SEARCH_EMBEDDING_DIM=1024
EMBED_SERVICE_URL=http://127.0.0.1:8100
EMBED_SERVICE_TIMEOUT_MS=800
EMBED_SERVICE_ALLOW_NON_LOOPBACK=false
SEARCH_RRF_K=60
SEARCH_CANDIDATE_K=100
```

- [ ] **Step 2: worker/.env.example 갱신**

In `worker/.env.example`, append:
```
SEARCH_EMBEDDING_MODEL=BAAI/bge-m3
SEARCH_EMBEDDING_DIM=1024
EMBED_SERVICE_HOST=127.0.0.1
EMBED_SERVICE_PORT=8100
```

- [ ] **Step 3: SMOKE.md에 embed 서비스 + 인덱싱 실행 순서 추가**

In `worker/SMOKE.md`, add a section documenting: ① 커스텀 PG 이미지(`damwha/postgres-bigm:pg16`) 빌드, ② `uv sync --extra models`, ③ embed 서비스 기동(`uv run uvicorn damwha_worker.embed_service:app --host 127.0.0.1 --port 8100`), ④ 기동 순서(Postgres → embed 서비스 health → API → 워커), ⑤ bge-m3 첫 로드 지연. (Task 9 Step 6 명령 재사용.)

- [ ] **Step 4: CLAUDE.md 워커 섹션 보강**

In `CLAUDE.md`의 "Python worker" 섹션에, 검색 인덱싱이 `index_meeting` 잡(실패는 job-only)이고 쿼리 임베딩은 embed 서비스(localhost RPC, job-table-only 불변식의 단일 예외)라는 1–2줄을 추가.

- [ ] **Step 5: API 전체 스위트**

Run: `npm test`
Expected: 전 스위트 PASS (커스텀 PG 이미지 필요 — Task 1 빌드 선행).

- [ ] **Step 6: 워커 전체 스위트 + 린트**

Run:
```bash
cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format --check .
```
Expected: PASS.

- [ ] **Step 7: 타입 체크**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected: 에러 없음.

- [ ] **Step 8: Commit**

```bash
git add .env.example worker/.env.example worker/SMOKE.md CLAUDE.md
git commit -m "docs+config: search env examples, embed service smoke steps, living-doc sync"
```

---

## Self-Review 결과 (작성자 점검)

- **Spec 커버리지**: §2 스키마→T2 · §3 계약→T3/T4 · §4 인덱싱(원자 enqueue/2-가드/reconciler)→T5/T6/T7/T13 · §4.3 dispatch·실패 분기→T9 · §5 쿼리 SQL/RRF/browse→T11 · §5.1 응답 DTO(camelCase/nested speaker)→T12 · §5.4 top-K/hasMore→T11/T12 · §6 embed 서비스→T8, degrade/loopback→T10 · §10 커스텀 PG 이미지→T1. 누락 없음.
- **플레이스홀더**: 모든 코드 스텝에 실제 코드. pg_bigm 버전 태그는 ARG로 명시(릴리스 변동 시 교체 가능).
- **타입 일관성**: `IndexMeetingPayload`/`search_embedding` shape이 zod(T3)·pydantic(T4)·persist enqueue(T7)·fixture에서 동일. `persist_index_meeting`/`fail_job`/`run_index_meeting`/`SearchRow`/`SearchFilters` 시그니처가 정의 태스크와 소비 태스크에서 일치.
