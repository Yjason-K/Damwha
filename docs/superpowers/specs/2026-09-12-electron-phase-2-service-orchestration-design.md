# Electron Phase 2 — 서비스 실행 통합 설계

작성일: 2026-09-12
브랜치: `feat/electron-migration-phase-2-service-orchestration`
분기점: `dev` (`2764ffd`)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 2. 서비스 실행 통합"
선행 Phase 결과: [Phase 1 결과](../reports/2026-09-11-electron-phase-1-app-foundation-results.md)
선행 Phase 스펙: [Phase 1 설계](2026-09-11-electron-phase-1-app-foundation-design.md)

**상태: 스펙 작성 중. 구현 미착수.** 완료 기준의 판정 값은 계획 실행 단계에서 증거와 함께 채운다.

## 1. 이 Phase가 만드는 것

터미널을 열지 않고 담화를 쓴다. 앱이 DB·API·worker·embed 넷의 기동과 종료를 관리한다.

Phase 1은 자식 **하나**(API)를 만들고 정리했다. 이 Phase는 그 절차를 **넷으로 확장**하면서, 확장이
가능한 모양으로 계약을 세운다. 만드는 것은 편의가 아니라 **서비스 실행 계약**이다 — 로드맵 범위
5번("기존 실행 파일을 후속 Phase의 내장 실행 파일로 교체할 수 있는 계약 확정")이 이 Phase의 무게
중심이고, Phase 3·4는 그 계약의 `launch()` 하나씩만 갈아끼우는 일이 된다.

이 Phase가 세우는 다섯 계약:

1. **서비스 실행 계약** — 한 서비스를 무엇으로 띄우고, 준비를 무엇으로 판정하고, 어떻게 내리는가.
2. **소유권 계약(확장)** — 앱이 만든 것과 외부의 것을 서비스마다 어떻게 가르는가. 포트가 없는
   서비스는 어떻게 가르는가.
3. **준비 상태 계약(확장)** — "프로세스가 살아 있다"와 "그 프로세스가 일을 한다"를 나눈다.
4. **종료 계약** — 의존 역순, 서비스별 정중한 절차, 진행 중 작업의 처리.
5. **실행 파일 해석 계약** — 앱이 외부 실행 파일을 어떻게 찾고, 자식에게 어떤 `PATH`를 주는가.

## 2. Phase 1에서 인계받는 것

Phase 1 결과 문서의 "후속 Phase에 넘기는 것"이 넷을 이 Phase로 보냈다.

| 인계 항목 | 이 스펙에서 |
| --- | --- |
| `be/worker/.env`의 `STORAGE_ROOT`를 사람이 맞추는 수동 합의 | §6.4의 env 주입으로 **없어진다.** P2-C2가 판정한다 |
| ready 이후 자동 재시작 부재 | §6.8 재시작 정책 |
| dev와 packaged의 프로세스 의미가 다름 | §6.7·§11. 두 모드가 같은 서비스 집합과 같은 감독 코드를 쓰고, 차이는 어댑터의 `launch()` 한 줄로 좁힌다 |
| P1-C8 품질 — 여러 줄 원인이 `startup failed: [`까지만 보임 | §6.12에서 고친다 |
| P1-C10 검증 범위 — `unverified-owner` 화면 종단간 미발화 | §9의 비고. 이 Phase에서 수단이 생기면 1회 확인한다 |
| R1-6 — 포트 폴백 후 TCC 대화상자 재요청 여부 미판정 | §9의 비고. 사람이 1회 확인한다 |

Phase 1이 만든 기구 중 이 Phase가 **그대로 재사용**하는 것: `isPortOccupied()`(스폰 전 사전 점검),
`verifyOwnListener()`/`listenerPids()`/`descendantPids()`(소유 증명), `waitForReady()`/`probeHealth()`,
`lastMeaningfulLine()`/`ANSI_SGR`, `RETRY_DELAYS_MS`, `loadConfig()`, 셸 화면.

## 3. 현재 시스템에서 이 Phase가 건드리는 지점

| 지점 | 현재 상태 | Phase 2에서 |
| --- | --- | --- |
| `desktop/src/main.ts` | API 하나를 직접 띄우고 감시한다. 609줄 | 서비스 감독자를 부르는 쪽으로 바뀐다. 수명주기·창·권한만 남는다 |
| `desktop/src/api-process.ts` | `launchDev`/`launchPackaged` | `services/api.ts` 어댑터가 감싼다. 함수 자체는 유지 |
| `be/worker/damwha_worker/__main__.py` | `supervisor <id> started`를 **DB 연결 전에** 찍는다(`:296` → `:298` → `:107`) | DB 연결 성공 뒤 ready 한 줄을 추가한다. §10 |
| `fe/src/features/meeting/` | 라이브 중지는 화면의 버튼 경로에서만 불린다. `beforeunload`/`pagehide` 훅이 **0건** | 종료 handshake용 훅 하나를 `window`에 노출한다. §10 |
| `be/docker-compose.yml` | `name: damwha`, `restart: unless-stopped`, `pg_isready` healthcheck | **변경 없음.** 앱이 읽고 부르기만 한다 |
| `be/src/` | Phase 1이 `HOST`를 추가한 상태 | **변경 없음** |
| `packages/contracts/` | — | 변경 없음 |

제품 코드 변경은 `be/worker` 1파일과 `fe/` 1군데뿐이다. §10에 전량을 적는다.

## 4. 범위

### 4.1 포함

- `desktop/src/services/` — 서비스 감독자와 어댑터 넷.
- DB 준비 확인·기동 연계 (`docker compose up -d`), worker·embed 자동 실행.
- 실행 파일 탐색과 자식 `PATH` 보강.
- 의존 순서 기동, 준비 판정, 상태 모델(프로세스 × 건강), 실패 표시, 재시작, 로그 회전.
- 의존 역순 종료와 서비스별 정중한 종료 절차. 앱이 만든 전체 프로세스 트리의 정리.
- 창 닫기와 앱 종료 구분. 녹음·분석 중 종료 정책과 녹음 종료 handshake.
- 외부 실행 서비스의 감지와 정책(채택 / 비기동 경고).
- 미적용 마이그레이션 감지 게이트.
- 서비스 상태 창(표시 전용)과 원인별 복구 안내.

### 4.2 제외

| 제외 | 이유 |
| --- | --- |
| 마이그레이션 **실행** | 감지·안내까지만 한다(§6.7). 실행은 Phase 3 |
| PostgreSQL 내장 | Phase 3 |
| Python·ML·ffmpeg 내장, 모델 다운로드 | Phase 4. `FFMPEG_BIN` 문제는 §15로 인계 |
| job lease token 도입 | §13 R2-6. API·worker 양쪽의 SQL 계약 변경이라 이 Phase 범위를 넘는다 |
| 기존 DB·녹음·모델 이전 | Phase 5 |
| 서명·공증·DMG·자동 업데이트 | Phase 6 |
| 렌더러 → main IPC 채널 | §6.11. Phase 1 계약을 유지한다 |
| Docker Desktop 자동 실행 | 앱이 대신 켜지 않는다. 데몬이 없으면 안내한다 |
| Intel 맥, Mac App Store | 로드맵 전체 범위 밖 |

### 4.3 선행 조건

Phase 1의 선행 조건 4개 중 **1·2·3번이 사라진다** — 그것이 이 Phase의 목적이다.

구현·검증 시점에 갖춰져 있어야 하는 것:

1. **Docker Desktop이 실행 중이다.** 앱은 데몬을 켜지 않는다.
2. **`uv`가 설치돼 있고 `be/worker`의 venv가 `uv sync --extra models`로 준비돼 있다.**
3. **`be/worker/.env`와 `be/.env`가 존재한다.** 앱이 주입하지 않는 키(모델 선택, `HF_TOKEN` 등)가
   거기서 온다. `be/.gitignore:7`이 두 파일을 무시하므로 새 체크아웃에는 없다 — §6.4가 그 경우를
   기동 전에 판정한다.
4. **DB에 마이그레이션이 적용돼 있다.** 앱은 감지만 하고 실행하지 않는다.
5. packaged 검증에는 저장소 체크아웃이 있어야 한다(§6.4의 `REPO_ROOT`).

## 5. 데이터 안전 규칙

Phase 1 §5를 그대로 잇고, 이 Phase가 새로 여는 위험 둘을 더한다. 각 규칙은 P2-C15와 P2-C5가
실측으로 판정한다.

- 앱은 기존 `be/storage`에 **쓰지 않는다.** `STORAGE_ROOT` 기본값이 `<userData>/storage`다.
- 앱은 **마이그레이션을 실행하지 않는다.** `_migrations` 행 수가 변하지 않는다(P2-C15).
- 앱은 `damwha_pgdata` 볼륨과 compose의 `name: damwha`를 건드리지 않는다. **컨테이너를 내리지도
  지우지도 않는다** — `docker compose up -d`만 부르고 `down`·`stop`·`rm`은 부르지 않는다.
- **앱이 만들지 않은 프로세스는 죽이지 않는다.** 외부 worker·embed·Postgres가 대상이다(P2-C6).
- **진행 중인 job을 강제로 잃지 않는다.** 종료는 정중한 경로를 먼저 쓰고, 그 경로가 `attempts`를
  되돌린다(P2-C5). 강제 종료는 사람이 명시적으로 고른 경우에만 일어난다.
- **녹음 중 종료가 오디오를 버리지 않는다.** 종료 전에 렌더러의 라이브 중지를 완주시킨다(P2-C13).
- `.app` 번들 **안에는 쓰지 않는다.** `uv`가 venv를 만들 수 있는 자리는 번들 밖이다.

## 6. 구성요소와 계약

### 6.1 패키지 구조

```
desktop/src/
  main.ts               수명주기, 창, 단일 인스턴스, 권한 — 서비스 관리는 supervisor에 위임
  services/
    types.ts            ServiceSpec, ServiceHandle, ServiceState, ReadinessProbe
    supervisor.ts       의존 순서 기동 · 준비 대기 · 감시/재시작 · 역순 종료
    resolve.ts          실행 파일 탐색 + 자식 PATH 보강
    external.ts         외부 인스턴스 감지 (포트 기반 / ps 기반)
    postgres.ts         어댑터
    api.ts              어댑터 (Phase 1의 launchDev/launchPackaged를 감싼다)
    embed.ts            어댑터
    worker.ts           어댑터
  shutdown.ts           종료 정책 — 진행 중 판정, 대화상자, 녹음 handshake
  logs.ts               로그 파일 회전과 ANSI 제거
  shell/
    status.html         Phase 1의 준비·오류 화면 (확장)
    services.html       서비스 상태 창 (신규, 표시 전용)
```

기존 `api-process.ts`·`readiness.ts`·`port.ts`·`stderr.ts`·`config.ts`·`origin.ts`·`permissions.ts`·
`menu.ts`·`shell-window.ts`·`vite-process.ts`는 유지한다. `main.ts`는 줄어든다.

### 6.2 서비스 실행 계약

```ts
type ServiceId = "postgres" | "api" | "embed" | "worker";

interface ServiceSpec {
  id: ServiceId;
  /** 시작 순서와 종료 역순을 이 한 값이 결정한다. */
  dependsOn: ServiceId[];
  /** 화면을 열기 전에 준비를 기다리는가. §6.7 */
  gate: boolean;
  /** 외부에 이미 있으면 무엇을 하는가. §6.5 */
  externalPolicy: "adopt" | "stand-down" | "use-as-is" | "relocate";
  detectExternal(ctx: LaunchContext): Promise<ExternalState>;
  /** ← Phase 3·4가 갈아끼우는 유일한 지점. */
  launch(ctx: LaunchContext): Promise<ServiceHandle>;
  readiness: ReadinessProbe;
  stop(handle: ServiceHandle, plan: StopPlan): Promise<StopOutcome>;
  restart: { maxAttempts: number; backoffMs: readonly number[] } | "never";
}
```

**이 계약이 Phase 3·4를 버티는가.** `postgres.launch`는 `docker compose up -d`에서 번들
`pg_ctl`로, `worker.launch`·`embed.launch`는 `uv run`에서 번들 Python으로 바뀐다. 순서·준비·감시·
종료·로그·화면은 그대로다.

**완전히는 버티지 못한다.** 바이너리 해석의 일부가 worker **안**에 있다 —
`be/worker/damwha_worker/pipeline/ffmpeg.py:24,59`가 `"ffprobe"`·`"ffmpeg"`를 리터럴로
`subprocess`에 넘긴다. 런처가 아무리 절대 경로를 알아도 그 호출은 `PATH`를 본다. Phase 2는
§6.3의 `PATH` 보강으로 덮고, **Phase 4가 `FFMPEG_BIN`/`FFPROBE_BIN`을 worker `Settings`에
넣어야 한다**는 것을 §15에 인계한다. 이 한계를 적어 두지 않으면 Phase 4가 번들 ffmpeg를 넣고도
개발 도구 없는 맥에서 `probe_failed`로 죽는 것을 실행 시점에야 발견한다.

### 6.3 실행 파일 해석과 PATH

**Finder로 띄운 앱의 `PATH`는 `/usr/bin:/bin:/usr/sbin:/sbin`뿐이다.** 이 기계에서 `uv`는
`/opt/homebrew/bin`, `docker`는 `/usr/local/bin`이라 둘 다 없다(2026-09-12 실측).

탐색 디렉터리 목록(순서대로):

```
config.json의 EXTRA_PATH (있으면 맨 앞)
/opt/homebrew/bin, /opt/homebrew/sbin
/usr/local/bin, /usr/local/sbin
<HOME>/.local/bin, <HOME>/.cargo/bin
/usr/bin, /bin, /usr/sbin, /sbin
```

두 가지를 한 목록으로 한다.

1. `uv`·`docker`는 이 목록에서 **절대 경로로 찾아** 그것으로 실행한다. `config.json`의
   `UV_BIN`·`DOCKER_BIN`이 있으면 탐색보다 우선한다.
2. **같은 목록을 자식 env의 `PATH` 앞에 붙인다.** 이게 없으면 worker 안의
   `shutil.which("mlx_lm.server")`(`llm_server.py:88`)가 렌즈·요약 서버를 못 찾아 그 job들이
   PERMANENT `llm_server_start_failed`로 죽고, `ffmpeg.py`의 리터럴 호출도 실패한다.

못 찾으면 **무엇을 못 찾았는지와 고치는 방법**을 화면에 적는다(P2-C8). 조용히 기본 이름으로
실행해 `ENOENT`를 stderr에 남기지 않는다 — Phase 1이 `sysctl`에서 같은 값을 치렀다.

### 6.4 경로·설정 계약

#### `REPO_ROOT`

packaged `.app` 안에는 `be/worker/`도 `be/docker-compose.yml`도 없다. Phase 3·4가 번들할
것들이고, 이 Phase는 **저장소 체크아웃을 가리켜야** 한다.

빌드 시점에 굽지 않는다 — Phase 1의 완료 기준 P1-C11이 "번들 안에 저장소 절대 경로 문자열 0건"을
요구하고, 그 기준은 이 Phase에서도 유지된다(P2-C14).

```
1. config.json의 REPO_ROOT가 있으면 그것
2. dev에서는 app.getAppPath()/.. 로 추론
3. 둘 다 없으면 dialog.showOpenDialog로 폴더를 한 번 묻고 config.json에 저장
```

고른 경로는 `be/worker/pyproject.toml`과 `be/docker-compose.yml`의 존재로 검증한다. 아니면 다시
묻는다. **Phase 3·4가 번들을 넣으면 이 물음 자체가 사라진다.**

#### `config.json` 확장

Phase 1의 세 키에 이 Phase의 키를 더한다. 파일 형식과 "앱이 소유하는 키는 덮어쓴다"는 규칙은
Phase 1 §6.3 그대로다.

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `DATABASE_URL`·`STORAGE_ROOT`·`PORT` | Phase 1과 같다 | — |
| `REPO_ROOT` | 없음 → 물어본다 | §위 |
| `EXTRA_PATH` | `[]` | 탐색 목록 맨 앞에 붙는다 |
| `UV_BIN`·`DOCKER_BIN` | 없음 → 탐색 | 탐색보다 우선 |
| `EMBED_PORT` | `8100` | 한 값에서 세 프로세스의 설정이 파생된다 |
| `WORKER_ID` | `desktop-<앱 실행마다 새 값>` | §6.5 |

`HOST`는 Phase 1과 같이 **앱이 고정 주입**하며 설정으로 열 수 없다.

#### env 주입

| 키 | api | worker | embed | 근거 |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | ○ | ○ | — | 셋이 같은 DB를 본다 |
| `STORAGE_ROOT`(절대) | ○ | ○ | — | **Phase 1의 수동 합의가 사라진다.** P2-C2 |
| `HOST` | `127.0.0.1` 고정 | — | — | Phase 1 §6.6 |
| `PORT` | 결정된 포트 | — | — | Phase 1 §6.4 |
| `WORKER_ID` | — | ○ | — | 외부 worker와 id가 겹치면 소유권 가드가 무너진다 |
| `EMBED_SERVICE_URL` | ○ | — | — | `be/src/config/env.ts`가 읽는 키 |
| `EMBED_SERVICE_HOST`/`PORT` | — | ○ | ○ | worker `config.py`가 읽는 키 |
| `LENS_LLM_BASE_URL` | — | ○ | ○ | **기본값 없는 필수값.** 없으면 worker가 로그 한 줄 전에 죽는다 |
| `PATH`(보강) | ○ | ○ | ○ | §6.3 |

`EMBED_SERVICE_URL`과 `EMBED_SERVICE_HOST`/`PORT`는 **`config.json`의 `EMBED_PORT` 한 값에서
파생한다.** API와 worker가 서로 다른 키를 읽기 때문에(`be/src/config/env.ts` 대 
`be/worker/damwha_worker/config.py:28-29`) 두 값을 따로 관리하면 어긋나고, **어긋난 결과는 오류가
아니라 조용한 degrade다** — API가 embed에 못 닿으면 검색이 키워드 전용으로 떨어진다. P2-C3이
의미 검색 결과로 그것을 판정한다.

`LENS_LLM_BASE_URL`은 `be/worker/damwha_worker/config.py:34-39`에서 **기본값 없는 필수 필드**이고
`load_settings()`가 기동 즉시 검증한다. `be/worker/.env`는 gitignore 대상이라(`be/.gitignore:7`)
없을 수 있다. 앱은 두 가지를 한다 — (1) worker를 띄우기 전에 `be/worker/.env`의 존재를 확인하고
없으면 원인과 복구 방법을 화면에 적는다, (2) `config.json`에 값이 있으면 주입한다.

pydantic-settings는 환경변수가 `.env`를 이긴다 — 2026-09-12 실측으로 확인했다
(`STORAGE_ROOT=/tmp/injected-wins uv run … load_settings()` → `/tmp/injected-wins`). 그래서 주입이
파일을 덮는다.

### 6.5 소유권 계약

앱이 **소유**하는 것은 자기가 `launch()`한 프로세스뿐이다. 소유하지 않은 것은 죽이지 않는다.

| 서비스 | 외부 판정 방법 | 정책 | 종료 시 |
| --- | --- | --- | --- |
| postgres | `docker compose ps` | `use-as-is` — 이미 떠 있으면 그대로 쓴다 | **건드리지 않는다** |
| api | Phase 1의 `isPortOccupied()` + `verifyOwnListener()` | 포트를 옮긴다 | 소유분만 내린다 |
| embed | 포트 + **`/embed` 계약 프로브** | `adopt` — 쓰고 죽이지 않는다 | 소유분만 내린다 |
| worker | `ps -axo pid,command` | `stand-down` — 자기 것을 띄우지 않고 경고한다 | 소유분만 내린다 |

**embed 채택 판정은 `/health`가 아니다.** `be/worker/damwha_worker/embed_service.py:24-25`의
`/health`는 `{"status":"ok"}`만 돌려주므로 **다른 모델·다른 차원을 서빙하는 서비스도 200을 준다.**
채택하면 API가 그 응답의 `model`·`dimension`을 거절해 모든 의미 검색이 조용히 키워드 검색으로
떨어진다. 그래서 채택 판정은 `POST /embed`에 짧은 입력을 넣어 `model`과 `dimension`이 설정값과
**일치할 때만** 성립한다. 불일치면 채택하지 않고 다른 포트에 우리 것을 띄우며, 그 사실을 화면에
적는다.

**worker는 포트가 없어 Phase 1의 기구를 쓸 수 없다.** `ps -axo pid,command`에서 `damwha_worker`를
찾되 두 가지를 거른다.

- `descendantPids()`로 얻은 **우리 자손**을 뺀다 (Phase 1의 BFS를 재사용).
- **argv에 `--once`가 있는 항목을 뺀다.** `__main__.py:279`가 자식을 
  `[sys.executable, "-m", "damwha_worker", "--once"]`로 띄우므로, 이것을 거르지 않으면 job 하나를
  처리 중인 일회성 자식을 상시 supervisor로 오인해 앱이 자기 worker를 영영 띄우지 않는다.

`stand-down`은 **앱을 막지 않는다.** DB·API·embed는 뜨고 화면은 열리며, 상태 창에 "외부 worker를
쓰는 중 — 그쪽 `STORAGE_ROOT`가 앱과 다르면 앱으로 올린 파일이 처리되지 않습니다"가 남는다.
그 경고를 확인으로 바꿀 수 없는 이유는 **다른 프로세스의 환경변수를 읽을 수 없기 때문**이다 —
이 macOS에서 `ps eww`는 SIP 때문에 다른 프로세스의 env를 내주지 않는다(2026-09-12 실측).

**`WORKER_ID`는 앱 실행마다 새로 만든다.** 기본값 `worker-1`을 외부 worker와 나눠 쓰면
`locked_by = worker_id AND status='running'`만 보는 소유권 가드가 둘을 구별하지 못한다
(`be/worker/damwha_worker/db/queue.py`). 더 좁은 위험이 이 Phase 때문에 새로 생긴다 — **재시작할
때 supervisor만 죽이면 `--once` 자식이 살아남아 같은 `WORKER_ID`를 쥔 채 돌고, 새 supervisor가
같은 id로 뜬다.** §6.9의 자손 정리가 그 구멍을 닫는다. 근본적인 해소(claim마다 lease token)는
API·worker 양쪽의 SQL 계약 변경이라 이 Phase 밖이다 — §13 R2-6, §15.

### 6.6 준비 상태 계약

**두 사실을 나눈다.** Phase 1은 하나로 봤지만 그것이 틀린 경우가 있다.

| 축 | 값 | 뜻 |
| --- | --- | --- |
| `state` | `stopped` · `starting` · `running` · `failed` | 프로세스가 있나 |
| `health` | `unknown` · `ok` · `degraded` | 그 프로세스가 실제로 일을 하나 |

나누는 이유는 API다. `be/src/database/database.service.ts:34`의 fail-fast는 **`onModuleInit`에만**
있다. 부팅 뒤 DB가 끊기면 API는 죽지 않고 `/api/health`가 503을 준다
(`be/src/health/health.controller.ts`). 프로세스가 살아 있으므로 종료 기반 재시작은 발화하지 않고,
`state`만 보는 감독자는 "정상 실행 중"을 띄우면서 모든 요청이 실패한다.

그래서 **`degraded`는 재시작을 유발하지 않는다.** 재시작해도 DB가 돌아오지 않으면 같고, 백오프만
태운다. 대신 원인과 복구 방법을 띄우고 health 회복을 계속 감시한다. DB가 돌아오면 스스로
`ok`로 돌아온다(P2-C11).

서비스별 준비 판정:

| 서비스 | ready 신호 | degraded 신호 |
| --- | --- | --- |
| postgres | `docker compose ps --format json`의 `Health == "healthy"` | healthy를 잃음 |
| api | `/api/health` 200 **+ `verifyOwnListener()` 소유 증명** (Phase 1 §6.4) | `/api/health` 503 |
| embed | `POST /embed` 계약 프로브 통과 (§6.5) | 프로브 실패 |
| worker | **DB 연결 성공 뒤에 찍히는 ready 로그 한 줄** (§10) | 그 줄보다 **뒤에** `reconnect failed`가 있음 |

**worker의 `degraded`도 같은 줄 하나로 판정한다.** worker는 API와 같은 모양의 문제를 갖는다 —
ready 뒤에 DB가 끊기면 `_reconnect()` 백오프 루프에 들어가 프로세스는 살아 있고 큐만 멈춘다
(`__main__.py:117-124`가 peek 오류에서 재접속을 다시 부른다). 프로세스 생존만 보는 감독자는 그것을
정상으로 읽는다.

그래서 §10의 ready 로그는 **첫 연결이 아니라 `_reconnect()`가 성공할 때마다** 찍는다. 그러면 한
줄이 두 가지를 다 준다 — 처음 나오면 `ready`, `reconnect failed`(`__main__.py:173`)가 그보다 뒤에
있으면 `degraded`, 그 뒤에 다시 나오면 `ok`로의 회복이다. API와 마찬가지로 `degraded`는 재시작을
유발하지 않는다.

**worker의 준비 신호를 새로 만드는 이유.** 기존 `supervisor <id> started`는 쓸 수 없다 —
`__main__.py:296`이 그 줄을 찍고 `:298`이 `run_supervisor()`를 부르며, **실제 DB 연결은 그 안
`:107`의 `_reconnect()`**다. 잘못된 `DATABASE_URL`이나 권한 오류면 그 줄을 찍은 뒤 백오프 루프에
무기한 머문다 — 화면은 "준비됨"인데 큐는 영원히 안 돈다. 그래서 `_reconnect()`가 성공한 **뒤에**
찍히는 줄을 추가하고 그것을 계약으로 삼는다. P2-C10이 이 회귀를 막는다.

`app_setting.worker_capabilities` 행은 준비 신호로 **쓰지 않는다.** 그 보고는 데몬 스레드에서
torch를 import하는 자식 프로세스를 거치므로 수십 초에서 120초가 걸리고
(`capabilities.py:_PROBE_TIMEOUT_SECONDS`), 실패해도 worker는 정상 동작한다
(`report_host_capabilities`가 예외를 삼킨다). 늦고, 없어도 되는 값은 준비 신호가 아니다.

### 6.7 시작 순서와 게이트

```
postgres                     (gate)
   └─→ api                   (gate)
         └─ 기동 로그의 마이그레이션 경고 검사   (gate)
               ├─→ 창을 API origin에 붙인다
               └─→ worker    (배경)
embed                        (배경, DB에 의존하지 않는다)
```

**게이트는 postgres·api·마이그레이션 검사 셋뿐이다.** worker와 embed는 배경에서 준비되고 상태
창에 보인다. embed의 bge-m3 로딩(import 시점) 때문에 앱 전체를 세우는 것은 손해이고, 그동안에도
회의 목록과 업로드는 동작한다. embed는 DB를 쓰지 않으므로 postgres와 나란히 띄운다. 로드맵의
"앱 실행만으로 전체 서비스 준비"는 **"넷 다 준비 상태에 도달하고 그것을 앱에서 확인할 수 있다"**로
판정한다(P2-C1).

**마이그레이션 감지 게이트.** 앱이 `docker compose up -d`를 부르는 순간 "빈 볼륨" 경로가 열린다 —
볼륨이 없거나 지워졌으면 컨테이너는 healthy가 되지만 스키마가 없다. `be/src/database/
database.service.ts:44-53`은 미적용 마이그레이션을 **경고만 하고 부팅을 계속**하므로, 그대로 두면
화면은 정상인데 첫 회의 생성이 `relation does not exist`로 죽고 worker는 `peek_queued` 오류
재접속 루프에 들어간다.

**판정은 API 자신의 기동 로그로 한다.** `database.service.ts`가 이미
`N pending migration(s): … — run \`pnpm be:migrate\``를 찍고, 앱은 Phase 1부터 API의 출력을
받고 있다. main에 pg 클라이언트를 넣지 않는 이유가 이것이다 — 넣으면 `desktop/package.json`의
`dependencies`가 비지 않아 Phase 1의 번들 위생 기준(P1-C11, 이 Phase에서는 P2-C14)이 깨진다.

**그 줄은 stdout에 있다. stderr가 아니다** (2026-09-12 실측, Task 6). 이 문서의 초판은
"앱은 Phase 1부터 API의 stderr를 받고 있다"고 적었고 그것이 틀렸다. 근거:
`database.service.ts:47,53`이 두 신호를 모두 `logger.warn()`으로 찍고, NestJS의
`ConsoleLogger.printMessages`는 `process[writeStreamType ?? 'stdout']`에 쓰며 `'stderr'`를
넘기는 것은 `.error()` 하나뿐이다(`console-logger.service.js:52`). 그런데 Phase 1의
`makeSink`는 `isError`일 때만 tail에 쌓는다(`api-process.ts:18`) — 로그 **파일**에는 두
스트림이 다 들어가지만 `stderrTail()`에는 stdout이 한 줄도 없다.

그래서 `ApiHandle`에 **`stdoutTail()`을 따로 더한다.** 합치지 않는 이유는 `stderrTail()`이
`lastMeaningfulLine`·`isAddrInUse`·`database unreachable` 판정에서 **실패 원인**을 찾는 데
쓰이기 때문이다 — 평범한 stdout 한 줄이 `lastMeaningfulLine`을 이기면 실패 화면이 엉뚱한
원인을 말하기 시작한다. 게이트는 `stdoutTail()`을, 나머지는 `stderrTail()`을 읽는다.

두 가지를 2026-09-12에 확인했다.

- `be/nest-cli.json`의 `assets`가 `database/migrations/*.sql`을 `dist`로 복사하고
  `be/package.json`의 `files: ["dist"]`가 그것을 `pnpm deploy` 트리에 싣는다 — **packaged에서도
  경고가 뜬다.** 이 조건이 깨지면 게이트가 조용히 비활성화되므로 P2-C9가 packaged에서 판정한다.
- `migrate.ts:19`는 `_migrations` 테이블 자체가 없으면 전체 파일을 미적용으로 돌려준다 — "빈
  볼륨"이 정확히 최대치로 잡힌다.

경고가 보이면 **창을 API origin에 붙이지 않고 worker도 띄우지 않은 채** 거기서 멈춰
`pnpm be:migrate`를 안내한다. API 자식은 정리한다. **앱은 마이그레이션을 실행하지 않는다** —
로드맵이 그 일을 Phase 3에 뒀고, P2-C15가 `_migrations` 행 수 불변으로 그것을 판정한다.

`database.service.ts:54-58`은 목록을 못 읽으면 `pending migration check skipped`를 찍고 넘어간다.
그 줄이 보이면 앱은 게이트를 통과시키되 **그 사실을 상태 창에 남긴다** — 검사가 돌지 않았다는 것과
통과했다는 것은 다른 사실이다.

### 6.8 재시작 정책

| 서비스 | 정책 | 근거 |
| --- | --- | --- |
| api · embed · worker | `[3s, 8s, 20s]` 3회 → `failed` 고정 | Phase 1의 `RETRY_DELAYS_MS` 재사용 |
| postgres | **`never`** | `docker-compose.yml`의 `restart: unless-stopped`가 이미 그 일을 한다. 앱이 겹쳐 하면 두 감독자가 같은 컨테이너를 다툰다 |

**의존 캐스케이드를 만들지 않는다.** DB가 끊기면 worker는 자기 `_reconnect()` 백오프로 버티고
(`__main__.py:168-179`), API는 `degraded`로 표시되며 죽지 않는다(§6.6). DB가 돌아오면 둘 다 스스로
복구한다. 감독자가 명시적으로 순서를 다시 몰아주는 경로는 실패 모드만 늘린다.

`failed`로 고정된 서비스는 메뉴의 "다시 시도"로만 다시 뜬다. `retryCount`는 ready 도달 시 0으로
돌아간다(Phase 1과 같다).

### 6.9 종료 계약

```
worker → embed → api → (postgres는 건드리지 않는다)
```

**worker의 절차가 특별하다.** `__main__.py:279`가 `--once` 자식을 `start_new_session=True`로 띄우기
때문에 **프로세스 그룹 kill이 그 자식에 닿지 않는다.** supervisor를 SIGKILL하면 자식과 그 자식이
띄운 `mlx_lm.server`(`llm_server.py`)가 고아로 남는다. 그래서 절차는:

1. **SIGTERM 1회.** supervisor의 2단계 핸들러가 자식에 SIGTERM을 전달하고
   (`__main__.py:_on_signal`), 자식은 stage boundary에서 멈춰 `requeue_for_shutdown`을 부른다 —
   이 경로가 **`attempts`를 되돌려** 재시도를 태우지 않는다(`jobs.py:144-147`). P2-C5가 판정한다.
2. 유예 초과 → 네이티브 대화상자 `[계속 기다리기 / 지금 강제 종료]`.
3. 강제 → **SIGTERM 2회차.** supervisor가 자식을 `kill()`하고 `os._exit(1)`한다.
4. 그래도 남으면 `descendantPids()`로 자손 집합을 훑어 SIGKILL. `start_new_session`은 세션만 바꾸고
   **부모-자식 관계는 그대로**라 `ps`의 ppid BFS가 여전히 찾아낸다. 이 단계가 §6.5의
   `WORKER_ID` 재사용 구멍도 닫는다.
5. 그래도 남으면 **pid를 화면과 로그에 적는다.** 정리 실패를 조용히 넘기지 않는다.

유예 시간의 구체 값은 구현 계획이 정하고 근거를 결과 문서에 남긴다. stage boundary는 31분 오디오의
STT 한가운데면 분 단위가 될 수 있다.

#### 진행 중 작업과 종료 확인

종료(Cmd+Q·메뉴)는 **녹음 중이거나 분석 중이면 네이티브 대화상자로 확인을 받는다.**

- **분석 중 판정**: 앱이 소유한 worker에 `--once` 자식이 있는가(`descendantPids()`). 새 API
  엔드포인트를 만들지 않는다. 외부 worker가 하는 일은 우리가 소유하지 않으므로 판정 대상이 아니다.
- **녹음 중 판정**: §6.10의 렌더러 훅.

#### 녹음 중 종료 — close handshake

**렌더러를 그냥 파괴하면 오디오를 잃는다.** `fe/src`에 `beforeunload`·`pagehide` 훅이 **0건**이라
창이 사라지면 `LiveRecorder.stop()`이 아예 불리지 않는다 — 마지막 tail 청크가 서버에 못 들어가고,
API의 `LiveOrphanService.sweep`이 90초 뒤에 `committed_bytes`에서 봉인하며 `capture_error`는
`producer_abandoned`가 된다. 그런데 **그 sweep은 API의 `@Cron`**이라 우리가 API도 내리는 종료
경로에서는 그 순간 아무도 봉인하지 않고, 회의는 다음 앱 실행 때까지 `recording`에 남아
`meeting_single_recording_idx`가 새 녹음을 막는다.

그래서 종료 순서의 맨 앞에 handshake를 둔다.

```
1. 녹음 중인가?  (렌더러 훅 조회)
2. 대화상자로 확인
3. 승인 → 렌더러의 라이브 중지를 부르고 서버 ACK까지 기다린다
4. 그 뒤에 worker → embed → api 역순 종료
```

`fe/`는 `window`에 훅 하나를 노출하고 main은 `webContents.executeJavaScript()`로 부른다.
`executeJavaScript`는 평가 결과를 **Promise로 돌려주므로** main이 완료를 기다릴 수 있다. 방향이
main → 렌더러라 **Phase 1의 계약("렌더러에서 main을 부를 경로를 새로 만들지 않는다")은 그대로
산다** — 렌더러가 먼저 부를 수 있는 채널은 여전히 없다. 훅 형태는 §10.

handshake가 실패하거나 시간 안에 안 끝나면 그 사실을 화면에 적고 종료를 진행한다. 그때는 sweeper
경로로 떨어지며, **다음 앱 실행 때 API가 뜨면 봉인·마감된다.** 그 경로도 스펙의 일부다.

### 6.10 창 닫기와 앱 종료

| 동작 | Phase 1 | Phase 2 |
| --- | --- | --- |
| 창 닫기 | 앱 종료 | **앱과 서비스가 계속 산다.** Dock 아이콘(`activate`)으로 창을 되살린다 |
| Cmd+Q · 메뉴 종료 | 앱 종료 | 전체 종료. §6.9의 확인과 역순 절차를 거친다 |

`window-all-closed`에서 `app.quit()`을 부르지 않는다. 긴 전사가 창을 닫아도 이어지고, Dock에 남아
있으므로 "껐다고 생각했는데 돌고 있다"는 상태는 아니다.

**창을 닫으면 렌더러가 죽으므로 녹음도 끊긴다.** 그래서 녹음 중에는 창 닫기에도 Cmd+Q와 같은
확인과 같은 handshake를 적용한다. 분석 중에는 확인하지 않는다 — 창을 닫아도 분석은 계속되고,
그것이 이 변경의 목적이다.

### 6.11 보안 경계

Phase 1 §6.6을 그대로 잇는다. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
preload 없음, `HOST=127.0.0.1`, 권한 핸들러, `setWindowOpenHandler`, `will-navigate`.

이 Phase가 더하는 것:

- **렌더러 → main 채널은 여전히 없다.** 상호작용은 main이 소유한 것으로만 만든다 — 네이티브
  대화상자(`dialog.showMessageBox`), 애플리케이션 메뉴, 그리고 표시 전용 상태 창.
- **main → 렌더러는 `executeJavaScript` 한 방향만 쓴다.** §6.9의 handshake와 상태 창 갱신이
  그것이다. 반환값을 받는 것은 호출의 결과이지 렌더러가 연 채널이 아니다.
- 상태 창도 같은 `webPreferences`를 쓴다. 자기 origin은 `file://`이고 권한을 요구하지 않는다.

`app.enableCors()`의 무제한 정책과 API 인증 부재는 이 Phase에서도 바꾸지 않는다 — Phase 6 인계
(Phase 1 §15와 같다).

### 6.12 로그

```
<userData>/logs/
  supervisor.log   감독자 자신의 판단 기록 (기동·준비·재시작·종료·정리 결과)
  api.log          Phase 1과 같다
  worker.log
  embed.log
```

- **크기 기반 회전** — 10 MB를 넘으면 `.1`, `.2`로 밀고 3세대까지 보관한다. 값의 근거는 결과
  문서에 남긴다.
- **ANSI escape를 벗긴다.** worker는 진행 바와 로그가 같은 stderr를 쓰고
  (`console.install_logging`), NestJS Logger도 TTY가 아닌 stderr에 색상을 쓴다. Phase 1의
  `ANSI_SGR`을 파일 기록 경로에 재사용한다.
- 로그 파일을 못 쓰는 것은 **앱이 죽을 이유가 아니다.** Phase 1의 `makeSink` 규칙을 유지한다.

**실패 화면의 원인 표시를 고친다.** Phase 1의 `lastMeaningfulLine()`은 한 줄만 고르므로 zod 검증
실패처럼 여러 줄인 원인이 `startup failed: [`까지만 보였다(Phase 1 결과의 남은 한계). `startup
failed:` 이후의 **블록 전체**를 상한을 두고 보여주도록 바꾼다.

**원인마다 복구 방법을 짝짓는다.**

| 원인 | 화면이 말하는 것 |
| --- | --- |
| Docker 데몬 없음 | Docker Desktop을 실행하세요 |
| `uv`·`docker`를 못 찾음 | 설치하거나 `config.json`의 `UV_BIN`/`DOCKER_BIN`에 경로를 적으세요 |
| `REPO_ROOT`가 저장소가 아님 | 폴더를 다시 고르세요 |
| `be/worker/.env` 없음 | `be/worker/.env.example`을 복사해 값을 채우세요 |
| 미적용 마이그레이션 | `pnpm be:migrate`를 실행하세요 |
| 외부 worker 감지 | 터미널의 worker를 끄거나, 그쪽 `STORAGE_ROOT`가 앱과 같은지 확인하세요 |
| embed 계약 불일치 | 외부 embed의 모델·차원이 설정과 다릅니다 |
| API `degraded` (503) | 데이터베이스 연결이 끊겼습니다. DB가 뜨면 자동으로 복구됩니다 |

## 7. 사용자 동작

| 동작 | 기대 |
| --- | --- |
| Finder에서 `Damwha.app` 더블클릭 (터미널 명령 0회) | 준비 화면을 지나 담화 화면이 붙고, 배경에서 worker·embed가 준비된다 |
| 첫 실행 | 저장소 폴더를 한 번 묻는다 |
| 업로드 | worker가 집어 처리한다. `be/worker/.env`를 손대지 않았다 |
| 검색 | 의미 + 키워드 양쪽이 섞여 나온다 |
| 창 닫기 | 앱은 살아 있다. Dock 아이콘으로 창이 돌아온다. 돌던 분석은 계속된다 |
| 녹음 중 창 닫기 / Cmd+Q | 확인을 묻고, 승인하면 녹음을 정상 중지한 뒤 종료한다 |
| 분석 중 Cmd+Q | 확인을 묻고, 승인하면 정중히 멈춘다. 오래 걸리면 강제 종료를 제안한다 |
| Docker가 꺼진 채 실행 | 원인과 복구 방법이 뜨고, Docker를 켜고 재시도하면 진입한다 |
| 터미널 worker를 켜 둔 채 실행 | 앱은 뜨고, 외부 worker를 쓰는 중이라는 경고가 상태 창에 남는다 |
| 앱 종료 후 | 앱이 만든 프로세스가 0개. Postgres 컨테이너와 외부 서비스는 살아 있다 |

## 8. 실패·복구 동작

Phase 1 §8을 잇고 이 Phase의 것을 더한다.

| 실패 | 앱의 처리 |
| --- | --- |
| Docker 데몬 없음 | 기동을 멈추고 원인·복구 안내. 재시도 제공 |
| `docker compose up -d` 실패 | stderr를 원인으로 보여준다 |
| postgres가 유예 안에 healthy가 안 됨 | 원인·로그 경로. 컨테이너는 건드리지 않는다 |
| 미적용 마이그레이션 | API 기동 로그에서 감지해 창을 붙이기 전에 멈추고 `pnpm be:migrate` 안내. API 자식은 정리하고 worker는 띄우지 않는다 |
| 마이그레이션 검사 자체가 건너뛰어짐 | 게이트를 통과시키되 "검사가 돌지 않았다"를 상태 창에 남긴다 |
| `uv`·`docker`를 못 찾음 | 무엇을 못 찾았는지와 `config.json` 대안 |
| `be/worker/.env` 없음 | worker를 띄우지 않고 안내 |
| worker가 ready 신호 전에 죽음 | stderr 블록과 종료 코드 |
| worker가 ready 신호 없이 유예 초과 | `failed`. DB 연결이 안 되는 상태일 수 있다고 적는다 |
| 외부 worker 감지 | 자기 것을 안 띄우고 경고. 앱은 계속 쓸 수 있다 |
| 외부 embed 계약 불일치 | 채택하지 않고 다른 포트에 우리 것을 띄운다 |
| ready 뒤 서비스 사망 | 백오프 3회 재시작 → `failed` 고정 + 메뉴 재시도 |
| 부팅 뒤 DB 끊김 | api `degraded`. **재시작하지 않는다.** DB 복귀 시 자동 회복 |
| 종료 handshake 실패·초과 | 사실을 화면에 적고 종료. 다음 실행의 sweeper가 봉인·마감 |
| 종료 후 프로세스가 남음 | pid를 화면과 로그에 적는다 |

## 9. 완료 기준

각 기준은 식별자 · 확인 환경 · 확인 방법 · 성공 판정으로 구성한다. **아직 실행되지 않았다.**

"packaged 환경"은 `pnpm desktop:build`로 만든 `Damwha.app`을 Finder에서 실행한 상태를 말한다.

### 축 A — 실사용 동작

**P2-C1. 터미널 없이 전체 서비스 준비**

- 확인 환경: packaged. Docker Desktop만 실행 중이고 DB·worker·embed는 **전부 꺼진** 상태.
- 확인 방법: Finder에서 앱을 실행한다. 터미널 명령을 하나도 실행하지 않는다. 상태 창을 연다.
- 성공 판정: postgres·api·worker·embed 넷이 모두 `running`/`ok`에 도달하고 상태 창에서 확인된다.
  화면은 담화 화면이다.

**P2-C2. `be/worker/.env`를 손대지 않은 업로드 처리**

- 확인 환경: packaged. `be/worker/.env`의 `STORAGE_ROOT`는 웹 흐름 기본값 `../storage` 그대로 둔다.
- 확인 방법: 앱에서 오디오 파일로 회의를 만들고 처리가 끝날 때까지 둔다. 시작 전후로 그 파일의
  체크섬을 비교한다.
- 성공 판정: 전사 결과가 앱 화면에 뜬다. `be/worker/.env`가 **한 바이트도 바뀌지 않았다.**
  Phase 1이 사람에게 맡긴 합의가 사라졌다는 뜻이다.

**P2-C3. 의미 검색 동작**

- 확인 환경: packaged. 결과가 있는 회의 대상.
- 확인 방법: 검색어를 넣는다. 반환된 결과에 키워드 일치로는 설명되지 않는 항목이 있는지 본다.
- 성공 판정: 의미 + 키워드가 섞인 결과가 나온다. `EMBED_SERVICE_URL`과
  `EMBED_SERVICE_HOST`/`PORT`가 한 값에서 파생돼 실제로 맞았다는 뜻이다 — 어긋나면 오류 없이
  키워드 전용으로 떨어지므로 이 판정이 유일한 관찰 지점이다.

### 축 B — 프로세스 소유권

**P2-C4. 전체 트리 정리**

- 확인 환경: packaged. 앱이 넷을 다 띄운 상태. 렌즈·요약 job을 한 번 돌려 `mlx_lm.server`가 뜬
  적이 있는 상태를 포함한다.
- 확인 방법: 앱 실행 전후의 프로세스 목록을 기록한다. 종료 후 `damwha_worker`·`uvicorn`·
  `mlx_lm.server`·`node`를 전수 확인한다. `docker compose ps`도 전후로 비교한다.
- 성공 판정: 앱이 만든 프로세스가 **0개** 남는다. supervisor·`--once` 자식·`mlx_lm.server`가 모두
  없다. **Postgres 컨테이너는 살아 있고** 볼륨도 그대로다.
- 비고: `mlx_lm.server`를 실제로 띄우려면 LLM 모델이 내려받아져 있어야 한다. 그 조건을 만들 수 없으면
  **그 사실을 증거에 적고**, 대신 `--once` 자식이 있는 상태(= 임의의 `process_meeting` 처리 중)에서
  강제 종료를 걸어 §6.9 4단계의 자손 SIGKILL이 세션이 다른 자식까지 잡는지를 판정한다. 그 4단계가
  `mlx_lm.server`를 잡는 근거와 같은 근거다 — 둘 다 `ps`의 ppid BFS로 찾는다.

**P2-C5. 분석 중 정중한 종료**

- 확인 환경: packaged. `process_meeting` job이 `running`인 상태.
- 확인 방법: 종료한다. 대화상자에서 승인하고 강제 종료를 **누르지 않는다.** 종료 후 `job` 행의
  `status`·`attempts`를 본다.
- 성공 판정: job이 `queued`로 돌아가고 **`attempts`가 늘지 않았다.** `requeue_for_shutdown` 경로를
  실제로 탔다는 뜻이다.

**P2-C6. 외부 서비스 보존과 구분**

- 확인 환경: packaged. `pnpm worker`와 `pnpm embed`를 터미널에서 띄워 둔 상태.
- 확인 방법: 앱을 실행한다. 상태 창과 프로세스 목록을 본다. 앱을 종료하고 다시 본다.
- 성공 판정: 앱이 자기 worker를 띄우지 않고 경고가 상태 창에 있다. 외부 embed는 채택된다.
  종료 후 **외부 worker와 외부 embed가 둘 다 살아 있다.**

### 축 C — 실패 표시

**P2-C7. Docker 데몬 없음**

- 확인 환경: packaged. Docker Desktop 종료 상태.
- 확인 방법: 앱을 실행한다. Docker를 켜고 재시도한다.
- 성공 판정: 원인과 "Docker Desktop을 실행하세요"가 화면에 나온다(빈 화면·무한 로딩이 아니다).
  Docker를 켠 뒤 재시도로 정상 진입한다.

**P2-C8. 실행 파일을 못 찾음**

- 확인 환경: packaged. `config.json`의 `UV_BIN`을 존재하지 않는 경로로 두고 탐색 목록에서도 `uv`가
  안 잡히게 만든다.
- 확인 방법: 앱을 실행한다.
- 성공 판정: **무엇을** 못 찾았는지와 `config.json`으로 고치는 방법이 화면에 나온다. 원인 불명
  실패가 아니다. 확인 후 원복한다.

**P2-C9. 미적용 마이그레이션**

- 확인 환경: packaged. **운영 DB에 하지 않는다.** 같은 클러스터 안에 빈 데이터베이스를 하나 만들고
  (`CREATE DATABASE damwha_migration_gate;`) `config.json`의 `DATABASE_URL`이 그것을 가리키게 한다.
  `damwha` 데이터베이스와 `damwha_pgdata` 볼륨은 손대지 않는다. 확인 후 `DROP DATABASE`하고
  `config.json`을 원복한다.
- 확인 방법: 앱을 실행한다. 상태 창과 프로세스 목록을 본다.
- 성공 판정: 창이 담화 화면으로 넘어가지 않고 `pnpm be:migrate` 안내가 뜬다. **worker가 뜨지
  않는다.** 복제 DB의 `_migrations` 행 수가 변하지 않는다 — 앱이 마이그레이션을 실행하지 않았다.
- 비고: packaged에서 판정하는 것이 중요하다. 이 게이트는 `be/nest-cli.json`의 `assets`가 `.sql`을
  `dist`로 복사하고 `be/package.json`의 `files`가 그것을 `pnpm deploy` 트리에 싣는 데 의존하며,
  그 사슬이 끊기면 API가 `pending migration check skipped`를 찍고 게이트가 **조용히 비활성화**된다.

**P2-C10. worker DB 설정만 틀렸을 때 준비로 오판하지 않음**

- 확인 환경: packaged. 넷이 준비된 상태.
- 확인 방법: `docker compose stop postgres`로 DB를 내린다. 그 상태에서 앱이 소유한 worker
  supervisor를 밖에서 죽여 앱의 재시작 정책을 발화시킨다. 상태 창과 `worker.log`를 본다.
- 성공 판정: 재시작된 worker가 **`running`/`ok`로 표시되지 않는다.** `worker.log`에는
  `supervisor <id> started`가 있지만 ready 로그는 없고, 유예 초과 후 `failed`가 되며 DB 연결
  문제일 수 있다는 원인이 보인다. DB를 올리고 메뉴에서 다시 시도하면 `ok`에 도달한다.
- 근거: 기존 `supervisor <id> started`는 DB 연결 **전**에 찍힌다(`__main__.py:296` → `:298` →
  `:107`). 그 줄을 준비 신호로 쓰면 이 상황이 "준비됨"으로 보인다. 이 기준이 그 회귀를 막는다.
  설정을 조작하지 않고 DB를 내려 같은 조건을 만드므로 `config.json`에 검증 전용 키를 추가하지
  않는다.

**P2-C11. 부팅 뒤 DB 끊김**

- 확인 환경: packaged. 넷이 준비된 상태에서 `docker compose stop postgres`.
- 확인 방법: 상태 창을 본다. 30초 이상 둔다. `docker compose start postgres` 후 다시 본다.
- 성공 판정: api가 `running`/**`degraded`**로 표시되고 **재시작 루프에 들어가지 않는다**(로그에
  재시작 기록이 없다). DB 복귀 후 스스로 `ok`로 돌아온다.

### 축 D — 수명주기

**P2-C12. 창 닫기와 앱 종료의 구분**

- 확인 환경: packaged. 분석 job이 `running`인 상태.
- 확인 방법: 창을 닫는다. 프로세스 목록과 job 진행을 확인한다. Dock 아이콘을 누른다.
- 성공 판정: 앱과 네 서비스가 살아 있고 분석이 계속된다. Dock 클릭으로 창이 돌아오고 화면이
  정상 렌더된다. 확인 대화상자는 뜨지 않는다.

**P2-C13. 녹음 중 종료 handshake**

- 확인 환경: packaged. 라이브 녹음 중.
- 확인 방법: Cmd+Q. 대화상자에서 승인한다. 종료 후 DB의 그 회의와 job을 본다. 앱을 다시 띄워
  화면을 확인한다.
- 성공 판정: 확인 대화상자가 떴고, 종료 후 회의가 **정상 마감**됐으며 `meeting.capture_error`가
  `producer_abandoned`가 **아니다.** 녹음 파일 길이가 중지 시점까지 있다. 재실행 시 그 회의가
  `recording`에 남아 있지 않다.

### 축 E — 회귀와 데이터 보존

**P2-C14. 기존 웹 흐름과 번들 위생 회귀 없음**

- 확인 환경: 앱을 실행하지 않은 상태.
- 확인 방법: 루트에서 `pnpm install`·`build`·`test`·`lint`. `pnpm dev`로 웹 흐름 확인.
  `docker build -f deploy/api.Dockerfile .`. Phase 1의 `desktop/scripts/check-bundle.mjs`를
  다시 돌린다.
- 성공 판정: 넷이 통과하고 브라우저 흐름이 동작하며 이미지 빌드가 성공한다. `pnpm dev`가
  Electron을 띄우지 않고 `pnpm build`가 `.app`을 만들지 않는다. **번들 안에 저장소 절대 경로
  문자열이 0건이다**(P1-C11 유지). worker 테스트(`pnpm worker:test`)와 fe 테스트가 통과한다.

**P2-C15. 기존 데이터 보존**

- 확인 환경: packaged. §5의 규칙 전체가 대상.
- 확인 방법: 앱을 처음 실행하기 전에 `be/storage` 전체의 파일 목록·체크섬, `meeting`·`utterance`·
  `_migrations` 행 수, `docker compose config`의 `name`과 볼륨 이름을 기록한다. P2-C1~C6, C12,
  C13을 수행한다. 같은 것을 다시 뜬다.
- 성공 판정: `be/storage`의 목록·체크섬이 **한 건도 다르지 않다.** 기존 `meeting`·`utterance`
  행이 줄지 않았다. **`_migrations` 행 수가 변하지 않았다.** compose `name`이 `damwha`이고
  볼륨이 `damwha_pgdata`로 그대로이며, 컨테이너가 삭제·재생성되지 않았다.

### 비고 — Phase 1에서 넘어온 확인 항목

기준은 아니지만 이 Phase의 검증에서 기회가 생기면 1회 확인하고 결과 문서에 적는다.

- `unverified-owner` 화면의 종단간 발화 (Phase 1 P1-C10의 남은 범위).
- 포트 폴백 후 macOS TCC 대화상자 재요청 여부 (Phase 1 R1-6).

## 10. 제품 코드 변경 목록

`desktop/` 확장과 루트 스크립트 외에, 기존 코드 변경은 **둘뿐**이다.

**`be/worker/damwha_worker/__main__.py`** — DB 연결 성공 뒤의 ready 로그 한 줄.

`run_supervisor()`에서 **`_reconnect()`가 성공할 때마다** 찍는다 — 첫 연결(`:107`)과 peek 오류
뒤의 재연결(`:120`) 둘 다다. 한 번만 찍으면 ready는 판정되지만 §6.6의 `degraded` 회복을 관찰할 수
없다. 기존 `supervisor %s started`(`:296`)는 그대로 두고 **더한다** — 그 줄은 "프로세스가 떴다"의
신호로 여전히 쓸모가 있고, 지우면 기존 로그를 읽던 사람의 기대가 깨진다.

`run_supervisor()`는 `connect_fn`을 주입받으므로 기존 테스트 구조에서 이 줄을 고정할 수 있다.
worker 테스트에 두 검사를 추가한다 — 첫 연결에서 찍히는가, **재연결에서 다시 찍히는가.** 문구가
데스크톱의 계약이 되므로 테스트가 없으면 리팩터링이 조용히 깨뜨린다.

**`fe/`** — 종료 handshake용 훅.

라이브 녹음이 활성인 동안에만 `window`에 등록하고 끝나면 지운다. 형태:

```ts
window.__damwha_desktop = {
  isRecording: () => boolean,
  stopLiveRecording: () => Promise<{ stopped: boolean; reason?: string }>,
}
```

`stopLiveRecording()`은 화면의 중지 버튼과 **같은 경로**를 부른다 — 별도 종료 경로를 만들면 둘이
갈라진다. 웹 배포에서는 아무도 부르지 않으므로 무해하고, `fe/`가 이 객체 없이도 동작하는 성질은
유지된다(Phase 1 §6.6의 조건).

`database.service.ts`를 `.warn()`에서 `.error()`로 바꾸는 길도 있었으나 택하지 않았다 —
웹·Docker 배포의 동작을 바꾸고(이 Phase의 제품 코드 예산 밖이다), 그 파일의 주석이 의도적으로
advisory라고 적어 둔 조건을 error 수준으로 올리게 된다.

**변경하지 않는 것:** `be/src/`, `be/docker-compose.yml`, `packages/contracts/`, `.npmrc`,
`be/.env`, `be/worker/.env`, `fe/.env`.

## 11. 빌드와 실행 흐름

루트 스크립트는 Phase 1 그대로다 — `desktop:dev`·`desktop:build`. `pnpm dev`·`pnpm be:*`·
`pnpm fe:*`도 손대지 않는다.

**dev와 packaged가 같은 서비스 집합을 같은 감독 코드로 관리한다.** 차이는 어댑터의 `launch()`뿐이다.

| | dev (`pnpm desktop:dev`) | packaged |
| --- | --- | --- |
| postgres | `docker compose -f <REPO_ROOT>/be/docker-compose.yml up -d` | 같다 |
| api | `pnpm --filter damwha-be run dev` (Phase 1) | `utilityProcess.fork(Resources/api/dist/main.js)` |
| worker | `uv run --directory <REPO_ROOT>/be/worker python -m damwha_worker` | 같다 |
| embed | `uv run --directory <REPO_ROOT>/be/worker damwha-embed` | 같다 |
| 렌더러 | Vite (Phase 1) | API origin |
| `REPO_ROOT` | `app.getAppPath()/..`로 추론 | `config.json` 또는 폴더 선택 |

**Phase 1이 남긴 "두 모드의 프로세스 의미가 다르다"는 여기서 좁아진다.** 넷 중 셋이 두 모드에서
같은 명령이고, 남은 차이는 api 하나다. 그 하나의 차이(dev의 `nest --watch` 래퍼는 손자가 죽어도
살아 있다)는 Phase 1의 `attempt()`가 이미 흡수하고 있으며 이 Phase도 그 처리를 유지한다.

## 12. 미확정 사항

구현에 영향을 주는 것은 계획 작성 전에 닫는다.

| 항목 | 성격 | 언제 닫히나 |
| --- | --- | --- |
| `docker compose ps --format json`의 출력 형식과 `Health` 필드 | 기술 확인 | 계획 1단계에서 실측. compose 버전에 따라 다르면 `docker inspect` 대체 |
| `uv run`이 GUI 실행 환경에서 venv를 재해석하는가 (첫 실행 sync 포함) | 기술 위험 | 계획 1단계에서 실측 |
| worker ready 로그의 정확한 문구 | 구현 값 | 계획에서 정하고 worker 테스트로 고정 |
| 종료 유예 시간(worker·embed·api 각각) | 구현 값 | 계획에서 정하고 근거를 결과 문서에 남긴다 |
| 로그 회전 크기·세대 수 | 구현 값 | 계획에서 정한다 (초안 10 MB × 3) |
| 상태 창의 문안과 시각 언어 | 구현 세부 | 구현 단계. `fe/DESIGN.md`의 톤을 따른다 |
| `fe/` 훅의 정확한 등록 위치 | 구현 세부 | 구현 단계. 중지 버튼과 같은 경로를 부른다는 계약은 §10에서 닫혔다 |

## 13. 기술 위험

| 식별자 | 위험 | 관찰 방법 | 대응 |
| --- | --- | --- | --- |
| R2-1 | GUI 실행 앱의 `PATH`에 `uv`·`docker`가 없다 | **2026-09-12 실측으로 확인됨** | §6.3 탐색 + `PATH` 보강 |
| R2-2 | worker의 `--once` 자식이 `start_new_session`이라 그룹 kill에 안 잡혀 고아가 된다 | P2-C4 | §6.9의 5단계 절차. `ps` ppid BFS가 세션과 무관하게 찾는다 |
| R2-3 | `supervisor started`가 DB 연결 전이라 준비를 오판한다 | **확인됨** (`__main__.py:296`/`:298`/`:107`) | §10의 ready 로그 추가. P2-C10 |
| R2-4 | 녹음 중 종료가 렌더러를 파괴해 마지막 청크를 잃는다 | **확인됨** (`fe/src`에 `beforeunload` 0건) | §6.9 handshake. P2-C13 |
| R2-5 | 부팅 뒤 DB 끊김에 API가 fail-fast하지 않아 감독자가 정상으로 오판한다 | **확인됨** (fail-fast는 `onModuleInit`에만) | §6.6 상태 모델 분리. P2-C11 |
| R2-6 | 같은 `WORKER_ID`를 쓰는 두 프로세스가 소유권 가드를 통과해 한 job을 두 번 쓴다 | P2-C4, P2-C5 | 실행마다 새 `WORKER_ID` + §6.9의 자손 정리. **근본 해소(lease token)는 범위 밖 — §15** |
| R2-7 | 외부 embed가 다른 모델·차원인데 채택돼 검색이 조용히 degrade된다 | P2-C3, P2-C6 | §6.5의 `/embed` 계약 프로브 |
| R2-8 | 빈 볼륨에서 화면은 정상인데 모든 요청이 실패한다 | P2-C9 | §6.7의 마이그레이션 감지 게이트 |
| R2-9 | `LENS_LLM_BASE_URL` 부재로 worker가 로그 한 줄 전에 죽는다 | P2-C1 | §6.4의 `.env` 존재 확인 + 주입 |
| R2-10 | `docker compose ps`의 출력 형식이 버전에 따라 달라 준비 판정이 깨진다 | 계획 1단계 | `docker inspect` 대체안 |
| R2-11 | `executeJavaScript` handshake가 렌더러 상태(다른 화면, 로딩 중)에서 실패한다 | P2-C13 | 훅 부재를 정상 응답으로 다루고, 실패 시 sweeper 경로로 떨어진다(§6.9) |
| R2-12 | 창을 닫아도 서비스가 사는 탓에 사용자가 "껐다"고 믿고 자원을 쥔다 | — | Dock에 남는다. 상태 창과 메뉴에서 언제든 볼 수 있다 |

## 14. 로드맵 완료 기준과의 대응

| 로드맵 Phase 2 완료 기준 | 이 스펙의 기준 |
| --- | --- |
| 사전 설치 환경이 갖춰진 현재 맥에서 앱 실행만으로 전체 서비스 준비 | P2-C1, P2-C2, P2-C3 |
| 앱이 생성한 자식 프로세스가 종료 후 남지 않음 — 전체 서비스 기준 | P2-C4, P2-C5 |
| 외부에서 이미 실행 중인 서비스를 앱 소유 프로세스와 구분하여 관리 | P2-C6 (§6.5) |
| 서비스 시작 실패 시 원인과 복구 방법을 앱에서 확인 가능 | P2-C7, P2-C8, P2-C9, P2-C10, P2-C11 |

로드맵 Phase 2 범위 중 "창 닫기와 앱 종료 구분, 녹음·분석 중 종료 동작 정의"는 P2-C12·P2-C13이,
"기존 실행 파일을 후속 Phase의 내장 실행 파일로 교체할 수 있는 계약 확정"은 §6.2와 §15가 받는다.

## 15. 후속 Phase에 넘기는 것

- **Phase 3** — `postgres` 어댑터의 `launch()`를 번들 `pg_ctl`로 바꾸고, `initdb`와 **마이그레이션
  실행**을 그 어댑터에 넣는다. §6.7의 감지 게이트가 실행 게이트로 승격된다.
- **Phase 4** — `worker`·`embed` 어댑터의 `launch()`를 번들 Python으로 바꾼다. **그것만으로는
  부족하다** — `be/worker/damwha_worker/pipeline/ffmpeg.py:24,59`가 `"ffprobe"`·`"ffmpeg"`를
  리터럴로 부르므로 `FFMPEG_BIN`/`FFPROBE_BIN`을 worker `Settings`에 추가하고 그 호출을 절대
  경로로 바꿔야 한다. 하지 않으면 개발 도구 없는 맥에서 업로드가 `probe_failed`/`corrupt_audio`로
  영구 실패한다. §6.4의 `REPO_ROOT` 물음도 이 Phase에서 사라진다.
- **Phase 5** — 중단된 작업의 복구와 §6.9가 남긴 sweeper 경로(handshake 실패 시 다음 실행에서
  봉인)의 실제 처리 검증. 기존 `be/storage` 이전.
- **Phase 6** — **job lease token**(R2-6의 근본 해소)을 다룰지 결정한다. `locked_by`만 보는
  가드는 같은 `worker_id`를 쓰는 두 프로세스를 구별하지 못하며, 이것은 Phase 2 이전부터 있던
  성질이다. 앱이 서비스를 관리하기 시작하면 그 조건을 만들 경로가 늘어나므로 배포 전에 판단한다.
  Phase 1이 넘긴 `app.enableCors()`와 API 인증 부재도 여기서 다룬다.

## 16. 산출물

- `desktop/src/services/`와 `shutdown.ts`·`logs.ts`, 상태 창.
- `be/worker/damwha_worker/__main__.py`의 ready 로그 1줄과 그것을 고정하는 worker 테스트.
- `fe/`의 종료 handshake 훅.
- 결과 문서 `docs/superpowers/reports/2026-09-12-electron-phase-2-service-orchestration-results.md` —
  스펙 리뷰, 계획 검증, 단계별 실행·리뷰, 최종 검증을 구분해 기록한다.
- 로드맵의 Phase 2 상태 갱신과 Phase 4 인계 항목(`FFMPEG_BIN`) 반영.
- `be/CLAUDE.md`·`fe/CLAUDE.md`의 운영 문서 갱신 — worker의 ready 로그 계약과 `fe/`의 훅.

## 17. 외부 리뷰 기록

스펙 작성 중 **Codex CLI**(`gpt-5.x-codex`, read-only, `model_reasoning_effort=high`)에 설계
초안을 넘겨 저장소를 직접 읽고 반박하게 했다. 세션 `01a09388-4831-7053-a6a5-7131e8e54948`.
10건 중 7건을 이 스펙이 반영했고, 각 항목의 근거는 직접 재확인했다.

| Codex 지적 | 판정 | 이 스펙의 반영 |
| --- | --- | --- |
| 빈 볼륨에서 스키마 없이 화면이 뜬다 | 맞음 | §6.7 마이그레이션 감지 게이트, P2-C9 |
| 녹음 중 종료가 렌더러의 `stop()`을 건너뛴다 | 맞음 | §6.9 handshake, §10 `fe/` 훅, P2-C13 |
| `ps` 탐지가 `--once` 자식을 supervisor로 오인한다 | **부분 오류** | `__main__.py:279`의 argv에 `--once`가 있어 구분 가능. §6.5에 필터를 명시 |
| 같은 `worker_id`의 두 프로세스가 소유권 가드를 통과한다 | 맞음(기존 성질) | §6.5·§6.9로 좁히고, lease token은 §15로 인계 |
| `supervisor started`가 DB 연결 전이다 | 맞음 | §6.6·§10 ready 로그, P2-C10 |
| `LENS_LLM_BASE_URL` 주입 누락 | 맞음 | §6.4, R2-9 |
| API와 worker의 embed 설정 키가 다르다 | 맞음 | §6.4의 단일 `EMBED_PORT` 파생, P2-C3 |
| `/health`만으로 embed를 채택하면 위험하다 | 맞음 | §6.5의 `/embed` 계약 프로브 |
| worker 안의 `ffmpeg`·`ffprobe` 리터럴 | 맞음 | §6.2의 seam 한계, §15 Phase 4 인계 |
| 부팅 뒤 DB 끊김에 API가 fail-fast하지 않는다 | 맞음 | §6.6 상태 모델 분리, P2-C11 |

Codex의 결론 중 **"handshake를 넣으면 무-IPC 조건을 유지할 수 없다"는 반박했다.**
`webContents.executeJavaScript()`는 평가 결과를 Promise로 돌려주므로 main이 완료를 기다릴 수 있고,
방향이 main → 렌더러라 렌더러가 먼저 여는 채널은 여전히 없다(§6.11).
