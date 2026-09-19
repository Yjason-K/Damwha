# Electron Phase 5 — 운영 안정화 (구현 스펙)

작성일: 2026-09-19
브랜치: `feat/electron-migration-phase-5-data-migration-operations`
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
| C | supervisor 재시작 시 이전 `--once` 자식 회수 | Phase 2 결과 §5 이월 — 크래시로 재시작된 supervisor는 앞의 `--once` 자식을 추적하지 않는다 |
| D | 시스템 이벤트 실측 — 강제 종료·잠자기/복귀·디스크 부족·서비스 장애·녹음 중 강제 종료 | 로드맵 Phase 5 범위. Phase 2가 검증한 것은 **정상 종료**뿐이다 |

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| 기존 DB·녹음의 이전(migration) | 사용자가 기존 Docker DB·`be/storage`(2.1G)를 새 앱으로 옮길 필요가 없다고 결정했다(2026-09-19) | 로드맵 Phase 5에서 삭제. 다른 맥으로의 이전이 필요해지면 Phase 6에서 다룬다 |
| 백업·복원 기구 | 이전이 빠지면서 이 Phase의 동인이 사라졌다. Phase 3이 마이그레이션 전 `pg_dump -Fc` 5개를 이미 돌린다 | **Phase 6** — "업데이트 전 백업, 업데이트 실패 복구"가 이미 Phase 6 완료 기준이다 |
| `model_readiness`의 두 writer 키 충돌·부분 캐시 `ready`·캐시 삭제 미인지·`entries` 무한 증가 | worker+BE+FE+desktop 네 패키지 동시 스키마 변경. 이 Phase의 작업 복구 정합성과 독립이다 | Phase 6 또는 별도 작업. Phase 4 결과 §12.6-1~6에 원문이 있다 |
| 끊긴 다운로드의 바이트 이어받기 | Phase 4 스펙 §15에서 이미 미뤘다. B가 같은 증상(3분 끊김)을 **재시도 쪽에서** 덮는다 | 미정 |

## 3. 선행 Phase에서 인계받는 사실

구현이 이 사실 위에 선다. 각 항목은 실제 코드에서 확인한 것이다.

1. **`job.locked_by`는 worker의 신분 문자열**이다. 앱이 띄운 worker는 `WORKER_ID=desktop-<uuid>`를
   쓰고(`desktop/src/config/config.ts:60`의 `RUN_WORKER_ID`), 이 값은 **앱 실행마다 새로 발급**된다.
2. `withAppOwned`(`config.ts:294`)가 **모든 자식 env**에 `WORKER_ID`를 얹고 `api.ts:181`이 그대로
   펼치므로 **API도 이번 실행의 신분을 안다.**
3. 터미널 `pnpm worker`의 기본 신분은 `worker-1`이다(`be/worker/damwha_worker/config.py:67`).
   웹 배포판에는 `WORKER_ID`가 없다.
4. 회수 경로는 지금 **둘 다 시간 기반**이다 — BE의 `ReaperService`(5분 크론,
   `REAPER_STALE_MINUTES=30`)와 worker의 `run_reaper_loop`. 둘 다 `locked_at`이 30분보다 오래된
   `running`만 본다.
5. 정상 종료 경로는 이미 정합하다 — `requeue_for_shutdown`(`db/queue.py:88`)이 claim이 올린
   `attempts`를 되돌린다. **잔류는 그 경로를 타지 못했을 때** 생긴다(SIGKILL, ⌘Q 이중 신호 경합).
6. worker의 heartbeat는 **소유권 상실을 감지하는 훅**을 이미 갖고 있다(`jobs.py:77`).
   `set_stage`·`heartbeat`·`mark_processing`이 전부 `locked_by=%s AND status='running'`로 가드된다.
7. 재시도 판정은 `dispatch.py:44` — `TRANSIENT`이고 `attempts < max_attempts`일 때만 requeue.
   `PERMANENT`(401·403·설정 오류 등)는 재시도하지 않는다.
8. `live_session`은 재queue 대상이 아니다(`jobs.repository.ts:113`의 주석, 설계 §2.2·§4.2).
   끊긴 라이브는 앞에서부터 다시 전사해도 의미가 없다.
9. 기동 전 고아 정리는 `app/reap-on-start.ts`가 `reapOrphans`(`process/orphans.ts:581`)로 한다.
   **supervisor 재시작 경로(`supervisor.ts:686` `restartOnce`)에서는 돌지 않는다.**

## 4. 변경 A — 기동 시 고아 job 회수

### 4.1 규칙

`JobsRepository.reclaimOrphaned(exec, workerId)`를 새로 만든다.

```sql
UPDATE job
   SET status='queued',
       attempts = greatest(attempts - 1, 0),
       locked_by=NULL, locked_at=NULL, next_attempt_at=NULL, updated_at=now()
 WHERE status='running'
   AND locked_by LIKE 'desktop-%'     -- 앱이 띄운 worker의 신분만
   AND locked_by <> $1                -- 이번 실행 것은 건드리지 않는다
   AND type <> 'live_session'         -- 끊긴 라이브는 재queue하지 않는다
```

`live_session`은 같은 호출에서 `failed`로 닫는다 — 사유 `code='app_restarted'`. 그러지 않으면
stale live 행이 30분 동안 `running`에 남는다(§3-8과 같은 이유).

`attempts`를 되돌리는 근거: 앱이 죽은 것은 job의 잘못이 아니다. `requeue_for_shutdown`과 같은 규칙이다.

### 4.2 경계 — 무엇을 건드리지 않나

- **터미널 `pnpm worker`(`worker-1`)의 job**: `desktop-` 접두사에 걸리지 않는다. Phase 2가 세운
  "외부에서 실행 중인 서비스를 앱 소유와 구분한다"와 같은 결이다.
- **웹 배포판**: `WORKER_ID`가 없으면 **아무것도 하지 않고 반환한다.** 회수 SQL을 돌리지 않는다.
- **이번 실행의 job**: `locked_by <> $1`. 앱이 재시작한 worker가 다시 claim하기 전의 행은 신분이
  같으므로 남는다 — 그것은 시간 기반 reaper의 몫이다.

### 4.3 호출 시점

`ReaperService`의 `onApplicationBootstrap`에서 **1회**. 크론 `reap()`은 그대로 둔다 —
회수는 "앞 실행이 남긴 것", reaper는 "이번 실행 중에 죽은 것"으로 역할이 갈린다.

API는 worker보다 먼저 준비되므로(Phase 2 의존 순서), 회수는 새 worker가 claim하기 전에 끝난다.

### 4.4 설정

`be/src/config/env.ts`에 `WORKER_ID: z.string().optional()`을 더한다. 기본값을 두지 않는다 —
**없음이 곧 "앱이 띄운 API가 아니다"**라는 신호다.

### 4.5 실패 동작

회수 SQL이 실패하면 **기동을 막지 않는다.** 로그에 남기고 계속한다 — 회수는 복구 가속이지
기동 조건이 아니며, 실패해도 30분 reaper가 같은 일을 한다.

## 5. 변경 B — 재시도 정책

### 5.1 지금

`db/queue.py:78`의 `requeue`가 `least(power(2, attempts - 1), 60)`초를 쓴다. `attempts`는 claim이
이미 올린 값이라 1회차 1초, 2회차 2초다. `max_attempts` 기본값 3(`001_init.sql:101`)이므로
**세 번이 약 3초 + 처리 시간 안에 다 탄다.** 3분짜리 네트워크 끊김은 job을 영구 실패로 만든다.

### 5.2 바꾸는 것

| 값 | 전 | 후 |
| --- | --- | --- |
| 백오프 | `least(power(2, attempts-1), 60)` 초 | `least(30 * power(2, attempts-1), 900)` 초 |
| `max_attempts` 기본값 | 3 | 5 |

재시도 시각(claim 직후 실패 기준): 0 · 30s · 90s · 210s · 450s. **4회차가 3.5분에 닿으므로 3분
끊김을 같은 job이 넘긴다.**

- 마이그레이션 `025_job_retry_policy.sql` — `ALTER TABLE job ALTER COLUMN max_attempts SET DEFAULT 5`.
  **기존 행은 고치지 않는다**(이미 끝난 job의 기록을 사후에 바꾸지 않는다).
- `live_session`은 영향이 없다 — `live.service.ts:252`가 `maxAttempts: 1`을 명시해 컬럼
  DEFAULT를 타지 않는다.
- `jobs.repository.ts:12`의 주석("컬럼 DEFAULT(3)")도 함께 고친다. 상수를 복제하지 않는다는
  원칙은 유지하고 숫자만 맞춘다.
- `PERMANENT`는 지금도 재시도하지 않는다(§3-7). 상한을 올려도 401·403이 5번 도는 일은 없다.

### 5.3 대가

한 job이 최대 ~12분 동안 `queued`로 앉아 있을 수 있다. 화면은 그 사이 "대기 중"으로 보인다 —
진행 표시 문구가 재시도를 말하는지는 구현 단계에서 확인한다(§9 P5-C4의 관찰 항목).

## 6. 변경 C — supervisor 재시작 시 `--once` 고아 회수

`restartOnce`(`supervisor.ts:686`)가 worker를 다시 띄우기 **전에** `reapOrphans`와 같은 스캔을
1회 돌린다. 대상은 좁힌다.

- `runId === 이번 실행`이고 `once === true`인 줄만. 다른 run-id는 기동 시 정리가 이미 봤다.
- 신호 절차는 기존 `reapByKind`를 그대로 쓴다(SIGTERM → 3초 유예 → SIGKILL 전 args 재확인).
- 스캔 실패는 재시작을 막지 않는다 — 로그에 남기고 재시작을 계속한다.

worker 이외의 서비스 재시작에서는 돌리지 않는다. `--once` 자식은 worker만 만든다.

## 7. 데이터·프로세스 소유권 (변경 후)

| 대상 | 소유자 | 회수 주체 |
| --- | --- | --- |
| `running` job, `locked_by = 이번 실행` | 이번 실행의 worker | 정상 종료: worker(`requeue_for_shutdown`) / 비정상: 시간 기반 reaper(30분) |
| `running` job, `locked_by = desktop-*` (앞 실행) | 없음 (고아) | **API 기동 시 `reclaimOrphaned`** (신설) |
| `running` job, `locked_by = worker-1` 등 | 외부 worker | 앱은 건드리지 않는다. 시간 기반 reaper만 |
| `--once` 자식 프로세스 | supervisor | 종료: B층 회수 / supervisor 재시작: **신설 스캔** / 앱 기동: `reap-on-start` |

## 8. 검증 대상 — 시스템 이벤트

| 상황 | 주입 | 관찰 |
| --- | --- | --- |
| 앱 강제 종료 | 분석 중 `kill -9 <앱 pid>` | 재기동 시 job이 `queued`로 회수되고 `attempts` 증가 0, 처리 재개 |
| 잠자기·복귀 | 처리 중 `pmset sleepnow`, 10분 뒤 깨움 | worker heartbeat·DB 연결 회복, job이 `running`에 갇히지 않음, 화면이 상태를 정직하게 말함 |
| 디스크 부족 | §10의 미확정 절차 | 원인·복구 안내가 화면에 뜨고 **기존 회의·녹음 파일이 보존됨**, 클러스터 파손 없음 |
| 서비스 장애 | 처리 중 embed `kill`, postgres `SIGQUIT` | 화면 사유 + 자동 회복. Phase 3의 `degraded` 경로가 **처리 중에도** 성립하는지 |
| 녹음 중 강제 종료 | 녹음 중 `kill -9` | 손실 범위가 Phase 2 정책과 일치, `live_session` job이 정직하게 닫힘 |

## 9. 완료 기준

환경 표기: **packaged** = `desktop/out/mac-arm64/Damwha.app`을 Finder에서 실행. **dev** = `pnpm dev`.
**unit** = 자동 테스트.

| ID | 기준 | 환경 | 확인 방법 |
| --- | --- | --- | --- |
| P5-C1 | 분석 중 앱 `kill -9` → 재기동 후 같은 job이 `attempts` 소모 없이 재개된다 | packaged | 죽이기 전후 `job` 행의 `attempts`·`status`·`locked_by`를 psql로 비교. 회의가 `done`까지 간다 |
| P5-C2 | 회수가 외부 worker(`worker-1`) 소유 `running` 행을 건드리지 않는다 | dev + unit | `locked_by='worker-1'` 행을 손으로 넣고 API 기동. 행 불변 |
| P5-C3 | `WORKER_ID` 없는 환경에서 회수가 no-op | unit | `WORKER_ID` 미설정으로 부트스트랩, SQL 미발행을 확인 |
| P5-C4 | 3분 네트워크 끊김 뒤 **같은 job**이 사람 개입 없이 완주한다 | packaged | 모델 다운로드 중 Wi-Fi 3분 차단. `attempts`가 5 이내, 최종 `done` |
| P5-C5 | 10분 잠자기·복귀 후 job이 `running`에 갇히지 않는다 | packaged | 복귀 후 job이 진행 중이거나 `queued`/`failed`로 정직하게 전이. 화면과 DB가 일치 |
| P5-C6 | 디스크 부족에서 원인·복구가 화면에 뜨고 기존 데이터가 보존된다 | packaged | §10의 절차. 전후 `meeting`·`utterance` 수와 storage 파일 수 비교 |
| P5-C7 | supervisor 크래시 재시작 후 이전 `--once` 고아가 0 | packaged | supervisor pid만 `kill -9` → 재시작 뒤 `ps`에 `--once` 줄 0 |
| P5-C8 | 처리 중 embed·DB 장애가 화면에 사유로 뜨고 회복된다 | packaged | 각각 죽이고 상태 창·셸 화면 관찰. 재시작 없이 회복 |
| P5-C9 | 녹음 중 `kill -9`의 손실 범위가 Phase 2 정책과 일치한다 | packaged | 녹음 파일 크기·`live_session` job 상태·화면 안내 |
| P5-C10 | 모든 회차 뒤 `meeting.status`·`job.status`·`current_job_id`가 정합하다 | packaged | 회차 종료 후 정합성 질의 1벌 (processing인데 running job 없음 / done인데 utterance 0 등) |

## 10. 미확정 사항 — 디스크 부족 주입 방법

**구현에 영향을 주므로 계획의 첫 Task에서 실증한다.** 스펙 리뷰 통과의 조건이 아니라 별도 검증
단계로 명시한다(로드맵 "1. 구현 스펙"의 규칙).

후보 1 (먼저 시도): 작은 sparse disk image를 마운트하고 `--user-data-dir`로 `<userData>`를 그 위에
올린 채 packaged 앱을 실행. **미확인** — Electron이 `app.setName("Damwha")` 뒤에도 이 switch를
존중하는지, 그 상태에서 클러스터 초기화가 되는지.

후보 2 (내려갈 자리): `data/storage`만 작은 볼륨에 두고 심볼릭 링크. **미확인** — `.damwha-cluster`
마커 페어링이 심볼릭 링크를 받아들이는지.

둘 다 실패하면 P5-C6은 **미판정**으로 남기고 결과 문서에 이유를 적는다. 실제 디스크를 채우는
방법은 쓰지 않는다 — 회수 불가능한 위험이다.

## 11. 기술 위험

1. **`desktop-` 접두사 규칙이 문자열 관습에 의존한다.** `RUN_WORKER_ID`의 모양이 바뀌면 회수가
   조용히 멈춘다. 완화: 접두사를 한 곳에 상수로 두고 unit이 모양을 고정한다.
2. **백오프를 늘리면 실패가 늦게 보인다.** 5회차까지 ~12분. 화면이 "대기 중"만 말하면 사람은
   멈춘 것으로 읽는다(§5.3).
3. **잠자기 복귀 후 좀비 worker.** 복귀한 worker가 이미 회수된 job에 쓰려 하면 가드가 막지만
   (§3-6), 그 뒤 worker가 무엇을 하는지는 미관측이다. P5-C5가 본다.
4. **`kill -9` 회차가 `<userData>`에 Electron 잔재를 남긴다**(Phase 4 §12.6-19 — `SingletonLock`·
   `Cookie`·`Socket`). 다음 기동이 조용히 물러날 수 있다. 회차마다 그 셋을 확인한다.

## 12. 로드맵 변경

이 스펙과 함께 `docs/electron-migration-roadmap.md`를 고친다.

- Phase 5의 제목·목표·범위를 "운영 안정화"로 재정의하고 이전(migration) 항목을 지운다.
- 이전 관련 완료 기준 둘("기존 회의 기록과 녹음·검색 결과를 새 앱에서 사용 가능", "이전 실패 시
  원본 데이터를 보존하고 복구 가능")을 지운다.
- Phase 6 범위에 백업·복원이 이 Phase에서 넘어왔음을 명시한다.
- 변경 이유(사용자가 2026-09-19에 이전 불필요를 결정)를 남긴다.
