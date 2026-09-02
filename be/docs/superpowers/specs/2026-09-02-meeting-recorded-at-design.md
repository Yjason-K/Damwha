# 회의 기준일시(recorded_at) 필수화 설계

> 상태: 초안 · 작성일: 2026-09-02

## 1. 목적과 범위

`meeting.recorded_at`을 nullable 선택 항목에서 **항상 값이 있는 회의 기준일시**로
승격하고, 그 값을 렌즈 추출 프롬프트에 실어 LLM이 상대 날짜 표현을 절대 날짜로
환산하게 한다. 지정되지 않은 업로드는 등록 시각으로 채운다.

포함하는 것: 마이그레이션과 백필, 업로드/수정 API의 계약 변경, 워커의 기준일시
주입과 `due_at` 파싱 관대화, FE 안내 문구.

포함하지 않는 것: 회의 목록·검색의 정렬 규칙 변경, `COALESCE(recorded_at,
created_at)` 정리, 요약(`summarize_meeting`) 프롬프트 변경.

## 2. 배경

데모 시드 회의(`mtg_1`)의 `extract_lenses` job이 `llm_invalid_response`(PERMANENT)로
실패했다. 원인은 모델이 `due_at`에 한국어 상대 날짜를 그대로 넣은 것이다.

```
6 validation errors for _LlmLensResponse
  items.3.due_at  input_value='22 일'
  items.5.due_at  input_value='목요일'
  items.6.due_at  input_value='오늘'
  items.9.due_at  input_value='22 일 월요일'
```

두 가지가 겹친 실패다.

1. 프롬프트가 `due_at (nullable)`이라고만 하고 **포맷도 기준일도 주지 않는다**.
   모델에게 "오늘"을 날짜로 바꿀 근거 자체가 없었다.
2. 검증이 all-or-nothing이라 날짜 6개가 **추출 10건 전체**를 떨궜다. `temperature=0`
   이라 재실행해도 같은 자리에서 죽는다.

같은 성격의 사고가 `lens_client.py`의 인덱스 보간 주석에 이미 한 번 기록돼 있다.

## 3. 데이터 모델

`be/src/database/migrations/021_meeting_recorded_at_not_null.sql`

```sql
UPDATE meeting SET recorded_at = created_at WHERE recorded_at IS NULL;
ALTER TABLE meeting ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE meeting ALTER COLUMN recorded_at SET NOT NULL;
```

기존 NULL 행은 `created_at`으로 백필한다. 등록 시각이 곧 이 회의에 대해 시스템이
아는 유일한 시점이고, 미지정 업로드의 기본값과 같은 규칙이라 신·구 데이터가 같은
의미를 갖는다.

순서가 중요하다 — 백필이 먼저다. `SET NOT NULL`을 먼저 걸면 기존 행 때문에 실패한다.

### COALESCE는 그대로 둔다

`lenses.repository.ts`, `saved-utterances.repository.ts`, `search.repository.ts`가
`COALESCE(recorded_at, created_at)`으로 정렬 키를 만든다. NOT NULL 이후에는 두 번째
인자가 죽은 가지가 되지만 **건드리지 않는다**. 무해한 방어이고, 정렬 키를 만지면 이
작업과 무관한 목록·검색 회귀 위험만 는다.

## 4. API 계약

### `POST /meetings` (업로드)

- `recorded_at`이 오면 ISO-8601 검증 후 저장. **지금은 검증이 없어서** 잘못된
  문자열이 Postgres까지 내려가 500으로 샌다. `processing`·`speakers`와 같은 자리
  (storage 저장 전)에서 검증하고, 실패하면 temp 파일을 unlink한 뒤 400을 던진다.
- 생략·빈 문자열이면 INSERT가 `now()`로 채운다.
- Swagger 설명을 "녹음 시각 ISO8601 (선택)"에서 "생략하면 업로드 시각으로 기록"으로
  고친다.

### `PATCH /meetings/:id` — 깨는 변경

`recorded_at: null`이 지금은 허용되고 컬럼을 NULL로 되돌린다
(`meetings.service.ts:148`). NOT NULL 이후로는 **400**이다. 에러 메시지에서 null이
더 이상 허용되지 않음을 밝힌다. 제목(`title`)의 null 허용은 그대로다.

## 5. 워커 — 기준일시 주입

### payload는 바꾸지 않는다

`ExtractLensesPayloadSchema`는 zod `.strict()`, 워커 쪽 `ExtractLensesPayload`는
pydantic `extra="forbid"`다. 필드를 하나 추가하면 `schema_version`을 2로 올리고 양쪽
계약과 계약 픽스처를 모두 손대야 한다. 그만한 값이 없다 — `recorded_at`은 enqueue
시점의 **결정**이 아니라 DB에 있는 **사실**이고, 워커는 이미 같은 job에서 발화와
화자를 DB에서 읽는다.

`run_extract_lenses`가 발화를 읽는 자리에서 `meeting.recorded_at`을 함께 읽는다.
부수 효과로, 사용자가 `PATCH`로 날짜를 고친 뒤 재추출하면 고친 값이 반영된다.
payload에 박아뒀다면 낡은 값이 재시도마다 되살아났을 것이다.

### 프롬프트

`_render_prompt`가 맨 앞에 한 줄을 붙인다.

```
Meeting date: 2026-09-02 (Asia/Seoul)

Speakers:
spk_1 김영재
...
```

`_EXTRACTION_SYSTEM_PROMPT`에 `due_at` 규칙을 추가한다: `YYYY-MM-DD` 절대 날짜로
쓰고, 발언이 "오늘"·"다음 주 목요일" 같은 상대 표현이면 회의 날짜를 기준으로
환산하며, 환산할 수 없으면 null.

### 타임존

`recorded_at`은 `timestamptz`이고 Postgres는 UTC, 워커 호스트는 KST다. 렌더링 존을
고정하지 않으면 오전 8시 KST 회의가 UTC로 전날이 되어 모든 `due_at`이 하루씩 밀린다.

워커 `Settings`에 `meeting_timezone: str = "Asia/Seoul"`을 추가하고 이 존으로 날짜를
환산한다. 기본값으로 동작하되, 해외 배포에서는 env로 바꾼다.

## 6. 워커 — `due_at` 파싱 관대화

`_LlmLensItem.due_at`을 `Annotated[date | None, BeforeValidator(...)]`로 바꾼다.
validator는 값을 ISO 날짜로 파싱해 보고, 실패하면 `None`을 돌려준다.

핵심은 **실패 단위가 항목 하나**라는 점이다. 지금은 날짜 하나가 깨지면 추출 run
전체가 `llm_invalid_response`로 죽는다. 관대화 이후에는 그 항목이 마감일 없는
항목이 되고 나머지 9건은 저장된다.

관대화는 `due_at`에만 적용한다. `kind`·`text`·`primary_index`는 그대로 엄격하다 —
그것들이 틀리면 항목 자체가 의미가 없고, 인덱스 조작은 없는 발화를 근거로 지목하는
문제라 조용히 넘기면 안 된다.

## 7. FE

동작 변경 없음. `upload-dialog.tsx`는 이미 `DatePicker` + 시각 입력을 선택 항목으로
갖고 있고, 서버가 기본값을 채우므로 그대로 둔다. 필드 아래 "비우면 업로드 시각으로
기록됩니다" 안내 문구만 추가한다.

`Meeting` 타입의 `recorded_at`은 nullable로 유지한다. 서버가 항상 값을 주게 되지만,
타입을 좁히면 이 작업과 무관한 컴포넌트들의 null 분기까지 정리 대상이 된다.

## 8. 테스트

TDD로 간다 — 각 항목의 테스트를 먼저 쓰고 실패를 확인한 뒤 구현한다.

| 대상 | 파일 | 케이스 |
| --- | --- | --- |
| 업로드 | `be/test/meetings.e2e-spec.ts` | 미지정 → `recorded_at`이 업로드 시각 근처; ISO 지정 → 그 값; 잘못된 문자열 → 400 |
| 수정 | `be/test/meetings-management.e2e-spec.ts` | `recorded_at: null` → 400; ISO 지정 → 200 |
| 마이그레이션 | `be/test/migration.spec.ts` | NULL 행이 `created_at`으로 백필되고 NOT NULL이 걸린다 |
| 렌즈 클라이언트 | `be/worker/tests/test_lens_client.py` | 프롬프트 첫 줄에 기준일; `'2026-09-22'` → date, `'오늘'`·`'22 일'` → None(항목은 보존) |
| 추출 파이프라인 | `be/worker/tests/test_extract_lenses.py` | `meeting.recorded_at`을 읽어 client에 넘긴다 |
| 설정 | `be/worker/tests/test_config.py` | `meeting_timezone` 기본값 `Asia/Seoul` |

## 9. 롤아웃

1. `feat/meeting-recorded-at`(← `origin/dev`)에서 구현.
2. PR → `dev` 병합.
3. `feat/public-demo-deployment`에 `dev` 머지.
4. 데모 DB에서 `job_3`을 requeue해 렌즈 재추출이 통과하는지 확인.

마이그레이션은 되돌리는 스크립트를 두지 않는다. 되돌릴 일이 생기면 NOT NULL만 다시
푸는 한 줄이면 되고, 백필된 값은 되돌릴 원본이 애초에 없다(NULL이었다).
