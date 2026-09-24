# Electron Phase 6b-3 — `attempts` 분리 (구현 스펙)

작성일: 2026-09-24
브랜치: `feat/electron-migration-phase-6b-attempts`
선행: Phase 6b-1 병합 (PR #30, `dev` = `24331f6`). 발행된 최신 릴리스 `desktop-v0.3.1`.

## 1. 목표

**강제 종료·크래시로 회수된 실행이 일시 실패 재시도 예산을 먹지 않게 한다. 그러면서도 앱을 죽이는
job은 여전히 유한한 횟수 안에 `failed`로 끝나게 한다.**

지금은 `job.attempts` 한 컬럼이 두 사실을 함께 센다. claim이 +1 하고 정상 종료(`requeue_for_shutdown`)
만 −1 하므로, SIGKILL·크래시·전원 차단·heartbeat 30분 부재로 회수된 실행이 TRANSIENT 재시도 5회 중 한
회를 먹는다(Phase 5 스펙 §2.2, `desktop/CLAUDE.md` "재시도" 절). 셈을 하나 더 두고 한도도 따로 둔다.

이 Phase의 마이그레이션 `026`은 **v1(0.3.1) → v2 업그레이드 검증의 실물 시험체**다(로드맵 Phase 6b,
2026-09-20 분할 문단). 0.3.1과 현재 `dev`는 둘 다 `025`에서 끝나므로, `026`이 없으면 0.3.1에서
올릴 때 마이그레이션 게이트가 백업을 뜨지 않고(`migration-gate.ts:171`) 6b-2가 시험할 대상도 없다.

같은 회수 CTE와 재시도 배너를 고치는 김에, 코덱스 스펙 리뷰(§11.1)가 그 자리에서 찾은 **기존 결함
셋**을 함께 고친다(§6). 셋 다 이 Phase의 실측(C1~C3)이 기대는 경로다.

## 2. 범위

### 2.1 포함

- 마이그레이션 `026_job_interruptions.sql` — `interruptions`·`max_interruptions` 컬럼 (§4.4).
- 회수 CTE 세 벌이 `interruptions`를 올리고 그것으로 상한을 판정한다 (§4.2).
- worker의 재시도 판정·백오프가 재시도 예산 소비량(`attempts − interruptions`)을 쓴다 (§4.3).
- 회의 상태 API의 `retry` 객체와 처리 배너 문구 (§5).
- 기존 결함 셋 (§6): 회수의 회의 전파에 `current_job_id` 가드, 재시도 대기가 옛 stage를 이기게,
  TRANSIENT requeue가 오류를 저장하게.
- 두 언어 회수 판정의 공유 fixture (§8.1).
- packaged 업그레이드 실측 — 발행된 0.3.1에서 새 빌드로 덮어쓰기 (§8.2).

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| 업데이트 전 백업·복원 UI·수동 복원 절차·실패 복구 정책 | 6b의 다른 덩어리. 이 Phase의 `026`이 그 시험 대상이 된다 | **6b-2** (이 Phase 병합 뒤 새 브랜치) |
| `attempts`의 의미 자체를 "실패 수"로 바꾸기 (claim이 올리지 않게) | 의미는 가장 깨끗하나 claim 두 벌·shutdown·기존 행 재해석까지 바뀐다. 2026-09-24 결정(§11.2) | 범위 밖 |
| `max_attempts=3`으로 남은 `025` 이전 행 고치기 | `025`와 같은 규칙 — 기존 행은 고치지 않는다 | 범위 밖 |
| `JobsRepository.claim`(TS) 변경 | 운영 경로가 부르지 않는다(claim은 worker `queue.py`만) — 테스트 헬퍼다 | 범위 밖 |
| 재처리의 상태 재확인을 트랜잭션 잠금 안으로 (코덱스 #1의 앞 절반) | 재처리 경합 자체는 회의·API 흐름 결함이다. 이 Phase는 그 경합이 회수 전파로 번지는 끝만 막는다(§6.1) | `be/docs/backlog.md` |
| `--once` 스캔 실패 뒤에도 worker를 재시작해 같은 `WORKER_ID`의 자식 둘이 겹칠 수 있음 (코덱스 #2) | Phase 5부터의 결함(`supervisor.ts:544`)이고 이 컬럼이 위험을 키우지 않는다. 고치려면 실행별 펜싱이 필요하다 | `be/docs/backlog.md`, §7 |

## 3. 선행 사실

각 항목은 2026-09-24 `dev`(`24331f6`)의 코드에서 확인했다.

1. **claim이 `attempts`를 +1 한다** — worker `db/queue.py:16`. API의 `JobsRepository.claim`
   (`jobs.repository.ts:32`)도 같은 식이나 운영 경로에서 부르지 않는다(호출자는 `dispatch.py:114`·
   `__main__.py:55`의 worker `db.claim`뿐).
2. **정상 종료는 되돌린다** — `requeue_for_shutdown`(`queue.py:96`)이 `greatest(attempts − 1, 0)`.
   **live는 예외** — live job은 shutdown에서 이 경로를 타지 않는다(`jobs.py:331`).
3. **회수 CTE는 세 벌이다.**
   - `JobsRepository.reclaimOrphaned`(`jobs.repository.ts:125`) — API 기동 1회, 앞 실행 `desktop-*` 행.
   - `JobsRepository.reapStale`(`jobs.repository.ts:214`) — API 5분 크론, `locked_at` 30분 초과.
   - worker `_REAP_SQL`(`queue.py:111`) — 선택자만 다른 `reap_stale`(`:184`)·`reap_own_orphans`(`:192`).

   셋 다 비-live는 `attempts < max_attempts`면 `queued`, 아니면 `failed`로 닫고 딸린 행
   (`lens_extraction_run`·`meeting_summary`·`meeting`·`speaker`)까지 닫는다. live는 언제나 `failed`.
   **`attempts`를 되돌리지 않는다**(Phase 5 스펙 §4.1). 딸린 행 중 요약·렌즈 run은 `job_id`로,
   화자는 `current_job_id`로 짝을 찾지만 **회의만 `meeting_id`로 찾는다**
   (`jobs.repository.ts:188`·`:267`, `queue.py:158`) — §6.1.
4. **재시도 판정은 `dispatch.py:44`** — `TRANSIENT and attempts < max_attempts`. `attempts`는 claim이
   이미 올린 값이라 "지금 실행을 포함한 시작 횟수"다.
5. **requeue**(`queue.py:79`)는 `least(30 * power(2, attempts − 1), 900)`초 뒤로 미루고,
   **`stage`·`progress`를 지우지 않으며 `error`를 쓰지 않는다.** 호출처는 `jobs.py:141`·`:154` 둘이고
   둘 다 `on_failure`의 `error`를 손에 쥐고 있으나 넘기지 않는다 — §6.3.
6. **관측** — `findStatus`(`meetings.repository.ts:123`)가 `retry: {attempts, max_attempts,
   next_attempt_at, error}`를 주고, `fe/src/pages/meeting.tsx:137`이 **`status.stage`가 있으면 그것을
   먼저** 쓰고 없을 때만 `재시도 대기 · …`를 그린다. requeue가 stage를 지우지 않으므로 stage를 한 번이라도
   찍은 job의 재시도 대기에는 이 문구가 뜨지 않는다 — §6.2. 기존 배너 테스트는 `stage: null`을 직접
   넣어 이 경우를 비켜 갔다(`meeting.test.tsx:1117`).
7. **heartbeat** — 별도 스레드·별도 연결로 30초마다(`config.py` `heartbeat_interval_seconds`,
   `heartbeat.py:25`·`:55`), 핸들러 전체(모델 빌드 포함)를 감싼다(`dispatch.py:221`). 30분 reaper가
   보는 것은 **"30분간 heartbeat 성공 없음"**이지 job 길이나 일반적인 hang이 아니다 — heartbeat가 살아
   있는 한 한 시간짜리 job도, 멈춘 job도 회수되지 않는다.
8. **마이그레이션 게이트** — 적용할 것이 있고 이미 적용된 것이 하나라도 있으면
   `<userData>/backups/<stamp>-before-<첫 pending>.dump`를 뜬 뒤 적용하고, 5개를 넘는 옛 백업을 지운다
   (`migration-gate.ts:143`·`:171`). 러너는 파일마다 트랜잭션이다(`be/src/database/migrate.ts`).
   DB에 모르는 마이그레이션이 있으면 기동을 거부한다(`migration-gate.ts:168`, `migrationUnknown`).
9. **공유 fixture 선례** — `be/test/fixtures/job-payloads/`를 TS(`contract-fixtures.spec.ts`)와
   Python(`tests/test_contracts*.py`, `parents[2] / "test" / "fixtures"`)이 함께 읽는다. 두 쪽 DB는
   따로다 — jest는 testcontainers로 컨테이너를 띄워 `runMigrations`(`be/test/db.ts:19`), pytest는
   마이그레이션 SQL을 직접 적용하고 테스트마다 초기화한다(`conftest.py:54`). pytest `seed_job`은
   `max_attempts=3`을 늘 명시한다(`conftest.py:105`).

## 4. 셈 규칙

### 4.1 두 셈과 파생값

| 값 | 뜻 | 누가 바꾸나 |
| --- | --- | --- |
| `attempts` | 시작한 실행 수 (정상 종료로 반납한 비-live 실행은 뺀다) | claim +1, `requeue_for_shutdown` −1 — **바뀌지 않는다** |
| `interruptions` (신설) | 실행이 끝나기 전에 주인을 잃고 회수된 횟수 | 회수 CTE 세 벌만 +1 |
| `max_interruptions` (신설) | 그 한도. 기본 3 | 컬럼 DEFAULT |
| **`failures`** = `attempts − interruptions` | **재시도 예산 소비량.** 중단되지 않고 끝난(또는 진행 중인) 실행 수 — 실패한 실행, `running`인 지금 실행, 성공해 `done`이 된 실행이 모두 1씩이다 | 파생값 — 저장하지 않는다 |

`failures`를 "스스로 낸 실패 수"라고 부르지 않는다. 첫 시도에 성공한 job도 `failures=1`이고, 실행
중인 job은 지금 실행을 포함한다. 재시도 판정·백오프가 필요로 하는 양이 정확히 이것이다.

**불변식.**
- 언제나 `0 ≤ interruptions ≤ attempts`.
- **`status='running'`이면 `interruptions < attempts`.** 증명: 행이 `running`이 되는 길은 claim(+1)뿐이고,
  그 실행이 끝나기 전에는 그 +1을 되돌리는 것(같은 실행의 정상 반납)도 그 실행을 센 중단(회수)도 아직
  없다. 회수는 이 조건을 가진 `running` 행에서 `interruptions`를 +1 하므로 결과는 `≤`를 지킨다.
  정상 반납도 이 조건 아래서 −1 하므로 `≤`를 지킨다.

DB 제약으로 걸지 않고 테스트로 고정한다(§8.1) — 회수 CTE 한가운데서 제약 위반이 나면 기동 회수
전체가 실패하고, 그 실패는 로그만 남기고 삼켜진다(Phase 5 스펙 §4.5).

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
- live 행은 **회수 순간** 지금처럼 언제나 `failed`이고 `interruptions`는 올린다(기록 일관성).
  판정에는 쓰지 않는다. 그 뒤 API 마무리가 그 행을 `done`으로 바꾸고 새 `process_meeting` job을
  enqueue할 수 있다(`live.service.ts:455`) — **중단 횟수는 옛 live 행에 남고 새 job으로 옮기지 않는다.**
- 딸린 행 정리, 오류 코드(`app_restarted`·`stale_worker`), 잠금(`FOR UPDATE SKIP LOCKED`), 선택자는
  바뀌지 않는다. 회의 전파에만 가드가 붙는다(§6.1).
- `reclaimOrphaned`의 비-live 소진 분기 메시지 `'… — no attempts left'`를
  `'the app was interrupted N times while running this job'` 꼴로 바꾼다(N은 `new_interruptions`).
  반환값 이름 `failedSpent`는 `failedInterrupted`로 바꾸고 `ReaperService`의 로그와
  `reclaim-bootstrap.spec.ts:15`의 목도 따라간다.

**결과.** `max_interruptions=3`이면 중단 두 번까지는 `queued`, 세 번째에 `failed`다. ⌘Q는
`requeue_for_shutdown`을 타므로 어느 셈도 올리지 않는다(live 제외, §3-2). 두 한도는 독립이고 먼저 닿는
쪽이 job을 끝낸다.

**같은 실행을 두 번 세지 않는다.** 네 회수 경로(API 기동 회수·API reaper·worker reaper·worker 자기
고아 회수)는 모두 `status='running'` 행을 `FOR UPDATE SKIP LOCKED`로 집고 같은 트랜잭션에서
`queued`/`failed`로 바꾼다. 커밋 뒤에 두 번째 회수가 오면 그 행은 이미 `running`이 아니다. 한 번의
실제 중단은 한 번만 센다 — §8.1이 "커밋 뒤 두 번째 회수는 0행"과 두 회수의 겹침을 고정한다.

**heartbeat 부재도 중단이다.** 30분간 heartbeat 성공이 없으면(§3-7) 멀쩡히 일하던 worker라도 잠금을
잃고, 그것이 중단 예산을 쓴다. 세 번 잃으면 `failed`다 — 옛 규칙에서는 새 job 기준 다섯 번이었다.
받아들인다: heartbeat가 30분 끊기는 것은 worker 일시 정지·DB 연결 장기 장애이고, 그 job이 원인일 수도
있다. 이 Phase는 일반적인 진행 감시(watchdog)를 제공하지 않는다.

### 4.3 재시도 판정·백오프 (worker)

- `dispatch.py:44`: `retry = TRANSIENT and failures(job) < max_attempts`.
  같은 자리의 로그 `attempt=%s/%s`도 `failures` 기준으로 찍고 `interruptions=%s`를 덧붙인다.
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
  시도를 전부 예산 소비로 안고 간다 — 재시도를 더 얹지 않는 보수적 해석이다. 그 행들이 과거에
  크래시로 먹은 시도는 되돌려 주지 않는다(구분할 정보가 없다).
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
실리므로 판이 섞이지 않는다. `JobRow`(`jobs.types.ts`)에 두 필드를 더한다. `findStatus`는 job이
끝난 뒤에도 현재 job을 준다 — 그때의 `failures`는 §4.1의 뜻(성공한 실행도 1) 그대로다.

### 5.2 처리 배너 (`meeting.tsx`)

```
재시도 대기 · {failures}/{max_attempts}회차 · 약 N분 뒤[ · 마지막 오류: X][ · 중단 {interruptions}회]
```

- **우선순위를 바꾼다(§6.2):** 다운로드 문구 > **재시도 대기** > stage 라벨 > "대기 중".
- `· 중단 N회`는 `interruptions > 0`일 때만.
- 문구가 뜨는 조건(`next_attempt_at`이 미래)은 바꾸지 않는다. 회수는 `next_attempt_at=NULL`로 돌려놓으므로
  회수 직후의 job에는 이 문구가 뜨지 않는다 — 회수가 stage를 남기므로 그동안 화면은 옛 stage 라벨이다.
  곧바로 재claim되어 새 stage가 찍히므로 고치지 않는다(§7).
- `RetryStatus`(`fe/src/features/meeting/api/types.ts:188`)를 `failures`·`interruptions`로 바꾼다.

## 6. 기존 결함 셋 (코덱스 스펙 리뷰 #1·#6·#7, 2026-09-24 포함 결정)

### 6.1 회수의 회의 전파에 `current_job_id` 가드

세 벌의 `fail_meetings` CTE에 `m.current_job_id = f.id`를 더한다.

**결함.** 재처리는 회의 상태를 트랜잭션 **밖에서** 확인하고(`meetings.service.ts:223`),
`bumpVersionForReprocess`(`meetings.repository.ts:215`)는 상태를 다시 보지 않는다. 재처리 요청 둘이
동시에 `done`을 보면 job 둘이 enqueue되고 늦은 쪽이 `current_job_id`가 된다. 밀려난 옛 job이 중단 한도를
태우면 회수가 `meeting_id`만 보고 **새 실행이 끝낸 회의를 `failed`로 덮는다.** 요약·렌즈 run·화자는 이미
`job_id`/`current_job_id`로 짝을 찾으므로 회의만 고친다. 재처리 경합 자체(앞 절반)는 backlog다(§2.2).

### 6.2 재시도 대기가 옛 stage를 이긴다

§5.2의 우선순위. **결함:** requeue가 stage를 지우지 않고(§3-5) 배너가 stage를 먼저 쓰므로(§3-6),
전사 도중의 TRANSIENT 실패는 재시도 대기 내내 "전사 중"으로 보였다. worker가 아니라 화면에서 고친다 —
stage는 `error.stage`의 원천이고 회수·실패 CTE가 `j.stage`를 읽는다.

### 6.3 TRANSIENT requeue가 오류를 저장한다

`db.requeue(conn, job_id, worker_id, error)` — 소유권 가드(`locked_by`·`status='running'`)는 그대로 두고
`error = %s`를 함께 쓴다. 호출처 둘(`jobs.py:141`·`:154`의 `_requeue_or`)이 `on_failure`의 `error`를
넘긴다. **결함:** 지금은 재시도 대기 중 `job.error`가 비어 있거나 더 오래된 것이라 "마지막 오류: X"가
TRANSIENT 재시도에서 뜨지 않았다. 다음 claim은 `error`를 지우지 않는다 — 재시도 중인 job의 마지막 오류로
남고, 성공하면 `done` 행에 남는다(지금 `fail_job`이 남기는 것과 같다).

## 7. 알려진 한계

- **0.3.1에서 넘어온 행의 과거 크래시는 예산 소비로 남는다**(§4.4). 업그레이드 시점에 재시도 대기 중인
  job만 해당하고, 새로 enqueue되는 job에는 없다.
- **`max_interruptions`는 컬럼이지만 바꾸는 경로가 없다.** `max_attempts`와 같다.
- **중단의 원인을 가리지 않는다.** 사용자가 Activity Monitor로 앱을 죽인 것, job이 worker를 segfault
  시킨 것, heartbeat가 30분 끊긴 것을 같게 센다. 죽은 프로세스는 사유를 기록하지 못한다.
- **`--once` 스캔이 실패하면 같은 `WORKER_ID`의 자식 둘이 겹칠 수 있다**(코덱스 #2, `supervisor.ts:544`).
  살아남은 옛 자식의 job을 새 supervisor의 자기 고아 회수가 거두면 `interruptions`가 오르고, 그 뒤 옛
  자식의 늦은 heartbeat·stage·실패 쓰기가 같은 신분이라 소유권 가드를 통과할 수 있다. Phase 5부터 있던
  결함이고 이 Phase가 키우지 않는다. 막으려면 실행별 펜싱이 필요하다 — backlog.
- **회수 직후 배너는 옛 stage 라벨이다**(§5.2). 곧바로 재claim되므로 두지 않는다.

## 8. 테스트·검증

### 8.1 자동

실행: be는 `pnpm --filter damwha-be exec jest <path>`(실 Postgres, testcontainers), worker는
`pnpm worker:test`, fe는 `pnpm --filter damwha-fe exec vitest run <path>`.

**be**

- `026` 적용 테스트 — **`025`까지만 적용한 DB에 행을 시드한 뒤** `026`을 적용해 기존 행의 `attempts`·
  `max_attempts` 보존과 새 컬럼 기본값을 본다(`startTestDb`는 전부 적용하므로 이 테스트는 부분 적용
  경로를 따로 둔다). DEFAULT·NOT NULL·CHECK 둘.
- `reclaim.spec`·`reaper.spec` 갱신 — 기존 "attempts 소진 → failed" 케이스는 "중단 소진 → failed"로.
  새 케이스:
  - **`attempts = max_attempts`, `interruptions = 0`인 `running` 행이 `queued`로, `interruptions=1`.**
  - `interruptions = 2`(기본 한도 3)면 `failed`와 딸린 행 넷.
  - `attempts`는 어느 분기에서도 그대로.
  - live 행: 언제나 `failed`, `interruptions` +1.
  - **§6.1:** `current_job_id`가 다른 job인 회의는 소진 회수가 건드리지 않는다.
  - 커밋 뒤 두 번째 회수는 0행(이중 계수 없음).
- 누락돼 있던 소진 단언 갱신: `jobs.repository.spec.ts:97`, `reclaim-bootstrap.spec.ts:15`(반환값 이름).
- `status-retry.spec`: `failures = attempts − interruptions`, `interruptions` 필드.
- `reclaim-races.spec`: 기존 시나리오에 카운터 단언을 더하고, **겹치는** 시나리오를 새로 — 기동 회수와
  reaper가 같은 행을 동시에 집을 때 한 번만 센다.

**worker**

- `test_db_lifecycle.py`: `reap_stale`·`reap_own_orphans`의 같은 케이스, `requeue` 백오프가
  `interruptions`를 빼는지(`attempts=3, interruptions=1` → 60초, DB 시각 기준 간격), `requeue`가 `error`를
  쓰는지(§6.3), `requeue_for_shutdown`이 `interruptions`를 건드리지 않는지, §6.1 가드.
- `test_summarize_meeting.py:228`의 소진 단언 갱신.
- `dispatch` 재시도 판정: `attempts=5, max_attempts=5, interruptions=1`의 TRANSIENT는 **requeue**
  (옛 판정은 fail). dispatch → `findStatus`까지 **실제 경로로** 오류가 보이는지(§6.3).
- 전이 시퀀스 테스트 — 도달 가능한 상태만으로: claim→회수→claim→정상 반납, claim→회수→claim→회수×2,
  회수→(옛 소유자의 늦은 반납은 가드로 0행). 매 전이 뒤 §4.1의 두 불변식. 불변식을 깨는 합성 행(예:
  `running, attempts=1, interruptions=1`)은 도달 불가 입력으로 따로 분류하고 격자에 넣지 않는다.

**두 언어 일치 — 공유 fixture** `be/test/fixtures/job-reap/grid.json`

한 케이스는 다음을 담는다.
- 초기 상태: `type`(`process_meeting`·`summarize_meeting`·`extract_lenses`·`enroll_speaker`·`live_session`),
  `attempts`, `max_attempts`, `interruptions`, `max_interruptions` — **한도 필드를 생략한 케이스**를
  포함해 DEFAULT를 탄다. 모든 케이스는 `running`이고 §4.1 불변식을 만족한다.
- 기대: `status`, `interruptions`, `attempts`(불변), 잠금 필드 초기화, 딸린 행의 최종 상태(타입별).

경계값(한도 −1·한도·0)을 포함한다. TS(`reclaimOrphaned`·`reapStale`)와 Python(`reap_stale`·
`reap_own_orphans`)이 **같은 파일**을 읽고, 케이스마다 새로 시드한 뒤 각 회수를 부르고 단언한다.
선택자 조건(앞 실행 신분·오래된 `locked_at`·자기 신분)은 각 테스트가 맞춘다. 같은 파일의 두 번째
격자 `(attempts, interruptions) → (failures, retry 여부, 백오프 초)`로 `requeue`(SQL)·`failures()`·
dispatch 판정이 같은 식인지 고정한다.

**fe**

- 배너가 `failures/max_attempts`를 쓴다(`attempts`가 아니라).
- `interruptions > 0`일 때만 `· 중단 N회`.
- **§6.2:** `stage`가 null이 아닌데 `next_attempt_at`이 미래면 재시도 문구가 이긴다. 다운로드 문구는 여전히
  재시도 문구를 이긴다.

**변이** — 하나씩 넣어 빨간불을 기록한다(동치 변이는 사유 기록).

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
| M12 | `026`의 DEFAULT 3 → 5 | 026 적용 테스트 · grid(한도 생략 케이스) |
| M13 | `fail_meetings`의 `current_job_id` 가드 제거 (각 벌) | §6.1 케이스 |
| M14 | 배너 우선순위를 stage 먼저로 되돌림 | meeting.test(§6.2) |
| M15 | `requeue`가 `error`를 쓰지 않음 | lifecycle · dispatch→status |

### 8.2 packaged 실측

userData(`~/Library/Application Support/Damwha`)를 dev와 packaged가 **함께 쓴다**(`main.ts:97`). 실측은
실데이터 위에서 돈다 — 준비와 정리를 빠뜨리면 사용자의 기록을 잃는다.

**0. 준비.**
1. **모든 쓰는 주체가 꺼졌는지** 확인한다 — Electron만이 아니라 postmaster와 worker·embed·LLM 자식까지.
   `pgrep -fl "Damwha.app/Contents|Electron.app/Contents/MacOS/Electron|electron/cli.js|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"`
   가 비어야 한다. postmaster는 앱이 죽어도 살아남을 수 있다(`service.ts:144`).
2. **복구 세트를 통째로** 앱 밖 고유 경로에 복사한다 — `models/`(7.1 GB, 다시 받을 수 있다)와 Chromium
   캐시를 뺀 userData 전체: `data/`(클러스터·스토리지 한 쌍), `backups/`(게이트가 5개 초과분을 지운다),
   `config.json`, `hf-token.bin`, `update-state.json`, `storage/`.
   `rsync -a --exclude models --exclude 'Cache' --exclude 'Code Cache' --exclude GPUCache "<userData>/" ~/damwha-6b3-recovery-<stamp>/`.
3. 새 빌드는 `pnpm desktop package:desktop` 뒤 `desktop/out/mac-arm64/Damwha.app`을 버전 붙은 이름으로
   복사해 둔다. 발행된 0.3.1 DMG를 받아 둔다.

**1. 업그레이드 보존 (C1).**
1. 0.3.1을 `/Applications/Damwha.app`에 설치해 띄운다. 회의 하나를 업로드해 `done`까지, 처리 설정 하나를
   바꾼다. 가능하면 재시도 대기 job을 하나 남긴다.
2. **0.3.1이 떠 있는 동안** psql(상태 창의 명령)로 **전 기준선**을 뜬다 — 앱을 끄면 내장 PG도 내려가
   psql을 쓸 수 없다.
   - `SELECT name FROM _migrations ORDER BY 1` 마지막이 `025_job_retry_policy.sql`이고
     `job`에 `interruptions` 컬럼이 **없다**. (앞서 dev를 띄워 `026`이 이미 적용돼 있으면 이 실측은
     성립하지 않는다 — 준비 2의 복구 세트로 되돌리거나 `026` 이전 상태를 만든다.)
   - 회의별 `id, status, processing_version, audio_key`, 발화 `id, text, speaker_id`의 해시, 요약 본문 해시,
     화자 `id, name`, `app_setting`의 **`processing_defaults` 값**. `worker_capabilities`는 기동마다 다시
     쓰이므로 비교하지 않는다(`__main__.py:367`).
   - job 행 `id, type, status, attempts, max_attempts`.
   - 파일: `data/storage` 아래 오디오의 sha256, 클러스터 마커, `config.json`·`hf-token.bin`의 sha256.
   - `backups/` 목록.
3. ⌘Q로 끈다(준비 1로 전부 꺼졌는지 확인). 새 빌드를 `/Applications`에 덮어쓰고 기동.
4. 기대:
   - `backups/`에 **이번 기동이 만든** `*-before-026_job_interruptions.sql.dump`(목록 차이와 파일 시각,
     `supervisor.log`의 `적용 전 백업` 줄), `_migrations`에 `026`과 이번 기동 시각의 `applied_at`.
   - 전 기준선의 레코드·해시·`processing_defaults`가 같다. job 행은 `attempts`·`max_attempts`가 같고
     `interruptions=0`, `max_interruptions=3` — 단 재시도 대기 job은 기동 뒤 곧 claim되어 `attempts`가
     오를 수 있다(그 행은 `attempts`가 기준선 이상이고 `interruptions=0`이면 통과).
   - 파일 해시가 같다. 토큰 재입력·마이크 재요청이 없다.
   - 화면: 옛 회의를 열어 오디오 재생, 전사·요약이 보이고, 바꾼 처리 설정이 설정 화면에 그대로다.

**2. 중단이 재시도 예산을 먹지 않는다 (C2).** 두 경로를 따로 본다.
- **2a. worker 자기 고아 회수 ×3.** 긴 오디오 처리 중, job을 쥔 `--once` 자식을 특정한다(psql로
  `locked_by`와 `status='running'`인 job id, `ps`로 그 job을 처리 중인 `damwha_worker … --once` pid). 그
  자식만 `kill -9`. supervisor가 거둔 **직후**(재claim 전) `interruptions=1, status='queued'`,
  `failures = attempts − interruptions = 0`. 재claim 뒤 `running`이면 `failures=1`이다(지금 실행 포함 —
  §4.1). 세 번 반복해 3회차에 `failed`(`stale_worker`)와 회의 `failed`. 재claim 전 순간을 못 잡으면 로그의
  `reap_own_orphans` 줄과 재claim 뒤 값으로 두 단계를 각각 확인한다.
- **2b. 앱 전체 강제 종료 → 기동 회수 1회.** 처리 중 worker 자식들을 먼저, 그다음 main을 `kill -9`
  (`pkill -9 -f "Damwha.app/Contents/Resources/python"` 뒤 `pkill -9 -f "Damwha.app/Contents/MacOS/Damwha"`).
  **postmaster에는 SIGKILL을 보내지 않는다**(`desktop/CLAUDE.md` "지키는 것"). main만 죽이면 worker 자식이
  살아남아 다음 기동의 정리가 SIGTERM으로 **정상 반납**시키므로 중단으로 세지지 않는다 — 그래서 자식부터
  죽인다. 재기동 뒤 `supervisor.log`·API 로그의 기동 회수 줄과 `interruptions` +1, `attempts` 불변(재claim
  전 기준).

**3. 일시 실패 재시도 (C3).** 2a의 1회차 뒤 이어지는 실행에서 TRANSIENT를 일으킬 수 있으면(P5-C4의
Wi-Fi 차단) worker 로그의 `attempt=1/5 … interruptions=1`, `next_attempt_at − updated_at ≈ 30초`, 화면의
"재시도 대기 · 1/5회차 · … · 마지막 오류: X · 중단 1회"를 본다. 일으킬 수 없으면 §8.1이 증명하고 실측은
생략을 기록한다.

**4. 되돌림 거부 기록 (C4, 6b-2의 전제).** 새 판 위에 0.3.1을 다시 설치해 기동 → `migrationUnknown`으로
멈추고 아무것도 지우거나 만들지 않는다(`backups/` 목록 전후 동일). 확인 뒤 새 판을 다시 설치해 기동이
정상인지 본다. **복원은 하지 않는다.**

**5. 정리.** 준비 1로 전부 꺼진 것을 확인한 뒤, 사용자에게 새 판 상태로 둘지 복구 세트로 되돌릴지
묻는다. 되돌릴 때는 복구 세트를 userData에 그대로 되쓴다(`data/`와 `backups/`를 먼저 비우고).

## 9. 완료 기준

| ID | 기준 | 방법 |
| --- | --- | --- |
| P6b3-C1 | 0.3.1 → 새 빌드 덮어쓰기에서 회의(레코드·내용·오디오)·`processing_defaults`·토큰이 유지되고, 이번 기동이 만든 적용 전 백업과 함께 `026`이 적용됨 | §8.2-1 |
| P6b3-C2 | worker 자식 강제 종료 3회에 1·2회차 `queued`, 3회차 `failed`, 회수 시점의 `failures` 불변. 앱 전체 강제 종료 1회에 기동 회수가 `interruptions`만 올림 | §8.2-2 |
| P6b3-C3 | 중단이 있었던 job의 TRANSIENT 재시도가 5회 예산·30초 첫 백오프를 쓰고, 화면이 stage가 있어도 재시도 대기와 마지막 오류를 말함 | §8.1 (+ §8.2-3) |
| P6b3-C4 | 새 판 위에 0.3.1을 올리면 `migrationUnknown`으로 거부하고 아무것도 바꾸지 않음 | §8.2-4 |
| P6b3-C5 | 공유 격자를 TS·Python 회수 넷이 모두 통과 | §8.1 |
| P6b3-C6 | 밀려난 job의 소진 회수가 새 실행의 회의를 건드리지 않음 | §8.1 (§6.1) |
| P6b3-C7 | 변이 M1~M15 전부 빨간불(동치는 사유 기록) | §8.1 |
| P6b3-C8 | `pnpm test`·`pnpm lint`·`pnpm worker:test` 초록 | static |

## 10. 로드맵·문서 변경

- 로드맵 Phase 6b 절에 6b-3 상태 문단을 더한다(스펙·결과·브랜치 링크).
- **순서를 적는다(2026-09-24 결정): 6b-3 먼저, 6b-2는 그 병합 뒤.** 이유는 §1 둘째 문단 —
  `026`이 있어야 6b-2가 실제 스키마 변경을 백업·복원 대상으로 삼는다. 0.4.0은 둘 다 병합된 뒤 낸다.
- `desktop/CLAUDE.md` "재시도" 절의 마지막 항목("강제 종료 N번은 재시도 5회 중 N회를 먹는다")과
  "중단된 작업의 회수" 절의 `attempts` 문장들을 새 규칙으로 고친다.
- `be/docs/backlog.md`에 둘: 재처리 상태 확인의 트랜잭션 밖 경합(§2.2), `--once` 스캔 실패 뒤 같은 신분
  자식의 중첩(§7).

## 11. 리뷰 기록

### 11.1 코덱스 스펙 리뷰 (2026-09-24)

열린 탐색 과제로 넘겼다(판정 요청 아님): 놓친 `attempts` 사용처, 불변식 반례, 회수 경합과 이중 계수,
heartbeat와 30분 만료, packaged 실측의 거짓 초록불·실데이터 손상 경로, 공유 fixture의 실현성. 12건을 냈고
핵심 주장(#1·#2·#6·#7·#11 성공 경로)은 코드에서 직접 확인했다.

| # | 지적 | 판정 | 반영 |
| --- | --- | --- | --- |
| 1 | P1 — 회수의 회의 전파가 `current_job_id`를 안 봐, 동시 재처리에서 밀려난 job이 새 실행의 회의를 `failed`로 덮음 | **유효**(기존 결함) | §6.1 가드 포함. 재처리 잠금은 backlog |
| 2 | P1 — `--once` 스캔 실패 뒤 재시작이 같은 신분 자식 둘을 만들 수 있음 | **유효**(기존 결함, Phase 5) | §7 한계·backlog. 이 컬럼이 키우지 않는다 |
| 3 | P1 — 실측 준비가 Electron만 확인, 복구 세트가 `data/`뿐 | **유효** | §8.2-0 전 주체 확인·복구 세트 확장 |
| 4 | P1 — C1 기준선 부재(`026` 선적용), `app_setting` 전체 비교의 거짓 빨간불, 레코드 수만 비교 | **유효** | §8.2-1 기준선·내용 해시·`processing_defaults`·화면 확인 |
| 5 | P1 — main만 `kill -9`하면 자식이 살아 정상 반납됨. 재claim 뒤 `failures`는 1 | **유효** | §8.2-2를 2a(자식 특정)·2b(자식 먼저)로, 단계별 단언 |
| 6 | P1 — 배너가 stage를 먼저 써서 재시도 문구가 대개 안 뜸 | **유효**(기존 결함) | §6.2 우선순위 |
| 7 | P2 — TRANSIENT requeue가 오류를 저장하지 않음 | **유효**(기존 결함) | §6.3 |
| 8 | P2 — 불변식에 `running ⇒ interruptions < attempts` 필요 | **유효** | §4.1 |
| 9 | P2 — fixture: DEFAULT 생략·딸린 행 타입·`025`→`026` 시드 필요 | **유효** | §8.1 |
| 10 | P2 — 누락된 소진 테스트 파일, 경합 테스트가 실제로는 순차 | **유효** | §8.1 파일 추가·겹침 시나리오 |
| 11 | P2 — `failures`가 "스스로 낸 실패"가 아님(성공도 1), live 종료·마무리 예외 | **유효** | §4.1 정의, §3-2·§4.2 live |
| 12 | P2 — 30분 만료는 heartbeat 부재지 hang이 아님 | **유효** | §3-7·§4.2 문구, 세 번이면 failed를 명시적으로 수용 |

### 11.2 사용자 결정 (2026-09-24)

- 6b-2·6b-3은 스펙·계획·PR을 나누고 6b-3을 먼저 한다.
- 분리 방식은 A — `attempts`는 그대로, `interruptions`·`max_interruptions`를 덧붙인다. (B: `attempts`를
  실패 수로 재정의 — 기각. C: 회수가 `attempts`를 되돌리며 따로 셈 — 기각, 시작 실행 수라는 관측값만
  잃는다.)
- `max_interruptions` 기본값 3.
- 코덱스 리뷰의 기존 결함 중 #1(회의 전파 가드)·#6·#7을 이 Phase에 포함한다. #2와 재처리 잠금은 backlog.
