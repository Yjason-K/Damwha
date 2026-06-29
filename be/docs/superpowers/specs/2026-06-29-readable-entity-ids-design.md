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
- 형식: `text` PK, prefix별 정규식 **`^<prefix>_[1-9][0-9]*$`**. 시퀀스 생성값은 1부터 무패딩이라 항상 이를 만족 → 생성기와 검증이 정확히 일치(`mtg_0`·`mtg_001` 불허).

### 형식 강제 (UUID가 다시 못 들어오게)

형식을 **정의만** 하면 UUID나 `"x"`도 계속 저장된다. "UUID 제거"를 보장하려면 양쪽 경계에서 강제한다:

1. **DB CHECK** — 각 PK에 prefix별 `CHECK (id ~ '^mtg_[1-9][0-9]*$')`. 인라인 DEFAULT는 항상 이를 만족하므로, CHECK는 수동/버그성 INSERT(예: smoke의 UUID 삽입)를 즉시 거부한다.
2. **계약 검증** — job 페이로드의 id 필드를 prefix별 정규식으로 검증 (zod + pydantic). `meeting_id`→`^mtg_[1-9][0-9]*$`, `speaker_id`→`^spk_[1-9][0-9]*$`.

라우트 파이프 생략(`ParseUUIDPipe` 제거)과 이 내부 강제는 **별개** — 파이프는 HTTP 입력 편의, CHECK/계약은 데이터·경계 무결성.

## ID 생성 메커니즘

### 테이블별 시퀀스 + 인라인 DEFAULT

채번 함수를 두지 않고 각 테이블 DEFAULT에서 시퀀스를 **직접** 참조한다. prefix와 시퀀스가 테이블 정의 옆에 함께 있어, 오타(`mtgg_id_seq`)는 `CREATE TABLE` 시점(마이그레이션)에 즉시 실패한다 — 런타임이 아님.

```sql
CREATE SEQUENCE mtg_id_seq;
CREATE TABLE meeting (
  id text PRIMARY KEY DEFAULT 'mtg_' || nextval('mtg_id_seq')
       CHECK (id ~ '^mtg_[1-9][0-9]*$'),
  ...
);
ALTER SEQUENCE mtg_id_seq OWNED BY meeting.id;  -- 컬럼/테이블과 생명주기 연동
```

- `OWNED BY`로 시퀀스를 컬럼에 귀속 → 테이블 DROP 시 시퀀스도 함께 정리. 시퀀스·테이블은 기존 마이그레이션과 동일하게 `public` 스키마(별도 한정 없음).
- **워커가 INSERT하는 행**(utterance, meeting_cluster, voiceprint, utterance_embedding, job): DB DEFAULT가 자동 채번. `RETURNING id`로 id를 받는 현재 코드 그대로 → **워커 런타임 코드·jobs 코드 변경 없음** (단, 워커 smoke 스크립트는 예외 — §3 참조).
- **meeting, speaker**: API가 파일 저장 전에 id가 필요(스토리지 경로 때문). 따라서 **트랜잭션 밖**에서 `this.db.pool`로 선할당한다 — 현재 흐름(`id 생성 → 파일 저장 → withTransaction(INSERT)`)을 그대로 유지하고, 파일 I/O를 트랜잭션 안으로 끌어들이지 않는다(긴 트랜잭션 방지). `crypto.randomUUID()`를 작은 TS 헬퍼로 교체:

```ts
// prefix↔시퀀스 매핑은 리터럴(사용자 입력 아님 → 인젝션 없음), 호출부는 유니온으로 제한
const SEQ = { meeting: 'mtg', speaker: 'spk' } as const;
async function nextId(q: Queryable, t: keyof typeof SEQ): Promise<string> {
  const p = SEQ[t];
  const { rows } = await q.query(`SELECT '${p}_' || nextval('${p}_id_seq') AS id`);
  return rows[0].id;
}
// 호출: const meetingId = await nextId(this.db.pool, 'meeting');  // 파일 저장 전, 트랜잭션 밖
```

선할당값은 시퀀스에서 즉시 소비되므로, 이후 트랜잭션이 롤백돼도 그 번호는 건너뛴다(§짚어둘 점 "번호 구멍"과 동일 — 무해).

## 변경 범위

### 1. 스키마 — `001_init.sql` 직접 수정

운영 데이터 없음 → 새 마이그레이션 대신 001을 직접 수정한다(히스토리 깔끔). 일반적으로 "적용된 마이그레이션 수정 금지" 규칙의 의도적 예외 — DB는 리셋된다.

- 시퀀스 생성(001: `mtg_id_seq`, `spk_id_seq`, `utt_id_seq`, `clu_id_seq`, `vp_id_seq`, `job_id_seq`) + 각 `ALTER SEQUENCE ... OWNED BY <table>.id`.
- 001의 모든 `uuid` PK/FK 컬럼 → `text`.
- 001의 모든 `DEFAULT gen_random_uuid()` → `DEFAULT '<prefix>_' || nextval('<prefix>_id_seq')`.
- 각 PK에 prefix별 `CHECK (id ~ '^<prefix>_[1-9][0-9]*$')` 추가.
- 기존 FK 관계, `ON DELETE CASCADE/SET NULL`, status/stage 등 CHECK 제약, UNIQUE, 인덱스는 그대로.
- `vector(192)` 등 pgvector 컬럼은 무관 — 그대로.

**`002_search.sql`도 직접 수정** (마찬가지로 적용 전 리셋):
- `ue_id_seq` 시퀀스 생성 + `OWNED BY utterance_embedding.id`.
- `utterance_embedding`: `id uuid ... gen_random_uuid()` → `id text ... 'ue_' || nextval('ue_id_seq')` + `CHECK (id ~ '^ue_[1-9][0-9]*$')`; `utterance_id uuid` → `text`, `job_id uuid` → `text`.
- `ALTER TABLE job DROP/ADD CONSTRAINT` 부분은 타입 무관 — 그대로.

**`003_meeting_favorite.sql`**: `is_favorite boolean` 컬럼만 추가 — uuid 의존성 없음, 변경 없음.

### 2. API 코드 (`src/`)

- `nextId` 헬퍼 추가(위 §ID 생성 메커니즘). 위치: `database/` 또는 작은 `common/` 유틸.
- `meetings/meetings.service.ts:37`: `crypto.randomUUID()` → `await nextId(this.db.pool, 'meeting')` (파일 저장 전, 트랜잭션 밖).
- `speakers/speakers.service.ts:35`: `crypto.randomUUID()` → `await nextId(this.db.pool, 'speaker')` (동일 패턴: id → 파일 저장 → 트랜잭션).
- `crypto` import는 더 이상 안 쓰면 제거(단, `storage/upload-options.ts`의 `dw-upload-${randomUUID()}` 임시파일명은 **유지** — 엔티티 ID와 무관).
- **`ParseUUIDPipe` 전부 제거** → 평범한 `@Param('id')` 문자열. 대상: `meetings.controller.ts`, `speakers.controller.ts`, `clusters.controller.ts`. 없는 id는 서비스가 이미 `NotFoundException`(404)으로 처리하므로 형식 검증 불필요. (트레이드오프: 잘못된 형식 id가 400 대신 404가 됨 — 수용.)
- `contracts/job-payload.schema.ts`: `z.string().uuid()` → prefix별 정규식 (meeting_id ×2 → `z.string().regex(/^mtg_[1-9][0-9]*$/)`, speaker_id → `z.string().regex(/^spk_[1-9][0-9]*$/)`). `[0-9]` 명시(JS `\d`도 ASCII지만 세 경계 통일).
- `search/search.repository.ts`: `::uuid[]` 캐스팅 → `::text[]` (speakerIds, meetingIds 필터).
- Swagger `format: 'uuid'` 주석 제거(표시용, 기능 무관): `search.controller.ts`, `clusters.controller.ts`, `meetings.controller.ts`.

### 3. 워커 (Python `worker/`)

- `contracts.py`: 현재 `meeting_id: str` / `speaker_id: str`. zod와 대칭으로 prefix 패턴 추가 — `Annotated[str, StringConstraints(pattern=r"^mtg_[1-9][0-9]*$")]` (speaker는 `^spk_[1-9][0-9]*$`). **`\d` 금지** — Python `re`의 `\d`는 유니코드 숫자(`mtg_1٢` 등)를 허용해 DB·zod와 어긋남. 반드시 `[0-9]`. 동일 픽스처를 양쪽에서 검증하므로 drift 차단.
- 워커 런타임 코드(persist/identify/enroll 등)는 UUID를 생성/파싱하지 않음 — **변경 없음**.
- **smoke 스크립트는 변경 필요** (UUID를 PK로 직접 INSERT → DB CHECK가 거부하므로 깨짐):
  - `scripts/smoke_process_meeting.py:83` — `meeting_id = str(uuid.uuid4())` → 새 형식 생성(예: `nextval` 사용 `SELECT 'mtg_' || nextval('mtg_id_seq')`, 또는 id 생략하고 `INSERT ... RETURNING id`로 DB DEFAULT 사용).
  - `scripts/smoke_enroll_identify.py:121,170,230` — `spk_id`/`mid`/`alice`의 `uuid.uuid4()` 동일 처리. 117행 `_process_payload(str(uuid.uuid4()), ...)`은 모델 빌드용 더미 인자지만 pydantic 패턴(위 §3) 검증을 통과해야 하므로 `mtg_1` 등 유효 형식으로 정리.
  - 213행 주석("psycopg returns uuid columns as uuid.UUID; compare via str()")은 id가 `text`가 되면 무의미 — 비교 로직 단순화 가능.

### 4. 테스트 & 픽스처

- `test/fixtures/job-payloads/*.json`: UUID 리터럴 → 새 형식(`mtg_1`, `spk_1` 등) + `audio_key` 경로의 UUID도 동반 변경. zod/pydantic 양쪽에서 검증되므로 두 런타임 모두 통과해야 함.
- **invalid 계약 픽스처 추가**: 유니코드 숫자 케이스(예: `mtg_1٢`)를 양쪽(zod/pydantic) 모두 거부하는지 검증 — `\d` 회귀 방지. UUID 형식·`mtg_0`도 거부 케이스에 포함.
- UUID를 하드코딩하거나 `randomUUID()`로 생성하는 e2e·단위 테스트 갱신(`test/*.spec.ts`).
- 워커 테스트(`worker/tests/`)에서 UUID 형식 id를 쓰는 픽스처가 있으면 새 형식으로 갱신(있을 경우).

### 5. Living docs

- `CLAUDE.md:34` 및 `AGENTS.md:34`(CLAUDE.md 미러, 현재 untracked) — Storage path safety 불변식의 `meetings/<uuid>/...` → `meetings/<meeting_id>/...`로 갱신. 키는 여전히 슬래시 없는 단일 세그먼트라 `resolve()` 안전성 불변.
- `docs/backlog.md:19`(검색 백로그 S5) — "잘못된 날짜·UUID가 DB 오류로 전파"의 UUID 기준이 더 이상 유효치 않음(meetingIds/speakerIds는 `text`). 입력 검증 항목을 새 ID 형식(`^mtg_[1-9][0-9]*$` 등) 기준으로 갱신.
- `docs/README.md`, `worker/SMOKE.md` — grep 결과 UUID 형식 언급 없음 → 구현 중 새 ID 예시가 추가되지 않는 한 변경 불필요(구현 시 재확인).

## 검증 (성공 기준)

- `npm run migrate`가 깨끗한 DB에 성공.
- `npm test` 전체 통과 (e2e: 업로드→meeting 생성 시 id가 `mtg_<n>`, enroll 시 `spk_<n>`, job이 `job_<n>`).
- `npx tsc --noEmit -p tsconfig.build.json` 통과.
- 워커 `uv run pytest -q` 통과 (계약 픽스처 양쪽 검증).
- **형식 강제 확인**: UUID/잘못된 형식을 PK로 INSERT 시 DB CHECK가 거부(테스트로 검증). 계약에 UUID 형식 id 전달 시 zod/pydantic이 거부.
- 수동 확인: 업로드 후 `meeting`, `job`, 워커 처리 후 `utterance`/`meeting_cluster` 행의 id가 모두 새 형식.
- (실모델 환경) `smoke_process_meeting.py` / `smoke_enroll_identify.py`가 새 형식으로 정상 동작.

## 짚어둘 점 / 트레이드오프

- **번호 구멍**: 시퀀스는 실패 INSERT/롤백 시 되돌아가지 않음 → `mtg_3` 다음 `mtg_5` 가능. 개인용엔 무해.
- **열거 가능성**: 순번이라 다음 id 추측 가능. 단일 사용자 self-hosted(인증·외부 노출 없음)라 비위협.
- **ParseUUIDPipe 제거**: 잘못된 형식 id가 400 대신 404. 가벼운 정규식 파이프(`^[a-z]+_[1-9][0-9]*$`)를 원하면 추가 가능하나, 기본은 단순하게 간다(simplicity-first).

## 비목표

- 데이터 마이그레이션(운영 데이터 없음).
- 비순차/랜덤 suffix ID(Stripe `mtg_a3f9k2`식) — 읽기 쉬운 순번이 목표.
- 라우트 파라미터 형식 검증 파이프(필요 시 후속).
