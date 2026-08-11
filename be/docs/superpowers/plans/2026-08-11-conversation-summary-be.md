# 대화 요약 (백엔드 + 워커) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대화 녹음에서 주요 주제와 단락별 요약을 로컬 LLM으로 추출해 저장하고, 조회·재생성 API로 노출한다.

**Architecture:** 기존 `extract_lenses` 잡의 형제로 `summarize_meeting` 잡을 신설한다. 두 잡은 `process_meeting` 완료 시 같은 트랜잭션에서 나란히 큐잉되고 서로 독립적으로 실행·재시도·실패한다. 결과는 회의당 1행인 `meeting_summary` 테이블에 jsonb로 저장된다(읽기 전용 + 통째 재생성이라 정규화하지 않는다). LLM은 단락 경계의 `utterance.id`만 반환하고 타임스탬프는 워커가 DB에서 파생시킨다.

**Tech Stack:** NestJS 11 + 원시 SQL(`DatabaseService`) + zod / Python 3.12 + pydantic v2 + psycopg3 + httpx / Postgres 16 (pgvector, pg_bigm) / pytest + testcontainers, jest + testcontainers

**설계 문서:** `docs/superpowers/specs/2026-08-11-conversation-summary-design.md`

## Global Constraints

- Node **22** 필수 (`.nvmrc`, `engines`). 명령 전에 `nvm use`.
- Python 워커는 `worker/` 디렉터리에서 **uv**로 실행. 테스트는 `uv run pytest -q`.
- **테스트에 Docker 필요** — testcontainers가 `damwha/postgres-bigm:pg16`을 띄운다.
- **ORM 없음.** 모든 DB 접근은 원시 SQL. NestJS는 `DatabaseService`(`query` + `withTransaction`), 워커는 psycopg3.
- 마이그레이션은 `src/database/migrations/`의 번호 붙은 SQL 파일. **이미 적용된 파일은 절대 수정하지 않는다.** 새 번호를 추가한다.
- Enum은 네이티브 타입이 아니라 `text` + `CHECK`. **zod 스키마 · pydantic 스키마 · CHECK 목록 셋을 항상 함께 바꾼다.**
- 잡 페이로드는 양쪽 계약이다 — `src/contracts/job-payload.schema.ts`(zod)와 `worker/damwha_worker/contracts.py`(pydantic)가 같은 모양을 유지해야 하고, `test/fixtures/job-payloads/`의 동일 fixture를 양쪽에서 검증한다.
- **API에 ML·외부 네트워크 호출을 추가하지 않는다.** LLM 호출은 워커 쪽에만 존재하며 루프백 로컬이다.
- 워커의 공유 상태 쓰기는 **전부 소유권 가드**를 거친다. 영향 행 0 = 소유권 상실 → 로컬 결과 폐기.
- 커밋 메시지·주석·문서는 **한국어**.

---

### Task 1: 마이그레이션 — 잡 타입/스테이지 제약과 `meeting_summary` 테이블

**Files:**
- Create: `src/database/migrations/016_summarize_meeting_job.sql`
- Create: `src/database/migrations/017_meeting_summary.sql`
- Modify: `src/jobs/jobs.types.ts:4` (`JobType` 유니온)
- Test: `worker/tests/test_summarize_meeting.py`, `test/jobs.repository.spec.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `meeting_summary` 테이블 (`meeting_id` PK, `processing_version`, `job_id`, `model`, `status`, `topics` jsonb, `segments` jsonb, `error` jsonb, `updated_at`); `job.type`에 `'summarize_meeting'` 허용; `job.stage`에 `'summarize_meeting'`, `'persist_summary'` 허용; TS `JobType`에 `'summarize_meeting'` 추가

> **DB CHECK만 늘리면 컴파일이 깨진다.** `jobs.enqueue`가 받는 `type`은 `src/jobs/jobs.types.ts:4`의 `JobType` 유니온이라, 여기에 값을 넣지 않으면 Task 6의 `jobs.enqueue({ type: 'summarize_meeting', ... })`가 타입 오류로 실패한다. DB 제약과 TS 유니온은 한 태스크에서 함께 늘린다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`worker/tests/test_summarize_meeting.py`를 새로 만든다.

```python
def _one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()


def test_summarize_job_type_is_permitted_by_job_constraint(conn):
    definition = _one(
        conn,
        """SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conname='job_type_check'""",
    )["definition"]
    assert "summarize_meeting" in definition


def test_summarize_stages_are_permitted_by_job_constraint(conn):
    definition = _one(
        conn,
        """SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint WHERE conname='job_stage_check'""",
    )["definition"]
    assert "summarize_meeting" in definition
    assert "persist_summary" in definition


def test_meeting_summary_table_exists_with_defaults(conn):
    from tests.conftest import seed_meeting

    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, model, status)
           VALUES (%s, 0, 'model', 'queued')""",
        (meeting_id,),
    )
    row = _one(conn, "SELECT topics, segments, error FROM meeting_summary")
    assert row["topics"] == []
    assert row["segments"] == []
    assert row["error"] is None


def test_meeting_summary_status_check_rejects_unknown_value(conn):
    import psycopg
    import pytest

    from tests.conftest import seed_meeting

    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            """INSERT INTO meeting_summary(meeting_id, processing_version, model, status)
               VALUES (%s, 0, 'model', 'bogus')""",
            (meeting_id,),
        )
```

`test/jobs.repository.spec.ts`에도 TS 쪽 케이스를 추가한다. 이 테스트 하나가 `JobType` 유니온(컴파일 시점)과 DB CHECK(런타임)를 동시에 지킨다.

```ts
it('summarize_meeting 잡을 큐잉하고 다시 읽어온다', async () => {
  const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
  const job = await repo.enqueue(db.pool, {
    type: 'summarize_meeting',
    meetingId,
    payload: {
      schema_version: 1,
      meeting_id: meetingId,
      processing_version: 0,
      model: 'model',
    },
  });
  const { rows } = await db.query(`SELECT type FROM job WHERE id = $1`, [job.id]);
  expect(rows[0].type).toBe('summarize_meeting');
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd worker && uv run pytest tests/test_summarize_meeting.py -q
cd .. && npx jest test/jobs.repository.spec.ts
```

Expected: 워커 FAIL — `job_type_check`에 `summarize_meeting`이 없고 `meeting_summary` 릴레이션이 없다 (`UndefinedTable`). Jest FAIL — `'summarize_meeting'` is not assignable to type `JobType`.

- [ ] **Step 3: 마이그레이션을 쓴다**

`src/database/migrations/016_summarize_meeting_job.sql`:

```sql
ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting',
                  'extract_lenses','summarize_meeting'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary'));
```

`src/database/migrations/017_meeting_summary.sql`:

```sql
-- 회의당 1행. 요약은 읽기 전용이고 통째로 재생성되므로 topics/segments를
-- 정규화하지 않는다 — 재생성이 UPSERT 1회로 끝나고 원자적이다.
CREATE TABLE meeting_summary (
  meeting_id          text PRIMARY KEY REFERENCES meeting(id) ON DELETE CASCADE,
  processing_version  int  NOT NULL,
  job_id              text REFERENCES job(id) ON DELETE SET NULL,
  model               text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  topics              jsonb NOT NULL DEFAULT '[]'::jsonb,
  segments            jsonb NOT NULL DEFAULT '[]'::jsonb,
  error               jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: TS 잡 타입을 늘린다**

`src/jobs/jobs.types.ts:4`:

```ts
export type JobType =
  | 'process_meeting'
  | 'enroll_speaker'
  | 'index_meeting'
  | 'extract_lenses'
  | 'summarize_meeting';
```

- [ ] **Step 5: 통과를 확인한다**

```bash
cd worker && uv run pytest tests/test_summarize_meeting.py -q
cd .. && npx jest test/jobs.repository.spec.ts && npx tsc --noEmit -p tsconfig.build.json
```

Expected: 워커 PASS (4 passed), Jest PASS, 타입 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add src/database/migrations/016_summarize_meeting_job.sql \
        src/database/migrations/017_meeting_summary.sql \
        src/jobs/jobs.types.ts test/jobs.repository.spec.ts \
        worker/tests/test_summarize_meeting.py
git commit -m "feat: meeting_summary 테이블과 summarize_meeting 잡 타입 추가"
```

---

### Task 2: 잡 페이로드 계약 (zod + pydantic + fixture)

**Files:**
- Modify: `src/contracts/job-payload.schema.ts` (`ExtractLensesPayloadSchema` 정의 아래 `:83` 부근)
- Modify: `worker/damwha_worker/contracts.py:10-15`, `:139-167`, `:190-205`
- Create: `test/fixtures/job-payloads/summarize-meeting-v1.json`
- Test: `worker/tests/test_contracts.py` (기존 파일에 추가), `test/contracts.spec.ts` (기존 파일에 추가)

**Interfaces:**
- Consumes: Task 1의 `summarize_meeting` 잡 타입
- Produces:
  - TS: `SummarizeMeetingPayloadSchema`, 타입 `SummarizeMeetingPayload`, `buildSummarizeMeetingPayload({ meetingId, processingVersion, model }): SummarizeMeetingPayload`
  - Python: `SummarizeMeetingPayload`(필드 `schema_version: Literal[1]`, `meeting_id`, `processing_version`, `model`), `SummarySegmentCandidate`, `SummaryResponse`, `parse_payload("summarize_meeting", data) -> SummarizeMeetingPayload`

> 렌즈와 달리 `extraction_run_id`가 없다. `meeting_summary`가 회의당 1행이라 별도 run 엔티티가 필요 없고, `(meeting_id)`가 곧 키다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`worker/tests/test_contracts.py` 끝에 추가:

```python
def test_parse_summarize_meeting_payload():
    from damwha_worker.contracts import SummarizeMeetingPayload, parse_payload

    payload = parse_payload(
        "summarize_meeting",
        {
            "schema_version": 1,
            "meeting_id": "mtg_1",
            "processing_version": 0,
            "model": "qwen3.5:4b-mlx",
        },
    )
    assert isinstance(payload, SummarizeMeetingPayload)
    assert payload.model == "qwen3.5:4b-mlx"


def test_summarize_meeting_payload_rejects_extra_field():
    import pytest
    from pydantic import ValidationError

    from damwha_worker.contracts import parse_payload

    with pytest.raises(ValidationError):
        parse_payload(
            "summarize_meeting",
            {
                "schema_version": 1,
                "meeting_id": "mtg_1",
                "processing_version": 0,
                "model": "m",
                "extraction_run_id": "ler_1",
            },
        )


def test_summary_response_requires_known_utterance_id_shape():
    import pytest
    from pydantic import ValidationError

    from damwha_worker.contracts import SummaryResponse

    parsed = SummaryResponse.model_validate(
        {
            "topics": ["파이프라인 실행 순서"],
            "segments": [
                {
                    "start_utterance_id": "utt_1",
                    "end_utterance_id": "utt_2",
                    "title": "티켓 등록 수정",
                    "bullets": ["공유를 해드릴 것임"],
                }
            ],
        }
    )
    assert parsed.segments[0].title == "티켓 등록 수정"

    with pytest.raises(ValidationError):
        SummaryResponse.model_validate(
            {"topics": [], "segments": [{"start_utterance_id": "nope",
                                         "end_utterance_id": "utt_2",
                                         "title": "t", "bullets": []}]}
        )
```

`test/contracts.spec.ts` 끝에 추가 (기존 fixture 검증 패턴을 따른다):

```ts
import { SummarizeMeetingPayloadSchema } from '../src/contracts/job-payload.schema';
import summarizeV1 from './fixtures/job-payloads/summarize-meeting-v1.json';

describe('SummarizeMeetingPayloadSchema', () => {
  it('v1 fixture를 통과시킨다', () => {
    expect(() => SummarizeMeetingPayloadSchema.parse(summarizeV1)).not.toThrow();
  });

  it('알 수 없는 필드를 거부한다', () => {
    expect(() =>
      SummarizeMeetingPayloadSchema.parse({ ...summarizeV1, extraction_run_id: 'ler_1' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd worker && uv run pytest tests/test_contracts.py -q
cd .. && npx jest test/contracts.spec.ts
```

Expected: 양쪽 FAIL — `SummarizeMeetingPayload` / `SummarizeMeetingPayloadSchema` 미정의, fixture 파일 없음.

- [ ] **Step 3: 계약을 구현한다**

`test/fixtures/job-payloads/summarize-meeting-v1.json`:

```json
{
  "schema_version": 1,
  "meeting_id": "mtg_1",
  "processing_version": 0,
  "model": "qwen3.5:4b-mlx"
}
```

`src/contracts/job-payload.schema.ts` — `ExtractLensesPayloadSchema` 블록 바로 아래에 추가:

```ts
export const SummarizeMeetingPayloadSchema = z.object({
  schema_version: z.literal(1),
  meeting_id: z.string().regex(/^mtg_[1-9][0-9]*$/),
  processing_version: z.number().int().nonnegative(),
  model: z.string().min(1),
}).strict();
```

같은 파일의 타입 export 목록에 추가:

```ts
export type SummarizeMeetingPayload = z.infer<typeof SummarizeMeetingPayloadSchema>;
```

같은 파일 맨 아래에 빌더 추가:

```ts
export function buildSummarizeMeetingPayload(args: {
  meetingId: string; processingVersion: number; model: string;
}): SummarizeMeetingPayload {
  return {
    schema_version: 1,
    meeting_id: args.meetingId,
    processing_version: args.processingVersion,
    model: args.model,
  };
}
```

`worker/damwha_worker/contracts.py` — `SUPPORTED_SCHEMA_VERSIONS`에 항목 추가 (`:14` 다음 줄):

```python
    "summarize_meeting": frozenset({1}),
```

같은 파일에서 `LensExtractionResponse` 정의(`:164-167`) 아래에 추가:

```python
class SummarizeMeetingPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    meeting_id: MeetingId
    processing_version: int = Field(ge=0)
    model: NonEmptyString


class SummarySegmentCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_utterance_id: UtteranceId
    end_utterance_id: UtteranceId
    title: NonEmptyText
    bullets: list[NonEmptyText]


class SummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topics: list[NonEmptyText]
    segments: list[SummarySegmentCandidate]
```

`parse_payload`의 dispatch(`:199-205`)를 수정 — 마지막 무조건 반환을 명시 분기로 바꾼다:

```python
    if job_type == "index_meeting":
        return IndexMeetingPayload.model_validate(data)
    if job_type == "summarize_meeting":
        return SummarizeMeetingPayload.model_validate(data)
    return ExtractLensesPayload.model_validate(data)
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd worker && uv run pytest tests/test_contracts.py -q
cd .. && npx jest test/contracts.spec.ts
```

Expected: 양쪽 PASS

- [ ] **Step 5: 커밋**

```bash
git add src/contracts/job-payload.schema.ts worker/damwha_worker/contracts.py \
        test/fixtures/job-payloads/summarize-meeting-v1.json \
        test/contracts.spec.ts worker/tests/test_contracts.py
git commit -m "feat: summarize_meeting 잡 페이로드 계약 (zod + pydantic)"
```

---

### Task 3: `SummaryClient` — 로컬 LLM 어댑터

**Files:**
- Create: `worker/damwha_worker/summary_client.py`
- Test: `worker/tests/test_summary_client.py`

**Interfaces:**
- Consumes: Task 2의 `SummaryResponse`, `SummarySegmentCandidate`
- Produces: `SummaryClient(base_url: str, api_key: str | None, timeout_seconds: float)` with `summarize(*, model: str, utterances: list[dict]) -> SummaryResponse`

> `lens_client.py`의 형제다. 코드 흐름(타임아웃/상태코드 분류, 코드펜스 벗기기, `WorkerError` 매핑)은 동일하고 프롬프트와 응답 타입만 다르다. 반환값이 리스트가 아니라 객체이므로 `lens_client.py:84-85`의 "리스트로 오면 감싸기" 보정은 여기 없다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`worker/tests/test_summary_client.py`:

```python
import json

import httpx
import pytest

from damwha_worker.errors import WorkerError
from damwha_worker.summary_client import SummaryClient


def _mount(monkeypatch, handler):
    """httpx.Client.post를 handler로 대체한다."""
    monkeypatch.setattr(httpx.Client, "post", lambda self, url, **kw: handler(url, kw))


def _ok(content: str, status: int = 200):
    return httpx.Response(
        status,
        json={"choices": [{"message": {"content": content}}]},
        request=httpx.Request("POST", "http://x/chat/completions"),
    )


BODY = {
    "topics": ["파이프라인 실행 순서"],
    "segments": [
        {
            "start_utterance_id": "utt_1",
            "end_utterance_id": "utt_2",
            "title": "티켓 등록 수정",
            "bullets": ["공유를 해드릴 것임"],
        }
    ],
}


def test_summarize_parses_valid_response(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps(BODY, ensure_ascii=False)))
    client = SummaryClient("http://x", None, 5.0)
    result = client.summarize(model="m", utterances=[{"id": "utt_1"}])
    assert result.topics == ["파이프라인 실행 순서"]
    assert result.segments[0].end_utterance_id == "utt_2"


def test_summarize_unwraps_code_fence(monkeypatch):
    fenced = "```json\n" + json.dumps(BODY, ensure_ascii=False) + "\n```"
    _mount(monkeypatch, lambda url, kw: _ok(fenced))
    client = SummaryClient("http://x", None, 5.0)
    assert client.summarize(model="m", utterances=[]).topics == ["파이프라인 실행 순서"]


def test_summarize_sends_transcript_unescaped(monkeypatch):
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0).summarize(
        model="m", utterances=[{"id": "utt_1", "text": "한글"}]
    )
    user_message = captured["json"]["messages"][1]["content"]
    assert "한글" in user_message  # \uXXXX 이스케이프가 아니라 원문 그대로


def test_summarize_maps_5xx_to_transient(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok("{}", status=503))
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.TRANSIENT


def test_summarize_maps_invalid_json_to_permanent(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok("not json at all"))
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.PERMANENT
```

`ErrorKind`는 `from damwha_worker.errors import ErrorKind, WorkerError`로 가져온다. **enum 멤버로 비교하고 `.value` 문자열을 비교하지 않는다** — `ErrorKind`의 값은 `WorkerError.to_json()`(`errors.py:27`)을 통해 `job.error` jsonb에 저장되는 진단 데이터라, 테스트를 맞추려고 그 값을 바꾸면 저장된 데이터 형식이 업그레이드 경계에서 갈린다.

- [ ] **Step 2: 실패를 확인한다**

```bash
cd worker && uv run pytest tests/test_summary_client.py -q
```

Expected: FAIL — `ModuleNotFoundError: No module named 'damwha_worker.summary_client'`

- [ ] **Step 3: 클라이언트를 구현한다**

`worker/damwha_worker/summary_client.py`:

```python
import json
from typing import Any

import httpx
from pydantic import ValidationError

from .contracts import SummaryResponse
from .errors import (
    LLM_INVALID_RESPONSE,
    LLM_REQUEST_FAILED,
    ErrorKind,
    WorkerError,
)

_SUMMARY_SYSTEM_PROMPT = (
    "Return a JSON object with exactly two keys: topics and segments. topics is an "
    "array of short phrases naming what was discussed. segments splits the "
    "conversation into consecutive chunks; each segment has exactly these fields: "
    "start_utterance_id, end_utterance_id, title, bullets. start_utterance_id and "
    "end_utterance_id must be IDs from the supplied utterances, in the order given. "
    "bullets are short sentences restating what was said in that segment. Do not "
    "output timestamps. Do not speculate. Write topics, title, and bullets in the "
    "language of the transcript."
)


def _strip_code_fence(content: str) -> str:
    """Unwrap a ```json ... ``` block. Models wrap JSON despite response_format."""
    text = content.strip()
    if not text.startswith("```"):
        return text
    body = text[3:].removesuffix("```")
    head, sep, rest = body.partition("\n")
    return rest if sep and not head.strip().startswith("{") else body


class SummaryClient:
    """Small synchronous adapter for OpenAI-compatible chat-completion APIs."""

    def __init__(self, base_url: str, api_key: str | None, timeout_seconds: float) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    def summarize(self, *, model: str, utterances: list[dict[str, Any]]) -> SummaryResponse:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
                # Escaped non-ASCII (\uXXXX) is unreadable to the model and inflates
                # the prompt several-fold, so the transcript goes over as-is.
                {
                    "role": "user",
                    "content": json.dumps({"utterances": utterances}, ensure_ascii=False),
                },
            ],
            "response_format": {"type": "json_object"},
            "reasoning_effort": "none",
        }
        try:
            with httpx.Client(timeout=self._timeout_seconds) as client:
                response = client.post(
                    f"{self._base_url}/chat/completions", headers=headers, json=payload
                )
        except httpx.TimeoutException as exc:
            raise WorkerError(LLM_REQUEST_FAILED, str(exc), ErrorKind.TRANSIENT) from exc
        except httpx.RequestError as exc:
            raise WorkerError(LLM_REQUEST_FAILED, str(exc), ErrorKind.TRANSIENT) from exc

        if response.status_code in {408, 429} or response.status_code >= 500:
            raise WorkerError(LLM_REQUEST_FAILED, response.text, ErrorKind.TRANSIENT)
        if response.status_code >= 400:
            raise WorkerError(LLM_REQUEST_FAILED, response.text, ErrorKind.PERMANENT)

        try:
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(_strip_code_fence(content))
            return SummaryResponse.model_validate(parsed)
        except (IndexError, KeyError, TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd worker && uv run pytest tests/test_summary_client.py -q && uv run ruff check .
```

Expected: PASS (5 passed), ruff 통과

- [ ] **Step 5: 커밋**

```bash
git add worker/damwha_worker/summary_client.py worker/tests/test_summary_client.py
git commit -m "feat: 로컬 LLM 요약 클라이언트 SummaryClient 추가"
```

---

### Task 4: 워커 DB 레이어 — 소유권 가드가 붙은 요약 읽기/쓰기

**Files:**
- Modify: `worker/damwha_worker/db.py` (`fail_enroll` 뒤, `:175` 부근에 새 함수 3개; `persist_process_meeting`의 후속 잡 큐잉부 `:355-386` 뒤; reaper CTE `:110-115`)
- Modify: `src/jobs/jobs.repository.ts:92-97` (reaper CTE — 워커와 **같은 SQL 본문**)
- Test: `worker/tests/test_summarize_meeting.py` (Task 1에서 만든 파일에 추가), `test/jobs.repository.spec.ts`

> **reaper는 둘이다.** NestJS `reaper.service.ts`와 워커 supervisor의 데몬 스레드가 5분마다 **같은 CTE**를 돌린다(`CLAUDE.md`의 잡 큐 불변식). 운영 스케줄러는 `JobsRepository.reapStale`를 쓰므로, 워커 쪽 `db.reap_stale`만 고치면 크래시 경로에서 잡은 `failed`가 되는데 `meeting_summary`는 `running`에 고정된다. 그러면 재생성 요청이 "이미 진행 중"으로 판정되어 영구히 막힌다. **두 SQL 본문을 같은 태스크에서 함께 고친다.**

**Interfaces:**
- Consumes: Task 1의 `meeting_summary` 테이블
- Produces:
  - `db.mark_summary_running(conn, *, job_id, worker_id, meeting_id, processing_version) -> str` — `"running"` | `"discarded"` | `"lost"`
  - `db.persist_summary(conn, *, job_id, worker_id, meeting_id, processing_version, topics: list[str], segments: list[dict]) -> str` — `"committed"` | `"discarded"` | `"lost"`
  - `db.fail_summary(conn, job_id, worker_id, meeting_id, processing_version, error: dict) -> str` — `"failed"` | `"lost"`
  - `persist_process_meeting(..., summary_llm_model=None)` 파라미터 추가 — 값이 있으면 `meeting_summary` 행(`queued`)과 `summarize_meeting` 잡을 같은 트랜잭션에서 만든다

> 세 함수 모두 렌즈 쪽 형제(`mark_lens_run_running` / `persist_lens_extraction` / `fail_lens_extraction`)와 같은 두 겹 가드를 쓴다: **잡 가드**(`locked_by = worker AND status='running'`)와 **회의 가드**(`processing_version` 일치). 회의 가드가 어긋나면 결과를 버리고 잡을 `done`으로 닫는다(`"discarded"`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`worker/tests/test_summarize_meeting.py`에 추가한다. 파일 상단에 import를 넣는다.

```python
from damwha_worker import db
from damwha_worker.errors import ErrorKind, WorkerError
from tests.conftest import seed_job, seed_meeting


def _utterance(conn, meeting_id, *, version=0, text="spoken", start_ms=0, end_ms=1000):
    return conn.execute(
        """
        INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, text, status,
                              order_index, processing_version)
        VALUES (%s, 'S0', %s, %s, %s, 'ok',
                (SELECT coalesce(max(order_index) + 1, 0)
                 FROM utterance WHERE meeting_id=%s),
                %s) RETURNING id
        """,
        (meeting_id, start_ms, end_ms, text, meeting_id, version),
    ).fetchone()["id"]


@pytest.fixture
def summary_job(conn):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    utt_1 = _utterance(conn, meeting_id, start_ms=0, end_ms=1000)
    utt_2 = _utterance(conn, meeting_id, text="support", start_ms=2000, end_ms=3000)
    job_id = seed_job(
        conn,
        type="summarize_meeting",
        meeting_id=meeting_id,
        payload={
            "schema_version": 1,
            "meeting_id": meeting_id,
            "processing_version": 0,
            "model": "model",
        },
    )
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'queued')""",
        (meeting_id, job_id),
    )
    return db.claim(conn, "w"), {"meeting_id": meeting_id, "utt_1": utt_1, "utt_2": utt_2}


def test_mark_summary_running_flips_status(conn, summary_job):
    job, ids = summary_job
    assert (
        db.mark_summary_running(
            conn, job_id=job["id"], worker_id="w",
            meeting_id=ids["meeting_id"], processing_version=0,
        )
        == "running"
    )
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "running"


def test_persist_summary_writes_topics_and_segments(conn, summary_job):
    job, ids = summary_job
    assert (
        db.persist_summary(
            conn, job_id=job["id"], worker_id="w",
            meeting_id=ids["meeting_id"], processing_version=0,
            topics=["주제"],
            segments=[{
                "start_utterance_id": ids["utt_1"], "end_utterance_id": ids["utt_2"],
                "start_ms": 0, "end_ms": 3000, "title": "제목", "bullets": ["불릿"],
            }],
        )
        == "committed"
    )
    row = _one(conn, "SELECT status, topics, segments FROM meeting_summary")
    assert row["status"] == "done"
    assert row["topics"] == ["주제"]
    assert row["segments"][0]["end_ms"] == 3000


def test_persist_summary_discards_on_stale_version(conn, summary_job):
    job, ids = summary_job
    conn.execute("UPDATE meeting SET processing_version=1 WHERE id=%s", (ids["meeting_id"],))
    assert (
        db.persist_summary(
            conn, job_id=job["id"], worker_id="w",
            meeting_id=ids["meeting_id"], processing_version=0,
            topics=["주제"], segments=[],
        )
        == "discarded"
    )
    assert _one(conn, "SELECT topics FROM meeting_summary")["topics"] == []
    assert _one(conn, "SELECT status FROM job WHERE id=%s", (job["id"],))["status"] == "done"


def test_fail_summary_marks_row_but_keeps_meeting_done(conn, summary_job):
    job, ids = summary_job
    error = WorkerError("bad_response", "invalid", ErrorKind.PERMANENT).to_json(stage="summarize")
    assert (
        db.fail_summary(conn, job["id"], "w", ids["meeting_id"], 0, error) == "failed"
    )
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "failed"
    assert (
        _one(conn, "SELECT status FROM meeting WHERE id=%s", (ids["meeting_id"],))["status"]
        == "done"
    )


def test_reaper_fails_summary_row_when_worker_lock_expires(conn):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    job_id = seed_job(
        conn, type="summarize_meeting", meeting_id=meeting_id, status="running",
        locked_by="w", attempts=3, max_attempts=3, locked_minutes_ago=30,
        payload={"schema_version": 1, "meeting_id": meeting_id,
                 "processing_version": 0, "model": "model"},
    )
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'running')""",
        (meeting_id, job_id),
    )
    db.reap_stale(conn, 5)
    assert _one(conn, "SELECT status FROM meeting_summary")["status"] == "failed"
```

`test/jobs.repository.spec.ts`에도 Nest reaper 케이스를 추가한다 — 두 reaper가 같은 동작을 해야 한다.

```ts
it('reapStale이 요약 잡 실패 시 요약 행도 failed로 넘긴다', async () => {
  const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
  const { rows: jobRows } = await db.query<{ id: string }>(
    `INSERT INTO job(type, meeting_id, payload, status, locked_by, locked_at,
                     attempts, max_attempts)
     VALUES ('summarize_meeting', $1, '{}'::jsonb, 'running', 'w',
             now() - interval '30 minutes', 3, 3)
     RETURNING id`,
    [meetingId],
  );
  await db.query(
    `INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
     VALUES ($1, 0, $2, 'model', 'running')`,
    [meetingId, jobRows[0].id],
  );

  await repo.reapStale(db.pool, 5);

  const { rows } = await db.query(
    `SELECT status FROM meeting_summary WHERE meeting_id = $1`, [meetingId],
  );
  expect(rows[0].status).toBe('failed');
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd worker && uv run pytest tests/test_summarize_meeting.py -q
cd .. && npx jest test/jobs.repository.spec.ts
```

Expected: 워커 FAIL — `AttributeError: module 'damwha_worker.db' has no attribute 'mark_summary_running'`. Jest FAIL — 요약 행이 `running`에 남아 있다.

- [ ] **Step 3: DB 함수를 구현한다**

`worker/damwha_worker/db.py`의 `fail_enroll` 정의가 끝나는 지점(`:175` 아래, `class _Abort` 앞)에 추가한다.

```python
def mark_summary_running(
    conn, *, job_id: str, worker_id: str, meeting_id: str, processing_version: int
) -> str:
    """요약 행을 running으로 넘긴다. 잡 가드 + 회의 가드 둘 다 통과해야 한다."""
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            mrow = conn.execute(
                "SELECT processing_version FROM meeting WHERE id=%s FOR UPDATE", (meeting_id,)
            ).fetchone()
            if mrow is None or mrow["processing_version"] != processing_version:
                stale = Jsonb(
                    {
                        "code": "discarded_by_stale_guard",
                        "message": "meeting superseded by newer processing_version",
                        "stage": "summarize_meeting",
                        "kind": None,
                    }
                )
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (stale, job_id),
                )
                # 요약 행도 함께 닫는다. 닫지 않으면 running인데 소유한 워커가 없는
                # 좀비가 남고, reaper는 reap된 잡만 매칭하므로 이 행을 건지지 못한다
                # (이 잡은 정상 종료라 reap 대상이 아니다). 그 상태에서 재생성은
                # queued|running을 "진행 중"으로 보고 영구히 거부된다.
                conn.execute(
                    "UPDATE meeting_summary SET status='failed', error=%s, updated_at=now() "
                    "WHERE meeting_id=%s AND processing_version=%s",
                    (stale, meeting_id, processing_version),
                )
                return "discarded"
            conn.execute(
                "UPDATE meeting_summary SET status='running', updated_at=now() "
                "WHERE meeting_id=%s AND processing_version=%s",
                (meeting_id, processing_version),
            )
            return "running"
    except _Abort:
        return "lost"


def persist_summary(
    conn,
    *,
    job_id: str,
    worker_id: str,
    meeting_id: str,
    processing_version: int,
    topics: list,
    segments: list,
) -> str:
    """검증이 끝난 요약으로 기존 행을 덮어쓴다 — 통째 교체라 머지 로직이 없다.

    UPSERT가 아니라 평범한 UPDATE다. 행은 잡을 큐잉한 트랜잭션에서 이미
    queued로 만들어져 있으므로 INSERT 경로가 필요 없다.
    """
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT 1 FROM job WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            mrow = conn.execute(
                "SELECT processing_version FROM meeting WHERE id=%s FOR UPDATE", (meeting_id,)
            ).fetchone()
            if mrow is None or mrow["processing_version"] != processing_version:
                stale = Jsonb(
                    {
                        "code": "discarded_by_stale_guard",
                        "message": "meeting superseded by newer processing_version",
                        "stage": "persist_summary",
                        "kind": None,
                    }
                )
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (stale, job_id),
                )
                # mark_summary_running과 같은 이유로 요약 행도 닫는다 — 소유자 없는
                # running 좀비가 남으면 재생성이 영구히 막힌다.
                conn.execute(
                    "UPDATE meeting_summary SET status='failed', error=%s, updated_at=now() "
                    "WHERE meeting_id=%s AND processing_version=%s",
                    (stale, meeting_id, processing_version),
                )
                return "discarded"
            # 요약 행은 큐잉 시점에 이미 만들어져 있다(queued). 여기서는 결과만
            # 덮어쓴다 — 읽기 전용이라 머지할 사람 손댄 값이 없다.
            conn.execute(
                """
                UPDATE meeting_summary
                   SET status='done', job_id=%s, topics=%s, segments=%s,
                       error=NULL, updated_at=now()
                 WHERE meeting_id=%s AND processing_version=%s
                """,
                (job_id, Jsonb(topics), Jsonb(segments), meeting_id, processing_version),
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"


def fail_summary(
    conn, job_id: str, worker_id: str, meeting_id: str, processing_version: int, error: dict
) -> str:
    """요약 실패는 요약 행과 잡만 건드린다 — meeting은 done을 유지한다."""
    try:
        with conn.transaction():
            cur = conn.execute(
                "UPDATE job SET status='failed', error=%s, updated_at=now() "
                "WHERE id=%s AND locked_by=%s AND status='running'",
                (Jsonb(error), job_id, worker_id),
            )
            if cur.rowcount == 0:
                raise _Abort
            conn.execute(
                "UPDATE meeting_summary SET status='failed', error=%s, updated_at=now() "
                "WHERE meeting_id=%s AND processing_version=%s",
                (Jsonb(error), meeting_id, processing_version),
            )
        return "failed"
    except _Abort:
        return "lost"
```

같은 파일의 reaper CTE에서 `fail_lens_extraction_runs` 블록(`:110-115`) 바로 뒤에 형제 블록을 추가한다.

```sql
        fail_summaries AS (
          UPDATE meeting_summary s SET status='failed', error=f.error, updated_at=now()
          FROM failed f
          WHERE s.job_id=f.id AND f.type='summarize_meeting'
          RETURNING s.meeting_id
        ),
```

**같은 블록을 `src/jobs/jobs.repository.ts`에도 넣는다** — `fail_lens_extraction_runs`(`:92-97`) 바로 뒤, `fail_meetings` 앞이다. 들여쓰기만 그 파일 스타일(7칸)에 맞춘다.

```sql
       fail_summaries AS (
         UPDATE meeting_summary s SET status='failed', error=f.error, updated_at=now()
         FROM failed f
         WHERE s.job_id=f.id AND f.type='summarize_meeting'
         RETURNING s.meeting_id
       ),
```

`persist_process_meeting`의 시그니처(`:185-202`)에 파라미터를 추가한다.

```python
    lens_llm_model=None,
    summary_llm_model=None,
) -> str:
```

같은 함수의 렌즈 큐잉 블록(`:355-386`)이 끝난 직후, `return "committed"` 앞에 추가한다.

```python
            if summary_llm_model is not None:
                summary_job_id = conn.execute(
                    """
                    INSERT INTO job(type, meeting_id, payload)
                    VALUES ('summarize_meeting', %s, %s)
                    RETURNING id
                    """,
                    (
                        meeting_id,
                        Jsonb(
                            {
                                "schema_version": 1,
                                "meeting_id": str(meeting_id),
                                "processing_version": processing_version,
                                "model": summary_llm_model,
                            }
                        ),
                    ),
                ).fetchone()["id"]
                conn.execute(
                    """
                    INSERT INTO meeting_summary(meeting_id, processing_version, job_id,
                                                model, status)
                    VALUES (%s, %s, %s, %s, 'queued')
                    ON CONFLICT (meeting_id) DO UPDATE
                    SET processing_version=EXCLUDED.processing_version,
                        job_id=EXCLUDED.job_id, model=EXCLUDED.model, status='queued',
                        topics='[]'::jsonb, segments='[]'::jsonb, error=NULL,
                        updated_at=now()
                    """,
                    (meeting_id, processing_version, summary_job_id, summary_llm_model),
                )
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd worker && uv run pytest tests/test_summarize_meeting.py -q
cd .. && npx jest test/jobs.repository.spec.ts
```

Expected: 워커 PASS (9 passed — Task 1의 4건 + 이번 5건), Jest PASS

- [ ] **Step 5: 회귀를 확인한다**

```bash
cd worker && uv run pytest -q
cd .. && npm test
```

Expected: 전체 통과. `persist_process_meeting` 시그니처가 바뀌었지만 새 파라미터는 기본값 `None`이라 기존 호출부가 깨지지 않는다.

- [ ] **Step 6: 커밋**

```bash
git add worker/damwha_worker/db.py src/jobs/jobs.repository.ts \
        worker/tests/test_summarize_meeting.py test/jobs.repository.spec.ts
git commit -m "feat: 요약 영속화 함수와 양쪽 reaper의 요약 실패 전이 추가"
```

---

### Task 5: `summarize_meeting` 파이프라인과 워커 배선

**Files:**
- Create: `worker/damwha_worker/pipeline/summarize_meeting.py`
- Modify: `worker/damwha_worker/__main__.py:13` (import), `:82-86` (dispatch), `:116-123` (실패 처리), `:25-39`·`:135-147`·`:168-198` (콜백 주입), `:373-380` (빌더)
- Modify: `worker/damwha_worker/config.py` (`summary_llm_model` 설정 추가)
- Test: `worker/tests/test_summarize_meeting.py` (파이프라인 케이스 추가)

**Interfaces:**
- Consumes: Task 3의 `SummaryClient.summarize`, Task 4의 `db.mark_summary_running` / `db.persist_summary`
- Produces: `run_summarize_meeting(conn, job, payload, client, *, worker_id, shutdown_event=None) -> str` — `"committed"` | `"discarded"` | `"lost"`

> **핵심 규칙:** LLM이 준 `start_utterance_id` / `end_utterance_id`만 신뢰 대상이고, `start_ms` / `end_ms`는 워커가 DB에서 읽은 행에서 채운다. 검증 실패는 all-or-nothing — `WorkerError(PERMANENT)`를 던지고 아무것도 저장하지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`worker/tests/test_summarize_meeting.py`에 추가한다.

```python
from types import SimpleNamespace

from damwha_worker.contracts import SummarySegmentCandidate, SummaryResponse
from damwha_worker.pipeline.summarize_meeting import run_summarize_meeting


def _payload(job):
    from damwha_worker.contracts import parse_payload

    return parse_payload(job["type"], job["payload"])


def _response(segments, topics=("주제",)):
    return SummaryResponse(topics=list(topics), segments=segments)


def _segment(start, end, title="제목", bullets=("불릿",)):
    return SummarySegmentCandidate(
        start_utterance_id=start, end_utterance_id=end,
        title=title, bullets=list(bullets),
    )


def test_pipeline_fills_timestamps_from_database(conn, summary_job):
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response([_segment(ids["utt_1"], ids["utt_2"])])
    )
    assert run_summarize_meeting(conn, job, _payload(job), client, worker_id="w") == "committed"
    segment = _one(conn, "SELECT segments FROM meeting_summary")["segments"][0]
    assert segment["start_ms"] == 0
    assert segment["end_ms"] == 3000
    assert segment["title"] == "제목"


def test_pipeline_sends_payload_model_and_utterance_rows(conn, summary_job):
    job, ids = summary_job
    captured = {}

    def summarize(**kwargs):
        captured.update(kwargs)
        return _response([])

    assert (
        run_summarize_meeting(
            conn, job, _payload(job), SimpleNamespace(summarize=summarize), worker_id="w"
        )
        == "committed"
    )
    assert captured["model"] == "model"
    assert [u["id"] for u in captured["utterances"]] == [ids["utt_1"], ids["utt_2"]]


def test_pipeline_rejects_segment_with_unknown_utterance(conn, summary_job):
    job, _ids = summary_job
    client = SimpleNamespace(summarize=lambda **_kw: _response([_segment("utt_999", "utt_998")]))
    with pytest.raises(WorkerError):
        run_summarize_meeting(conn, job, _payload(job), client, worker_id="w")
    assert _one(conn, "SELECT segments FROM meeting_summary")["segments"] == []


def test_pipeline_rejects_segment_with_reversed_boundaries(conn, summary_job):
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response([_segment(ids["utt_2"], ids["utt_1"])])
    )
    with pytest.raises(WorkerError):
        run_summarize_meeting(conn, job, _payload(job), client, worker_id="w")
    assert _one(conn, "SELECT segments FROM meeting_summary")["segments"] == []


def test_pipeline_rejects_out_of_order_segments(conn, summary_job):
    job, ids = summary_job
    client = SimpleNamespace(
        summarize=lambda **_kw: _response([
            _segment(ids["utt_2"], ids["utt_2"], title="뒤"),
            _segment(ids["utt_1"], ids["utt_1"], title="앞"),
        ])
    )
    with pytest.raises(WorkerError):
        run_summarize_meeting(conn, job, _payload(job), client, worker_id="w")


def test_pipeline_stores_empty_summary_for_meeting_without_utterances(conn):
    meeting_id = seed_meeting(conn, status="done", processing_version=0)
    job_id = seed_job(
        conn, type="summarize_meeting", meeting_id=meeting_id,
        payload={"schema_version": 1, "meeting_id": meeting_id,
                 "processing_version": 0, "model": "model"},
    )
    conn.execute(
        """INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
           VALUES (%s, 0, %s, 'model', 'queued')""",
        (meeting_id, job_id),
    )
    job = db.claim(conn, "w")
    client = SimpleNamespace(summarize=lambda **_kw: _response([], topics=()))
    assert run_summarize_meeting(conn, job, _payload(job), client, worker_id="w") == "committed"
    row = _one(conn, "SELECT status, topics FROM meeting_summary")
    assert row["status"] == "done"
    assert row["topics"] == []
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd worker && uv run pytest tests/test_summarize_meeting.py -q
```

Expected: FAIL — `ModuleNotFoundError: No module named 'damwha_worker.pipeline.summarize_meeting'`

- [ ] **Step 3: 파이프라인을 구현한다**

`worker/damwha_worker/pipeline/summarize_meeting.py`:

```python
import threading

from .. import db
from ..contracts import SummarizeMeetingPayload
from ..errors import LLM_INVALID_RESPONSE, ErrorKind, WorkerError
from .stage import enter_stage


def _resolve_segments(segments, rows) -> list[dict]:
    """LLM이 지목한 경계 utterance를 DB 행에 맞춰 검증하고 시간을 채운다.

    LLM은 id만 신뢰 대상이다 — start_ms/end_ms는 여기서 DB 값으로 파생시켜
    모델이 타임스탬프를 지어내는 실패 모드를 원천 차단한다.
    """
    order = {row["id"]: index for index, row in enumerate(rows)}
    by_id = {row["id"]: row for row in rows}
    resolved: list[dict] = []
    previous_end = -1
    for segment in segments:
        start = by_id.get(segment.start_utterance_id)
        end = by_id.get(segment.end_utterance_id)
        if start is None or end is None:
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segment cites an utterance outside the meeting: "
                f"{segment.start_utterance_id}..{segment.end_utterance_id}",
                ErrorKind.PERMANENT,
            )
        if order[start["id"]] > order[end["id"]]:
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segment boundaries are reversed: {start['id']}..{end['id']}",
                ErrorKind.PERMANENT,
            )
        if order[start["id"]] <= previous_end:
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segments are not in transcript order at {start['id']}",
                ErrorKind.PERMANENT,
            )
        previous_end = order[end["id"]]
        resolved.append(
            {
                "start_utterance_id": start["id"],
                "end_utterance_id": end["id"],
                "start_ms": start["start_ms"],
                "end_ms": end["end_ms"],
                "title": segment.title,
                "bullets": list(segment.bullets),
            }
        )
    return resolved


def run_summarize_meeting(
    conn,
    job: dict,
    payload: SummarizeMeetingPayload,
    client,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
) -> str:
    outcome = db.mark_summary_running(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
    )
    if outcome != "running":
        return outcome
    enter_stage(conn, job["id"], worker_id, "summarize_meeting", 30, shutdown_event)
    rows = conn.execute(
        """SELECT u.id, u.speaker_id, s.name AS speaker_name, u.text, u.start_ms, u.end_ms
           FROM utterance u
           LEFT JOIN speaker s ON s.id = u.speaker_id
           WHERE u.meeting_id=%s AND u.processing_version=%s
             AND u.status='ok' AND u.text IS NOT NULL
           ORDER BY u.order_index, u.id""",
        (payload.meeting_id, payload.processing_version),
    ).fetchall()
    response = client.summarize(model=payload.model, utterances=[dict(row) for row in rows])
    segments = _resolve_segments(response.segments, [dict(row) for row in rows])
    enter_stage(conn, job["id"], worker_id, "persist_summary", 80, shutdown_event)
    return db.persist_summary(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
        topics=list(response.topics),
        segments=segments,
    )
```

- [ ] **Step 4: 워커를 배선한다**

`worker/damwha_worker/config.py:25`의 `lens_llm_model` 바로 아래에 한 줄을 추가한다. `lens_llm_base_url` / `lens_llm_api_key` / `lens_llm_timeout_seconds`는 **재사용**한다 — 같은 로컬 런타임이다.

```python
    summary_llm_model: str = "qwen3.5:4b-mlx"
```

`worker/damwha_worker/__main__.py`:

`:13` 아래에 import 추가.

```python
from .pipeline.summarize_meeting import run_summarize_meeting
```

`handle_job` 시그니처(`:25-39`)에 두 파라미터 추가 — `build_lens_client=None` 다음에 `build_summary_client=None`, `lens_llm_model=None` 다음에 `summary_llm_model=None`.

`:86`의 `extract_lenses` 분기 바로 아래에 dispatch 분기 추가.

```python
        if job["type"] == "summarize_meeting":
            summary_client = build_summary_client()
            return run_summarize_meeting(
                conn, job, payload, summary_client,
                worker_id=worker_id, shutdown_event=shutdown_event,
            )
```

`:123`의 `extract_lenses` 실패 분기 바로 아래에 실패 분기 추가.

```python
        if job["type"] == "summarize_meeting":
            meeting_id = job["meeting_id"]
            processing_version = (job["payload"] or {}).get("processing_version")
            if transient_retry:
                return "requeued" if db.requeue(conn, job["id"], worker_id) else "lost"
            return db.fail_summary(
                conn, job["id"], worker_id, meeting_id, processing_version, error_json
            )
```

`run_process_meeting` 호출부(`:48-60`)에 `summary_llm_model=summary_llm_model,`을 추가하고, `run_once`(`:135-165`)와 `dispatch_claimed_job`(`:168-198`)에도 같은 두 파라미터를 통과시킨다. `dispatch_claimed_job`에서는 이렇게 넘긴다.

```python
            build_summary_client=(
                (lambda: build_summary_client_fn(settings)) if build_summary_client_fn else None
            ),
            summary_llm_model=settings.summary_llm_model,
```

`run_child`(`:373-380`) 아래에 빌더를 추가하고 `run_single_job`에 넘긴다.

```python
    def _build_summary_client(worker_settings):
        from .summary_client import SummaryClient

        return SummaryClient(
            worker_settings.lens_llm_base_url,
            worker_settings.lens_llm_api_key,
            worker_settings.lens_llm_timeout_seconds,
        )
```

`run_process_meeting`(`worker/damwha_worker/pipeline/process_meeting.py`)에도 `summary_llm_model` 파라미터를 추가하고, `db.persist_process_meeting` 호출에 그대로 전달한다.

- [ ] **Step 5: 통과를 확인한다**

```bash
cd worker && uv run pytest -q && uv run ruff check . && uv run ruff format .
```

Expected: 전체 PASS, ruff 통과

- [ ] **Step 6: 커밋**

```bash
git add worker/damwha_worker/pipeline/summarize_meeting.py \
        worker/damwha_worker/pipeline/process_meeting.py \
        worker/damwha_worker/__main__.py worker/damwha_worker/config.py \
        worker/tests/test_summarize_meeting.py
git commit -m "feat: summarize_meeting 파이프라인과 워커 디스패치 배선"
```

---

### Task 6: 요약 조회·재생성 API

**Files:**
- Create: `src/summary/summary.repository.ts`, `src/summary/summary.service.ts`, `src/summary/summary.module.ts`, `src/summary/summary.types.ts`
- Modify: `src/meetings/meetings.controller.ts` (`:57` 렌즈 재추출 라우트 아래에 새 라우트), `src/meetings/meetings.service.ts` (`getStatus` `:142-146` + 상세 응답에 `summary` 병합), `src/meetings/meetings.module.ts` (`SummaryModule` import — **이게 없으면 컨트롤러·서비스의 `SummaryService` DI가 실패한다**), `src/app.module.ts` (모듈 등록), `src/config/env.ts`, `.env.example`
- Test: `test/summary.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1의 `meeting_summary`, Task 2의 `buildSummarizeMeetingPayload`
- Produces:
  - `SummaryRow` = `{ meeting_id: string; processing_version: number; status: 'queued'|'running'|'done'|'failed'; model: string; topics: string[]; segments: SummarySegment[]; error: unknown }`
  - `SummarySegment` = `{ start_utterance_id: string; end_utterance_id: string; start_ms: number; end_ms: number; title: string; bullets: string[] }`
  - `SummaryService.get(meetingId): Promise<SummaryRow | null>` — 현재 `processing_version`과 다르면 `null`
  - `SummaryService.request(meetingId): Promise<{ status: string; job_id: string | null; processing_version: number }>`
  - `GET /meetings/:id` 응답에 `summary: SummaryRow | null`
  - `POST /meetings/:id/summary/generate`

> `LensExtractionService`(`src/lenses/lens-extraction.service.ts`)가 정확한 형제 패턴이다: `withTransaction` → 회의 잠금 → `status='done'` 확인 → 진행 중이면 재사용 → 아니면 행 생성 + `jobs.enqueue`. 렌즈와 달리 run 테이블이 없으므로 `meeting_summary` 행 자체를 UPSERT한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/summary.e2e-spec.ts`. 기존 `test/lenses.e2e-spec.ts`의 부트스트랩(테스트 DB 기동, 앱 생성, 시드 헬퍼)을 그대로 따른다.

```ts
describe('요약 API', () => {
  it('처리되지 않은 회의는 summary가 null이다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    const res = await request(app.getHttpServer()).get(`/meetings/${meetingId}`).expect(200);
    expect(res.body.summary).toBeNull();
  });

  it('저장된 요약을 상세 응답에 실어 준다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummary(meetingId, {
      processingVersion: 0,
      status: 'done',
      topics: ['주제'],
      segments: [{
        start_utterance_id: 'utt_1', end_utterance_id: 'utt_2',
        start_ms: 0, end_ms: 3000, title: '제목', bullets: ['불릿'],
      }],
    });
    const res = await request(app.getHttpServer()).get(`/meetings/${meetingId}`).expect(200);
    expect(res.body.summary.topics).toEqual(['주제']);
    expect(res.body.summary.segments[0].end_ms).toBe(3000);
  });

  it('재처리로 버전이 올라간 요약은 숨긴다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 1 });
    await seedSummary(meetingId, { processingVersion: 0, status: 'done', topics: ['옛날'] });
    const res = await request(app.getHttpServer()).get(`/meetings/${meetingId}`).expect(200);
    expect(res.body.summary).toBeNull();
  });

  it('재생성 요청이 summarize_meeting 잡을 큐잉한다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    const res = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .expect(201);
    expect(res.body.status).toBe('queued');
    const jobs = await db.query(
      `SELECT type FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('이미 진행 중이면 잡을 중복 큐잉하지 않는다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(201);
    await request(app.getHttpServer()).post(`/meetings/${meetingId}/summary/generate`).expect(201);
    const jobs = await db.query(
      `SELECT id FROM job WHERE meeting_id=$1 AND type='summarize_meeting'`, [meetingId],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('처리 중인 회의의 재생성 요청은 409다', async () => {
    const meetingId = await seedMeeting({ status: 'processing', processingVersion: 0 });
    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary/generate`)
      .expect(409);
  });

  it('상태 엔드포인트가 요약 상태를 함께 반환한다', async () => {
    const meetingId = await seedMeeting({ status: 'done', processingVersion: 0 });
    await seedSummary(meetingId, { processingVersion: 0, status: 'running', topics: [] });
    const res = await request(app.getHttpServer())
      .get(`/meetings/${meetingId}/status`)
      .expect(200);
    expect(res.body.summary_status).toBe('running');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
npx jest test/summary.e2e-spec.ts
```

Expected: FAIL — `summary` 필드 없음, `POST /meetings/:id/summary/generate` 404.

- [ ] **Step 3: 리포지토리를 구현한다**

`src/summary/summary.types.ts`:

```ts
export type SummaryStatus = 'queued' | 'running' | 'done' | 'failed';

export interface SummarySegment {
  start_utterance_id: string;
  end_utterance_id: string;
  start_ms: number;
  end_ms: number;
  title: string;
  bullets: string[];
}

export interface SummaryRow {
  meeting_id: string;
  processing_version: number;
  status: SummaryStatus;
  model: string;
  topics: string[];
  segments: SummarySegment[];
  error: unknown;
}
```

`src/summary/summary.repository.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { DatabaseService, Exec } from '../database/database.service';
import { SummaryRow } from './summary.types';

@Injectable()
export class SummaryRepository {
  constructor(private readonly db: DatabaseService) {}

  /** 현재 processing_version의 요약만 돌려준다 — 재처리로 버전이 오르면 없음 취급. */
  async findCurrent(meetingId: string): Promise<SummaryRow | null> {
    const { rows } = await this.db.query<SummaryRow>(
      `SELECT s.meeting_id, s.processing_version, s.status, s.model,
              s.topics, s.segments, s.error
         FROM meeting_summary s
         JOIN meeting m ON m.id = s.meeting_id
        WHERE s.meeting_id = $1 AND s.processing_version = m.processing_version`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async lockMeeting(exec: Exec, meetingId: string) {
    const { rows } = await exec.query<{ id: string; status: string; processing_version: number }>(
      `SELECT id, status, processing_version FROM meeting WHERE id = $1 FOR UPDATE`,
      [meetingId],
    );
    return rows[0] ?? null;
  }

  async findActive(exec: Exec, meetingId: string, processingVersion: number) {
    const { rows } = await exec.query<{ status: string; job_id: string | null }>(
      `SELECT status, job_id FROM meeting_summary
        WHERE meeting_id = $1 AND processing_version = $2
          AND status IN ('queued','running')`,
      [meetingId, processingVersion],
    );
    return rows[0] ?? null;
  }

  /** 재생성 — 이전 결과를 지우고 queued로 되돌린다(읽기 전용이라 머지가 없다). */
  async upsertQueued(
    exec: Exec,
    args: { meetingId: string; processingVersion: number; jobId: string; model: string },
  ) {
    await exec.query(
      `INSERT INTO meeting_summary(meeting_id, processing_version, job_id, model, status)
       VALUES ($1, $2, $3, $4, 'queued')
       ON CONFLICT (meeting_id) DO UPDATE
         SET processing_version = EXCLUDED.processing_version,
             job_id = EXCLUDED.job_id, model = EXCLUDED.model, status = 'queued',
             topics = '[]'::jsonb, segments = '[]'::jsonb, error = NULL, updated_at = now()`,
      [args.meetingId, args.processingVersion, args.jobId, args.model],
    );
  }
}
```

- [ ] **Step 4: 서비스와 라우트를 구현한다**

`src/summary/summary.service.ts`:

```ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { buildSummarizeMeetingPayload } from '../contracts/job-payload.schema';
import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { JobsRepository } from '../jobs/jobs.repository';
import { SummaryRepository } from './summary.repository';
import { SummaryRow } from './summary.types';

export interface SummaryRequestResult {
  status: string;
  job_id: string | null;
  processing_version: number;
}

@Injectable()
export class SummaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jobs: JobsRepository,
    private readonly summaries: SummaryRepository,
  ) {}

  get(meetingId: string): Promise<SummaryRow | null> {
    return this.summaries.findCurrent(meetingId);
  }

  async request(meetingId: string): Promise<SummaryRequestResult> {
    const model = loadEnv().SUMMARY_LLM_MODEL;
    return this.db.withTransaction(async (exec) => {
      const meeting = await this.summaries.lockMeeting(exec, meetingId);
      if (!meeting) throw new NotFoundException('meeting not found');
      if (meeting.status !== 'done') {
        throw new ConflictException('summary generation allowed only when status is done');
      }

      const active = await this.summaries.findActive(exec, meeting.id, meeting.processing_version);
      if (active) {
        return {
          status: active.status,
          job_id: active.job_id,
          processing_version: meeting.processing_version,
        };
      }

      const payload = buildSummarizeMeetingPayload({
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        model,
      });
      const job = await this.jobs.enqueue(exec, {
        type: 'summarize_meeting', meetingId: meeting.id, payload,
      });
      await this.summaries.upsertQueued(exec, {
        meetingId: meeting.id,
        processingVersion: meeting.processing_version,
        jobId: job.id,
        model,
      });
      return { status: 'queued', job_id: job.id, processing_version: meeting.processing_version };
    });
  }
}
```

`src/summary/summary.module.ts` — 컨트롤러는 없다(라우트가 `/meetings/:id/...` 아래라 meetings 컨트롤러에 붙는다).

```ts
import { Module } from '@nestjs/common';
import { SummaryRepository } from './summary.repository';
import { SummaryService } from './summary.service';

@Module({
  providers: [SummaryRepository, SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
```

`src/app.module.ts`의 imports 배열에 `SummaryModule`을 추가한다.

`src/meetings/meetings.controller.ts` — `:57`의 렌즈 재추출 라우트 아래에 추가한다.

```ts
  @Post(':id/summary/generate')
  @ApiOperation({ summary: '대화 요약 생성/재생성' })
  generateSummary(@Param('id') id: string) { return this.summary.request(id); }
```

컨트롤러 생성자에 `private readonly summary: SummaryService`를 추가한다.

`src/meetings/meetings.service.ts` — 생성자에 `private readonly summary: SummaryService`를 추가하고, 상세 조회 메서드 `get(id)`(`:134-140`, 현재 `return { ...meeting, utterances, clusters }`)의 반환 객체에 `summary`를 얹는다.

```ts
    const summary = await this.summary.get(id);
    return { ...meeting, utterances, clusters, summary };
```

`getStatus`(`:142-146`)도 요약 상태를 함께 싣는다.

```ts
  async getStatus(id: string) {
    const status = await this.meetings.findStatus(this.db.pool, id);
    if (!status) throw new NotFoundException('meeting not found');
    const summary = await this.summary.get(id);
    return { ...status, summary_status: summary?.status ?? null };
  }
```

`MeetingsModule`의 imports에 `SummaryModule`을 추가한다.

`src/config/env.ts`의 스키마에 `SUMMARY_LLM_MODEL`을 추가한다 — `:29`의 `LENS_LLM_MODEL: z.string().default('qwen3.5:4b-mlx')` 바로 아래에 같은 형태로:

```ts
  SUMMARY_LLM_MODEL: z.string().default('qwen3.5:4b-mlx'),
```

`.env.example`에도 같은 줄을 추가한다.

`src/meetings/meetings.module.ts`의 `imports` 배열은 현재 `[SettingsModule, SystemModule, LensesModule]`이다 — 여기에 `SummaryModule`을 같은 방식으로 추가한다.

- [ ] **Step 5: 통과를 확인한다**

```bash
npx jest test/summary.e2e-spec.ts
npx tsc --noEmit -p tsconfig.build.json
```

Expected: PASS (7 passed), 타입 오류 없음

- [ ] **Step 6: 회귀를 확인한다**

```bash
npm test
```

Expected: 전체 통과

- [ ] **Step 7: 커밋**

```bash
git add src/summary src/meetings/meetings.controller.ts src/meetings/meetings.service.ts \
        src/meetings/meetings.module.ts src/app.module.ts src/config/env.ts \
        .env.example test/summary.e2e-spec.ts
git commit -m "feat: 요약 조회/재생성 API 추가"
```

---

### Task 7: 문서 갱신

**Files:**
- Modify: `docs/worker-architecture.md` (잡 타입 목록과 흐름도)
- Modify: `CLAUDE.md` ("Lens extraction is a third job type" 문단 뒤)

**Interfaces:**
- Consumes: Task 1–6 전체
- Produces: 없음 (문서)

- [ ] **Step 1: 워커 아키텍처 문서에 잡을 추가한다**

`docs/worker-architecture.md`의 잡 타입 목록과 `process_meeting` 후속 흐름도에 `summarize_meeting`을 추가한다. 요지: `process_meeting`의 persist 트랜잭션이 `index_meeting`, `extract_lenses`, `summarize_meeting` 세 후속 잡을 함께 큐잉하며, 셋은 서로 독립적으로 실행·재시도·실패한다.

- [ ] **Step 2: CLAUDE.md에 불변식을 적는다**

Python worker 절의 렌즈 문단 뒤에 추가한다.

```markdown
- **Conversation summary is a fourth job type.** `summarize_meeting`
  (`pipeline/summarize_meeting.py`) reads the same `status='ok'` utterances as
  `extract_lenses` and calls the same local LLM through `summary_client.py`,
  but writes a single `meeting_summary` row (topics + segments as jsonb). The
  two jobs are queued together in the `persist` transaction and are otherwise
  **independent** — a summary failure leaves lens items untouched and vice
  versa. **The LLM supplies only boundary `utterance_id`s; `start_ms`/`end_ms`
  are derived from the DB rows** (`_resolve_segments`), so a model cannot
  invent timestamps. Validation is all-or-nothing: an unknown utterance,
  reversed boundaries, or out-of-order segments raise a PERMANENT
  `WorkerError` and nothing is stored. The summary is **read-only** — there is
  no per-item edit path, no `source` column, and no merge; regeneration
  replaces the row wholesale.
```

- [ ] **Step 3: 커밋**

```bash
git add docs/worker-architecture.md CLAUDE.md
git commit -m "docs: summarize_meeting 잡과 요약 불변식 기록"
```

---

## 완료 확인

```bash
npm test                       # NestJS 전체
cd worker && uv run pytest -q  # 워커 전체
cd worker && uv run ruff check .
cd .. && npx tsc --noEmit -p tsconfig.build.json
```

네 명령이 모두 통과하면 백엔드 작업이 끝난 것이다. 프론트엔드는 `../fe/docs/superpowers/plans/2026-08-11-conversation-summary-fe.md`가 이어받는다.
