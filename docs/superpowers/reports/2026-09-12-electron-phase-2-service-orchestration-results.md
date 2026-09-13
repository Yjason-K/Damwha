# Electron Phase 2 — 서비스 실행 통합 실행 결과

브랜치: `feat/electron-migration-phase-2-service-orchestration`
분기점: `dev` (`2764ffd`)
스펙: [2026-09-12-electron-phase-2-service-orchestration-design.md](../specs/2026-09-12-electron-phase-2-service-orchestration-design.md)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 2. 서비스 실행 통합"

**상태 (2026-09-13): 구현 완료. packaged 통합 검증에서 완료 기준 P2-C1~P2-C15 15건 충족 (§4).** 검증 중 드러난 결함 4건은 이 브랜치에서 고친 뒤 다시 판정했다(§4.2). 남은 제약과 인계는 §5.

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
| `039d40c` | 내부 리뷰 지적 S-1~S-4 반영, 결과 문서 개설 |
| `c1a162b` | 구현 계획 작성 (15 Task) |
| `e582948` | 계획 검증 지적 V-1~V-6 반영 |

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

## 2.4 사전 실측 (계획 Task 1)

구현 전에 스펙 §12의 미확정 둘을 실측으로 닫았다. 측정이 계획의 결함 하나를 잡았다.

| 항목 | 측정값 (2026-09-12, 이 기계) |
| --- | --- |
| Docker Compose | v5.5.0 |
| `ps --format json` 형태 | **JSONL** (줄마다 객체, 배열 아님). 필드 `Name`·`Service`·`State`·`Health` |
| running + healthy | `{"State":"running","Health":"healthy"}` |
| 멈춘 컨테이너 | `ps`에서 **빠진다.** `ps -a`에만 `{"State":"exited","Health":""}` → **`-a` 필수** |
| 데몬 없음 | exit **1**, stdout 빈 문자열, stderr `failed to connect to the docker API at unix://…; check if the path is correct and if the daemon is running: …` |
| GUI 앱 PATH | `launchctl getenv PATH`가 비어 있다 → 시스템 기본 `/usr/bin:/bin:/usr/sbin:/sbin`. 그 넷에 `uv`·`docker` **둘 다 없다**(실제 `/opt/homebrew/bin/uv`, `/usr/local/bin/docker`) |
| 최소 PATH + 절대 경로 uv | `uv run --directory be/worker python -c …` → `ok 3.12.13`. **동작한다** |
| embed 준비 시간 | `/health` 200까지 **31초** (따뜻한 모델 캐시) |
| embed `/embed` 응답 | `model=BAAI/bge-m3`, `dimension=1024`, 벡터 길이 1024 |

**측정이 잡은 계획 결함 1건.** 계획의 `DAEMON_DOWN` 정규식
`/cannot connect to the docker daemon|is the docker daemon running/i`가 **실제 문구를 잡지 못한다** —
Docker가 "failed to connect to the docker API … if the daemon is running"으로 말한다. 세 패턴으로
넓히고(옛 문구 포함) Task 5 테스트에 두 케이스를 각각 뒀다. 이것이 Task 1을 구현 앞에 둔 이유다.

**측정이 확인한 설계 판단 1건.** embed 31초는 사전 스캔의 C-4(비게이트 서비스가 직렬로 대기해
실제로는 게이트가 된다)가 실제 문제였음을 뜻한다. 그 31초가 창 표시를 그만큼 늦췄을 것이다.
감독자가 비게이트를 배경으로 돌리도록 고쳤고, embed에는 서비스별 준비 유예 180초를 뒀다.

## 3. 단계별 실행과 리뷰

실행 방식은 사용자가 고른 **Subagent-Driven Development**다 — Task마다 새 구현자를 붙이고,
구현이 끝나면 그 diff만 보는 리뷰어를 따로 붙인다. 지적이 남으면 수정 라운드를 열고 범위를
좁힌 재리뷰로 닫는다. 판정(Ruling)은 전부 원장
(`.superpowers/sdd/2026-09-12-electron-phase-2-service-orchestration/progress.md`)에 남겼다.

리뷰가 "초록불인데 아무것도 지키지 않는 테스트"를 반복해서 통과시켰기 때문에, Task 6부터는
**변이 증거**를 리뷰·재리뷰의 필수 제출물로 바꿨다. 프로덕션 코드를 일부러 망가뜨렸을 때
어떤 테스트가 어떤 문구로 실패하는지를 그대로 붙이지 않으면 "검증했다"로 인정하지 않는다.
이 규칙이 실제로 잡아낸 것이 아래 표의 마지막 열이다.

### 3.1 단계별 결과

| Task | 내용 | 커밋 범위 | 수정 라운드 | 그 라운드가 연 이유 |
| --- | --- | --- | --- | --- |
| 1 | 사전 실측 | (문서) | — | 실측이 계획 2건을 고쳤다 (§2.4) |
| 2 | 실행 파일 탐색 · 저장소 루트 | `44829ef..d14425a` | 0 | — |
| 3 | 감독자 골격 (위상 정렬 · 게이트) | `d14425a..9800151` | 0 | — |
| 4 | postgres 어댑터 | `6365bff..92bd3d1` | 1 | compose 상태 파싱이 실패를 삼켰다 |
| 5 | api 어댑터 · 마이그레이션 게이트 | `92bd3d1..93304fb` | 1 | Critical 예외 전파 + `-a` 미고정 |
| 6 | 준비 판정 · 두 축 상태 | `93304fb..bbff894` | 1 | 게이트가 읽는 스트림이 틀렸다 (아래) |
| 7 | 재시작 정책 | `bbff894..892d16f` | 0 | — |
| 8 | worker 어댑터 · `launchWithUv` | `892d16f..39e2979` | 1 | 스트림 분리 · `as never` 제거 · 런처 무검증 |
| 9 | embed 어댑터 | `56000bf..a8cc48c` | 0 | — |
| 10 | 렌더러 브리지 (`__damwha_desktop`) | `a8cc48c..06a6bed` | 1 | `isLiveCapture` 가드가 무검증이었다 |
| 11 | 종료 정책 | `06a6bed..ea6a818` | 3 | 진입 가드·자손 스냅샷·`leaked` 정직성, `processExists`·재스냅샷 무검증 (§3.3) |
| 12 | main 배선 · 창 흐름 · 상태 채널 | `717d5ec..cf66e4a` | 3 | 재시도의 config 재적용이 embed 포트 파생을 어긋내고 `WORKER_ID`를 재발급했다. 테스트할 수 없는 `main.ts` 잎을 모듈 6개로 분리 |
| 13 | 종료 흐름 배선 (quit · close · handshake) | `cf66e4a..e90d5d3` | 5 (차단기 판정) | 내 판정 "⌘Q 직후 종료 화면"이 handshake 전에 렌더러를 파괴했다. "false = 계속 기다리기"가 된 뒤 `?? Promise.resolve(false)` 기본값이 무한 대기가 됐다 |
| 14 | 실패 표시 (상태 창 · 원인 카탈로그) | `e90d5d3..6362561` | 3 | degraded 안내가 사람이 움직여야 풀리는 원인을 가렸다. 같은 view를 두 번 그려 실시간 갱신을 지키지 못하는 테스트 |
| 최종 | whole-branch 리뷰 → 수정 1회 + 재리뷰 1회 | `6362561..e00cf9b` | 1 | 아래 §3.2 "최종 리뷰가 잡은 것" |
| 15 | packaged 통합 검증 | `9602c5f`, `24f9080`, `ccb407a`, `6d22ed5` | — | §4.2의 결함 4건 |

### 3.2 이 단계들에서 실제로 잡힌 결함

기록할 값이 있는 것만 적는다. 전부 리뷰 또는 컨트롤러의 독립 확인이 잡은 것이고, 구현자의
자기 보고로 드러난 것은 없다.

**마이그레이션 게이트가 틀린 스트림을 읽고 있었다 (Task 6).** 스펙 §6.7이 "앱은 Phase 1부터
API의 stderr를 받고 있다"고 적었는데 **사실이 아니었다.** NestJS `ConsoleLogger`는 `.error()`만
stderr로 보내고 미적용 마이그레이션 경고는 `.warn()`이라 **stdout**으로 나간다. Phase 1의
`makeSink`는 stderr만 축적했으므로 게이트는 영원히 빈 문자열을 읽는다 — 즉 게이트가 조용히
꺼진 채로 초록불이었다. `stdoutTail()`을 따로 만들어 고쳤다(`330e892`).
**내 검증 절차 자체가 이 결함을 가렸다**: 확인 명령에 `2>&1`을 써서 두 스트림을 합쳐 버렸다.
그 절차도 함께 고쳤다(`f45a764`).

**게이트 아닌 서비스가 사실상 게이트였다 (사전 스캔).** 계획대로면 비게이트 서비스도 순차
`await`이라 embed의 실측 31초가 창 표시를 그만큼 늦춘다. 실행 전 스캔이 잡아 배선을 바꿨다.

**재시작 정책을 아무도 읽지 않았다 (사전 스캔).** 타입에 선언돼 있고 어댑터가 전부 값을
채우는데 그 값을 읽는 코드가 없었다. 그대로 뒀으면 완료 기준 P2-C11을 **판정할 수 없다.**

**초록불인데 아무것도 지키지 않는 테스트 — 5회.** 전부 같은 모양이다: 테스트를 위해 주입
구멍을 만들었고, 모든 테스트가 가짜를 주입했고, 실제 경로는 한 번도 실행되지 않았다.

| Task | 지키지 못하던 것 | 그대로 뒀을 때 |
| --- | --- | --- |
| 3 | 비게이트 배경 실행 성질 (18/18 초록) | 창이 embed를 기다린다 |
| 6 | `stdoutTail` 배선 (150/150 초록) | 마이그레이션 게이트가 죽어 있다 |
| 8 | `detached: true`와 `'error'` 리스너 (179/179 초록) | 손자 프로세스가 남고, spawn 실패가 main을 죽인다 |
| 10 | 실제 `hasLiveCapture`/`stopActiveLiveCapture` | 녹음 중 종료 handshake가 동작하지 않는다 |
| 11 | `processExists` (21/21 초록, 변이 2종) | 정상 종료마다 "worker가 남았습니다"가 뜬다 |

**서브에이전트 보고 3건을 뒤집었다.** (1) "SIGTERM으로 worker가 안 죽어 `kill -9`가 필요하다"
→ 직접 6/6 정상 종료를 측정했다. 원인은 그쪽이 고른 pid가 자기 셸 래퍼였다(나도 같은 실수를
먼저 했다). (2) "감독자가 그 throw를 잡아 `failed`로 바꾼다" → 감독자가 잡는 것은
`detectExternal`이지 `readiness`가 아니다. 실제 사슬은 rejection → 정리 생략 → `rt.result` 잔류
→ 앱이 살아 있는 동안 재시도 영구 차단이다. (3) "인자 제거는 타입 정리라 런타임 변화가 없다"
→ stderr 읽는 시점을 probe 뒤로 옮겨 지연된 staleness 버그를 소리 없이 고쳤다.

**최종 whole-branch 리뷰가 잡은 것 (Critical 0, Important 4).**

- **I-1 — 정중한 종료가 사실상 강제 종료였다.**
  - 원인: `kill(-pgid)`가 uv 그룹의 Python supervisor에 SIGTERM을 **두 번** 닿게 했다 — 커널이 한 번,
    `uv run`의 전달이 한 번. supervisor는 두 번째를 "강제"로 읽어 `--once` 자식을 죽이고 `os._exit(1)`한다.
  - 영향: job이 돌고 있으면 P2-C5가 **결정적으로** 실패한다.
  - 확인: 컨트롤러가 장난감 스크립트로 실측했다(5/5 두 번, uv pid 대상은 2/2 한 번).
  - 수정: 1·3단계 SIGTERM을 uv pid로 보낸다. supervisor가 끝난 뒤에만 그룹에 한 번 보내 같은 그룹의 MPS
    probe 자식을 거둔다.
  - Task 11 때의 6/6 측정은 job이 없는 상태라 이것을 못 봤다. 실앱 확인은 P2-C5.
- **I-4 — `WORKER_ID`를 실행 간 고정한 Task 12의 내 판정은 스펙 §6.5 위반이었다.**
  - 실행 간 고정은 R2-6을 오히려 넓힌다.
  - 수정: 실행마다 새로 만들고 `config.json`에 쓰지 않는다. 옛 빌드가 남긴 값도 이기지 못한다.
- **I-3 — 크래시 뒤 재시작 경로의 고아를 §6.9가 막는다는 스펙 주장이 거짓이었다.**
  스펙만 정정하고 메커니즘은 Phase 6으로 넘겼다(§5.3).
- **I-2** — 테스트 강도 결함. 수정 뒤 재리뷰의 I-A(대화상자 동안 끝난 worker에 신호를 보냄)는 컨트롤러가 `e00cf9b`로
  고쳤다.

**내가 틀렸고 리뷰어가 고친 것 1건.** 나는 모든 `stopped: true` 직전에 자손을 훑자고 했다.
리뷰어가 그것으로는 못 잡는다는 것을 보였다 — 감독자가 먼저 죽으면 OS가 그 자식을 pid 1로
재부모화하므로 사후 BFS에는 아무것도 안 보인다. 옳은 수정은 **감독자가 살아 있는 진입 시점에
자손을 찍어 두고**, 깨끗하다고 말하기 전에 그 집합을 되보는 것이다.

### 3.3 판정 기록

실행 중 내린 판정은 Task 11 시점에 **37건**, Task 15 끝에 **98건**이다. 전문은 원장
(`.superpowers/sdd/.../progress.md`, git 추적 대상 아님)에 `Ruling:` 항목으로 시간순으로 있고,
각 항목은 "무엇을 정했나 / 왜 / 틀렸을 때 비용" 세 줄을 갖는다. 여기에는 **제품 동작을 바꾼 것**만
추린다.

| 판정 | 결정 | 틀렸을 때 비용 |
| --- | --- | --- |
| `DAEMON_DOWN` 정규식 | 계획의 정규식이 실제 Docker 문구를 못 잡는다. 실측 문구로 교체 | Docker 꺼짐이 "원인 불명 실패"로 뜬다 (P2-C7 실패) |
| embed 준비 유예 | 서비스별 유예를 도입하고 embed는 180초 (실측 31초의 6배) | 느린 첫 로드가 embed를 `failed`로 만든다 |
| 지속적 health 감시 | 계획에 아예 없었다 — 감독자에 넣는다 | P2-C11(DB 끊김 → `degraded`)을 판정할 수 없다 |
| 재시작 안정 창 | ready 후 60초 지나면 `restarts`를 0으로 되돌린다 | 하루 켜 두면 재시작 예산이 소진돼 복구가 죽는다 |
| 초기 게이트 실패 | 초기 `start()` 중 실패한 게이트에는 재시작을 걸지 않는다 | 화면이 안내 대신 재시작 루프에 들어간다 |
| `retry()` 진입점 | `start()`를 재진입 수단으로 쓰지 않는다 | 사용자의 "다시 시도"가 이미 뜬 서비스를 또 띄운다 |
| 외부 worker 감지 | 거부 목록 → **허용 목록**으로 뒤집는다 | 남의 python 프로세스를 worker로 오인해 앱이 stand-down한다 |
| 마이그레이션 게이트 스트림 | stderr가 아니라 **stdout**이다 (§3.2) | 게이트가 조용히 꺼진다 (P2-C9 실패) |
| 유예 초과의 해석 | "응답 없음"만이 아니라 "분석 마무리 중"도 포함한다 | 정상 동작 중인 worker를 고장으로 표시한다 |
| `launchWithUv` 스트림 분리 | `as never` 캐스트를 없앤다 — 회귀가 테스트가 아니라 `tsc`에서 걸린다 | 더 약한 그물로 같은 버그를 다시 맞는다 |
| 종료 4단계 SIGKILL | 비대칭을 유지하되 **의도임을 스펙에 적는다** | 강제 종료한 job이 reaper까지 최대 30분 멈춰 보인다 |
| 종료 재스냅샷 위치 | 대화상자 **앞**으로 옮긴다 | 재사용된 pid가 "남았다"고 사용자 화면에 뜬다 |
| 4단계 kill 대상 | 낡은 스냅샷이 아니라 방금 걸은 트리 (M-B 테스트로 고정) | **남의 프로세스를 SIGKILL한다** |
| `listExternalWorkers` root pid | 계획이 root pid를 "우리 것"에 안 넣는다 — 넣는다 | 앱이 자기 worker를 외부로 오인한다 (P2-C6 실패) |

나머지 23건은 절차 판정이다 — 어떤 지적을 어느 라운드로 보낼지, 무엇을 파킹할지, 계획과 리뷰가
충돌할 때 어느 쪽을 따를지.

### 3.4 이월 항목

전부 `.superpowers/sdd/.../deferred.md`에 있다. 아래는 Task 11 시점에 적은 인계이고, **Task 12~14와 최종 리뷰
수정이 모두 받아 처리했다.** 끝까지 남은 것은 §5.3에 옮겼다.

**Task 12가 받는 것**
- `descendantPids`를 `main.ts`에서 export한다 (Task 13이 `opts.descendants`에 배선한다).
- `listExternalWorkers`의 `ours`에 root pid를 넣는다 (§3.3).

**Task 13이 받는 것**
- `StopOutcome`에 `detail?: string`. 지금은 `{stopped, leaked}`뿐이라 "고아가 살아 있다" /
  "스냅샷 실패로 증명 못 했다" / "사용자가 강제를 거절했다"를 대화상자가 구별할 수 없다.
- **N2** — 진입 가드 `!handle.alive()`가 고아가 살아 있어도 `{stopped:true}`를 돌려준다.
  수정 자리가 이 모듈 밖(호출자가 진입 전에 자손을 잡아야 한다)이다.
- 고아 **처분 정책** — 재부모화된 `--once` 자식에게 SIGTERM인가 SIGKILL인가.
- `console.error` 로그 싱크. packaged Electron main에는 콘솔 싱크가 없어 스냅샷 실패 기록이
  dev에서만 보인다. 주입 구멍을 미리 만들지 않고 호출자와 함께 배선한다.
- 유예 초과 문구를 "분석 마무리 중"과 "응답하지 않습니다"로 나눈다.

**Task 14가 받는 것**
- `failureBlock`에 아직 프로덕션 호출자가 없다 — Phase 1의 zod 절단이 사용자 화면에 그대로 산다.

**최종 whole-branch 리뷰가 받는 것**
- M-R: 4단계 SIGKILL 일소 뒤의 settle 대기가 무검증. 안전 방향 실패(거짓 경고)다.
- `desktop/tsconfig.json`의 `include`가 `src/**/*.ts`뿐이라 `pnpm lint`가 `tests/`를 타입 검사하지
  않는다 (기존 성질).
- 주석의 사실과 다른 주장 몇 건, `pollMs: 0`일 때 `waitForExit`가 무한 회전하는 기존 성질.

## 4. 최종 검증

**결과: P2-C1~P2-C15 15건 모두 충족.** 단, 검증 도중 제품 결함 4건이 드러났다. 전부 이 브랜치에서
고쳤고, 영향받은 기준은 고친 빌드로 다시 판정했다(§4.2). 첫 판정에서 실패한 기준은 P2-C11 하나다.

- 확인 환경: `pnpm desktop:build`로 만든 `desktop/out/mac-arm64/Damwha.app`.
- 진행: 사용자와 공동 진행, 2026-09-13 18:29~23:41 KST. 화면 판정은 사용자가 보고 답했고, 로그·프로세스·DB는
  컨트롤러가 직접 조회했다.
- 증거 파일: 저장소 밖 `~/.cache/damwha-p2-evidence/`. 기준별 파일 이름은 원장의 Task 15 항목에 있다.
- 실데이터에 닿는 동작은 사용자가 Task 15에 한해 허락한 네 가지뿐이고, 매번 실행 직전에 다시 확인했다.
  - postgres 컨테이너 stop/start
  - 검증용 DB 생성·삭제
  - 실제 DB에 회의 추가
  - Docker Desktop 종료
- `docker compose down`·`pnpm be:migrate`·`.env` 수정은 한 번도 하지 않았다.

### 4.1 판정

빌드는 네 번 바뀌었다. 판정마다 어느 빌드였는지 적는다. 이후 빌드에서 판정을 흔드는 변경은 §4.2의 수정뿐이고,
그 수정이 닿는 기준(C4·C5·C10·C11)은 수정 뒤 빌드에서 판정했다.

| 기준 | 판정 | 빌드 | 증거 |
| --- | --- | --- | --- |
| P2-C1 터미널 없이 넷 다 준비 | **충족** | `24f9080` | 사용자가 Finder로 실행했고 터미널 명령은 없었다. 상태 창에 넷이 실행 중으로 떴다(사용자 확인). supervisor.log 12:22:32Z에 넷 모두 `running/ok`(api 0.5초·worker 1초·embed 10초). 앱이 멈춰 있던 컨테이너 `f2028e470e9a`를 재기동했고 재생성은 없었다. 뒤 두 빌드의 기동에서도 넷 `ok`가 매번 반복됐다 |
| P2-C2 `be/worker/.env` 무변경 업로드 | **충족** | `24f9080`(처리) · `6d22ed5`(화면) | 앱에서 업로드한 mtg_18을 앱 소유 worker가 job_91로 처리해 `done`, 발화 426. 전사 화면을 사용자가 확인했다. `be/worker/.env` sha `67572e8f…`가 전후 같다 — `STORAGE_ROOT=../storage` 그대로 |
| P2-C3 의미 검색 | **충족** | `24f9080` · `ccb407a` | 사용자가 검색 정상을 확인했다. `POST /api/search 201` 5회와 같은 시각에 embed.log `POST /embed 200`이 찍혔고, 키워드 전용 폴백 경고는 0건 |
| P2-C4 전체 트리 정리 | **충족 (한계 있음)** | `ccb407a` | 렌즈 job_97 중 `mlx_lm.server`(pid 26687, `--once` 자식의 세션)가 떠 있는 상태에서 ⌘Q. 0.5초 간격 추적에서 worker·`--once`·`mlx_lm.server`·embed·앱이 1초 안에 전부 사라졌고, 5초 뒤 0개. 3000/8000/8100 포트 비었고 컨테이너는 Up. **한계:** 3단계(강제 SIGTERM)와 4단계(자손 SIGKILL)는 발화하지 않았다 — 두 번째 대화상자 중에 렌즈 단계가 끝나 자식이 LLM 서버를 스스로 내렸다. 강제 경로는 단위 테스트로만 존재한다 |
| P2-C5 분석 중 정중한 종료 | **충족 (2/2)** | `24f9080` · `ccb407a` | job_95 STT 도중 ⌘Q → 대화상자에서 종료 → job `queued`, `attempts` 1→0, `locked_by` 해제. worker.log에 "forwarding SIGTERM to child"가 **1회**, "again — killing child"는 없다. `requeued_shutdown`. 최종 리뷰 I-1 수정이 실제 앱에서 성립했다 |
| P2-C6 외부 서비스 보존·구분 | **충족** | `24f9080` | 터미널 `pnpm worker`(pid 4590)·`pnpm embed`(pid 5467)를 띄운 뒤 앱 실행. embed는 채택하고, worker는 띄우지 않으면서 pid를 적은 경고를 냈다. 앱 소유 worker·embed는 0개. ⌘Q 뒤에도 외부 두 프로세스가 살아 있었고 `:8100/health`가 ok |
| P2-C7 Docker 데몬 없음 | **충족** | `6d22ed5` | Docker Desktop을 완전히 종료(§4.3)한 뒤 앱 실행. `postgres: 기동 실패 — Docker Desktop이 실행 중이 아니에요.`와 실행 안내가 화면에 떴다(사용자 확인). Docker를 켜자 창의 자동 재시도가 9초 뒤 같은 컨테이너를 채택했고, 넷 `ok` |
| P2-C8 실행 파일 못 찾음 | **충족** | `ccb407a` | `config.json`에 `UV_BIN=/nowhere/uv`. worker·embed가 `spawn failed: spawn /nowhere/uv ENOENT`로 재시작 3회 뒤 `failed`. 상태 창에 경로와 "config.json의 UV_BIN·DOCKER_BIN" 안내가 떴다(사용자 확인). 원복함. §5.2의 "재시도로는 안 고쳐진다"를 함께 발견 |
| P2-C9 미적용 마이그레이션 | **충족** | `ccb407a` | 같은 클러스터의 빈 DB `damwha_migration_gate`로 실행. api.log에 `24 pending migration(s): 001_init.sql … — run pnpm be:migrate` — packaged 트리에 `.sql`이 실렸다는 증거다(`skipped` 아님). health 200 뒤 0.5초에 api `failed`. worker·embed는 기동 0회. 복제 DB에는 `_migrations` 테이블이 전후로 없다. 화면은 실패 + `pnpm be:migrate` 안내(사용자 확인). 확인 뒤 DROP, `config.json`은 sha 대조로 원복 |
| P2-C10 worker DB 설정만 틀림 | **충족** | `ccb407a` | DB를 내린 채 앱 소유 worker supervisor를 SIGKILL했다. pid는 34787→uv 34786→앱 34699 사슬로 확인했다. 재시작 3회가 모두 60초 유예를 넘겨 `failed`였고, `running/ok`는 한 번도 없었다. worker.log: `started` 3줄, `ready (db connected)` 0줄, `reconnect failed` 18줄. DB를 올리고 메뉴 재시도하자 넷 `ok`(사용자 확인). **한계:** 원인 문구("데이터베이스에 연결하지 못해 멈춰 있을 수 있어요…")는 코드와 단위 테스트가 근거이고, 사용자가 화면 문구를 읽지는 않았다 |
| P2-C11 부팅 뒤 DB 끊김 | **1차 실패 → 수정 후 충족** | `ccb407a` ✗ / `6d22ed5` ✓ | 1차: api 프로세스가 **죽었다**(§4.2-4). 수정 빌드: DB 다운 66초 동안 같은 pid가 `running/degraded`였고, health 503이 10초마다, 재시작·종료 기록 0. DB 복귀 8초 뒤 스스로 `ok`, worker는 28초 뒤 `ok`. 실행 전체에서 api 기동은 1회 |
| P2-C12 창 닫기 ≠ 앱 종료 | **충족** | `ccb407a` | job_95 처리 중 빨간 버튼으로 창을 닫았다. 대화상자는 없었고, Dock 클릭으로 창이 돌아왔고, 처리는 계속됐다(사용자 확인). 그 사이 supervisor.log에 정지 기록 없음 |
| P2-C13 녹음 중 종료 handshake | **충족** | `6d22ed5` | 라이브 녹음 약 40초 중 ⌘Q → "녹음 중 종료" 대화상자를 승인했다(사용자 확인). `POST …/live/stop 200`이 worker의 SIGTERM보다 먼저다. mtg_21은 `uploaded`, `capture_error` NULL(≠`producer_abandoned`). job_98 `committed_bytes`=`sealed_bytes`=1,333,760 = WAV 666,880프레임 = 41.68초 = `duration_ms`. 재실행하자 `processing`을 거쳐 `done` |
| P2-C14 웹 흐름·번들 위생 | **충족** | `6d22ed5` (HEAD) | 루트 install·build·lint·test 모두 exit 0 — desktop 543, fe 578, be 470, worker 526. `pnpm build`는 contracts·be·fe만 빌드했고 `.app` mtime은 그대로. `docker build -f deploy/api.Dockerfile .` exit 0. check-bundle 13/13(저장소 절대 경로 0건 포함). `pnpm dev` 웹 흐름(목록·전사·검색)을 사용자가 확인했고 Electron은 뜨지 않았다. fe lint 경고 1건은 이 브랜치가 안 건드린 파일의 기존 경고 |
| P2-C15 기존 데이터 보존 | **충족** | 전 구간 | `be/storage` 131파일 체크섬 diff 0줄. 기존 meeting 12건과 그 발화 1,463건 그대로(+ 승인된 테스트 회의 mtg_17~21). `_migrations` 25 → 25. compose `name: damwha`, 볼륨 `damwha_pgdata`와 컨테이너 `f2028e470e9a`의 생성 시각이 기준선과 같다 — 재생성 없음 |

### 4.2 검증이 잡은 결함

넷 모두 단위 테스트가 전부 초록인 상태에서 packaged 실행으로만 드러났다.

**1. packaged 앱에 옛 코드가 실렸다 (`24f9080`).**

- 원인: `pnpm desktop:build`가 desktop TypeScript를 컴파일하지 않았다. 그래서 00:24에 만든 `dist`(그 뒤 커밋 15개
  누락)가 번들에 실렸다.
- 방어가 못 막은 이유: check-bundle 11/11은 통과했다. 파일 **존재**만 봤지 내용이 현재 소스인지는 보지 않았다.
- 발견 경위: 첫 실행이 만든 `config.json`에 I-4가 없앴어야 할 `WORKER_ID`가 적혀 있었다.
- 수정: 패키징이 `dist`를 지우고 먼저 컴파일한다. check-bundle에 "asar의 `dist/*.js`가 현재 소스를 새로 컴파일한
  결과와 바이트 단위로 같다"를 더했다(13/13). 옛 번들에 새 검사가 FAIL하는 것을 확인했다.
- 옛 빌드에서 본 것은 판정에 쓰지 않았다.

**2. 서명 신원이 모호했다 (`9602c5f`).**

- 원인: 키체인에 이름이 같은 "Apple Development" 인증서가 둘 있어, electron-builder의 자동 탐색이 codesign
  `ambiguous`로 실패했다.
- 수정: `mac.identity: null`로 자동 탐색을 끄고, 설계대로 스크립트가 ad-hoc 서명한다. 키체인은 건드리지 않았다.

**3. 처리 중 worker가 거짓 `degraded`로 떴다 (`ccb407a`).**

- 원인: ready 줄을 8KB stderr 꼬리에서 찾았다. 처리 로그가 쌓이면 그 줄이 창 밖으로 밀려나, 첫 분석 뒤
  재시작 전까지 계속 `degraded`였다.
- 수정: stderr를 줄 단위로 훑어 마지막 준비 사건을 기억한다.
- 실앱 확인: ready 뒤 stderr가 11,051B로 8KB를 넘겨도 `ok`를 유지했다.

**4. DB가 연결을 끊으면 API 프로세스가 죽었다 (`6d22ed5`, `be/`).**

- 스펙 §6.6의 "API는 죽지 않고 503을 준다"가 요청 시점의 DB 부재에만 맞았다.
- 원인: `docker compose stop postgres`처럼 서버가 연결을 끊으면(57P01) pg-pool이 idle 클라이언트의 오류를
  pool의 `'error'`로 올린다. `DatabaseService`에 리스너가 없어 Node가 프로세스를 죽였다(`Unhandled 'error'
  event`, 코드 1). `withTransaction`이 빌린 클라이언트도 같은 부류다.
- 수정: 두 곳에서 `'error'`를 받아 경고만 남긴다.
- 테스트: testcontainers Postgres에서 `pg_terminate_backend`로 두 경로를 재현한다. 수정 전 RED를 확인했다.
- 변이 3종이 모두 잡혔다:
  - pool 리스너 제거 → `Unhandled error … 57P01`
  - 트랜잭션 리스너 제거 → `Connection terminated unexpectedly`
  - `removeListener` 제거 → `Expected 1, Received 2`
- 스펙 §6.6·§10에 정정을 적었다. 웹·Docker 배포에도 그대로 옳은 수정이다.

### 4.3 비고

**Docker Desktop 종료가 한 번에 되지 않았다 (P2-C7 준비).**

1. `quit app "Docker"` 뒤 엔진은 내려갔지만(`docker info` 500) 앱과 백엔드가 2분 넘게 남았다.
2. 사용자가 메뉴로 완전 종료한 뒤에도 `com.docker.backend` 트리가 남아 `docker ps`가 응답 없이 멈췄다.
3. 사용자 승인을 받아 그 백엔드 둘에만 SIGTERM을 보냈고, 5초 안에 전부 끝났다.
4. 그 뒤 CLI가 앱이 판정하는 문구로 즉시 실패했다.

멈춘 Docker(소켓은 받는데 응답이 없음)에서 앱이 어떻게 보이는지는 실측하지 않았다. `dockerRun`의 30초 타임아웃을
거쳐 일반 실패로 뜰 것이다.

**"처리가 느려졌다"는 보고 — 앱은 원인이 아니다.** 같은 오디오(음성 1,623,469ms), 같은 설정으로 쟀다.

| job | worker | STT | 배속 |
| --- | --- | --- | --- |
| job_87 | 앱 소유, 옛 빌드, 앱 기동 직후 | 274.0초 | 5.92배 |
| job_91 | 앱 소유, 새 빌드 | 234.8초 | 6.91배 |
| job_93 | 터미널 `pnpm worker` | 약 244초 | 6.65배 |

과거 9배속 기록은 다른 오디오였다. worker 자체의 회귀인지는 옛 회의를 지금 worker로 재처리해야 알 수 있고,
이 Phase 범위 밖이다(§5.3).

**Phase 1에서 넘어온 확인 항목 (스펙 §9 비고) — 둘 다 미확인.**

- `unverified-owner` 화면의 종단간 발화: 포트를 외부 API가 쥔 상황을 만들 기회가 없었다.
- 포트 폴백 뒤 TCC 재요청: 이번 검증 내내 포트 폴백이 일어나지 않았다.

## 5. 남은 제약과 후속 Phase 인계

### 5.1 구현 값과 근거

| 값 | 현재 | 근거 |
| --- | --- | --- |
| worker 종료 유예 (`WORKER_GRACE_MS`) | 90초 | stage boundary까지 기다리는 정중한 경로. 넘기면 `[계속 기다리기 / 지금 강제 종료]` |
| 종료 handshake 상한 (`HANDSHAKE_TIMEOUT_MS`) | 90초 | fe 상수로 계산한 렌더러 최악 중지 82초 이상. 테스트가 이 부등식을 고정한다 |
| 준비 유예 | 기본 60초, embed 180초 | embed 첫 로드 실측 31초의 6배 |
| 재시작 정책 | `[3s, 8s, 20s]` 3회 → `failed` 고정 | Phase 1 `RETRY_DELAYS_MS` 재사용. postgres는 `never`(compose `restart: unless-stopped`) |
| 재시작 예산 초기화 | ready 뒤 60초 유지 | 하루 켜 둔 앱이 예산을 소진하지 않게 |
| 기동 중 정리 유예 (`CLEANUP_GRACE_MS`) | 5초 (worker는 90초로 올라감 — §5.3 M-5) | 준비 실패한 자식을 치우고 재시도 |
| health 재확인 | api·worker 10초, postgres·embed 30초 | P2-C11의 `degraded` ↔ `ok` 전이를 관찰하는 유일한 수단 |
| docker CLI 타임아웃 | 30초 | 멈춘 Docker에서 무한 대기하지 않게 |
| 로그 회전 | 10MB × 3세대, 기동 시 1회 | 스트림이 열린 뒤 옮기면 핸들이 옛 파일을 가리킨다. 한 실행 안에서는 상한 없음(§5.3 M-8) |
| stderr·stdout 꼬리 | 8,000자. worker 준비 판정은 줄 단위(carry 8,000자) | §4.2-3 |

### 5.2 이번 검증에서 드러났지만 고치지 않은 것

모두 데이터 손실은 없고 동작이나 안내 수준이다. 후속 Phase가 받거나 별도 작업으로 연다.

1. **게이트 실패 뒤 창이 상한 없이 자동 재시도한다.**
   - 현상: 창 타이머가 3초·8초 뒤 **20초마다** API를 계속 다시 띄운다(P2-C9에서 1분 40초에 7회, 기동마다 api.log ~8.5KB).
     감독자는 게이트에 재시작을 걸지 않지만 `main.ts`의 `scheduleRetry`가 그것을 우회한다.
   - 스펙과의 관계: 계획이 명시한 동작이지만 스펙 §6.7의 "거기서 멈춰 안내"와 어긋난다.
   - 참고할 점: `pnpm be:migrate` 뒤 클릭 없이 회복되고, Docker를 켰을 때(P2-C7)는 이것이 복구 경로였다.
     상한이나 로그 억제를 정할 때 이 둘을 같이 봐야 한다.
2. **`UV_BIN`·`DOCKER_BIN`을 고치고 "다시 시도"해도 반영되지 않는다.**
   - 원인: 경로가 감독자 생성 때 한 번 정해지고(`main.ts:1011`) 재시도는 같은 감독자를 쓴다.
   - 실측: 원복한 `config.json`으로 재시도해도 `spawn /nowhere/uv ENOENT`가 반복됐다.
   - 화면은 "config.json에 경로를 적어 주세요"까지만 말하고 "앱을 다시 켜야 한다"는 말하지 않는다.
3. **종료 화면이 90초 넘게 진행 표시 없이 떠 있다.** 렌즈 중 ⌘Q에서 사용자가 "엄청 오래 걸렸다"고 보고했다.
   경과 시간이나 마무리 중인 작업 이름을 보여줄 후보.
4. **상태줄이 기동 전이나 정지 뒤의 서비스에 `(외부)`를 붙인다.** 초기 상태와 `stopAll`이 `owned:false`로 적기
   때문이다. P2-C6의 진짜 외부 표시와 헷갈릴 수 있다.
5. **패키징이 Finder와 경합한다.** electron-builder가 `out/mac-arm64`를 비우는 사이 Finder가 `.DS_Store`를 다시 써
   `ENOTEMPTY`로 실패했다. 그 폴더를 Finder로 열어 둔 경우다. 남은 것을 지우고 다시 빌드하면 된다.
6. **P2-C4의 강제 경로(3·4단계)는 실앱에서 발화하지 않았다** (§4.1).

### 5.3 최종 리뷰에서 남긴 것

- **I-3 — worker supervisor가 크래시한 뒤의 재시작은 이전 `--once` 자식을 추적하지 않는다.**
  - 피해 조건: 같은 `WORKER_ID`의 고아가 아직 쓰는 중에 reaper가 그 job을 되돌리면, 한 job에 writer가 둘 생긴다.
  - 스펙: §6.5·R2-6에 정직하게 적어 두었다.
  - 해소: job별 lease token과 함께 **Phase 6**. 부분 해소 설계는 부록 A에 있다.
  - 이것을 밟는 완료 기준은 없다.
- **M-5.** 기동 중 정리가 `StopOutcome`을 버리고 `rt.result`를 비운다. 정리하지 못한 자식이 추적에서 빠지고, 재시작이
  그 옆에 또 띄울 수 있다. `Math.max(plan.graceMs, WORKER_GRACE_MS)`가 worker의 5초 정리 유예를 90초로 바꾼다.
- **M-8.** 로그 회전이 기동 시 1회뿐이라 창을 닫고 오래 켜 두면 `worker.log`가 한 실행 안에서 무한히 자란다
  (스펙 §6.12는 크기 기반 회전을 요구한다).
- **M-7.** 브리지 이름(`__damwha_desktop`, `isRecording`, `stopLiveRecording`)이 fe의 `DesktopBridge`와 문자열로만
  묶여 있다. fe에서 이름을 바꾸면 P2-C13의 확인과 handshake가 조용히 건너뛰어진다.
- **M-9.** 다른 흐름 중에 누른 ⌘Q·⌘W는 로그 한 줄만 남기고 화면에는 아무 반응이 없다.
- 테스트 강도 잔여 — 변이가 살아남는 곳:
  - M-1: 상태줄의 degraded 문구
  - M-2: 서비스 창 "마지막 갱신" 시각, `status.html`의 `?? "3"`
  - M-R: 4단계 SIGKILL 뒤 settle 대기
  - M-10: `pollMs: 0` 무한 회전(도달 불가)
  - PORT 검증 중복
  - `main.ts`의 잎(electron import라 테스트 불가 — 신호 실패 로그 등)
- **job_97 `llm_invalid_response`** (렌즈 LLM 응답 형식)와 **worker 처리 속도의 과거 대비 회귀 여부**는 이 Phase
  범위 밖이다. 앱과는 무관함을 확인했다(§4.3).

### 5.4 후속 Phase 인계 (스펙 §15)

- **Phase 3** — 마이그레이션 실행.
  - 지금 앱은 감지해 멈추기만 하고(P2-C9) 실행하지 않는다.
  - 실행 게이트를 넣을 때 §5.2-1의 자동 재시도 루프를 함께 정리한다.
- **Phase 4** — 번들 도구. `FFMPEG_BIN`/`FFPROBE_BIN`.
  - worker의 `pipeline/ffmpeg.py`가 두 실행 파일을 리터럴로 부르므로, 번들 ffmpeg를 넣는 것만으로는 개발 도구가
    없는 맥에서 동작하지 않는다.
  - `UV_BIN`처럼 탐색·설정·안내가 필요하고, §5.2-2의 "재시도로 반영 안 됨"도 같은 자리다.
- **Phase 5** — sweeper 경로 검증.
  - 종료 handshake가 실패하거나 시간을 넘겼을 때, 다음 실행의 `LiveOrphanService`가 봉인·마감하는 경로다.
  - P2-C13은 handshake가 성공한 경로만 밟았다.
- **Phase 6** — job lease token.
  - R2-6과 I-3의 근본 해소.
  - Developer ID 서명(§4.2-2의 ad-hoc 서명을 대체).

## 부록 A. I-3 — 보류한 설계 (Phase 6이 lease token과 함께 쓴다)

최종 리뷰 수정 중 구현자가 구현 전에 올린 설계다. 설계는 옳다고 판정했다. 넣지 않은 이유는 세 가지다.

1. 마지막 수정 dispatch에 새 감독자 상태·새 훅·health tick마다 `ps`·재시작 보류를 한꺼번에 넣게 된다.
2. 이것을 밟는 완료 기준이 없다.
3. 부분 해소이고, 근본 해소(job별 lease token)와 한 번에 하는 편이 낫다.

**왜 재시작 경로 한 곳만 고쳐서는 안 되나.** supervisor가 죽은 뒤 `--once` 자식은 ppid 1이 되어 어떤 ppid BFS에도
안 보인다. 그래서 스냅샷은 **supervisor가 살아 있을 때** 찍어야 한다. 그러려면 `ps`가 필요한데, 그것은 범용
감독자가 아니라 `main.ts`나 어댑터 deps에 산다.

**설계.**

1. **`types.ts`** — 선택 훅 `ServiceSpec.leftovers?(): Promise<number[]>`를 더한다.
   - 이 서비스의 이전 인스턴스가 남긴, 아직 살아 있는 프로세스를 돌려준다.
   - 읽기 전용이다. 신호는 보내지 않는다.
2. **worker 어댑터** — deps `onceChildren(rootPid)`·`stillOnce(pids)`를 더한다.
   - `readiness()`가 ready/degraded로 판정할 때만 `--once` pid를 찍는다. 10초 health tick마다 `ps` 한 번이다.
     ready 전에는 `--once` 자식이 있을 수 없다.
   - `leftovers()`는 `stillOnce(마지막 스냅샷)`이다. `ps`가 실패하면 후보를 유지한다 — 사라졌다고 증명할 수 없기
     때문이다.
   - 트리 전체가 아니라 `--once` pid만 본다. 고아 `mlx_lm.server`는 스스로 끝나지 않아 worker를 영원히 막는다.
   - 생존 확인 때 그 pid의 명령에 아직 `--once`가 있는지 다시 본다. pid가 재사용됐으면 보류가 걸리지 않는다.
3. **`shutdown.ts`** — 순수 파서 `onceChildren(psOutput, set)`을 두고, `hasOnceChild`는 `.length > 0`이 된다.
   `main.ts`는 `ps -axo pid,ppid,command` 한 번으로 두 deps를 배선한다.
4. **`supervisor.ts`**
   - `Runtime.held: number[] | null`을 더한다.
   - `watchForDeath` → `awaitLeftovers`.
     - 목록이 비어 있지 않은 동안 `failed`(종료 원인 + 새 CAUSES 문구)로 두고, `arm()`으로 5초마다 다시 본다.
     - 비면 평소의 `scheduleRestart`로 간다.
     - 보류는 재시작 예산을 쓰지 않는다.
   - 보류 중에는 `bringOnce`가 바로 돌아간다. 메뉴 재시도가 고아 옆에 새 worker를 띄우지 못한다.
   - `stopAll`은 보류 중인 런타임의 leftovers를 다시 보고 `{stopped:false, leaked, detail}`을 보고한다.
     신호 없이 거짓 "깨끗한 ⌘Q"를 없앤다.
   - 보류는 `pending`에 넣지 않는다. 종료가 그것을 기다리지 않는다.

**알려진 한계:** supervisor가 죽기 10초 안에 뜬 `--once` 자식은 놓친다.
