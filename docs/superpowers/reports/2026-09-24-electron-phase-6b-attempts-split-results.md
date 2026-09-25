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

## 2. 완료 기준 판정 (P6b3-C1~C8)

controller-recorded, 2026-09-24. 빌드: HEAD `064830e`를 `pnpm desktop package:desktop`으로 packaged(`check-bundle` "all checks passed"). 번들에 `026_job_interruptions.sql`이 실려 있다.

| ID | 기준 | 판정 | 근거 |
| --- | --- | --- | --- |
| P6b3-C1 | 0.3.1 → 새 빌드 덮어쓰기에서 회의(레코드·내용·오디오)·`processing_defaults`·토큰이 유지되고, 이번 기동이 만든 적용 전 백업과 함께 `026`이 적용됨 | **충족** | §3 C1 — 전 기준선과 새 빌드 기동 뒤 값이 레코드·해시·`processing_defaults` 전부 동일, `backups/`에 `20260924T084933Z-before-026_job_interruptions.sql.dump` 신규 1건, `_migrations`에 `026` `applied_at 2026-09-24 17:49:33.264641+09` |
| P6b3-C2 | worker 자식 강제 종료 3회에 1·2회차 `queued`, 3회차 `failed`, 회수 시점의 `failures` 불변. 앱 전체 강제 종료 1회에 기동 회수가 `interruptions`만 올림 | **충족** | §3 C2a·C2b — job_46 3회 kill이 `queued(1)→queued(2)→failed(3, stale_worker)`, 회수 직후 `failures` 불변(0→0→0, claim 뒤에만 1↑); job_47 boot 회수가 `interruptions` 0→1만 올리고 `attempts`는 claim이 그 뒤 1→2로 올림(회수 자체는 불변) |
| P6b3-C3 | 중단이 있었던 job의 TRANSIENT 재시도가 5회 예산·30초 첫 백오프를 쓰고, 화면이 stage가 있어도 재시도 대기와 마지막 오류를 말함 | **생략(사유 기록)** | §3 C3 — 모델이 전부 캐시돼 P5-C4의 Wi-Fi 차단 수법으로는 다운로드 실패가 나지 않고, 그 밖의 주입(파일 권한 조작 등)은 스테이지 타이밍에 좌우돼 실데이터 위에서 재현이 안전하지 않았다. 스펙 §8.2-3이 정한 대체 증거 — §8.1: worker 판정 경로 `be/worker/tests/test_worker_loop.py`(TRANSIENT → requeue, 오류 저장), 재시도 격자 `be/worker/tests/test_reap_grid.py` + `be/test/fixtures/job-reap/grid.json`(첫 백오프 30초, `attempts − interruptions` 기준), fe 배너 `fe/src/pages/meeting.test.tsx`(재시도 문구가 stage를 이김, 마지막 오류 표시) — 셋 다 §0에서 초록 |
| P6b3-C4 | 새 판 위에 0.3.1을 올리면 `migrationUnknown`으로 거부하고 아무것도 바꾸지 않음 | **충족** | §3 C4 — 시작 페이지에 "API: 실패 / 더 새 버전의 앱이 이 데이터를 업데이트했어요 (026_job_interruptions.sql)." 표시, `supervisor.log`에 마이그레이션·백업·삭제 줄 없음, `backups/` 목록 전후 3건 동일, `_migrations` 마지막 여전히 `026`, api/worker 프로세스 미기동. 새 판 재설치 뒤 정상 기동·회의 목록 정상·중단됐던 job 재개 |
| P6b3-C5 | 공유 격자를 TS·Python 회수 넷이 모두 통과 | **충족** | §0·§1 — `be/test/reap-grid.spec.ts`(TS `reclaimOrphaned`·`reapStale`, 11케이스×2)와 `be/worker/tests/test_reap_grid.py`(Python `reap_stale`·`reap_own_orphans`, 11케이스×2)가 각각 be 552 tests·worker 757 passed 안에서 전부 초록. 격자를 겨냥한 변이(M1~M6·M12, a/b/c 포함 11행)가 모두 이 격자 테스트를 빨간불로 만들었다(§1) |
| P6b3-C6 | 밀려난 job의 소진 회수가 새 실행의 회의를 건드리지 않음 | **충족** | §6.1 케이스 — `be/test/reclaim.spec.ts`·`be/test/reaper.spec.ts`의 `'does not fail a meeting whose current job is a newer one (spec §6.1)'`, `be/worker/tests/test_db_lifecycle.py`의 `test_reap_stale_leaves_a_meeting_whose_current_job_is_newer` 셋이 초록. §1의 M13a~c(각 `fail_meetings`에서 `current_job_id` 가드를 지운 변이)가 정확히 이 세 테스트만 1건씩 빨간불로 만들어 가드가 실제로 그 테스트에 걸려 있음을 확인 |
| P6b3-C7 | 변이 M1~M15 전부 빨간불(동치는 사유 기록) | **충족** | §1 — 21개 변이 행 전부 첫 시도에 빨간불, 동치 변이·결손 없음 |
| P6b3-C8 | `pnpm test`·`pnpm lint`·`pnpm worker:test` 초록 | **충족** | §0 — 셋 다 exit 0(be 53 suites/552 tests, fe 66 files/605 tests, worker 757 passed), `ruff check` all checks passed |

## 3. 실측 기록

userData(`~/Library/Application Support/Damwha`)를 dev와 packaged가 함께 쓰므로 실데이터 위에서 돌았다. 준비: 쓰는 주체 전부(Electron·postmaster·worker·embed·LLM 자식) `pgrep` 확인 결과 비어 있음(13 GiB 여유, 98%). 복구 세트는 `models/`·Chromium 캐시를 뺀 userData 전체를 `rsync`로 `~/damwha-6b3-recovery-20260924T173744`에(783M). 새 빌드는 `desktop/out`에서 꺼내지 않았고(디스크 여유로 불필요 판단), 발행된 0.3.1은 `~/damwha-builds/Damwha-0.3.1-published.app`에 codesign 검증 보존.

### C1 — 업그레이드 보존

1. 0.3.1(published, `/Applications`)을 띄우고 회의 하나를 업로드해 `done`까지, 처리 언어를 `ko`로 변경.
2. **0.3.1이 떠 있는 동안** psql로 전 기준선을 떴다: `_migrations` 마지막 `025_job_retry_policy.sql`, `job.interruptions` 컬럼 없음(count 0). 회의 6행, 발화 해시 4개 회의, 요약 해시(mtg_6/7/8 등 done), 화자 6행, `processing_defaults` = `{"preset": "custom", "devices": {"stt": "gpu", "diarization": "gpu"}, "language": "ko", "summary_model": "mlx-community/Qwen3.5-4B-8bit", "whisper_model": "large-v3-turbo"}`, job 23행, 스토리지 파일 7개 sha256, `config.json` sha256 `c2a7a93b…`, `hf-token.bin` sha256 `107fe360…`, 클러스터 마커 `{"clusterId":"7687238228739395787","databaseOid":16384}`, 백업 2개(before-022, before-025).
3. ⌘Q로 전부 종료 확인 뒤 새 빌드를 `/Applications`에 ditto로 덮어쓰고 17:49에 기동.
4. `supervisor.log` 신규 줄: `08:49:33.206Z 마이그레이션 게이트: 적용 전 백업 — …/backups/20260924T084933Z-before-026_job_interruptions.sql.dump`, `마이그레이션 게이트: 1개 적용 — 026_job_interruptions.sql`. `_migrations`: `026_job_interruptions.sql 2026-09-24 17:49:33.264641+09`.
5. 새 기준선 대 전 기준선 비교 — 회의·발화 해시·요약 해시·화자·`processing_defaults`·job(id,type,status,attempts,max_attempts)·스토리지 파일 해시·`config.json`/`hf-token.bin` 해시·클러스터 마커 **전부 동일**. 백업 목록 차이는 신규 dump 1개뿐. job 23행, `interruptions` min/max 0/0, `max_interruptions` 3/3.
6. 화면: 옛 회의가 열리고 오디오 재생·전사·요약이 보이며 설정에 `ko`가 그대로. 토큰 재입력·마이크 재요청 없음.

### C2a — worker 자기 고아 회수 ×3

job_46(`process_meeting`, mtg_11, 오디오 ~54분). 시작: `running | attempts 1 | interruptions 0 | locked_by desktop-5fc743dc…`.

| 회차 | kill | 직후(17:5x) | 재claim 뒤 | worker.log |
| --- | --- | --- | --- | --- |
| 1 | `--once` 자식 pid 57479, 17:51:41 | 17:51:41 `queued\|attempts1\|interruptions1`(failures 0) | 17:51:44 `running\|attempts2\|interruptions1`(failures 1) | `reclaimed own orphans: requeued=1 failed=0` |
| 2 | pid 57795, 17:52:20 | `queued\|attempts2\|interruptions2`(failures 0) | 17:52:24 `running\|attempts3\|interruptions2`(failures 1) | `requeued=1 failed=0` |
| 3 | pid 58615, 17:52:47 | 17:52:48 `failed\|attempts3\|interruptions3`, `error={"code":"stale_worker","stage":"diarize","message":"worker lock expired"}`; 회의 mtg_11도 `failed`(`stale_worker`, "processing worker lost") | — | `requeued=0 failed=1` |

`failures = attempts − interruptions`가 회수 시점마다 0 → 재claim 뒤 1로 정확히 순환하고, 3회차에 `max_interruptions=3`을 태워 `failed`로 닫혔다 — §4.2 판정과 일치.

### C2b — 앱 전체 강제 종료 → 기동 회수 1회

job_47(mtg_11 재처리). 시작: `running | attempts 1 | interruptions 0 | stage diarize`.

1. `pkill -9 -f "Damwha.app/Contents/Resources/python"` 뒤 `pkill -9 -f "Damwha.app/Contents/MacOS/Damwha"`(17:54:03), postgres에는 SIGKILL 미전송. 직후: postmaster만 생존, job_47은 여전히 `running\|attempts1\|interruptions0`, `locked_by` 옛 값(desktop-5fc743dc…).
2. 재기동. `api.log`: `17:54:18 WARN [ReaperService] reclaim: requeued=1 failedLive=0 failedInterrupted=0`. job_47이 `running\|attempts2\|interruptions1`, `locked_by` 새 값(desktop-19c3f825…)으로 바뀜 — 회수가 `interruptions`만 0→1로 올리고, 그 뒤 재claim이 `attempts`를 1→2로 올렸다(회수 자체는 `attempts`를 건드리지 않음, §4.2와 일치).

### C4 — 되돌림 거부

1. ⌘Q(새 빌드)로 전부 종료. 발행된 0.3.1을 `~/damwha-builds`에서 `/Applications`에 재설치.
2. 0.3.1 기동: 네이티브 대화상자가 아니라 시작/로딩 페이지에 `API: 실패 / 더 새 버전의 앱이 이 데이터를 업데이트했어요 (026_job_interruptions.sql). / 해결: 이 데이터를 업데이트한 브랜치나 앱 버전으로 실행하거나, config.json의 DEBUG_EXTERNAL_DATABASE_URL로 외부 DB를 쓰세요.` 표시.
3. `supervisor.log` 신규 줄: `2026-09-24T08:58:08.006Z api: 기동 실패 — 더 새 버전의 앱이 이 데이터를 업데이트했어요 (026_job_interruptions.sql).` — 마이그레이션·백업·삭제 줄 없음. `backups/` 목록 전후 동일(3개 파일). `_migrations` 마지막 여전히 `026`. api·worker 프로세스 미기동.
4. `osascript -e 'quit app "Damwha"'`로 종료 — (모달이 아니라 시작 페이지라) 즉시 수락, 프로세스 전부 종료. 새 빌드 재설치 후 기동: 마이그레이션·백업 줄 없음, 백업 3개 그대로, 회의 목록 정상, 중단됐던 job이 재개.

## 4. 관찰

- **중첩 마이그레이션 디렉터리.** 발행된 0.3.1과 새 빌드 둘 다 `api/dist/database/migrations/migrations/`라는 중첩 디렉터리를 담고 있다 — 기존 패키징 특이점으로, `migrate.ts`가 최상위 `*.sql`만 읽으므로 무해하다.
- **자기 고아 회수 소진 메시지.** C2a 3회차의 `error.message`가 "worker lock expired"인 것은 `reapStale`과 공유하는 `_REAP_SQL` 문구 그대로다(기존 동작, 이 Phase가 바꾸지 않음). `failed`로 닫힌 행이 `locked_by`를 그대로 쥐고 있는 것도 기존 `failed` 분기 동작이다. 둘 다 범위 밖.
- **C4 거부의 표면.** 되돌림 거부가 네이티브 대화상자가 아니라 시작/로딩 페이지에 뜬다 — 6b-1의 업데이트 알림 대화상자와는 다른 표면이라, ⌘Q 대체 수단인 `osascript quit`이 모달 거절(`User canceled`) 없이 바로 먹혔다.
- **⌘Q는 `interruptions`를 건드리지 않는다.** job_47은 ⌘Q 전 `running\|attempts2\|interruptions1`이었고, 정상 종료 후 재기동에서도 `running\|attempts2\|interruptions1`로 같다 — `requeue_for_shutdown`의 −1과 재claim의 +1이 상쇄돼 `attempts`가 그대로고, `interruptions`는 애초에 ⌘Q 경로가 건드리지 않는다(스펙대로).

## 5. 최종 리뷰와 수정

최종 whole-branch 리뷰(opus, `24331f6..5566993` 범위)의 판정은 **"With fixes"** — Critical 0, Important 2:

1. `be/CLAUDE.md` :32·:65의 재시도·회수 서술이 스펙 §10이 요구한 갱신을 누락(옛 `attempts` 규칙 그대로).
2. 재시도 배너가 재시도 문구로 넘어간 뒤에도 옛 진행률(%)을 이어 붙임(`meeting.tsx` ~165).

수정 라운드가 둘 다 고쳤다 — `ab53aeb`(`fix(fe): 재시도 배너가 옛 진행률을 덧붙이지 않는다`)와 `064830e`(`docs(phase6b): 최종 리뷰 지적 셋을 반영한다` — `be/CLAUDE.md`, `orphans.ts:318-322` 주석, 스펙 §8.2-2b 정정 문단 셋). 재검토는 4/4 해소를 확인했지만 잔여 1건을 새로 찾았다 — `be/CLAUDE.md:65`가 "`max_interruptions`를 소진한 회수는 `error`에 `app_restarted`를 찍는다"고만 적어, 실제로는 boot-time `reclaimOrphaned`에만 참이고 `reapStale`·worker의 `reap_stale`/`reap_own_orphans`는 `stale_worker`를 찍는 사실(`be/src/jobs/jobs.repository.ts:154,165` vs `:245`, `be/worker/damwha_worker/db/queue.py:143`으로 검증)을 가린다는 것이다. 별도 리뷰 라운드를 새로 열지 않고 이 Task 9 문서 커밋에 그 한 절만 접어 고쳤다(`be/CLAUDE.md` "Failure classification and retry timing" 절).

**보류(parked)한 지적 넷** — 최종 리뷰 라운드가 냈으나 이 Phase에서 고치지 않기로 한 것:

- requeue된 job의 `error`에 traceback이 그대로 실린다 — 스펙이 `error` 보존을 받아들였고 fe는 `.code`만 읽는다. 유지; `/status` 페이로드 크기가 문제되면 재검토.
- 공유 격자에 `extract_lenses`/`enroll_speaker`의 requeue 케이스가 없다 — 실재하는 간극이나 저위험(딸린 행이 requeue에서 안 바뀌는 것은 `process_meeting`/`summarize_meeting`에서 이미 커버). 나중으로.
- §8.1의 dispatch→`findStatus` 경로가 두 반쪽 테스트로만 커버된다 — 오류 모양(`code` 최상위)이 양쪽에서 일치함을 확인했고, 원래 이번 C3 packaged 점검이 전체 경로를 잡을 계획이었다(§2, C3 생략으로 이 몫은 §8.1 대체 증거에 흡수).
- `be/worker/SMOKE.md:258`가 `max_attempts` 기본값을 3이라 적고 있다(`025`가 5로 올린 뒤로도 기존 오기) — 범위 밖.

## 6. 남은 일

- **6b-2(백업·복원·실패 복구)는 이 브랜치가 `dev`에 병합된 뒤 새 브랜치에서 시작한다.** `026_job_interruptions.sql`이 그 시험 대상 스키마 변경이다 — 0.3.1과 병합 전 `dev`는 둘 다 `025`에서 끝나 실제 마이그레이션 없이는 백업·복원을 시험할 대상이 없었다(스펙 §1).
- **`v0.4.0` 릴리스는 6b-2까지 병합된 뒤에 낸다.**
- **`be/docs/backlog.md`에 항목 둘을 남겼다**(`ef73b70`) — 재처리의 상태 확인이 트랜잭션 밖이라 동시 재처리에서 job 둘이 enqueue될 수 있는 경합(§2.2 제외 항목의 앞 절반, §6.1 가드는 그 경합이 회수로 번지는 끝만 막는다), `--once` 스캔 실패 뒤 재시작이 같은 `WORKER_ID`의 자식 둘을 겹치게 할 수 있는 문제(코덱스 스펙 리뷰 #2, Phase 5부터의 기존 결함).
