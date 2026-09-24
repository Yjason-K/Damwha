# Electron Phase 6b-3 — `attempts` 분리 (구현 스펙)

작성일: 2026-09-24
브랜치: `feat/electron-migration-phase-6b-attempts`
선행: Phase 6b-1 병합 (PR #30, `dev` = `24331f6`). 발행된 최신 릴리스 `desktop-v0.3.1`.

## 1. 목표

**강제 종료·크래시로 회수된 실행이 일시 실패 재시도 예산을 먹지 않게 한다. 그러면서도 앱을 죽이는
job은 여전히 유한한 횟수 안에 `failed`로 끝나게 한다.**

지금은 `job.attempts` 한 컬럼이 두 사실을 함께 센다. claim이 +1 하고 정상 종료(`requeue_for_shutdown`)
만 −1 하므로, SIGKILL·크래시·전원 차단·30분 잠금 만료로 회수된 실행이 TRANSIENT 재시도 5회 중 한
회를 먹는다(Phase 5 스펙 §2.2, `desktop/CLAUDE.md` "재시도" 절). 셈을 하나 더 두고 한도도 따로 둔다.

이 Phase의 마이그레이션 `026`은 **v1(0.3.1) → v2 업그레이드 검증의 실물 시험체**다(로드맵 Phase 6b,
2026-09-20 분할 문단). 0.3.1과 현재 `dev`는 둘 다 `025`에서 끝나므로, `026`이 없으면 0.3.1에서
올릴 때 마이그레이션 게이트가 백업을 뜨지 않고(`migration-gate.ts:171`) 6b-2가 시험할 대상도 없다.

## 2. 범위

### 2.1 포함

- 마이그레이션 `026_job_interruptions.sql` — `interruptions`·`max_interruptions` 컬럼.
- 회수 CTE 세 벌이 `interruptions`를 올리고 그것으로 상한을 판정한다.
- worker의 재시도 판정·백오프가 실패 수(`attempts − interruptions`)를 쓴다.
- 회의 상태 API의 `retry` 객체와 처리 배너 문구.
- 두 언어 회수 판정의 공유 fixture.
- packaged 업그레이드 실측 — 발행된 0.3.1에서 새 빌드로 덮어쓰기.

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| 업데이트 전 백업·복원 UI·수동 복원 절차·실패 복구 정책 | 6b의 다른 덩어리. 이 Phase의 `026`이 그 시험 대상이 된다 | **6b-2** (이 Phase 병합 뒤 새 브랜치) |
| `attempts`의 의미 자체를 "실패 수"로 바꾸기 (claim이 올리지 않게) | 의미는 가장 깨끗하나 claim 두 벌·shutdown·기존 행 재해석까지 바뀐다. 2026-09-24 결정(§11.2) | 범위 밖 |
| `max_attempts=3`으로 남은 `025` 이전 행 고치기 | `025`와 같은 규칙 — 기존 행은 고치지 않는다 | 범위 밖 |
| `JobsRepository.claim`(TS) 변경 | 운영 경로가 부르지 않는다(claim은 worker `queue.py`만) — 테스트 헬퍼다. 셈 규칙이 claim을 바꾸지 않으므로 손대지 않는다 | 범위 밖 |

## 3. 선행 사실

각 항목은 2026-09-24 `dev`(`24331f6`)의 코드에서 확인했다.

1. **claim이 `attempts`를 +1 한다** — worker `db/queue.py:16`. API의 `JobsRepository.claim`
   (`jobs.repository.ts:32`)도 같은 식이나 운영 경로에서 부르지 않는다(호출자는 `dispatch.py:114`·
   `__main__.py:55`의 worker `db.claim`뿐).
2. **정상 종료는 되돌린다** — `requeue_for_shutdown`(`queue.py:96`)이 `greatest(attempts − 1, 0)`.
3. **회수 CTE는 세 벌이다.**
   - `JobsRepository.reclaimOrphaned`(`jobs.repository.ts:125`) — API 기동 1회, 앞 실행 `desktop-*` 행.
   - `JobsRepository.reapStale`(`jobs.repository.ts:214`) — API 5분 크론, `locked_at` 30분 초과.
   - worker `_REAP_SQL`(`queue.py:111`) — 선택자만 다른 `reap_stale`(`:184`)·`reap_own_orphans`(`:192`).

   셋 다 비-live는 `attempts < max_attempts`면 `queued`, 아니면 `failed`로 닫고 딸린 행
   (`lens_extraction_run`·`meeting_summary`·`meeting`·`speaker`)까지 닫는다. live는 언제나 `failed`.
   **`attempts`를 되돌리지 않는다**(Phase 5 스펙 §4.1 — 되돌리면 앱을 죽이는 job이 상한에 영영
   닿지 못한다).
4. **재시도 판정은 `dispatch.py:44`** — `TRANSIENT and attempts < max_attempts`. `attempts`는 claim이
   이미 올린 값이라 "지금 실행을 포함한 시작 횟수"다.
5. **백오프는 `requeue`(`queue.py:79`)** — `least(30 * power(2, attempts − 1), 900)`초.
6. **관측** — `findStatus`(`meetings.repository.ts:123`)가 `retry: {attempts, max_attempts,
   next_attempt_at, error}`를 주고, `fe/src/pages/meeting.tsx:140`이 `재시도 대기 · {attempts}/{max_attempts}회차 ·
   약 N분 뒤 · 마지막 오류: X`로 그린다. `next_attempt_at`이 없거나 지났으면 이 문구는 뜨지 않는다.
   회수는 `next_attempt_at=NULL`로 돌려놓으므로 **회수된 job에는 이 문구가 뜨지 않는다.**
7. **마이그레이션 게이트** — 적용할 것이 있고 이미 적용된 것이 하나라도 있으면
   `<userData>/backups/<stamp>-before-<첫 pending>.dump`를 뜬 뒤 적용한다(`migration-gate.ts:171`).
   러너는 파일마다 트랜잭션이다(`be/src/database/migrate.ts`). DB에 모르는 마이그레이션이 있으면
   기동을 거부한다(`migration-gate.ts:168`, `migrationUnknown`).
8. **공유 fixture 선례** — `be/test/fixtures/job-payloads/`를 TS(`contract-fixtures.spec.ts`)와
   Python(`tests/test_contracts*.py`, `parents[2] / "test" / "fixtures"`)이 함께 읽는다.

## 4. 셈 규칙

### 4.1 두 셈과 파생값

| 값 | 뜻 | 누가 바꾸나 |
| --- | --- | --- |
| `attempts` | 시작한 실행 수 (정상 종료로 반납한 것은 뺀다) | claim +1, `requeue_for_shutdown` −1 — **바뀌지 않는다** |
| `interruptions` (신설) | 실행이 끝나기 전에 주인을 잃고 회수된 횟수 | 회수 CTE 세 벌만 +1 |
| `max_interruptions` (신설) | 그 한도. 기본 3 | 컬럼 DEFAULT |
| **실패 수** = `attempts − interruptions` | job이 스스로 낸 실패 수. `running`이면 지금 실행을 포함한다 | 파생값 — 저장하지 않는다 |

**불변식: `0 ≤ interruptions ≤ attempts`.** 회수는 `running` 행만 보고, `running`이 된 것은 claim이
+1 했기 때문이며, 그 +1을 되돌리는 것은 같은 실행의 정상 종료뿐이다(그 실행은 회수되지 않았다).
따라서 실패 수는 음수가 되지 않는다. DB 제약으로 걸지 않고 테스트로 고정한다(§8.1) — 회수 CTE
한가운데서 제약 위반이 나면 기동 회수 전체가 실패하고, 그 실패는 로그만 남기고 삼켜진다
(Phase 5 스펙 §4.5).

### 4.2 회수 (세 벌 모두)

비-live 행:

```
new_interruptions = interruptions + 1
new_interruptions <  max_interruptions  →  status='queued',  interruptions=new_interruptions
new_interruptions >= max_interruptions  →  status='failed',  interruptions=new_interruptions  (+ 딸린 행)
```

- **`attempts`는 판정에 들어가지 않는다.** 실행 중인 job은 실패 예산이 남아 있다 — 다 썼다면
  dispatch가 이미 `failed`로 닫았다(§3-4). 그래서 `attempts = max_attempts`로 실행 중이던 행도
  중단 예산이 남으면 `queued`로 간다. **이것이 이 Phase가 바꾸는 동작이다.**
- `failed`로 닫을 때도 `interruptions`를 올린다 — "세 번째 중단에서 멈췄다"가 행에 남는다.
- live 행은 지금처럼 언제나 `failed`. `interruptions`는 올린다(기록 일관성). 판정에는 쓰지 않는다.
- 딸린 행 정리, 오류 코드(`app_restarted`·`stale_worker`), 잠금(`FOR UPDATE SKIP LOCKED`), 선택자는
  바뀌지 않는다.
- `reclaimOrphaned`의 비-live 소진 분기 메시지 `'… — no attempts left'`를
  `'the app was interrupted N times while running this job'` 꼴로 바꾼다(N은 `new_interruptions`).
  반환값 이름 `failedSpent`는 `failedInterrupted`로 바꾸고 `ReaperService`의 로그도 따라간다.

**결과.** `max_interruptions=3`이면 강제 종료 두 번까지는 `queued`, 세 번째에 `failed`다. ⌘Q는
`requeue_for_shutdown`을 타므로 어느 셈도 올리지 않는다. 두 한도는 독립이고 먼저 닿는 쪽이 job을 끝낸다.

### 4.3 재시도 판정·백오프 (worker)

- `dispatch.py:44`: `retry = TRANSIENT and (attempts − interruptions) < max_attempts`.
  같은 자리의 로그 `attempt=%s/%s`도 실패 수 기준으로 찍고 `interruptions=%s`를 덧붙인다.
- `requeue`: `least(30 * power(2, attempts − interruptions − 1), 900)`초. 크래시가 백오프를 부풀리지
  않는다 — 첫 TRANSIENT 실패는 앞선 중단 횟수와 무관하게 30초다.
- 파생식은 Python에 한 함수(`failures(job)`)로 두고 두 호출처가 그것을 쓴다. SQL `requeue`는 같은
  식을 인라인하되 §8.1의 격자가 두 식의 일치를 고정한다.

### 4.4 마이그레이션 `026_job_interruptions.sql`

```sql
ALTER TABLE job
  ADD COLUMN interruptions     int NOT NULL DEFAULT 0 CHECK (interruptions >= 0),
  ADD COLUMN max_interruptions int NOT NULL DEFAULT 3 CHECK (max_interruptions >= 1);
```

- PG16은 상수 DEFAULT 컬럼 추가에 테이블을 다시 쓰지 않는다.
- **기존 행의 `attempts`는 고치지 않는다.** 0.3.1에서 넘어온 행은 `interruptions=0`이라 이미 쓴
  시도를 전부 실패로 안고 간다 — 재시도를 더 얹지 않는 보수적 해석이다. 그 행들이 과거에 크래시로
  먹은 시도는 되돌려 주지 않는다(구분할 정보가 없다).
- `026` 적용 시점에 `running`인 행은 없다 — 게이트가 API·worker 스폰 **전에** 돈다. 앞 실행이 남긴
  `running`은 적용 뒤 기동 회수가 새 규칙으로 처리한다(첫 `interruptions=1`).
- 주석에 이 문단의 요지(기존 행 규칙·불변식)를 남긴다. `025`의 주석 형식을 따른다.

## 5. 관측 — API·화면

### 5.1 `findStatus`

`retry` 객체의 `attempts`를 **`failures`로 바꾸고** `interruptions`를 더한다.

```sql
jsonb_build_object(
  'failures',        j.attempts - j.interruptions,
  'max_attempts',    j.max_attempts,
  'interruptions',   j.interruptions,
  'next_attempt_at', j.next_attempt_at,
  'error',           j.error)
```

같은 이름의 뜻을 몰래 바꾸지 않으려고 이름째 바꾼다. 소비자는 `fe` 하나이고 같은 앱 번들에 함께
실리므로 판이 섞이지 않는다. `JobRow`(`jobs.types.ts`)에 두 필드를 더한다.

### 5.2 처리 배너 (`meeting.tsx`)

```
재시도 대기 · {failures}/{max_attempts}회차 · 약 N분 뒤[ · 마지막 오류: X][ · 중단 {interruptions}회]
```

- `· 중단 N회`는 `interruptions > 0`일 때만. 문구가 뜨는 조건(`next_attempt_at`이 미래)은 바꾸지 않는다
  — 회수 직후의 job은 곧바로 claim되므로 지금처럼 이 문구 없이 "대기 중"이다(§3-6).
- `RetryStatus`(`fe/src/features/meeting/api/types.ts:188`)를 `failures`·`interruptions`로 바꾼다.

## 6. 경계 사례

| 상황 | 기대 |
| --- | --- |
| TRANSIENT 2회 뒤 강제 종료 1회, 다시 TRANSIENT | 실패 수 3 < 5라 requeue, 백오프 **120초**(옛 식 240초) — 표 아래 주 |
| `attempts=5, max_attempts=5, interruptions=0`으로 `running` 중 강제 종료 (0.3.1 행 포함) | `queued`, `interruptions=1`. 다음 실행의 TRANSIENT 실패는 실패 수 5 ≥ 5라 재시도 없이 `failed` |
| 강제 종료 3회 | 1·2회차 `queued`, 3회차 `failed`(`app_restarted`), 회의·요약·렌즈 run·화자도 `failed` |
| 30분 잠금 만료(worker hang) | 같은 셈 — `interruptions`가 오른다. 코드는 `stale_worker` |
| ⌘Q 정상 종료 | `attempts` −1, `interruptions` 그대로 |
| 터미널 `pnpm worker`(`worker-1`)의 job | 기동 회수는 건드리지 않는다(선택자 불변). 30분 reaper는 같은 셈 규칙 |
| `live_session` 회수 | 언제나 `failed`. `interruptions`는 +1 |
| `max_attempts=3`으로 남은 `025` 이전 행 | 실패 한도 3 그대로, 중단 한도는 기본 3 |

주: 백오프 지수는 "지금 실행을 포함한 실패 수 − 1"이다. TRANSIENT 2회 → 강제 종료 → 재claim 뒤
TRANSIENT면 `attempts=4, interruptions=1`, 실패 수 3, 백오프 `30×2^2 = 120`초. 옛 식은
`30×2^3 = 240`초였다.

## 7. 알려진 한계

- **0.3.1에서 넘어온 행의 과거 크래시는 실패로 남는다**(§4.4). 업그레이드 시점에 재시도 대기 중인
  job만 해당하고, 새로 enqueue되는 job에는 없다.
- **`max_interruptions`는 컬럼이지만 바꾸는 경로가 없다.** `max_attempts`와 같다 — enqueue가 넘기지
  않으면 DEFAULT다. live는 판정에 쓰지 않으므로 넘길 이유가 없다.
- **중단의 원인을 가리지 않는다.** 사용자가 Activity Monitor로 앱을 죽인 것과 job이 worker를 segfault
  시킨 것을 같게 센다. 가리려면 종료 사유를 기록할 주체가 필요한데, 죽은 프로세스는 기록하지 못한다.

## 8. 테스트·검증

### 8.1 자동

**be** (`pnpm --filter damwha-be exec jest <path>` — 실 Postgres)

- `migration.spec`·`migrate-status.spec`: `026` 적용 뒤 두 컬럼의 DEFAULT·NOT NULL·CHECK, 기존 행
  `attempts` 보존.
- `reclaim.spec`·`reaper.spec` 갱신 — 기존 "attempts 소진 → failed" 케이스는 "중단 소진 → failed"로
  바꾸고, 새 케이스:
  - **`attempts = max_attempts`, `interruptions = 0`인 `running` 행이 `queued`로, `interruptions=1`.**
  - `interruptions = 2`(기본 한도 3)면 `failed`와 딸린 행 넷.
  - `failed`로 닫을 때도 `interruptions`가 오른다. `attempts`는 어느 분기에서도 그대로.
  - live 행: 언제나 `failed`, `interruptions` +1.
- `status-retry.spec`: `failures = attempts − interruptions`, `interruptions` 필드.
- `reclaim-races.spec`: 기존 경합 시나리오가 새 컬럼으로도 하나로 수렴하는지 — 필드 단언만 더한다.

**worker** (`pnpm worker:test` — 실 Postgres)

- `test_db_lifecycle.py`: `reap_stale`·`reap_own_orphans`의 같은 케이스, `requeue` 백오프가
  `interruptions`를 빼는지(`attempts=3, interruptions=1` → 60초), `requeue_for_shutdown`이
  `interruptions`를 건드리지 않는지.
- `dispatch` 재시도 판정: `attempts=5, max_attempts=5, interruptions=1`의 TRANSIENT는 **requeue**
  (옛 판정은 fail).
- 불변식: 모든 전이 뒤 `0 ≤ interruptions ≤ attempts`.

**두 언어 일치 — 공유 fixture** `be/test/fixtures/job-reap/grid.json`

격자 `(type ∈ {process_meeting, live_session}, attempts, max_attempts, interruptions, max_interruptions)`
→ 기대 `(status, interruptions)`. 경계값(한도 −1·한도·0)을 포함한다. TS(`reclaimOrphaned`·`reapStale`)와
Python(`reap_stale`·`reap_own_orphans`)이 **같은 파일**을 읽어 각 행을 DB에 넣고 회수한 뒤 결과를
단언한다. 선택자는 각 테스트가 맞춘다(시간·소유자). 같은 파일에 `failures`·백오프 기대값 격자도 두어
`requeue`(SQL)와 `failures()`(Python)가 같은 식인지 고정한다.

**fe** (`pnpm --filter damwha-fe exec vitest run src/pages/meeting.test.tsx`)

- 배너가 `failures/max_attempts`를 쓴다(`attempts`가 아니라).
- `interruptions > 0`일 때만 `· 중단 N회`.

**변이** — 아래를 하나씩 넣어 빨간불을 기록한다(동치 변이는 사유 기록).

| # | 변이 | 잡아야 할 테스트 |
| --- | --- | --- |
| M1 | 회수 판정 `<` → `<=` (TS reclaim) | grid |
| M2 | 같은 것 (TS reapStale) | grid |
| M3 | 같은 것 (Python `_REAP_SQL`) | grid |
| M4 | 회수에서 `interruptions + 1` 누락 (각 벌) | grid · reclaim/reaper |
| M5 | 회수 판정을 옛 `attempts < max_attempts`로 되돌림 (각 벌) | `attempts=max` 케이스 |
| M6 | `failed` 분기에서 `interruptions` 증가 누락 | grid |
| M7 | dispatch가 `attempts < max_attempts`로 되돌림 | dispatch |
| M8 | `requeue` 백오프에서 `− interruptions` 누락 | grid(backoff) · lifecycle |
| M9 | `requeue_for_shutdown`이 `interruptions`도 −1 | lifecycle |
| M10 | `findStatus`가 `attempts`를 `failures`로 그대로 냄 | status-retry |
| M11 | 배너가 `interruptions` 조건 없이 `중단 0회`를 붙임 | meeting.test |
| M12 | `026`의 DEFAULT 3 → 5 | migration.spec · grid(기본 한도 행) |

### 8.2 packaged 실측

**사전.** dev·packaged 인스턴스가 모두 꺼졌는지 확인한다
(`pgrep -fl "Damwha.app/Contents/MacOS|Electron.app/Contents/MacOS/Electron|electron/cli.js"`).
userData(`~/Library/Application Support/Damwha`)를 dev와 공유하므로 **`data/`를 통째로
`ditto data data.pre-6b3-backup`** 한다(앱이 꺼진 상태에서). 새 빌드는 `pnpm desktop package:desktop`
뒤 `desktop/out/mac-arm64/Damwha.app`을 버전 붙은 이름으로 복사해 둔다.

1. **업그레이드 보존 (C1).** 발행된 `desktop-v0.3.1` DMG로 `/Applications/Damwha.app`을 설치해 띄운다.
   회의 하나를 업로드해 `done`까지 보내고, 설정 하나를 바꾸고(처리 설정 화면), 가능하면 TRANSIENT로
   재시도 대기 중인 job을 하나 남긴다. 종료. psql로 전 스냅샷(회의·발화·요약 수, `app_setting` 전체,
   `job`의 `id, status, attempts, max_attempts`)을 뜨고 `config.json`·`hf-token.bin`의 sha256을 적는다.
   새 빌드를 `/Applications`에 덮어쓰고 기동.
   - `backups/*-before-026_job_interruptions.sql.dump`가 생긴다.
   - `_migrations`에 `026_job_interruptions.sql`.
   - 후 스냅샷이 전과 같고 job 행은 `interruptions=0`, `max_interruptions=3`.
   - 두 파일의 sha256이 같다. 토큰 재입력·마이크 재요청이 없다.
2. **강제 종료가 재시도를 먹지 않는다 (C2).** 긴 오디오 처리 중 `kill -9 <main pid>` → 재기동을 세 번.
   회차마다 psql로 `attempts, interruptions, status`. 1·2회차 `queued`·`interruptions` 1·2, 3회차
   `failed`(`app_restarted`), 회의 `failed`. 그동안 실패 수(`attempts − interruptions`)는 0.
3. **일시 실패 재시도 (C3).** C2의 1회차 뒤 이어지는 실행에서 TRANSIENT를 일으킬 수 있으면(P5-C4의
   Wi-Fi 차단) worker 로그의 `attempt=1/5 … interruptions=1`과 `next_attempt_at − updated_at ≈ 30초`를
   본다. 일으킬 수 없으면 §8.1이 증명하고 실측은 생략을 기록한다.
4. **되돌림 거부 기록 (C4, 6b-2의 전제).** 새 판 위에 0.3.1을 다시 설치해 기동 → `migrationUnknown`
   으로 멈추고 아무것도 지우거나 만들지 않는다(`backups/` 목록 전후 동일). 확인 뒤 새 판을 다시 설치해
   기동이 정상인지 본다. **복원은 하지 않는다.**
5. **정리.** 실측이 끝나면 사용자가 원하는 상태로 되돌린다 — 새 판을 둘지, `data.pre-6b3-backup`을
   되살릴지 사용자에게 묻는다.

## 9. 완료 기준

| ID | 기준 | 방법 |
| --- | --- | --- |
| P6b3-C1 | 0.3.1 → 새 빌드 덮어쓰기에서 회의·설정·토큰이 유지되고 `026`이 적용 전 백업과 함께 적용됨 | §8.2-1 |
| P6b3-C2 | 강제 종료 3회에 1·2회차 `queued`, 3회차 `failed`, 그동안 실패 수 불변 | §8.2-2 |
| P6b3-C3 | 중단이 있었던 job의 TRANSIENT 재시도가 5회 예산·30초 첫 백오프를 그대로 씀 | §8.1 (+ §8.2-3) |
| P6b3-C4 | 새 판 위에 0.3.1을 올리면 `migrationUnknown`으로 거부하고 아무것도 바꾸지 않음 | §8.2-4 |
| P6b3-C5 | 공유 격자를 TS·Python 회수 넷이 모두 통과 | §8.1 |
| P6b3-C6 | 변이 M1~M12 전부 빨간불(동치는 사유 기록) | §8.1 |
| P6b3-C7 | `pnpm test`·`pnpm lint`·`pnpm worker:test` 초록 | static |

## 10. 로드맵 변경

- Phase 6b 절에 6b-3 상태 문단을 더한다(스펙·결과·브랜치 링크).
- **순서를 적는다(2026-09-24 결정): 6b-3 먼저, 6b-2는 그 병합 뒤.** 이유는 §1 둘째 문단 —
  `026`이 있어야 6b-2가 실제 스키마 변경을 백업·복원 대상으로 삼는다. 0.4.0은 둘 다 병합된 뒤 낸다.
- `desktop/CLAUDE.md` "재시도" 절의 마지막 항목("강제 종료 N번은 재시도 5회 중 N회를 먹는다")과
  "중단된 작업의 회수" 절의 `attempts` 문장들을 새 규칙으로 고친다.

## 11. 리뷰 기록

### 11.1 코덱스 스펙 리뷰

(리뷰 뒤 채운다.)

### 11.2 사용자 결정 (2026-09-24)

- 6b-2·6b-3은 스펙·계획·PR을 나누고 6b-3을 먼저 한다.
- 분리 방식은 A — `attempts`는 그대로, `interruptions`·`max_interruptions`를 덧붙인다. (B: `attempts`를
  실패 수로 재정의 — 기각. C: 회수가 `attempts`를 되돌리며 따로 셈 — 기각, 시작 실행 수라는 관측값만
  잃는다.)
- `max_interruptions` 기본값 3.
