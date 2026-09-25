# 모델 다운로드 관리 D2 — 받기·삭제 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 › 모델 카드에서 모델을 미리 받고(취소 포함), 안 쓰는 전사·요약 모델을 지운다.

**Architecture:** 받기·삭제는 새 job 종류 `download_model`·`delete_model`로 job 테이블을 탄다(API가 넣고 worker가 처리, FIFO). "그 모델을 쓰는 queued/running job이 있나"는 마이그레이션 027의 SQL 함수 `model_job_refs` 하나가 판정하고 API와 worker가 같은 함수를 부른다. 받기는 D1의 받기 명세(`specs.py`)로 `snapshot_download`를 부르기만 하고, 디스크 점검·진행 보고·무진행 감시는 기존 훅이 맡는다. 취소는 `stop_requested_at` + 훅 감시 루프의 취소 술어다. 결과는 D1의 inventory 지문 규칙이 알아서 화면에 반영한다.

**Tech Stack:** Python 3.12 (psycopg 3, huggingface_hub 1.20.1, pytest, testcontainers) · NestJS 10 + zod + raw SQL (jest, supertest) · React 19 + TanStack Query (vitest) · PostgreSQL 16.

**Spec:** `docs/superpowers/specs/2026-09-25-model-download-management-design.md` (§2.2, §4.4, §5.2~§5.5, §6.4, §7, §8, §9 D2, §10.2). D1은 `adc4557..8886843`로 끝났고 실측을 통과했다(스펙 §11). 계획이 스펙과 어긋나면 **스펙을 따르고** 스펙 §11에 적는다.

## Global Constraints

- D1의 구조를 **덧붙이기만** 한다. `GET /models` 응답의 기존 필드 의미를 바꾸지 않는다(새 필드 `job`·`freeBytes` 추가만).
- 받기·삭제의 식별자는 **논리 키** `role:name:backend`(backend 없으면 빈 문자열)다. repo 풀이에 기대지 않는다(스펙 §5.2).
- 삭제는 `DELETABLE_ROLES`(`stt`·`summary`)만. 고정 역할은 받기만 된다.
- "쓰는 모델" 판정 규칙은 SQL 함수 `model_job_refs` **하나**에만 있다. TS·Python에 사본을 두지 않는다.
- 오류 본문은 `{ statusCode, code, message }`(`DemoReadOnlyGuard`와 같은 모양). fe는 `code`로 문구를 고른다 — 자유 문구로 고르지 않는다.
- 디스크 부족 코드는 worker `errors.DISK_FULL` = **`"DISK_FULL"`**(대문자) 그대로 쓴다.
- 취소된 job은 `failed` + `error.code = "download_cancelled"`, 화면에 오류를 보이지 않는다.
- 미리 받기가 최종 실패(재시도 없음)·취소로 끝나면 그 repo의 `model_readiness` key를 **지운다**(desktop 상태 창이 "다시 시작"을 권하지 않게, 스펙 §7.4). desktop 코드는 고치지 않는다.
- 사용자 문구: 서비스·라이브러리 이름(worker, embed, pyannote, speechbrain, bge) 금지. "작업 처리기", "전사 모델" 등 D1 용어.
- fe: `useEffect`+`setState` 금지. 파생 값은 렌더 중 계산.
- 코드 주석·UI 문구·커밋 메시지는 한국어. 커밋 메시지 끝에 `Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC`.
- 테스트 명령: worker `uv run --directory be/worker pytest -q <파일>`(파일 지정) / 전체 `pnpm worker:test` · be `pnpm --filter damwha-be exec jest --runInBand <패턴>` / 전체 `pnpm be test` · be 정적 검사 `pnpm --filter damwha-be exec tsc --noEmit`(be에는 lint 설정이 없다) · fe `pnpm --filter damwha-fe exec vitest run <경로>` · `pnpm fe lint` · `pnpm --filter damwha-fe exec tsc -b` · contracts 빌드 `pnpm --filter @damwha/contracts build`.
- 루트에서 패키지를 직접 띄우지 않는다. `npm install` 금지. 파괴적 git 명령 금지.

## Review Focus

1. **같은 모델을 두 번 빠르게 누름** (받기 연타, 받기·삭제 교차) — job은 하나만 생긴다(advisory lock + 멱등). → Task 5 `concurrent download requests insert one job`.
2. **옛 payload(v1 `device: mps|cpu|cuda`, `schema_version` 없음, v1/v2 `summary_model` 없음)를 가진 queued job** — 삭제가 그 모델을 "사용 중"으로 막는다. → Task 1 `model_job_refs` 표.
3. **TRANSIENT로 재queue된 받기 job에 이미 취소가 찍힘** — 다시 받지 않고 취소로 닫힌다. → Task 3 `test_download_already_cancelled_at_start`.
4. **받는 도중 디스크가 참(ENOSPC)** — "인터넷 연결" 안내가 아니라 디스크 부족 안내. → Task 3 `test_download_enospc_is_disk_full`.
5. **목록 밖 렌즈 모델(BE·worker env 값)의 받기** — 400이 아니라 받아진다. 삭제는 사용 중이라 409. → Task 5.

---

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `be/src/database/migrations/027_model_jobs.sql` (신설) | job type·stage CHECK, `model_job_refs` 함수 | 1 |
| `be/test/model-job-refs.spec.ts` (신설), `be/test/migration.spec.ts` (추가) | 참조 판정 표, 027 적용 | 1 |
| `be/src/contracts/job-payload.schema.ts`, `be/src/jobs/jobs.types.ts` (수정) | `ModelJobPayloadSchema`, `JobType` | 2 |
| `be/worker/damwha_worker/contracts.py` (수정) | `ModelJobPayload`, 지원 버전 | 2 |
| `be/test/fixtures/job-payloads/model_job.*.json` (신설) | 양쪽 계약 픽스처 | 2 |
| `be/test/contract-fixtures.spec.ts`, `be/worker/tests/test_contracts_model_jobs.py` (추가/신설) | 계약 테스트 | 2 |
| `be/worker/damwha_worker/models/downloads.py` (수정) | `cancel_when`, 취소 술어, `DownloadCancelled` | 3 |
| `be/worker/damwha_worker/errors.py` (수정) | `DOWNLOAD_CANCELLED`, `MODEL_IN_USE`, `MODEL_NOT_DELETABLE` 코드 | 3 |
| `be/worker/damwha_worker/db/model_jobs.py` (신설), `db/__init__.py` (수정) | job 완료·취소 읽기·readiness key 제거·참조 호출 | 3 |
| `be/worker/damwha_worker/pipeline/model_jobs.py` (신설) | 받기·삭제 본체 | 3, 4 |
| `be/worker/damwha_worker/jobs.py`, `dispatch.py` (수정) | 핸들러 등록, `JobContext.hf_token` | 3, 4 |
| `be/worker/damwha_worker/models/cache_scan.py`, `__main__.py`, `inventory.py` (수정) | 오래된 `.incomplete` 청소, `free_bytes` | 4 |
| `be/worker/tests/test_model_jobs.py`, `test_downloads.py` (신설/추가) | | 3, 4 |
| `be/src/models/model-jobs.ts` (신설), `models.service.ts`·`models.controller.ts`·`models-view.ts`·`model-inventory.ts` (수정) | POST 세 개, 행 `job`, `freeBytes` | 5 |
| `be/test/models-jobs.e2e-spec.ts` (신설), `models-view.spec.ts` (추가) | | 5 |
| `fe/src/shared/api/client.ts` (수정) | `ApiError.code` 일반화 | 6 |
| `fe/src/features/models/api/models.ts`·`types.ts` (수정), `lib/actions.ts` (신설) | 뮤테이션, 행 동작·오류 문구 | 6 |
| `fe/src/features/models/ui/models-card.tsx` (수정), `ui/model-row-actions.tsx`·`ui/delete-model-dialog.tsx` (신설) | 버튼·확인·게이트 | 7 |
| `docs/MODELS.md`, `docs/HUGGINGFACE.md`, `be/CLAUDE.md`, `fe/CLAUDE.md` (수정) | 문서 | 8 |

---

### Task 1: 마이그레이션 027 — job type·stage, `model_job_refs`

**Files:**
- Create: `be/src/database/migrations/027_model_jobs.sql`
- Create: `be/test/model-job-refs.spec.ts`
- Modify: `be/test/migration.spec.ts` (027 케이스 추가)

**Interfaces:**
- Produces: SQL 함수 `model_job_refs(p_role text, p_name text, p_backend text, p_lens_models text[], p_summary_fallback text, p_exclude_job text) RETURNS SETOF text` — 그 논리 키의 모델을 쓰는 queued/running job id들. job type `download_model`·`delete_model`, stage `download_model`·`delete_model` 허용.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/model-job-refs.spec.ts`:

```ts
import { startTestDb, StartedTestDb } from './db';

/**
 * `model_job_refs` — "그 모델을 쓰는 queued/running job" 판정 (스펙 §5.4). API와 worker가 같은 함수를
 * 부르므로 규칙은 여기 한 곳에서만 고정한다.
 */
describe('model_job_refs', () => {
  let db: StartedTestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await db?.stop(); });

  const LENS = ['mlx-community/Qwen3.5-4B-8bit'];
  const FALLBACK = 'mlx-community/Qwen3.5-4B-8bit';

  async function job(type: string, payload: unknown, status = 'queued'): Promise<string> {
    const r = await db.pool.query(
      `INSERT INTO job(type, payload, status) VALUES($1, $2::jsonb, $3) RETURNING id`,
      [type, JSON.stringify(payload), status],
    );
    return r.rows[0].id;
  }
  async function refs(role: string, name: string, backend: string | null, exclude: string | null = null) {
    const r = await db.pool.query(
      `SELECT * FROM model_job_refs($1, $2, $3, $4::text[], $5, $6) AS id`,
      [role, name, backend, LENS, FALLBACK, exclude],
    );
    return r.rows.map((x) => x.id).sort();
  }

  const v5 = (over: Record<string, unknown> = {}) => ({
    schema_version: 5,
    models: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'mlx-community/Qwen3.5-9B-8bit' },
    followups: { lens: true, summary: true },
    ...over,
  });

  it('v5: 전사는 이름과 백엔드가 모두 맞아야 한다', async () => {
    const id = await job('process_meeting', v5());
    expect(await refs('stt', 'small', 'faster')).toEqual([id]);
    expect(await refs('stt', 'small', 'mlx')).toEqual([]);
    expect(await refs('stt', 'medium', 'faster')).toEqual([]);
  });

  it('v1: device mps→mlx, cpu·cuda→faster, schema_version 없어도 v1', async () => {
    const mps = await job('process_meeting', { models: { whisper_model: 'large-v3', device: 'mps' } });
    const cuda = await job('process_meeting', { schema_version: 1, models: { whisper_model: 'large-v3', device: 'cuda' } });
    expect(await refs('stt', 'large-v3', 'mlx')).toEqual([mps]);
    expect(await refs('stt', 'large-v3', 'faster')).toEqual([cuda]);
  });

  it('요약: summary_model, 없으면(v1·v2) 대체값, followups.summary false면 안 씀', async () => {
    const withModel = await job('process_meeting', v5());
    const v2 = await job('process_meeting', { schema_version: 2, models: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'gpu' } } });
    await job('process_meeting', v5({ followups: { lens: false, summary: false } }));
    expect(await refs('summary', 'mlx-community/Qwen3.5-9B-8bit', null)).toEqual([withModel]);
    // v2는 요약 대체값(4B)과 렌즈(v1~v4는 항상 참, 4B)로 4B를 쓴다
    expect(await refs('summary', 'mlx-community/Qwen3.5-4B-8bit', null)).toEqual([withModel, v2].sort());
  });

  it('렌즈: followups.lens가 참이거나 필드가 없으면 렌즈 모델을 쓴다', async () => {
    const off = await job('process_meeting', v5({ followups: { lens: false, summary: true } }));
    const on = await job('process_meeting', v5());
    const r = await refs('summary', 'mlx-community/Qwen3.5-4B-8bit', null);
    expect(r).toContain(on);
    expect(r).not.toContain(off);
  });

  it('summarize_meeting·extract_lenses의 model', async () => {
    const s = await job('summarize_meeting', { schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' });
    const l = await job('extract_lenses', { schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' });
    expect(await refs('summary', 'mlx-community/Qwen3.5-27B-8bit', null)).toEqual([s, l].sort());
  });

  it('live_session은 process 블록의 전사·요약을 본다', async () => {
    const id = await job('live_session', { schema_version: 1, process: v5() });
    expect(await refs('stt', 'small', 'faster')).toEqual([id]);
    expect(await refs('summary', 'mlx-community/Qwen3.5-9B-8bit', null)).toEqual([id]);
  });

  it('done·failed job은 세지 않고, p_exclude_job은 뺀다', async () => {
    await job('process_meeting', v5(), 'done');
    await job('process_meeting', v5(), 'failed');
    const running = await job('process_meeting', v5(), 'running');
    expect(await refs('stt', 'small', 'faster')).toEqual([running]);
    expect(await refs('stt', 'small', 'faster', running)).toEqual([]);
  });

  it('고정 역할은 아무것도 돌려주지 않는다 (삭제 대상이 아니다)', async () => {
    await job('process_meeting', v5());
    expect(await refs('diarization', 'pyannote/speaker-diarization-community-1', null)).toEqual([]);
  });
});
```

`be/test/migration.spec.ts` — 026 케이스 뒤에 추가(같은 파일의 기존 헬퍼·DB 수명주기를 따른다):

```ts
  it('027 allows download_model/delete_model job types and their stages', async () => {
    const r = await db.pool.query(
      `INSERT INTO job(type, payload, stage) VALUES ('download_model', '{}'::jsonb, 'download_model'),
                                               ('delete_model', '{}'::jsonb, 'delete_model') RETURNING id`,
    );
    expect(r.rowCount).toBe(2);
    await expect(
      db.pool.query(`INSERT INTO job(type, payload) VALUES ('nope', '{}'::jsonb)`),
    ).rejects.toThrow(/job_type_check/);
  });
```

> `migration.spec.ts`의 기존 케이스가 DB를 어떻게 여는지(`startTestDb` 또는 파일 단위 적용) 먼저 읽고 같은 방식으로 쓴다. 검증 내용은 위 두 가지다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand model-job-refs migration`
Expected: FAIL — `function model_job_refs(...) does not exist`, `job_type_check` 위반

- [ ] **Step 3: 마이그레이션을 쓴다**

`be/src/database/migrations/027_model_jobs.sql`:

```sql
-- 모델 받기·삭제 job (모델 다운로드 관리 스펙 §4.4·§5.4).
--
-- 1. job type·stage에 download_model·delete_model을 더한다. meeting_id는 null이다.
-- 2. model_job_refs — "그 모델을 쓰는 queued/running job" 판정. API(삭제 409)와 worker(delete_model
--    실행 직전 재검사)가 **같은 함수**를 부른다. 규칙을 TS·Python에 따로 두면 v1 payload의
--    device(mps→gpu) 해석처럼 한쪽에만 있는 규칙이 갈린다.
--
-- 식별자는 논리 키(role·name·backend)다 — payload도 저장소가 아니라 이름·장치를 싣기 때문이다.
--   전사: models.whisper_model = name 이고 백엔드(devices.stt, v1은 device: mps→gpu, 그 밖→cpu;
--         gpu→mlx, cpu→faster) = backend.
--   요약: summary_model(v1·v2는 없음 → p_summary_fallback) — followups.summary가 거짓이면 안 쓴다
--         (v1~v4는 그 필드가 없고 항상 참). 렌즈 모델(p_lens_models)은 followups.lens가 참이거나 필드가
--         없을 때 쓴다. summarize_meeting·extract_lenses는 payload.model.
--   live_session: payload.process가 v5 process_meeting payload다 — 같은 규칙.
--   고정 역할: 삭제 대상이 아니므로 아무것도 돌려주지 않는다.
ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting',
                  'extract_lenses','summarize_meeting','live_session',
                  'download_model','delete_model'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary',
                   'capture','finalize',
                   'download_model','delete_model'));

CREATE OR REPLACE FUNCTION model_job_refs(
  p_role text, p_name text, p_backend text,
  p_lens_models text[], p_summary_fallback text, p_exclude_job text
) RETURNS SETOF text LANGUAGE sql STABLE AS $$
  WITH active AS (
    SELECT id, type, payload FROM job
    WHERE status IN ('queued', 'running')
      AND (p_exclude_job IS NULL OR id <> p_exclude_job)
  ),
  proc AS (
    SELECT id, payload AS p FROM active WHERE type = 'process_meeting'
    UNION ALL
    SELECT id, payload -> 'process' FROM active WHERE type = 'live_session'
  ),
  norm AS (
    SELECT id,
           p -> 'models' ->> 'whisper_model' AS whisper,
           CASE COALESCE(p -> 'models' -> 'devices' ->> 'stt',
                         CASE p -> 'models' ->> 'device' WHEN 'mps' THEN 'gpu' ELSE 'cpu' END)
             WHEN 'gpu' THEN 'mlx' ELSE 'faster' END AS backend,
           COALESCE(p -> 'models' ->> 'summary_model', p_summary_fallback) AS summary,
           COALESCE((p -> 'followups' ->> 'summary')::boolean, true) AS uses_summary,
           COALESCE((p -> 'followups' ->> 'lens')::boolean, true) AS uses_lens
    FROM proc
  )
  SELECT id FROM norm
   WHERE p_role = 'stt' AND whisper = p_name AND backend = p_backend
  UNION
  SELECT id FROM norm
   WHERE p_role = 'summary'
     AND ((uses_summary AND summary = p_name) OR (uses_lens AND p_name = ANY (p_lens_models)))
  UNION
  SELECT id FROM active
   WHERE p_role = 'summary'
     AND type IN ('summarize_meeting', 'extract_lenses')
     AND payload ->> 'model' = p_name
$$;
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand model-job-refs migration`
Expected: PASS

- [ ] **Step 5: worker 테스트 DB도 027을 탄다** — worker `conftest.py`가 마이그레이션 디렉터리 전체를 적용하므로 따로 할 일은 없다. `uv run --directory be/worker pytest -q tests/test_db_lifecycle.py`가 통과하는지만 확인한다.

- [ ] **Step 6: 변이 검증** — `COALESCE(...'summary')::boolean, true)`를 `true`로 바꾸면 "followups.summary false면 안 씀"이, v1 `CASE ... WHEN 'mps'`를 `'cpu'`로 바꾸면 "v1: device" 케이스가 FAIL하는지 보고 되돌린다.

- [ ] **Step 7: 커밋**

```bash
git add be/src/database/migrations/027_model_jobs.sql be/test/model-job-refs.spec.ts be/test/migration.spec.ts
git commit -m "feat(db): 모델 받기·삭제 job과 사용 중 판정 함수

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 2: payload 계약 (zod·pydantic·픽스처)

**Files:**
- Modify: `be/src/contracts/job-payload.schema.ts` (파일 끝, `LiveSessionPayloadSchema` 뒤)
- Modify: `be/src/jobs/jobs.types.ts` (`JobType`)
- Modify: `be/worker/damwha_worker/contracts.py` (`SUPPORTED_SCHEMA_VERSIONS`, 모델, `parse_payload`)
- Create: `be/test/fixtures/job-payloads/model_job.stt.valid.json`, `model_job.summary.valid.json`, `model_job.summary_with_backend.invalid.json`, `model_job.stt_without_backend.invalid.json`
- Modify: `be/test/contract-fixtures.spec.ts`
- Create: `be/worker/tests/test_contracts_model_jobs.py`

**Interfaces:**
- Produces:
  - TS: `ModelJobPayloadSchema`, `type ModelJobPayload = { schema_version: 1; role: ModelRole; name: string; backend?: SttBackend }`, `buildModelJobPayload(k: { role: ModelRole; name: string; backend: SttBackend | null }): ModelJobPayload`, `JobType`에 `'download_model' | 'delete_model'`.
  - Python: `ModelJobPayload(schema_version: Literal[1], role: Literal[...], name: str, backend: Literal["mlx","faster"] | None)`; `parse_payload("download_model"|"delete_model", data) -> ModelJobPayload`.

- [ ] **Step 1: 픽스처를 쓴다**

`model_job.stt.valid.json`:
```json
{ "schema_version": 1, "role": "stt", "name": "small", "backend": "faster" }
```
`model_job.summary.valid.json`:
```json
{ "schema_version": 1, "role": "summary", "name": "mlx-community/Qwen3.5-9B-8bit" }
```
`model_job.summary_with_backend.invalid.json`:
```json
{ "schema_version": 1, "role": "summary", "name": "mlx-community/Qwen3.5-9B-8bit", "backend": "mlx" }
```
`model_job.stt_without_backend.invalid.json`:
```json
{ "schema_version": 1, "role": "stt", "name": "small" }
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`be/test/contract-fixtures.spec.ts`의 describe 안, 끝에 추가(import에 `ModelJobPayloadSchema`):

```ts
  it('model_job: 전사는 backend 필수, 그 밖은 backend 금지', () => {
    expect(ModelJobPayloadSchema.parse(read('model_job.stt.valid.json')).backend).toBe('faster');
    expect(ModelJobPayloadSchema.parse(read('model_job.summary.valid.json')).role).toBe('summary');
    expect(() => ModelJobPayloadSchema.parse(read('model_job.summary_with_backend.invalid.json'))).toThrow();
    expect(() => ModelJobPayloadSchema.parse(read('model_job.stt_without_backend.invalid.json'))).toThrow();
  });
```

`be/worker/tests/test_contracts_model_jobs.py`:

```python
"""download_model·delete_model payload v1 — be 픽스처를 그대로 읽는다 (zod와 같은 판정)."""

import json
from pathlib import Path

import pytest

from damwha_worker.contracts import ModelJobPayload, parse_payload

FIX = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def _read(name):
    return json.loads((FIX / name).read_text())


@pytest.mark.parametrize("job_type", ["download_model", "delete_model"])
def test_valid_fixtures_parse(job_type):
    p = parse_payload(job_type, _read("model_job.stt.valid.json"))
    assert isinstance(p, ModelJobPayload)
    assert (p.role, p.name, p.backend) == ("stt", "small", "faster")
    s = parse_payload(job_type, _read("model_job.summary.valid.json"))
    assert (s.role, s.backend) == ("summary", None)


@pytest.mark.parametrize(
    "name",
    ["model_job.summary_with_backend.invalid.json", "model_job.stt_without_backend.invalid.json"],
)
def test_invalid_fixtures_rejected(name):
    with pytest.raises(ValueError):
        parse_payload("download_model", _read(name))


def test_unknown_role_rejected():
    with pytest.raises(ValueError):
        parse_payload("delete_model", {"schema_version": 1, "role": "vad", "name": "x"})
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand contract-fixtures` → FAIL (`ModelJobPayloadSchema` 없음)
Run: `uv run --directory be/worker pytest -q tests/test_contracts_model_jobs.py` → FAIL (`ModelJobPayload` 없음)

- [ ] **Step 4: zod와 JobType**

`be/src/contracts/job-payload.schema.ts` — import에 `MODEL_ROLES, STT_BACKENDS`(및 타입 `ModelRole, SttBackend`)를 `@damwha/contracts`에서 더하고, 파일 끝 스키마 묶음 뒤에:

```ts
// 모델 받기·삭제 (모델 다운로드 관리 스펙 §4.4). 식별자는 논리 키 — 저장소는 worker가 받기 명세로 푼다.
// backend는 전사(stt)에만 있고, 그 밖의 역할에 있으면 거부한다(같은 모델을 두 키로 부르지 않게).
export const ModelJobPayloadSchema = z
  .object({
    schema_version: z.literal(1),
    role: z.enum(MODEL_ROLES),
    name: z.string().min(1),
    backend: z.enum(STT_BACKENDS).optional(),
  })
  .strict()
  .refine((p) => (p.role === 'stt') === (p.backend !== undefined), {
    message: 'backend is required for role "stt" and forbidden otherwise',
  });
export type ModelJobPayload = z.infer<typeof ModelJobPayloadSchema>;

export function buildModelJobPayload(k: {
  role: ModelRole; name: string; backend: SttBackend | null;
}): ModelJobPayload {
  return k.backend === null
    ? { schema_version: 1, role: k.role, name: k.name }
    : { schema_version: 1, role: k.role, name: k.name, backend: k.backend };
}
```

`be/src/jobs/jobs.types.ts` — `JobType`에 `| 'download_model' | 'delete_model'`를 더한다.

- [ ] **Step 5: pydantic**

`be/worker/damwha_worker/contracts.py` — `SUPPORTED_SCHEMA_VERSIONS`에 `"download_model": frozenset({1}), "delete_model": frozenset({1}),`을 더하고, `LiveSessionPayload` 정의 뒤에:

```python
ModelRole = Literal["stt", "summary", "diarization", "speaker_embedding", "search_embedding"]


class ModelJobPayload(BaseModel):
    """download_model·delete_model payload v1 (모델 다운로드 관리 스펙 §4.4).

    식별자는 논리 키(role·name·backend)다. backend는 전사에만 있고 그 밖에서는 없어야 한다 —
    zod(`ModelJobPayloadSchema`)와 같은 판정.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    role: ModelRole
    name: NonEmptyString
    backend: Literal["mlx", "faster"] | None = None

    @model_validator(mode="after")
    def _backend_only_for_stt(self):
        if (self.role == "stt") != (self.backend is not None):
            raise ValueError('backend is required for role "stt" and forbidden otherwise')
        return self
```

`parse_payload`의 분기 끝(`summarize_meeting` 분기 뒤)에:

```python
    if job_type in ("download_model", "delete_model"):
        return ModelJobPayload.model_validate(data)
```

> pydantic `ValidationError`는 `ValueError`의 하위 클래스다 — 테스트의 `pytest.raises(ValueError)`가 잡는다. 기존 `parse_payload`가 검증 실패를 어떻게 올리는지(그대로 두는지 감싸는지) 확인하고 같게 둔다.

- [ ] **Step 6: 통과·정적 검사**

Run: `pnpm --filter damwha-be exec jest --runInBand contract-fixtures job-payload` → PASS
Run: `uv run --directory be/worker pytest -q tests/test_contracts_model_jobs.py tests/test_contracts.py` → PASS
Run: `pnpm --filter damwha-be exec tsc --noEmit` · `uv run --directory be/worker ruff check damwha_worker tests` → 오류 없음

- [ ] **Step 7: 커밋**

```bash
git add be/src/contracts/job-payload.schema.ts be/src/jobs/jobs.types.ts be/worker/damwha_worker/contracts.py \
  be/test/fixtures/job-payloads/model_job.*.json be/test/contract-fixtures.spec.ts be/worker/tests/test_contracts_model_jobs.py
git commit -m "feat(contracts): 모델 받기·삭제 job payload v1

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 3: worker `download_model` — 받기·취소·실패 정리

**Files:**
- Modify: `be/worker/damwha_worker/errors.py` (코드 3개)
- Modify: `be/worker/damwha_worker/models/downloads.py` (`cancel_when`, `_run_watched`, `_is_benign`)
- Create: `be/worker/damwha_worker/db/model_jobs.py`; Modify: `db/__init__.py`
- Create: `be/worker/damwha_worker/pipeline/model_jobs.py`
- Modify: `be/worker/damwha_worker/jobs.py` (`JobContext.hf_token`, `DownloadModelHandler`), `dispatch.py` (`hf_token` 배선)
- Test: `be/worker/tests/test_model_jobs.py`, `be/worker/tests/test_downloads.py` (추가)

**Interfaces:**
- Consumes: `specs.spec_for(role, name, backend)` (D1), `ModelJobPayload` (Task 2), `model_job_refs` (Task 1), `core.merge_model_readiness`/`MODEL_READINESS_KEY`
- Produces:
  - `errors.DOWNLOAD_CANCELLED = "download_cancelled"`, `errors.MODEL_IN_USE = "model_in_use"`, `errors.MODEL_NOT_DELETABLE = "model_not_deletable"`
  - `downloads.DownloadCancelled(errors.WorkerError)`; `downloads.cancel_when(predicate: Callable[[], bool])` 컨텍스트 매니저
  - `db.complete_job(conn, job_id, worker_id) -> bool`, `db.stop_requested(conn, job_id) -> bool`, `db.remove_model_readiness_key(conn, key) -> None`, `db.model_job_refs(conn, role, name, backend, lens_models, summary_fallback, exclude_job) -> list[str]`
  - `pipeline.model_jobs.run_download_model(conn, job, payload, *, worker_id, hf_token, snapshot=None) -> str`
  - `jobs.DownloadModelHandler` (type `download_model`)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_model_jobs.py`:

```python
"""download_model·delete_model (모델 다운로드 관리 스펙 §7). 실 DB(`conn`)와 가짜 snapshot으로 돈다."""

import errno

import pytest
from psycopg.types.json import Jsonb

from damwha_worker import db, errors
from damwha_worker.contracts import ModelJobPayload
from damwha_worker.db import core
from damwha_worker.models import downloads
from damwha_worker.pipeline import model_jobs
from tests.conftest import seed_job

W = "w-test"


@pytest.fixture(autouse=True)
def _clean(conn, monkeypatch):
    monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    conn.execute("DELETE FROM app_setting WHERE key=%s", (core.MODEL_READINESS_KEY,))
    yield
    conn.execute("DELETE FROM app_setting WHERE key=%s", (core.MODEL_READINESS_KEY,))


def _running(conn, type_, payload):
    jid = seed_job(conn, type=type_, payload=payload, status="running", locked_by=W, attempts=1)
    return conn.execute("SELECT * FROM job WHERE id=%s", (jid,)).fetchone()


def _p(**kw):
    return ModelJobPayload.model_validate({"schema_version": 1, **kw})


def _status(conn, jid):
    return conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()


def test_download_calls_snapshot_with_spec_and_completes(conn):
    job = _running(conn, "download_model", {"schema_version": 1, "role": "search_embedding",
                                             "name": "BAAI/bge-m3"})
    calls = []
    out = model_jobs.run_download_model(
        conn, job, _p(role="search_embedding", name="BAAI/bge-m3"), worker_id=W, hf_token="t",
        snapshot=lambda **kw: calls.append(kw) or "/tmp/x",
    )
    assert out == "committed"
    assert calls[0]["repo_id"] == "BAAI/bge-m3"
    assert calls[0]["revision"] == "9a0624b896d81da7492a910ffa53731274b6cf3d"
    assert "model.safetensors" in calls[0]["allow_patterns"]
    assert calls[0]["token"] == "t"
    assert _status(conn, job["id"])["status"] == "done"


def test_download_without_spec_uses_name_as_repo(conn):
    job = _running(conn, "download_model", {"schema_version": 1, "role": "summary", "name": "org/custom-lens"})
    calls = []
    model_jobs.run_download_model(conn, job, _p(role="summary", name="org/custom-lens"), worker_id=W,
                                  hf_token=None, snapshot=lambda **kw: calls.append(kw) or "/x")
    assert calls[0]["repo_id"] == "org/custom-lens"
    assert calls[0].get("allow_patterns") is None


def test_download_already_cancelled_at_start(conn):
    job = _running(conn, "download_model", {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"})
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    with pytest.raises(downloads.DownloadCancelled):
        model_jobs.run_download_model(conn, job, _p(role="stt", name="tiny", backend="mlx"), worker_id=W,
                                      hf_token=None, snapshot=lambda **kw: pytest.fail("must not download"))


def test_download_enospc_is_disk_full(conn):
    job = _running(conn, "download_model", {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"})

    def boom(**_kw):
        raise OSError(errno.ENOSPC, "No space left on device")

    with pytest.raises(errors.WorkerError) as ei:
        model_jobs.run_download_model(conn, job, _p(role="stt", name="tiny", backend="mlx"), worker_id=W,
                                      hf_token=None, snapshot=boom)
    assert ei.value.code == errors.DISK_FULL
    assert ei.value.kind is errors.ErrorKind.PERMANENT


def test_remove_model_readiness_key_is_atomic_and_scoped(conn):
    core.merge_model_readiness(conn, "a/b", {"state": "failed"}, "w")
    core.merge_model_readiness(conn, "c/d", {"state": "ready"}, "w")
    db.remove_model_readiness_key(conn, "a/b")
    entries = core.read_model_readiness(conn)["entries"]
    assert "a/b" not in entries and "c/d" in entries
    db.remove_model_readiness_key(conn, "missing/key")  # 없는 key는 무해하다


def test_stop_requested(conn):
    job = _running(conn, "download_model", {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"})
    assert db.stop_requested(conn, job["id"]) is False
    conn.execute("UPDATE job SET stop_requested_at=now() WHERE id=%s", (job["id"],))
    assert db.stop_requested(conn, job["id"]) is True


def test_handler_final_failure_removes_readiness_key(conn):
    from damwha_worker.jobs import DownloadModelHandler, JobContext

    job = _running(conn, "download_model", {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"})
    core.merge_model_readiness(conn, "mlx-community/whisper-tiny", {"state": "failed"}, W)
    ctx = JobContext(storage=None, worker_id=W)
    out = DownloadModelHandler().on_failure(conn, job, ctx, {"code": "model_download_failed"}, retry=False)
    assert out == "failed"
    assert "mlx-community/whisper-tiny" not in core.read_model_readiness(conn)["entries"]


def test_handler_retry_keeps_readiness_key(conn):
    from damwha_worker.jobs import DownloadModelHandler, JobContext

    job = _running(conn, "download_model", {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"})
    core.merge_model_readiness(conn, "mlx-community/whisper-tiny", {"state": "failed"}, W)
    out = DownloadModelHandler().on_failure(conn, job, JobContext(storage=None, worker_id=W),
                                            {"code": "model_download_failed"}, retry=True)
    assert out == "requeued"
    assert "mlx-community/whisper-tiny" in core.read_model_readiness(conn)["entries"]


def test_handler_cancel_closes_as_cancelled_without_retry(conn):
    from damwha_worker.jobs import DownloadModelHandler, JobContext

    job = _running(conn, "download_model", {"schema_version": 1, "role": "stt", "name": "tiny", "backend": "mlx"})
    err = downloads.DownloadCancelled("mlx-community/whisper-tiny").to_json()
    out = DownloadModelHandler().on_failure(conn, job, JobContext(storage=None, worker_id=W), err, retry=True)
    assert out == "failed"
    row = _status(conn, job["id"])
    assert row["status"] == "failed" and row["error"]["code"] == errors.DOWNLOAD_CANCELLED
```

`be/worker/tests/test_downloads.py` 끝에 추가(파일의 기존 설치·가짜 원본 헬퍼를 그대로 쓴다 — 무진행 감시 테스트가 `_run_watched`를 부르는 방식과 같게):

```python
def test_cancel_when_releases_caller_and_is_not_recorded_as_failed(monkeypatch):
    """취소 술어가 참이 되면 호출자를 풀고 DownloadCancelled를 던진다. readiness에 failed를 남기지 않는다."""
    import threading

    from damwha_worker.models import downloads

    monkeypatch.setattr(downloads._STATE, "stall_seconds", 60.0)
    monkeypatch.setattr(downloads, "_WATCHDOG_TICK_SECONDS", 0.01)
    gate = threading.Event()
    report = downloads._Report(conn=None, key="org/m", writer="w")
    failed = []
    monkeypatch.setattr(report, "fail", lambda exc: failed.append(exc))
    flag = {"stop": False}

    def blocked(**_kw):
        gate.wait(5)
        return "late"

    def cancel_soon():
        flag["stop"] = True

    threading.Timer(0.05, cancel_soon).start()
    with downloads.cancel_when(lambda: flag["stop"]):
        with pytest.raises(downloads.DownloadCancelled):
            with downloads.report_download(None, "org/m", "w") as r:
                r.fail = report.fail
                downloads._run_watched(blocked, (), {}, r, "org/m")
    gate.set()
    assert failed == []


def test_cancel_when_is_thread_local_and_restores():
    from damwha_worker.models import downloads

    assert downloads._current_cancel() is None
    with downloads.cancel_when(lambda: False):
        assert downloads._current_cancel() is not None
    assert downloads._current_cancel() is None
```

> `test_downloads.py`의 기존 fixture가 `_STATE`를 되돌리는 방식(`_uninstall` 등)과 `report_download`가 `conn=None`을 받는지 먼저 확인한다. `_Report`가 `core.shared_state_enabled()`를 읽으므로 `DAMWHA_SHARED_STATE=off`를 monkeypatch해 DB 쓰기를 끄는 편이 단순하면 그렇게 한다. 검증 내용은 두 가지다: (1) 술어가 참이면 호출자가 `DownloadCancelled`로 풀린다, (2) 그 예외는 `failed`로 적히지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `uv run --directory be/worker pytest -q tests/test_model_jobs.py tests/test_downloads.py -k "cancel or model_jobs or download or readiness or stop"`
Expected: FAIL — `cannot import name 'model_jobs'` 등

- [ ] **Step 3: 오류 코드**

`be/worker/damwha_worker/errors.py` — `DISK_FULL` 정의 근처에:

```python
# 모델 받기·삭제 job (모델 다운로드 관리 스펙 §7). 셋 다 PERMANENT로 쓰인다 — 다시 해도 같다.
DOWNLOAD_CANCELLED = "download_cancelled"  # 사용자가 받기를 취소했다 (화면에 오류로 보이지 않는다)
MODEL_IN_USE = "model_in_use"  # 지우려는 모델을 queued/running job이 쓴다
MODEL_NOT_DELETABLE = "model_not_deletable"  # 고정 역할 — 받기만 된다
```

- [ ] **Step 4: 취소 술어**

`be/worker/damwha_worker/models/downloads.py` — `_cache_first_attempt` 정의 뒤에:

```python
# ── 받기 취소 (모델 다운로드 관리 스펙 §7.2) ───────────────────────────
#
# `_run_watched`는 handler가 아니라 훅(`hooked`)이 부른다 — handler가 술어를 인자로 넘길 길이 없다.
# 그래서 캐시 우선 시도(`_CACHE_FIRST`)와 같은 스레드 로컬로 건다. `snapshot_download`의 바깥 호출은
# 이 스레드에서 훅을 지나고, 감시 루프도 이 스레드에서 돈다.

_CANCEL = threading.local()


class DownloadCancelled(errors.WorkerError):
    """사용자가 받기를 취소했다. PERMANENT — 재시도하지 않는다. readiness에 `failed`로 적지 않는다."""

    def __init__(self, key: str) -> None:
        super().__init__(
            errors.DOWNLOAD_CANCELLED, f"download of {key!r} was cancelled", errors.ErrorKind.PERMANENT
        )


def _current_cancel():
    return getattr(_CANCEL, "predicate", None)


@contextlib.contextmanager
def cancel_when(predicate):
    """이 스레드의 다운로드를 `predicate()`가 참이 되는 순간 끝낸다(감시 주기마다 한 번 부른다)."""
    previous = _current_cancel()
    _CANCEL.predicate = predicate
    try:
        yield
    finally:
        _CANCEL.predicate = previous
```

`_is_benign`에 취소를 더한다(취소는 모델의 실패가 아니다):

```python
def _is_benign(exc: BaseException) -> bool:
    """허브에 **없는** 파일을 물은 것 — transformers가 선택 파일(adapter_config.json …)마다 그렇게
    묻고 404를 삼킨다. 받을 것이 없었으므로 모델의 실패가 아니다. 사용자의 취소도 실패가 아니다."""
    if isinstance(exc, DownloadCancelled):
        return True
    return any(cls.__name__ == "RemoteEntryNotFoundError" for cls in type(exc).__mro__)
```

> `DownloadCancelled`는 `_is_benign`보다 아래에 정의되지만 함수 본문 안에서 이름을 찾으므로 호출 시점에는 정의돼 있다.

`_run_watched` — 감시가 꺼진 경로(`limit <= 0`)에서도 취소를 볼 수 있도록 판정 순서를 바꾸고, 루프에 술어를 더한다:

```python
    limit = _STATE.stall_seconds
    cancel = _current_cancel()
    if limit <= 0 and cancel is None:
        return original(*args, **kwargs)
    ...  # box·done·_run·스레드 시작은 그대로
    while not done.wait(_WATCHDOG_TICK_SECONDS):
        if cancel is not None and not done.is_set():
            try:
                stop = cancel()
            except Exception:  # noqa: BLE001 — 술어의 DB 오류가 다운로드를 깨지 않는다
                stop = False
            if stop:
                report.abandon()
                raise DownloadCancelled(key)
        idle = _clock() - report.last_progress
        if limit > 0 and idle >= limit and not done.is_set():
            ...  # 기존 무진행 처리 그대로
```

- [ ] **Step 5: DB 함수**

`be/worker/damwha_worker/db/model_jobs.py`:

```python
"""모델 받기·삭제 job의 DB 원시 요소 (모델 다운로드 관리 스펙 §7)."""

from .core import MODEL_READINESS_KEY, shared_state_enabled


def complete_job(conn, job_id: str, worker_id: str) -> bool:
    """내가 쥔 running job을 done으로 닫는다. 소유권을 잃었으면 False."""
    cur = conn.execute(
        "UPDATE job SET status='done', progress=100, updated_at=now() "
        "WHERE id=%s AND locked_by=%s AND status='running'",
        (job_id, worker_id),
    )
    return cur.rowcount > 0


def stop_requested(conn, job_id: str) -> bool:
    row = conn.execute("SELECT stop_requested_at FROM job WHERE id=%s", (job_id,)).fetchone()
    return row is not None and row["stop_requested_at"] is not None


# merge_model_readiness와 같은 한 문장의 원자적 갱신 — 읽고 고쳐 쓰면 다른 writer의 key를 지운다.
_REMOVE_READINESS_KEY_SQL = """
UPDATE app_setting
   SET value = jsonb_set(value, '{entries}', COALESCE(value->'entries', '{}'::jsonb) - %(k)s::text),
       updated_at = now()
 WHERE key = %(row_key)s AND jsonb_typeof(value->'entries') = 'object'
"""


def remove_model_readiness_key(conn, key: str) -> None:
    """`model_readiness.entries[key]`를 지운다. 미리 받기의 최종 실패·취소·삭제 뒤에 부른다 (스펙 §7.3·§7.4).

    남겨 두면 desktop 상태 창이 선택 기능의 실패에 "다시 시작"을 권하거나, 지운 모델이 처리
    배너에 옛 상태로 남는다.
    """
    if not shared_state_enabled():
        return
    conn.execute(_REMOVE_READINESS_KEY_SQL, {"k": key, "row_key": MODEL_READINESS_KEY})


def model_job_refs(conn, role, name, backend, lens_models, summary_fallback, exclude_job) -> list[str]:
    """마이그레이션 027의 `model_job_refs` — API와 같은 판정을 부른다(사본을 두지 않는다)."""
    rows = conn.execute(
        "SELECT id FROM model_job_refs(%s, %s, %s, %s::text[], %s, %s) AS id",
        (role, name, backend, list(lens_models), summary_fallback, exclude_job),
    ).fetchall()
    return [r["id"] for r in rows]
```

`db/__init__.py` — 기존 재수출 방식대로 `complete_job`, `stop_requested`, `remove_model_readiness_key`, `model_job_refs`를 `from .model_jobs import …`로 더하고 `__all__`에도 넣는다.

- [ ] **Step 6: 받기 본체**

`be/worker/damwha_worker/pipeline/model_jobs.py`:

```python
"""모델 받기·삭제 job 본체 (모델 다운로드 관리 스펙 §7).

받기는 D1의 받기 명세(`models/specs.py`)로 `snapshot_download`를 부르기만 한다. 디스크 사전 점검,
진행 보고(`model_readiness`), 무진행 감시는 `models/downloads.py`의 훅이 맡는다 — 이 파일은 그 위에
취소와 job 마무리만 얹는다.
"""

from __future__ import annotations

import errno
import logging

from .. import db, errors
from ..models import downloads, specs
from .stage import enter_stage

log = logging.getLogger("damwha_worker")


def _snapshot(**kwargs):
    from huggingface_hub import snapshot_download  # models extra — 부모에서는 import하지 않는다

    return snapshot_download(**kwargs)


def _download_kwargs(payload, hf_token):
    spec = specs.spec_for(payload.role, payload.name, payload.backend)
    if spec is None:
        # 명세 없는 모델(env가 고정·렌즈 모델을 표 밖 저장소로 바꾼 경우): 이름이 곧 저장소다.
        return {"repo_id": payload.name, "token": hf_token}
    kw = {"repo_id": spec.repo_id, "revision": spec.revision, "token": hf_token}
    if spec.allow_patterns is not None:
        kw["allow_patterns"] = list(spec.allow_patterns)
    return kw


def run_download_model(conn, job, payload, *, worker_id, hf_token, snapshot=None) -> str:
    job_id = job["id"]
    # 재queue된 job에 이미 취소가 찍혀 있을 수 있다 — 받기 전에 본다 (스펙 §7.1).
    if db.stop_requested(conn, job_id):
        raise downloads.DownloadCancelled(payload.name)
    enter_stage(conn, job_id, worker_id, "download_model", 0)
    kwargs = _download_kwargs(payload, hf_token)
    try:
        with downloads.cancel_when(lambda: db.stop_requested(conn, job_id)):
            (snapshot or _snapshot)(**kwargs)
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise errors.WorkerError(
                errors.DISK_FULL, "디스크 공간이 부족해요 — 받는 도중 디스크가 찼어요.",
                errors.ErrorKind.PERMANENT,
            ) from exc
        raise
    return "committed" if db.complete_job(conn, job_id, worker_id) else "lost"
```

> 취소 술어는 감시 스레드가 아니라 **호출자 스레드**(`_run_watched`의 루프)에서 불린다. 같은 `conn`을 그 스레드가 쓰는 동안 다운로드 스레드는 DB를 쓰지 않는다(훅은 자기 연결 `_HookConnection`을 쓴다) — 연결 공유 경합이 없다.

- [ ] **Step 7: 핸들러와 토큰 배선**

`be/worker/damwha_worker/jobs.py`:
- `JobContext`에 필드 추가: `hf_token: str | None = None` (`meeting_timezone` 근처, 주석 "모델 받기가 게이트 모델(화자 분리)을 받을 때 쓴다").
- import에 `from .pipeline.model_jobs import run_download_model`, `from .models.downloads import DownloadCancelled`를 더한다.
- 핸들러:

```python
class DownloadModelHandler(JobHandler):
    """모델 미리 받기 (모델 다운로드 관리 스펙 §7.1·§7.2·§7.4)."""

    type = "download_model"

    def run(self, conn, job, payload, ctx):
        return run_download_model(conn, job, payload, worker_id=ctx.worker_id, hf_token=ctx.hf_token)

    def on_failure(self, conn, job, ctx, error, *, retry):
        cancelled = error.get("code") == errors.DOWNLOAD_CANCELLED
        if retry and not cancelled:
            return "requeued" if db.requeue(conn, job["id"], ctx.worker_id, error) else "lost"
        ok = db.fail_job(conn, job["id"], ctx.worker_id, error)
        # 최종 실패·취소 — 사유는 job.error에 있고 설정 화면이 그것을 보인다. readiness의 failed를
        # 남기면 desktop 상태 창이 선택 기능의 실패에 "다시 시작"을 권한다 (스펙 §7.4).
        repo = _repo_of(job)
        if repo is not None:
            try:
                db.remove_model_readiness_key(conn, repo)
            except Exception:  # noqa: BLE001 — 정리 실패가 job 마무리를 깨지 않는다
                log.warning("could not clear model_readiness for %s", repo, exc_info=True)
        return "failed" if ok else "lost"


def _repo_of(job) -> str | None:
    p = job.get("payload") or {}
    spec = specs.spec_for(p.get("role"), p.get("name"), p.get("backend"))
    return spec.repo_id if spec is not None else p.get("name")
```

(`from .models import specs`, `from . import errors`가 없으면 import에 더한다.) `HANDLERS` 튜플에 `DownloadModelHandler()`를 더한다.

> `DownloadCancelled`는 PERMANENT라 dispatch가 `retry=False`로 부른다. 위의 `cancelled` 검사는 방어선이다 — 오류 dict의 code로 판정한다.

`be/worker/damwha_worker/dispatch.py` — `context_from_settings`의 `JobContext(...)`에 `hf_token=settings.hf_token,`을 더한다.

- [ ] **Step 8: 통과·전체·lint**

Run: `uv run --directory be/worker pytest -q tests/test_model_jobs.py tests/test_downloads.py tests/test_worker_loop.py tests/test_dispatch_index.py`
Expected: PASS
Run: `pnpm worker:test` → PASS · `uv run --directory be/worker ruff check damwha_worker tests` → 통과

- [ ] **Step 9: 변이 검증** — (1) `run_download_model` 시작의 `stop_requested` 검사를 지우면 `test_download_already_cancelled_at_start`가, (2) `_is_benign`의 `DownloadCancelled` 분기를 지우면 `test_cancel_when_releases_caller...`가, (3) `on_failure`의 `remove_model_readiness_key` 호출을 지우면 `test_handler_final_failure_removes_readiness_key`가 FAIL하는지 보고 되돌린다.

- [ ] **Step 10: 커밋**

```bash
git add be/worker/damwha_worker/errors.py be/worker/damwha_worker/models/downloads.py \
  be/worker/damwha_worker/db/model_jobs.py be/worker/damwha_worker/db/__init__.py \
  be/worker/damwha_worker/pipeline/model_jobs.py be/worker/damwha_worker/jobs.py be/worker/damwha_worker/dispatch.py \
  be/worker/tests/test_model_jobs.py be/worker/tests/test_downloads.py
git commit -m "feat(worker): 모델 미리 받기 job과 취소

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 4: worker `delete_model` + 임시 파일 청소 + `free_bytes`

**Files:**
- Modify: `be/worker/damwha_worker/pipeline/model_jobs.py` (`run_delete_model`)
- Modify: `be/worker/damwha_worker/jobs.py` (`DeleteModelHandler`)
- Modify: `be/worker/damwha_worker/models/cache_scan.py` (`clean_stale_incomplete`)
- Modify: `be/worker/damwha_worker/__main__.py` (시작 시·자식 종료 뒤 청소)
- Modify: `be/worker/damwha_worker/inventory.py` (`free_bytes`)
- Test: `be/worker/tests/test_model_jobs.py` (추가), `test_cache_scan.py` (추가), `test_inventory.py` (추가), `test_supervisor.py` (추가)

**Interfaces:**
- Consumes: Task 3의 `db.*`, `errors.*`; `cache_scan.hub_cache_dir`, `cache_scan.repo_folder`; `disk.free_bytes`
- Produces:
  - `run_delete_model(conn, job, payload, *, worker_id, lens_models: list[str], summary_fallback: str | None, cache_root: str | None = None) -> str`
  - `jobs.DeleteModelHandler` (type `delete_model`)
  - `cache_scan.clean_stale_incomplete(root: str, older_than_seconds: float, *, now: float | None = None) -> int` (지운 개수)
  - inventory 행에 `"free_bytes": int | None`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_model_jobs.py`에 추가:

```python
from tests.test_cache_scan import make_repo


def _del(conn, tmp_path, payload, *, lens=("mlx-community/Qwen3.5-4B-8bit",), job=None):
    job = job or _running(conn, "delete_model", payload)
    return job, model_jobs.run_delete_model(
        conn, job, _p(**{k: v for k, v in payload.items() if k != "schema_version"}),
        worker_id=W, lens_models=list(lens), summary_fallback="mlx-community/Qwen3.5-4B-8bit",
        cache_root=str(tmp_path),
    )


def test_delete_removes_repo_dir_and_readiness_key(conn, tmp_path):
    make_repo(tmp_path, "mlx-community/whisper-small-mlx", {"config.json": b"{}"})
    core.merge_model_readiness(conn, "mlx-community/whisper-small-mlx", {"state": "ready"}, W)
    job, out = _del(conn, tmp_path, {"schema_version": 1, "role": "stt", "name": "small", "backend": "mlx"})
    assert out == "committed"
    assert not (tmp_path / "models--mlx-community--whisper-small-mlx").exists()
    assert "mlx-community/whisper-small-mlx" not in core.read_model_readiness(conn)["entries"]
    assert _status(conn, job["id"])["status"] == "done"


def test_delete_refuses_fixed_role(conn, tmp_path):
    with pytest.raises(errors.WorkerError) as ei:
        _del(conn, tmp_path, {"schema_version": 1, "role": "diarization",
                              "name": "pyannote/speaker-diarization-community-1"})
    assert ei.value.code == errors.MODEL_NOT_DELETABLE


def test_delete_refuses_model_used_by_queued_job_and_keeps_files(conn, tmp_path):
    make_repo(tmp_path, "mlx-community/whisper-small-mlx", {"config.json": b"{}"})
    seed_job(conn, type="process_meeting", payload={
        "schema_version": 5,
        "models": {"whisper_model": "small", "devices": {"diarization": "gpu", "stt": "gpu"},
                   "summary_model": "mlx-community/Qwen3.5-9B-8bit"},
        "followups": {"lens": True, "summary": True},
    })
    with pytest.raises(errors.WorkerError) as ei:
        _del(conn, tmp_path, {"schema_version": 1, "role": "stt", "name": "small", "backend": "mlx"})
    assert ei.value.code == errors.MODEL_IN_USE
    assert (tmp_path / "models--mlx-community--whisper-small-mlx").exists()


def test_delete_excludes_itself_and_missing_dir_is_fine(conn, tmp_path):
    _job, out = _del(conn, tmp_path, {"schema_version": 1, "role": "summary",
                                      "name": "mlx-community/Qwen3.5-27B-8bit"})
    assert out == "committed"  # 폴더가 이미 없어도 성공 — 결과(없음)가 같다


def test_delete_refuses_lens_model(conn, tmp_path):
    seed_job(conn, type="process_meeting", payload={
        "schema_version": 5,
        "models": {"whisper_model": "small", "devices": {"diarization": "gpu", "stt": "gpu"},
                   "summary_model": "mlx-community/Qwen3.5-9B-8bit"},
        "followups": {"lens": True, "summary": True},
    })
    with pytest.raises(errors.WorkerError) as ei:
        _del(conn, tmp_path, {"schema_version": 1, "role": "summary", "name": "mlx-community/Qwen3.5-4B-8bit"})
    assert ei.value.code == errors.MODEL_IN_USE
```

`be/worker/tests/test_cache_scan.py`에 추가:

```python
def test_clean_stale_incomplete_removes_only_old_ones(tmp_path):
    base = make_repo(tmp_path, "org/m", {"config.json": b"{}"},
                     blobs_extra=[("a.11111111.incomplete", b"x"), ("b.22222222.incomplete", b"y")])
    old = base / "blobs" / "a.11111111.incomplete"
    os.utime(old, (1000, 1000))
    fresh = base / "blobs" / "b.22222222.incomplete"
    os.utime(fresh, (1_000_000, 1_000_000))
    n = cache_scan.clean_stale_incomplete(str(tmp_path), 180, now=1_000_100)
    assert n == 1
    assert not old.exists() and fresh.exists()
    assert (base / "snapshots").exists()  # 임시 파일 말고는 건드리지 않는다


def test_clean_stale_incomplete_missing_root(tmp_path):
    assert cache_scan.clean_stale_incomplete(str(tmp_path / "nope"), 180) == 0
```

`be/worker/tests/test_inventory.py`에 추가:

```python
def test_build_inventory_reports_free_bytes(tmp_path, monkeypatch):
    from damwha_worker.models import disk

    monkeypatch.setattr(disk, "free_bytes", lambda _p: 123_456)
    value = inventory.build_inventory(str(tmp_path), lens_model=None, summary_fallback=None)
    assert value["free_bytes"] == 123_456
```

`be/worker/tests/test_supervisor.py`에 추가 — 기존 `run_supervisor` 테스트가 가짜 `spawn_fn`·`connect_fn`으로 루프를 도는 방식을 그대로 따라, 자식이 한 번 끝난 뒤 `cache_scan.clean_stale_incomplete`가 불렸는지 monkeypatch로 센다:

```python
def test_supervisor_cleans_stale_incomplete_after_each_child(monkeypatch):
    from damwha_worker import __main__ as main_mod

    calls = []
    monkeypatch.setattr(main_mod.cache_scan, "clean_stale_incomplete",
                        lambda root, age, **_: calls.append((root, age)) or 0)
    # 이하: 이 파일의 기존 "자식 exit 0 뒤 재peek" 테스트와 같은 가짜 conn/spawn/child_holder 구성으로
    # 자식 1회를 돌리고 shutdown한다.
    ...
    assert len(calls) >= 2  # 시작 1회 + 자식 종료 뒤 1회
```

> `...` 자리는 이 파일의 기존 테스트에서 가짜 연결·spawn을 만드는 헬퍼를 그대로 복사해 채운다(그 헬퍼 이름과 모양을 먼저 읽는다). 검증 내용은 "시작 시 1회 + 자식 종료마다 1회"다.

- [ ] **Step 2: 실패를 확인한다**

Run: `uv run --directory be/worker pytest -q tests/test_model_jobs.py tests/test_cache_scan.py tests/test_inventory.py tests/test_supervisor.py`
Expected: FAIL — `run_delete_model`·`clean_stale_incomplete`·`free_bytes` 없음

- [ ] **Step 3: 삭제 본체**

`be/worker/damwha_worker/pipeline/model_jobs.py`에 추가(import에 `os`, `shutil`, `from ..contracts import ...` 불필요, `from ..models import cache_scan`):

```python
_DELETABLE = ("stt", "summary")


def run_delete_model(conn, job, payload, *, worker_id, lens_models, summary_fallback,
                     cache_root=None) -> str:
    """전사·요약 모델 하나를 캐시에서 지운다 (스펙 §7.3). 재시도 없음 — 실패는 PERMANENT."""
    job_id = job["id"]
    if payload.role not in _DELETABLE:
        raise errors.WorkerError(
            errors.MODEL_NOT_DELETABLE, f"role {payload.role!r} cannot be deleted",
            errors.ErrorKind.PERMANENT,
        )
    enter_stage(conn, job_id, worker_id, "delete_model", 0)
    # API가 넣을 때 검사했어도 그 사이 새 job이 들어올 수 있다 — 지우기 직전에 같은 함수로 다시 본다.
    users = db.model_job_refs(conn, payload.role, payload.name, payload.backend,
                              lens_models, summary_fallback, job_id)
    if users:
        raise errors.WorkerError(
            errors.MODEL_IN_USE, f"in use by {', '.join(users)}", errors.ErrorKind.PERMANENT,
        )
    spec = specs.spec_for(payload.role, payload.name, payload.backend)
    repo = spec.repo_id if spec is not None else payload.name
    root = cache_root or cache_scan.hub_cache_dir()
    path = os.path.join(root, cache_scan.repo_folder(repo))
    if os.path.isdir(path):  # 없으면 성공이다 — 결과(없음)가 같다
        shutil.rmtree(path)
    db.remove_model_readiness_key(conn, repo)
    return "committed" if db.complete_job(conn, job_id, worker_id) else "lost"
```


`be/worker/damwha_worker/jobs.py`:

```python
class DeleteModelHandler(JobHandler):
    """전사·요약 모델 삭제 (스펙 §7.3). 재시도하지 않는다 — 기본 on_failure가 retry=False면 닫는다."""

    type = "delete_model"

    def run(self, conn, job, payload, ctx):
        return run_delete_model(
            conn, job, payload, worker_id=ctx.worker_id,
            lens_models=[m for m in (ctx.lens_llm_model,) if m],
            summary_fallback=ctx.summary_llm_model,
        )
```

`HANDLERS`에 `DeleteModelHandler()`를 더하고 import에 `run_delete_model`을 더한다. 삭제 오류는 모두 PERMANENT라 dispatch가 `retry=False`로 기본 `on_failure`(job만 failed)를 부른다.

- [ ] **Step 4: 임시 파일 청소**

`be/worker/damwha_worker/models/cache_scan.py`에 추가(`import time`):

```python
def clean_stale_incomplete(root: str, older_than_seconds: float, *, now: float | None = None) -> int:
    """`blobs/*.incomplete` 중 mtime이 `older_than_seconds`보다 오래된 것을 지운다 (스펙 §7.5).

    받는 중인 임시 파일은 계속 쓰여 mtime이 새롭다. 오래된 것은 무진행 감시·취소·강제 종료가 버린
    스레드의 잔해다 — hub 1.20.1은 이어 받지 않으므로 남겨도 쓸모가 없고 디스크만 먹는다.
    complete 판정은 `.incomplete`를 보지 않으므로 inventory와 무관한 디스크 정리다.
    """
    now = time.time() if now is None else now
    removed = 0
    try:
        folders = os.listdir(root)
    except OSError:
        return 0
    for folder in folders:
        blobs = os.path.join(root, folder, "blobs")
        if not folder.startswith(_PREFIX) or not os.path.isdir(blobs):
            continue
        try:
            names = os.listdir(blobs)
        except OSError:
            continue
        for name in names:
            if not name.endswith(".incomplete"):
                continue
            path = os.path.join(blobs, name)
            try:
                if now - os.stat(path).st_mtime >= older_than_seconds:
                    os.remove(path)
                    removed += 1
            except OSError:
                continue
    return removed
```

`be/worker/damwha_worker/__main__.py`:
- import에 `from .models import cache_scan`과 `from .config import HF_STALL_SECONDS`(이미 있으면 생략)를 더한다.
- 헬퍼:

```python
def _clean_stale_downloads() -> None:
    """버려진 다운로드 임시 파일을 치운다 (모델 다운로드 관리 스펙 §7.5). 실패는 로그만."""
    try:
        n = cache_scan.clean_stale_incomplete(cache_scan.hub_cache_dir(), 2 * HF_STALL_SECONDS)
        if n:
            log.info("removed %d stale download temp file(s)", n)
    except Exception:  # noqa: BLE001
        log.warning("stale download cleanup failed", exc_info=True)
```

- `run_supervisor`에서 `_reap_own_orphans(conn, settings)` 첫 호출 뒤에 `_clean_stale_downloads()`, 그리고 `code = _wait_child(proc)` / `child_holder["proc"] = None` 바로 뒤에 `_clean_stale_downloads()`를 부른다.

> `HF_STALL_SECONDS`가 `config.py`의 모듈 상수인지 먼저 확인한다(Phase 4 주석은 `config.HF_STALL_SECONDS`, 90초). 다른 이름이면 그 이름을 쓴다.

- [ ] **Step 5: `free_bytes`**

`be/worker/damwha_worker/inventory.py`의 `build_inventory` 반환 dict에:

```python
        # 남은 디스크 — 받기 전 "여유보다 큰 모델" 경고용(스펙 §6.4). 정확한 판정은 받을 때 훅이 한다.
        "free_bytes": _free_bytes(root),
```

와 모듈 함수:

```python
def _free_bytes(root: str) -> int | None:
    from .models import disk  # 표준 라이브러리만 쓴다(shutil) — 부모 경량 규칙을 지킨다

    try:
        return disk.free_bytes(root)
    except OSError:
        return None
```

> `models/disk.py`는 `..errors`만 import한다 — 무거운 의존이 없어 부모에서 불러도 된다. 테스트는 `disk.free_bytes`를 monkeypatch하므로 함수 안 import가 그 이름을 늦게 찾는다.

- [ ] **Step 6: 통과·전체·lint**

Run: `uv run --directory be/worker pytest -q tests/test_model_jobs.py tests/test_cache_scan.py tests/test_inventory.py tests/test_supervisor.py`
Expected: PASS
Run: `pnpm worker:test` → PASS · ruff 통과

- [ ] **Step 7: 변이 검증** — `run_delete_model`의 `model_job_refs` 재검사를 지우면 `test_delete_refuses_model_used_by_queued_job_and_keeps_files`가, `clean_stale_incomplete`의 mtime 비교를 지우면 `test_clean_stale_incomplete_removes_only_old_ones`가 FAIL하는지 보고 되돌린다.

- [ ] **Step 8: 커밋**

```bash
git add be/worker/damwha_worker/pipeline/model_jobs.py be/worker/damwha_worker/jobs.py \
  be/worker/damwha_worker/models/cache_scan.py be/worker/damwha_worker/__main__.py be/worker/damwha_worker/inventory.py \
  be/worker/tests/test_model_jobs.py be/worker/tests/test_cache_scan.py be/worker/tests/test_inventory.py be/worker/tests/test_supervisor.py
git commit -m "feat(worker): 모델 삭제 job, 버려진 임시 파일 청소, 남은 용량 보고

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 5: be — `POST /models/download|delete|cancel`, 행 `job`·`freeBytes`

**Files:**
- Create: `be/src/models/model-jobs.ts` (검증·키·SQL)
- Modify: `be/src/models/models.service.ts`, `models.controller.ts`, `models.module.ts` (JobsModule import 필요 시), `models-view.ts`, `model-inventory.ts`
- Test: `be/test/models-jobs.e2e-spec.ts` (신설), `be/test/models-view.spec.ts` (추가), `be/test/model-inventory.spec.ts` (추가)

**Interfaces:**
- Consumes: `model_job_refs`(Task 1), `ModelJobPayloadSchema`·`buildModelJobPayload`·`JobType`(Task 2), inventory `free_bytes`(Task 4), `DatabaseService.withTransaction`, `JobsRepository.enqueue`
- Produces:
  - HTTP `POST /models/download`·`POST /models/delete` 본문 `{ role, name, backend? }` → 201 `{ job: { id, type, status } }`(새로) / 200(이미 있는 같은 job) / 400·409 `{ statusCode, code, message }`
  - HTTP `POST /models/cancel` 본문 `{ jobId }` → 200 `{ job: { id, type, status } }` / 400 / 409 `job_not_active`
  - `ModelRow.job: { id: string; type: 'download_model'|'delete_model'; status: 'queued'|'running'|'done'|'failed'; error: { code: string; message: string } | null } | null`
  - `ModelsView.freeBytes: number | null`; `ModelsView.pending`는 queued/running 모델 job이 있어도 참
  - 409 코드: `model_not_deletable`, `model_in_use_by_settings`, `model_in_use_by_job`, `model_busy`, `job_not_active`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/models-jobs.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('POST /models/*', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  // 기본 처리 설정(env 폴백): large-v3-turbo · devices.stt는 env WHISPER_DEVICE(mps→gpu). 렌즈 = 4B.
  async function currentBackend(): Promise<'mlx' | 'faster'> {
    const r = await request(srv()).get('/settings/processing');
    return r.body.devices.stt === 'gpu' ? 'mlx' : 'faster';
  }
  const jobs = async () => (await db.pool.query(`SELECT id, type, status, payload FROM job ORDER BY id`)).rows;

  it('download → 201과 job 한 개, payload는 논리 키', async () => {
    const res = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    expect(res.status).toBe(201);
    expect(res.body.job).toMatchObject({ type: 'download_model', status: 'queued' });
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ schema_version: 1, role: 'stt', name: 'small', backend: 'faster' });
  });

  it('같은 받기를 다시 누르면 새 job 없이 200으로 기존 job', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    const b = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    expect(b.status).toBe(200);
    expect(b.body.job.id).toBe(a.body.job.id);
    expect(await jobs()).toHaveLength(1);
  });

  it('동시 받기 요청은 job 하나만 넣는다', async () => {
    const body = { role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit' };
    const rs = await Promise.all([1, 2, 3, 4].map(() => request(srv()).post('/models/download').send(body)));
    expect(new Set(rs.map((r) => r.body.job.id)).size).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });

  it.each([
    [{ role: 'stt', name: 'small' }, 'backend'],
    [{ role: 'stt', name: 'huge', backend: 'mlx' }, 'name'],
    [{ role: 'summary', name: 'org/unknown' }, 'name'],
    [{ role: 'diarization', name: 'someone/else' }, 'name'],
    [{ role: 'nope', name: 'x' }, 'role'],
  ])('400: %j — 필드와 허용 값을 적는다', async (body, field) => {
    const res = await request(srv()).post('/models/download').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_model');
    expect(res.body.message).toContain(field);
  });

  it('목록 밖이어도 렌즈 모델(BE env)은 받을 수 있다', async () => {
    const lens = process.env.LENS_LLM_MODEL ?? 'mlx-community/Qwen3.5-4B-8bit';
    const res = await request(srv()).post('/models/download').send({ role: 'summary', name: lens });
    expect(res.status).toBe(201);
  });

  it('409 model_not_deletable — 고정 역할', async () => {
    const res = await request(srv()).post('/models/delete').send({ role: 'search_embedding', name: 'BAAI/bge-m3' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ statusCode: 409, code: 'model_not_deletable' });
  });

  it('409 model_in_use_by_settings — 현재 전사 모델, 렌즈 모델', async () => {
    const be = await currentBackend();
    const stt = await request(srv()).post('/models/delete').send({ role: 'stt', name: 'large-v3-turbo', backend: be });
    expect(stt.body.code).toBe('model_in_use_by_settings');
    const lens = await request(srv()).post('/models/delete').send({ role: 'summary', name: 'mlx-community/Qwen3.5-4B-8bit' });
    expect(lens.body.code).toBe('model_in_use_by_settings');
  });

  it('409 model_in_use_by_job — queued job이 쓴다', async () => {
    await db.pool.query(
      `INSERT INTO job(type, payload) VALUES('summarize_meeting', $1::jsonb)`,
      [JSON.stringify({ schema_version: 1, model: 'mlx-community/Qwen3.5-27B-8bit' })],
    );
    const res = await request(srv()).post('/models/delete').send({ role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('model_in_use_by_job');
  });

  it('409 model_busy — 받는 중인 모델 삭제, 삭제 중인 모델 받기', async () => {
    await request(srv()).post('/models/download').send({ role: 'stt', name: 'tiny', backend: 'faster' });
    const del = await request(srv()).post('/models/delete').send({ role: 'stt', name: 'tiny', backend: 'faster' });
    expect(del.body.code).toBe('model_busy');
    await request(srv()).post('/models/delete').send({ role: 'stt', name: 'base', backend: 'faster' });
    const dl = await request(srv()).post('/models/download').send({ role: 'stt', name: 'base', backend: 'faster' });
    expect(dl.body.code).toBe('model_busy');
  });

  it('cancel — queued는 바로 failed(download_cancelled)', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    const c = await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id });
    expect(c.status).toBe(200);
    const row = (await db.pool.query(`SELECT status, error, stop_requested_at FROM job WHERE id=$1`, [a.body.job.id])).rows[0];
    expect(row.status).toBe('failed');
    expect(row.error.code).toBe('download_cancelled');
  });

  it('cancel — running은 stop_requested_at만 찍는다', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    await db.pool.query(`UPDATE job SET status='running', locked_by='w', attempts=1 WHERE id=$1`, [a.body.job.id]);
    const c = await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id });
    expect(c.status).toBe(200);
    const row = (await db.pool.query(`SELECT status, stop_requested_at FROM job WHERE id=$1`, [a.body.job.id])).rows[0];
    expect(row.status).toBe('running');
    expect(row.stop_requested_at).not.toBeNull();
  });

  it('cancel — 끝난 job은 409 job_not_active, download 아닌 job은 400', async () => {
    const a = await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    await db.pool.query(`UPDATE job SET status='done' WHERE id=$1`, [a.body.job.id]);
    expect((await request(srv()).post('/models/cancel').send({ jobId: a.body.job.id })).body.code).toBe('job_not_active');
    const d = await request(srv()).post('/models/delete').send({ role: 'stt', name: 'small', backend: 'faster' });
    expect((await request(srv()).post('/models/cancel').send({ jobId: d.body.job.id })).status).toBe(400);
  });

  it('GET /models — 행에 마지막 job, 활성 모델 job이 있으면 pending', async () => {
    await request(srv()).post('/models/download').send({ role: 'stt', name: 'small', backend: 'faster' });
    const v = (await request(srv()).get('/models')).body;
    expect(v.pending).toBe(true);
    // inventory가 없어도 행 job은 논리 키로 붙는다 — 다른 백엔드 행은 inventory가 없으면 안 보이므로
    // 현재 백엔드와 같은 요청으로 확인한다.
  });
});
```

> 마지막 케이스는 현재 백엔드로 받기를 넣고, 그 행(`name`·`backend` 일치)의 `job`이 `{type:'download_model', status:'queued'}`인지 단언하도록 `currentBackend()`로 채운다.

`be/test/models-view.spec.ts`에 추가:

```ts
  it('job — 같은 논리 키의 마지막 모델 job을 행에 싣고, 활성이면 pending', () => {
    const v = buildModelsView(input({
      modelJobs: [
        { id: 'job_1', type: 'download_model', status: 'failed', role: 'stt', name: 'large-v3', backend: 'mlx',
          error: { code: 'DISK_FULL', message: '디스크 공간이 부족해요' } },
        { id: 'job_2', type: 'download_model', status: 'queued', role: 'summary', name: 'mlx-community/Qwen3.5-27B-8bit',
          backend: null, error: null },
      ],
    }));
    expect(find(v, 'stt', 'large-v3', 'mlx')?.job).toEqual({
      id: 'job_1', type: 'download_model', status: 'failed', error: { code: 'DISK_FULL', message: '디스크 공간이 부족해요' },
    });
    expect(v.pending).toBe(true);
    expect(find(v, 'stt', 'small', 'mlx')?.job).toBeNull();
  });

  it('deletable — queued/running job이 쓰는 모델도 삭제 불가', () => {
    const v = buildModelsView(input({ modelRefs: new Set(['stt:small:mlx']) }));
    expect(find(v, 'stt', 'small', 'mlx')?.deletable).toBe(false);
  });

  it('freeBytes — inventory free_bytes를 싣는다', () => {
    expect(buildModelsView(input({ inventory: inv({ freeBytes: 5_000 }) })).freeBytes).toBe(5_000);
    expect(buildModelsView(input({ inventory: null })).freeBytes).toBeNull();
  });
```

(`input()`의 기본값에 `modelJobs: []`, `modelRefs: new Set()`, `inv()`의 기본값에 `freeBytes: null`을 더한다.)

`be/test/model-inventory.spec.ts`에 추가:

```ts
  it('free_bytes를 싣고, 없거나 숫자가 아니면 null', () => {
    expect(fromInventoryRow({ scanned_at: 't', free_bytes: 42 })?.freeBytes).toBe(42);
    expect(fromInventoryRow({ scanned_at: 't' })?.freeBytes).toBeNull();
    expect(fromInventoryRow({ scanned_at: 't', free_bytes: 'x' })?.freeBytes).toBeNull();
  });
```

(기존 첫 테스트의 기대 객체에 `freeBytes: null`을 더한다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest --runInBand models`
Expected: FAIL

- [ ] **Step 3: inventory 파서와 조립에 필드를 더한다**

`model-inventory.ts` — `ModelInventory`에 `freeBytes: number | null`, `RowSchema`에 `free_bytes: z.number().finite().nonnegative().nullable().catch(null).default(null)`, 반환에 `freeBytes: row.data.free_bytes`.

`models-view.ts`:
- 타입:

```ts
export interface ModelJobRef {
  id: string;
  type: 'download_model' | 'delete_model';
  status: 'queued' | 'running' | 'done' | 'failed';
  error: { code: string; message: string } | null;
}
export interface ModelJobRow extends ModelJobRef { role: ModelRole; name: string; backend: SttBackend | null }
```

- `ModelRow`에 `job: ModelJobRef | null`, `ModelsView`에 `freeBytes: number | null`.
- `ModelsViewInput`에 `modelJobs: ModelJobRow[]`(논리 키마다 **가장 최근** job 하나, 서비스가 고른다)와 `modelRefs: Set<string>`(queued/running job이 쓰는 모델의 논리 키 `role:name:backend`, 서비스가 `model_job_refs`로 채운다)을 더한다.
- 키 함수 `export const modelKey = (role: string, name: string, backend: string | null) => \`${role}:${name}:${backend ?? ''}\`;`
- `row()`에서 `job`을 `modelJobs`의 같은 키로 찾아 `{id,type,status,error}`만 싣고, `deletable`에 `&& !input.modelRefs.has(modelKey(role, name, backend))`를 더한다.
- `pending`에 `|| input.modelJobs.some((j) => j.status === 'queued' || j.status === 'running')`.
- 반환에 `freeBytes: inventory?.freeBytes ?? null`.

- [ ] **Step 4: 검증·SQL 모듈**

`be/src/models/model-jobs.ts`:

```ts
import { BadRequestException, ConflictException } from '@nestjs/common';
import { MODEL_ROLES, STT_BACKENDS, SUMMARY_MODELS, WHISPER_MODELS, ModelRole, SttBackend } from '@damwha/contracts';
import { PoolClient } from 'pg';
import { modelKey } from './models-view';

/**
 * 모델 받기·삭제 요청의 검증과 job SQL (모델 다운로드 관리 스펙 §5.2~§5.4).
 * 오류 본문은 `{ statusCode, code, message }` — fe가 code로 문구를 고른다(`DemoReadOnlyGuard`와 같은 모양).
 */
export interface ModelKey { role: ModelRole; name: string; backend: SttBackend | null }

export const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, code, message });
const invalid = (message: string) => new BadRequestException({ statusCode: 400, code: 'invalid_model', message });

export function parseModelKey(
  body: unknown,
  allowed: { fixed: Record<'diarization' | 'speaker_embedding' | 'search_embedding', string>; lensModels: string[] },
): ModelKey {
  const b = (body ?? {}) as Record<string, unknown>;
  const role = b.role;
  if (typeof role !== 'string' || !(MODEL_ROLES as readonly string[]).includes(role)) {
    throw invalid(`role must be one of ${MODEL_ROLES.join(', ')}`);
  }
  const name = b.name;
  if (typeof name !== 'string' || name.length === 0) throw invalid('name is required');
  const backend = b.backend ?? null;
  if (role === 'stt') {
    if (typeof backend !== 'string' || !(STT_BACKENDS as readonly string[]).includes(backend)) {
      throw invalid(`backend is required for stt: one of ${STT_BACKENDS.join(', ')}`);
    }
    if (!(WHISPER_MODELS as readonly string[]).includes(name)) {
      throw invalid(`name for stt must be one of ${WHISPER_MODELS.join(', ')}`);
    }
    return { role, name, backend: backend as SttBackend };
  }
  if (backend !== null) throw invalid('backend is only allowed for stt');
  if (role === 'summary') {
    const ok = [...SUMMARY_MODELS, ...allowed.lensModels];
    if (!ok.includes(name)) throw invalid(`name for summary must be one of ${ok.join(', ')}`);
    return { role, name, backend: null };
  }
  const fixed = allowed.fixed[role as keyof typeof allowed.fixed];
  if (name !== fixed) throw invalid(`name for ${role} must be ${fixed}`);
  return { role: role as ModelRole, name, backend: null };
}

/** 모델 job 네임스페이스 — 마이그레이션 lock(`migrate.ts`의 bigint 키)과 공간을 나눈다. */
const MODEL_JOB_LOCK_NS = 72_031;

export async function lockModelKey(c: PoolClient, k: ModelKey): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [MODEL_JOB_LOCK_NS, modelKey(k.role, k.name, k.backend)]);
}

export async function activeModelJob(c: PoolClient, type: 'download_model' | 'delete_model', k: ModelKey) {
  const r = await c.query(
    `SELECT id, type, status FROM job
      WHERE type = $1 AND status IN ('queued','running')
        AND payload->>'role' = $2 AND payload->>'name' = $3
        AND COALESCE(payload->>'backend', '') = $4
      ORDER BY created_at DESC LIMIT 1`,
    [type, k.role, k.name, k.backend ?? ''],
  );
  return r.rows[0] ?? null;
}

export async function jobRefs(
  c: { query: PoolClient['query'] }, k: ModelKey, lensModels: string[], summaryFallback: string | null,
): Promise<string[]> {
  const r = await c.query(
    `SELECT * FROM model_job_refs($1, $2, $3, $4::text[], $5, NULL) AS id`,
    [k.role, k.name, k.backend, lensModels, summaryFallback],
  );
  return r.rows.map((x: { id: string }) => x.id);
}
```

- [ ] **Step 5: 서비스와 컨트롤러**

`models.service.ts` — 생성자에 `JobsRepository`를 더하고(`JobsModule`이 export하는지 확인, 아니면 `models.module.ts`에서 provider로 가져온다), 메서드:

```ts
  private allowed(inventory: ModelInventory | null) {
    const env = loadEnv();
    return {
      fixed: { diarization: env.DIARIZATION_MODEL, speaker_embedding: env.EMBEDDING_MODEL, search_embedding: env.SEARCH_EMBEDDING_MODEL },
      lensModels: [...new Set([env.LENS_LLM_MODEL, inventory?.workerLlm.lensModel].filter((x): x is string => !!x))],
      summaryFallback: inventory?.workerLlm.summaryFallback ?? env.LENS_LLM_MODEL,
    };
  }

  async download(body: unknown) {
    const inventory = await this.readInventory();
    const a = this.allowed(inventory);
    const k = parseModelKey(body, a);
    return this.db.withTransaction(async (c) => {
      await lockModelKey(c, k);
      if (await activeModelJob(c, 'delete_model', k)) throw conflict('model_busy', '이 모델을 지우는 중이에요.');
      const existing = await activeModelJob(c, 'download_model', k);
      if (existing) return { created: false, job: existing };
      const job = await this.jobs.enqueue(c, { type: 'download_model', meetingId: null, payload: buildModelJobPayload(k) });
      return { created: true, job: { id: job.id, type: job.type, status: job.status } };
    });
  }

  async delete(body: unknown) {
    const inventory = await this.readInventory();
    const a = this.allowed(inventory);
    const k = parseModelKey(body, a);
    if (!(DELETABLE_ROLES as readonly string[]).includes(k.role)) {
      throw conflict('model_not_deletable', '이 모델은 지울 수 없어요.');
    }
    const view = await this.list();
    const row = view.models.find((m) => m.role === k.role && m.name === k.name && m.backend === k.backend);
    if (row && row.inUseFor.length > 0) throw conflict('model_in_use_by_settings', '지금 설정에서 쓰고 있어요.');
    return this.db.withTransaction(async (c) => {
      await lockModelKey(c, k);
      if ((await jobRefs(c, k, a.lensModels, a.summaryFallback)).length > 0) {
        throw conflict('model_in_use_by_job', '처리 중인 작업이 쓰고 있어요.');
      }
      if (await activeModelJob(c, 'download_model', k)) throw conflict('model_busy', '이 모델을 받는 중이에요.');
      const existing = await activeModelJob(c, 'delete_model', k);
      if (existing) return { created: false, job: existing };
      const job = await this.jobs.enqueue(c, { type: 'delete_model', meetingId: null, payload: buildModelJobPayload(k), maxAttempts: 1 });
      return { created: true, job: { id: job.id, type: job.type, status: job.status } };
    });
  }

  async cancel(body: unknown) {
    const jobId = (body as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId !== 'string') throw new BadRequestException({ statusCode: 400, code: 'invalid_job', message: 'jobId is required' });
    const t = await this.db.query(`SELECT type FROM job WHERE id=$1`, [jobId]);
    if (t.rows[0]?.type !== 'download_model') {
      throw new BadRequestException({ statusCode: 400, code: 'invalid_job', message: 'only download_model jobs can be cancelled' });
    }
    const error = { code: 'download_cancelled', message: '받기를 취소했어요', kind: 'PERMANENT', stage: null };
    const q = await this.db.query(
      `UPDATE job SET status='failed', error=$2::jsonb, updated_at=now() WHERE id=$1 AND status='queued' RETURNING id, type, status`,
      [jobId, JSON.stringify(error)],
    );
    if (q.rows[0]) return { job: q.rows[0] };
    // 그 사이 claim됐거나 이미 running — 끝내는 것은 worker다 (스펙 §5.3).
    const r = await this.db.query(
      `UPDATE job SET stop_requested_at=now(), updated_at=now() WHERE id=$1 AND status='running' RETURNING id, type, status`,
      [jobId],
    );
    if (r.rows[0]) return { job: r.rows[0] };
    throw conflict('job_not_active', '이미 끝난 작업이에요.');
  }
```

`list()`는 `buildModelsView`에 넘기기 전에:

```ts
    const jobs = await this.db.query(
      `SELECT DISTINCT ON (payload->>'role', payload->>'name', COALESCE(payload->>'backend',''))
              id, type, status, error, payload->>'role' AS role, payload->>'name' AS name, payload->>'backend' AS backend
         FROM job WHERE type IN ('download_model','delete_model')
        ORDER BY payload->>'role', payload->>'name', COALESCE(payload->>'backend',''), created_at DESC`,
    );
    const modelJobs = jobs.rows.map((r) => ({
      id: r.id, type: r.type, status: r.status, role: r.role, name: r.name, backend: r.backend ?? null,
      error: r.error && typeof r.error.code === 'string' ? { code: r.error.code, message: String(r.error.message ?? '') } : null,
    }));
```

와 `modelRefs`(삭제 가능 후보 행마다 `jobRefs`를 부르면 행 수만큼 쿼리가 나가므로, 한 번에): 

```ts
    const a = this.allowed(inventory);
    const refs = await this.db.query(
      `SELECT k FROM unnest($1::text[], $2::text[], $3::text[]) AS t(role, name, backend),
              LATERAL (SELECT 1 FROM model_job_refs(t.role, t.name, NULLIF(t.backend,''), $4::text[], $5, NULL) LIMIT 1) x,
              LATERAL (SELECT t.role || ':' || t.name || ':' || t.backend AS k) y`,
      [candidates.map((c) => c.role), candidates.map((c) => c.name), candidates.map((c) => c.backend ?? ''), a.lensModels, a.summaryFallback],
    );
    const modelRefs = new Set<string>(refs.rows.map((r) => r.k));
```

> `candidates`는 `DELETABLE_ROLES`의 카탈로그 행 키(전사 6×2, `SUMMARY_MODELS`, 렌즈 모델)다. 이 쿼리가 번거로우면 `buildModelsView`를 두 번 부르지 말고, 먼저 `modelRefs` 없이 조립한 뒤 `deletable` 후보 행만 모아 위 쿼리로 한 번에 판정해 다시 조립한다. 어느 쪽이든 **쿼리 1회**로 끝낸다. 오류가 나면 `modelRefs`를 빈 집합으로 두지 말고 삭제 가능 후보를 모두 "쓰는 중"으로 본다(안전한 쪽 — `deletable: false`).

`models.controller.ts`:

```ts
  @Post('download')
  @ApiOperation({ summary: '모델 미리 받기 — download_model job을 넣는다 (같은 job이 있으면 그것)' })
  async download(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.service.download(body);
    res.status(r.created ? 201 : 200);
    return { job: r.job };
  }

  @Post('delete')
  @ApiOperation({ summary: '모델 삭제 — delete_model job. 쓰는 모델은 409' })
  async remove(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.service.delete(body);
    res.status(r.created ? 201 : 200);
    return { job: r.job };
  }

  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({ summary: '받기 취소 — queued는 바로 닫고, running은 worker에게 멈추라고 알린다' })
  cancel(@Body() body: unknown) {
    return this.service.cancel(body);
  }
```

(import: `Body, HttpCode, Post, Res` from `@nestjs/common`, `Response` from `express`.)

- [ ] **Step 6: 통과·전체·타입**

Run: `pnpm --filter damwha-be exec jest --runInBand models model-inventory model-job-refs` → PASS
Run: `pnpm be test` → PASS · `pnpm --filter damwha-be exec tsc --noEmit` → 오류 없음

- [ ] **Step 7: 변이 검증** — (1) `lockModelKey` 호출을 지우면 "동시 받기 요청" 케이스가(반복 실행에서) 깨지는지, (2) `download`의 `activeModelJob(... 'delete_model')` 검사를 지우면 `model_busy` 케이스가, (3) `modelRefs`를 무시하면 `deletable — queued/running job` 케이스가 FAIL하는지 보고 되돌린다. (1)이 경합이라 한 번에 안 깨지면 그 사실과 반복 횟수를 보고서에 적는다.

- [ ] **Step 8: 커밋**

```bash
git add be/src/models be/test/models-jobs.e2e-spec.ts be/test/models-view.spec.ts be/test/model-inventory.spec.ts
git commit -m "feat(be): 모델 받기·삭제·취소 API와 행의 작업 상태

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 6: fe — `ApiError.code`, 뮤테이션, 행 동작·문구 규칙

**Files:**
- Modify: `fe/src/shared/api/client.ts` (+ 기존 client 테스트)
- Modify: `fe/src/features/models/api/types.ts`, `api/models.ts` (+ `models.test.tsx`)
- Create: `fe/src/features/models/lib/actions.ts`, `lib/actions.test.ts`

**Interfaces:**
- Consumes: Task 5의 HTTP 계약
- Produces:
  - `ApiError.code`가 서버 본문의 문자열 `code`를 항상 싣는다(DISK_FULL 경로 유지)
  - `ModelRow.job`, `ModelsView.freeBytes` 타입
  - `useDownloadModel()`, `useDeleteModel()`, `useCancelModelJob()` — 성공 시 `["models"]` 무효화
  - `rowAction(row): { kind: 'download' | 'redownload' | 'cancel' | 'delete' | null; reason: string | null }`
  - `jobErrorText(row): { text: string; accept: boolean } | null` — `accept`는 "사용 조건 페이지 열기" 버튼을 붙일지
  - `conflictText(code: string | undefined): string | null`
  - `exceedsFreeSpace(row, freeBytes): boolean`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/models/lib/actions.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { ModelRow } from "../api/types";
import { conflictText, exceedsFreeSpace, jobErrorText, rowAction } from "./actions";

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt", name: "small", backend: "mlx", repoId: "r", inUseFor: [], installed: "no",
    sizeBytes: null, approxBytes: 481_000_000, downloading: null, deletable: true, job: null, ...over,
  };
}
const job = (over: Partial<NonNullable<ModelRow["job"]>>) => ({
  id: "job_1", type: "download_model" as const, status: "queued" as const, error: null, ...over,
});

describe("rowAction", () => {
  test.each([
    [row({}), "download"],
    [row({ installed: "partial" }), "redownload"],
    [row({ downloading: { bytesDone: 1, bytesTotal: 2 } }), "cancel"],
    [row({ job: job({ status: "queued" }) }), "cancel"],
    [row({ job: job({ status: "running" }) }), "cancel"],
    [row({ installed: "yes" }), "delete"],
    [row({ installed: "yes", deletable: false, inUseFor: ["stt"] }), null],
    [row({ installed: "yes", deletable: false, role: "diarization", backend: null, inUseFor: ["fixed"] }), null],
    [row({ installed: "unknown" }), null],
    [row({ installed: "yes", job: job({ type: "delete_model", status: "running" }) }), null],
  ])("%#", (r, kind) => {
    expect(rowAction(r).kind).toBe(kind);
  });

  test("사용 중이라 못 지우면 이유를 준다, 고정 모델은 이유 없음", () => {
    expect(rowAction(row({ installed: "yes", deletable: false, inUseFor: ["stt"] })).reason).toBe("지금 설정에서 쓰고 있어요");
    expect(rowAction(row({ installed: "yes", deletable: false, inUseFor: [] })).reason).toBe("처리 중인 작업이 쓰고 있어요");
    expect(rowAction(row({ installed: "yes", deletable: false, role: "search_embedding", backend: null, inUseFor: ["fixed"] })).reason).toBeNull();
  });
});

describe("jobErrorText", () => {
  const failed = (code: string, type: "download_model" | "delete_model" = "download_model", message = "") =>
    row({ job: job({ type, status: "failed", error: { code, message } }) });

  test("코드로 고른다", () => {
    expect(jobErrorText(failed("DISK_FULL", "download_model", "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.")))
      .toEqual({ text: "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.", accept: false });
    expect(jobErrorText(failed("hf_token_invalid"))?.text).toBe("허깅페이스 토큰이 유효하지 않아 받지 못했어요. 토큰을 확인해 주세요.");
    expect(jobErrorText(failed("hf_gate_not_accepted"))).toEqual({ text: "모델 사용 조건에 동의해야 받을 수 있어요.", accept: true });
    expect(jobErrorText(failed("model_in_use", "delete_model"))?.text).toBe("처리 중인 작업이 쓰고 있어 지우지 않았어요.");
    expect(jobErrorText(failed("model_download_failed"))?.text).toBe("받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요.");
    expect(jobErrorText(failed("io_error", "delete_model"))?.text).toBe("지우지 못했어요.");
  });

  test("취소·성공·진행 중은 표시하지 않는다", () => {
    expect(jobErrorText(failed("download_cancelled"))).toBeNull();
    expect(jobErrorText(row({ job: job({ status: "done" }) }))).toBeNull();
    expect(jobErrorText(row({ job: job({ status: "running" }) }))).toBeNull();
    expect(jobErrorText(row({}))).toBeNull();
  });

  test("받은 뒤에는 옛 받기 실패를 보이지 않는다", () => {
    expect(jobErrorText(row({ installed: "yes", job: job({ status: "failed", error: { code: "model_download_failed", message: "" } }) }))).toBeNull();
  });
});

test("conflictText — 409 코드", () => {
  expect(conflictText("model_in_use_by_settings")).toBe("지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.");
  expect(conflictText("model_in_use_by_job")).toBe("처리 중인 작업이 쓰고 있어요. 끝난 뒤 지울 수 있어요.");
  expect(conflictText("model_busy")).toBe("이 모델에 대한 다른 작업이 진행 중이에요.");
  expect(conflictText("other")).toBeNull();
});

test("exceedsFreeSpace — 안 받은 모델의 대략 용량이 남은 용량보다 클 때만", () => {
  expect(exceedsFreeSpace(row({ approxBytes: 10 }), 5)).toBe(true);
  expect(exceedsFreeSpace(row({ approxBytes: 10 }), 50)).toBe(false);
  expect(exceedsFreeSpace(row({ approxBytes: null }), 5)).toBe(false);
  expect(exceedsFreeSpace(row({ approxBytes: 10 }), null)).toBe(false);
  expect(exceedsFreeSpace(row({ installed: "yes", approxBytes: 10 }), 5)).toBe(false);
});
```

`fe/src/features/models/api/models.test.tsx`에 추가:

```tsx
test("받기·삭제·취소 뮤테이션은 성공 시 models를 무효화한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { job: { id: "job_1" } } } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const w = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result: d } = renderHook(() => useDownloadModel(), { wrapper: w });
  await d.current.mutateAsync({ role: "stt", name: "small", backend: "mlx" });
  expect(post).toHaveBeenCalledWith("/models/download", { role: "stt", name: "small", backend: "mlx" });
  const { result: x } = renderHook(() => useDeleteModel(), { wrapper: w });
  await x.current.mutateAsync({ role: "summary", name: "m", backend: null });
  expect(post).toHaveBeenCalledWith("/models/delete", { role: "summary", name: "m" });
  const { result: c } = renderHook(() => useCancelModelJob(), { wrapper: w });
  await c.current.mutateAsync("job_1");
  expect(post).toHaveBeenCalledWith("/models/cancel", { jobId: "job_1" });
  expect(invalidate).toHaveBeenCalledTimes(3);
});
```

`fe/src/shared/api/client.ts`의 기존 테스트 파일(`client.test.ts`, 없으면 새로)에 — axios 인터셉터를 지나는 기존 테스트 방식을 따라:

```ts
test("오류 본문의 code를 ApiError에 싣는다 (DISK_FULL 밖에서도)", async () => {
  // 기존 DISK_FULL 테스트와 같은 방식으로 409 { statusCode: 409, code: 'model_busy', message: '...' } 응답을 흘려
  // reject된 ApiError의 code가 'model_busy', message가 서버 message인지 단언한다.
});
```

> 이 테스트는 기존 `client` 테스트가 인터셉터를 어떻게 부르는지(모의 어댑터·핸들러 직접 호출) 먼저 읽고 같은 방식으로 채운다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/models src/shared/api` → FAIL

- [ ] **Step 3: `ApiError.code` 일반화**

`client.ts` 인터셉터 끝의 `return Promise.reject(new ApiError(status, message));`를:

```ts
    // 서버가 붙인 기계용 code는 항상 싣는다 — 화면이 code로 문구를 고른다(모델 받기·삭제 409 등).
    const code = typeof data?.code === "string" ? data.code : undefined;
    return Promise.reject(new ApiError(status, message, code));
```

- [ ] **Step 4: 타입·뮤테이션**

`types.ts` — `ModelRow`에 `job: ModelJobRef | null`, `ModelsView`에 `freeBytes: number | null`, 그리고

```ts
export interface ModelJobRef {
  id: string;
  type: "download_model" | "delete_model";
  status: "queued" | "running" | "done" | "failed";
  error: { code: string; message: string } | null;
}
export interface ModelKey { role: ModelRole; name: string; backend: SttBackend | null }
```

`models.ts`에 추가:

```ts
function body(k: ModelKey) {
  return k.backend === null ? { role: k.role, name: k.name } : { role: k.role, name: k.name, backend: k.backend };
}

function useModelMutation<T>(fn: (v: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: MODELS_QUERY_KEY }),
  });
}

export const useDownloadModel = () =>
  useModelMutation((k: ModelKey) => apiClient.post("/models/download", body(k)));
export const useDeleteModel = () =>
  useModelMutation((k: ModelKey) => apiClient.post("/models/delete", body(k)));
export const useCancelModelJob = () =>
  useModelMutation((jobId: string) => apiClient.post("/models/cancel", { jobId }));
```

(import에 `useMutation`, `useQueryClient`, `ModelKey`.)

- [ ] **Step 5: 행 동작·문구**

`fe/src/features/models/lib/actions.ts`:

```ts
import type { ModelRow } from "../api/types";

/**
 * 모델 행의 버튼과 오류 문구 (모델 다운로드 관리 스펙 §6.4). 문구는 job의 **code**로 고른다 — 자유
 * 문구로 고르지 않는다. 디스크 부족만 worker 문구(남은·필요 용량)를 그대로 보인다.
 */
export type RowActionKind = "download" | "redownload" | "cancel" | "delete" | null;

const active = (r: ModelRow) => r.job !== null && (r.job.status === "queued" || r.job.status === "running");

export function rowAction(r: ModelRow): { kind: RowActionKind; reason: string | null } {
  if (r.downloading !== null || (active(r) && r.job?.type === "download_model")) return { kind: "cancel", reason: null };
  if (active(r)) return { kind: null, reason: null }; // 지우는 중
  if (r.installed === "no") return { kind: "download", reason: null };
  if (r.installed === "partial") return { kind: "redownload", reason: null };
  if (r.installed !== "yes") return { kind: null, reason: null };
  if (r.deletable) return { kind: "delete", reason: null };
  if (r.inUseFor.includes("fixed")) return { kind: null, reason: null };
  return {
    kind: null,
    reason: r.inUseFor.length > 0 ? "지금 설정에서 쓰고 있어요" : "처리 중인 작업이 쓰고 있어요",
  };
}

export function jobErrorText(r: ModelRow): { text: string; accept: boolean } | null {
  const j = r.job;
  if (j === null || j.status !== "failed" || j.error === null) return null;
  const code = j.error.code;
  if (code === "download_cancelled") return null;
  if (j.type === "download_model" && r.installed === "yes") return null; // 그 뒤에 받아졌다
  if (code === "DISK_FULL") return { text: j.error.message, accept: false };
  if (code === "hf_token_invalid")
    return { text: "허깅페이스 토큰이 유효하지 않아 받지 못했어요. 토큰을 확인해 주세요.", accept: false };
  if (code === "hf_gate_not_accepted") return { text: "모델 사용 조건에 동의해야 받을 수 있어요.", accept: true };
  if (code === "model_in_use") return { text: "처리 중인 작업이 쓰고 있어 지우지 않았어요.", accept: false };
  return j.type === "delete_model"
    ? { text: "지우지 못했어요.", accept: false }
    : { text: "받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요.", accept: false };
}

export function conflictText(code: string | undefined): string | null {
  switch (code) {
    case "model_in_use_by_settings":
      return "지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.";
    case "model_in_use_by_job":
      return "처리 중인 작업이 쓰고 있어요. 끝난 뒤 지울 수 있어요.";
    case "model_busy":
      return "이 모델에 대한 다른 작업이 진행 중이에요.";
    default:
      return null;
  }
}

export function exceedsFreeSpace(r: ModelRow, freeBytes: number | null): boolean {
  return r.installed !== "yes" && r.approxBytes !== null && freeBytes !== null && r.approxBytes > freeBytes;
}
```

- [ ] **Step 6: 통과·lint·타입**

Run: `pnpm --filter damwha-fe exec vitest run src/features/models src/shared/api` → PASS
Run: `pnpm --filter damwha-fe exec vitest run` · `pnpm fe lint` · `pnpm --filter damwha-fe exec tsc -b` → 통과 (D1 테스트의 `row()` 헬퍼들이 `job`·`freeBytes` 누락으로 타입 오류가 나면 기본값 `job: null` / `freeBytes: null`을 더한다)

- [ ] **Step 7: 커밋**

```bash
git add fe/src/shared/api fe/src/features/models/api fe/src/features/models/lib
git commit -m "feat(fe): 모델 받기·삭제 요청과 행 동작·오류 문구 규칙

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 7: fe — 버튼, 삭제 확인, 토큰 게이트

**Files:**
- Create: `fe/src/features/models/ui/model-row-actions.tsx`, `ui/delete-model-dialog.tsx`
- Modify: `fe/src/features/models/ui/models-card.tsx` (행·요약 줄에 붙임)
- Test: `fe/src/features/models/ui/models-card.test.tsx` (추가)

**Interfaces:**
- Consumes: Task 6의 `rowAction`·`jobErrorText`·`conflictText`·`exceedsFreeSpace`·뮤테이션; `useDiarizationGate` (`@/features/hf-token/ui/hf-token-gate`); `HfFailureAction`의 "사용 조건 페이지 열기"(`sendHfTokenAction({kind:"open", link:"accept"})`); `Dialog`·`Button` (`@/shared/ui/*`)
- Produces: `ModelRowActions({ row, freeBytes })`, `DeleteModelDialog({ open, onOpenChange, row })`

- [ ] **Step 1: 실패하는 테스트를 쓴다** — `models-card.test.tsx`에 추가(기존 `renderCard`·`row()` 헬퍼를 쓰고, `apiClient.post`를 spy):

```tsx
test("안 받은 모델에 받기 → POST /models/download", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { job: { id: "job_9" } } } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models, row({ name: "medium", installed: "no", sizeBytes: null, approxBytes: 1_524_927_044, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "모든 모델 보기" }));
  fireEvent.click(screen.getByRole("button", { name: "medium 받기" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/download", { role: "stt", name: "medium", backend: "mlx" }));
});

test("받는 중이면 취소 → POST /models/cancel", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [row({ name: "small", installed: "no", sizeBytes: null, downloading: { bytesDone: 1, bytesTotal: 10 }, job: { id: "job_3", type: "download_model", status: "running", error: null } }), ...VIEW.models.slice(1)] });
  fireEvent.click(await screen.findByRole("button", { name: "small 받기 취소" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/cancel", { jobId: "job_3" }));
});

test("삭제는 확인을 거친다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models, row({ role: "summary", name: "mlx-community/Qwen3.5-27B-8bit", backend: null, sizeBytes: 29_528_168_817, installed: "yes", deletable: true, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "qwen3.5 27B 삭제" }));
  expect(screen.getByText("qwen3.5 27B를 지울까요? 29.5 GB가 비워져요. 다시 쓰려면 다시 받아야 해요.")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/delete", { role: "summary", name: "mlx-community/Qwen3.5-27B-8bit" }));
});

test("사용 중인 모델은 삭제 버튼 없이 이유만", async () => {
  renderCard({ ...VIEW, freeBytes: null });
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).queryByRole("button", { name: /large-v3-turbo 삭제/ })).toBeNull();
  expect(within(list).getAllByText("지금 설정에서 쓰고 있어요").length).toBeGreaterThan(0);
});

test("실패한 받기는 코드별 문구, 취소는 표시 없음", async () => {
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models,
    row({ name: "medium", installed: "no", sizeBytes: null, job: { id: "j", type: "download_model", status: "failed", error: { code: "DISK_FULL", message: "디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB." } } }),
    row({ name: "base", installed: "no", sizeBytes: null, job: { id: "k", type: "download_model", status: "failed", error: { code: "download_cancelled", message: "" } } }),
  ] });
  fireEvent.click(await screen.findByRole("button", { name: "모든 모델 보기" }));
  expect(screen.getByText("디스크 공간이 부족해요 — 남은 용량 1.0 GB, 필요한 용량 3.0 GB.")).toBeTruthy();
  expect(screen.queryByText(/취소/)).toBeNull();
});

test("409는 행 아래 한 줄로 보인다", async () => {
  vi.spyOn(apiClient, "post").mockRejectedValue(new ApiError(409, "지금 설정에서 쓰고 있어요.", "model_in_use_by_settings"));
  renderCard({ ...VIEW, freeBytes: null, models: [...VIEW.models, row({ name: "small", installed: "yes", deletable: true, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "small 삭제" }));
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  expect(await screen.findByText("지금 설정에서 쓰고 있어요. 다른 모델로 바꾼 뒤 지울 수 있어요.")).toBeTruthy();
});

test("남은 용량보다 큰 모델은 받기 옆에 경고", async () => {
  renderCard({ ...VIEW, freeBytes: 1_000_000_000, models: [...VIEW.models, row({ name: "large-v3", installed: "no", sizeBytes: null, approxBytes: 3_083_522_487, job: null })] });
  fireEvent.click(await screen.findByRole("button", { name: "모든 모델 보기" }));
  expect(screen.getByText("남은 용량(1.0 GB)보다 커요")).toBeTruthy();
});

test("요약의 안 받은 줄에 미리 받기", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCard({ ...VIEW, freeBytes: null, models: [row({ name: "small", installed: "no", sizeBytes: null, inUseFor: ["stt"], deletable: false, job: null }), ...VIEW.models.slice(1)] });
  const summary = await screen.findByRole("region", { name: "지금 설정에서 쓰는 모델" });
  fireEvent.click(within(summary).getByRole("button", { name: "small 미리 받기" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/models/download", { role: "stt", name: "small", backend: "mlx" }));
});
```

(import에 `waitFor`, `ApiError`. D1의 `VIEW`·`row()`에 `freeBytes`·`job: null` 기본값을 더한다.)

화자 분리 모델의 토큰 게이트는 Provider가 필요하므로 별도 테스트로:

```tsx
test("화자 분리 모델 받기는 토큰 게이트를 거친다 (토큰 없으면 요청 없이 다이얼로그)", async () => {
  // HfTokenGateProvider를 토큰 없음 상태로 감싸는 방법은 features/hf-token/ui/hf-token-gate.test.tsx가
  // 쓰는 스토어·브리지 모의를 그대로 따른다. 화자 분리 모델 행을 installed:'no'로 두고 "화자 분리 모델 받기"를
  // 누르면 apiClient.post가 불리지 않고 "허깅페이스 토큰이 필요해요" 다이얼로그가 뜨는지 단언한다.
});
```

> 이 테스트는 `hf-token-gate.test.tsx`의 Provider 구성을 먼저 읽고 채운다. 검증 내용은 "토큰 없음 → 요청 0건 + 다이얼로그", "토큰 있음 → 요청 1건"이다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/models/ui` → FAIL

- [ ] **Step 3: 행 동작 컴포넌트**

`fe/src/features/models/ui/model-row-actions.tsx`:

```tsx
import { useState } from "react";
import { isApiError } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import { useDiarizationGate } from "@/features/hf-token/ui/hf-token-gate";
import { sendHfTokenAction } from "@/features/hf-token/lib/use-hf-token";
import { useCancelModelJob, useDownloadModel } from "../api/models";
import type { ModelRow } from "../api/types";
import { conflictText, exceedsFreeSpace, jobErrorText, rowAction } from "../lib/actions";
import { formatBytes } from "../lib/format";
import { DeleteModelDialog } from "./delete-model-dialog";

/**
 * 모델 행의 동작 (모델 다운로드 관리 스펙 §6.4). 받기는 확인 없이, 삭제는 확인 뒤, 화자 분리 모델
 * 받기는 토큰 게이트를 거친다 — 토큰을 넣은 뒤 자동으로 이어 받지 않는다(기존 게이트와 같게).
 */
export function ModelRowActions({ row, freeBytes, label }: { row: ModelRow; freeBytes: number | null; label: string }) {
  const download = useDownloadModel();
  const cancel = useCancelModelJob();
  const gate = useDiarizationGate();
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const action = rowAction(row);
  const err = jobErrorText(row);
  const key = { role: row.role, name: row.name, backend: row.backend };

  const onError = (e: unknown) => setConflict(isApiError(e) ? conflictText(e.code) ?? e.message : "요청하지 못했어요.");
  const startDownload = () => {
    setConflict(null);
    const go = () => download.mutate(key, { onError });
    if (row.role === "diarization") gate.run(go);
    else go();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {(action.kind === "download" || action.kind === "redownload") && (
          <>
            {exceedsFreeSpace(row, freeBytes) && freeBytes !== null && (
              <span className="text-xs text-[color:var(--red-text)]">남은 용량({formatBytes(freeBytes)})보다 커요</span>
            )}
            <Button type="button" size="sm" variant="secondary" aria-label={`${label} 받기`}
              disabled={download.isPending || gate.locked} onClick={startDownload}>
              {action.kind === "download" ? "받기" : "다시 받기"}
            </Button>
          </>
        )}
        {action.kind === "cancel" && row.job && (
          <Button type="button" size="sm" variant="ghost" aria-label={`${label} 받기 취소`}
            disabled={cancel.isPending} onClick={() => cancel.mutate(row.job!.id, { onError })}>
            취소
          </Button>
        )}
        {action.kind === "delete" && (
          <Button type="button" size="sm" variant="ghost" aria-label={`${label} 삭제`} onClick={() => setConfirming(true)}>
            삭제
          </Button>
        )}
        {action.kind === null && action.reason && (
          <span className="text-xs text-[color:var(--text-faint)]">{action.reason}</span>
        )}
      </div>
      {err && (
        <p className="flex items-center gap-2 text-xs text-[color:var(--red-text)]">
          {err.text}
          {err.accept && (
            <Button type="button" size="sm" variant="secondary" onClick={() => sendHfTokenAction({ kind: "open", link: "accept" })}>
              사용 조건 페이지 열기
            </Button>
          )}
        </p>
      )}
      {conflict && <p className="text-xs text-[color:var(--red-text)]">{conflict}</p>}
      <DeleteModelDialog open={confirming} onOpenChange={setConfirming} row={row} label={label} onError={onError} />
    </div>
  );
}
```

> `label`은 카드가 넘기는 `rowLabel(row, current)`이다(버튼 접근 이름과 확인 문구에 같은 이름을 쓴다). `sendHfTokenAction`·`isApiError`의 실제 export 경로를 확인한다(`HfFailureAction`이 쓰는 경로와 같게). `--text-faint` 토큰은 처리 설정 폼이 이미 쓴다.

`fe/src/features/models/ui/delete-model-dialog.tsx`:

```tsx
import { Button } from "@/shared/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/shared/ui/dialog";
import { useDeleteModel } from "../api/models";
import type { ModelRow } from "../api/types";
import { formatBytes } from "../lib/format";

/** 모델 삭제 확인 (스펙 §6.4). 비워질 용량은 그 행의 sizeBytes다. */
export function DeleteModelDialog({
  open, onOpenChange, row, label, onError,
}: { open: boolean; onOpenChange: (o: boolean) => void; row: ModelRow; label: string; onError: (e: unknown) => void }) {
  const del = useDeleteModel();
  const freed = row.sizeBytes !== null ? `${formatBytes(row.sizeBytes)}가 비워져요. ` : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>모델 지우기</DialogTitle>
          <DialogDescription>
            {`${label}를 지울까요? ${freed}다시 쓰려면 다시 받아야 해요.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost">취소</Button></DialogClose>
          <Button
            variant="destructive"
            disabled={del.isPending}
            onClick={() =>
              del.mutate({ role: row.role, name: row.name, backend: row.backend }, {
                onSuccess: () => onOpenChange(false),
                onError: (e) => { onOpenChange(false); onError(e); },
              })
            }
          >
            지우기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> `Button`의 파괴적 variant 이름을 `shared/ui/button.tsx`에서 확인한다(`DeleteSpeakerDialog`가 쓰는 것과 같게).

- [ ] **Step 4: 카드에 붙인다**

`models-card.tsx`:
- 목록 `li`의 오른쪽 `statusText(m)` span 옆에 `<ModelRowActions row={m} freeBytes={data.freeBytes} label={rowLabel(m, current)} />`를 둔다(목록 컴포넌트에 `freeBytes` prop을 넘긴다).
- 요약 `dl`의 줄에 행을 이을 수 있도록 `summaryLines`가 쓰는 행을 찾는다: 요약 줄 중 전사·요약·렌즈 줄에 대응하는 행이 `rowAction(row).kind === "download"`이면 그 줄의 `dd` 끝에 `<Button size="sm" variant="secondary" aria-label={`${modelShortLabel(...)} 미리 받기`}>미리 받기</Button>`을 둔다. 가장 단순한 방법: `SummaryLine`에 선택 필드 `row?: ModelRow`를 더해(Task 5 D1의 `summaryLines`가 행을 알고 있다) 카드가 `l.row && rowAction(l.row).kind === 'download'`일 때 `ModelRowActions`의 받기 동작을 쓰는 작은 `DownloadNowButton`을 그린다. `rows.ts`·`rows.test.ts`의 `SummaryLine` 기대값에 `row`가 생기면 기존 `toEqual` 단언을 `toMatchObject`로 바꾼다.

- [ ] **Step 5: 통과·lint·타입**

Run: `pnpm --filter damwha-fe exec vitest run` · `pnpm fe lint` · `pnpm --filter damwha-fe exec tsc -b` → 통과

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/models
git commit -m "feat(fe): 모델 카드에 받기·취소·삭제와 토큰 게이트

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 8: 문서

**Files:** `docs/MODELS.md`, `docs/HUGGINGFACE.md`, `be/CLAUDE.md`, `fe/CLAUDE.md`

- [ ] **Step 1: `docs/MODELS.md`** — "설정에서 확인하기" 절 뒤에 추가:

```markdown
## 미리 받기·지우기

**설정 › 모델**에서 할 수 있습니다.

- **받기** — 안 받은 모델 옆의 "받기"(요약 영역에서는 "미리 받기"). 받는 동안 진행률이 보이고 "취소"로 멈출 수
  있습니다. 취소하면 그때까지 받은 파일 일부가 남을 수 있고, 다음에 받을 때 나머지만 받습니다.
- 받기는 회의 처리와 같은 줄에 섭니다. 큰 모델을 받는 동안 새 회의는 받기가 끝난 뒤 처리됩니다.
- **화자 분리 모델**은 허깅페이스 토큰이 있어야 받을 수 있습니다. 없으면 토큰 입력 창이 먼저 뜹니다. 넣은 뒤
  "받기"를 다시 눌러 주세요.
- **지우기** — 전사·요약 모델만 지울 수 있습니다. 기본 모델(화자 분리·화자 식별·검색 임베딩)은 지울 수 없습니다.
- 다음 경우에는 지울 수 없습니다: 지금 설정에서 쓰는 모델(렌즈 추출이 쓰는 모델 포함), 처리 중이거나 처리를
  기다리는 회의가 쓰는 모델. 다른 모델로 바꾸거나 처리가 끝난 뒤 지우세요.
- 디스크가 부족하면 받기 전에 멈추고 남은 용량과 필요한 용량을 알려 줍니다.
```

- [ ] **Step 2: `docs/HUGGINGFACE.md` §5** — 마지막 문장 "모델 가중치는 첫 회의를 처리할 때 알아서 받는다(수 GB, 수 분)." 뒤에: "첫 회의 전에 **설정 › 모델**에서 미리 받아 둘 수도 있다([모델](MODELS.md))."

- [ ] **Step 3: `be/CLAUDE.md`** — 비자명한 불변식 절에: "`download_model`·`delete_model` job(마이그레이션 027)은 `meeting_id`가 null이고 payload는 논리 키 `{role,name,backend?}`다. '그 모델을 쓰는 job' 판정은 SQL 함수 `model_job_refs` 하나에만 있다 — API(`models.service.ts` 409)와 worker(`pipeline/model_jobs.py` 재검사)가 같은 함수를 부른다. 사본을 만들지 않는다." worker 절에: "`pipeline/model_jobs.py` — 받기는 받기 명세로 `snapshot_download`만 부르고(디스크·진행·무진행은 훅), 취소는 `downloads.cancel_when` 스레드 로컬 술어다. 최종 실패·취소·삭제 뒤 그 repo의 `model_readiness` key를 지운다(desktop 상태 창 오안내 방지)."

- [ ] **Step 4: `fe/CLAUDE.md`** — `features/models` 문단 끝에: "D2: `lib/actions.ts`가 행 버튼(`rowAction`)과 job 오류 문구(`jobErrorText`, **code로만** 고름)·409 문구(`conflictText`)를 정한다. `ApiError.code`는 서버 본문의 `code`를 항상 싣는다. 화자 분리 모델 받기는 `useDiarizationGate().run()`을 거친다."

- [ ] **Step 5: 커밋**

```bash
git add docs/MODELS.md docs/HUGGINGFACE.md be/CLAUDE.md fe/CLAUDE.md
git commit -m "docs: 모델 미리 받기·지우기 안내

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 9: 전체 검증과 실측 (D2-C1~C6)

컨트롤러(메인 세션)가 수행한다. 앱 조작은 computer-use(또는 Chrome에서 dev Vite), 비밀 입력은 사용자.

- [ ] **Step 1: 전체 스위트** — `pnpm worker:test` · `pnpm be test` · `pnpm --filter damwha-fe exec vitest run` · `pnpm fe lint` · `pnpm --filter damwha-fe exec tsc -b` · `pnpm --filter damwha-be exec tsc --noEmit` · `pnpm --filter damwha-desktop exec vitest run` 모두 통과.

- [ ] **Step 2: 앱 기동** — `desktop/out/` 앱이 떠 있으면 사용자에게 종료를 요청한다. `pnpm desktop:dev`(자기 Vite를 띄운다 — 따로 `pnpm fe dev`를 띄우지 않는다). API는 `http://localhost:3000/api`. 자동화 브라우저 탭은 숨김 상태라 폴링이 멈춘다 — 진행률 갱신은 새로 불러와 확인하거나 앱 창에서 본다.

- [ ] **Step 3: 백업** — 파괴적 단계 전에 대상 저장소(`~/Library/Application Support/Damwha/models/hub/models--…`)를 scratchpad로 복사한다. 현재 설정(`GET /api/settings/processing`)도 저장해 두고 끝나면 `PUT`으로 되돌린다.

- [ ] **Step 4: D2-C1** — 안 받은 전사 모델을 mlx·faster 각각 하나씩 "받기" → mlx는 진행률이 보이고(faster는 라이브러리가 진행을 보고하지 않아 "받는 중"만) 끝나면 "받음". 그 모델로 짧은 회의를 처리하거나(사용자 동의 시) D1-C4 방식의 오프라인 적재로, **다시 받지 않는다**를 확인한다 — 판정은 그 저장소 `blobs/`의 파일 목록·mtime이 전후로 같은 것.

- [ ] **Step 5: D2-C2** — 큰 모델(27B) 받기 중 "취소" → job `failed`(`download_cancelled`), 화면에 오류 없음, 상태 창에 실패 없음(readiness key 없음), worker 자식 종료 뒤 `blobs/*.incomplete`가 `2 × HF_STALL_SECONDS`가 지나 청소됨. 저장소는 `partial`이거나 없음. 끝나면 남은 부분을 지운다(사용자 확인).

- [ ] **Step 6: D2-C3** — 현재 설정의 전사 모델과 렌즈 모델(4B)은 삭제 버튼 없이 "지금 설정에서 쓰고 있어요". API를 직접 불러도(`curl -X POST .../api/models/delete`) 409 `model_in_use_by_settings`.

- [ ] **Step 7: D2-C4** — 안 쓰는 모델(D1 실측이 받은 mlx `small`, 481 MB) 삭제 → `df`로 그만큼 비고, readiness에서 key가 사라지고, 화면이 "안 받음".

- [ ] **Step 8: D2-C5** — 디스크 부족: 남은 용량보다 큰 모델의 받기 옆 경고가 보이고, 받기를 누르면 받기 전에 실패해 "남은 용량 X, 필요한 용량 Y"가 행에 뜬다. 상태 창에 실패가 남지 않는다. (남은 용량을 줄이기 어렵다면 27B가 여유보다 큰지 먼저 보고, 아니면 사용자와 상의해 이 항목의 방법을 정한다.)

- [ ] **Step 9: D2-C6** — 토큰이 없을 때 화자 분리 모델 받기 → 토큰 다이얼로그가 먼저 뜨고 요청이 나가지 않는다. 토큰은 사용자가 넣는다. 넣은 뒤 "받기"를 다시 누르면 받기가 진행된다(이미 받아 둔 경우 캐시 적중으로 곧바로 "받음").

- [ ] **Step 10: 기록** — 스펙 §11에 D2 실측 결과·판정, Notion P2-D를 "D2 완료"로(사용자 확인 뒤). `graphify update .`.

---

## 판정 기록 (계획 ↔ 스펙)

- **디스크 부족 코드**: 스펙 §6.4는 `disk_full`이라 적었지만 실제 worker 상수는 `errors.DISK_FULL = "DISK_FULL"`이다. 계획은 실제 값을 쓴다. 스펙 §11에 옮겨 적는다.
- **남은 용량 경고의 출처**: 스펙 §6.4는 "approx_bytes가 남은 용량보다 크면 행에 경고"라 했지만 API에 남은 용량이 없었다. inventory에 `free_bytes`(worker가 `disk.free_bytes`로 캐시 볼륨을 잰다)를 더해 `GET /models`의 `freeBytes`로 싣는다(Task 4·5). 스펙 §4.2 모양에 필드 하나가 는다.
- **`model_job_refs`의 렌즈 인자**: 스펙 §5.4는 BE·worker 렌즈 값마다 "두 번 부르거나" 했지만, 계획은 `p_lens_models text[]` 하나로 받는다 — 판정은 같고 호출이 한 번이다.
- **delete job의 `max_attempts`**: 스펙은 "재시도 없음"이다. 오류는 모두 PERMANENT로 올리고, 넣을 때 `maxAttempts: 1`도 준다(회수 재queue는 `interruptions`로 따로 센다).
