# Electron Phase 6b-3 — `attempts` 분리 (결과)

스펙: [2026-09-24-electron-phase-6b-attempts-split-design.md](../specs/2026-09-24-electron-phase-6b-attempts-split-design.md)
계획: [2026-09-24-electron-phase-6b-attempts-split.md](../plans/2026-09-24-electron-phase-6b-attempts-split.md)
브랜치: `feat/electron-migration-phase-6b-attempts`

## 0. 전 패키지 초록 (P6b3-C8)

저장소 루트에서 실행. 셋 다 exit 0, be·fe 테스트 수 0 아님(거짓 초록불 아님).

| 명령 | 결과 |
| --- | --- |
| `pnpm lint` | exit 0. desktop(`tsc -p tsconfig.lint.json`) 통과, fe(`eslint .`) 경고 1건(기존, `saved-utterance-dashboard.tsx`의 `react-hooks/exhaustive-deps`) 외 0 error. be는 lint 스크립트 없음(정상 — `be/package.json`에 `lint` 없음). |
| `pnpm test` | exit 0. be: **53 suites / 552 tests passed**. fe: **66 files / 605 tests passed**. |
| `pnpm worker:test` | exit 0. **757 passed**, 기존 pyannote 경고 3건(`test_eval_diarization.py`, 미변경 파일). |
| `uv run --directory be/worker ruff check .` | `All checks passed!` |

## 1. 변이 검증 (P6b3-C7)

각 변이는 작업 트리에서만 적용 → 표의 테스트를 돌림 → 빨간불 기록 → `git checkout -- <파일>`로 되돌림. 매 회 `git status --short`가 `?? docs/images/2026-09-20/`(무관, 기존 미추적)만 보이는 것을 확인했다. 21개 행 전부 빨간불이었다 — 결손(테스트를 보강해야 했던 변이)은 없다.

| # | 변이 | 돌린 테스트 | 결과 (빨간불을 낸 테스트 이름) |
| --- | --- | --- | --- |
| M1 | `jobs.repository.ts` `reclaimOrphaned`의 `requeued` WHERE `interruptions + 1 < max_interruptions` → `<=` | `test/reap-grid.spec.ts` | 5 failed — `reap grid … › {third interruption fails under the default limit, limit 1 fails on the first interruption, summary exhausted fails its row, lens exhausted fails its run, enroll exhausted fails the speaker} › reclaimOrphaned`. 소진돼야 할 5개 케이스가 `queued`로 남음(`toMatchObject` status 불일치). |
| M2 | `reapStale`의 같은 자리 `<` → `<=` | `test/reap-grid.spec.ts` | 5 failed — 같은 5개 케이스, `› reapStale`. |
| M3 | `queue.py` `_REAP_SQL`의 같은 자리 `<` → `<=` | `tests/test_reap_grid.py` | 10 failed — `test_reap_stale_grid`·`test_reap_own_orphans_grid` 각 5개 케이스. `assert 'queued' == 'failed'`. |
| M4a | `reclaimOrphaned` `requeued`의 `interruptions = interruptions + 1` 삭제 | `test/reap-grid.spec.ts test/reclaim.spec.ts` | 7 failed — grid의 `reclaimOrphaned` 5개(`first interruption requeues`, `spent attempts no longer decide a reclaim`, `second interruption requeues`, `an explicit higher limit keeps requeueing`, `summary requeues with its row untouched`) + `reclaimOrphaned › counts the interruption and leaves attempts where claim put them`, `› a second reclaim after commit finds nothing — one interruption is counted once`. |
| M4b | `reapStale` `requeued`의 같은 삭제 | `test/reap-grid.spec.ts test/reaper.spec.ts` | 6 failed — grid의 `reapStale` 같은 5개 + `reapStale › requeues a stale job whose retry budget is spent but whose interruptions are not`. |
| M4c | `_REAP_SQL` `requeued`의 같은 삭제 | `tests/test_reap_grid.py tests/test_db_lifecycle.py` | 13 failed — grid 10개(양쪽 선택자 각 5개) + `test_reap_stale_requeues_a_job_whose_retry_budget_is_spent`, `test_transitions_keep_the_counter_invariants`, `test_a_late_shutdown_from_the_old_owner_is_refused_after_reclaim`. |
| M5a | `reclaimOrphaned` 판정 둘을 `attempts < max_attempts`/`>=`로 되돌림(`orphaned`에 `attempts, max_attempts` 재-SELECT) | `test/reap-grid.spec.ts` | 5 failed — `reclaimOrphaned` 케이스 `spent attempts no longer decide a reclaim`, `third interruption fails under the default limit`, `limit 1 fails on the first interruption`, `lens exhausted fails its run`, `enroll exhausted fails the speaker`. 핵심 회귀(`attempts=max_attempts, interruptions=0`인 `running`이 `failed`로 잘못 감)를 정확히 잡음. |
| M5b | `reapStale` 같은 되돌림 | `test/reap-grid.spec.ts` | 5 failed — 같은 5개 케이스, `reapStale`. |
| M5c | `_REAP_SQL` 같은 되돌림 | `tests/test_reap_grid.py` | 10 failed — 양쪽 선택자 각 5개. |
| M6 | `failed_interrupted`(TS)의 `interruptions = j.interruptions + 1` 삭제 | `test/reap-grid.spec.ts` | 5 failed — `reclaimOrphaned › {third interruption fails under the default limit, limit 1 fails on the first interruption, summary exhausted fails its row, lens exhausted fails its run, enroll exhausted fails the speaker}`. |
| M7 | `dispatch.py` 재시도 판정 `spent < …` → `job["attempts"] < …` | `tests/test_worker_loop.py` | 1 failed — `test_transient_error_requeues_when_only_interruptions_used_the_budget`(`assert 'failed' == 'requeued'` — 중단만 예산을 썼는데도 `failed`로 잘못 감). |
| M8 | `requeue` 백오프의 `- interruptions` 삭제 | `tests/test_reap_grid.py` | 3 failed — `test_retry_grid_failures_and_backoff[a3-i1]`, `[a4-i1]`, `[a5-i1]`(`interruptions>0`인 세 행. 예: `attempts=5,interruptions=1` 기대 240초인데 480초). |
| M9 | `requeue_for_shutdown`에 `interruptions = greatest(interruptions - 1, 0),` 추가 | `tests/test_db_lifecycle.py` | 2 failed — `test_transitions_keep_the_counter_invariants`, `test_requeue_for_shutdown_leaves_interruptions_alone`(둘 다 `interruptions` 기대값 1인데 0으로 내려감). |
| M10 | `findStatus`의 `'failures', j.attempts - j.interruptions` → `'failures', j.attempts` | `test/status-retry.spec.ts` | 1 failed — `findStatus retry › reports failures (attempts − interruptions), max_attempts, interruptions and the next attempt time`. |
| M11 | 배너의 `retryInterruptions > 0 ?` 조건 제거(항상 붙임) | `src/pages/meeting.test.tsx` | 1 failed — `중단이 없으면 중단 문구를 붙이지 않는다`(`interruptions=0`인데 "중단 0회"가 붙음, `queryByText(/중단 \d+회/)`가 non-null). |
| M12 | `026`의 `DEFAULT 3` → `DEFAULT 5` | `test/migration.spec.ts test/reap-grid.spec.ts` | 10 failed — `migration › {026 adds interruptions (default 0) and max_interruptions (default 3) with CHECKs, 026 keeps rows that pre-date it: attempts and max_attempts untouched, counters defaulted}` + grid에서 한도를 생략해 DEFAULT를 타는 4개 케이스 × 양쪽 회수(`third interruption fails under the default limit`, `summary exhausted fails its row`, `lens exhausted fails its run`, `enroll exhausted fails the speaker`) = 8. |
| M13a | `reclaimOrphaned` `fail_meetings`의 `AND m.current_job_id = f.id` 삭제 | `test/reclaim.spec.ts` | 1 failed — `reclaimOrphaned › does not fail a meeting whose current job is a newer one (spec §6.1)`. |
| M13b | `reapStale` 같은 삭제 | `test/reaper.spec.ts` | 1 failed — `reapStale › does not fail a meeting whose current job is a newer one (spec §6.1)`. |
| M13c | `_REAP_SQL` 같은 삭제 | `tests/test_db_lifecycle.py` | 1 failed — `test_reap_stale_leaves_a_meeting_whose_current_job_is_newer`(`assert 'failed' == 'processing'`). |
| M14 | 배너 삼항을 stage 먼저로 되돌림 | `src/pages/meeting.test.tsx` | 1 failed — `앞 시도의 stage가 남아 있어도 재시도 대기가 이긴다 (스펙 §6.2)`. |
| M15 | `requeue`의 `error=%s,` 삭제(인자 튜플도 맞춤) | `tests/test_db_lifecycle.py tests/test_worker_loop.py` | 3 failed — `test_requeue_stores_the_error_it_retries_for`, `test_transient_error_requeues_when_attempts_left`, `test_transient_error_requeues_when_only_interruptions_used_the_budget`(뒤 둘은 `row["error"]["code"]`에서 `TypeError: 'NoneType' object is not subscriptable` — `error`가 전혀 안 쓰여 `None`). |

**초록이었던 변이: 없음.** 21개 행 모두 표에 적힌 명령으로 첫 시도에 빨간불이 났다 — 테스트를 보강할 필요가 없었다. 동치 변이로 판정한 행도 없다.

**도구 오류·컨테이너 기동 실패·수집 0건**은 한 번도 없었다 — 매 변이 실행에서 grid는 22개(reap 11×2 언어단위 또는 reap-grid 케이스 수), status-retry는 5개, meeting.test.tsx는 42개, worker 쪽은 해당 파일의 전체 수집이 보고돼 "0건 수집"이 아님을 확인했다.

## 2. 완료 기준 판정

(Task 9 뒤에 채운다.)
