# 읽기 쉬운 엔티티 ID 설계 (UUID → `prefix_n`)

**날짜**: 2026-06-29
**상태**: 설계 승인됨, 구현 대기

## 배경 / 문제

모든 테이블의 PK가 `uuid` (`gen_random_uuid()`)이고 FK로 사방에 얽혀 있다. UUID는 코드 밖으로도 새어 나간다: 스토리지 경로(`meetings/<uuid>/...`), job 페이로드 계약(zod + pydantic), 워커. 로그/디버깅/DB 작업/URL·API 응답 전반에서 `ca8e8f66-6e2b-4c4f-8d0b-7d432a7a6aca` 같은 값이 사람이 식별·대화하기 어렵다.

목표: 시스템 전반에서 UUID를 걷어내고 `mtg_42`처럼 읽기 쉬운 순번 ID로 교체한다.

전제: **개인 self-hosted, 운영 데이터 없음 → DB 리셋 가능.** 따라서 데이터 마이그레이션(매핑 테이블, FK 재작성, 디스크 폴더 rename)은 불필요하다.

## ID 형식

| 테이블 | prefix | 예시 |
|---|---|---|
| meeting | `mtg` | `mtg_42` |
| speaker | `spk` | `spk_3` |
| utterance | `utt` | `utt_1820` |
| meeting_cluster | `clu` | `clu_5` |
| voiceprint | `vp` | `vp_11` |
| utterance_embedding | `ue` | `ue_1820` |
| job | `job` | `job_8` |

- **숫자 패딩 없음**: `mtg_1`, `mtg_42`, `mtg_137`.
- **축약 prefix (Stripe식)**.
- 형식: `text` PK, `^[a-z]+_\d+$`.

## ID 생성 메커니즘

### 채번 SQL 함수 (단일 출처)

prefix→시퀀스 매핑을 한 곳에만 둔다. prefix 약어가 곧 시퀀스 이름 규칙(`mtg` → `mtg_id_seq`).

```sql
CREATE FUNCTION new_id(prefix text) RETURNS text
LANGUAGE sql AS $$
  SELECT prefix || '_' || nextval((prefix || '_id_seq')::regclass)::text;
$$;
```

### 테이블별 시퀀스 + DEFAULT

```sql
CREATE SEQUENCE mtg_id_seq;
CREATE TABLE meeting (
  id text PRIMARY KEY DEFAULT new_id('mtg'),
  ...
);
```

- **워커가 INSERT하는 행**(utterance, meeting_cluster, voiceprint, utterance_embedding, job): DB DEFAULT가 자동 채번. `RETURNING id`로 id를 받는 현재 코드 그대로 → **워커·jobs 코드 변경 없음**.
- **meeting, speaker**: API가 파일 저장 전에 id가 필요(스토리지 경로 때문). `crypto.randomUUID()`를 `SELECT new_id('mtg')` / `SELECT new_id('spk')` 호출로 교체. 나머지 흐름 동일.

## 변경 범위

### 1. 스키마 — `001_init.sql` 직접 수정

운영 데이터 없음 → 새 마이그레이션 대신 001을 직접 수정한다(히스토리 깔끔). 일반적으로 "적용된 마이그레이션 수정 금지" 규칙의 의도적 예외 — DB는 리셋된다.

- `new_id()` 함수 생성.
- 시퀀스 생성(001: `mtg_id_seq`, `spk_id_seq`, `utt_id_seq`, `clu_id_seq`, `vp_id_seq`, `job_id_seq`).
- 001의 모든 `uuid` PK/FK 컬럼 → `text`.
- 001의 모든 `DEFAULT gen_random_uuid()` → `DEFAULT new_id('<prefix>')`.
- FK 관계, `ON DELETE CASCADE/SET NULL`, CHECK 제약, UNIQUE, 인덱스는 그대로.
- `vector(192)` 등 pgvector 컬럼은 무관 — 그대로.

**`002_search.sql`도 직접 수정** (마찬가지로 적용 전 리셋):
- `ue_id_seq` 시퀀스 생성.
- `utterance_embedding`: `id uuid ... gen_random_uuid()` → `id text ... new_id('ue')`; `utterance_id uuid` → `text`, `job_id uuid` → `text`.
- `ALTER TABLE job DROP/ADD CONSTRAINT` 부분은 타입 무관 — 그대로.

**`003_meeting_favorite.sql`**: `is_favorite boolean` 컬럼만 추가 — uuid 의존성 없음, 변경 없음.

### 2. API 코드 (`src/`)

- `meetings/meetings.service.ts`: `crypto.randomUUID()` → `new_id('mtg')` 헬퍼 호출.
- `speakers/speakers.service.ts`: `crypto.randomUUID()` → `new_id('spk')` 헬퍼 호출.
- `crypto` import는 더 이상 안 쓰면 제거(단, `storage/upload-options.ts`의 `dw-upload-${randomUUID()}` 임시파일명은 **유지** — 엔티티 ID와 무관).
- **`ParseUUIDPipe` 전부 제거** → 평범한 `@Param('id')` 문자열. 대상: `meetings.controller.ts`, `speakers.controller.ts`, `clusters.controller.ts`. 없는 id는 서비스가 이미 `NotFoundException`(404)으로 처리하므로 형식 검증 불필요. (트레이드오프: 잘못된 형식 id가 400 대신 404가 됨 — 수용.)
- `contracts/job-payload.schema.ts`: `z.string().uuid()` → `z.string().min(1)` (3곳: meeting_id ×2, speaker_id).
- `search/search.repository.ts`: `::uuid[]` 캐스팅 → `::text[]` (speakerIds, meetingIds 필터).
- Swagger `format: 'uuid'` 주석 제거(표시용, 기능 무관): `search.controller.ts`, `clusters.controller.ts`, `meetings.controller.ts`.

### 3. 워커 (Python `worker/`)

- `contracts.py`는 이미 `meeting_id: str` / `speaker_id: str` — **변경 없음**.
- 워커는 코드에서 UUID를 생성/파싱하지 않음 — **변경 없음**.

### 4. 테스트 & 픽스처

- `test/fixtures/job-payloads/*.json`: UUID 리터럴 → 새 형식(`mtg_1`, `spk_1` 등). zod/pydantic 양쪽에서 검증되므로 두 런타임 모두 통과해야 함.
- UUID를 하드코딩하거나 `randomUUID()`로 생성하는 e2e·단위 테스트 갱신(`test/*.spec.ts`).
- 워커 테스트(`worker/tests/`)에서 UUID 형식 id를 쓰는 픽스처가 있으면 새 형식으로 갱신(있을 경우).

## 검증 (성공 기준)

- `npm run migrate`가 깨끗한 DB에 성공.
- `npm test` 전체 통과 (e2e: 업로드→meeting 생성 시 id가 `mtg_<n>`, enroll 시 `spk_<n>`, job이 `job_<n>`).
- `npx tsc --noEmit -p tsconfig.build.json` 통과.
- 워커 `uv run pytest -q` 통과 (계약 픽스처 양쪽 검증).
- 수동 확인: 업로드 후 `meeting`, `job`, 워커 처리 후 `utterance`/`meeting_cluster` 행의 id가 모두 새 형식.

## 짚어둘 점 / 트레이드오프

- **번호 구멍**: 시퀀스는 실패 INSERT/롤백 시 되돌아가지 않음 → `mtg_3` 다음 `mtg_5` 가능. 개인용엔 무해.
- **열거 가능성**: 순번이라 다음 id 추측 가능. 단일 사용자 self-hosted(인증·외부 노출 없음)라 비위협.
- **ParseUUIDPipe 제거**: 잘못된 형식 id가 400 대신 404. 가벼운 정규식 파이프(`^[a-z]+_\d+$`)를 원하면 추가 가능하나, 기본은 단순하게 간다(simplicity-first).

## 비목표

- 데이터 마이그레이션(운영 데이터 없음).
- 비순차/랜덤 suffix ID(Stripe `mtg_a3f9k2`식) — 읽기 쉬운 순번이 목표.
- 라우트 파라미터 형식 검증 파이프(필요 시 후속).
