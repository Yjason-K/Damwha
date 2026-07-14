# 렌즈 기반 서비스 설계

> 상태: 승인됨 · 작성일: 2026-07-14 · 상위 로드맵: `2026-07-14-lens-platform-roadmap-design.md` 작업 1

## 1. 목적과 범위

액션아이템, 결정사항, 약속·책임 렌즈를 영속하고 수정·조회할 백엔드 기반을 만든다.
이 작업은 DB 스키마, 도메인 서비스, 병합 규칙, HTTP API와 테스트만 포함한다.

다음은 제외한다.

- 로컬 LLM 호출과 `extract_lenses` 작업 큐잉(작업 2)
- 전역 대시보드와 회의 인사이트 UI(작업 3)
- 주제·키워드 저장 검색(작업 4)

## 2. 데이터 모델

### `lens_item`

회의 하나에 귀속되는 렌즈 항목이다.

| 필드 | 의미 |
|---|---|
| `id` | `lens_<n>` 형식의 식별자 |
| `meeting_id` | 소속 회의, 삭제 시 함께 삭제 |
| `kind` | `action`, `decision`, `promise` |
| `text` | 사용자에게 보여 줄 항목 본문 |
| `assignee_speaker_id` | 담당 화자. 없을 수 있음 |
| `due_at` | ISO 날짜. 없을 수 있음 |
| `completion_status` | `open` 또는 `done` |
| `source` | `ai`, `user`, `edited` |
| `user_modified` | 사용자가 본문·담당자·기한·근거·완료 상태를 변경했는지 |
| `lifecycle_status` | `active` 또는 `archived` |
| `created_at`, `updated_at` | 감사와 정렬용 시각 |

`assignee_speaker_id`는 해당 회의에서 한 번 이상 발화한 화자만 허용한다. 항목 본문은
공백 제거 후 1–1,000자여야 한다. `due_at`은 유효한 `YYYY-MM-DD` 날짜여야 한다.

### `lens_evidence`

렌즈 항목과 발언을 연결한다. `(lens_item_id, utterance_id)`는 유일하며 관계는
`primary` 또는 `supporting`이다. 연결 발언은 항목의 `meeting_id`와 같은 회의에
속해야 한다. AI 항목은 활성 상태일 때 `primary` 근거를 정확히 하나 이상 가져야
한다. 수동 항목은 근거 없이 생성할 수 있다.

### `lens_extraction_run`

작업 2의 워커가 사용할 실행 이력 테이블이다. 회의와 처리 버전, 상태
(`queued|running|done|failed`), 모델 식별자, 오류 JSON, 생성·완료 시각을 기록한다.
이 작업에서는 이 테이블을 만들기만 하며, 작업 생성·상태 변경 API는 제공하지 않는다.

## 3. 재추출 병합 정책

작업 2가 새 AI 결과를 저장할 때 아래 규칙을 사용한다.

1. 기존의 `source=ai`, `user_modified=false`, `lifecycle_status=active` 항목만 자동
   갱신 또는 보관 대상으로 삼는다.
2. 같은 회의·유형이고 새 결과의 primary 근거 발언이 같은 기존 항목은 같은 항목으로
   간주해 AI가 제공한 본문·담당자·기한·근거로 갱신한다.
3. 위 기준으로 대응하지 못한 기존 미수정 AI 항목은 `archived`로 전환한다. 삭제하지
   않는다.
4. `source=user`, `source=edited`, `user_modified=true`, 또는 `completion_status=done`인
   항목은 자동으로 갱신·보관·삭제하지 않는다.
5. 회의 재처리로 기존 근거 발언이 사라져도 보존 대상 항목은 유지한다. 근거 상태의
   화면 표시는 작업 3의 책임이다.

## 4. HTTP API

모든 응답은 snake_case를 사용하며 기존 NestJS meeting API의 오류 형식을 따른다.

### 조회

- `GET /lenses`
  - 선택 필터: `kind`, `meeting_id`, `speaker_id`, `date_from`, `date_to`,
    `completion_status`, `lifecycle_status`, `limit`, `cursor`
  - 기본값: `completion_status=open`, `lifecycle_status=active`, 최신 `updated_at` 순.
  - 응답에는 회의 제목·녹음 시각, 담당 화자, 근거 발언의 ID·시작 시각·본문을 포함한다.
- `GET /meetings/:id/lenses`
  - 해당 회의의 활성 항목을 유형과 최신 갱신 시각으로 정렬해 반환한다.

### 변경

- `POST /lenses`: 수동 항목을 생성한다. 기본 `source=user`, `user_modified=true`,
  `completion_status=open`, `lifecycle_status=active`다.
- `PATCH /lenses/:id`: 본문·담당자·기한·유형을 변경한다. 변경 후
  `source=edited`, `user_modified=true`로 전환한다.
- `DELETE /lenses/:id`: 사용자가 만든/편집한 항목을 명시적으로 제거한다. 항목과 근거
  연결을 함께 삭제한다.
- `POST /lenses/:id/complete`, `POST /lenses/:id/reopen`: 완료 상태를 바꾸고
  `user_modified=true`로 설정한다.
- `POST /lenses/:id/evidence`: 같은 회의의 발언을 `primary` 또는 `supporting` 근거로
  연결하고 `user_modified=true`로 설정한다.
- `DELETE /lenses/:id/evidence/:utteranceId`: 근거 연결을 제거하고
  `user_modified=true`로 설정한다. 활성 AI 항목의 마지막 primary 근거 제거는 409으로
  거부한다.

`POST /meetings/:id/lenses/extract`는 작업 2에서 추가한다. 작업 1에는 추출 요청 API나
워크플로를 노출하지 않는다.

## 5. 오류와 정합성

- 존재하지 않는 회의·항목·발언·화자는 404를 반환한다.
- 다른 회의의 발언 또는 해당 회의에서 발화하지 않은 담당 화자를 연결하면 400을
  반환한다.
- 유효하지 않은 enum, 날짜, 본문 길이, cursor 또는 페이지 크기는 400을 반환한다.
- AI 항목의 마지막 primary 근거를 제거하려는 요청은 409을 반환한다.
- 항목 변경과 근거 변경은 트랜잭션으로 실행한다.

## 6. 검증 기준

- 마이그레이션이 빈 DB와 기존 데이터가 있는 DB에서 적용된다.
- 수동 생성·수정·삭제·완료·재개·근거 연결 API가 E2E에서 검증된다.
- AI 항목의 primary 근거 제약과 교차 회의 근거 거부를 검증한다.
- 병합 단위 테스트는 미수정 AI 갱신·보관, 사용자 생성·수정·완료 항목 보존을 검증한다.
- `GET /lenses`는 모든 필터, 기본값, 안정적인 cursor 페이지네이션을 검증한다.
