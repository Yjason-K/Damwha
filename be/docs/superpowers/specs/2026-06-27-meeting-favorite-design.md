# Damwha 백엔드 — 회의 즐겨찾기 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-06-27 · 대상: 회의 즐겨찾기(단순 별표 토글)
> 선행: Phase 1 (Plan 1 NestJS API + Plan 2 Python 워커, 완료), Phase 2 (검색, 완료)
> 전체 스펙: `2026-06-22-damwha-ingestion-backend-design.md`

---

## 0. 이 문서의 범위

회의(`meeting`)를 사용자가 **즐겨찾기(별표) 표시**할 수 있게 한다. 자주 다시 보는 회의를 빠르게 구분하기 위한 단순 on/off 플래그다.

**범위에 포함:**
- `meeting`에 즐겨찾기 상태 컬럼 1개 추가 (`is_favorite boolean`)
- 즐겨찾기 설정/해제 API (멱등 `PUT` / `DELETE`)
- 기존 회의 목록·단건 응답에 `is_favorite` 필드 노출 (기존 `SELECT *` 경로로 자동 포함)
- e2e 테스트

**범위 밖 (비목표):**
- **백엔드 필터링·정렬** — `?favorite=true` 쿼리, 상단 고정 정렬 등은 제공하지 않는다. 목록 필터/정렬은 **프론트엔드의 몫**. 백엔드는 `is_favorite` 필드만 노출한다.
- **사용자별 즐겨찾기** — 본 시스템은 단일 사용자·자체호스팅(인증/`user` 테이블 없음). 즐겨찾기는 회의에 직접 붙는 전역 플래그이며 `user_id`가 없다.
- **즐겨찾기 메모·컬렉션/폴더** — 별표 하나만. 메모·그룹화는 다루지 않는다.
- **즐겨찾기 시각(`favorited_at`) 기록** — "언제 즐겨찾기했는가"는 현재 요구에 불필요(YAGNI). 향후 최근순 정렬이 필요해지면 `favorited_at timestamptz`로 확장 가능.

---

## 1. 데이터 모델

신규 마이그레이션 `src/database/migrations/003_meeting_favorite.sql`:

```sql
ALTER TABLE meeting ADD COLUMN is_favorite boolean NOT NULL DEFAULT false;
```

- 마이그레이션은 번호순 SQL 파일이며 `migrate.ts`가 `_migrations` 테이블로 추적한다. 적용된 파일(`001`,`002`)은 수정하지 않고 `003`을 추가한다.
- `NOT NULL DEFAULT false` — 기존 회의는 모두 즐겨찾기 해제 상태로 시작.
- 기존 `MeetingsRepository.list()`/`findById()`가 `SELECT *`를 쓰므로, 컬럼 추가만으로 **목록·단건 응답에 `is_favorite`가 자동 포함**된다. 별도 노출 코드가 필요 없다.
- 응답 필드명은 기존 snake_case 컬럼 관례(`original_filename`, `processing_version`)와 일치하는 `is_favorite`.

## 2. API

| 메서드 | 경로 | 동작 | 응답 |
|---|---|---|---|
| `PUT` | `/meetings/:id/favorite` | 즐겨찾기 설정 (`is_favorite=true`) | `200` + 갱신된 meeting 행 |
| `DELETE` | `/meetings/:id/favorite` | 즐겨찾기 해제 (`is_favorite=false`) | `200` + 갱신된 meeting 행 |

설계 근거:

- **멱등(idempotent)**: 즐겨찾기는 회의의 *하위 상태(sub-state)*다. `PUT`은 "설정된 상태", `DELETE`는 "해제된 상태"를 명시적으로 단언한다. 이미 같은 상태에서 다시 호출해도 에러 없이 동일 결과 — 중복 클릭/재시도에 안전. (toggle 방식의 비멱등 위험을 피한다.)
- **바디 없음**: 원하는 상태가 메서드로 결정되므로 요청 바디가 불필요.
- **갱신된 행 반환**: 두 엔드포인트 모두 `RETURNING *`로 갱신된 meeting 행을 돌려줘 프론트가 즉시 최신 상태를 반영한다. (`DELETE`도 `204`가 아니라 `200` + 바디 — 프론트 편의 + 두 엔드포인트 응답 일관성.)
- **상태 무관**: `uploaded`/`processing`/`done`/`failed` 어떤 처리 상태에서도 허용한다. 즐겨찾기는 처리 파이프라인과 독립적이므로 `reprocess`와 달리 status 가드를 두지 않는다.

## 3. 레이어별 변경 (repository / service / controller 3분할 준수)

- **repository** (`meetings.repository.ts`):
  - `MeetingRow` 인터페이스에 `is_favorite: boolean` 추가.
  - `setFavorite(exec, id, value): Promise<MeetingRow | null>` —
    `UPDATE meeting SET is_favorite=$2 WHERE id=$1 RETURNING *`. 0행이면 `null`(= 미존재 회의).
- **service** (`meetings.service.ts`):
  - `setFavorite(id, value)` — repository 호출 결과가 `null`이면 `NotFoundException`. 단일 `UPDATE`라 트랜잭션 불필요(`this.db.pool` 직접 사용).
- **controller** (`meetings.controller.ts`):
  - `@Put(':id/favorite')` → `service.setFavorite(id, true)`.
  - `@Delete(':id/favorite')` → `service.setFavorite(id, false)`.
  - `ParseUUIDPipe`, `@HttpCode(200)`, `@ApiOperation` Swagger 주석 (기존 엔드포인트와 동일 스타일).

## 4. 에러 처리

| 상황 | 응답 | 메커니즘 |
|---|---|---|
| 존재하지 않는 `:id` | `404` | `NotFoundException` (`setFavorite` 0행 → throw) |
| 잘못된 UUID 형식 | `400` | `ParseUUIDPipe` (기존 패턴) |

## 5. 테스트 (`test/meetings.e2e-spec.ts`에 추가)

- `PUT /meetings/:id/favorite` → 응답 `is_favorite:true`, 이후 `GET /meetings/:id`와 `GET /meetings` 목록 모두에 반영.
- `DELETE /meetings/:id/favorite` → `is_favorite:false`로 복귀.
- 멱등성: `PUT` 2회 연속 / 미설정 상태에서 `DELETE` 모두 `200` + 일관된 상태.
- 미존재 회의 id로 `PUT`/`DELETE` → `404`.
- 마이그레이션은 e2e가 fresh Testcontainers Postgres에 전체 적용하므로 새 컬럼이 자동 커버된다(별도 마이그레이션 단위 테스트 불필요).

## 6. 변경 파일 (5개)

1. `src/database/migrations/003_meeting_favorite.sql` (신규)
2. `src/meetings/meetings.repository.ts`
3. `src/meetings/meetings.service.ts`
4. `src/meetings/meetings.controller.ts`
5. `test/meetings.e2e-spec.ts`
