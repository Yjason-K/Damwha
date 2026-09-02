# 회의 기준일시(recorded_at) 필수화 설계

> 상태: 초안 · 작성일: 2026-09-02 · 개정: 2026-09-02 (Codex 리뷰 반영)

## 1. 목적과 범위

`meeting.recorded_at`을 nullable 선택 항목에서 **항상 값이 있는 회의 기준일시**로
승격하고, 그 값을 렌즈 추출 프롬프트에 실어 LLM이 상대 날짜 표현을 절대 날짜로
환산하게 한다. 지정되지 않은 업로드는 등록 시각으로 채운다.

포함하는 것: 마이그레이션과 백필, 업로드/수정 API의 계약 변경, NULL을 전제하던 기존
테스트 갱신, 워커의 기준일시 주입과 `due_at` 파싱 관대화, FE 안내 문구.

포함하지 않는 것: 회의 목록·검색의 정렬 규칙 변경, 회의별 타임존 저장, 요약
(`summarize_meeting`) 프롬프트 변경, 업로드 트랜잭션 실패 시 저장된 오디오를 지우는
경로(선행하는 별개 결함이며 이 작업으로 새로 생기지 않는다).

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

### COALESCE는 남기되, NULL 테스트는 갱신한다

`lenses.repository.ts:12`, `saved-utterances.repository.ts:10`,
`search.repository.ts:126`이 `COALESCE(recorded_at, created_at)` 또는
`NULLS LAST`로 정렬 키를 만든다. NOT NULL 이후 두 번째 가지는 도달 불가가 되지만
**SQL은 건드리지 않는다** — 무해하고, 정렬 키를 만지면 이 작업과 무관한 목록·검색
회귀 위험만 는다.

대신 그 가지를 검증하던 기존 테스트는 반드시 갱신한다(§8). 도달 불가가 된 분기를
검증하는 테스트를 남겨두면 "NULL을 지원한다"는 잘못된 계약이 테스트로 굳는다.

## 4. API 계약

### `POST /meetings` (업로드) — 명시적 NULL이 DEFAULT를 우회한다

현재 INSERT는 `body.recorded_at ?? null`로 **명시적 NULL**을 넘긴다
(`meetings.service.ts:87`). Postgres의 `DEFAULT`는 컬럼이 생략됐을 때만 적용되고
명시적 NULL에는 적용되지 않으므로, 마이그레이션만 넣으면 **`recorded_at`을 지정하지
않은 모든 업로드가 NOT NULL 위반으로 실패**한다. `saveFromTemp()`가 INSERT보다
먼저 끝나므로 오디오 파일도 고아로 남는다.

값 바인딩을 유지한 채 SQL에서 해결한다.

```sql
INSERT INTO meeting(id, title, original_filename, audio_key, recorded_at, status)
VALUES($1,$2,$3,$4, COALESCE($5::timestamptz, now()), 'uploaded') RETURNING *
```

`COALESCE`를 쓰는 이유는 분기 SQL(컬럼을 넣은 문장과 뺀 문장 두 벌)을 두지 않기
위해서다. 문장이 하나면 파라미터 번호가 갈라지지 않고, "미지정 = 등록 시각" 규칙이
SQL 한 곳에 남는다.

그 외 업로드 경로의 변경:

- `recorded_at`이 오면 `isIso8601`로 검증한다. **지금은 검증이 없어서** 잘못된
  문자열이 `$::timestamptz` 캐스트까지 내려가 500으로 샌다. `processing`·`speakers`와
  같은 자리(storage 저장 전)에서 검증하고, 실패하면 temp 파일을 unlink한 뒤 400.
- 빈 문자열은 `undefined`로 정규화한다. multipart 필드는 비워도 `''`로 도착하므로,
  정규화하지 않으면 `''::timestamptz`가 되어 500이 난다.
- Swagger 설명을 "녹음 시각 ISO8601 (선택)"에서 "생략하면 업로드 시각으로 기록"으로
  고친다.

### `PATCH /meetings/:id` — 깨는 변경

`recorded_at: null`이 지금은 허용되고 컬럼을 NULL로 되돌린다
(`meetings.service.ts:148`). NOT NULL 이후로는 **400**이다. 에러 메시지에서 null이
더 이상 허용되지 않음을 밝힌다. 제목(`title`)의 null 허용은 그대로다.

### date-only·offset 없는 값은 계속 허용한다

`isIso8601`(`common/iso8601.ts:7`)은 `2026-07-03`과 `2026-07-03T09:00`처럼 시각이나
오프셋이 빠진 값도 통과시키고, `meetings-management.e2e-spec.ts:56`이 date-only PATCH의
성공을 명시적으로 검증한다. 이 계약은 유지한다 — 좁히면 기존 클라이언트가 깨진다.

오프셋이 없는 값은 `timestamptz` 캐스트가 **DB 세션 타임존**(운영·테스트 모두 UTC)
으로 해석한다. 즉 `2026-07-03`은 `2026-07-03T00:00:00Z`로 저장되고, 워커가 이를
`Asia/Seoul`로 렌더하면 `2026-07-03 09:00 KST` → 날짜는 `2026-07-03`으로 같다.

**알려진 한계**: 이 일치는 KST가 UTC보다 앞서기 때문에 성립한다. `meeting_timezone`을
UTC보다 뒤진 존(예: `America/New_York`)으로 바꾸면 date-only 입력이 프롬프트에서
하루 앞 날짜로 렌더된다. 그 시점에 API가 date-only를 `meeting_timezone` 자정으로
명시 변환하도록 고쳐야 한다. 지금은 변환을 넣지 않는다 — 쓰이지 않는 경로에 대한
변환은 검증할 방법이 없다.

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

### 실행 중 PATCH — 스냅샷을 허용한다

추출이 도는 중에 `recorded_at`이 바뀌면, 워커는 읽어둔 옛 기준일로 LLM을 호출하고
그 결과를 저장한다. stale guard는 `processing_version`만 보므로 이를 막지 않는다.

**이 동작을 의도된 것으로 확정한다.** 기준일 변경은 처리 버전을 올리지 않고, 이미
저장된 `due_at`을 무효화하거나 재추출을 자동으로 걸지도 않는다. 고친 날짜를 반영하려면
사용자가 `POST /meetings/:id/lenses/extract`로 재추출한다. 대안(변경 시 진행 중 run
폐기 + 자동 재큐잉)은 `recorded_at`을 처리 버전과 같은 급의 입력으로 승격시키는
일이라, 한 필드 편집에 비해 비용이 크다.

### 프롬프트

`_render_prompt`가 맨 앞에 한 줄을 붙인다.

```
Meeting date: 2026-09-02

Speakers:
spk_1 김영재
...
```

존 이름은 프롬프트에 싣지 않는다. 날짜는 이미 `meeting_timezone`으로 환산해서
넘기므로 모델이 쓸 곳이 없고, 존 문자열을 출력만 하려고 클라이언트에 인자를 하나 더
두게 된다. 환산은 파이프라인이, 렌더는 클라이언트가 한다.

`_EXTRACTION_SYSTEM_PROMPT`에 `due_at` 규칙을 추가한다: `YYYY-MM-DD` 절대 날짜로
쓰고, 발언이 "오늘"·"다음 주 목요일" 같은 상대 표현이면 회의 날짜를 기준으로
환산하며, 환산할 수 없으면 null.

### 타임존 설정

`recorded_at`은 `timestamptz`이고 Postgres는 UTC, 워커 호스트는 KST다. 렌더링 존을
고정하지 않으면 오전 8시 KST 회의가 UTC로 전날이 되어 모든 `due_at`이 하루씩 밀린다.

워커 `Settings`에 `meeting_timezone: str = "Asia/Seoul"`을 추가한다. **기동 시점에
검증한다** — `field_validator`에서 `ZoneInfo(v)`를 시도하고 실패하면
`ValidationError`로 워커를 못 뜨게 한다(`_non_empty_prefix`와 같은 자리·같은 방식).
검증하지 않으면 오타 하나가 렌즈 job을 claim한 뒤에야 터져서, 설정 오류가 job 실패로
분류돼 나타난다.

fallback은 두지 않는다. 잘못된 존으로 조용히 UTC를 쓰면 `due_at`이 하루씩 어긋난 채
저장되고, 그건 기동 실패보다 훨씬 늦게 발견된다.

### 인스턴스 전역 타임존이라는 제약

FE는 `combineToISO`(`upload-dialog.tsx:95`)에서 사용자가 고른 날짜·시각을 **브라우저
로컬 타임존**으로 instant로 바꾼다. 워커는 그 instant를 **인스턴스 전역**
`meeting_timezone`으로 다시 날짜로 렌더한다. 둘이 다르면 사용자가 고른 날짜와
프롬프트의 `Meeting date`가 하루 다를 수 있다.

단일 조직·단일 타임존(KST) 배포를 전제로 이 제약을 받아들인다. 회의별 타임존 저장은
범위 밖이며, 여러 타임존의 사용자가 같은 인스턴스를 쓰게 되는 시점에 다시 연다.

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

### 새로 쓰는 것

| 대상 | 파일 | 케이스 |
| --- | --- | --- |
| 업로드 | `be/test/meetings.e2e-spec.ts` | 미지정 → `recorded_at`이 업로드 시각 근처이고 NOT NULL; ISO 지정 → 그 값; 빈 문자열 → 미지정과 같음; 잘못된 문자열 → 400 |
| 수정 | `be/test/meetings-management.e2e-spec.ts` | `recorded_at: null` → 400 |
| 마이그레이션 | `be/test/migration.spec.ts` | 아래 §백필 테스트 |
| 렌즈 클라이언트 | `be/worker/tests/test_lens_client.py` | 프롬프트 첫 줄에 기준일; `'2026-09-22'` → date, `'오늘'`·`'22 일'` → None이고 **항목은 보존** |
| 추출 파이프라인 | `be/worker/tests/test_extract_lenses.py` | `meeting.recorded_at`을 읽어 client에 넘긴다 |
| 설정 | `be/worker/tests/test_config.py` | `meeting_timezone` 기본값 `Asia/Seoul`; 잘못된 존 → `ValidationError` |

### 갱신해야 하는 기존 테스트

021 적용 후 아래는 그대로 두면 실패한다. 구현 전에 먼저 고친다.

| 파일 | 지금 | 바뀔 모습 |
| --- | --- | --- |
| `meetings-management.e2e-spec.ts:56` | `recorded_at: null`이 값을 지운다고 검증 | null → 400. date-only 허용 검증은 그대로 유지 |
| `lenses.e2e-spec.ts:161` | `mkMeeting('녹음 날짜 없음')`이 NULL을 INSERT | 헬퍼가 `recorded_at` 컬럼을 생략해 DEFAULT를 받게 한다. 테스트 이름과 의도를 "기준일을 지정하지 않은 회의는 등록 시각으로 정렬된다"로 고친다 |
| `saved-utterances.e2e-spec.ts:93` | 위와 같음 | 위와 같음 |
| `search.repository.spec.ts:151` | `seedMeeting('undated', null)` | 헬퍼가 컬럼을 생략. `NULLS LAST` 검증은 이름을 정렬 순서 검증으로 고친다 |

### 백필 테스트

`test/db.ts:19`의 `startTestDb()`는 항상 **모든** 마이그레이션을 적용한 DB를 준다.
따라서 "021 이전 상태에서 NULL 행을 만든다"를 그대로 재현할 수 없다.

`migration.spec.ts`가 이미 `fs`·`path`로 마이그레이션 파일을 읽는 것을 이용해, 021의
업그레이드 경로를 그 자리에서 재현한다.

1. `ALTER TABLE meeting ALTER COLUMN recorded_at DROP NOT NULL`로 제약을 푼다.
2. `recorded_at`이 NULL이고 `created_at`이 알려진 값인 행을 만든다.
3. `021_*.sql` 파일을 읽어 그대로 실행한다.
4. 그 행의 `recorded_at`이 `created_at`과 같아졌고, 컬럼이 다시 NOT NULL인지 본다.

마이그레이션 러너를 "N번까지만 적용"하도록 고치는 대안은 택하지 않는다. 테스트 하나를
위해 프로덕션 마이그레이션 경로에 분기를 넣는 값이 없다.

## 9. 롤아웃

1. `feat/meeting-recorded-at`(← `origin/dev`)에서 구현.
2. PR → `dev` 병합.
3. `feat/public-demo-deployment`에 `dev` 머지.
4. 데모 DB에서 `job_3`을 requeue해 렌즈 재추출이 통과하는지 확인.

마이그레이션은 되돌리는 스크립트를 두지 않는다. 되돌릴 일이 생기면 NOT NULL만 다시
푸는 한 줄이면 되고, 백필된 값은 되돌릴 원본이 애초에 없다(NULL이었다).
