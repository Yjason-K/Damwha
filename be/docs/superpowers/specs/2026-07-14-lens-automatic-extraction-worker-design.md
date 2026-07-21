# 렌즈 자동 추출 워커 설계

> 상태: 완료됨 (2026-07-15) · 작성일: 2026-07-14 · 상위 로드맵: `2026-07-14-lens-platform-roadmap-design.md` 작업 2

## 1. 목적과 범위

처리가 끝난 회의의 발언에서 액션아이템(`action`), 결정사항(`decision`), 약속·책임
(`promise`)을 자동 추출한다. 기존 Python 워커의 `job` 큐와 job당 자식 프로세스 모델을
확장하며, OpenAI 호환 HTTP API를 제공하는 로컬 LLM(Ollama, vLLM, LM Studio 등)을
사용한다.

이 작업은 자동·수동 실행, 구조화 출력 검증, 실행 이력, 재시도와 작업 1의 보존 병합을
포함한다. 전역 LensView UI와 저장 주제 검색은 포함하지 않는다.

## 2. 실행 이력과 큐 계약

### `extract_lenses` job

`job.type`에 `extract_lenses`를 추가한다. payload는 아래 v1 고정 구조다.

```json
{
  "schema_version": 1,
  "meeting_id": "mtg_1",
  "processing_version": 3,
  "extraction_run_id": "ler_7",
  "model": "qwen2.5:14b-instruct"
}
```

발언 원문과 화자 이름은 payload에 복제하지 않는다. 워커가 job 처리 시 해당
`meeting_id`·`processing_version`의 발언과 화자를 DB에서 읽는다. 그래서 payload는
작고, 재시도도 같은 처리 결과를 대상으로 한다.

`lens_extraction_run`에는 `job_id`를 추가해 API와 운영 도구가 run과 job을 연결할 수
있게 한다. `job_id`는 job 생성 뒤 같은 트랜잭션에서 채운다. `(meeting_id,
processing_version)`에 대해 상태가 `queued` 또는 `running`인 run은 하나만 허용하는
부분 unique index를 둔다.

### 자동 실행

`persist_process_meeting`이 최신 처리 버전의 발언을 저장하고 meeting을 `done`으로
전환할 때, 같은 DB 트랜잭션에서 다음을 생성한다.

1. `lens_extraction_run(status='queued', model=<설정 모델>)`
2. 이를 가리키는 `extract_lenses` job
3. run의 `job_id`

기존 `index_meeting` enqueue와 독립적이며 둘은 병렬로 claim될 수 있다. 처리 버전이
stale guard에 의해 discard되면 어느 것도 생성하지 않는다.

### 수동 재추출

`POST /meetings/:id/lenses/extract`를 추가한다. 회의가 없으면 404, `done` 상태가
아니면 409을 반환한다. 트랜잭션에서 현재 처리 버전의 queued/running run을 잠금 조회한다.

- 있으면 새 job을 만들지 않고 기존 `run_id`, `job_id`, `status`를 반환한다.
- 없으면 새 run/job을 만들고 `202 Accepted`와 같은 필드를 반환한다.

완료·실패한 이전 run은 새 실행을 막지 않는다. 새 결과의 저장은 작업 1의 병합 규칙을
따르므로 사용자 생성·수정·완료 항목은 보존된다.

## 3. LLM 어댑터와 출력 계약

워커 설정에 아래 환경 기반 값을 추가한다.

| 설정 | 의미 |
|---|---|
| `lens_llm_base_url` | OpenAI 호환 서버의 base URL |
| `lens_llm_model` | 호출·run 기록에 사용할 모델 식별자 |
| `lens_llm_api_key` | 선택 값. 있을 때만 Bearer 인증 헤더를 보낸다 |
| `lens_llm_timeout_seconds` | HTTP 전체 요청 timeout |

Nest API도 자동 enqueue payload를 만들기 위해 같은 모델 식별자를 환경 설정으로 읽는다.
base URL과 key는 Python 워커에만 필요하다.

어댑터는 `POST {base_url}/chat/completions`에 시스템 지시문과 순서가 있는 발언 목록을
보낸다. 각 발언은 `utterance_id`, `speaker_id`(없을 수 있음), 표시 이름(있을 수 있음),
시작·끝 시각, 텍스트를 가진다. 시스템 지시문은 다음을 요구한다.

- action·decision·promise만 추출하고, 추측하거나 중복 항목을 만들지 않는다.
- 후보마다 정확히 하나의 `primary_utterance_id`를 원본 ID로 지정한다.
- supporting ID와 assignee는 입력에 있던 값만 사용한다.
- 응답은 JSON 객체 하나이며 `items` 배열만 가진다.

응답 스키마는 다음이다. `supporting_utterance_ids`는 비어 있을 수 있으며 primary와
중복되면 저장 전에 하나로 정규화한다.

```json
{
  "items": [{
    "kind": "action",
    "text": "다음 주까지 제안서를 공유한다.",
    "assignee_speaker_id": "spk_2",
    "due_at": "2026-07-21",
    "primary_utterance_id": "utt_18",
    "supporting_utterance_ids": ["utt_19"]
  }]
}
```

Pydantic은 타입·enum·본문 길이·날짜·ID 형식을 검증한다. 이어서 DB가 모든 evidence
발언과 담당 화자가 해당 회의·처리 버전에 속하는지 검증한다. 하나라도 어기면 **응답 전체를
저장하지 않는다**.

## 4. 저장, 소유권과 stale 처리

워커는 job과 run을 같은 트랜잭션에서 잠근 뒤 run의 상태를 `running`으로 전환한다.
성공 저장도 같은 소유권 조건(`job.id`, `locked_by`, `status='running'`)과
`extraction_run.job_id`를 확인한다.

저장 시 작업 1의 `mergeAiExtraction` 정책을 Python DB 경로에 정확히 적용한다.

1. 활성·미수정·미완료 AI 항목은 `(kind, primary_utterance_id)`로 후보와 대응한다.
2. 대응한 항목은 AI 소유 필드와 evidence를 갱신하고, 새 후보는 만든다.
3. 새 후보에 대응하지 않은 위 AI 항목은 `archived`로 전환한다.
4. 사용자 생성·편집·완료 항목은 변경·보관·삭제하지 않는다.

회의가 재처리되어 `processing_version`이 달라졌거나 run/job 소유권을 잃었으면 결과를
discard하고 job만 `done`으로 끝낸다. 이 경우 최신 실행과 렌즈 항목을 건드리지 않는다.

## 5. 오류와 재시도

`extract_lenses`의 실패는 meeting 상태를 바꾸지 않는다. 회의의 녹취와 검색 색인은
`done`으로 계속 사용할 수 있다.

| 상황 | 분류 | 동작 |
|---|---|---|
| timeout, 연결 오류, HTTP 408/429/5xx | transient | 기존 job `max_attempts`까지 requeue |
| 인증 오류, 모델 없음, HTTP 4xx(408/429 제외) | permanent | 즉시 job/run failed |
| JSON 파싱·Pydantic·DB 소속 검증 실패 | permanent | 즉시 job/run failed, 결과 미저장 |
| 재시도 소진 | final | job/run failed, meeting은 done 유지 |

재시도 중 run은 `running`으로 남는다. 최종 실패 시 job error JSON을 run.error에 복사하고
run.finished_at을 채운다. 성공·discard도 run.finished_at을 채우며, discard는 run을 `done`으로
기록하고 job error에 stale 이유를 남긴다.

## 6. API 응답과 관찰성

수동 API 응답은 `{ run_id, job_id, status, processing_version }`를 반환한다. 회의 상태
응답에는 최신 extraction run의 상태·모델·오류·완료 시각을 포함해 작업 3이 별도 API 없이
추출 상태를 표시할 수 있게 한다. 오류 JSON은 worker job과 run에 같은 code/message/stage를
기록한다.

## 7. 검증 기준

- migration이 run-job 연결과 실행 중복 방지를 보장한다.
- process meeting의 최신 persist가 `index_meeting`과 `extract_lenses`를 한 트랜잭션으로
enqueue하며 stale persist는 둘 다 만들지 않음을 검증한다.
- 수동 API는 done 회의만 허용하고, 실행 중 run 재사용과 완료 뒤 새 run 생성을 검증한다.
- job payload의 Nest Zod와 Python Pydantic 계약이 각각 유효·무효 fixture를 검증한다.
- OpenAI 호환 요청의 URL·헤더·모델·timeout과 올바른 JSON 응답의 후보 변환을 단위 테스트한다.
- malformed JSON, schema 오류, 다른 회의/처리 버전의 발언·화자는 결과를 전혀 저장하지 않고
permanent failure가 됨을 검증한다.
- HTTP transient 재시도, 최종 run failed, meeting done 유지, stale discard, 사용자 수정 보존
병합을 worker 통합 테스트로 검증한다.
