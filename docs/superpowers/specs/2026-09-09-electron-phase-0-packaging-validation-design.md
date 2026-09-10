# Electron Phase 0 — 패키징 기술 검증 설계

**작성일:** 2026-09-09

**상태:** 초안. 스펙 리뷰 전이며, 사용자 승인 전이다. 이 문서의 어떤 항목도 아직 검증되지 않았다.

**기준 코드:** `494d44c` (`dev`, "docs: Electron macOS 앱 전환 로드맵을 추가한다")

**브랜치:** `feat/electron-migration-phase-0-packaging-validation`

**worktree:** `/Users/gim-yeongjae/project/daewha-electron-phase-0`

**상위 문서:** [Electron macOS 앱 전환 로드맵](../../electron-migration-roadmap.md) — Phase 0 절과 §"Phase별 문서와 실행 방식", §"브랜치 운영 방식"

**구현 계획:** 아직 없음. 이 스펙이 리뷰를 통과하고 사용자 승인을 받은 뒤 작성한다.

---

## 1. 이 Phase가 만드는 것

Phase 0의 산출물은 **제품 코드가 아니라 검증 보고서와 기술 결정**이다.

로드맵이 전제로 깔아 둔 최종 구성(하나의 `Damwha.app` 안에 PostgreSQL·Python·ML 라이브러리·ffmpeg를 담고, 데이터는 앱 밖에 둔다)은 아직 **한 번도 검증된 적이 없는 가정**이다. 이 Phase는 그 가정이 성립하는지, 성립하지 않는다면 어디까지 성립하는지를 실제로 실행해서 확인한다. Phase 1~6의 범위는 이 결과에 따라 조정된다.

따라서 이 문서가 정의하는 "구현 대상"은 앱의 기능이 아니라 **검증 실험**이다. 실험 코드는 일회성이며, 통과하더라도 그대로 제품 코드가 되지 않는다.

## 2. 현재 시스템의 실행 의존성

검증 대상을 특정하려면 지금 담화를 돌리는 데 실제로 무엇이 필요한지 먼저 확정해야 한다. 기준 코드에서 확인한 목록이다.

| 런타임 | 현재 제공 방식 | 위치 | 앱 내장 대상 |
| --- | --- | --- | --- |
| PostgreSQL 16 + pgvector + pg_bigm 1.2-20240606 | Docker 이미지 `damwha/postgres-bigm:pg16` (`be/docker/postgres-bigm/Dockerfile`) | Docker Desktop | Phase 3 |
| Node 22 + NestJS API | 호스트 pnpm 워크스페이스 (`be/`) | nvm / corepack | Phase 1~2 (Electron의 Node) |
| Node 22 + Vite 빌드 산출물 | 호스트 pnpm 워크스페이스 (`fe/`) | 〃 | Phase 1 |
| Python 3.12 + `models` extra | uv venv (`be/worker/.venv`) | uv 0.8.16 | Phase 4 |
| ffmpeg / ffprobe | Homebrew | `/opt/homebrew/bin/ffmpeg` (9.0.1) | Phase 4 |
| **`mlx_lm.server`** | **uv tool** — 워커 의존성 밖 | `~/.local/share/uv/tools/mlx-lm/` | Phase 4 |
| HF 모델 캐시 | 개발자 홈 | `~/.cache/huggingface` (현재 40 GB, 담화 외 모델 포함) | 앱 외부 데이터 |

`mlx_lm.server`는 이 표를 만들면서 드러난 항목이다. `be/worker/pyproject.toml`의 `models` extra에도, 기본 의존성에도 없다 — `uv tool install mlx-lm`으로 워커 venv **밖에** 설치하는 것이 현재 절차이며(`be/worker/SMOKE.md`), 워커는 이것을 `subprocess`로만 부른다(`llm_server.py`, `config.py::lens_llm_server_bin`). 즉 요약·렌즈 기능은 **어떤 매니페스트에도 선언되지 않은 네 번째 런타임**에 의존한다. 이것을 패키징 대상에서 빠뜨리면 Phase 4에서 요약이 통째로 죽는다.

`be/worker/damwha_worker/audio/source.py`의 `sounddevice`(PortAudio)는 `models` extra에 있으나, 2026-09-05 브라우저 캡처 전환 이후 실사용 경로가 남아 있는지는 검증 대상에 포함한다(§7 U-4).

### 검증이 필요한 ML 스택

`be/worker/pyproject.toml`의 `models` extra 전량이다. 재배치·독립 실행이 깨질 가능성이 높은 순서로 적는다.

`torch==2.12.1`, `torchaudio==2.11.0`, `mlx-whisper==0.4.3`(arm64 전용), `pyannote.audio==4.0.5`, `speechbrain==1.1.0`, `silero-vad==6.2.1`, `sentence-transformers==5.6.0`, `faster-whisper==1.2.1`, `soundfile==0.14.0`(libsndfile), `numpy==2.4.6`, `fastapi`/`uvicorn`, `sounddevice==0.5.2`(PortAudio).

### 검증 기준 호스트

| 항목 | 값 |
| --- | --- |
| macOS | 27.0 (`26A5425a`) |
| 칩 / 아키텍처 | Apple M2 / `arm64` |
| 메모리 | 16 GB |
| 툴체인 | Node v22.21.1, uv 0.8.16, Docker 29.4.0, Xcode Command Line Tools (`/Library/Developer/CommandLineTools`) |

이 호스트는 **개발 환경**이다. 완료 기준의 실행 검증은 §4가 정의하는 격리 환경에서 수행하며, 이 호스트의 PATH·venv·Homebrew를 쓰지 않는다.

## 3. 범위

### 3.1 포함

1. macOS arm64용 PostgreSQL 16 + pgvector + pg_bigm의 **Docker·Homebrew 없는** 독립 실행 검증.
2. Python 3.12 + `models` extra 전량 + `mlx-lm`의 **재배치 가능한** 독립 런타임 구성 및 실행 검증.
3. ffmpeg / ffprobe 실행 파일의 번들 실행과 네이티브 라이브러리 의존성 확인.
4. 번들 대상 바이너리의 **코드 서명·공증·Gatekeeper 제약** 확인.
5. 사용 모델의 **라이선스·재배포 가능 여부·게이팅·토큰 요구사항** 조사와 기록.
6. 지원 macOS 최소 버전, 실행 환경 제공 방식, 설치 용량과 초기 준비 비용의 **결정**.
7. 위 전부를 담은 검증 보고서 작성과 로드맵 상태 갱신.

### 3.2 제외

Phase 0은 앱을 만들지 않는다. 다음은 명시적으로 범위 밖이다.

- Electron 앱 껍데기, 창, 메뉴, IPC, 프로세스 수명 관리, 준비 상태 표시 (Phase 1~2).
- 제품 코드의 실행 경로 변경. `be/src`, `be/worker/damwha_worker`, `fe/src`, `packages/contracts`는 **한 줄도 고치지 않는다**. Phase 0이 발견한 문제는 문서에 기록하고 후속 Phase가 고친다.
- 실제 DMG 생성·배포·자동 업데이트 (Phase 6). 서명은 **제약 확인**까지만 하고 배포 가능한 산출물을 만들지 않는다.
- 데이터 이전, 백업·복원 (Phase 5).
- Intel 맥, Mac App Store, SQLite 전환, Windows/Linux.
- 성능 최적화·모델 교체·정확도 개선.
- 개발자 워크플로 변경. `pnpm dev` / `pnpm db:up` / `uv run` 경로는 그대로 둔다.

### 3.3 선행 조건

Phase 0은 첫 Phase이므로 인계받는 조건이 없다. 시작 시점 전제는 다음뿐이다.

- 기준 코드 `494d44c`의 `pnpm install`이 worktree에서 성공한 상태다. (완료)
- `be/.env`, `fe/.env`, `be/worker/.env`가 worktree에 복사돼 있다. (완료)
- 검증용 오디오는 `be/storage/meetings/<id>/original.flac` 중 1건을 샌드박스로 **복사**해 쓴다. 원본은 읽기만 한다 (§4.4). 어느 회의를 쓸지는 계획 첫 Task에서 고른다.
- HF 토큰이 `be/worker/.env`의 `HF_TOKEN`에 있고, pyannote 게이트 3종이 수락된 계정이다. (`be/worker/SMOKE.md` 기준)

## 4. 검증 환경 — "개발 환경에 의존하지 않는다"의 정의

로드맵의 완료 기준은 "개발자의 기존 PATH·가상환경·Homebrew에 의존하지 않는 환경"을 요구한다. 이 문장을 검증 가능한 절차로 바꾼 것이 이 절이며, **이 스펙에서 가장 중요한 부분**이다. 여기가 느슨하면 "우연히 개발 환경이 채워 준" 결과를 성공으로 기록하게 된다.

두 개의 게이트를 정의한다. 실행 검증 완료 기준(P0-C1 ~ P0-C6)은 **번들 대상 산출물과 그 실행 프로세스가 G1과 G2를 모두 통과해야** 성공으로 기록한다. 게이트를 무엇에 적용하고 무엇에 적용하지 않는지는 §4.0이 정한다. 초안이 세 번째 게이트로 두었던 별도 사용자 계정은 채택하지 않으며, 그 근거와 대체 수단은 §4.3에 있다.

### 4.0 격리하는 것과 하지 않는 것

게이트를 적용하기 전에 **무엇이 격리 대상인지** 먼저 못 박는다. 이 경계가 없으면 "Node가 없어서 마이그레이션을 못 돌린다" 같은 문제를 격리를 풀어서 해결하게 된다.

| 대상 | 격리 | 이유 |
| --- | --- | --- |
| PostgreSQL **서버** 프로세스 | **함** | Phase 3이 내장할 대상. Docker·Homebrew 비의존이 검증 항목이다. |
| Python·ML 런타임, `mlx_lm.server`, ffmpeg/ffprobe | **함** | Phase 4가 내장할 대상. |
| 그 서버에 접속하는 **클라이언트** — `pnpm be:migrate`(ts-node), `psql`, 시드·검증 스크립트 | **안 함** | Node 런타임은 Phase 1에서 Electron이 제공한다. Phase 0의 기술 위험이 아니며, 여기서 격리해 봐야 확인되는 것이 없다. |
| 검사 도구 — `otool`, `codesign`, `xattr`, `du` | **안 함** | 피검사 대상이 아니라 측정 수단이다. |

즉 G1·G2는 **번들에 들어갈 산출물과 그것을 실행하는 프로세스**에만 적용한다. 증거에는 각 명령이 어느 쪽인지 표시한다.

**마이그레이션은 이 경계 위에서 `pnpm be:migrate`로 적용한다.** `be/CLAUDE.md`가 `src/database/migrate.ts` + `_migrations` 테이블을 단일 진실 원천으로 못 박았고, `.sql`을 손으로 실행하면 `_migrations`에 기록이 남지 않아 그 계약이 깨진다. 실험은 `DATABASE_URL`만 실험 DB(포트 55432)로 바꿔 개발 Node 환경에서 실행하고, 그 명령이 격리 대상 밖임을 증거에 명시한다. 검증되는 것은 "번들 PostgreSQL이 이 마이그레이션 전량을 받아내는가"이지 "Node 없이 마이그레이션이 도는가"가 아니다.

### 4.1 G1 — 정적 링크 검사 (자동)

스테이징한 번들 후보 안의 **모든 Mach-O 파일**(실행 파일, `.dylib`, Python `.so`)을 전수 조사한다.

- `otool -L`의 각 의존 경로가 다음 중 하나여야 한다: `@rpath/…`, `@loader_path/…`, `@executable_path/…`, `/usr/lib/…`, `/System/Library/…`.
- `otool -l`의 `LC_RPATH`에 번들 밖 절대 경로가 없어야 한다.
- **금지 문자열 전수 검사:** 어떤 파일에도 다음이 나타나지 않아야 한다.

  | 문자열 | 이 머신에서의 실체 |
  | --- | --- |
  | `/opt/homebrew` | Homebrew 전체. ffmpeg 9.0.1이 여기 있다. |
  | `/Library/Frameworks/Python.framework` | **실제로 설치돼 있다** (3.9, 3.11). |
  | `/usr/local/bin` | 위 Python.framework, OrbStack `docker`, `ollama`의 심볼릭 링크. |
  | `/usr/local/lib`, `/usr/local/Cellar`, `/usr/local/opt` | 현재 비어 있으나 dyld 기본 검색 경로. |
  | `/Users/gim-yeongjae` | 개발자 홈 전체 (`~/.local/bin/mlx_lm.server`, `~/.cache/huggingface` 포함). |
  | `.venv`, `pyvenv.cfg`의 개발 venv 경로 | `be/worker/.venv`. |
  | `/Library/Developer/CommandLineTools` | 빌드 툴체인. 번들 실행에 필요해서는 안 된다. |

  Mach-O뿐 아니라 텍스트 파일(Python `sysconfig` 데이터, `pkgconfig`, `*.pc`, `postgresql.conf`, 셸 래퍼, 콘솔 스크립트 shebang, `pyvenv.cfg`)까지 포함한다 — 재배치가 깨지는 흔한 자리는 컴파일된 바이너리가 아니라 빌드 시점 경로가 그대로 박힌 텍스트다.

- `/Library/Frameworks/Python.framework`가 이 목록에서 가장 중요하다. **dyld는 프레임워크를 `/Library/Frameworks`에서 찾으며, 이 경로는 `PATH`와 무관하고 사용자 계정을 바꿔도 사라지지 않는다.** 머신 전역 설치물이기 때문이다. 즉 이 항목을 잡을 수 있는 것은 G1의 정적 검사와 G2의 dyld 로드 로그뿐이고, 계정 분리로는 잡히지 않는다 (§4.3).

`otool`은 Command Line Tools 소속이지만 **검사 도구**이지 번들 실행에 쓰이는 것이 아니므로 격리 규칙의 예외로 둔다. 검사 도구와 피검사 대상의 구분을 보고서에 명시한다.

### 4.2 G2 — 격리 실행 (자동)

같은 사용자 계정에서, 환경 변수를 완전히 비우고 실행한다.

```
/usr/bin/env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  HOME=<SANDBOX>/home \
  TMPDIR=<SANDBOX>/tmp \
  <검증 대상 명령>
```

- `PATH`에 `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, nvm, uv 경로가 없다. 따라서 Homebrew의 ffmpeg(9.0.1), `~/.local/bin/mlx_lm.server`, `/usr/local/bin`이 링크하는 `/Library/Frameworks/Python.framework`의 `python3`·`pip3`은 **찾을 수 없다**.
- `PATH`가 막는 것은 **이름으로 찾는 실행 파일**뿐이다. 절대 경로로 박힌 dylib 참조와 dyld의 기본 프레임워크 검색은 `PATH`와 무관하게 동작하므로, 그쪽은 G1의 정적 검사와 아래 dyld 실측이 담당한다.
- `HOME`을 샌드박스로 돌린다. 이것이 없으면 개발자의 `~/.cache/huggingface`(40 GB, 담화가 쓰는 모델이 이미 전부 캐시돼 있음)가 모델 다운로드 검증과 초기 준비 비용 측정을 통째로 무효화한다. 게이트 모델 접근성 확인(P0-C10)도 캐시가 있으면 통과해 버린다.
- `VIRTUAL_ENV`, `PYTHONPATH`, `PYTHONHOME`, `UV_*`, `DYLD_*`, `HF_HOME`, `HUGGINGFACE_HUB_CACHE`는 `env -i`가 전부 제거한다.
- **`env -i`는 워커가 기동에 반드시 필요로 하는 값도 같이 지운다.** `damwha_worker.config.Settings`는 `database_url`과 `lens_llm_base_url`에 기본값이 없어 없으면 `ValidationError`로 죽고, `HF_TOKEN`이 없으면 pyannote 게이트 모델을 받지 못한다. 따라서 래퍼는 아래 목록만 **명시적으로 다시 주입**한다. 이 목록에 없는 변수를 주입하면 격리 위반이며, 주입한 값 전체를 증거에 기록한다.

  | 변수 | 값 | 성격 |
  | --- | --- | --- |
  | `PATH` | `/usr/bin:/bin:/usr/sbin:/sbin` | 고정 |
  | `HOME` | `<SANDBOX>/home` | 샌드박스 |
  | `TMPDIR` | `<SANDBOX>/tmp` | 샌드박스 |
  | `DATABASE_URL` | 실험 DB (`127.0.0.1:55432`) | 샌드박스 |
  | `STORAGE_ROOT` | `<SANDBOX>/storage` | 샌드박스 |
  | `MODEL_CACHE_DIR`, `HF_HOME` | `<SANDBOX>/home/.cache/...` | 샌드박스 |
  | `EMBED_SERVICE_HOST`/`PORT` | `127.0.0.1` / `58100` | 고정 |
  | `LENS_LLM_BASE_URL` | `http://127.0.0.1:58000/v1` | 고정 |
  | `LENS_LLM_SERVER_BIN` | 번들 안 절대 경로 | 번들 내부 |
  | `HF_TOKEN` | `be/worker/.env`의 값 | **비밀값 — 증거에는 `set`/`unset`만 적고 값을 남기지 않는다.** |

  `HF_TOKEN`은 경로가 아니라 자격 증명이라 "번들 안을 가리키는 값" 규칙이 적용되지 않는다. 이것을 주입하는 것은 격리 위반이 아니다 — Phase 4의 최종 사용자도 자기 토큰을 넣어야 하기 때문이며(R-6), 오히려 그 흐름을 그대로 재현한다.
- 로드된 dylib 실측: `DYLD_PRINT_LIBRARIES=1`을 켜고 실행해 실제로 열린 라이브러리 경로 전량을 로그로 남긴다. 그 로그에 §4.1의 금지 문자열이 0건이어야 한다. **주의:** SIP는 플랫폼 바이너리에 대해 `DYLD_*`를 무시하므로, 이 측정은 우리가 스테이징한(서명되지 않았거나 ad-hoc 서명된) 바이너리에서만 유효하다. 무시된 경우를 통과로 기록하지 않고 "측정 불가"로 구분해 남긴다.

G2는 자동화 가능하므로 실험 스크립트의 표준 실행 래퍼로 만든다. **모든** 실행 검증은 이 래퍼를 통과한다.

### 4.3 계정 분리를 쓰지 않는 이유

초안은 세 번째 게이트로 "새로 만든 macOS 표준 사용자 계정에서 재실행"을 두었다. 검토 결과 **그 게이트는 G2가 이미 하는 일을 반복하고, G2가 못 잡는 것은 여전히 잡지 못한다.** 채택하지 않는다.

이 머신에 실제로 설치된 것을 기준으로 따진 결과다.

| 개발 환경 오염원 | 위치 | 새 계정이 배제하는가 | 실제로 막는 것 |
| --- | --- | --- | --- |
| Homebrew (ffmpeg 9.0.1 등) | `/opt/homebrew` | **아니오** — 머신 전역 | G1 금지 문자열 + G2 `PATH`·dyld 로그 |
| Python.framework 3.9 / 3.11 | `/Library/Frameworks` | **아니오** — 머신 전역, dyld가 `PATH` 없이 찾음 | G1 금지 문자열 + G2 dyld 로그 |
| `docker`·`ollama`·Python 심볼릭 링크 | `/usr/local/bin` | **아니오** — 머신 전역 | G2 `PATH` |
| `mlx_lm.server` (uv tool) | `~/.local/share/uv/tools/` | 예 | G2 `PATH` + `env -i` |
| HF 모델 캐시 40 GB | `~/.cache/huggingface` | 예 | G2 `HOME` 격리 |
| 셸 설정, `VIRTUAL_ENV`, `UV_*` | `~/.zshrc`, 프로세스 환경 | 예 | `env -i` |
| 개발 venv | `be/worker/.venv` | 예 (저장소를 복사하지 않으면) | G1 금지 문자열 + `env -i` |

새 계정이 배제하는 항목은 모두 홈 디렉터리 안에 있고, `env -i` + `HOME=<샌드박스>`가 이미 전부 차단한다. 반대로 상위 세 줄 — 이 검증에서 가장 위험한 항목들 — 은 계정을 바꿔도 그대로 보인다. 계정 생성은 관리자 권한이 필요하고 되돌리기가 시스템 수준인데, 그 비용을 치르고 얻는 추가 보장이 없다.

대신 G1·G2를 강화하고, 머신 전역 설치물에 대한 비의존을 **런타임 자기 보고**로 직접 확인한다 (P0-C8). 번들 Python이 스스로 보고하는 `sys.prefix` / `sys.path` / `sysconfig` 경로와, PostgreSQL이 스스로 보고하는 `pg_config` 경로·`data_directory`가 전부 번들 안을 가리키는지 보는 방식이다. 새 계정에서 "실행이 됐다"는 관찰보다 증거력이 높고, 자동화되며, 회차마다 재현된다.

**진짜 독립 설치 검증은 다른 맥에서 하는 것이고, 로드맵이 이미 그것을 Phase 6에 두었다.** 공통 설계 원칙의 "단순 앱 재실행 검증과 실제 다른 맥에서의 독립 설치 검증을 구분한다"가 그 구분이며, Phase 6 완료 기준의 "개발 환경이 없는 지원 대상 맥에 배포 산출물을 설치하고 실제 처리 성공"이 그 검증이다. Phase 0은 같은 맥에서 할 수 있는 최대치까지만 하고, 남은 것을 §12에 인계 사항으로 명시한다.

### 4.4 데이터 안전 규칙 (전 Task 공통)

실험은 기존 개발 자산을 읽기만 하고 절대 바꾸지 않는다.

- **금지:** `damwha_pgdata` / `be_pgdata` 볼륨에 대한 모든 쓰기, `docker compose down -v`, `be/storage` 하위 파일의 생성·수정·삭제, `~/.cache/huggingface`에 대한 쓰기, `be/worker/.venv` 재생성, 저장소 어디에서든 `npm install`.
- 실험용 PostgreSQL은 **새 데이터 디렉터리에 새로 `initdb`** 하며, 포트는 `5432`가 아니라 **`55432`**를 쓴다. 기존 Docker Postgres가 떠 있어도 충돌하지 않고, 어느 인스턴스에 붙었는지가 포트로 구분된다.
- 검증용 오디오는 원본을 샌드박스로 **복사**해서 쓴다. 원본 경로에 쓰지 않는다.
- 실험이 만든 프로세스는 실험 스크립트가 자신의 PID만 종료한다. `pkill postgres`처럼 이름으로 죽이는 명령은 금지한다 — 개발용 Docker Postgres나 사용자의 다른 작업을 같이 죽인다.
- 실험 산출물(수 GB)은 §6이 정한 gitignore 경로에만 쓴다.

**중단·재실행 규칙.** 실험은 여러 번 돌아가고 도중에 죽을 수 있다. 로드맵 §2가 요구하는 "시작 실패·중단·재시작" 조건을 실험 자체에 적용한다.

- 각 실험 스크립트는 시작할 때 자기 PID 파일을 `<SANDBOX>/run/`에 쓰고, 끝나거나 신호를 받으면 그 PID들만 정리한다. PID 파일이 이미 있으면 그 프로세스가 살아 있는지 확인하고, 살아 있으면 새로 시작하지 않는다.
- **재실행은 멱등해야 한다.** 실험 DB 데이터 디렉터리가 이미 있으면 `initdb`를 다시 하지 않고 기동만 한다. 처음부터 다시 하려면 스크립트에 명시적인 `--fresh` 플래그를 주고, 그 플래그는 `<SANDBOX>` 하위만 지운다.
- 모델 다운로드는 중단될 수 있다. 재실행 시 샌드박스 캐시를 지우지 않고 이어받는다. 단 P0-C13의 "처음부터 받은 용량·시간" 측정은 **빈 캐시에서 한 번만** 수행하고 그 회차를 증거에 명시한다.
- 실험이 실패로 끝나도 개발 자산(§4.4 첫 항목의 금지 목록)은 그대로여야 한다. 각 Task 종료 시 `docker volume ls`와 `be/storage`의 파일 수·mtime을 기록해 변화가 없음을 보인다.

**디스크 여유.** 기준 호스트의 데이터 볼륨은 현재 **27 GiB 여유(94% 사용)** 다. 번들 스테이징(후보별 Python 런타임 + torch)과 모델 다운로드가 이 안에서 끝나지 않는다. 각 실험 Task는 시작 전에 필요한 여유를 확인하고 부족하면 **시작하지 않고 실패로 보고한다.** 조용히 디스크를 채우면 개발 환경까지 같이 죽는다 (R-14).

## 5. 완료 기준

각 기준은 식별자 · 확인 환경 · 확인 방법 · 성공 판정으로 구성한다. **아직 실행되지 않았다.** 판정 값은 계획 실행 단계에서 증거와 함께 채운다.

### 축 A — PostgreSQL 런타임

**P0-C1. 독립 PostgreSQL + 확장 2종 기동**

- 확인 환경: 서버 프로세스에 G1 + G2. `pnpm be:migrate`와 `psql` 클라이언트는 §4.0에 따라 격리 대상 밖이며, 증거에 그렇게 표시한다.
- 확인 방법: 스테이징한 PostgreSQL 16 번들로 새 데이터 디렉터리에 `initdb` → 포트 55432로 기동 → `CREATE EXTENSION vector` 및 `CREATE EXTENSION pg_bigm` → **`pnpm be:migrate`**(§4.0의 경계에 따라 개발 Node 환경, `DATABASE_URL`만 실험 DB로) → 정상 종료(`pg_ctl stop -m fast`) → 재기동 후 스키마 유지 확인 → **`SIGKILL`로 강제 종료한 뒤 재기동**해 crash recovery 후에도 스키마와 데이터가 남는지 확인.
- 성공 판정: 두 `CREATE EXTENSION`이 오류 없이 끝나고, `SELECT extname, extversion FROM pg_extension`이 `vector`와 `pg_bigm`을 반환하며, `pnpm be:migrate`가 exit 0으로 끝나고 `SELECT count(*) FROM _migrations`가 `migrations/` 디렉터리의 `.sql` 파일 수와 같으며, 정상 재기동과 강제 종료 후 재기동 **양쪽 모두**에서 마이그레이션이 만든 테이블 전량이 남는다. Docker·Homebrew 프로세스가 관여하지 않는다.
- 강제 종료 항목을 넣는 이유: Phase 3 완료 기준이 "앱 재시작 후 데이터 유지"를 요구하고, Phase 5가 "강제 종료" 처리를 요구한다. 번들 PostgreSQL의 WAL·crash recovery가 재배치된 데이터 디렉터리에서 동작하지 않으면 그 두 Phase의 전제가 무너지므로, 가장 싼 시점인 여기서 확인한다.
- 위험: `pg_bigm`은 배포 바이너리가 사실상 없어 소스 빌드가 필요하며(현재도 Dockerfile이 컨테이너 안에서 빌드한다), 빌드 산출물이 `pg_config`의 절대 경로에 묶여 재배치를 깰 가능성이 있다. 이 경우 G1이 잡는다.

**P0-C2. 독립 DB에서 검색 쿼리 성공**

- 확인 환경: P0-C1의 인스턴스와 P0-C5의 임베딩 서비스에 G1 + G2. 시드·질의를 던지는 클라이언트는 §4.0에 따라 격리 대상 밖이다.
- 확인 방법: `meeting` → `utterance`(`status='ok'`, `text` 있음) → `utterance_embedding`(`model='BAAI/bge-m3'`, `dimension=1024`) 순으로 시드하고, `be/src/search/search.repository.ts`의 하이브리드 쿼리와 같은 형태의 SQL을 직접 실행한다 — `kw` CTE는 `u.text LIKE likequery($1)` + `bigm_similarity(u.text, $1)`(pg_bigm), `sem` CTE는 `e.embedding <=> $3::vector` with `e.model=$4 AND e.dimension=$5`(pgvector), `fused`는 둘의 `FULL OUTER JOIN` + RRF. 질의 벡터와 시드 임베딩은 모두 P0-C5의 번들 bge-m3 서비스가 만든다.
- 성공 판정: 두 경로 각각이 0건이 아닌 결과를 반환하고, RRF 결합 결과가 반환된다. `likequery`/`bigm_similarity`가 정의돼 있고 `<=>` 연산자가 동작한다.
- 비고: NestJS API를 띄우지 않는다. Node 런타임은 Electron이 제공하므로 Phase 0의 위험 항목이 아니다. 검증하는 것은 **DB 쪽 확장 기능이 번들에서 살아 있는가**다.

### 축 B — Python·ML 런타임

**P0-C3. 재배치 가능한 Python 런타임 구성과 import**

- 확인 환경: G1 + G2
- 확인 방법: 개발 venv(`be/worker/.venv`)가 아닌 독립 Python 3.12 런타임을 만들고 `models` extra 전량 + `mlx-lm`을 설치한다. `damwha_worker` 패키지 자체도 이 런타임에 **설치**한다 — 소스를 고치지 않고 `be/worker`를 패키지로 설치하는 것이므로 §3.2의 "제품 코드를 고치지 않는다"와 충돌하지 않는다. 개발 venv를 `PYTHONPATH`로 끌어오는 방식은 금지한다(격리가 깨진다). 설치한 **뒤 디렉터리를 다른 절대 경로로 옮기고**(재배치), 그 상태에서 `torch`, `torchaudio`, `mlx_whisper`, `mlx_lm`, `pyannote.audio`, `speechbrain`, `silero_vad`, `sentence_transformers`, `faster_whisper`, `soundfile`, `numpy`, `fastapi`, `uvicorn`을 import한다. `torch.backends.mps.is_available()`와 `damwha_worker.models.device.mps_available()`을 호출한다.
- 성공 판정: 모든 import가 성공하고, `mps_available()`이 `True`이며, G1·G2가 통과한다. **이동 전에는 되는데 이동 후에 깨지는 것**이 이 기준의 핵심 관찰 대상이다.
- 위험: `torch`의 `.dylib` rpath, `soundfile`의 `libsndfile`, `sounddevice`의 PortAudio, `mlx`의 Metal 라이브러리(`.metallib`) 경로 해석.

**P0-C4. 실제 음성 처리 파이프라인 성공**

- 확인 환경: G1 + G2. 드라이버 스크립트는 **번들 런타임 안에서** 실행되므로 격리 대상이다(클라이언트 예외가 아니다). P0-C3의 런타임과 P0-C1의 DB를 쓴다.
- 확인 방법: 실제 2인 대화 오디오 1건으로 전체 파이프라인(ffmpeg normalize/probe → Silero VAD → pyannote diarization → ECAPA 임베딩 → Whisper STT → align → persist)을 실행한다. 번들 런타임·번들 ffmpeg·P0-C1의 DB를 쓴다.
- **`be/worker/scripts/smoke_process_meeting.py`를 그대로 쓸 수 없다.** 그 스크립트는 `testcontainers.postgres.PostgresContainer("damwha/postgres-bigm:pg16")`로 **Docker를 띄운다** — Phase 0이 제거하려는 바로 그 의존이고, `testcontainers`는 `dev` 의존성 그룹이라 `models` extra만 담는 번들에 존재하지도 않는다. 따라서 실험은 `experiments/electron-phase-0/`에 **자체 드라이버**를 둔다: 페이로드 형태와 시드 절차는 그 smoke 스크립트를 참고하되, 컨테이너 대신 `DATABASE_URL`로 P0-C1의 DB에 접속하고 `damwha_worker`의 `run_once` 경로를 그대로 호출한다. smoke 스크립트는 **읽기 참조 전용이며 실행하지도 수정하지도 않는다** (§3.2).
- 성공 판정: `outcome: committed`, 회의 `status=done`, 화자별 발화가 텍스트와 함께 1건 이상 생성. 게이트 모델 3종을 번들 밖(샌드박스 HOME)에 새로 내려받아 사용했다는 로그.
- 비고: 정확도는 판정 대상이 아니다. **번들 런타임이 실행되는가**만 본다.

**P0-C5. bge-m3 임베딩 서비스 기동**

- 확인 환경: G1 + G2, P0-C3의 런타임
- 확인 방법: 번들 런타임에서 `damwha_worker.embed_service`를 **`127.0.0.1:58100`**(개발 기본값 8100과 분리)으로 띄우고 `GET /health` → `POST /embed`.
- 성공 판정: `/health`가 `{"status":"ok"}`, `/embed`가 `dimension: 1024`와 요청 문자열 수만큼의 벡터를 반환.

**P0-C5b. `mlx_lm.server` 번들 실행**

- 확인 환경: G1 + G2, P0-C3의 런타임
- 확인 방법: 번들 안의 `mlx_lm.server`를 **`127.0.0.1:58000`**(개발 기본값 8000과 분리)에서 `mlx-community/Qwen3.5-4B-8bit`로 기동하고 `GET /models`가 응답할 때까지 대기한 뒤, 짧은 프롬프트로 `POST /v1/chat/completions`를 한 번 호출하고 SIGTERM으로 내린다.
- 성공 판정: `~/.local/bin/mlx_lm.server`가 아니라 **번들 안의 실행 파일**이 떴고(경로를 증거에 남김), `/models`가 응답하고, 생성 응답이 오고, SIGTERM에 종료된다.
- 근거: §2가 밝힌 대로 이 런타임은 현재 어떤 매니페스트에도 선언돼 있지 않다. 여기서 검증하지 않으면 Phase 4에서 요약·렌즈가 통째로 실패한다.

### 축 C — 네이티브 바이너리

**P0-C6. ffmpeg / ffprobe 번들 실행**

- 확인 환경: G1 + G2
- 확인 방법: 번들에 넣은 ffmpeg·ffprobe로 `be/worker/damwha_worker/pipeline/ffmpeg.py`가 쓰는 것과 같은 명령을 실행한다 — `ffprobe -v error -show_entries format=duration -of json <파일>`과 normalize 변환.
- 성공 판정: 두 명령 모두 exit 0, `ffprobe`가 duration을 담은 JSON을 반환, normalize 산출물이 16 kHz mono로 생성. Homebrew의 `/opt/homebrew/bin/ffmpeg`(9.0.1)가 실행되지 않았음이 G2 로그로 확인된다.
- 함께 기록: 선택한 ffmpeg 빌드의 **라이선스 구성**(GPL 포함 여부, 활성화된 인코더). 담화는 정규화·probe만 쓰므로 LGPL 구성으로 충분한지 판단해 §5 축 E에 반영한다.

### 축 D — 환경 격리 증거

**P0-C7. G1 + G2 전수 통과**

- 확인 환경: 자동
- 확인 방법: P0-C1 ~ P0-C6의 모든 번들 산출물에 §4.1의 정적 검사를 돌리고, 모든 실행 검증의 `DYLD_PRINT_LIBRARIES` 로그를 수집해 금지 문자열을 검색한다.
- 성공 판정: 정적 검사 위반 0건, 동적 로그의 금지 문자열 0건. `DYLD_*`가 무시된 실행(SIP 대상 플랫폼 바이너리)은 "측정 불가"로 별도 집계하고, 해당 항목은 G1의 정적 검사와 P0-C8의 런타임 자기 보고로 대체 확인한다. 대체 확인도 불가능한 항목은 미충족으로 남기고 Phase 6 인계 목록에 적는다.

**P0-C8. 머신 전역 설치물 비의존 — 런타임 자기 보고 (자동)**

- 확인 환경: G2
- 확인 방법: 실행 중인 번들 런타임이 **스스로 보고하는 경로**를 전량 덤프해 번들 밖을 가리키는 항목이 없는지 본다. `PATH`가 막았는지가 아니라 **런타임이 실제로 자기 위치를 어디로 알고 있는지**를 보는 것이므로, dyld 로그가 SIP에 막힌 경우의 대체 증거도 된다.
  - Python: `sys.executable`, `sys.prefix`, `sys.base_prefix`, `sys.path` 전량, `sysconfig.get_paths()` 전량, `site.getsitepackages()`.
  - 주요 확장 모듈의 실제 로드 위치: `torch.__file__`, `mlx.__file__`, `soundfile.__file__`, `mlx_lm.__file__` 및 각각이 여는 dylib 경로.
  - PostgreSQL: `pg_config --bindir --libdir --sharedir --pkglibdir`, 접속 후 `SHOW data_directory`, `SHOW dynamic_library_path`, `SELECT setting FROM pg_settings WHERE name='shared_preload_libraries'`.
  - ffmpeg / ffprobe: 실행된 바이너리의 절대 경로(`/proc` 대응이 없으므로 래퍼가 `command -v` 결과와 실제 `argv[0]`을 함께 기록).
- 성공 판정: 덤프된 모든 경로가 번들 루트 또는 §4.4가 정한 샌드박스 경로 하위다. §4.1의 금지 문자열이 0건이다. 특히 `/Library/Frameworks/Python.framework`가 `sys.path`·`sys.prefix`·로드된 dylib 어디에도 없다.
- 근거: 이 머신에는 `/Library/Frameworks/Python.framework`(3.9, 3.11)가 실제로 설치돼 있고 dyld가 `PATH` 없이 찾는다. 계정을 바꿔도 사라지지 않으므로(§4.3), 이 기준이 그 위험을 담당한다.

### 축 E — 배포 제약

**P0-C9. 코드 서명 · 공증 · Gatekeeper 제약 확인**

- 확인 환경: 기준 호스트 (격리 게이트 대상 아님 — 서명 도구는 시스템 도구다)
- 확인 방법:
  1. 번들의 모든 Mach-O에 **ad-hoc 서명**(`codesign -s -`)을 hardened runtime 옵션과 함께 적용해 보고, 서명이 거부되는 파일을 목록화한다.
  2. hardened runtime 하에서 실행이 깨지는지 확인한다. 특히 **JIT / 쓰기+실행 메모리**(torch inductor, MLX의 Metal 셰이더 런타임 컴파일)와 **서명되지 않은 dylib 로딩**(Python이 런타임에 여는 `.so`)을 본다. 필요한 entitlement(`com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`, `…disable-library-validation`)를 실측으로 특정한다.
  3. `xattr -w com.apple.quarantine` 로 격리 속성을 붙인 뒤 실행해 Gatekeeper 동작을 확인한다.
  4. 공증(notarization)에 필요한 조건을 **목록으로만** 정리한다. 실제 제출은 하지 않는다.
- 성공 판정: 서명 실패 파일 목록, 필요한 entitlement 목록, Gatekeeper 동작이 문서에 기록된다.
- **범위: ad-hoc 서명까지.** Apple Developer Program은 유료 멤버십이고 현재 미가입이므로, Developer ID 인증서와 공증은 이 Phase에서 다루지 않는다. 그래도 이 기준의 핵심 목적은 달성된다 — `codesign -s -`와 `--options runtime`은 멤버십 없이 쓸 수 있고, R-4(MLX Metal 셰이더 런타임 컴파일·torch JIT이 hardened runtime에서 죽는지)와 R-5(서명되지 않은 `.so` 로딩 차단)는 그 조합으로 실측된다. 멤버십 가입은 Phase 6 착수 전으로 미룬다.
- 재현되지 않는 것: ad-hoc 서명에는 Team ID가 없다. Developer ID로 서명했을 때 library validation이 "같은 Team ID의 dylib만 허용"으로 동작하는 형태는 여기서 재현되지 않는다(R-12). 이 사각을 Phase 6 선결 조건으로 명시해 인계한다.
- 비고: 이 기준은 "성공/실패"가 아니라 **"제약이 특정되었는가"**로 판정한다. 서명이 불가능하다는 결론도 유효한 통과다 — 다만 Phase 6의 범위가 바뀐다.

**P0-C10. 모델 라이선스 · 게이팅 · 재배포 가능 여부**

- 확인 환경: 문서 조사 + 샌드박스 HOME에서의 실제 다운로드
- 확인 방법: 담화가 쓰는 모델 전량에 대해 라이선스, 게이트 여부, HF 토큰 필요 여부, **앱 번들에 동봉 재배포가 허용되는지**, 첫 실행 다운로드 용량을 표로 만든다. 대상: pyannote `speaker-diarization-3.1` / `segmentation-3.0` / `speaker-diarization-community-1` / `wespeaker-voxceleb-resnet34-LM`, `speechbrain/spkrec-ecapa-voxceleb`, `BAAI/bge-m3`, silero-vad, `be/worker/damwha_worker/models/whisper_mlx.py::_REPO`가 매핑하는 6종(`mlx-community/whisper-{tiny, base-mlx, small-mlx, medium-mlx, large-v3-turbo, large-v3-mlx}`) 및 `faster-whisper` CPU 경로가 받는 대응 모델, `mlx-community/Qwen3.5-{4B,9B,27B}-8bit`.
- 성공 판정: 모든 항목에 라이선스·게이팅·재배포 가능 여부·용량이 채워지고, "사용자에게 HF 토큰과 라이선스 수락을 요구해야 하는 모델"의 최소 목록이 확정된다.
- 비고: 로드맵의 "모델별 이용 동의와 토큰 요구사항은 별도로 처리한다"를 여기서 구체화한다. 게이트 모델을 동봉할 수 없다면 Phase 4의 최초 실행 흐름이 그 사실 위에 설계돼야 한다.

### 축 F — 기술 결정

**P0-C11. 지원 macOS 최소 버전 결정**

- 확인 방법: 번들 구성요소 각각의 배포 타깃(`otool -l`의 `LC_BUILD_VERSION` / `minos`)을 수집하고, MLX·PyTorch·Electron의 공식 최소 요구 버전과 교차해 최댓값을 취한다.
- 성공 판정: 버전 하나와 그 값을 강제하는 구성요소가 근거와 함께 기록된다.
- 비고: 기준 호스트가 macOS 27.0이므로 **더 낮은 버전에서의 실제 실행은 이 Phase에서 검증할 수 없다.** 결정값은 "구성요소가 선언한 최소값"이고 실측이 아니라는 점을 보고서에 명시한다.

**P0-C12. 실행 환경 제공 방식 결정**

- 확인 방법: §8이 나열한 후보 중 실험을 통과한 것을 고르고, 탈락 이유를 남긴다. 네 가지를 각각 결정한다 — (1) PostgreSQL 제공 방식, (2) Python 런타임 제공 방식, (3) ffmpeg 제공 방식, (4) 모델 제공 방식(동봉 / 최초 실행 다운로드 / 혼합).
- 성공 판정: 네 결정이 각각 근거·탈락안·남은 제약과 함께 기록되고, Phase 3·4가 그대로 착수할 수 있는 수준으로 구체적이다.
- 비고: **실패한 항목은 대안을 검증한 뒤 결정한다.** 대안도 실패하면 그 사실과 Phase 범위 조정 제안을 기록한다(로드맵 §6).

**P0-C13. 설치 용량과 초기 준비 비용 측정**

- 확인 방법: 번들 크기(압축 전/후, 구성요소별 내역)와, 샌드박스 HOME에서 처음부터 받은 모델의 총 용량·소요 시간을 측정한다. 프리셋별(light / standard / quality)로 필요한 모델 집합이 다르므로 **프리셋별 최소 다운로드 용량**을 구분한다.
- **실측과 산정을 구분한다.** 기준 호스트의 여유 디스크가 27 GiB뿐이므로 `quality` 프리셋의 `mlx-community/Qwen3.5-27B-8bit`(단독으로 수십 GB)는 **내려받지 않는다.** 그 항목은 HF 저장소의 파일 메타데이터로 용량을 **산정**하고 표에 `산정`으로 표시한다. `light`·`standard`가 쓰는 모델은 실제로 내려받아 `실측`으로 표시한다.
- 성공 판정: 번들 용량 내역표와 프리셋별 초기 다운로드 용량·시간이 기록되고, 각 행이 `실측`인지 `산정`인지 구분돼 있다. 실측하지 않은 값을 실측으로 적지 않는다.
- 비고: 개발자 캐시(40 GB)를 재사용하면 이 측정은 무효다. §4.2의 `HOME` 격리가 이 기준의 전제다.

**P0-C14. 검증 보고서 완성과 로드맵 갱신**

- 확인 방법: `docs/superpowers/reports/2026-09-09-electron-phase-0-packaging-validation-results.md`에 스펙 리뷰·계획 검증·Task별 실행·최종 검증·남은 제약·기술 결정이 모두 기록되고, `docs/electron-migration-roadmap.md`의 Phase 0 상태와 후속 Phase에 영향을 주는 전제가 갱신된다.
- 성공 판정: 모든 P0-C 기준에 대해 충족/미충족과 증거 경로가 표로 존재한다. 실행하지 않은 검증이 성공으로 적히지 않는다.

## 6. 실험 산출물의 위치와 수명

로드맵은 "일회성 산출물은 제품 코드에 포함하지 않는다"를 요구한다. 다음과 같이 나눈다.

| 종류 | 위치 | 커밋 | 수명 |
| --- | --- | --- | --- |
| 실험 스크립트, 후보별 빌드 레시피, 격리 러너, README | `experiments/electron-phase-0/` | 함 | Phase 0 브랜치에 보존. 후속 Phase가 제품 코드를 새로 쓰며, 이 디렉터리를 이식하지 않는다. |
| 스테이징·번들·다운로드 산출물, 샌드박스 HOME, 실험 DB 데이터 디렉터리 | `experiments/electron-phase-0/{stage,bundle,sandbox,pgdata}/` | 안 함 | 로컬. 재생성 가능. |
| 검증 증거 (명령 출력, `otool` 결과, dyld 로그, 용량 측정) | `docs/superpowers/reports/evidence/phase-0/` | 함 | 영구. 보고서가 참조한다. |
| — 확장자는 **`.md` 또는 `.txt`만** 쓴다 | 〃 | 함 | 루트 `.gitignore:37`의 `*.log`가 경로에 상관없이 걸린다. `git check-ignore`로 확인했다 — `evidence/phase-0/x.log`는 무시되고 `x.txt`는 추적된다. dyld 로그를 `.log`로 저장하면 **조용히 커밋에서 빠진다.** |
| 검증 보고서 | `docs/superpowers/reports/2026-09-09-electron-phase-0-packaging-validation-results.md` | 함 | 영구. |

- `experiments/`는 pnpm 워크스페이스 멤버가 아니다. `pnpm-workspace.yaml`의 `packages`는 `be`, `fe`, `packages/*`뿐이므로 **파일을 고칠 필요가 없다** — 다만 `experiments/electron-phase-0/`에 `package.json`을 두지 않는다.
- gitignore는 루트 `.gitignore`를 건드리지 않고 `experiments/electron-phase-0/.gitignore`에 국소적으로 둔다. 루트 파일은 저장소 전역 규칙을 담고 있어 Phase 0의 일회성 경로를 섞지 않는다.
- 증거 파일은 회차마다 새 파일이며 덮어쓰지 않는다(실행 스킬 §1-3 규칙).

## 7. 미확정 사항

**해결하지 않으면 계획을 쓸 수 없는 것**이다. 구현 위험(§8)과 구분한다.

### 7.1 해결된 것 (2026-09-09, 사용자 확인)

| ID | 내용 | 결정 |
| --- | --- | --- |
| U-1 | 검증용 오디오 출처 | `be/storage/meetings/<id>/original.flac` 1건을 샌드박스로 **복사**해 쓴다. 원본은 읽기만 한다. 어느 회의인지는 계획 첫 Task에서 고른다. |
| U-2 | 독립 사용자 계정(G3) 수행 여부 | **수행하지 않는다.** 새 계정은 `/opt/homebrew`·`/Library/Frameworks/Python.framework`·`/usr/local/bin` 같은 머신 전역 설치물을 배제하지 못하고, 배제하는 항목은 이미 `env -i` + `HOME` 격리가 전부 막는다 (§4.3). 대신 G1·G2를 강화하고 P0-C8을 런타임 자기 보고 검증으로 재정의했다. 진짜 독립 설치 검증은 Phase 6이 다른 맥에서 한다. |
| U-6 | 실험용 포트 | 스펙 리뷰에서 `lsof`로 확인했다 — **55432(DB), 58000(`mlx_lm.server`), 58100(embed) 모두 비어 있다.** 이 셋을 고정값으로 쓴다. 각각 개발 기본값 5432 / 8000 / 8100과 분리돼 있어 어느 인스턴스에 붙었는지가 포트로 구분된다. |
| U-3 | Apple Developer Program 멤버십 | **지금 가입하지 않는다.** P0-C9의 범위를 ad-hoc 서명 + hardened runtime까지로 확정한다. 멤버십이 필요한 것은 공증뿐이고 Phase 6 착수 전으로 미룬다. Team ID 기반 library validation은 재현되지 않으므로 R-12로 기록해 인계한다. |

### 7.2 남은 것

| ID | 내용 | 해결 시점 | 기본 제안 |
| --- | --- | --- | --- |
| U-4 | `sounddevice`(PortAudio)가 브라우저 캡처 전환 이후에도 실사용 경로에 남아 있는지. 남아 있지 않다면 번들 대상에서 뺄 수 있다. | 계획 첫 Task | 조사해서 결정한다. 불확실하면 포함한다 — 빼서 깨지는 쪽이 더 비싸다. |
| U-5 | Whisper 모델 카탈로그(`tiny`~`large-v3-turbo`) 전량을 P0-C10·C13의 대상으로 삼을지, 프리셋이 실제로 쓰는 것만 볼지. | 계획 작성 시 | 프리셋이 쓰는 것 + `large-v3-turbo`를 기준으로 하고, 나머지는 용량만 표에 남긴다. |

## 8. 기술 위험

**검증해 봐야 아는 것**이다. Phase 0이 존재하는 이유이며, 실패해도 Phase 0 자체의 실패는 아니다 — 실패를 기록하고 대안을 검증한 뒤 후속 범위를 조정한다(로드맵 §6).

| ID | 위험 | 영향 | 걸리는 기준 |
| --- | --- | --- | --- |
| R-1 | `pg_bigm`은 배포 바이너리가 없어 소스 빌드가 필요하고, `pg_config` 기준 절대 경로가 산출물에 박혀 재배치가 깨질 수 있다. | Phase 3. 최악의 경우 Docker 의존 제거 실패. | P0-C1, P0-C7 |
| R-2 | PostgreSQL 자체가 `initdb` 시점의 경로 가정을 갖는다. 번들을 `/Applications`로 옮긴 뒤 기동이 깨질 수 있다. | Phase 3 | P0-C1 |
| R-3 | `torch`·`mlx`의 `.dylib`/`.metallib`가 빌드 시점 절대 경로를 참조하면 재배치 후 import가 깨진다. | Phase 4 | P0-C3, P0-C7 |
| R-4 | hardened runtime이 MLX의 Metal 셰이더 런타임 컴파일이나 torch의 JIT을 막을 수 있다. entitlement로 풀리지 않으면 서명된 앱에서 GPU 경로가 죽는다. | Phase 4, Phase 6 | P0-C9 |
| R-5 | 라이브러리 검증(library validation)이 Python이 런타임에 여는 서명되지 않은 `.so` 로딩을 막을 수 있다. | Phase 6 | P0-C9 |
| R-6 | pyannote 게이트 모델을 번들에 동봉 재배포할 수 없으면, 사용자마다 HF 계정·토큰·라이선스 수락이 필요하다. "Python·uv·Homebrew 없이 쓴다"는 목표는 지키지만 "설치하면 바로 쓴다"는 아니게 된다. | Phase 4, 제품 요구사항 | P0-C10 |
| R-7 | 번들 + 모델 총 용량이 실용적이지 않을 수 있다(quality 프리셋의 27B 8bit 하나가 수십 GB). DMG 배포 크기와 초기 다운로드 시간이 문제가 된다. | Phase 6, 프리셋 정책 | P0-C13 |
| R-8 | ffmpeg 정적 빌드가 GPL 구성이면 배포 조건이 바뀐다. | Phase 6 | P0-C6 |
| R-9 | `mlx_lm.server`가 콘솔 스크립트 shebang에 절대 경로를 박아 재배치가 깨질 수 있다. 현재 `~/.local/share/uv/tools/`에 있는 uv tool 설치본이 그 형태다. | Phase 4 | P0-C5b, P0-C7 |
| R-10 | 기준 호스트가 macOS 27.0뿐이라 더 낮은 버전에서의 실제 실행을 검증할 수 없다. P0-C11의 결정은 선언값 기반이다. | Phase 6 | P0-C11 |
| R-11 | 16 GB 메모리 호스트에서 27B 8bit 모델 검증이 불가능하거나 스왑으로 매우 느릴 수 있다. | P0-C13 측정 범위 | P0-C13 |
| R-12 | ad-hoc 서명에는 Team ID가 없어, Developer ID 서명 시의 library validation("같은 Team ID의 dylib만 허용")을 Phase 0에서 재현할 수 없다. 그 시점에 처음 드러나는 실패가 있을 수 있다. | Phase 6 | P0-C9 (재현 불가로 명시) |
| R-14 | 데이터 볼륨 여유가 27 GiB(94% 사용)뿐이다. 후보별 번들 스테이징과 모델 다운로드가 동시에 필요한 용량을 넘길 수 있고, 넘기면 개발 환경까지 영향을 받는다. | 전 Task | §4.4 디스크 여유 사전 점검, P0-C13의 산정/실측 구분 |
| R-13 | Phase 0의 모든 실행 검증이 개발 머신 한 대에서 이뤄진다. 그 머신에만 있는 시스템 상태에 우연히 기대는 경우를 G1·G2·P0-C8이 놓칠 수 있다. | Phase 6 | Phase 6의 다른 맥 설치 검증으로만 해소된다 (§12) |

## 9. 패키징 후보 방식

실험이 고를 대상이다. 이 목록이 곧 결정은 아니며, P0-C12가 여기서 하나씩 고른다.

**PostgreSQL**
1. EnterpriseDB의 macOS arm64 바이너리 아카이브를 재배치.
2. Postgres.app 번들에서 추출.
3. 소스 빌드(`--prefix`를 번들 상대 경로로 잡고 `pgvector`·`pg_bigm`을 같이 빌드).
4. `embedded-postgres` 계열이 배포하는 바이너리 아카이브.

어느 경로든 `pg_bigm`은 별도 빌드가 필요하고, `pgvector`도 EDB/Postgres.app 배포본에는 포함되지 않는다.

**Python 런타임**
1. `python-build-standalone`(uv가 내려받는 것과 같은 배포본) + `uv pip install --target` 또는 `--python`으로 번들 안에 설치.
2. `uv venv --relocatable`로 만든 venv를 통째로 번들.
3. PyInstaller / py2app 단일 번들.
4. conda-pack.

`mlx-lm`은 어느 경로를 택하든 **같은 런타임 안에** 넣어야 한다. 현재처럼 uv tool로 분리하면 번들에서 재현되지 않는다.

**ffmpeg**
1. 공개 정적 빌드(라이선스 구성 확인 필수).
2. 필요한 코덱만 켠 LGPL 구성으로 직접 빌드.

**모델**
1. 전량 동봉.
2. 전량 최초 실행 다운로드.
3. 혼합 — 라이선스가 허용하고 작은 것(silero VAD, ECAPA)은 동봉, 게이트·대용량은 다운로드.

## 10. 로드맵 완료 기준과의 대응

| 로드맵 Phase 0 완료 기준 | 대응 식별자 |
| --- | --- |
| 개발자의 기존 PATH·가상환경·Homebrew에 의존하지 않는 환경에서 DB 검색과 실제 음성 처리·임베딩 실행 성공 | P0-C1, C2, C3, C4, C5, C5b, C6, C7, C8 — "의존하지 않는 환경"의 정의는 §4의 G1+G2이며, 계정 분리를 쓰지 않는 근거는 §4.3이다. |
| 가능한 패키징 방식, 검증 환경, 남은 제약을 문서로 기록 | P0-C9, C10, C13, C14 |
| 후속 Phase에서 사용할 실행 환경 제공 방식을 결정. 실패한 항목은 대안 검증 후 진행 | P0-C11, C12 |

## 11. Phase 6로 넘기는 검증

Phase 0이 같은 맥에서 할 수 있는 최대치까지만 하기로 했으므로(§4.3), 남는 것을 여기에 명시해 두고 결과 문서에도 같은 목록을 옮긴다.

- **다른 맥에서의 독립 설치·실행.** 개발 도구가 하나도 없는 지원 대상 맥에 번들을 복사해 실행하는 검증. 로드맵 Phase 6 완료 기준이 이미 이것을 요구한다.
- **공증(notarization) 통과.** Apple Developer Program 가입과 Developer ID 인증서가 선결 조건이다 (U-3).
- **Team ID 기반 library validation.** ad-hoc 서명으로는 재현되지 않는다 (R-12).
- **지원 macOS 최소 버전의 실측.** P0-C11의 결정값은 구성요소 선언값 기반이며, 기준 호스트가 macOS 27.0뿐이라 더 낮은 버전에서의 실제 실행은 확인되지 않는다 (R-10).

## 12. 산출물

- `docs/superpowers/specs/2026-09-09-electron-phase-0-packaging-validation-design.md` (이 문서)
- `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md`
- `docs/superpowers/reports/2026-09-09-electron-phase-0-packaging-validation-results.md`
- `docs/superpowers/reports/evidence/phase-0/*`
- `experiments/electron-phase-0/*` (일회성 실험 코드)
- `docs/electron-migration-roadmap.md` Phase 0 상태 갱신
