# Electron Phase 2 — 서비스 실행 통합 실행 결과

브랜치: `feat/electron-migration-phase-2-service-orchestration`
분기점: `dev` (`2764ffd`)
스펙: [2026-09-12-electron-phase-2-service-orchestration-design.md](../specs/2026-09-12-electron-phase-2-service-orchestration-design.md)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 2. 서비스 실행 통합"

**상태 (2026-09-12): 스펙 리뷰 통과. 구현 계획 작성 예정. 구현 미착수.**

이 문서는 로드맵이 정한 네 기록을 구분해 담는다 — 스펙 리뷰, 계획 검증, 단계별 실행·리뷰,
최종 검증. 아직 채워지지 않은 절은 그 사실을 적어 둔다. **실행하지 않은 검증을 성공으로
가정하지 않는다.**

## 1. 스펙 리뷰

### 1.1 외부 리뷰 — Codex CLI (스펙 초안 대상)

스펙을 쓰기 **전**, 설계 초안을 Codex CLI에 넘겨 저장소를 직접 읽고 반박하게 했다.

| | |
| --- | --- |
| 검토자 | Codex CLI (`codex exec`, read-only 샌드박스, `model_reasoning_effort=high`) |
| 세션 | `01a09388-4831-7053-a6a5-7131e8e54948` |
| 대상 | 설계 초안 D1~D14 (문서화 전, 대화 내 제시안) |
| 프롬프트 방식 | 내가 좁힌 선택지의 판정이 아니라 **저장소를 읽고 내가 놓친 것을 찾는** 열린 과제. 이미 확인한 7건(V1~V7)을 명시해 중복을 막았다 |
| 결과 | 10건 지적. 7건 반영, 1건 부분 오류, 1건 기존 성질로 인계, 1건 이미 반영됨 |

각 지적의 근거는 **메인 세션이 직접 재확인했다.** 판정과 반영 위치는 스펙 §17의 표에 있다.
설계를 뒤집은 것은 셋이다.

| 지적 | 재확인한 근거 | 스펙의 반영 |
| --- | --- | --- |
| `supervisor <id> started`가 DB 연결 **전**에 찍힌다 | `__main__.py:296`이 로그, `:298`이 `run_supervisor()`, 실제 연결은 그 안 `:107`의 `_reconnect()` | §6.6·§10에 ready 로그 추가. P2-C10 |
| 녹음 중 종료가 `LiveRecorder.stop()`을 건너뛴다 | `fe/src`에 `beforeunload`·`pagehide` 훅 **0건**. `jobs.py:330,350`이 live job을 `requeue_for_shutdown`이 아니라 `fail_live_preview`로 닫는다 | §6.9 close handshake, §10 `fe/` 훅. P2-C13 |
| 부팅 뒤 DB 끊김에 API가 fail-fast하지 않는다 | fail-fast는 `database.service.ts`의 `onModuleInit`에만 있다. 이후는 `/api/health` 503 | §6.6 상태 모델 분리. P2-C11 |

**반박한 것 1건.** Codex는 handshake를 넣으면 Phase 1의 무-IPC 조건을 유지할 수 없다고 했다.
`webContents.executeJavaScript()`는 평가 결과를 Promise로 돌려주므로 main이 완료를 기다릴 수 있고,
방향이 main → 렌더러라 렌더러가 먼저 여는 채널은 생기지 않는다. 스펙 §6.11이 그 경계를 적는다.

**부분 오류 1건.** "`ps` 탐지가 `--once` 자식을 supervisor로 오인한다"는 `__main__.py:279`가 자식을
`[sys.executable, "-m", "damwha_worker", "--once"]`로 띄우므로 argv로 구분 가능하다. 구현이 그
필터를 빠뜨리면 실제로 일어나는 일이라, 지적을 기각하지 않고 **필터를 스펙 §6.5에 명시**했다.

### 1.2 내부 리뷰 — 메인 세션 (쓰인 스펙 대상)

| | |
| --- | --- |
| 검토자 | 메인 세션 (로드맵 §"스펙 리뷰"는 이 단계를 서브 에이전트에 넘기지 않는다) |
| 대상 커밋 | `2e180a0` — `docs: Electron Phase 2 — 서비스 실행 통합 스펙을 쓴다` |
| 검토 항목 | 로드맵 범위·완료 기준과의 부합, `be/CLAUDE.md`의 불변식과의 충돌, 실패·중단·재시작·데이터 보존 조건, 완료 기준의 관찰 가능성, 내부 모순 |

**로드맵 부합** — Phase 2 범위 5개 항목과 완료 기준 4개가 모두 스펙의 절·기준에 대응한다
(스펙 §14). 누락 없음.

**기존 계약과의 충돌** — 없음. 확인한 것:

- `WORKER_ID`를 실행마다 바꾸는 것이 reaper·소유권 가드와 충돌하지 않는다. `requeue_for_shutdown`은
  같은 프로세스가 자기 id로 부르고, reaper는 `locked_at` 나이로만 판정하며,
  `app_setting.worker_capabilities`는 단일 행이라 id가 값으로 들어갈 뿐이다.
- 라이브 바이트 경계(`job.committed_bytes`)를 건드리지 않는다. handshake는 화면의 중지 버튼과
  **같은 경로**를 부르도록 계약했다(§10).
- storage key는 상대 키라는 서비스 계약을 유지한다. 앱은 `STORAGE_ROOT`만 주입한다.

**지적 4건. 전부 조치했다.**

| # | 등급 | 지적 | 조치 |
| --- | --- | --- | --- |
| S-1 | 차단 | **P2-C10의 확인 수단이 "구현 계획이 정한다"로 열려 있었다.** 로드맵 §"구현 스펙"은 각 기준을 "어떤 환경에서 어떻게 확인할지" 적으라고 한다. 또 원안대로 worker에게만 다른 `DATABASE_URL`을 주려면 `config.json`에 검증 전용 키를 새로 파야 했다 | 기준을 다시 썼다 — `docker compose stop postgres` 후 worker supervisor를 밖에서 죽여 앱의 재시작을 발화시킨다. 같은 조건(연결 못 하는 worker)을 설정 조작 없이 만든다. §12의 미확정 항목에서도 제거 |
| S-2 | 차단 | **worker의 `degraded` 신호가 비어 있었다.** worker는 API와 같은 모양의 문제를 갖는다 — ready 뒤 DB가 끊기면 `_reconnect()` 루프에 들어가 프로세스는 살고 큐만 멈춘다(`__main__.py:117-124`). §6.6이 API에 대해서만 상태를 나눠 놓고 worker는 `—`로 비워 둔 것은 같은 결함을 반만 고친 것이다 | §10의 ready 로그를 **`_reconnect()`가 성공할 때마다** 찍도록 바꿨다. 한 줄이 ready·degraded·회복 셋을 다 준다. §6.6의 표를 채우고 worker 테스트를 두 개(첫 연결, 재연결)로 늘렸다 |
| S-3 | 경미 | **P2-C9의 "복제 DB"를 만드는 방법이 없었다.** 데이터 안전이 걸린 기준에서 방법을 비워 두면 계획이 위험한 수단을 고를 수 있다 | 같은 클러스터에 빈 데이터베이스를 만들고(`CREATE DATABASE damwha_migration_gate`) `config.json`이 그것을 보게 한 뒤 확인 후 `DROP`하도록 명시. `damwha`와 `damwha_pgdata`는 손대지 않는다 |
| S-4 | 경미 | **P2-C4가 `mlx_lm.server`가 뜬 적 있는 상태를 요구하는데 그 조건을 못 만들 수 있다**(LLM 모델 미다운로드). 만들 수 없을 때 기준이 어떻게 판정되는지 적혀 있지 않았다 | 대안을 비고로 명시 — `--once` 자식이 있는 상태에서 강제 종료를 걸어 §6.9 4단계의 자손 SIGKILL이 세션이 다른 자식을 잡는지로 판정한다. `mlx_lm.server`를 잡는 근거와 같은 근거다. 조건을 못 만들었으면 **그 사실을 증거에 적는다** |

**재검토 결과: 통과.** 범위·계약·데이터 안전성·완료 기준에 영향을 주는 지적이 남아 있지 않다.
수정 커밋은 아래 §1.3.

### 1.3 사용자 승인

2026-09-12, 사용자가 스펙의 범위와 주요 동작을 승인했다. 승인 전에 대화에서 확정한 결정 10건은
스펙 본문에 반영돼 있다 — DB는 기동까지·종료는 안 함, 실행 파일 탐색 + PATH 보강, 창 닫기 ≠ 종료,
녹음·분석 둘 다 종료 확인, embed 채택·worker 비기동, worker에 ready 신호 추가, dev도 같은 서비스
집합, 저장소 경로는 첫 실행에 폴더 선택, 마이그레이션은 감지·안내만, Phase 2를 건너뛰지 않음.

| 커밋 | 내용 |
| --- | --- |
| `2e180a0` | 스펙 최초 작성 |
| (다음 커밋) | 내부 리뷰 지적 S-1~S-4 반영 |

## 2. 계획 검증

| | |
| --- | --- |
| 검토자 | 메인 세션 (로드맵 §"계획 검증"은 이 단계를 서브 에이전트에 넘기지 않는다) |
| 대상 커밋 | `c1a162b` — `docs: Phase 2 구현 계획을 쓴다 — 15 Task` |
| 계획 | [2026-09-12-electron-phase-2-service-orchestration.md](../plans/2026-09-12-electron-phase-2-service-orchestration.md) — 15 Task, 4,575줄 |

### 2.1 완료 기준과 구현 단계의 연결

**15건 전부 연결됐다.** 각 기준은 그것을 만드는 Task와 그것을 판정하는 Task 15의 Step을 함께 갖는다.

| 기준 | 만드는 Task | 판정 |
| --- | --- | --- |
| P2-C1 터미널 없이 전체 준비 | 3, 5, 6, 8, 12 | 15 Step 3 |
| P2-C2 `.env` 불변 처리 완주 | 8 (env 주입), 12 | 15 Step 4 |
| P2-C3 의미 검색 | 8 (`EMBED_PORT` 단일 파생) | 15 Step 4 |
| P2-C4 트리 정리 0개 | 11, 13 | 15 Step 5 |
| P2-C5 정중한 종료와 `attempts` | 11, 13 | 15 Step 5 |
| P2-C6 외부 서비스 보존 | 4, 8 | 15 Step 6 |
| P2-C7 Docker 데몬 없음 | 5, 14 | 15 Step 7 |
| P2-C8 실행 파일 못 찾음 | 2, 8, 14 | 15 Step 7 |
| P2-C9 마이그레이션 게이트 | 6 | 15 Step 8 |
| P2-C10 worker 준비 오판 방지 | 7, 8 | 15 Step 9 |
| P2-C11 부팅 뒤 DB 끊김 | 3, 6 | 15 Step 9 |
| P2-C12 창 닫기와 앱 종료 | 12 | 15 Step 10 |
| P2-C13 녹음 handshake | 10, 11, 13 | 15 Step 10 |
| P2-C14 회귀와 번들 위생 | 12, 전 Task | 15 Step 11 |
| P2-C15 데이터 보존 | 5 (`stop` 없음), 6 (게이트) | 15 Step 12 |

### 2.2 지적 6건. 전부 조치했다.

| # | 등급 | 지적 | 조치 |
| --- | --- | --- | --- |
| V-1 | 차단 | **정의되지 않은 식별자 5개** — `saveConfigValue`·`logPathOf`·`currentGraceAnswer`·`appendSupervisorLog`·`reattachWindow`가 이름만 등장했다. 계획을 순서대로 읽는 구현자는 이 자리에서 막힌다 | Task 12에 넷의 구현을 넣고, `currentGraceAnswer`는 Task 13에 모듈 변수로 명시했다 |
| V-2 | 차단 | **`renderStatus`의 시그니처가 두 Task에서 달랐다** — Task 12가 `(s, mine)`로 부르고 Task 14가 `(statuses)`로 정의했다 | 호출부를 `onStatus: renderStatus`로 맞췄다 |
| V-3 | 차단 | **Task 12가 Phase 1의 전역 `apiOrigin`을 그대로 쓴다고 가정했다.** 새 `apiSpec`은 origin을 `LaunchResult`로 돌려주므로 그 전역은 더 이상 채워지지 않는다 | `currentApiOrigin()`을 더해 감독자 런타임에서 읽게 하고, 렌더러 부착을 `reattachWindow(mine)` 하나로 모았다 |
| V-4 | 차단 | **packaged 산출물 경로가 틀렸다** — Task 15가 `desktop/build/mac*/Damwha.app`을 봤지만 `electron-builder.yml`의 `directories.output`은 `out`이고 `check-bundle.mjs`도 `desktop/out/mac-arm64/Damwha.app`을 본다. `desktop/build`는 `pnpm deploy`의 API 스테이징 디렉터리다 | 경로를 `desktop/out/mac-arm64/Damwha.app`으로 고쳤다 |
| V-5 | 중간 | **감독자가 Phase 1의 `waitForReady`를 우회 사용했다** — `ReadinessResult`의 `failed`를 `"db-unreachable"`에 태워 조기 탈출시켰다. 그 함수의 결과 어휘는 API 하나를 위한 것이라, 다음 사람이 그 값을 DB 이야기로 읽는다 | 감독자가 자기 폴링 루프를 갖게 했다(여덟 줄). `waitForReady` import를 지웠다 |
| V-6 | 경미 | **`dialog` import가 빠졌다** — `main.ts`는 `{ app, BrowserWindow }`만 가져오는데 Task 12·13이 `dialog`를 쓴다 | Task 12 Step 5에 import 줄을 명시했다 |

### 2.3 그 밖에 확인한 것

- **명령이 실제로 존재한다.** `pnpm --filter damwha-desktop exec vitest`(vitest 4.1.9 devDep 확인), `pnpm worker:test -- -k`(루트 스크립트가 `uv run --directory be/worker pytest -q`), `pnpm --filter damwha-fe exec vitest`(fe에 vitest 4.1.9), `node desktop/scripts/check-bundle.mjs`(인자 없음), `pnpm be:start`(`node dist/main.js`), `pnpm --filter damwha-desktop run compile`.
- **각 Task가 개별 리뷰 가능하다.** 15개 Task 전부에 `Verify`·`Review` 블록이 있다(로드맵 §"계획 실행"의 형식 요구). Task 12까지 종료는 Phase 1 동작 그대로이고 Task 13이 바꾼다 — 감독자와 종료를 따로 리뷰할 수 있다.
- **파괴적 명령을 전수 확인했다.** `CREATE/DROP DATABASE`는 Task 6 Step 6과 Task 15 Step 8 둘뿐이고 대상은 새로 만든 빈 DB이며 정리 단계가 붙어 있다. `docker compose down`은 Task 15 Step 3에서 한 번 쓰는데 검증자가 "전부 꺼진 상태"를 만드는 행위이고 `-v`가 없어 볼륨을 지우지 않는다. 앱 코드에는 `down`·`stop`·`rm`이 없다(Task 5의 Verify가 `grep`으로 판정).
- **스펙 밖의 작업이 없다.** 계획의 모든 Task가 스펙 §6~§10의 절로 되짚어진다. 스펙 변경이 필요해진 항목도 없다.

**재검증 결과: 통과.** 지적 6건을 반영한 뒤 다시 훑어 정의 없는 식별자 0건, 시그니처 불일치 0건,
경로 불일치 0건을 확인했다.

## 3. 단계별 실행과 리뷰

**아직 수행하지 않았다.** 각 단계의 구현 커밋, 검증 명령과 출력, 리뷰 대상 diff와 지적·조치를
단계마다 기록한다.

## 4. 최종 검증

**아직 수행하지 않았다.** 완료 기준 P2-C1~P2-C15의 판정과 증거를 기록한다. 판정 값은 실제
실행 결과로만 채운다.

## 5. 남은 제약과 후속 Phase 인계

**아직 채우지 않았다.** 스펙 §15가 현재까지 식별한 인계 항목을 담고 있다 —
Phase 3의 마이그레이션 실행 게이트, Phase 4의 `FFMPEG_BIN`/`FFPROBE_BIN`,
Phase 5의 sweeper 경로 검증, Phase 6의 job lease token 판단.
