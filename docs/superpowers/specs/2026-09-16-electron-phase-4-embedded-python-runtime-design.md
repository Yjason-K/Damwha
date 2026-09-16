# Electron Phase 4 — Python·ML 실행 환경 내장 구현 스펙

작성일: 2026-09-16
개정: 2026-09-16 (Codex 스펙 리뷰 1회차 반영 — §17)
브랜치: `feat/electron-migration-phase-4-embedded-python-runtime`
로드맵: [docs/electron-migration-roadmap.md](../../electron-migration-roadmap.md) — Phase 4

---

## 1. 이 Phase가 만드는 것

앱이 Python·ML 라이브러리·ffmpeg를 자기 안에 싣고, worker·embed를 그 번들로 띄운다.
**Python·uv·Homebrew를 따로 깔지 않은 맥에서 전사·화자 분리·요약·검색이 돈다.**

Phase 3이 Docker 의존을 지웠듯 이 Phase는 개발 도구 의존을 지운다. 끝나면 앱이
저장소 체크아웃 밖의 실행 파일을 하나도 부르지 않는다 — `uv`도, Homebrew `ffmpeg`도,
`be/worker/.venv`도, `~/.local/bin/mlx_lm.server`도.

모델 가중치는 번들에 넣지 않는다. 앱 밖 사용자 데이터 폴더에 받아 두고 재사용한다.
화자 분리 모델이 HF에서 게이트되므로, 앱은 첫 실행에 HF 토큰을 받고 macOS Keychain에 보관한다.

**이 Phase가 바꾸지 않는 것:** job 테이블 계약, 파이프라인 알고리즘, 모델 선택 규칙
(payload 책임), 기존 웹 개발 흐름(`pnpm worker`·`pnpm embed`·`be/worker/.venv`).

---

## 2. 선행 Phase에서 인계받는 것

### 2.1 Phase 0 (패키징 기술 검증) — 실측으로 확정된 제공 방식

| 항목 | 확정된 값 |
| --- | --- |
| Python | python-build-standalone **3.12.11** + `uv pip install --python`. venv를 만들지 않고 배포본 `site-packages`에 직접 설치. **1509 MiB** |
| ffmpeg | LGPL 2.1 **정적 소스 빌드** (`--disable-gpl --disable-nonfree --disable-version3`). **42 MB**. 완전 정적이라 `LC_RPATH`가 없고 재배치에서 아무것도 깨지지 않는다 |
| 재현 절차 | `experiments/electron-phase-0/{python,ffmpeg}/build.sh` — 태그 `archive/electron-phase-0-packaging-validation` |
| 탈락안 | `uv venv --relocatable`(`pyvenv.cfg`의 `home`이 절대 경로), PyInstaller(`sys.prefix` 의미 변화 + 진입점 넷), conda-pack(이 머신에 conda 계열 없음) |

**옮길 때마다 반복해야 하는 것** — `bin/` 콘솔 스크립트 셔뱅 65개, `_sysconfigdata` prefix,
`__pycache__` 760개 삭제. Mach-O 처리(`LC_RPATH` 58건 삭제, `LC_ID_DYLIB` 64건 정규화)는
첫 relocate로 완결되고 멱등이다.

**셔뱅 함정 (R-6).** 옛 경로가 **사라진** 경우에만 `bad interpreter`로 죽는다. 옛 경로가
남아 있으면 죽지 않고 **조용히 다른 런타임을 실행한다** — Phase 0 reviewer가 번들을 제3
경로로 복사하고 relocate 없이 `bin/uvicorn --version`을 돌리자 정상 종료했고
`sys.executable`이 원래 `bundle/python/bin/python3.12`였다. 앱 업데이트로 두 버전이 잠시
공존할 때 이 형태가 된다.

**무서명 `.so` 서명은 필수다 (R-5).** `disable-library-validation`은 서명 주체를 안 따질 뿐
"서명 없음"을 허용하지 않는다. 대상 10개를 ad-hoc 서명하면 전부 로드되고
`codesign --remove-signature`로 떼면 전부 `missing code signature`로 실패한다.

**슬라이스 구분이 작업량을 바꾼다.** 이 번들의 **arm64 무서명은 0개**, 다른 슬라이스만
무서명인 것이 10개, 전 슬라이스 서명이 516개다. `codesign --verify`를 `--arch` 없이 부르면
universal 파일에서 x86_64 슬라이스 하나만 서명이 없어도 파일 전체를 `not signed at all`로
보고한다.

**최소 entitlement 집합은 `{allow-unsigned-executable-memory, disable-library-validation}`.**
MLX Metal 셰이더 런타임 컴파일과 `torch.jit.script`는 hardened runtime에서 깨지지 않는다.
깨지는 것은 numba의 LLVM MCJIT이고, 쓰기+실행 매핑 거부는 **메시지 없이 SIGKILL**이며
크래시 리포트도 남지 않는다. `allow-jit`은 최소 집합에 들어가지 않으나 `jit+dlv` 회차는
재지 않았다.

**미해결로 넘어온 것 셋:**

1. **numba 사망 지점이 import인지 `@njit` 컴파일인지 구분되지 않았다.** `probe.sh:391-406`이
   한 프로세스에서 import + 정의 + 호출을 모두 해 어디서 죽었는지 모른다. 컴파일이라면
   `mlx_whisper/timing.py:47,72`의 `@numba.jit(nopython=True)`는 지연 컴파일이므로 STT는
   import에서 죽지 않고 **word-timestamp DTW 경로에서만** 죽는다.
2. **`mlx-lm`·`mlx` 버전의 단일 진실 원천이 없다.** → **2026-09-16 실측으로 더 나쁜 것이
   드러났다. §2.4를 보라.**
3. **bge-m3가 같은 가중치를 두 벌 받는다** — `pytorch_model.bin`(rev `5617a9f…`)과
   `model.safetensors`(rev `9a0624b…`)로 리비전까지 갈린다. **2.1 GB 낭비.**

**G1 허용 목록 24건**(제3자 wheel·CPython 표준 라이브러리 원본의 금지 문자열)과 그중
**실동작 폴백 3건**(`soundfile.py`, `ctypes/macholib/dyld.py`, `PIL/_imagingft…so`)의
미사용 증명은 이 Phase가 받지 않는다 — §15에서 Phase 6으로 넘긴다. **그 대신 로드맵
완료 기준 2번("번들 외부를 참조하지 않음")을 조건부로 남기지 않기 위해 §6.2에서 PATH
폴백 자체를 제거한다.**

### 2.2 Phase 2 (서비스 실행 통합)

- **`FFMPEG_BIN`/`FFPROBE_BIN`을 worker에 넣어야 한다.**
  `be/worker/damwha_worker/pipeline/ffmpeg.py`가 `ffmpeg`·`ffprobe`를 이름으로만 부르므로
  (`:24`, `:59`) 번들에 ffmpeg를 넣는 것만으로는 개발 도구가 없는 맥에서 찾지 못한다
  (Phase 2 스펙 §6.2·§15).
- **`UV_BIN`을 고친 뒤 "다시 시도"로는 반영되지 않는다** (Phase 2 결과 §5의 (2)).
  이 Phase가 `uv`를 런타임에서 제거하므로 **이 한계는 함께 소멸한다.**
- **앱 소유/외부 판정의 기존 형태가 이 Phase의 출발점이다.**
  `desktop/src/services/worker-discovery.ts:51-56`의 `isWorkerSupervisor`는 세 조건을
  **모두** 요구한다 — argv[0] basename이 python 실행 파일, `-m damwha_worker`가 **토큰 쌍**,
  `--once` 토큰 없음. 이것이 `uv run …` 런처 줄과 `/bin/zsh -c "… damwha_worker …"` 같은
  셸 줄을 거른다. §6.5가 이 판정을 대체하지 않고 **확장한다.**
- **`ps eww`는 SIP 때문에 다른 프로세스의 env를 내주지 않는다** (2026-09-12 실측). 소유 표식을
  env에 둘 수 없는 이유다 (§6.5).
- **강제 종료 4단계의 자손 SIGKILL은 실앱에서 발화한 적이 없다** — 단위 테스트로만 존재한다.
- worker supervisor가 **크래시**해 재시작되면 이전 `--once` 자식을 추적하지 않는다.
- **packaged 앱이 아직 저장소 체크아웃을 요구한다.** `desktop/src/config/repo-root.ts:9`의
  주석이 "packaged .app 안에는 be/worker가 없다 — **Phase 4가 번들할 것이라** 그때까지 저장소
  체크아웃을 가리켜야 한다"고 적었고, `main.ts:986`의 `resolveRepoRoot()`가 못 찾으면 폴더
  선택창을 띄우고 취소하면 기동이 실패한다. **이 Phase가 그 게이트를 지운다.**

### 2.3 Phase 3 (PostgreSQL 내장)

- **`pgBinaries` 방식 — PATH 탐색이 아니라 앱이 아는 절대 경로.** 이 Phase가 worker·embed·
  ffmpeg·`mlx_lm.server`에 같은 방식을 적용한다 (Phase 3 결과 §5.4).
- **빌드 스크립트 관례** — `desktop/scripts/build-postgres.sh`가 세운 형태: 버전 고정,
  이 머신에 없는 중립 `BUILD_PREFIX`, 캐시 키에 스크립트 자신의 체크섬, `desktop/build/` 아래
  스테이징, `extraResources: - from: build`가 그대로 `Resources/`로.
- **`app_setting` 공유 행 선례** — `worker_capabilities`가 job 테이블 계약 밖의 유일한
  공유 행이다(`be/worker/damwha_worker/db/core.py:20`, `be/src/system/capabilities.ts:78`).
  worker가 쓰고 API는 읽기 전용. 이 Phase의 `model_readiness`가 두 번째가 된다.
- **앱 main이 강제 종료되면 worker 트리가 고아로 남고 다음 실행이 정리하지 않는다**
  (Phase 3 결과 §5.2-2). P3-C3에서 옛 worker와 새 worker가 함께 돌았다. 고아 embed는 한 번은
  채택됐지만 그 뒤 실행에서는 채택되지 않고 새 embed가 따로 떠 둘이 모델 메모리를 썼다.
  **이 Phase가 받는다** (§6.5).
- 데이터 위치는 Phase 3이 고정했다 — `~/Library/Application Support/Damwha/`. dev와 packaged가
  같은 곳을 쓴다.

### 2.4 2026-09-16 실측으로 새로 드러난 것 — `mlx-lm`이 아예 매니페스트 밖이다

Phase 0은 `mlx-lm`이 "`pyproject.toml` 밖에서 고정된다"고 적었다. 실제는 더 나쁘다.

```
be/worker/pyproject.toml   → mlx-lm 없음 (mlx-whisper==0.4.3만)
be/worker/uv.lock          → mlx, mlx-metal, mlx-whisper만. mlx-lm 없음
be/worker/.venv            → mlx 0.31.2, mlx_whisper. mlx_lm 없음
uv tool list               → mlx-lm v0.31.3  →  ~/.local/bin/mlx_lm.server
```

**렌즈·요약은 지금 개발 머신의 전역 uv tool 설치에 기대고 있다.**
`llm_server.py:92`의 `shutil.which("mlx_lm.server")`가 `~/.local/bin`에서 찾고, 못 찾으면
`:96`이 `uv tool install mlx-lm`을 안내한다. 개발 도구가 없는 맥에는 그 경로가 없다.

**설치된 `mlx`는 0.31.2**로 Phase 0 문서의 0.32.2와 다르다. 버전 드리프트가 실재한다.

**함의:** 이 Phase는 `mlx-lm`을 **매니페스트에 넣고 번들에 설치해야 한다.** 그러지 않으면
완료 기준 "요약 성공"이 통과할 수 없다. 이것은 매니페스트 정리가 아니라 기능 복구다.

---

## 3. 현재 시스템에서 이 Phase가 건드리는 지점

| 지점 | 지금 | 이 Phase 뒤 |
| --- | --- | --- |
| `desktop/src/process/uv-launcher.ts` | `uv run --directory be/worker <args>` | `launchPython` — `<번들>/bin/python3.12 -m <모듈>` |
| `desktop/src/services/worker.ts:launch` | `ctx.bins.uv` 확인 + `be/worker/.env` 존재 확인 | 번들 python 확인. `.env` 검사 제거 |
| `desktop/src/services/embed.ts:launch` | `damwha-embed` 콘솔 스크립트 | `-m damwha_worker.embed_service` |
| `desktop/src/services/worker-discovery.ts` | `isWorkerSupervisor` 3조건 | + `--run-id` 판독. 소유/외부/고아 셋으로 |
| `desktop/src/process/executables.ts` | `searchDirs`가 자식 PATH 앞에 | **자식 PATH는 번들 경로만** (§6.2) |
| `desktop/src/config/repo-root.ts`·`main.ts:986` | packaged도 저장소를 요구, 없으면 폴더 선택창 | **packaged는 저장소를 보지 않는다** |
| `desktop/src/config/config.ts` | `UV_BIN` 설정 키 | 제거. `HF_TOKEN`은 앱 소유 키로 거절 |
| `desktop/src/services/supervisor.ts:472` | `retry()`가 running 서비스를 건너뛴다 | 모델 재시도는 별도 경로 (§6.10) |
| `desktop/scripts/package.mjs` | `build-postgres.sh` 하나, ad-hoc `--sign -` | 두 스크립트 추가, `--options runtime --entitlements` |
| `desktop/scripts/check-bundle.mjs` | API·PG 트리 검사 | Python·ffmpeg 트리·서명·entitlement·문자열 검사 |
| `be/worker/pyproject.toml` | `mlx-whisper`만 | **`mlx-lm`·`mlx` 명시 고정** |
| `be/worker/damwha_worker/config.py` | — | `ffmpeg_bin`·`ffprobe_bin` 필드 |
| `be/worker/damwha_worker/pipeline/ffmpeg.py:24,59` | `["ffmpeg", …]` 리터럴 | **호출 시점에 env에서 읽는다** (§6.6) |
| `be/worker/damwha_worker/embed_service.py` | `main()`만 | `if __name__ == "__main__": main()` |
| `be/worker/damwha_worker/__main__.py` | argv에 `--once`만 | `--run-id=<uuid>` 수용·전파 |
| `be/worker/damwha_worker/llm_server.py:92,103` | `shutil.which` + 콘솔 스크립트 실행 | `[sys.executable, "-m", "mlx_lm.server", …]` |
| `be/worker/damwha_worker/db/core.py` | `worker_capabilities` | `model_readiness` 추가 |

**건드리지 않는 것:** `__main__.py:286`의 `--once` 자식 스폰 대상과 `capabilities.py:68`의
프로브. 둘 다 `sys.executable`을 쓰므로 번들 python을 자동으로 승계한다. (`--once` 자식의
**인자**에는 `--run-id`를 더한다.)

---

## 4. 범위

### 4.1 포함

1. Python 런타임·ML 라이브러리·ffmpeg의 빌드·스테이징·번들 적재.
2. **`mlx-lm` 매니페스트 편입과 번들 설치** (§2.4).
3. 빌드 시점 Mach-O 서명(arm64 전수)과 재배치 3종 반복 적용. 최종 앱 서명에
   hardened runtime + entitlements 적용.
4. worker·embed·LLM 서버 실행 계약 교체 — `uv run`·콘솔 스크립트 제거, 번들 python `-m` 진입.
5. **자식 PATH에서 개발 도구 폴백 제거** — 번들 경로만 준다.
6. `FFMPEG_BIN`/`FFPROBE_BIN`의 절대 경로 주입과 worker 쪽 수용.
7. `be/worker/.env` 의존 제거, **packaged의 저장소 체크아웃 의존 제거.**
8. 모델·캐시 경로를 `<userData>/models`로 고정하고, 다른 캐시 환경변수를 정리.
9. bge-m3 중복 다운로드 제거 (리비전 고정 + safetensors 단일 경로).
10. HF 토큰 온보딩 — 첫 실행 필수 게이트, 실제 API 검증, Keychain 저장, 설정에서 수정.
11. 모델 준비 상태를 `app_setting.model_readiness`로 올리고 앱·FE가 읽어 진행·실패 표시.
12. **재시도 계약 3층 분리** — 모델 재다운로드 / 서비스 재시작 / job 재처리 (§6.10).
13. 소유 표식(`--run-id`)과 고아 정리, **부모 선종료 자손 회수** (§6.5).
14. numba 사망 지점 A/B 재측정과 그 결과에 따른 분기 (§6.8).
15. dev 루프 — `PYTHONPATH`로 저장소 worker 소스를 앞세운다.
16. 번들 위생 검사 확장(`check-bundle.mjs`).

### 4.2 제외

| 제외 | 어디로 |
| --- | --- |
| Developer ID 서명·공증·DMG·자동 업데이트 | Phase 6 |
| G1 허용 목록 24건 재검토, 실동작 폴백 3건 미사용 증명 | Phase 6 — 서명·공증과 같은 회차 |
| 기존 데이터(Docker DB·`be/storage`·기존 HF 캐시) 이전 | Phase 5 |
| 잠자기·복귀, 디스크 부족 중 동작 검증 | Phase 5 |
| 깨끗한 다른 맥에서의 독립 설치 검증 | Phase 6 |
| job lease token | Phase 6 |
| pyannote 비게이트 대안 모델 조사 | 범위 밖 |
| 모델 교체·선택 UI | 범위 밖 — 모델 선택은 payload 책임이다 |
| Intel 맥 | 로드맵 전체에서 제외 |

### 4.3 선행 조건

- 빌드 머신에 Xcode Command Line Tools와 `uv`. **실행 머신의 조건이 아니다.**
- HF 계정과 `pyannote/speaker-diarization-community-1` 조건 수락.
  **검증자가 조건을 수락한 계정과 수락하지 않은 계정 둘을 가져야 P4-C8을 판정할 수 있다.**
- Phase 3의 내장 PostgreSQL이 동작하는 상태.
- **검증용 빈 캐시 디렉터리를 만들 수 있어야 한다** — 기존 `~/.cache/huggingface`를
  건드리지 않고 `<userData>/models`만 비운다.

---

## 5. 데이터 안전 규칙

**보존 대상과 쓰기 대상을 구분한다.** 검증이 실제 처리를 하므로 "모두 불변"은 성립하지 않는다.

**절대 불변 (바이트 단위로 증명한다):**

1. `be/worker/.venv`, `be/worker/.env`, `be/.env`, `fe/.env`
2. `~/.cache/huggingface` — 기존 개발 모델 캐시
3. `~/.local/bin`, `~/.local/share/uv` — 기존 uv tool 설치
4. Docker 볼륨 `damwha_pgdata`, `be/storage`
5. `<userData>/storage/` — Phase 1·2가 Docker DB와 쓰던 폴더 (Phase 5가 옮긴다)

**앱이 쓰는 영역 (기존 레코드·파일 보존으로 판정한다):**

- `<userData>/data/postgres` (PGDATA) — 검증 전 행 수·회의 ID가 검증 뒤에도 전부 있고,
  **새로 추가된 것만** 늘어난다.
- `<userData>/data/storage` — 기존 파일 체크섬 불변 + 새 파일 추가.
- `<userData>/models` — 이 Phase가 만든다. 검증이 비우고 채운다.
- `<userData>/logs`, `<userData>/hf-token.bin`, `<userData>/config.json`.

**외부 DB 디버그 모드(`DEBUG_EXTERNAL_DATABASE_URL`)는 이 Phase의 검증에서 쓰지 않는다.**
Phase 3이 남긴 "그 모드에서 worker가 Docker DB에 `worker_capabilities` 한 행을 쓴다"는
경로를 이 Phase가 넓히지 않는다 — `model_readiness`도 같은 곳에 쓰게 되므로, 그 모드에서는
**두 행 모두 쓰지 않는다**고 §6.9에 명시한다.

**웹 흐름 회귀 검증(P4-C21)은 앱 데이터와 분리된 환경에서 한다** — Docker DB + `be/storage` +
기존 `.venv`. 앱 검증과 같은 회차에 섞지 않는다.

**그 밖:**

- 고아 정리는 §6.5의 4조건을 **모두** 만족하는 프로세스만 내린다.
- 빌드가 실패하면 앱을 만들지 않는다 — Python이 빠진 `.app`은 첫 실행에서야 드러난다.
- 토큰 평문을 디스크·로그·화면 어디에도 남기지 않는다.

---

## 6. 구성요소와 계약

### 6.1 번들 계약

```
Damwha.app/Contents/Resources/
  api/          (Phase 1·2)
  postgres/     (Phase 3)
  python/       ← 새로   bin/python3.12, lib/python3.12/site-packages/
  ffmpeg/       ← 새로   bin/ffmpeg, bin/ffprobe
```

dev는 `desktop/build/{python,ffmpeg}`를 같은 자리로 본다. `electron-builder.yml`의
`extraResources: - from: build`가 이미 `build/` 아래 전부를 싣는다 — 설정 변경은 없다.

**빌드 스크립트 두 개.**

| 스크립트 | 산출물 | 캐시 |
| --- | --- | --- |
| `desktop/scripts/build-python.sh [--fresh]` | `desktop/build/python/` | `desktop/.cache/python/` |
| `desktop/scripts/build-ffmpeg.sh [--fresh]` | `desktop/build/ffmpeg/` | `desktop/.cache/ffmpeg/` |

**캐시를 두 층으로 나눈다.** `build-postgres.sh`는 산출물이 하나뿐이라 캐시도 하나였지만,
Python 트리는 **거의 안 변하는 런타임+의존성**과 **매 커밋 변하는 worker 패키지**가 섞여 있다.
하나로 묶으면 worker를 고쳐도 캐시가 적중해 **옛 코드가 `.app`에 실린다** — Phase 2가 정확히
그 결함을 겪었다(`24f9080`).

| 층 | 캐시 키 | 내용 |
| --- | --- | --- |
| 런타임 | Python 버전 + `BUILD_PREFIX` + `checksums.txt` + **`pyproject.toml`·`uv.lock` 해시** + 스크립트 shasum | 인터프리터 + 의존성 + 재배치 + 서명 |
| worker | 위 키 + **`be/worker/damwha_worker/` 트리 해시** | `damwha_worker` 패키지 설치 |

worker 층은 런타임 층을 복사한 뒤 패키지만 덮어 설치하고 그 파일만 다시 서명한다.

**`build-python.sh`의 단계:**

1. python-build-standalone 3.12.11 내려받기·검증(`python-checksums.txt`)·전개.
2. `uv pip install --python <트리>` — `be/worker/pyproject.toml`의 기본 의존성 +
   `[project.optional-dependencies] models`. **`uv.lock`을 입력으로 쓴다** (`uv export`로
   고정 목록을 뽑아 넘긴다). 스크립트는 버전을 스스로 적지 않는다.
3. `uv pip install --python <트리> --no-deps <repo>/be/worker` — `damwha_worker` 패키지.
   `--no-deps`인 이유: 2단계가 이미 전부 깔았고, 여기서 해석이 다시 돌면 고정이 흔들린다.
4. **재배치 3종** — `bin/` 셔뱅 65개를 번들 상대로, `_sysconfigdata*.py`의 prefix,
   `__pycache__` 760개 삭제. **매 빌드 반복한다.**
5. **Mach-O 처리** — `LC_RPATH` 58건 삭제, `LC_ID_DYLIB` 64건 정규화. 멱등이다.
6. **arm64 전수 서명** — 무서명 Mach-O에 `codesign -s - --force`.
7. **자기 검사** — `codesign --verify --arch arm64`로 0건. `--arch` 없이 부르지 않는다.
8. **진입점 확인** — `python3.12 -c "import mlx_lm.server, damwha_worker"`가 통과해야 한다.
   §2.4의 결함이 다시 나면 빌드에서 잡힌다.

**의존성 매니페스트.** `be/worker/pyproject.toml`의 `models` extra에 **`mlx-lm`과 `mlx`를
`==`로 명시 고정**하고 `uv lock`을 갱신한다.

- `mlx-lm`의 기준값은 이 맥의 uv tool 설치본 **0.31.3** (2026-09-16 실측). `uv lock`이
  해석하는 `mlx` 버전이 기존 `.venv`의 0.31.2와 다르면, **다른 쪽이 아니라 `uv.lock`을
  단일 진실 원천으로 삼고** 웹 흐름의 `.venv`를 그 값으로 다시 맞춘다(`pnpm worker:sync`).
  두 스택이 갈린 채로 두지 않는다.
- 이 변경은 `be/worker` 테스트 전체와 실오디오 1건으로 회귀를 확인한 뒤 확정한다
  (`mlx` 버전 변화가 STT 출력을 바꿀 수 있다).

**공통 규칙** (`build-postgres.sh`와 같다): `BUILD_PREFIX`는 이 머신에 없는 중립 경로,
소스 아카이브는 체크섬 검증, 스크립트를 한 글자라도 고치면 다시 빌드.

**서명과 entitlements.** `desktop/build-resources/entitlements.mac.plist`:

```
com.apple.security.cs.allow-unsigned-executable-memory  true
com.apple.security.cs.disable-library-validation        true
```

`package.mjs`의 최종 서명을 고친다 — 지금은 `codesign --force --deep --sign -`뿐이라
**hardened runtime도 entitlement도 적용되지 않는다.** 바꿀 형태:

```
codesign --force --sign - --options runtime \
         --entitlements build-resources/entitlements.mac.plist \
         <Resources/python 안의 Mach-O들, Resources/ffmpeg/bin/*>
codesign --force --deep --sign - --options runtime \
         --entitlements build-resources/entitlements.mac.plist <Damwha.app>
```

`check-bundle.mjs`가 `codesign -d --entitlements -`로 실제 적용을 확인한다.
**§6.8의 numba 측정도 이 조합으로 서명한 번들에서 한다** — 측정 조건과 제품 조건이 같아야
측정에 의미가 있다. `allow-jit`은 §6.8이 요구할 때만 더한다.

### 6.2 실행 계약

`desktop/src/process/uv-launcher.ts` → `desktop/src/process/python-launcher.ts`.

```
<python>/bin/python3.12 -m damwha_worker               --run-id=<uuid>
<python>/bin/python3.12 -m damwha_worker.embed_service --run-id=<uuid>
<python>/bin/python3.12 -m damwha_worker --once        --run-id=<uuid>   (worker가 띄운다)
<python>/bin/python3.12 -m mlx_lm.server --model … --host … --port …     (worker가 띄운다)
```

- **콘솔 스크립트를 부르지 않는다.** `bin/damwha-worker`·`bin/damwha-embed`·
  `bin/mlx_lm.server`는 셔뱅을 타고, Phase 0 R-6대로 옛 경로가 남아 있으면 죽지 않고
  **조용히 다른 런타임을 실행한다**. `-m`은 셔뱅을 타지 않는다. (셔뱅 재배치는 여전히
  빌드에서 한다 — 사람이 손으로 부를 수 있다.)
- `embed_service.py`에 `if __name__ == "__main__": main()`을 더한다. 기존
  `[project.scripts] damwha-embed` 진입점은 그대로 둔다 (`deploy/README.md`의
  `uv tool install` 경로가 쓴다).
- **`llm_server.py`를 고친다.** 지금은 `shutil.which(settings.lens_llm_server_bin)`으로 찾은
  **콘솔 스크립트**를 `popen([binary, "--model", …])`로 실행한다. 이것을
  `[sys.executable, "-m", "mlx_lm.server", "--model", …]`로 바꾼다.
  - 셔뱅을 안 탄다.
  - `sys.executable`이 번들 python이므로 자동으로 번들 mlx-lm을 쓴다.
  - `LENS_LLM_SERVER_BIN` 설정은 **남기되 의미가 바뀐다** — 값이 있으면 그것을 그대로
    실행하고(수동 운용·다른 백엔드), 없으면 위 모듈 진입이 기본이다. 기본값을 모듈로 바꾸는
    것이므로 `lens_llm_server_bin`의 기본값을 `""`(=모듈 진입)로 내린다.
  - `:96`의 오류 문구도 고친다 — `uv tool install mlx-lm` 안내는 이제 틀렸다.
- **`mlx_lm.server`에는 `--run-id`를 붙이지 않는다.** upstream CLI라 모르는 인자로 죽는다.
  소유 판정은 §6.5가 별도 규칙으로 다룬다.
- **cwd.** `uv run --directory be/worker`가 하던 일을 잃는다. 앱은 cwd를 `<userData>`로 준다.
  worker는 경로를 절대값으로 받으므로 cwd에 의존하지 않는다. 다만 **`Settings`가
  `SettingsConfigDict(env_file=".env")`로 cwd의 `.env`를 읽으므로**(`config.py:9`),
  앱은 `<userData>`에 `.env`를 만들지 않고, `check-bundle.mjs`가 아닌 **기동 시** 그 파일이
  있으면 경고한다. (앱 env가 `.env`보다 우선이라 실해는 없지만, 있으면 혼란의 원인이다.)
- **종료 신호.** `uv` 중간 프로세스가 사라져 SIGTERM이 Python에 바로 닿는다. `detached: true`는
  유지한다 — dev 터미널의 그룹 신호가 종료 절차를 건너뛰는 것을 막는 것이 그 이유였다.
- **stdout/stderr 분리 유지.** worker의 ready 줄은 stderr, embed(uvicorn)의 접근 로그는 stdout.

**PATH 계약 — 폴백을 없앤다.**

```
자식 PATH = <python>/bin : <ffmpeg>/bin
```

기존 `searchDirs`(Homebrew·`/usr/local`·`~/.local/bin` …)를 **자식에게 주지 않는다.**

- 이유: 완료 기준이 "번들 외부를 참조하지 않음"이다. 폴백을 남기면 Homebrew ffmpeg가
  조용히 쓰여도 검증이 통과하고, 그 사실을 `lsof` 스냅숏으로는 확정적으로 부정할 수 없다.
  **증명이 구조적으로 성립하게 만드는 것이 스냅숏 증거를 늘리는 것보다 강하다.**
- 없는 도구를 찾으면 시끄럽게 죽는다. 그것이 조용한 폴백보다 낫다.
- `searchDirs`는 **앱 자신의** 도구 탐색(dev의 `git` 등)에만 남는다. 자식 env에는 안 간다.
- `/usr/bin:/bin`을 넣지 않는 것이 과한지는 구현 중 실측으로 확인한다 — 넣어야 한다면
  그 이유와 실측을 결과 문서에 적고, `check-bundle.mjs`가 아니라 P4-C12·C13이 판정을 맡는다.

### 6.3 env 주입 계약

`be/worker/.env` 존재 검사를 `workerSpec.launch`에서 **지운다.** 번들에는 그 파일이 없고,
앱이 필요한 값을 전부 자기가 넣는다.

| 키 | 값 | 출처 |
| --- | --- | --- |
| `DATABASE_URL`·`STORAGE_ROOT` | 내장 클러스터 짝 | Phase 3 (`withEmbeddedDatabase`) |
| `WORKER_ID` | `desktop-<uuid>` (실행마다 새 값) | Phase 2 (`RUN_WORKER_ID`) |
| `EMBED_SERVICE_HOST`·`PORT`·`URL` | 루프백 고정 + `prepare`의 파생 | Phase 2 |
| `HF_TOKEN` | Keychain 복호화본 | **새로** (§6.4) |
| `HF_HOME` | `<userData>/models` | **새로** |
| `LENS_LLM_BASE_URL` | `http://127.0.0.1:<빈 포트>` | **새로** — `DATABASE_URL`과 함께 기본값 없는 필수 키 둘 중 하나다. Phase 3이 이미 넣는 `DATABASE_URL`과 달리 이것은 **이 Phase가 새로 넣어야 한다**. 빠뜨리면 worker가 `ValidationError`로 기동 실패 |
| `FFMPEG_BIN`·`FFPROBE_BIN` | `<ffmpeg>/bin/ffmpeg`·`ffprobe` | **새로** (§6.6) |
| `PYTHONPATH` | **dev만** `<repo>/be/worker` | **새로** (§6.7) |

**env 위생 — 상속을 좁힌다.** 지금 `uv-launcher.ts:51-55`는 `...process.env`를 통째로
넘긴다. Electron이 Finder에서 뜨면 그 env는 얇지만, dev 터미널에서 뜨면 개발자의 전체
환경이 자식에 들어간다. 다음을 자식 env에서 **지운다**:

| 지울 키 | 이유 |
| --- | --- |
| `PYTHONHOME`·`PYTHONSTARTUP`·`PYTHONUSERBASE` | 번들 인터프리터의 prefix 해석을 흔든다 |
| `VIRTUAL_ENV`·`CONDA_PREFIX` | 다른 환경을 가리킨다 |
| `HF_HUB_CACHE`·`TRANSFORMERS_CACHE`·`TORCH_HOME`·`XDG_CACHE_HOME` | **`HF_HOME` 하나가 모두를 이긴다는 근거가 없다.** 더 구체적인 변수가 있으면 그것이 이긴다 |
| packaged의 `PYTHONPATH` | dev 전용이다. 새면 §6.7의 격리가 무너진다 |

**앱이 못 덮는 캐시가 남는지는 구현 중 실측한다.** speechbrain(ECAPA)·silero는 라이브러리가
자체 경로를 쓸 수 있다(`models/ecapa_embed.py:27-29`가 위치를 라이브러리에 위임한다).
**P4-C12가 판정하고**, `HF_HOME`으로 안 덮이는 것이 나오면 그 라이브러리의 전용 변수를
§6.3 표에 추가한다.

**`UV_BIN`을 지운다.** `config.ts`의 `APP_SETTING_KEYS`에서 빼고, `config.json`에 남아 있으면
`DOCKER_BIN`과 같이 **로그에만 남기는 note**를 적는다.

**`REPO_ROOT`의 의미가 좁아진다.** packaged는 읽지 않는다. dev만 쓰고, 못 찾아도
**폴더 선택창을 띄우지 않는다** — dev는 `app.getAppPath()/..`로 항상 찾을 수 있다.
`CAUSES.repoRootMissing`은 dev 전용 원인이 된다.

**`HF_TOKEN`은 앱 소유 키다.** `config.json`에 적혀 있으면 무시하고 화면 경고를 낸다.
값 자체는 경고에 싣지 않는다.

### 6.4 HF 토큰 계약

**첫 실행 게이트.** 토큰이 없으면 앱이 서비스를 띄우기 전에 토큰 화면을 띄운다. **건너뛸 수
없다.** 화면이 가진 것: (1) `pyannote/speaker-diarization-community-1` 조건 수락 페이지 링크,
(2) HF 토큰 발급 페이지 링크, (3) 입력칸.

**저장 전에 실제로 검증한다.** `GET https://huggingface.co/api/whoami-v2`에 `Bearer`로 붙여
200을 받아야 저장한다. 형식만 보면 오타난 토큰이 통과해 몇 분 뒤 job 실패로만 드러난다.
네트워크가 없으면 "지금은 확인할 수 없어요"로 구분해 말하고 저장하지 않는다.

**게이트 수락 여부는 이 시점에 확인하지 않는다.** 수락은 모델 단위이고, 확인하려면 그 모델
파일을 실제로 건드려야 한다. §6.6의 실패 분류가 403을 "조건 수락 안 함"으로 구별한다.

**저장.** `safeStorage.encryptString(token)` → `<userData>/hf-token.bin` (0600).
복호화는 Electron main만 한다. 자식에게는 `HF_TOKEN` env로만 넘어간다.

- `safeStorage.isEncryptionAvailable()`이 false면 **기동을 막고** 원인과 복구를 띄운다.
  평문 폴백은 두지 않는다.
- 복호화 실패는 "토큰을 읽을 수 없어요 — 다시 입력해 주세요"로 토큰 화면을 다시 띄운다.
  파일은 지우지 않는다.

**설정 화면.** 상태 창에 토큰 항목. 마스킹 표시(`hf_****…****abcd`), 수정·삭제 가능.
**토큰 교체는 §6.10의 "서비스 재시작" 경로를 탄다** — `retry()`가 아니다.

**토큰 원문은 어디에도 로그하지 않는다.** 검증 실패 사유는 HTTP 상태와 HF 응답 메시지만.

### 6.5 소유·고아 처분 계약

**표식은 argv에 둔다, env가 아니라.** `ps eww`는 SIP 때문에 남의 env를 안 준다.

**판정은 기존 3조건을 대체하지 않고 확장한다.** `worker-discovery.ts`의 `isWorkerSupervisor`가
이미 argv[0] basename·`-m` 토큰 쌍·`--once` 유무를 본다. run-id 하나만 보면 `grep --run-id=…`
같은 셸 줄이 걸린다 — 기존 코드가 정확히 그 오탐을 막으려고 만든 조건이다.

**damwha Python 프로세스 판정 (4조건 모두):**

1. argv[0] basename이 python 실행 파일이다.
2. `-m` 다음 토큰이 `damwha_worker` 또는 `damwha_worker.embed_service`다.
3. argv[0]의 절대 경로가 **번들 python 트리 아래**다 (`Resources/python` 또는
   `desktop/build/python`). 저장소 `.venv`·Homebrew python이 여기서 빠진다.
4. `--run-id=<uuid>` 토큰이 있다.

**처분:**

| 판정 | 처분 |
| --- | --- |
| 4조건 만족 + run-id가 내 것 | 내 프로세스 |
| 4조건 만족 + run-id가 다른 값 | **이전 실행의 고아. 내린다** |
| 1·2만 만족 (번들 밖 python, run-id 없음) | 외부 `pnpm worker`. **손대지 않고 stand-down** |
| `mlx_lm.server` | run-id가 없다 (§6.2). **부모 worker의 자손으로만 판정한다** — 고아 worker를 내릴 때 그 프로세스 트리를 함께 훑는다 |

**신호 직전에 pid 정체성을 다시 확인한다.** 스캔과 신호 사이에 pid가 재사용될 수 있다.
`process-tree.ts`가 이미 갖춘 왕복을 쓴다.

**스캔이 실패하면 새 worker를 띄우지 않는다.** `ps`가 실패했는데 그대로 진행하면 고아와
새 프로세스가 같은 job을 집는다. 실패 화면에 원인과 "다시 시도"를 띄운다.

**정리는 서비스 기동 전에 한다.** 뒤에 하면 새로 띄운 것과 고아가 잠시 공존한다.

**embed 채택 규칙이 좁아진다.** `--run-id`가 있고 내 것이 아닌 embed는 채택 대상이 아니라
**고아**다 — 먼저 내리고 새로 띄운다. run-id 없는 외부 embed(터미널 `pnpm embed`)만 채택한다.
Phase 3 §5.2-2의 "고아 embed가 한 번은 채택되고 그 뒤에는 둘이 모델 메모리를 썼다"가 닫힌다.

**부모 선종료 자손 회수.** Python supervisor는 **두 번째 SIGTERM에서 `--once` 자식을
`proc.kill()`하고 `os._exit(1)`한다**(`__main__.py:268-287`). 자식은 `start_new_session=True`라
**별도 세션**이다. 즉 부모가 먼저 사라지면 desktop의 자손 SIGKILL 단계는 훑을 트리를 잃는다.

그래서 종료 절차에 한 단계를 더한다:

1. SIGTERM → 유예.
2. 자손 SIGKILL (부모가 살아 있을 때).
3. **부모가 사라졌으면 §6.5의 4조건 + `--once` 토큰으로 남은 자식을 직접 찾아 회수한다.**
   run-id가 내 것인 `--once` 프로세스와 그 트리의 `mlx_lm.server`가 대상이다.

`llm_server.py`도 `start_new_session` 여부를 확인해 같은 규칙을 적용한다.

**supervisor가 실행 중 크래시해 재시작되면** 이전 `--once` 자식이 **같은 run-id를 갖는다** —
기동 시 정리로는 안 잡힌다. 근본 해소는 job lease token(Phase 6)이고, 이 Phase는 **그 경계를
명시만 한다.** 재시작 시 run-id가 같은 `--once` 자식을 회수할지는 구현 중 판단하되,
job을 처리 중인 자식을 죽이면 그 job이 `attempts`를 소모하므로 **기본은 회수하지 않는다.**

### 6.6 ffmpeg·모델 경로 계약

**ffmpeg 바이너리는 `ffmpeg.py`가 호출 시점에 env에서 읽는다.**

```python
def _bin(name: str) -> str:
    return os.environ.get(f"{name.upper()}_BIN") or name
```

`probe()`·`normalize()`가 `["ffprobe", …]` 대신 `[_bin("ffprobe"), …]`를 만든다.
`normalize` 안의 재귀 `probe(temp_path)` 호출(`ffmpeg.py:82`)도 자동으로 따라온다.

**`functools.partial` 안을 버린 이유(리뷰 지적 5).** `run_process_meeting`·
`run_enroll_speaker`에는 `settings`가 없고, 두 함수의 기본값은 **호출 시점에**
`ffmpeg.normalize`를 해석해 테스트의 `monkeypatch.setattr(pm.ffmpeg, "normalize", lambda s, d: None)`를
받는다(`process_meeting.py:53`, `enroll_speaker.py:33`, `tests/test_worker_loop.py:52`).
partial을 def-time에 만들면 monkeypatch가 무력해지고, call-time에 만들면 그 lambda에
`ffmpeg_bin=` 키워드를 주게 되어 `TypeError`다. **양쪽 다 깨진다.**

env 읽기는 시그니처·호출부·테스트를 하나도 건드리지 않는다.

**`Settings`에도 `ffmpeg_bin`·`ffprobe_bin`을 둔다** (기본 `"ffmpeg"`/`"ffprobe"`).
pydantic이 같은 env를 읽으므로 값이 갈리지 않고, 설정 문서화와 `.env` 운용 경로가 유지된다.
**단일 진실 원천은 env이고 `Settings`는 그 사본이다** — `ffmpeg.py`가 `Settings`를 직접
만들 수 없기 때문이다(`database_url`이 필수라 실패한다).

**모델 캐시.** `HF_HOME=<userData>/models` + §6.3의 경쟁 변수 제거.

**bge-m3 중복 제거.** `models/bge_embed.py`가 리비전을 고정하고 safetensors만 받게 한다.
검증은 전체 폴더 크기가 아니라 **`models/hub/models--BAAI--bge-m3` 안의 리비전 수와
`pytorch_model.bin` 부재**로 한다 (다른 모델 다운로드가 전체 크기를 흔든다).

### 6.7 dev 루프 계약

dev 실행만 `PYTHONPATH=<repo>/be/worker`. `sys.path`가 site-packages보다 먼저 거기를 본다.

- **빌드 트리에 dev 흔적이 남지 않는다.** editable 설치(`.pth`에 이 머신의 절대 경로)를
  쓰지 않는 이유 — dev와 packaged가 같은 `desktop/build/python`을 공유하므로 그 `.pth`가
  그대로 `.app`에 실린다.
- **packaged는 `PYTHONPATH`를 주지 않고, 상속된 것도 지운다** (§6.3).
- dev와 packaged의 차이는 이 한 줄이다. `sys.path[0]` 차이는 런타임 자기 보고에 드러난다.
- `pnpm worker`·`pnpm embed`(저장소 `.venv`)는 이 경로를 타지 않는다.

### 6.8 numba 측정 계약

**Task 1에서 잰다.** §6.1의 최종 서명 조합(hardened runtime + 최소 entitlement)으로 서명한
번들 python에서, 각각 **별개 프로세스**로:

1. `import numba` 만.
2. `@njit` 함수 **정의**만.
3. 그 함수 **호출** (= 컴파일 발화).

크래시 리포트가 안 남으므로 **부모가 자식의 종료 신호를 읽어 판정한다.**

| 결과 | 조치 |
| --- | --- |
| 셋 다 산다 | entitlement 최소 집합 유지. 끝 |
| 어디선가 죽는다 | `allow-jit`을 더해 재측정 |
| `allow-jit`으로도 죽는다 | **스펙 리뷰로 돌아간다.** §9의 전사 기준을 충족할 수 없다 |

**word-timestamp를 끄는 것은 대안이 아니다.** `models/whisper_mlx.py:107-123`이
`segment["words"]`만 `Word`로 변환하고 그 목록이 파이프라인의 유일한 전사 출력이다
(`pipeline/align.py:113-126`). `word_timestamps=False`면 결과가 **비어 버린다** —
정밀도 저하가 아니라 전사 실패다. 대안 경로(segment 텍스트 기반 정렬)를 설계하지 않은 채
안내 문구만 더하는 방식으로 통과시키지 않는다.

### 6.9 모델 준비 상태 계약

`app_setting`의 두 번째 공유 행. `worker_capabilities`와 같은 방향 — worker·embed가 쓰고
API는 읽기 전용.

```
app_setting.model_readiness = {
  "updated_at": "<ISO8601>",
  "entries": {
    "<hf-repo-id>": {
      "state": "downloading" | "ready" | "failed",
      "bytes_done": 0, "bytes_total": 0,
      "writer": "<WORKER_ID 또는 embed>",
      "attempt": 1,
      "started_at": "<ISO8601>", "updated_at": "<ISO8601>",
      "error": null, "error_kind": null
    }
  }
}
```

- `entries`는 배열이 아니라 **key 맵**이다. merge가 자연스럽고 순서에 의미가 없다.
- 모델 선택은 payload 책임이므로 앱이 미리 알 수 없다 — **실제로 건드린 모델만** 담는다.
- **갱신은 한 SQL 문의 원자적 merge다.** `jsonb_set` + `||`로 해당 key만 덮는다.
  읽고-고치고-쓰면 두 writer가 서로를 지운다.
- **같은 key에 두 writer가 붙을 때의 역전 방지:** 쓰기 전에 그 key의 `updated_at`을 비교해
  **더 오래된 값으로 덮지 않는다.** `ready`를 본 뒤 도착한 늦은 `downloading`은 버린다.
- `bytes_total`을 모르는 구간은 `0`으로 두고 화면이 "받는 중"만 보인다.
- 진행 갱신은 **초당 1회 이하**로 누른다.
- **크래시로 남은 `downloading`:** 읽는 쪽이 `updated_at`이 5분 넘게 멈춘 `downloading`을
  "중단됨"으로 보인다. writer가 정리해 주기를 기대하지 않는다.
- **외부 DB 디버그 모드에서는 이 행을 쓰지 않는다** (§5).

**DB 준비 전 구간 특례는 없다.** 초안은 "embed가 postgres와 나란히 떠서 DB 전에 받는다"고
적었으나 **틀렸다.** 실제 기동은 `buildSpecs`의 `postgres → api → embed → worker`이고
(`services/specs.ts:36-42`), `runFrom`이 gate 서비스를 순서대로 통과시킨 뒤에야 비-gate
서비스를 배경으로 돌린다(`supervisor.ts:495-505`). postgres·api가 gate이므로
**embed가 시작될 때 DB는 이미 준비돼 있다.** 메모리 버퍼가 필요 없다.

**준비 시간 제한을 다운로드와 분리한다.** 지금 embed의 `readyTimeoutMs`는 180초인데
(`services/embed.ts:47`) bge-m3 첫 다운로드는 그보다 오래 걸린다. LLM 서버도 600초 제한이다
(`config.py:54`). 규칙을 바꾼다:

- `model_readiness`에 그 서비스의 `downloading`이 있고 `updated_at`이 **갱신되고 있으면**
  준비 유예를 소모하지 않는다.
- 대신 **무진행 제한**을 둔다 — 진행이 120초 멈추면 실패로 본다.
- 이 규칙은 `readiness()`가 아니라 감독자의 유예 계산에 넣는다. 두 서비스가 같은 규칙을 쓴다.

**읽는 쪽.** API가 기존 설정 조회 응답에 `modelReadiness`로 얹고, 앱 상태 창과 FE가 같은 값을 본다.

### 6.10 재시도 계약 — 세 층을 구분한다

초안은 "`failed`면 다시 시도가 뜨고 누르면 그 서비스를 재시작한다"고 적었다. **그것으로는
job이 되살아나지 않는다** — `supervisor.ts:490`의 `needsRetry`는
`rt.status.process !== "running" || rt.result === null`이라 살아 있는 worker를 건너뛰고,
설령 재시작해도 `db/queue.py`의 `claim()`은 `queued`만 가져오므로 이미 `failed`가 된 job은
다시 집히지 않는다.

| 층 | 무엇이 실패했나 | 무엇을 한다 | 누가 |
| --- | --- | --- | --- |
| 1. 모델 재다운로드 | 다운로드만 실패, 서비스는 살아 있다 | worker가 **job 실패 없이** 그 자리에서 재시도한다 — TRANSIENT 분류로 job이 `queued`로 돌아가 다음 차례에 다시 받는다 | worker |
| 2. 서비스 재시작 | 서비스가 죽었거나 설정이 바뀌었다 (토큰 교체 포함) | 그 서비스만 내리고 다시 띄운다. **`retry()`와 별도 경로** — 살아 있는 서비스도 대상이다 | 앱 |
| 3. job 재처리 | job이 이미 `failed`다 | **기존 도메인 재처리 경로**(`POST /meetings/:id/reprocess`)로 새 job을 넣는다 | 사용자 |

- 1층: HF 다운로드 실패를 `errors.py`에서 **TRANSIENT**로 분류한다(네트워크·타임아웃).
  **401·403은 PERMANENT다** — 재시도해도 안 된다.
- 2층: 상태 창의 "서비스 다시 시작" 버튼. 토큰을 바꾸면 이 버튼을 쓰라고 화면이 말한다.
  **채택한 외부 embed와 stand-down 상태의 worker에는 이 버튼을 비활성화한다** — 앱이 소유하지
  않은 프로세스를 내릴 수 없다.
- 3층: 화면이 "이 회의를 다시 처리하기"로 안내하고 기존 경로로 보낸다. 새 경로를 만들지 않는다.

**세 층을 화면에서 구분해 말한다.** "다시 시도" 하나로 뭉치면 사용자가 눌러도 아무 일도 안
일어나는 경우가 생긴다 — Phase 2가 stand-down worker에서 정확히 그 문제를 겪었다.

---

## 7. 사용자 동작

1. **첫 실행** — 앱 아이콘 → 토큰 화면. 조건 수락·토큰 발급 링크를 브라우저에서 처리하고
   토큰을 붙여 넣는다. 확인이 통과하면 서비스가 뜬다.
2. **첫 업로드** — 모델이 없으므로 받는다. 상태 창과 FE에 진행이 보인다. 다 받으면 전사·
   화자 분리·요약이 이어진다.
3. **첫 검색** — embed가 bge-m3를 받는다. 그 전에는 키워드 검색만 되고 화면이 이유를 말한다.
4. **두 번째 실행** — 모델을 다시 받지 않는다. 네트워크가 없어도 처리가 된다.
5. **토큰 교체** — 상태 창 → 설정 → 토큰 수정 → "서비스 다시 시작".
6. **다운로드가 끊겼다** — 화면이 원인을 말한다. 네트워크가 돌아오면 다음 job이 이어받는다.
   이미 실패한 회의는 "다시 처리하기".
7. **앱 강제 종료 뒤 재실행** — 남은 고아를 앱이 조용히 정리하고 뜬다.

---

## 8. 실패·복구 동작

`desktop/src/diagnostics/causes.ts`의 `CAUSES`에 얹는다.

| 원인 | 화면 |
| --- | --- |
| `Resources/python`·`Resources/ffmpeg` 없음 | dev: 빌드 스크립트 안내. packaged: 재설치 안내 |
| 번들 python이 실행되지 않음 (`bad interpreter`·서명 거부) | 번들 손상. 로그 경로 + 재설치 |
| `mlx_lm.server` import 실패 | 번들 손상으로 분류 (빌드 8단계가 막지만 이중으로) |
| `safeStorage` 사용 불가 | Keychain 잠금 해제 안내. 서비스를 띄우지 않는다 |
| 토큰 없음 | 토큰 화면 (실패 화면이 아니라 온보딩) |
| 토큰 무효 (401) | "토큰이 유효하지 않아요" + 재입력 |
| 토큰 검증 불가 (네트워크) | "지금은 확인할 수 없어요" — 무효와 구분 |
| 모델 다운로드 403 | **"이 모델은 사용 조건 수락이 필요해요"** + 그 모델의 수락 페이지 링크 |
| 모델 다운로드 네트워크 실패 | 사유 + §6.10의 층별 안내 |
| 다운로드 무진행 120초 초과 | "진행이 멈췄어요" + 서비스 다시 시작 |
| 고아 스캔 실패 | 원인 + "다시 시도". **서비스를 띄우지 않는다** |
| 디스크 부족 | 남은 용량과 필요한 용량 |

**pyannote 오류 분류를 고친다.** `models/pyannote_diar.py:16-22`는 토큰 문제와 조건 미수락을
합쳐 일반 `RuntimeError`로 만들고, `errors.py:62-74`가 그것을 TRANSIENT로 처리한다.
HF의 401/403을 보존해 §6.10의 PERMANENT 분류와 위 화면 구분이 성립하게 한다.

**삭제되는 원인:** `uvMissing`, `workerEnvMissing`. `repoRootMissing`은 dev 전용이 된다.

Phase 2·3의 나머지 규칙은 유지한다 — manual 실패는 자동 재시도하지 않고, auto 실패는
`[3s, 8s, 20s]` 3회.

---

## 9. 완료 기준

### 축 A — 온보딩과 토큰

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C1 | 토큰 없는 첫 실행에 토큰 화면이 뜨고 건너뛸 수 없다 | 토큰 파일을 지우고 Finder 실행. 진행 시도 → 막힘 |
| P4-C2 | 토큰 평문이 디스크에 없다 | `hf-token.bin`이 바이너리. `grep -r <토큰>`이 userData 전체·로그에서 0건 |
| P4-C3 | 오타·무효 토큰은 저장 전에 거절된다 | 잘못된 토큰 → 화면에 사유. 파일 안 생김 |
| P4-C4 | 토큰을 바꾸고 "서비스 다시 시작"하면 새 값으로 동작한다 | **조건 미수락 계정 토큰 → 화자 분리 403 → 수락 계정 토큰으로 교체 → 재시작 → 성공.** 캐시는 그 모델만 비운 상태 |

### 축 B — 실사용 동작

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C5 | 모델 0개 상태에서 업로드 → 전사·화자 분리·요약·검색 전부 성공 | `<userData>/models` 비우고 실오디오 1건 완주. 네 결과가 DB에 |
| P4-C6 | 다운로드 진행이 화면에 보인다 | 상태 창·FE에 `downloading`과 진행. `model_readiness` 행 확인 |
| P4-C7 | 다운로드를 끊으면 원인이 뜨고, 회복 뒤 이어받는다 | 다운로드 중 네트워크 차단 → 화면에 사유 → 복구 → 다음 job이 **처음부터가 아니라** 이어받음 |
| P4-C8 | 게이트 미수락 403과 토큰 무효 401을 다른 안내로 구별한다 | 수락 안 한 계정의 유효 토큰 → 수락 페이지 링크. 무효 토큰 → 재입력 안내 |
| P4-C9 | 두 번째 실행은 모델을 다시 받지 않는다 | `models/` 크기·mtime 불변, 처리 성공. **HF 도메인으로 나가는 요청 0** (로컬 통신은 제외) |
| P4-C10 | bge-m3를 한 벌만 받는다 | `models/hub/models--BAAI--bge-m3`의 리비전 1개, `pytorch_model.bin` 부재 |
| P4-C11 | 요약·렌즈가 **번들** mlx-lm으로 돈다 | `~/.local/bin/mlx_lm.server`를 일시 격리한 상태에서 요약 job 성공. `ps -o args`가 번들 python `-m mlx_lm.server` |

### 축 C — 격리

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C12 | 앱의 모든 Python 프로세스가 번들 런타임을 쓴다 | worker·embed·`--once`·capabilities 프로브의 `sys.executable`·`sys.prefix`를 `supervisor.log`에 자기 보고. 전부 번들 트리 아래. **`sys.path`는 "site-packages가 번들 아래" + "packaged에 저장소 경로 0건"으로 판정한다** (cwd·dev `PYTHONPATH`는 정상 항목이다) |
| P4-C13 | 번들 밖 런타임·도구를 참조하지 않는다 | (a) 자식 PATH에 개발 도구 경로 0건(§6.2, 구조적 증명). (b) 처리 전 구간 `lsof -p`에 `/opt/homebrew`·`.venv`·`~/.local`·`/Library/Frameworks/Python.framework` 0건. (c) 처리 중 `ps -axo args` 주기 샘플링으로 **모든 자식 실행 경로**가 번들 아래 |
| P4-C14 | 모델·캐시가 `.app` 밖이고 `.app`을 교체해도 재사용된다 | `.app` 지우고 다시 빌드·설치 → 모델 재다운로드 0 |
| P4-C15 | `.app`에 arm64 무서명 Mach-O 0건, 개발 머신 경로 문자열 0건, entitlement 적용 | `check-bundle.mjs` — `codesign --verify --arch arm64` 전수, `codesign -d --entitlements -`, 금지 문자열 스캔 |
| P4-C16 | packaged가 저장소 체크아웃 없이 뜬다 | 저장소를 임시로 옮긴 뒤 `.app` 실행. 폴더 선택창이 뜨지 않고 정상 기동 |

### 축 D — 수명주기

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C17 | ⌘Q 뒤 앱이 만든 프로세스가 하나도 안 남는다 | `mlx_lm.server`가 뜬 렌즈 job 중 ⌘Q → `ps`에 번들 python 프로세스 0건 (run-id 없는 capabilities 프로브 포함) |
| P4-C18 | 앱 강제 종료 뒤 남은 고아를 다음 실행이 정리한다 | `kill -9` main → 고아 확인(worker·`--once`·`mlx_lm.server`) → 재실행 → 옛 run-id 전부 사라짐 |
| P4-C19 | **부모가 먼저 죽어도** 자손이 회수된다 | worker supervisor만 `kill -9` → `--once` 자식과 LLM 서버가 남음 → 앱 종료 → 전부 사라짐 |
| P4-C20 | 자손 SIGKILL 단계가 실제로 발화한다 | SIGTERM을 무시하는 자식으로 유예 초과 유도. Phase 2가 못 밟은 경로 |
| P4-C21 | 외부 `pnpm worker`는 앱이 손대지 않고 종료 뒤에도 산다 | Phase 2 P2-C6 재실행. `.venv` python이라 §6.5의 조건 3에서 빠진다 |
| P4-C22 | 고아 스캔이 실패하면 서비스를 띄우지 않는다 | `ps`를 실패하게 주입. 단위 테스트 |

### 축 E — 회귀와 데이터 보존

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C23 | dev에서 worker 소스 수정이 재빌드 없이 반영된다 | `__main__.py`에 로그 한 줄 추가 → `pnpm desktop:dev` 재기동 → 그 줄이 나온다 |
| P4-C24 | 기존 웹 흐름에 회귀가 없다 | **앱 검증과 분리된 회차에서** — `pnpm build`·`test`·`lint` 통과, `pnpm worker`·`pnpm embed`가 `.venv`로 기동해 Docker DB의 job을 처리 |
| P4-C25 | `mlx` 버전 정렬이 STT·요약 출력을 깨지 않는다 | `uv.lock` 갱신 뒤 worker 테스트 전체 + 실오디오 1건 (§6.1) |
| P4-C26 | 절대 불변 목록이 바이트 단위로 불변이다 | §5의 5개 항목 체크섬이 기준선과 같다 |
| P4-C27 | 앱 데이터 영역의 기존 레코드·파일이 보존된다 | 검증 전 회의 ID·행 수·`data/storage` 파일 체크섬이 검증 뒤에도 전부 존재. 증가만 있고 소실·변경 0 |
| P4-C28 | numba 사망 지점이 측정되고 그 결과가 문서에 있다 | §6.8 A/B 결과와 조치가 결과 문서에 |

### 비고 — 단위 테스트로만 판정하는 것

- `safeStorage` 사용 불가 경로 (Keychain을 실제로 잠그기 어렵다).
- 복호화 실패 경로.
- 고아 스캔 실패(P4-C22), 다운로드 무진행 제한, 디스크 부족 안내 문구.
- `model_readiness`의 동시 writer 역전 방지.

---

## 10. 제품 코드 변경 목록

**desktop/**

| 파일 | 변경 |
| --- | --- |
| `scripts/build-python.sh`·`build-ffmpeg.sh` | 신규 |
| `scripts/python-checksums.txt`·`ffmpeg-checksums.txt` | 신규 |
| `scripts/package.mjs` | 두 스크립트 호출, 서명에 `--options runtime --entitlements` |
| `scripts/check-bundle.mjs` | Python·ffmpeg 트리·서명·entitlement·문자열 검사 |
| `build-resources/entitlements.mac.plist` | 신규 |
| `src/process/python-launcher.ts` | `uv-launcher.ts` 대체 |
| `src/process/executables.ts` | 자식 PATH에서 개발 도구 폴백 제거 |
| `src/process/runtime-paths.ts` | 신규 — `pgBinaries` 모양의 `pythonBinaries`·`ffmpegBinaries` |
| `src/process/orphans.ts` | 신규 — 4조건 스캔·회수 |
| `src/services/worker-discovery.ts` | `--run-id` 판독, 소유/외부/고아 셋 |
| `src/services/worker.ts`·`embed.ts` | `.env`·uv 검사 제거, `-m` 진입, `--run-id`, 채택 규칙 |
| `src/services/worker-shutdown.ts` | 부모 선종료 자손 회수 단계 |
| `src/services/supervisor.ts` | 다운로드 중 유예 계산, 서비스 재시작 경로 |
| `src/config/config.ts` | `UV_BIN` 제거, `HF_TOKEN` 앱 소유 키, env 위생 |
| `src/config/repo-root.ts`·`src/main.ts` | packaged의 저장소 게이트 제거 |
| `src/config/token-store.ts` | 신규 — `safeStorage` 읽기·쓰기 |
| `src/windows/token-window.ts` | 신규 — 온보딩 화면 |
| `src/windows/status-view.ts` | 모델 준비·토큰·재시작 항목 |
| `src/diagnostics/causes.ts` | §8의 원인 |

**be/worker/**

| 파일 | 변경 |
| --- | --- |
| `pyproject.toml`·`uv.lock` | **`mlx-lm`·`mlx` 명시 고정** |
| `damwha_worker/config.py` | `ffmpeg_bin`·`ffprobe_bin`, `lens_llm_server_bin` 기본값 |
| `damwha_worker/pipeline/ffmpeg.py` | 호출 시점 env 읽기 |
| `damwha_worker/embed_service.py` | `if __name__ == "__main__"` |
| `damwha_worker/__main__.py` | `--run-id` 수용·전파, 런타임 자기 보고 로그 |
| `damwha_worker/llm_server.py` | `-m mlx_lm.server` 진입, 오류 문구, `--run-id` 미전달 |
| `damwha_worker/models/pyannote_diar.py` | 401/403 보존 |
| `damwha_worker/models/bge_embed.py` | 리비전 고정·safetensors 단일 |
| `damwha_worker/models/downloads.py` | 신규 — HF 진행 훅 → `model_readiness` |
| `damwha_worker/errors.py` | 다운로드 실패 분류 (401/403 = PERMANENT) |
| `damwha_worker/db/core.py` | `model_readiness` 원자적 merge |

**be/** — `model_readiness` 읽기, 설정 조회 응답에 `modelReadiness`.
**fe/** — 모델 준비 표시. 최소 범위.

---

## 11. 빌드와 실행 흐름

```
pnpm desktop:dev
  build-postgres.sh (캐시) → build-python.sh (캐시 2층) → build-ffmpeg.sh (캐시)
  → tsc → electron .            [PYTHONPATH=<repo>/be/worker]

pnpm desktop:build
  build-postgres.sh → build-python.sh → build-ffmpeg.sh
  → be build → fe build → pnpm deploy → SPA 복사
  → electron-builder --dir
  → codesign (Resources 하위 Mach-O, 그다음 .app) --options runtime --entitlements
  → check-bundle.mjs
```

첫 `build-python.sh`는 1.5 GB를 만든다 — 다운로드·설치·서명까지 수십 분. worker 소스만
고치면 2층 캐시 덕에 패키지 설치와 그 파일 서명만 다시 돈다.

---

## 12. 미확정 사항

| 항목 | 언제 정해지나 |
| --- | --- |
| numba 사망 지점과 `allow-jit` 필요 여부 | **Task 1의 측정.** `allow-jit`으로도 죽으면 스펙 리뷰로 돌아간다 (§6.8) |
| `uv lock` 갱신이 해석하는 `mlx` 버전과 그 회귀 영향 | Task 2. P4-C25가 판정 |
| 자식 PATH에 `/usr/bin:/bin`이 필요한지 | 구현 중 실측 (§6.2) |
| `HF_HOME`으로 안 덮이는 라이브러리 캐시가 있는지 | 구현 중 실측, P4-C13이 판정 (§6.3) |
| `LENS_LLM_BASE_URL`의 포트 — 고정 vs 빈 포트 탐색 | 구현 중. embed의 `freePort()` 선례 |
| 모델 준비 FE 표시의 위치·형태 | 구현 중. `fe/DESIGN.md` 관례 |
| supervisor 크래시 재시작 시 같은 run-id `--once` 자식 처분 | 구현 중 (§6.5). 기본은 회수하지 않는다 |
| `.app` 최종 크기 | 빌드 뒤 실측. 예상 1.6~1.8 GB |

---

## 13. 기술 위험

| ID | 위험 | 막는 것 |
| --- | --- | --- |
| R4-1 | 번들을 옮기면 조용히 다른 런타임을 실행한다 (Phase 0 R-6) | 모든 진입이 `-m` (셔뱅 미경유) + 빌드 셔뱅 재배치 + P4-C12 자기 보고 |
| R4-2 | 무서명 `.so` 하나가 남아 특정 모델에서만 죽는다 | 빌드 전수 서명 + `--arch arm64` 전수 검사 (P4-C15) |
| R4-3 | numba가 메시지 없이 SIGKILL한다 | §6.8 측정을 Task 1에. 해소 불가면 스펙 리뷰로 |
| R4-4 | **번들에 `mlx-lm`이 없어 요약·렌즈가 죽는다** | 매니페스트 편입 + 빌드 8단계 import 확인 + P4-C11(전역 설치 격리 후 검증) |
| R4-5 | PATH 폴백이 남아 Homebrew 도구가 조용히 쓰인다 | 폴백 제거(§6.2)로 구조적 차단 + P4-C13 3중 판정 |
| R4-6 | 고아 정리가 남의 프로세스를 죽인다 | 4조건 전부 + 신호 직전 pid 재확인 + 스캔 실패 시 기동 중단 |
| R4-7 | `model_readiness`를 여러 writer가 덮어쓴다 | 원자적 merge + `updated_at` 역전 방지 (§6.9) |
| R4-8 | 토큰이 로그·화면에 샌다 | 마스킹 + P4-C2 전수 grep |
| R4-9 | 빌드 캐시가 옛 worker 코드를 싣는다 | 캐시 2층, worker 층 키에 소스 트리 해시 (§6.1). Phase 2 `24f9080`의 재발 방지 |
| R4-10 | `.env` 검사를 지우면서 필수 env를 빠뜨린다 | §6.3 표. 기본값 없는 키는 `DATABASE_URL`(Phase 3이 주입)과 `LENS_LLM_BASE_URL`(이 Phase) 둘 |
| R4-11 | `mlx` 버전 정렬이 STT 출력을 바꾼다 | P4-C25 — 테스트 전체 + 실오디오 1건 |
| R4-12 | 다운로드가 준비 유예를 넘겨 서비스가 재시작을 반복한다 | 진행 중에는 유예를 소모하지 않고 무진행 120초로 판정 (§6.9) |
| R4-13 | "다시 시도"를 눌러도 아무 일도 안 일어난다 | §6.10의 3층 분리와 화면 문구. stand-down·채택 서비스는 버튼 비활성 |
| R4-14 | dev `PYTHONPATH`가 packaged로 샌다 | §6.3에서 packaged 상속 제거 + P4-C12의 저장소 경로 0건 |

---

## 14. 로드맵 완료 기준과의 대응

| 로드맵 기준 | 이 스펙의 기준 |
| --- | --- |
| 개발 도구가 없는 지원 대상 맥에서 모델 준비 후 전사·화자 분리·요약·검색 성공 | P4-C5, C6, C7, C8, C11, C16 |
| 앱 번들 외부의 개발용 가상환경이나 도구를 참조하지 않음 | P4-C12, C13, C15, C16, C21 |
| 모델과 캐시가 앱 패키지 외부에 저장되어 재실행 시 재사용됨 | P4-C9, C10, C14 |

로드맵 범위의 "모델 이용 동의·토큰 설정과 초기 준비 상태 안내"는 축 A 전체와 P4-C6·C8이 받는다.

**"번들 외부 미참조"를 조건부로 남기지 않는다.** Phase 0이 넘긴 실동작 폴백 3건의 미사용
증명은 Phase 6으로 미루지만, 그것은 **제3자 wheel 내부의 문자열**에 대한 증명이고, 이 Phase는
**자식 PATH에서 개발 도구를 아예 빼** 실행 경로 쪽 증명을 구조적으로 세운다(§6.2). 둘은 다른
증명이며, 후자만으로 로드맵 기준 2를 충족으로 적는다. 깨끗한 다른 맥에서의 실제 독립 설치
검증은 로드맵이 Phase 6에 두고 있다.

---

## 15. 후속 Phase에 넘기는 것

**Phase 5**
- 기존 데이터 이전 — Docker DB·`be/storage`·`~/.cache/huggingface`의 기존 모델을
  `<userData>/models`로 옮길지 결정.
- 잠자기·복귀, 디스크 부족 중 모델 다운로드·처리 동작.
- 중단된 다운로드의 부분 파일 위생 (HF hub의 `.incomplete`).
- `<userData>/storage/` (Phase 1·2 잔재) 처분.

**Phase 6**
- G1 허용 목록 24건 재검토와 실동작 폴백 3건 미사용 증명 — P0-C7의 조건부 충족을 닫는다.
- `Resources/python`·`Resources/ffmpeg`의 Developer ID 서명·공증. 1.5 GB 트리의 공증
  시간이 여기서 처음 드러난다.
- R-12 (Team ID 기반 library validation) — ad-hoc 서명에서는 재현 불가.
- 앱 업데이트 시 두 런타임 버전 공존 — Phase 0 R-6이 실제로 나타나는 조건.
- 소스 아카이브 서명 검증과 재현 가능 빌드.
- **job lease token** — supervisor 크래시 재시작 시 같은 run-id `--once` 자식 문제(§6.5)의
  근본 해소.

---

## 16. 산출물

- 이 스펙.
- 구현 계획 `docs/superpowers/plans/2026-09-16-electron-phase-4-embedded-python-runtime.md`.
- 결과 문서 `docs/superpowers/reports/2026-09-16-electron-phase-4-embedded-python-runtime-results.md`.
- 제품 코드 (§10).
- 로드맵·`desktop/CLAUDE.md`·`be/worker` 문서 갱신.

---

## 17. 외부 리뷰 기록

### 17.1 Codex CLI — 1회차 (대상: 커밋 `24f4445`)

지적 18건 (blocking 10 · important 7 · minor 1). 메인 세션이 저장소 코드로 전부 검증했다.

**수용 16건.**

| # | 지적 | 검증 | 반영 |
| --- | --- | --- | --- |
| 1 | 고아 판정이 소유권을 증명하지 않는다 | `worker-discovery.ts:51-56`이 이미 3조건을 요구한다 | §6.5 — 4조건 + pid 재확인 + 스캔 실패 시 기동 중단 |
| 2 | 설치 절차에 `mlx-lm`이 없다 | **맞고 더 나쁘다** — pyproject·uv.lock·`.venv` 전부 없고 uv tool 전역 설치에 기대고 있다 | §2.4 신설, §6.1 매니페스트 편입, P4-C11, R4-4 |
| 3 | LLM 실행이 셔뱅에 의존하고 `--run-id`를 못 받는다 | `llm_server.py:92,103` — `shutil.which` + 콘솔 스크립트 + upstream CLI | §6.2 — `-m mlx_lm.server`. run-id는 자손 트리로 판정 |
| 4 | packaged 저장소 게이트 제거가 빠졌다 | `main.ts:986`·`repo-root.ts:9` (주석이 "Phase 4가 지운다"고 적혀 있다) | §4.1-7, §6.3, P4-C16 |
| 5 | `partial` 주입이 테스트 monkeypatch를 깬다 | `process_meeting.py:53`이 호출 시점에 `ffmpeg.normalize`를 해석한다. def-time partial은 monkeypatch 무력화, call-time partial은 `TypeError` | §6.6 — **env 호출 시점 읽기로 전면 교체.** 시그니처·호출부·테스트 무변경 |
| 6 | 서비스 재시작만으로 job이 재개되지 않는다 | `supervisor.ts:490` `needsRetry`, `db/queue.py` `claim()`이 `queued`만 | §6.10 신설 — 3층 분리 |
| 7 | 부모 선종료 자손이 회수되지 않는다 | `__main__.py:268-287` — 2회차 신호에 `proc.kill()` + `os._exit(1)`, 자식은 `start_new_session=True` | §6.5 종료 3단계, P4-C19 |
| 8 | 데이터 불변 기준이 처리 검증과 충돌한다 | 맞다. `data/`에 PGDATA와 업로드 저장소가 있다 | §5 — 절대 불변/쓰기 영역 분리, P4-C26·C27, 웹 회귀는 별도 회차 |
| 9 | lsof 스냅숏으로 외부 미참조를 확정할 수 없다 | 공정하다 | §6.2 — **PATH 폴백 제거**로 구조적 증명. P4-C13 3중 판정. §14에 근거 명시 |
| 10 | word-timestamp를 끄면 전사가 빈다 | `whisper_mlx.py:107-123`이 `segment["words"]`만 쓴다 | §6.8 — fallback 삭제, 스펙 리뷰 복귀로 |
| 11 | 캐시 키에 의존성·소스가 없다 | 맞다. Phase 2 `24f9080`의 재발 형태 | §6.1 — 캐시 2층, R4-9 |
| 12 | cwd `.env`·env 상속 위생이 없다 | `config.py:9`, `uv-launcher.ts:51-55` | §6.3 env 위생 표, §6.2 cwd `.env` 경고 |
| 13 | merge 규칙 부족 + **기동 순서 설명이 틀렸다** | `specs.ts:36-42` `postgres → api → embed → worker`, gate가 순서를 건다 | §6.9 — DB 특례 삭제(불필요해졌다), 원자적 merge + 역전 방지 |
| 14 | LLM·pyannote 오류 분류가 연결되지 않는다 | `llm_server.py:103-150`, `pyannote_diar.py:16-22`, `errors.py:62-74` | §8 pyannote 401/403 보존, §6.10 PERMANENT 분류 |
| 15 | 다운로드와 준비 시간 제한이 충돌한다 | `embed.ts:47` 180초 vs bge-m3 2.2GB | §6.9 — 진행 중 유예 미소모 + 무진행 120초 |
| 16 | entitlement 생성과 서명 적용이 연결되지 않는다 | `package.mjs:82` = `--force --deep --sign -`. 옵션 없음 | §6.1 서명 명령, P4-C15 |
| 17 | 완료 기준 관찰 대상·합격 조건 | 대부분 맞다 | 축 전체 재작성. C12의 `sys.path` 조건, C9의 "네트워크 0", C10의 "절반 수준"을 판정 가능하게 고침 |
| 18 | 필수 env 설명·참조 번호 오류 | 맞다 | §6.3에 `DATABASE_URL` 명시, 본문 ID 참조 전면 정정 |

**부분 반박 2건.**

- **#1의 "앱 소유 실행 기록(pidfile 류)이 필요하다"** — 채택하지 않는다. run-id는 UUID라
  값 충돌 확률이 실질 0이고, 실제 오탐원은 `--run-id=` 문자열을 인자로 가진 **셸 줄**인데
  기존 `isWorkerSupervisor`의 argv[0]·토큰 쌍 조건이 그것을 이미 막는다. 거기에 "번들 트리
  아래 python"을 더한 4조건으로 충분하다. PG의 pidfile은 **데이터 디렉터리 소유권** 때문이지
  프로세스 판정 때문이 아니다 — 같은 기구를 여기 가져올 근거가 없다.
- **#9의 "`env -i`·HOME 격리를 검증 계약에 포함하라"** — 채택하지 않는다. Finder로 띄우는
  `.app`에는 `env -i`를 적용할 수 없고(Phase 0의 격리는 셸에서 부른 하네스라 가능했다),
  그 대신 **자식 PATH에서 개발 도구를 빼는** 쪽이 더 강한 증명이다. 격리 환경을 흉내 내는
  대신 참조 경로 자체를 없앤다.

### 17.2 메인 세션 리뷰

(작성 예정.)
