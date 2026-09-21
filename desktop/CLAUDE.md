# desktop/ — Damwha macOS 앱 (Electron)

Electron main이 네 서비스를 감독한다 — 번들 PostgreSQL, NestJS API(자식), worker·embed. **packaged는 번들 python(`Resources/python/bin/python3.12 -m …`)으로 돌고 저장소 체크아웃을 모른다**(Phase 4 Part 2). dev만 `uv run`과 저장소를 쓴다. 설계는 Phase별 스펙에 있다:
[Phase 1](../docs/superpowers/specs/2026-09-11-electron-phase-1-app-foundation-design.md) ·
[Phase 2](../docs/superpowers/specs/2026-09-12-electron-phase-2-service-orchestration-design.md) ·
[Phase 3](../docs/superpowers/specs/2026-09-14-electron-phase-3-embedded-postgres-design.md) ·
[Phase 4](../docs/superpowers/specs/2026-09-16-electron-phase-4-embedded-python-runtime-design.md).

## 명령

```bash
pnpm desktop:dev     # build-postgres.sh·build-python.sh·build-ffmpeg.sh(셋 다 캐시) → tsc → electron .
pnpm desktop:build   # 위 셋 → tsc → be·fe build → pnpm deploy → electron-builder
                     #   → hardened runtime 서명(plist 둘) → check-bundle (31건)
bash desktop/scripts/build-postgres.sh [--fresh]               # 내장 PG
bash desktop/scripts/build-python.sh   [--fresh|--print-key]   # 내장 Python 3.12 + worker 층 (1.3 GB)
bash desktop/scripts/build-ffmpeg.sh   [--fresh]               # 내장 ffmpeg·ffprobe
```

캐시는 `desktop/.cache/{postgres,python,ffmpeg}`, 스테이징은 `desktop/build/<이름>` (둘 다 gitignore).

**캐시가 비면 `desktop:dev`도 1.3 GB를 빌드한다** — Python 런타임 층 ~140초 + worker 층 ~150초
(`~/.cache/uv`가 온난할 때). 캐시가 적중하는지 확인하려고 그냥 돌리면 미스일 때 그 자리에서
빌드가 시작되므로, 두 층의 키와 적중 여부만 보려면 `build-python.sh --print-key`를 쓴다.

루트 `pnpm build`·`pnpm dev`는 이 셋을 빌드하지 않고 Electron을 띄우지 않는다.

## 번들 — `Resources/` 아래 넷

`desktop/build/<이름>`에 스테이징한 것을 `electron-builder.yml`의 `extraResources: - from: build`가
그대로 `Contents/Resources/<이름>`으로 싣는다. dev는 `desktop/build/`를 같은 자리로 본다 (Phase 4 §6.1).

| `Resources/` | 만드는 것 |
| --- | --- |
| `api/` | `package.mjs` — `pnpm deploy` 산출물에 `dist/public`으로 SPA를 얹는다 |
| `postgres/` | `build-postgres.sh` |
| `python/` | `build-python.sh` — 인터프리터·의존성 층(`rt-<키>`) 위에 `damwha_worker` 층(`wk-<키>`) |
| `ffmpeg/` | `build-ffmpeg.sh` |

서명은 electron-builder가 아니라 `package.mjs`가 그 뒤에 한다(`identity: null`이 자동 탐색을 끈다).
**plist 둘로 갈린다** — `build-resources/entitlements.python.plist`(키 둘)는 `Resources/python`의
Mach-O 전수와 `Resources/ffmpeg/bin/*`에, `entitlements.mac.plist`(키 셋 — 둘 + `allow-jit`)는
`.app` 본체에 `--deep`으로. 둘 다 `--options runtime`이다.

- **안쪽을 먼저 서명한다.** `.app` 서명이 Resources를 해시로 봉인하므로 순서가 뒤집히면 봉인이
  서명 전 내용을 가리키고 `codesign --verify`가 깨진다.
- `.app`에 python plist를 주면 V8이 `allow-jit` 없이 CodeRange 예약에 실패해 rc=133으로 죽는다.
  거꾸로 Python 트리에 `allow-jit`은 주지 않는다 — 안 쓰는 권한이다.
- `Resources/postgres`도 hardened runtime을 진다(Ruling R12, Task 6) — entitlements는 주지 않는다.
  원래는 "별개 프로세스라 자기 서명의 플래그로 돈다"며 runtime을 걸지 않았으나, Apple 공증이 번들 안
  실행 파일에 hardened runtime을 요구한다(실측: 제출 id 88197b1f-daae-41bc-aa68-e62176a321de가
  `postgres/bin`의 실행 파일 32개 전부를 "hardened runtime 없음"으로 거절했다, task-6-report.md).
  entitlements를 안 주는 이유는 그대로다 — postgres 트리 전체(pgvector·pg_bigm 포함)가 이미 같은
  Team ID로 서명돼 있어 hardened runtime의 library validation이 disable-library-validation 없이도
  통과한다(2026-09-21 실측: 재빌드한 앱을 띄워 postgres가 pgvector 0.8.6·pg_bigm 1.2를 로드하며
  뜨는 것과 api·worker의 DB 연결을 확인했다). `check-bundle.mjs`의 hardened runtime 단언은 이제
  postgres·python·ffmpeg 트리 전부에 건다.
- 서명한 뒤 **번들 python을 실행하지 않는다.** `__pycache__`가 봉인 밖에 생기고, `.pyc`에는
  빌드 머신의 절대 경로가 `co_filename`으로 박힌다 (`check-bundle.mjs`가 둘 다 잡는다).

## 서명·배포 (Phase 6a)

Developer ID로 서명하고 공증까지 마친 DMG로 배포한다. ad-hoc은 더 없다 — `signing.json`이
없거나 그 신원이 키체인에 없으면 패키징이 그 자리에서 죽는다(`scripts/lib/signing.mjs`).

- **신원은 `desktop/scripts/signing.json`**(gitignore 아님, 비밀이 아니다) — `identity`(sha1
  지문 `C35965CC0997E3897DED5C0975B4064D8AA4E27A`), `teamId`(`L5Y9SZHGRN`), `notaryProfile`
  (`damwha`, 키체인 앱 암호 프로필 이름). **이름이 아니라 지문을 쓴다** — 이 키체인에 동명
  `iPhone Distribution` 항목이 넷 있고, 2026-09-13에 이름 중복이 `codesign`을 `ambiguous`로
  실패시킨 적이 있다.
- **개인 키·`.p12` 백업은 `~/Documents/damwha-signing`**(0700, 저장소 밖·커밋 안 함) —
  `signing.mjs:35`가 신원을 못 찾으면 이 경로에서 import하라고 바로 안내한다. **잃으면**:
  인증서는 재발급되지만 새 키는 다른 identity가 되므로 기존 사용자의 TCC 마이크 권한과
  `safeStorage` 토큰이 전부 무효가 된다 — Phase 1이 경고한 "재빌드마다 권한 무효화"가 그대로
  돌아온다(스펙 §12 위험 1). **스펙 §3-7은 "이 맥 밖에 한 벌 더 둔다"고 적었으나, 실제로 그렇게
  됐는지는 확인된 적이 없다 — 위치 미기재, 사용자 확인 필요.**
- **`--release`가 유일한 새 플래그다**(`pnpm run package:release` = `package.mjs --release`).
  없으면(`pnpm desktop:build`가 쓰는 `package:desktop`) 지금까지와 같은 `--dir`뿐 — 공증·DMG가
  전혀 안 돌아 개발 루프 시간이 늘지 않는다. `--release`일 때만: 태그가 버전과 맞는지 확인(어긋나면
  electron-builder 앞에서 멈춤) → `.app` 공증·스테이플 → `check-bundle` 재확인 → `--prepackaged`로
  DMG 생성(재서명하지 않고 이미 서명·스테이플된 바이트를 그대로 담는다) → DMG 서명·공증·스테이플·
  `sha256` → 마운트해 안의 `.app`도 재검증. **`gh release create`는 여기 없다** — 자산 발행은
  별도 단계다(`package.mjs`에 grep해도 없다).
- **태그 네임스페이스는 `desktop-v<version>`**이고 `deploy/release.sh`가 쓰는 `v<version>`
  (셀프호스팅 웹 배포, `v0.1.1`~`v0.2.3` 실재)과 다르다. 섞으면 그 스크립트가 태그 버전을
  `be/worker/pyproject.toml`과 대조해 거절하고, 6b의 업데이트 조회가 웹 배포를 가리켜 앱이
  사용자에게 tarball을 권하게 된다.
- **최소 macOS 15.0을 세 자리가 같은 값으로 강제한다** — `scripts/lib/build-target.sh`의
  `MACOSX_DEPLOYMENT_TARGET`(postgres·ffmpeg 소스 빌드가 source), `electron-builder.yml`의
  `LSMinimumSystemVersion`, `scripts/lib/minos.mjs`의 `MAX_MINOS`(`check-bundle`이 번들 Mach-O
  전수의 `vtool -show-build` 값을 이 상한과 비교해 초과하면 exit 1). mlx·mlx-metal은
  `scripts/mlx-pin.txt`로 15.0 휠을 직접 URL 고정한다 — uv의 플랫폼 태그로는 못 고른다.

## 디스크 부족 — 진입점 셋 (Phase 6a)

디스크가 부족할 때 원인·복구 안내가 화면에 뜨는 경로가 셋이다. 문구 원천은
`desktop/src/diagnostics/causes.ts`의 `diskFull` 하나뿐이고, worker·API·FE는 서로 다른
런타임(파이썬·Node·별개 워크스페이스)이라 import를 못 해 바이트 단위로 재현한다 — 그 파일의
머리 주석이 새 사본 만들기를 금한다.

| 경로 | 어디서 잡나 | 화면 |
| --- | --- | --- |
| worker 모델 다운로드(job·embed·LLM 기동 셋 다 공통) | `models/disk.py` + `downloads.py`의 `hooked`(HF 진행 훅 설치 지점, 우회 분기 앞·캐시 우선 분기 뒤) | job은 회의 카드, embed·LLM은 상태 창에 `DISK_FULL` 사유 |
| 업로드(회의 생성·화자 등록) | `be/src/storage/disk-full.filter.ts` — ENOSPC를 507로 | `meeting`·`job` 행이 생기기 전에 507 — multer가 컨트롤러 진입 전에 쓴다 |
| LLM 서버 요청 스레드 | `llm_server.py`의 `run_guarding_disk_full` + `_start_stderr_relay`(`popen()` 직후부터 자식 stderr를 장수 스레드로 감시) | `lens_llm_timeout_seconds`(기본 300초)를 기다리지 않고 그 자리에서 `DISK_FULL`로 job 실패 |

세 번째 줄은 Phase 6a 안에서 나중에 더해졌다(Ruling R16) — `mlx_lm.server`의 요청 처리 스레드
안에서 올라온 예외가 Python 기본 스레드 예외 훅에 삼켜져, 고치기 전에는 5분 뒤 거짓 사유
(`llm_request_failed`/"시간이 초과됐어요")로만 보였다.

## 구조 — `src/`는 "무슨 일을 맡는가"로 나눈다

| 경로 | 맡는 일 |
| --- | --- |
| `main.ts` | Electron 초기화와 이벤트 배선. 앱 상태도 아직 여기 있다 |
| `app/` | 앱 전체의 시작·복구·종료 흐름 — 종료·창 닫기 흐름(`quit-flow`), 창 재열기(`window-flow`), 재시도 정책, 스폰 가드 |
| `windows/` | 창과 화면 — 셸·상태 창, 화면 판정(`shell-url`·`status-view`), 메뉴, 권한·출처 경계, 렌더러 왕복(`recording-bridge`) |
| `services/` | 서비스별 정책과 감독 — `supervisor`, api·worker·embed 스펙, `postgres/`(레이아웃·핸들·페어링·마이그레이션) |
| `process/` | 서비스들이 함께 쓰는 실행·조회 도구 — 핸들 타입, 출력 싱크, python 런처(`python-launcher`: packaged는 번들 python, dev는 `uv run`), 번들 경로 판정(`runtime-paths`), 고아 회수(`orphans`), 도구 러너, 프로세스 트리·포트·실행 파일 탐색, 준비 프로브 |
| `config/` | `config.json` 읽기·재로딩, DB URL 마스킹, 저장소 루트 판정 |
| `diagnostics/` | 로그 회전, stderr 요약, 원인 목록(`causes`) |
| `dev/` | dev 전용 — Vite 자식 |

- 순수한가가 아니라 책임으로 나눈다. electron을 쓰는 `windows/shell-window.ts`와 순수 판단인 `windows/shell-url.ts`가 같은 폴더다. 테스트 가능성은 **파일** 단위 분리로 지킨다(아래 "지키는 것"의 마지막 줄).
- 한 서비스가 다른 서비스의 파일을 import하지 않는다(공통인 `types`·`failure`와 스펙을 조립하는 `specs`는 예외). 둘 이상이 쓰게 되면 `process/`로 꺼낸다 — `launchWithUv`·`makeSink`가 그렇게 worker·api에서 나왔다. `process/`는 `services/types`의 타입 말고는 서비스를 모른다.
- `tests/`는 `src/`와 같은 트리다(`tests/services/postgres/handle.test.ts` ↔ `src/services/postgres/handle.ts`). 테스트가 `__dirname`으로 `shell/`·`build/`·`../fe`를 읽으므로 옮기면 그 깊이도 고친다.

## 데이터 위치 — dev와 packaged가 **같은** 곳을 쓴다

`~/Library/Application Support/Damwha` (`main.ts`의 `app.setName("Damwha")`). 클러스터도 하나다 — dev는
`desktop/build/postgres`, packaged는 `Resources/postgres`의 바이너리로 같은 PGDATA를 연다.

| 경로 | 무엇 |
| --- | --- |
| `data/postgres/` | 내장 클러스터 (PGDATA) |
| `data/storage/` | 그 클러스터와 짝인 파일 저장소. `.damwha-cluster` 마커가 짝을 증명한다 — 지우거나 옮기면 앱이 기동을 거부한다 |
| `run/` | 소켓 디렉터리(0700). TCP는 열지 않는다 |
| `backups/` | 데이터가 있는 DB에 마이그레이션을 적용하기 전의 `pg_dump -Fc`, 최근 5개 |
| `logs/` | `supervisor.log`·`api.log`·`worker.log`·`embed.log`·`postgres.log`(초기 stderr), `postgres/`(서버 로그) |
| `storage/` | Phase 1·2가 Docker DB와 쓴 파일. 앱은 읽지도 쓰지도 않는다 (Phase 5가 데이터 이전을 범위에서 뺐다 — 옮기는 주체가 없다) |
| `config.json` | 사람이 고치는 설정. 앱은 다시 쓰지 않는다(`REPO_ROOT` 저장 제외). 손으로 고친 뒤 JSON이 유효한지 확인한다 |

파괴적인 실험(DB 삭제·`PG_VERSION` 변경 등)은 앱을 끄고 `ditto data data.<이름>-backup`으로 통째로 복사한 뒤에만 한다 —
dev와 packaged가 같은 클러스터라 버려도 되는 "dev 클러스터"가 따로 없다.

## 중단된 작업의 회수 — 층이 넷

앱은 job을 직접 처리하지 않지만 **중단을 넷으로 나눠 거둔다** (Phase 5 스펙 §4·§8). 대상도 주체도
달라서 하나가 다른 하나를 대신하지 않는다.

| 층 | 언제 | 무엇을 | 어디 |
| --- | --- | --- | --- |
| 기동 회수 | API 기동 1회 (`onApplicationBootstrap`) | **앞 실행**이 남긴 `running` job — `locked_by`가 `desktop-`으로 시작하고 이번 실행 신분이 아닌 행 | `be/src/jobs/reaper.service.ts` → `JobsRepository.reclaimOrphaned` |
| 시간 기반 reaper | 5분 크론 | `locked_at`이 30분(`REAPER_STALE_MINUTES`)보다 오래된 `running` job — **이번 실행 중에** 죽은 것 | 같은 `ReaperService`, 그리고 worker의 같은 CTE |
| `--once` 스캔 | worker를 다시 띄우기 **직전** (크래시 재시작·사람이 누른 재시작 둘 다) | **프로세스** — 이번 실행 run-id를 단 `--once` 자식 | `services/supervisor.ts`의 `reapOwnOnceBefore` → `process/orphans.ts`의 `reapOwnOnceChildren` |
| 자기 고아 회수 | worker supervisor가 **자기 자식이 하나도 없는 순간** — 기동 직후·자식을 거둔 직후·DB 재접속 직후 | 자기 `WORKER_ID`로 잠긴 `running` job, **시간 조건 없이** | `be/worker/damwha_worker/__main__.py`의 `_reap_own_orphans` → `db/queue.py`의 `reap_own_orphans`

- **신분은 `RUN_WORKER_ID`(`desktop-<uuid>`)이고 앱 실행마다 새로 발급된다.** `withAppOwned`가 모든
  자식 env에 `WORKER_ID`로 얹는다. 터미널 `pnpm worker`(`worker-1`)와 웹 배포판은 접두사에 걸리지
  않아 **앱이 그 job을 건드리지 않는다** — Phase 2의 "외부 서비스와 앱 소유를 구분한다"와 같은 결이다.
- 기동 회수는 `attempts`를 **되돌리지 않고** 세 갈래로 간다: 남은 재시도가 있는 비-live는 `queued`로,
  다 쓴 비-live는 `failed`(`app_restarted`)로 — 딸린 `meeting`·요약·렌즈 run·화자까지 함께 닫는다 —
  `live_session`은 언제나 `failed`로. 앱을 다섯 번 강제 종료하면 그 job은 실패한다. 그것이 정직하다
  (그 job이 앱을 죽이고 있을 수 있다). 라이브의 봉인·마무리는 회수가 아니라 API의
  `LiveOrphanService`가 한다 — 회수는 그 경로를 30분 기다리지 않고 여는 것뿐이다.
- **회수도 스캔도 기동·재시작을 막지 않는다.** 회수 SQL은 `FOR UPDATE SKIP LOCKED`라 남이 쥔 행을
  기다리지 않고(기동 훅은 HTTP 리슨 **전에** 대기한다 — 잠금 대기는 예외가 아니라 try/catch가
  못 잡는다), 실패하면 로그만 남긴다. `--once` 스캔 실패도 재시작을 계속한다.
- 기동 시 **프로세스** 고아 정리(`app/reap-on-start.ts` → `reapOrphans`)는 이 셋과 다른 일이다 —
  그쪽은 앞 실행 run-id의 프로세스, 기동 회수는 DB 행이다. `--once` 스캔이 보는 것은 **이번 실행**
  run-id라 기동 정리가 보지 않는 사각이다.
- **네 번째 층이 왜 있나 (P5-C8, 2026-09-20 실측).** postgres가 죽으면 그 job을 쥔 `--once` 자식도
  연결이 끊겨 죽는데, supervisor 부모는 재연결에 성공해 살아남는다. 그러면 앞의 셋이 모두 비켜 간다 —
  기동 회수는 **앞 실행**의 행만 보고, `--once` 스캔은 supervisor가 재시작해야 도는데 재시작이 없었다.
  남는 것이 30분 reaper뿐이라 그 행은 `running`인 채 얼어 있었고(실측 4분 30초) 화면은 "회의를
  처리하고 있어요 · 35%"라는 거짓을 계속 말했다. 자기 고아 회수가 그 자리를 메운다. 성립 근거는
  **부모가 자식을 한 번에 하나만 띄우고 `_wait_child`로 거둔다**는 것 — 그래서 저 세 순간에는 자기
  신분으로 잠긴 행이 전부 고아다. 시간 조건이 없어도 남의 행을 건드리지 않는다.
- 자기 고아 회수도 `attempts`를 **되돌리지 않고** 기동 회수와 같은 갈래로 간다(재시도가 남은 비-live는
  `queued`, 소진했거나 `live_session`이면 `failed` — `reap_stale`과 SQL 한 벌을 공유한다). 재현
  회차에서 `attempts`가 1에서 2가 되고 새 `--once` 자식이 같은 job을 이어받았다.

`WORKER_ID`와 `ps`에 보이는 `--run-id`는 **같은 실행 안에서도 값이 다르다** — 전자는 `config.ts`의
`RUN_WORKER_ID`로 `job.locked_by`에 들어가고, 후자는 supervisor의 실행 id다. 둘 다 `desktop-` 접두사를
쓰므로 정합성 질의에 넣을 값은 `worker.log`의 `supervisor <id> ready (db connected)` 줄에서 읽는다.

## 재시도 — 0 · 30초 · 90초 · 210초 · 450초

worker가 TRANSIENT 실패를 requeue할 때 `next_attempt_at = now() + least(30 * 2^(attempts-1), 900)초`다
(`be/worker/damwha_worker/db/queue.py`). `job.max_attempts` 컬럼 기본값은 **5**(마이그레이션 `025`)라
claim 직후 실패를 기준으로 시도 시각이 0 · 30초 · 90초 · 210초 · 450초가 된다 — **4회차가 3.5분에
닿으므로 3분짜리 끊김(모델 다운로드 등)을 사람 개입 없이 같은 job이 넘긴다.**

- 앱이 보기에 그 구간은 `queued`다. 화면은 "재시도 대기 · N/M회차 · 약 M분 뒤"와 마지막 오류 코드로
  말한다 — 그 문구가 없으면 정상 백오프와 worker 미기동·DB 장애가 한 얼굴이 된다.
- 마이그레이션 `025` **전에 만들어진 job은 그대로 `max_attempts=3`**이다. 새 기본값은 그 뒤에
  enqueue된 job에만 붙는다.
- `live_session`은 `maxAttempts: 1`을 명시해 이 기본값을 타지 않는다. 라이브 오류는 전부 PERMANENT다.
- **강제 종료 N번은 재시도 5회 중 N회를 먹는다** — `attempts` 한 컬럼이 크래시 회수와 일시 실패를
  함께 센다. 나누려면 스키마 변경이 필요해 Phase 6이 받는다.

## 디버깅

- 내장 DB 접속: 상태 창(메뉴 → 서비스 → 서비스 상태)의 데이터베이스 줄에 명령이 있다 — `"<번들>/bin/psql" -h "<userData>/run" -U damwha damwha`.
- 거부·실패 사유: 기동(`launch`) 실패는 `supervisor.log`에 `기동 실패 — …`로 남는다. 준비 판정(판정표 2) 거부는 화면에만 뜨고 로그에는 상태 줄만 남는다. 마이그레이션 러너의 출력 전체는 `supervisor.log`에 있다.
- Docker 개발 DB에 붙여 재현: `config.json`에 `"DEBUG_EXTERNAL_DATABASE_URL": "postgres://postgres:postgres@localhost:5432/damwha"`. 내장 PG를 띄우지 않고, 마이그레이션은 **감지만** 하며, 상태 창에 `외부 DB(디버깅)`이 상시 뜬다. 모드 변경은 앱을 다시 켜야 반영된다. 이 모드에서도 worker는 기동하며 `app_setting.worker_capabilities`를 그 DB에 쓴다.

## 지키는 것

- postmaster에는 SIGINT(fast)·SIGQUIT(immediate)만. `services/postgres/handle.ts`의 신호 타입이 SIGKILL을 막는다.
- 앱이 지우는 것은 넷뿐 — `data/postgres.initdb-*`, 증명한 낡은 락, 5개 초과 백업, `*.dump.partial`. 거부 경로는 아무것도 만들거나 지우지 않는다.
- 마이그레이션 실패·페어링 거부 같은 `manual` 실패는 자동 재시도하지 않는다(`app/retry-policy.ts`, 창 재열기도 재시도하지 않는다 — `app/window-flow.ts`). 메뉴의 "다시 시도"만 다시 돈다.
- `desktop/package.json`의 `dependencies`는 비어 있다(번들 위생). DB에는 번들 `psql`·`pg_controldata`와 `migrate.js`로만 묻는다.
- `main.ts`는 electron을 값으로 import해 vitest가 부를 수 없다. 판단은 테스트 가능한 모듈로 빼고 `main.ts`에는 배선만 남긴다.
