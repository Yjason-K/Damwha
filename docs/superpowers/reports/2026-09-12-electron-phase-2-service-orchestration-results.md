# Electron Phase 2 — 서비스 실행 통합 실행 결과

브랜치: `feat/electron-migration-phase-2-service-orchestration`
분기점: `dev` (`2764ffd`)
스펙: [2026-09-12-electron-phase-2-service-orchestration-design.md](../specs/2026-09-12-electron-phase-2-service-orchestration-design.md)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 2. 서비스 실행 통합"

**상태 (2026-09-12): 스펙 리뷰 통과. 구현 계획 작성·검증 통과. 구현 미착수.**

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
| 11 | 종료 정책 | `06a6bed..` (진행 중) | 2 | 아래 §3.3 |

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

**내가 틀렸고 리뷰어가 고친 것 1건.** 나는 모든 `stopped: true` 직전에 자손을 훑자고 했다.
리뷰어가 그것으로는 못 잡는다는 것을 보였다 — 감독자가 먼저 죽으면 OS가 그 자식을 pid 1로
재부모화하므로 사후 BFS에는 아무것도 안 보인다. 옳은 수정은 **감독자가 살아 있는 진입 시점에
자손을 찍어 두고**, 깨끗하다고 말하기 전에 그 집합을 되보는 것이다.

### 3.3 판정 기록

실행 중 내린 판정은 **37건**이다. 전문은 원장
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

전부 `.superpowers/sdd/.../deferred.md`에 있다. 후속 Task가 받아야 하는 것만 적는다.

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

**아직 수행하지 않았다. P2-C1~P2-C15 중 충족된 것은 0건이다.**

이 시점에 desktop 225 · worker 526 · fe 578개 테스트가 통과하지만, **그것은 완료 기준을 하나도
판정하지 않는다.** §9의 15개 기준은 전부 `pnpm desktop:build`로 만든 `Damwha.app`을 Finder에서
실행한 상태를 확인 환경으로 못박는다 — 단위 테스트는 그 환경에 들어가 본 적이 없다. 지금까지
증명된 것은 "부품이 각각 명세대로 동작한다"이고, 기준이 묻는 것은 "터미널을 열지 않은 사람이
앱을 켰을 때 실제로 그렇게 되는가"다.

기준별 현재 상태는 아래와 같다. **"부품 준비됨"은 충족이 아니다.**

| 기준 | 주제 | 현재 | 남은 것 |
| --- | --- | --- | --- |
| P2-C1 | 터미널 없이 넷 다 준비 | 부품 준비됨 | Task 12 배선 + packaged 실행 |
| P2-C2 | `be/worker/.env` 무변경 업로드 | 부품 준비됨 | packaged 실행 + 체크섬 대조 |
| P2-C3 | 의미 검색 동작 | 부품 준비됨 | packaged 실행. 어긋나도 **오류 없이** 키워드 전용으로 떨어져 이 판정이 유일한 관찰 지점이다 |
| P2-C4 | 전체 트리 정리 | 종료 정책 완성 (Task 11) | Task 13 배선 + packaged 실행 |
| P2-C5 | 분석 중 정중한 종료 | 종료 정책 완성 | Task 13 + `job.attempts` 확인 |
| P2-C6 | 외부 서비스 보존·구분 | 감지 완성 (Task 4·8) | Task 12의 root pid 수정(§3.3) 없이는 **거짓 실패한다** |
| P2-C7 | Docker 데몬 없음 | 감지 완성 (Task 4) | Task 14 화면 + packaged 실행 |
| P2-C8 | 실행 파일 못 찾음 | 탐색 완성 (Task 2) | Task 14 화면 + packaged 실행 |
| P2-C9 | 미적용 마이그레이션 | 게이트 완성 (Task 5·6) | packaged 실행. **복제 DB로만 한다** — §9의 절차를 그대로 따른다 |
| P2-C10 | worker DB 설정만 틀림 | ready 신호 완성 (Task 7) | Task 12·14 + `docker compose stop postgres` |
| P2-C11 | 부팅 뒤 DB 끊김 | health 감시 완성 (Task 6·7) | Task 14 상태 창 + packaged 실행 |
| P2-C12 | 창 닫기 ≠ 앱 종료 | — | Task 12 Step 6 |
| P2-C13 | 녹음 중 종료 handshake | fe 훅 완성 (Task 10) | Task 13 배선 + packaged 실행 |
| P2-C14 | 웹 흐름·번들 위생 회귀 없음 | — | 루트 `build`/`test`/`lint` + `docker build` + `check-bundle.mjs` |
| P2-C15 | 기존 데이터 보존 | — | C1~C6·C12·C13 수행 전후 체크섬·행 수 대조 |

Task 15가 이 표를 실제 판정으로 바꾼다. 판정 값은 실행 결과로만 채운다 — 추론으로 채우지 않는다.

## 5. 남은 제약과 후속 Phase 인계

**아직 채우지 않았다.** 스펙 §15가 현재까지 식별한 인계 항목을 담고 있다 —
Phase 3의 마이그레이션 실행 게이트, Phase 4의 `FFMPEG_BIN`/`FFPROBE_BIN`,
Phase 5의 sweeper 경로 검증, Phase 6의 job lease token 판단.
