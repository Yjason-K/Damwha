# Electron Phase 5 — 운영 안정화 (구현 스펙)

작성일: 2026-09-19 (코덱스 리뷰 반영 1차)
브랜치: `feat/electron-migration-phase-5-operational-hardening`
선행: Phase 4 완료 (PR #24, `dev` = `fe119c5`)

## 1. 목표

앱을 일상적으로 쓰는 동안 **중단이 데이터나 작업을 잃지 않게** 만든다. 앱이 죽거나, 맥이 자거나,
디스크가 차거나, 서비스 하나가 넘어져도 job의 소유권·상태 전이가 정합하고, 복구가 사람의 개입
없이(또는 화면이 시킨 대로) 끝나야 한다.

## 2. 범위

### 2.1 포함

| # | 항목 | 근거 |
| --- | --- | --- |
| A | 기동 시 이전 실행 소유의 `running` job 회수 | Phase 4 결과 §12.6-10 — ⌘Q 경합이 job을 `running`으로 남겼고 회수는 30분 뒤 reaper뿐 |
| B | 재시도 백오프·상한 재설정 | Phase 4 결과 §12.6-12 — 3회가 ~3분에 소진돼 3분짜리 끊김이 job을 영구 실패로 만든다 |
| C | 재시도 상태의 관측 계약 (API + 화면) | B가 대기를 최대 ~7분으로 늘린다. 지금 화면은 그것을 "대기 중" 한 마디로만 말한다 |
| D | `mark_processing`에 소유권 가드 추가 | 회수·재claim 이후 **늦게 도착한 이전 worker**가 회의 상태를 되돌릴 수 있다 |
| E | supervisor 재시작 시 이전 `--once` 자식 회수 | Phase 2 결과 §5 이월 — 크래시로 재시작된 supervisor는 앞의 `--once` 자식을 추적하지 않는다 |
| F | 시스템 이벤트 실측 — 강제 종료·잠자기/복귀·디스크 부족·서비스 장애·녹음 중 강제 종료 | 로드맵 Phase 5 범위. Phase 2가 검증한 것은 **정상 종료**뿐이다 |

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| 기존 DB·녹음의 이전(migration) | 사용자가 기존 Docker DB·`be/storage`(2.1G)를 새 앱으로 옮길 필요가 없다고 결정했다(2026-09-19) | 로드맵 Phase 5에서 지웠다(커밋 `40f2627`). 다른 맥으로의 이전이 필요해지면 Phase 6 |
| 백업·복원 기구 | 이전이 빠지면서 이 Phase의 동인이 사라졌다. Phase 3이 마이그레이션 전 `pg_dump -Fc` 5개를 이미 돌린다 | **Phase 6** — "업데이트 전 백업, 업데이트 실패 복구"가 이미 Phase 6 완료 기준이다 |
| `model_readiness`의 두 writer 키 충돌·부분 캐시 `ready`·캐시 삭제 미인지·`entries` 무한 증가 | worker+BE+FE+desktop 네 패키지 동시 스키마 변경. 이 Phase의 작업 복구 정합성과 독립이다 | Phase 6 또는 별도 작업. Phase 4 결과 §12.6-1~6에 원문이 있다 |
| 끊긴 다운로드의 바이트 이어받기 | Phase 4 스펙 §15에서 이미 미뤘다. B가 같은 증상(3분 끊김)을 **재시도 쪽에서** 덮는다 | 미정 |

## 3. 선행 Phase에서 인계받는 사실

구현이 이 사실 위에 선다. 각 항목은 실제 코드에서 확인한 것이다.

1. **`job.locked_by`는 worker의 신분 문자열**이다. 앱이 띄운 worker는 `WORKER_ID=desktop-<uuid>`를
   쓰고(`desktop/src/config/config.ts:60`의 `RUN_WORKER_ID`), 이 값은 **앱 실행마다 새로 발급**된다.
2. `withAppOwned`(`config.ts:294`)가 **모든 자식 env**에 `WORKER_ID`를 얹고 `api.ts:181`이 그대로
   펼친다. 다만 **지금 API는 그 값을 읽지 못한다** — `be/src/config/env.ts`의 `EnvSchema`에 키가
   없다. §4.4가 그것을 더한다.
3. 터미널 `pnpm worker`의 기본 신분은 `worker-1`이다(`be/worker/damwha_worker/config.py:67`).
   웹 배포판에는 `WORKER_ID`가 없다.
4. **시간 기반** 회수는 둘이다 — BE `ReaperService`(5분 크론, `REAPER_STALE_MINUTES=30`)와 worker
   `run_reaper_loop`. 둘 다 `locked_at`이 30분보다 오래된 `running`만 본다. 시간 기반이 아닌 회수로는
   graceful shutdown 경로(`requeue_for_shutdown`)가 따로 있다.
5. 정상 종료 경로는 이미 정합하다 — `requeue_for_shutdown`(`db/queue.py:88`)이 claim이 올린
   `attempts`를 되돌린다. **잔류는 그 경로를 타지 못했을 때** 생긴다(SIGKILL, ⌘Q 이중 신호 경합).
6. worker의 heartbeat는 **소유권 상실을 감지하는 훅**을 갖고 있다(`jobs.py:77`).
   `set_stage`·`heartbeat`는 `locked_by=%s AND status='running'`으로 가드된다. **`mark_processing`은
   아니다** — `job.id`와 `status='running'`만 본다(`db/queue.py:43-51`). §7이 그것을 고친다.
7. 재시도 판정은 `dispatch.py:44` — `TRANSIENT`이고 `attempts < max_attempts`일 때만 requeue.
   `PERMANENT`(401·403·설정 오류 등)는 재시도하지 않는다.
8. `live_session`은 재queue 대상이 아니다. 기존 reaper도 live 행은 `failed`로 닫는다
   (`jobs.repository.ts:113`·`130`). 끊긴 라이브를 앞에서부터 다시 전사해도 의미가 없다.
9. **끊긴 라이브의 마무리 경로는 이미 있다.** `LiveOrphanService`(30초 크론, `ORPHAN_SECONDS=90`)가
   producer 만료를 확인하고 `committed_bytes`에서 봉인한 뒤, job이 `running`이 아니면
   `finalizeByApi`로 넘긴다(`live-orphan.service.ts:139-169`). 0바이트는 `closeEmpty`, 파일이 확정
   경계보다 짧으면 `closeIoFailure`. **파일은 지우지 않는다.**
10. 워커의 live 실패 경로는 **job만** 닫는다 — 회의·확정·봉인 경계를 건드리지 않는 것이 설계다
    (`db/live.py:14-32`의 `fail_live_preview`).
11. 기동 전 고아 프로세스 정리는 `app/reap-on-start.ts`가 `reapOrphans`(`process/orphans.ts:581`)로
    한다. **supervisor 재시작 경로(`supervisor.ts:686` `restartOnce`)에서는 돌지 않는다.**
12. 회의 상태 조회(`meetings.repository.ts:123` `findStatus`)는 `stage`·`progress`·`error`만 준다.
    `attempts`·`next_attempt_at`은 없다. 화면은 `stage`가 없으면 **"대기 중"** 한 마디다
    (`fe/src/pages/meeting.tsx:122-124`).

## 4. 변경 A — 기동 시 고아 job 회수

### 4.1 규칙 (비-live)

`JobsRepository.reclaimOrphaned(exec, workerId)`를 새로 만든다.

```sql
UPDATE job
   SET status='queued',
       locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
 WHERE status='running'
   AND locked_by LIKE 'desktop-%'     -- 앱이 띄운 worker의 신분만
   AND locked_by <> $1                -- 이번 실행 것은 건드리지 않는다
   AND type <> 'live_session'
```

**`attempts`는 되돌리지 않는다.** 초안은 `greatest(attempts-1, 0)`이었으나 그것은 무한 재시도를
만든다 — claim이 `attempts`를 +1 하고(`jobs.repository.ts:28`) 회수가 -1 하면 앱을 죽이는 job은
`attempts >= max_attempts` 분기에 영영 닿지 못한다(`jobs.repository.ts:120-131`). 앱을 다섯 번
강제 종료하면 그 job은 `failed`가 된다. 그것이 정직하다 — 그 job이 앱을 죽이고 있을 수 있다.

### 4.2 규칙 (live_session)

같은 호출에서 live 행은 `failed`로 닫는다. 기존 reaper의 live 분기와 같은 모양이고, 코드만 다르다.

```sql
UPDATE job SET status='failed', updated_at=now(),
       error = jsonb_build_object('code','app_restarted',
                                  'message','the app restarted while this live session was running',
                                  'stage', stage)
 WHERE status='running' AND locked_by LIKE 'desktop-%' AND locked_by <> $1
   AND type='live_session'
```

**회의·`committed_bytes`·`sealed_bytes`·파일은 건드리지 않는다**(§3-10과 같은 규칙). 그 뒤의 마무리는
§3-9의 `LiveOrphanService`가 한다 — 브라우저가 죽었으므로 producer는 만료 상태이고, 스위퍼가
확정 경계에서 봉인한 뒤 job이 `running`이 아니므로 `finalizeByApi`로 넘긴다. **이 회수가 하는 일은
그 경로를 30분 reaper 대신 즉시 여는 것뿐이다.**

### 4.3 경계 — 무엇을 건드리지 않나

- **터미널 `pnpm worker`(`worker-1`)의 job**: `desktop-` 접두사에 걸리지 않는다. Phase 2가 세운
  "외부에서 실행 중인 서비스를 앱 소유와 구분한다"와 같은 결이다.
- **웹 배포판**: `WORKER_ID`가 없으면 **SQL을 발행하지 않고 반환한다.**
- **이번 실행의 job**: `locked_by <> $1`. 회수보다 새 worker의 claim이 먼저 닿으면 그 행은 이번
  실행 신분을 갖게 되어 대상에서 빠진다. 같은 행을 두고 회수·claim·취소·재처리·reaper가 겹치면
  Postgres의 행 잠금으로 직렬화된다 — 순서별 최종 상태가 하나로 수렴하는지는 P5-C11이 고정한다.

### 4.4 호출 시점과 설정

`ReaperService`의 `onApplicationBootstrap`에서 **1회**. 크론 `reap()`은 그대로 둔다 — 회수는
"앞 실행이 남긴 것", reaper는 "이번 실행 중에 죽은 것"으로 역할이 갈린다. API는 worker보다 먼저
준비되므로(Phase 2 의존 순서) 회수는 새 worker가 claim하기 전에 끝난다.

`be/src/config/env.ts`에 `WORKER_ID: z.string().optional()`을 더한다. 기본값을 두지 않는다 —
**없음이 곧 "앱이 띄운 API가 아니다"**라는 신호다. 접두사 `desktop-`은 한 곳에 상수로 두고 unit이
`RUN_WORKER_ID`의 모양과 함께 고정한다.

### 4.5 실패 동작

회수 SQL이 실패하면 **기동을 막지 않는다.** 로그에 남기고 계속한다 — 회수는 복구 가속이지 기동
조건이 아니며, 실패해도 30분 reaper가 같은 일을 한다.

## 5. 변경 B — 재시도 정책

### 5.1 지금

`db/queue.py:78`의 `requeue`가 `least(power(2, attempts - 1), 60)`초를 쓴다. `attempts`는 claim이
이미 올린 값이라 1회차 1초, 2회차 2초다. `max_attempts` 기본값 3(`001_init.sql:101`)이므로
**세 번이 약 3초 + 처리 시간 안에 다 탄다.** 3분짜리 네트워크 끊김은 job을 영구 실패로 만든다.

### 5.2 바꾸는 것

| 값 | 전 | 후 |
| --- | --- | --- |
| 백오프 | `least(power(2, attempts-1), 60)` 초 | `least(30 * power(2, attempts-1), 900)` 초 |
| `max_attempts` **컬럼 기본값** | 3 | 5 |

재시도 시각(claim 직후 실패 기준): 0 · 30s · 90s · 210s · 450s. **4회차가 3.5분에 닿으므로 3분
끊김을 같은 job이 넘긴다.**

- 마이그레이션 `025_job_retry_policy.sql` — `ALTER TABLE job ALTER COLUMN max_attempts SET DEFAULT 5`.
- **기존 행은 고치지 않는다.** 이미 `max_attempts=3`으로 적힌 job은 계속 3회에서 실패하고 reaper도
  그 저장된 값을 본다(`jobs.repository.ts:120`). 새 기본값은 **마이그레이션 이후 enqueue되는 job**
  에만 적용된다. 검증 회차의 job은 전부 새로 만든 것이어야 한다.
- `live_session`은 영향이 없다 — `live.service.ts:252`가 `maxAttempts: 1`을 명시해 컬럼 DEFAULT를
  타지 않는다.
- `jobs.repository.ts:12`의 주석("컬럼 DEFAULT(3)")도 함께 고친다. 상수를 복제하지 않는다는 원칙은
  유지하고 숫자만 맞춘다.
- `PERMANENT`는 지금도 재시도하지 않는다(§3-7). 상한을 올려도 401·403이 5번 도는 일은 없다.

## 6. 변경 C — 재시도 상태의 관측 계약

B가 한 job의 대기를 최대 ~7분으로 늘린다. 지금 화면은 `stage`가 없으면 "대기 중"만 말하므로
(§3-12) **정상 백오프·worker 미기동·DB 장애가 사용자에게 같은 얼굴**이다. 로드맵 Phase 2가 세운
"시작 실패 시 원인과 복구 방법을 앱에서 확인 가능"을 이 Phase가 재시도까지 확장한다.

- `findStatus`(`meetings.repository.ts:123`)가 `j.attempts`·`j.max_attempts`·`j.next_attempt_at`·
  `j.error`를 함께 준다. 기존 필드는 그대로 둔다(계약 추가이지 변경이 아니다).
- 화면(`fe/src/pages/meeting.tsx:122`의 `stageLabel` 분기)은 `stage`가 없고 `next_attempt_at`이
  미래이면 **"재시도 대기 · N/M회차 · 약 M분 뒤"**와 마지막 오류 요약을 말한다. `next_attempt_at`이
  없으면 지금처럼 "대기 중"이다.
- 모델 다운로드 중 문구(Phase 4가 넣은 `downloading` 분기)와 겹치면 다운로드 쪽이 이긴다 — 그쪽이
  더 구체적이다.

## 7. 변경 D — `mark_processing` 소유권 가드

`mark_processing`은 지금 `job.id`와 `status='running'`만 본다(§3-6). 그래서 이 순서가 가능하다.

1. 회수가 앞 실행의 job을 `queued`로 되돌린다.
2. 이번 실행의 worker가 같은 job을 claim한다 — `locked_by`가 새 값, `status='running'`.
3. **아직 살아 있던 이전 worker**의 늦은 `mark_processing`이 도착한다. `status='running'`이 참이라
   그대로 통과해 회의를 `processing`으로 바꾼다 — 자기 것이 아닌 job의 상태 전이다.

수정: EXISTS 절에 `locked_by=%s`를 더하고 호출부가 `worker_id`를 넘긴다. 지금 호출부는 그것을
들고 있지 않으므로(`db/queue.py:43`의 주석이 그렇게 적혀 있다) **인자를 타고 내려보내는 변경이
함께 필요하다.** 0행이 나오면 지금과 같은 경로로 처리한다 — 이 워커는 더 쓸 것이 없다.

## 8. 변경 E — supervisor 재시작 시 `--once` 고아 회수

`restartOnce`(`supervisor.ts:686`)가 worker를 다시 띄우기 **전에** `reapOrphans`와 같은 스캔을
1회 돌린다. 대상은 좁힌다.

- `runId === 이번 실행`이고 `once === true`인 줄만. 다른 run-id는 기동 시 정리가 이미 봤다.
- 신호 절차는 기존 `reapByKind`를 그대로 쓴다(SIGTERM → 3초 유예 → SIGKILL 전 args 재확인).
- 스캔 실패는 재시작을 막지 않는다 — 로그에 남기고 재시작을 계속한다.

worker 이외의 서비스 재시작에서는 돌리지 않는다. `--once` 자식은 worker만 만든다.

## 9. 데이터·프로세스 소유권 (변경 후)

| 대상 | 소유자 | 회수 주체 |
| --- | --- | --- |
| `running` job, `locked_by` = 이번 실행 | 이번 실행의 worker | 정상 종료: worker(`requeue_for_shutdown`) / 비정상: 시간 기반 reaper(30분) |
| `running` job, `locked_by` = `desktop-*` (앞 실행), 비-live | 없음 (고아) | **API 기동 시 `reclaimOrphaned`** — `queued`로, attempts 유지 |
| `running` live job, `locked_by` = `desktop-*` (앞 실행) | 없음 (고아) | **회수가 `failed`로 닫고**, 봉인·마무리는 `LiveOrphanService` |
| `running` job, `locked_by` = `worker-1` 등 | 외부 worker | 앱은 건드리지 않는다. 시간 기반 reaper만 |
| 회의 상태 전이(`processing`) | job을 쥔 worker | §7의 소유권 가드가 다른 worker의 전이를 막는다 |
| `--once` 자식 프로세스 | supervisor | 종료: B층 회수 / supervisor 재시작: **신설 스캔** / 앱 기동: `reap-on-start` |

## 10. 검증 대상 — 시스템 이벤트

| 상황 | 주입 | 관찰 |
| --- | --- | --- |
| 앱 강제 종료 | 분석 중 `kill -9 <앱 pid>` | 재기동 시 job이 `queued`로 회수되고 처리 재개 |
| 잠자기·복귀 | 처리 중 `pmset sleepnow`, 10분 뒤 깨움 | worker heartbeat·DB 연결 회복, job이 `running`에 갇히지 않음, 화면과 DB가 같은 말을 함 |
| 디스크 부족 | §12의 미확정 절차 | 원인·복구 안내, **기존 회의·녹음 파일 보존**, 클러스터 파손 없음 |
| 서비스 장애 | 처리 중 embed `kill`, postgres `SIGQUIT` | 화면 사유 + 자동 회복. Phase 3의 `degraded` 경로가 **처리 중에도** 성립하는지 |
| 녹음 중 강제 종료 | 녹음 중 `kill -9` | 손실이 확정 경계 뒤 꼬리로 한정, live job이 닫히고 봉인·마무리까지 감 |

## 11. 완료 기준

환경 표기: **packaged** = `desktop/out/mac-arm64/Damwha.app`을 Finder에서 실행. **dev** = `pnpm dev`.
**unit** = 자동 테스트.

| ID | 기준 | 환경 | 확인 방법 |
| --- | --- | --- | --- |
| P5-C1 | 분석 중 앱 `kill -9` → 재기동 시 같은 job이 `queued`로 회수되고 `done`까지 간다 | packaged | psql로 같은 job id의 `status`·`locked_by`·`attempts` 전후 비교. **`attempts`는 1 늘어난다** — 회수는 되돌리지 않는다(§4.1) |
| P5-C2 | 회수가 외부 worker(`worker-1`) 소유 `running` 행을 건드리지 않는다 | dev + unit | `locked_by='worker-1'` 행을 넣고 API 기동. 행 불변 |
| P5-C3 | `WORKER_ID` 없는 환경에서 회수가 SQL을 발행하지 않는다 | unit | 부트스트랩 시 repository 호출 0회 |
| P5-C4 | 3분 네트워크 끊김 뒤 **같은 job**이 사람 개입 없이 완주한다 | packaged | `<userData>/models/hub`에서 모델 하나를 비워 다운로드를 강제한 뒤 Wi-Fi 3분 차단. `attempts` ≤ 5, 최종 `done`, 그 사이 화면이 **"재시도 대기"**를 말한다(§6) |
| P5-C5 | 10분 잠자기·복귀 후 60초 안에 job이 셋 중 하나로 정착한다 | packaged | (a) `running`이며 `stage`가 더 나아감, (b) `queued`, (c) `failed`+사유. 그리고 `meeting.status`와 화면 문구가 같은 것을 말한다 |
| P5-C6 | 디스크 부족에서 원인·복구가 화면에 뜨고 기존 데이터가 보존된다 | packaged | §12의 절차가 성립할 때만 판정. 전후 `meeting`·`utterance` 행 수와 `data/storage` 파일 수가 같다 |
| P5-C7 | supervisor 크래시 재시작이 이전 `--once` 자식을 회수한다 | packaged | 죽이기 **전** `--once` pid 목록을 기록 → supervisor만 `kill -9` → 재시작 뒤 그 pid가 전부 사라지고, 새로 뜬 `--once`는 다른 pid |
| P5-C8 | 처리 중 embed·DB 장애가 화면에 사유로 뜨고 60초 안에 회복된다 | packaged | 상태 창이 `degraded` 사유를 말하고 이후 `ok`로 돌아온다. job은 진행 또는 재시도 대기로 정직하다 |
| P5-C9 | 녹음 중 `kill -9`의 손실이 확정 경계 뒤 꼬리로 한정된다 | packaged | 파일이 남아 있고 길이 ≥ `committed_bytes`, live job이 `failed`, 2분 안에 `sealed_bytes`가 채워지고 회의가 마무리로 넘어간다(§3-9) |
| P5-C10 | 모든 회차 뒤 정합성 질의 넷이 0행이다 | packaged | ① `meeting.status='processing'`인데 `current_job_id`의 job이 `running`·`queued` 아님 ② `job.status='running'`인데 `locked_by IS NULL` ③ `meeting.status='done'`인데 `current_job_id`의 job이 `done` 아님 ④ `status='running' AND locked_by LIKE 'desktop-%'`인데 이번 실행 신분이 아님. **"done인데 utterance 0"은 기준에 넣지 않는다** — 무음 회의도 정상 완료다(`process_meeting.py`) |
| P5-C11 | 회수와 claim·취소·재처리의 경합이 어느 순서에서도 한 상태로 수렴한다 | unit | 세 순서(회수→claim, claim→회수, 회수↔취소)를 트랜잭션으로 엮어 최종 `job.status`·`meeting.status`를 고정 |
| P5-C12 | 이전 worker의 늦은 `mark_processing`이 0행이다 | unit | 회수→재claim 뒤 옛 `worker_id`로 호출 |

## 12. 미확정 사항 — 디스크 부족 주입 방법

**구현에 영향을 주므로 계획의 첫 Task에서 실증한다.** 스펙 리뷰 통과의 조건이 아니라 별도 검증
단계로 명시한다(로드맵 "1. 구현 스펙"의 규칙).

후보 1 (먼저 시도): 작은 sparse disk image를 마운트하고 `--user-data-dir`로 `<userData>`를 그 위에
올린 채 packaged 앱을 실행. **미확인** — Electron이 `app.setName("Damwha")` 뒤에도 이 switch를
존중하는지, 그 상태에서 클러스터 초기화가 되는지.

후보 2 (내려갈 자리): `data/storage`만 작은 볼륨에 두고 심볼릭 링크. **미확인** — `.damwha-cluster`
마커 페어링이 심볼릭 링크를 받아들이는지.

둘 다 실패하면 P5-C6은 **미판정**으로 남기고 결과 문서에 이유를 적는다. 실제 디스크를 채우는
방법은 쓰지 않는다 — 회수 불가능한 위험이다.

## 13. 기술 위험

1. **`desktop-` 접두사 규칙이 문자열 관습에 의존한다.** `RUN_WORKER_ID`의 모양이 바뀌면 회수가
   조용히 멈춘다. 완화: 접두사를 한 곳에 상수로 두고 unit이 모양을 고정한다(§4.4).
2. **백오프를 늘리면 실패가 늦게 보인다.** 5회차까지 ~12분. §6의 관측 계약이 그 대가를 갚는다.
3. **잠자기 복귀 후 좀비 worker.** 복귀한 worker가 이미 회수된 job에 쓰려 하면 `set_stage`·
   `heartbeat` 가드가 막고(§3-6), `mark_processing`은 §7이 막는다. 그 뒤 worker가 무엇을 하는지는
   미관측이다 — P5-C5가 본다.
4. **`kill -9` 회차가 `<userData>`에 Electron 잔재를 남긴다**(Phase 4 §12.6-19 — `SingletonLock`·
   `Cookie`·`Socket`). 다음 기동이 조용히 물러날 수 있다. 회차마다 그 셋을 확인한다.
5. **§7의 호출부 변경이 worker 파이프라인을 관통한다.** `worker_id`를 `mark_processing`까지
   내려보내야 하므로 시그니처가 바뀌는 자리가 여럿이다. 단위 테스트가 먼저다.

## 14. 로드맵 변경

커밋 `40f2627`이 이미 반영했다 — Phase 5를 "운영 안정화"로 재정의, 이전 관련 완료 기준 둘 삭제,
백업·복원이 Phase 6으로 넘어갔음을 양쪽에 명시.

## 15. 리뷰 기록

**1차 — 코덱스 (`gpt-5.6-terra`, effort medium, 읽기 전용), 대상 `e64d5cf`.**

| 지적 | 판정 | 조치 |
| --- | --- | --- |
| P0 로드맵과 스펙의 범위 불일치 | **무효** — 리뷰가 본 `e64d5cf`에는 로드맵 변경이 없었다. 같은 브랜치의 `40f2627`이 닫았다 | §14에 커밋을 적었다 |
| P0 `attempts` 복원이 무한 재시도를 만든다 | **유효** | §4.1에서 복원을 뺐다. P5-C1의 문구도 "attempts 1 증가"로 고쳤다 |
| P0 live job만 `failed`로 닫으면 회의·봉인 경계가 불일치한다 | **유효 (부분)** — 뒤처리 경로는 이미 있으나(`LiveOrphanService`) 스펙이 그 계약을 적지 않았다 | §3-9·§3-10·§4.2가 경로와 불변식을 명시. P5-C9가 봉인·마무리까지 관찰 |
| P1 `mark_processing`에 소유권 가드가 없다 (스펙의 사실 오류) | **유효** — `db/queue.py:43-51` 확인 | §3-6을 사실대로 고치고 §7을 새 변경으로 추가. P5-C12 신설 |
| P1 재시도 대기가 화면에서 "대기 중"과 구분되지 않는다 | **유효** | §6(변경 C) 신설. P5-C4·C8이 그 문구를 관찰 |
| 사실 오류 — API가 `WORKER_ID`를 "안다" | **유효** — env 스키마에 키가 없어 지금은 읽지 못한다 | §3-2를 고쳤다 |
| 완료 기준 C4·C5·C7·C8·C9·C10이 모호하거나 관측 불가 | **유효** | 여섯 기준 전부 주입·관찰 방법을 구체화. C10에서 "done인데 utterance 0"을 뺐다(무음 회의는 정상) |
| nit — 브랜치 표기 불일치, 경합 테스트 부재, `max_attempts` 기존 행 | **유효** | 머리말 브랜치 수정, P5-C11 신설, §5.2에 기존 행 규칙 명시 |
