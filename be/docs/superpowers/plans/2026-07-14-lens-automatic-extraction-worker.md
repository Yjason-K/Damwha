# 렌즈 자동 추출 워커 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의 처리 완료 뒤 OpenAI 호환 로컬 LLM으로 렌즈를 추출하고, 수동 재추출·실행 상태·안전한 병합을 제공한다.

**Architecture:** NestJS는 run/job 생성과 상태 조회를 담당한다. Python worker는 `extract_lenses` job을 claim해 DB의 발언을 LLM에 보내고, run/job 소유권과 처리 버전을 확인하는 단일 트랜잭션에서 작업 1의 AI 병합 정책을 적용한다.

**Tech Stack:** NestJS, TypeScript, Zod, PostgreSQL, Python 3.12, psycopg, Pydantic, httpx, Jest, pytest.

## Global Constraints

- Payload v1은 `meeting_id`, `processing_version`, `extraction_run_id`, `model`만 가진다.
- queued/running run은 같은 `(meeting_id, processing_version)`에서 하나만 허용한다.
- LLM 응답 하나라도 schema 또는 DB 소속 검증에 실패하면 해당 응답은 전혀 저장하지 않는다.
- 추출 최종 실패는 meeting 상태를 `done`에서 바꾸지 않는다.
- AI 병합은 active·unmodified·open AI만 자동 변경하며 사용자 생성·수정·완료 항목을 보존한다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/database/migrations/010_lens_extraction_jobs.sql` | run-job 관계와 active run 유일성 |
| `src/contracts/job-payload.schema.ts`, `src/jobs/jobs.types.ts`, `src/config/env.ts` | Nest job 계약·모델 설정 |
| `src/lenses/lens-extraction.{repository,service}.ts` | run 생성·중복 재사용 |
| `src/meetings/meetings.{service,controller,repository}.ts` | 수동 API와 상태 projection |
| `worker/damwha_worker/{contracts,config,lens_client,db,__main__}.py` | worker 계약·HTTP·lifecycle |
| `worker/damwha_worker/pipeline/extract_lenses.py` | prompt·검증·병합 |
| `test/lens-extraction.e2e-spec.ts`, `worker/tests/test_*lenses.py` | Nest/worker 회귀 테스트 |

## Task 1: 실행 이력 스키마와 Nest job 계약

**Files:**
- Create: `src/database/migrations/010_lens_extraction_jobs.sql`
- Modify: `src/contracts/job-payload.schema.ts`, `src/jobs/jobs.types.ts`, `src/config/env.ts`
- Test: `test/job-payload.spec.ts`, `test/lens-extraction.e2e-spec.ts`

**Interfaces:**
- Produces `ExtractLensesPayloadSchema`, `ExtractLensesPayload`, `buildExtractLensesPayload(args)`.
- Produces `JobType` member `'extract_lenses'` and `LENS_LLM_MODEL`.

- [ ] **Step 1: Write failing payload and migration tests**

```ts
it('accepts only extract_lenses v1 payloads', () => {
  expect(ExtractLensesPayloadSchema.parse({
    schema_version: 1, meeting_id: 'mtg_1', processing_version: 0,
    extraction_run_id: 'ler_1', model: 'qwen2.5:14b-instruct',
  }).extraction_run_id).toBe('ler_1');
  expect(() => ExtractLensesPayloadSchema.parse({ schema_version: 2 })).toThrow();
});
```

Add an E2E SQL assertion: duplicate queued run violates the partial unique index, but a done run is allowed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand test/job-payload.spec.ts`

Expected: FAIL because the schema is not exported.

- [ ] **Step 3: Implement the migration and contract**

```sql
ALTER TABLE lens_extraction_run
  ADD COLUMN job_id text REFERENCES job(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX lens_extraction_run_one_active_idx
  ON lens_extraction_run(meeting_id, processing_version)
  WHERE status IN ('queued', 'running');
CREATE INDEX lens_extraction_run_meeting_created_idx
  ON lens_extraction_run(meeting_id, created_at DESC);
```

```ts
export const ExtractLensesPayloadSchema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  extraction_run_id: z.string().regex(/^ler_[1-9][0-9]*$/),
  model: z.string().min(1),
});
export function buildExtractLensesPayload(args: {
  meetingId: string; processingVersion: number; extractionRunId: string; model: string;
}) {
  return { schema_version: 1, meeting_id: args.meetingId,
    processing_version: args.processingVersion, extraction_run_id: args.extractionRunId,
    model: args.model };
}
```

Append `'extract_lenses'` to `JobType` and add `LENS_LLM_MODEL` (default `qwen2.5:14b-instruct`) to `EnvSchema`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand test/job-payload.spec.ts && npm run build`

Expected: PASS and build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations/010_lens_extraction_jobs.sql src/contracts/job-payload.schema.ts src/jobs/jobs.types.ts src/config/env.ts test/job-payload.spec.ts test/lens-extraction.e2e-spec.ts
git commit -m "feat: add lens extraction job contract"
```

## Task 2: 수동 재추출 API와 추출 상태 조회

**Files:**
- Create: `src/lenses/lens-extraction.repository.ts`, `src/lenses/lens-extraction.service.ts`
- Create: `src/database/migrations/011_add_extract_lenses_job_type.sql`
- Modify: `src/lenses/lenses.module.ts`, `src/meetings/meetings.service.ts`, `src/meetings/meetings.controller.ts`, `src/meetings/meetings.repository.ts`
- Test: `test/lens-extraction.e2e-spec.ts`

**Interfaces:**
- Consumes Task 1 builder and `JobsRepository.enqueue`.
- Produces `LensExtractionService.request(meetingId)`.
- Produces `findLatestExtractionRun(exec, meetingId)` for the status response.

- [ ] **Step 1: Write failing E2E tests**

```ts
it('reuses the active run for duplicate requests', async () => {
  const first = await request(app.getHttpServer()).post('/meetings/mtg_1/lenses/extract').expect(202);
  const second = await request(app.getHttpServer()).post('/meetings/mtg_1/lenses/extract').expect(202);
  expect(second.body).toEqual(first.body);
  expect(await activeRunCount('mtg_1', 0)).toBe(1);
});
it('rejects a non-done meeting', () =>
  request(app.getHttpServer()).post('/meetings/mtg_1/lenses/extract').expect(409));
```

Also assert `GET /meetings/:id/status` includes latest run `status`, `model`, `error`, and `finished_at`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- --runInBand test/lens-extraction.e2e-spec.ts`

Expected: FAIL with route 404.

- [ ] **Step 3: Implement one transaction and the route**

Lock the meeting; return 404 if absent and 409 unless it is done. Lock/query the active run; return it unchanged if present. Otherwise insert queued run, enqueue the Task 1 payload, update run `job_id`, and return `{run_id, job_id, status, processing_version}`.

Before the API can enqueue its first extraction job, extend the existing database
`job_type_check` with a migration that permits `extract_lenses` alongside the three
existing job types. The TypeScript union added in Task 1 does not change PostgreSQL's
CHECK constraint.

```ts
@Post(':id/lenses/extract')
@HttpCode(202)
extract(@Param('id') id: string) { return this.service.extractLenses(id); }
```

Make `MeetingsService` delegate to the extraction service. Extend `findStatus` with a lateral latest-run query nested as `lens_extraction`, without renaming existing status fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:e2e -- --runInBand test/lens-extraction.e2e-spec.ts`

Expected: PASS and exactly one active run/job exists after duplicate requests.

- [ ] **Step 5: Commit**

```bash
git add src/lenses/lens-extraction.repository.ts src/lenses/lens-extraction.service.ts src/lenses/lenses.module.ts src/meetings/meetings.service.ts src/meetings/meetings.controller.ts src/meetings/meetings.repository.ts test/lens-extraction.e2e-spec.ts
git commit -m "feat: add manual lens extraction requests"
```

## Task 3: Python LLM contracts and OpenAI-compatible client

**Files:**
- Modify: `worker/pyproject.toml`, `worker/damwha_worker/contracts.py`, `worker/damwha_worker/config.py`, `worker/damwha_worker/errors.py`
- Create: `worker/damwha_worker/lens_client.py`, `worker/tests/test_contracts_lenses.py`, `worker/tests/test_lens_client.py`

**Interfaces:**
- Produces `ExtractLensesPayload`, `LensCandidate`, `LensExtractionResponse`.
- Produces `LensClient.extract(*, utterances) -> list[LensCandidate]`.

- [ ] **Step 1: Write failing strict-contract and HTTP tests**

```python
def test_extract_payload_requires_run_and_model():
    with pytest.raises(ValidationError):
        parse_payload("extract_lenses", {"schema_version": 1, "meeting_id": "mtg_1"})

def test_client_posts_openai_chat_completion_with_bearer(httpx_mock):
    client = LensClient("http://localhost:11434/v1", "qwen", "secret", 12.0)
    httpx_mock.add_response(json={"choices": [{"message": {"content": '{"items": []}'}}]})
    assert client.extract(utterances=[]) == []
    assert httpx_mock.get_request().headers["Authorization"] == "Bearer secret"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_contracts_lenses.py tests/test_lens_client.py -q`

Expected: FAIL due to missing models and client.

- [ ] **Step 3: Implement strict models and HTTP mapping**

Add `httpx>=0.27`. Restrict candidate kind to `action|decision|promise`, trimmed text to 1–1000 characters, IDs to DB formats, and due date to Pydantic `date`. Add `extract_lenses: frozenset({1})` to worker payload dispatch.

Use `httpx.Client(timeout=timeout_seconds)`, POST `{base_url}/chat/completions`, add `response_format: {type: 'json_object'}`, and validate `choices[0].message.content` through `model_validate_json`. Map timeout/transport/408/429/5xx to transient `WorkerError`; map other 4xx, malformed JSON, and schema errors to permanent errors. Add LLM base URL, model, optional API key, and timeout to `Settings`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_contracts_lenses.py tests/test_lens_client.py -q && uv run ruff check damwha_worker tests`

Expected: PASS and no Ruff findings.

- [ ] **Step 5: Commit**

```bash
git add worker/pyproject.toml worker/uv.lock worker/damwha_worker/contracts.py worker/damwha_worker/config.py worker/damwha_worker/errors.py worker/damwha_worker/lens_client.py worker/tests/test_contracts_lenses.py worker/tests/test_lens_client.py
git commit -m "feat: add lens extraction LLM client"
```

## Task 4: Worker extraction lifecycle and guarded merge

**Files:**
- Create: `worker/damwha_worker/pipeline/extract_lenses.py`, `worker/tests/test_extract_lenses.py`
- Modify: `worker/damwha_worker/db.py`, `worker/damwha_worker/__main__.py`, `worker/tests/test_worker_loop.py`

**Interfaces:**
- Produces `run_extract_lenses(conn, job, payload, client, *, worker_id, shutdown_event) -> str`.
- Produces `mark_lens_run_running`, `persist_lens_extraction`, `fail_lens_extraction`.

- [ ] **Step 1: Write failing lifecycle and merge tests**

```python
def test_extract_persists_ai_item_and_primary_evidence(conn, extraction_job, fake_client):
    fake_client.extract.return_value = [candidate("action", "utt_1", ["utt_2"])]
    assert run_extract_lenses(conn, extraction_job, payload(extraction_job), fake_client, worker_id="w") == "committed"
    assert one("SELECT source FROM lens_item")["source"] == "ai"
    assert one("SELECT relation FROM lens_evidence WHERE utterance_id='utt_1'")["relation"] == "primary"

def test_foreign_candidate_rolls_back_every_candidate(conn, extraction_job, fake_client):
    fake_client.extract.return_value = [candidate("action", "utt_1"), candidate("decision", "utt_999")]
    with pytest.raises(WorkerError): run_extract_lenses(conn, extraction_job, payload(extraction_job), fake_client, worker_id="w")
    assert count("SELECT * FROM lens_item") == 0
```

Add test cases for user-modified preservation, unmatched AI archival, transient requeue with run still running, terminal run failure while meeting stays done, and stale version discard.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_extract_lenses.py tests/test_worker_loop.py -q`

Expected: FAIL because pipeline/lifecycle functions do not exist.

- [ ] **Step 3: Implement guarded pipeline and persistence**

Read ordered `status='ok'` utterances at the payload version, include only those IDs in the prompt, and validate all evidence/assignees against the same meeting/version before mutation. In one transaction lock `job JOIN lens_extraction_run`, verify job lock owner, running status, run ID, and meeting version. Apply task 1's `(kind, primary_utterance_id)` merge policy, then mark run/job done only after all evidence writes succeed.

Stale version or lost ownership must make job/run done with `discarded_by_stale_guard` and write no lenses. Add `extract_lenses` dispatch to `handle_job`; it requeues transient errors and uses `fail_lens_extraction` for final errors, never `fail_process_meeting`. Construct `LensClient` only when dispatching this job type.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/test_extract_lenses.py tests/test_worker_loop.py -q && uv run ruff check damwha_worker tests`

Expected: PASS; no partial lens writes and meeting remains done.

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/pipeline/extract_lenses.py worker/damwha_worker/db.py worker/damwha_worker/__main__.py worker/tests/test_extract_lenses.py worker/tests/test_worker_loop.py
git commit -m "feat: run automatic lens extraction jobs"
```

## Task 5: 처리 완료 시 자동 enqueue와 전체 검증

**Files:**
- Modify: `worker/damwha_worker/db.py`, `worker/damwha_worker/pipeline/process_meeting.py`, `worker/damwha_worker/__main__.py`, `worker/damwha_worker/config.py`
- Test: `worker/tests/test_db_persist.py`, `worker/tests/test_db_lifecycle.py`

**Interfaces:**
- Consumes Tasks 1–4.
- Produces automatic queued run/job creation in successful `persist_process_meeting`.

- [ ] **Step 1: Write failing persistence tests**

```python
def test_process_persist_enqueues_index_and_lens_extract_atomically(conn):
    assert persist_process_meeting(..., lens_llm_model="qwen") == "committed"
    assert {r["type"] for r in rows("SELECT type FROM job WHERE meeting_id='mtg_1'")} >= {"index_meeting", "extract_lenses"}
    run = one("SELECT status, model, job_id FROM lens_extraction_run WHERE meeting_id='mtg_1'")
    assert run["status"] == "queued" and run["model"] == "qwen" and run["job_id"]

def test_stale_process_persist_enqueues_no_run(conn):
    assert persist_process_meeting(...stale_version...) == "discarded"
    assert count("SELECT * FROM lens_extraction_run") == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/test_db_persist.py tests/test_db_lifecycle.py -q`

Expected: FAIL because process persistence has no extraction model/run enqueue.

- [ ] **Step 3: Implement automatic enqueue**

Pass `settings.lens_llm_model` through `run_process_meeting` to `persist_process_meeting`. In its fresh transaction branch insert the queued run, insert its Task 1 payload job, then update `job_id`. Do not enqueue in stale/discard branch.

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
cd worker && uv run pytest -q
cd worker && uv run ruff check . && uv run ruff format --check .
git diff --check
```

Expected: every command exits 0. If testcontainers requires Docker, record that prerequisite and do not claim it passed without Docker.

- [ ] **Step 5: Commit**

```bash
git add worker/damwha_worker/db.py worker/damwha_worker/pipeline/process_meeting.py worker/damwha_worker/__main__.py worker/damwha_worker/config.py worker/tests/test_db_persist.py worker/tests/test_db_lifecycle.py
git commit -m "feat: enqueue lens extraction after meeting processing"
```

## Task 6: 완료 상태 문서화

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-lens-automatic-extraction-worker-design.md`
- Modify: `docs/superpowers/specs/2026-07-14-lens-platform-roadmap-design.md`

- [ ] **Step 1: Record completion after Task 5 passes**

Set task 2 spec to `상태: 완료됨` with completion date. Change only roadmap task 2 heading to `완료 (2026-07-14)` and record the actual commit range. Keep roadmap overall open because tasks 3 and 4 remain.

- [ ] **Step 2: Verify and commit docs**

Run: `git diff --check && git diff -- docs/superpowers/specs`

Expected: only task 2 completion-state text changed.

```bash
git add docs/superpowers/specs/2026-07-14-lens-automatic-extraction-worker-design.md docs/superpowers/specs/2026-07-14-lens-platform-roadmap-design.md
git commit -m "docs: 렌즈 자동 추출 작업 완료 상태 반영"
```

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover persistence/API/status; Tasks 3–4 cover OpenAI calling, strict validation, retries, guards, and merge; Task 5 covers atomic automatic enqueue and full verification; Task 6 covers completion tracking.
- Placeholder scan: no TBD/TODO or deferred implementation markers remain.
- Type consistency: Nest and Python use the same v1 payload fields; API and pipeline interfaces are named before their consumers.
