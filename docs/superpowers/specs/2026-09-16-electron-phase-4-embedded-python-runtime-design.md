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
| `be/worker/damwha_worker/llm_server.py:92,103` | `shutil.which` + 콘솔 스크립트 실행 | `[sys.executable, "-m", "damwha_worker.llm_entry", "--run-id=…", …]` |
| `be/worker/damwha_worker/llm_entry.py` | — | **신규** — run-id를 argv에 남기고 같은 프로세스에서 `mlx_lm.server.main()`을 부른다 |
| `be/worker/damwha_worker/embed_service.py:10-11` | 모듈 수준 `load_settings()`·`build_text_embedder()` | 지연 초기화. import만으로 설정을 요구하거나 모델을 받지 않게 한다 |
| `desktop/src/services/api.ts:172` | `ctx.repoRoot`를 `path.join`에 넣는다 | `repoRoot`가 nullable이 되므로 packaged/dev 분기를 타입으로 나눈다 |
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
17. **`embed_service`의 import 부작용 제거** — 지금 모듈 수준에서 `load_settings()`와
    `build_text_embedder()`를 실행해(`:10-11`) import만으로 `DATABASE_URL`을 요구하고
    bge-m3를 받는다. 빌드의 진입점 확인이 모델을 내려받는 것을 막고, "import는 안전하다"를
    성립시킨다.
18. **외부 DB 디버그 모드의 공유 행 writer 차단** (`DAMWHA_SHARED_STATE`).
19. **`api.ts`·마이그레이션 러너의 `repoRoot` nullable 전파** — §6.3이 packaged를 null로
    만들면서 생기는 타입 변경.

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

1. `be/worker/.env`, `be/.env`, `fe/.env`
2. `~/.cache/huggingface` — 기존 개발 모델 캐시
3. Docker 볼륨 `damwha_pgdata`, `be/storage`
4. `<userData>/storage/` — Phase 1·2가 Docker DB와 쓰던 폴더 (Phase 5가 옮긴다)

**허용 변경 (이 Phase의 명시적 산출물. 절차와 복구를 여기 적는다):**

초안은 `be/worker/.venv`와 `~/.local/*`를 절대 불변에 넣었는데, 이 Phase는 **그 둘을
반드시 건드린다** — `mlx-lm`을 매니페스트에 넣으면 `.venv`를 그 잠금에 맞춰야 하고(§2.4),
"번들 mlx-lm이 쓰이는가"는 전역 설치를 치워 봐야 증명된다. 규칙과 사실이 어긋난 채로
두지 않는다.

| 대상 | 변경 | 기준선 | 복구 |
| --- | --- | --- | --- |
| `be/worker/.venv` | `uv sync --extra models`로 새 `uv.lock`에 맞춘다 | **변경 전에** 버전 목록(`importlib.metadata`)과 `uv.lock` 사본을 뜬다 | 옛 `uv.lock`으로 `uv sync` 재실행 |
| `~/.local/bin/mlx_lm.server` | 검증 중 **일시 이동**(`mv`) 후 원위치 | `ls -la ~/.local/bin` | 같은 경로로 되돌린다. 검증 단계가 끝나면 즉시 |
| `~/.local/share/uv/tools` | 건드리지 않는다 | — | — |

**기준선은 첫 Task보다 먼저 뜬다.** 검증 단계(Task 20)에서 뜨면 그 앞의 변경을 못 잡는다.

`be/worker/.venv`는 재생성 가능한 파생물이라 이 취급이 정당하다 — `.env`(사람이 적은 값)나
`~/.cache/huggingface`(수십 GB의 다운로드)와 성질이 다르다.

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
| 런타임 | Python 버전 + `checksums.txt` + **`pyproject.toml`·`uv.lock` 해시** + `entitlements.plist` + 스크립트 shasum | 인터프리터 + 의존성 + 재배치 + 서명. **`BUILD_PREFIX`가 없다** — Python은 소스 빌드가 아니라 아카이브 전개라 우리가 정한 prefix가 트리에 없다 |
| worker | 위 키 + **`be/worker/damwha_worker/` 트리 해시** | `damwha_worker` 패키지 설치 |

worker 층은 런타임 층을 복사한 뒤 패키지만 덮어 설치하고 그 파일만 다시 서명한다.

**`build-python.sh`의 단계:**

1. python-build-standalone 3.12.11 내려받기·검증(`python-checksums.txt`)·전개.
2. `uv pip install --python <트리>` — `be/worker/pyproject.toml`의 기본 의존성 +
   `[project.optional-dependencies] models`. **`uv.lock`을 입력으로 쓴다** (`uv export`로
   고정 목록을 뽑아 넘긴다). 스크립트는 버전을 스스로 적지 않는다.
3. `uv pip install --python <트리> --no-deps <repo>/be/worker` — `damwha_worker` 패키지.
   `--no-deps`인 이유: 2단계가 이미 전부 깔았고, 여기서 해석이 다시 돌면 고정이 흔들린다.
4. **재배치** — §6.1-b가 넷을 정의한다. **매 빌드 반복한다.**
5. **Mach-O 처리** — 번들 밖 `LC_RPATH` 삭제(Phase 0 실측 58건), `LC_ID_DYLIB` 정규화(64건).
6. **arm64 전수 서명.** 무서명만이 아니라 전수다 — `install_name_tool`이 서명을 무효로 만들고,
   무엇을 고쳤는지 추적하는 것보다 전수가 싸고 안전하다.
7. **자기 검사** — `codesign --verify --arch arm64`로 0건. `--arch` 없이 부르지 않는다
   (universal 파일의 x86_64 슬라이스 하나 때문에 파일 전체가 `not signed at all`로 보고된다).
8. **진입점 확인** — `importlib.util.find_spec`으로 `damwha_worker`·`embed_service`·`llm_entry`·
   `mlx_lm.server`를 **찾는다.** `import`하지 않는다 — 부작용이 있는 모듈이 있으면 빌드가
   설정을 요구하거나 모델을 받는다. §2.4의 결함이 다시 나면 여기서 잡힌다.
9. **`__pycache__` 삭제.** 8단계가 만든 것까지 지운다 (§6.1-b 4번).
10. **스테이징** — 여기서부터 python을 실행하지 않는다.

### 6.1-b 재배치 — "최종 위치가 둘"이 이 절 전체를 정한다

Phase 0의 `build.sh`는 **한 최종 위치에서 relocate를 한 번** 하는 전제로 쓰였다. Phase 4는
그 전제가 성립하지 않는다 — 한 빌드 산출물이 **dev `desktop/build/python`과 packaged
`Resources/python` 두 자리**에 놓이고, electron-builder가 복사하는 지점에는 훅을 걸 수 없다.
게다가 그 사이에 캐시 2층(`rt-*` → `wk-*`)을 거치므로 **빌드 도중의 트리 경로는 전부
`<저장소>/desktop/.cache/…`**다.

그래서 규칙이 하나다 — **번들 안에 어떤 절대 경로도 굽지 않는다.** 위치는 런타임이 자기
자리에서 계산한다(`sys.prefix`·`sys.executable`이 그렇게 동작한다).

| # | 대상 | 조작 | 왜 |
| --- | --- | --- | --- |
| 1 | `bin/` 콘솔 스크립트 셔뱅 | **위치 독립 형태**(`${0%/*}`, 외부 명령 없음) | 절대 경로를 쓰면 두 자리를 못 덮고 `.app`에 dev 경로가 실린다 |
| 2 | `_sysconfigdata*.py`의 prefix | **중립 자리표시자** `/damwha-bundled-python`으로 고정 | uv가 설치 시점에 그것을 **캐시 임시 경로**로 다시 쓴다. 그 값에 저장소 경로가 들어 있어 금지 문자열 검사에 걸린다 |
| 3 | `direct_url.json` | 삭제 | 파일 경로 설치가 남기는 절대 경로 |
| 4 | `__pycache__` | **빌드의 마지막 python 실행 뒤에** 삭제 | `.pyc`가 `co_filename`으로 컴파일 시점 절대 경로를 담는다 |

**2번이 왜 중립 자리표시자인가.** 실제 경로를 넣을 수 없다(둘이다). 캐시 경로는 저장소를
담는다. PBS 원본값(`/install`)으로 되돌려도 되지만, **우리가 정한 문자열**이어야 의도된 값임이
드러나고 금지 문자열 검사의 예외로 올릴 근거가 된다.

무해한 이유: `sysconfig.get_config_var('prefix')`는 **C 확장을 빌드할 때** 헤더·라이브러리를
찾는 값이고 우리는 런타임에 아무것도 빌드하지 않는다. 모듈 해석은 `sys.prefix`가 하고 그것은
인터프리터가 자기 위치에서 계산한다. **그래서 P4-C12는 `sysconfig`가 아니라
`sys.prefix`·`sys.executable`로 판정한다** — Phase 0의 P0-C8이 `sysconfig`까지 본 것은 그쪽이
재배치 검증 자체를 목적으로 했기 때문이다.

**4번의 시점이 계약이다.** `relocate()` 안에서 지우면 그 뒤의 진입점 확인이 `.pyc`를 다시
만들고 그것이 그대로 실린다(실측 25개). 순서는 **모든 python 실행 → `__pycache__` 삭제 →
스테이징**이고, `check-bundle.mjs`가 `Resources/python` 아래 `__pycache__` **0개**를 확인한다.

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
<python>/bin/python3.12 -m damwha_worker.llm_entry    --run-id=<uuid> --model … --host … --port …
                                                                        (worker가 띄운다)
```

- **콘솔 스크립트를 부르지 않는다.** `bin/damwha-worker`·`bin/damwha-embed`·
  `bin/mlx_lm.server`는 셔뱅을 타고, Phase 0 R-6대로 옛 경로가 남아 있으면 죽지 않고
  **조용히 다른 런타임을 실행한다**. `-m`은 셔뱅을 타지 않는다. (셔뱅 재배치는 여전히
  빌드에서 한다 — 사람이 손으로 부를 수 있다.)
- `embed_service.py`에 `if __name__ == "__main__": main()`을 더한다. 기존
  `[project.scripts] damwha-embed` 진입점은 그대로 둔다 (`deploy/README.md`의
  `uv tool install` 경로가 쓴다).
- **LLM 서버는 `damwha_worker.llm_entry`라는 얇은 진입 모듈로 감싼다.** 지금은
  `shutil.which(settings.lens_llm_server_bin)`으로 찾은 **콘솔 스크립트**를
  `popen([binary, "--model", …])`로 실행한다(`llm_server.py:92,103`).

  `[sys.executable, "-m", "mlx_lm.server", …]`로 바꾸는 것만으로는 부족하다 — 그것은
  upstream CLI라 `--run-id`를 주면 모르는 인자로 죽고, 안 주면 **소유 표식이 없는
  프로세스**가 된다. 그 둘 사이에 앉을 자리가 필요하다.

  `llm_entry`가 하는 일은 셋뿐이다:
  1. `--run-id`를 **받아서 버린다** (앱이 `ps`로 읽는 것이 전부다).
  2. 나머지 인자로 `sys.argv`를 재구성한다.
  3. **같은 프로세스에서** `mlx_lm.server`의 `main()`을 부른다.

  얻는 것:
  - argv에 `-m damwha_worker.llm_entry --run-id=<uuid>`가 남아 §6.5의 4조건이 그대로 먹는다.
  - **중간 프로세스가 없다.** exec 래퍼나 부모-자식 구조로 하면 §6.2가 없앤 uv 구조가
    되살아난다.
  - 같은 프로세스라 **HF 다운로드 훅을 걸 수 있다** — `mlx_lm.server`가 별도 프로세스였다면
    LLM 모델의 다운로드 진행을 관측할 길이 없었다 (§6.9가 이 사실에 기댄다).

  대가: `mlx_lm.server.main()`의 진입 형태에 의존한다. 그 시그니처가 바뀌면 깨지는데,
  버전이 `uv.lock`에 고정돼 있고 §6.1의 빌드 8단계가 import를 확인하므로 **빌드에서 드러난다.**

- `LENS_LLM_SERVER_BIN` 설정은 **남기되 의미가 바뀐다** — 값이 있으면 그것을 실행 파일로
  그대로 실행하고(수동 운용·다른 백엔드), 없으면 위 모듈 진입이 기본이다.
  `lens_llm_server_bin`의 기본값을 `""`(=모듈 진입)로 내린다. **그 탈출구로 띄운 프로세스는
  앱이 소유를 증명할 수 없다** — 화면과 문서가 그 사실을 적는다.
- `llm_server.py:96`의 오류 문구도 고친다 — `uv tool install mlx-lm` 안내는 이제 틀렸다.
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

**금지 목록은 상속분이 아니라 최종 합성 env에 적용한다.** 이것이 초안의 구멍이었다 —
`process.env`만 씻고 `ctx.env`를 그 뒤에 합치면, `config.json`이 임의 문자열 키를 그대로
통과시키므로(`config.ts:299-300`) 사용자가 `PYTHONHOME`이나 `HF_HUB_CACHE`를 **다시 넣을 수
있다.** 씻는 순서를 뒤집는다:

```
child env = sanitize( { ...process.env, ...config.json 값, ...앱이 주장하는 값 } )
```

단 **앱이 주장하는 값은 금지 목록보다 뒤**다 — `HF_HOME`·`PYTHONPATH`(dev)는 앱이 의도적으로
넣는 것이라 씻겨 나가면 안 된다. 그래서 정확히는 "씻은 뒤 앱 값을 얹는다".

`config.json`이 금지 키를 담고 있으면 **버리고 경고한다** — 조용히 무시하면 사용자는 자기가
적은 값이 왜 안 먹는지 알 길이 없다 (`EXTRA_PATH`·`HOST`가 이미 그 규칙을 쓴다).

**앱이 못 덮는 캐시가 남는지는 구현 중 실측한다.** speechbrain(ECAPA)·silero는 라이브러리가
자체 경로를 쓸 수 있다(`models/ecapa_embed.py:27-29`가 위치를 라이브러리에 위임한다).
**P4-C13이 판정하고**, `HF_HOME`으로 안 덮이는 것이 나오면 그 라이브러리의 전용 변수를
위 표에 추가한다.

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

1. argv[0]이 **앱이 아는 번들 인터프리터 절대 경로**다 (`<번들>/bin/python3.12`).
2. `-m` 다음 토큰이 `damwha_worker`, `damwha_worker.embed_service`, `damwha_worker.llm_entry`
   중 하나다.
3. argv[0]의 절대 경로가 **번들 python 트리 아래**다. 저장소 `.venv`·Homebrew python이
   여기서 빠진다 (조건 1과 겹치지만, dev/packaged 두 트리를 다 받으므로 따로 둔다).
4. `--run-id=<uuid>` 토큰이 있다.

**판독 규칙 — 공백이 있는 경로를 견뎌야 한다.** `ps -axo pid,args`는 argv를 공백으로 이어
붙인 **평탄한 문자열**이라 다시 토큰으로 쪼갤 수 없다. `/Users/x/My Apps/Damwha.app/…`처럼
공백이 든 설치 경로는 흔하고, 단순 공백 분할은 argv[0]을 `/Users/x/My`로 잘라 **정상 프로세스를
판정에서 누락시킨다** — 고아 정리가 조용히 생략된다. (기존 `worker-discovery.ts:78-85`도 같은
한계를 갖는다. 이 Phase가 함께 고친다.)

그래서 **아는 접두사로 먼저 자른다**: 앱은 자기 번들 인터프리터 경로를 정확히 알고 있으므로,
`args`가 그 문자열로 시작하는지 보고 그 길이만큼 떼어 낸 나머지를 토큰으로 쪼갠다. dev와
packaged 두 경로를 다 시험한다.

**판독 실패를 "고아 없음"으로 처리하지 않는다** — `ps`가 실패했거나 출력이 잘렸으면
§아래의 "스캔이 실패하면" 규칙을 탄다.

**처분:**

| 판정 | 처분 |
| --- | --- |
| 4조건 만족 + run-id가 내 것 | 내 프로세스 |
| 4조건 만족 + run-id가 다른 값 | **이전 실행의 고아. 내린다** |
| 1·2만 만족 (번들 밖 python, run-id 없음) | 외부 `pnpm worker`. **손대지 않고 stand-down** |
| `damwha_worker.llm_entry` | 다른 셋과 **같은 규칙**이다 — §6.2의 진입 모듈 덕에 run-id를 갖는다. 부모 트리에 기대지 않는다 |
| `LENS_LLM_SERVER_BIN` 탈출구로 띄운 서버 | 표식이 없다. **앱이 소유를 증명할 수 없어 손대지 않는다.** 그 설정을 쓴 사람이 책임진다 — 화면과 문서가 그렇게 적는다 |

**신호 직전에 pid 정체성을 다시 확인한다.** 스캔과 신호 사이에 pid가 재사용될 수 있다.
`process-tree.ts`가 이미 갖춘 왕복을 쓴다.

**스캔이 실패하면 새 worker를 띄우지 않는다.** `ps`가 실패했는데 그대로 진행하면 고아와
새 프로세스가 같은 job을 집는다. 실패 화면에 원인과 "다시 시도"를 띄운다.

**정리는 서비스 기동 전에 한다.** 뒤에 하면 새로 띄운 것과 고아가 잠시 공존한다.

**embed 채택 규칙이 좁아진다.** `--run-id`가 있고 내 것이 아닌 embed는 채택 대상이 아니라
**고아**다 — 먼저 내리고 새로 띄운다. run-id 없는 외부 embed(터미널 `pnpm embed`)만 채택한다.
Phase 3 §5.2-2의 "고아 embed가 한 번은 채택되고 그 뒤에는 둘이 모델 메모리를 썼다"가 닫힌다.

**종료 절차 — 서비스 핸들과 독립인 마지막 단계를 둔다.**

Python supervisor는 **두 번째 SIGTERM에서 `--once` 자식을 `proc.kill()`하고 `os._exit(1)`한다**
(`__main__.py:268-287`). 자식은 `start_new_session=True`라 **별도 세션**이다. 즉 부모가 먼저
사라지면 자손 SIGKILL 단계는 훑을 트리를 잃는다.

문제는 그것만이 아니다. **감독자가 죽은 서비스의 `stop()`을 아예 부르지 않는다.**
`watchForDeath`가 `rt.result = null`로 만들고(`supervisor.ts:453`), `stopAll`은
`if (rt.result === null || !rt.result.owned) continue`로 건너뛴다(`supervisor.ts:536`).
그래서 **`stop()` 안에 무엇을 넣어도 이 경로에서는 실행되지 않는다.**

종료를 두 층으로 나눈다:

| 층 | 무엇 | 언제 |
| --- | --- | --- |
| A. 서비스별 `stop()` | SIGTERM → 유예 → 자손 SIGKILL | 감독자가 핸들을 쥐고 있을 때 |
| B. **앱 종료 회수** | §6.5의 4조건으로 `ps`를 훑어 **내 run-id를 가진 모든 프로세스**를 회수 | A가 전부 끝난 뒤, **핸들 유무와 무관하게 항상** |

B층이 이 Phase의 새 계약이다. 대상은 `damwha_worker`·`embed_service`·`llm_entry`·`--once`
전부이고, 판정 근거가 argv의 표식이라 **부모가 있든 없든, 감독자가 핸들을 쥐었든 잃었든
똑같이 동작한다.** 기동 시 고아 정리와 같은 코드를 쓰되 대상이 "내 run-id"인 점만 다르다.

B층이 무엇이든 회수했다면 그것은 A층이 놓쳤다는 뜻이므로 `supervisor.log`에 남긴다 —
조용히 덮으면 A층의 결함이 영영 안 보인다.

**supervisor가 실행 중 크래시해 재시작되면** 이전 `--once` 자식이 **같은 run-id를 갖는다** —
기동 시 정리로는 안 잡히고 B층은 종료 때만 돈다. 근본 해소는 job lease token(Phase 6)이고,
이 Phase는 **그 경계를 명시만 한다.** 재시작 시 같은 run-id의 `--once`를 회수하지 않는 것이
기본이다 — job을 처리 중인 자식을 죽이면 그 job이 `attempts`를 소모한다.

### 6.6 ffmpeg·모델 경로 계약

**ffmpeg 바이너리는 `ffmpeg.py`가 호출 시점에 env에서 읽는다.**

```python
def _bin(name: str) -> str:
    return os.environ.get(f"{name.upper()}_BIN") or name
```

`probe()`·`normalize()`가 `["ffprobe", …]` 대신 `[_bin("ffprobe"), …]`를 만든다.
`normalize` 안의 재귀 `probe(temp_path)` 호출(`ffmpeg.py:82`)도 **바이너리는** 자동으로
따라온다 — `_bin`을 그쪽에서도 다시 읽기 때문이다.

**그 재귀 호출에 `runner`를 넘기는 것은 별개 변경이고, 이 Phase의 범위가 아니다.**
넘기면 기존 테스트가 깨진다 — `tests/test_ffmpeg.py:49`·`:122`가
`monkeypatch.setattr(ffmpeg, "probe", lambda path: …)`로 **모듈 속성을** 갈아 끼우므로,
`probe(temp_path, runner=runner)`는 그 lambda에 `TypeError`를 낸다. 지금 그 재귀 호출이
모듈 기본 runner를 타는 것은 **의도된 기존 동작**이고(정규화 결과를 진짜 ffprobe로 검증한다),
이 Phase가 바꿀 이유가 없다. 바이너리 경로만 고치는 것이 이 절의 전부다.

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

**Part 1 Task 2에서 잰다.** §6.1의 최종 서명 조합(hardened runtime + 최소 entitlement)으로
서명한 번들 python에서, 각각 **별개 프로세스**로:

1. `import numba` 만.
2. `@njit` 함수 **정의**만.
3. 그 함수 **호출** (= 컴파일 발화).

크래시 리포트가 안 남으므로 **부모가 자식의 종료 신호를 읽어 판정한다.**

| 결과 | 조치 |
| --- | --- |
| **셋 다 산다** ← **이것이다 (2026-09-16 실측)** | entitlement 최소 집합 유지. 끝 |
| 어디선가 죽는다 | `allow-jit`을 더해 재측정 |
| `allow-jit`으로도 죽는다 | **스펙 리뷰로 돌아간다.** §9의 전사 기준을 충족할 수 없다 |

**실측 (2026-09-16).** python-build-standalone 3.12.11(`20250818`)에 잠금 버전
numba 0.65.1 · llvmlite 0.47.0 · numpy 2.4.6만 설치하고, Mach-O 42개를
`--options runtime --entitlements`로 전수 서명해 쟀다(`flags=0x10002(adhoc,runtime)` 확인).

| entitlement 집합 | 결과 |
| --- | --- |
| 서명 없음 (대조군) | 3/3 통과 |
| hardened runtime, 키 0개 | dyld가 `libpython3.12.dylib`을 거부 — rc=134 SIGABRT, `different Team IDs` |
| `disable-library-validation`만 | **`import numba`에서 rc=137 SIGKILL** |
| 최소 집합 (둘 다) | **3/3 통과** |

`allow-jit`은 필요 없다. **두 entitlement가 각각, 서로 다른 지점에서 load-bearing이다** —
`disable-library-validation`은 dyld 로드에서, `allow-unsigned-executable-memory`는
**`import numba`**에서. LLVM이 호출이 아니라 모듈 로드 시점에 실행 메모리를 잡는다. 대조군이
셋 다 통과했으므로 그 죽음은 설치 결함이 아니라 hardened runtime에 귀속된다.

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
- **외부 DB 디버그 모드에서는 이 행을 쓰지 않는다** (§5). 요구만 적고 전달 경로를 안 정하면
  구현되지 않으므로 여기서 정한다 — 앱이 `DAMWHA_SHARED_STATE=off`를 자식 env에 넣고,
  worker가 그 값일 때 **`model_readiness`와 `worker_capabilities` 두 writer를 모두** 건너뛴다.
  URL 모양으로 모드를 추정하지 않는다(worker는 자기가 어느 DB에 붙었는지 알 수 없다).
  기본은 `on`이라 웹 흐름(`pnpm worker`, 이 변수 없음)의 기존 보고 동작은 그대로다 —
  Phase 3이 남긴 "외부 DB 모드에서 worker가 capabilities 한 행을 쓴다"는 한계가 여기서 닫힌다.

**DB 준비 전 구간 특례는 없다.** 초안은 "embed가 postgres와 나란히 떠서 DB 전에 받는다"고
적었으나 **틀렸다.** 실제 기동은 `buildSpecs`의 `postgres → api → embed → worker`이고
(`services/specs.ts:36-42`), `runFrom`이 gate 서비스를 순서대로 통과시킨 뒤에야 비-gate
서비스를 배경으로 돌린다(`supervisor.ts:495-505`). postgres·api가 gate이므로
**embed가 시작될 때 DB는 이미 준비돼 있다.** 메모리 버퍼가 필요 없다.

**준비 시간 제한을 다운로드와 분리한다 — 단 두 곳에서 따로 한다.**

규칙은 하나다: **진행이 갱신되고 있으면 유예를 소모하지 않고, 무진행 120초면 실패로 본다.**
그러나 **적용 지점이 둘로 갈린다** — 초안은 "두 서비스가 같은 규칙을 쓴다"고 적었는데 그것은
거짓이다.

| 서비스 | 제한이 어디 있나 | 누가 고치나 |
| --- | --- | --- |
| embed | `embed.ts:47`의 `readyTimeoutMs` 180초. **감독자의 `awaitReady()`가 센다** | 감독자 |
| LLM | `config.py:53`의 `lens_llm_server_start_timeout_seconds` 600초. **Python `llm_server.py:_wait_ready`가 센다** | worker |

**감독자는 LLM을 볼 수 없다.** 그 서버는 이미 준비된 worker의 job 자식이 띄우고, 감독자의
`awaitReady()`는 서비스 기동 때만 돈다. 그래서 같은 규칙을 **두 자리에 각각** 넣는다:

- **감독자** — `model_readiness`에 그 서비스의 `downloading`이 있고 `updated_at`이 갱신되고
  있으면 유예 시계를 멈춘다. 고정 deadline이 아니라 **다운로드 시간을 뺀 누적**으로 센다.
- **`_wait_ready`** — 같은 판정을 Python 쪽에서 한다. **DB를 읽어야 한다.**
  `_wait_ready`(`llm_server.py:130`)는 **`--once` 자식**의 코드이고 `llm_entry`는 그것이
  `popen`한 **자식**이다 — 둘은 다른 프로세스다. §6.2가 말하는 "같은 프로세스"는
  `llm_entry`와 `mlx_lm.server.main()` 사이의 관계이지 `_wait_ready`와의 관계가 아니다.
  그래서 `llm_entry`가 `model_readiness`에 올린 `updated_at`을 `_wait_ready`가 주기적으로
  읽어 유예를 민다. `--once` 자식은 이미 DB 연결을 갖고 있으므로 그것을 `_wait_ready`에
  넘기는 시그니처 변경이 따른다.

**LLM 다운로드 진행의 관측 수단이 §6.2 결정에서 나온다.** `mlx_lm.server`를 그냥 실행했다면
그 프로세스 안의 HF 다운로드에 훅을 걸 수 없어 "시작·완료만 기록"이 최선이었고, 그러면 진행이
정상인 120초 동안에도 갱신이 없어 무진행으로 오판했다. `llm_entry`가 `main()`을 부르기 **전에**
훅을 설치하므로 다른 모델과 똑같이 바이트 진행을 올린다. `llm_entry`는 그 보고를 위해
**자기 DB 연결을 연다** — supervisor·`--once` 자식에 이은 세 번째 writer 프로세스다.

**훅 지점 (2026-09-16 실측으로 확정).** `huggingface_hub` **1.20.1**의
`snapshot_download`·`hf_hub_download`가 둘 다 `tqdm_class: type[base_tqdm] | None`을 받는다 —
클래스를 주면 hub가 인스턴스화해 `update(n)`을 부른다. 바이트 진행이 **가능하다.**

문제는 소비자 넷이 전부 **모듈 수준** `from huggingface_hub import …`이라는 것이다:

| 소비자 | 자리 |
| --- | --- |
| `mlx_whisper` | `load_models.py:8` |
| `sentence_transformers` | `util/file_io.py:7` |
| `pyannote.audio` | `pipelines/speaker_verification.py:32` **와** `utils/hf_hub.py:27` (두 곳) |
| `mlx_lm` | `utils.py:33` |

모듈 수준 import는 **import 시점에** 이름을 바인딩한다. 그래서 훅 설치가 두 갈래여야 한다:

1. **`huggingface_hub`의 원본을 먼저 바꾼다** — 아직 import되지 않은 소비자를 덮는다.
2. **`sys.modules`를 훑어 이미 import된 소비자의 모듈 속성도 바꾼다** — 1번만으로는 늦은 경우.

호출 순서가 계약이 된다: worker·embed·`llm_entry` 모두 **무거운 모듈을 import하기 전에**
훅을 설치한다. `llm_entry`는 `from mlx_lm.server import main` 앞이다.

**버전 취약성을 빌드가 막는다.** §6.1의 빌드 8단계가 두 함수에 `tqdm_class`가 있는지
assert한다 — 라이브러리가 그 인자를 없애면 `.app`이 아니라 빌드가 깨진다.

무진행 판정은 `bytes_done` 증가가 아니라 **`updated_at`** 기준이다 — `bytes_total`을 모르는
다운로드가 있고, 그럴 때 `bytes_done`만 보면 진행 중인 것을 멈춘 것으로 본다.

**어느 서비스의 다운로드인지 구별한다.** `entries`의 `writer`가 그 근거다. 다른 서비스가 받는
모델 때문에 이 서비스의 유예가 늘어나면 안 된다 — embed가 죽어 가는 동안 worker가 whisper를
받고 있으면 embed의 시계가 멈춘 채로 영영 안 죽는다.

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
| P4-C9 | 두 번째 실행은 모델을 다시 받지 않는다 | `models/` 크기·mtime 불변, 처리 성공, `model_readiness`에 새 `downloading` 0건. **판정은 이 셋이다** — huggingface.co로 나가는 패킷 0건은 라이브러리가 리비전 확인 요청을 보낼 수 있어 요구하지 않는다. 오프라인에서도 되는지는 별도로 본다 (P4-C29) |
| P4-C10 | bge-m3를 한 벌만 받는다 | `models/hub/models--BAAI--bge-m3`의 리비전 1개, `pytorch_model.bin` 부재 |
| P4-C29 | 모델을 받아 둔 뒤에는 네트워크 없이도 처리가 된다 | 캐시가 찬 상태에서 네트워크를 끊고 업로드 1건 완주 |
| P4-C11 | 요약·렌즈가 **번들** mlx-lm으로 돈다 | `~/.local/bin/mlx_lm.server`를 일시 격리한 상태에서 요약 job 성공. `ps -o args`가 번들 python `-m damwha_worker.llm_entry` |

### 축 C — 격리

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C12 | 앱의 모든 Python 프로세스가 번들 런타임을 쓴다 | worker·embed·`--once`·`llm_entry`·**capabilities 프로브**가 각자 `sys.executable`·`sys.prefix`를 로그에 자기 보고한다. 다섯 다 번들 트리 아래. **`sysconfig`는 보지 않는다** — §6.1-b가 그 값을 중립 자리표시자로 고정한다. capabilities 프로브는 `capabilities.py:68`의 `[sys.executable, "-c", …]`라 별도 프로세스이므로 `_PROBE_CODE`에 그 보고를 넣는다. embed는 uvicorn이 로깅을 잡기 전에 찍히지 않게 `install_logging` 뒤에 둔다. **`sys.path`는 "site-packages가 번들 아래" + "packaged에 저장소 경로 0건"으로 판정한다** (cwd·dev `PYTHONPATH`는 정상 항목이다) |
| P4-C13 | 번들 밖 런타임·도구를 참조하지 않는다 | (a) 자식 PATH에 개발 도구 경로 0건(§6.2, 구조적 증명). (b) 처리 전 구간 `lsof -p`에 `/opt/homebrew`·`.venv`·`~/.local`·`/Library/Frameworks/Python.framework` 0건. (c) 처리 중 `ps -axo args` 주기 샘플링으로 **모든 자식 실행 경로**가 번들 아래 |
| P4-C14 | 모델·캐시가 `.app` 밖이고 `.app`을 교체해도 재사용된다 | `.app` 지우고 다시 빌드·설치 → 모델 재다운로드 0 |
| P4-C15 | `.app`에 arm64 무서명 Mach-O 0건, 개발 머신 경로 문자열 0건, entitlement 적용, `Resources/python` 아래 `__pycache__` 0개 | `check-bundle.mjs` — `codesign --verify --arch arm64` 전수, `codesign -d --entitlements -`, 금지 문자열 스캔(**기존 4번 검사가 Resources 전체를 훑는다**), `find … -name __pycache__` |
| P4-C30 | `config.json`으로 금지 env를 다시 넣을 수 없다 | `config.json`에 `PYTHONHOME`·`HF_HUB_CACHE`를 적고 실행 → 자식 env에 없고 화면에 경고 |
| P4-C16 | packaged가 저장소 체크아웃 없이 뜬다 | 저장소를 임시로 옮긴 뒤 `.app` 실행. 폴더 선택창이 뜨지 않고 정상 기동 |

### 축 D — 수명주기

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C17 | ⌘Q 뒤 앱이 만든 프로세스가 하나도 안 남는다 | `mlx_lm.server`가 뜬 렌즈 job 중 ⌘Q → `ps`에 번들 python 프로세스 0건 (run-id 없는 capabilities 프로브 포함) |
| P4-C18 | 앱 강제 종료 뒤 남은 고아를 다음 실행이 정리한다 | `kill -9` main → 고아 확인(worker·`--once`·`mlx_lm.server`) → 재실행 → 옛 run-id 전부 사라짐 |
| P4-C19 | **부모가 먼저 죽어도** 자손이 회수된다 | (a) worker supervisor만 `kill -9` → `--once`와 `llm_entry`가 남음 → 앱 ⌘Q → 전부 사라짐. (b) supervisor와 `--once`를 **둘 다** `kill -9` → `llm_entry`만 남음 → ⌘Q → 사라짐. 둘 다 §6.5 B층이 회수하고 `supervisor.log`에 그 사실이 남는다. **감독자가 `rt.result=null`인 상태를 지나야 한다** — `watchForDeath` → `stopAll` 경로를 실제로 밟는 통합 테스트로 뒷받침한다 |
| P4-C20 | 자손 SIGKILL 단계가 실제로 발화한다 | `signal.signal(SIGTERM, SIG_IGN)` 뒤 대기하는 **전용 fixture 프로세스**를 worker 자손 자리에 띄워 유예를 넘긴다. Phase 2가 단위 테스트로만 갖고 있던 경로 |
| P4-C21 | 외부 `pnpm worker`는 앱이 손대지 않고 종료 뒤에도 산다 | Phase 2 P2-C6 재실행. `.venv` python이라 §6.5의 조건 3에서 빠진다 |
| P4-C22 | 고아 스캔이 실패하면 서비스를 띄우지 않는다 | 스캔 러너에 `ps` 비영(非零) 종료와 빈 출력을 각각 주입 → 기동 중단 + 화면에 원인. 단위 테스트 (실앱 발화 경로가 아니다) |

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
| `src/services/worker-shutdown.ts` | A층 정리 (핸들을 쥔 경우) |
| `src/main.ts`의 `stopServices()` | **B층 — 앱 종료 회수.** 핸들 유무와 무관하게 내 run-id를 전부 훑는다. `quit-flow.ts`가 아니다 — 거기에는 `stopAll`이 없고, `main.ts:1230`의 `.catch`가 받는 "`stopServices` 자체가 거부한" 경로를 놓친다 |
| `src/services/api.ts` | `repoRoot` nullable 전파 |
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
| `damwha_worker/llm_server.py` | `-m damwha_worker.llm_entry` 진입, 오류 문구, `_wait_ready`의 무진행 판정 |
| `damwha_worker/llm_entry.py` | 신규 — run-id 수용, HF 진행 훅, `mlx_lm.server.main()` 호출 |
| `damwha_worker/embed_service.py` | import 부작용 제거(지연 초기화), `__main__` 블록, 자기 보고 |
| `damwha_worker/capabilities.py` | `_PROBE_CODE`에 런타임 자기 보고 |
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
| ~~numba 사망 지점과 `allow-jit` 필요 여부~~ | **2026-09-16 실측으로 확정** — 최소 집합으로 셋 다 산다. `allow-jit` 불필요. 두 entitlement는 각각 dyld 로드와 `import numba`에서 필요하다 (§6.8) |
| `uv lock` 갱신이 해석하는 `mlx` 버전과 그 회귀 영향 | Part 1 Task 3. P4-C25가 판정. 현 `.venv`는 `mlx` 0.31.2이고 `mlx-lm`은 아예 없다(실측) |
| 자식 PATH에 `/usr/bin:/bin`이 필요한지 | 구현 중 실측 (§6.2) |
| `HF_HOME`으로 안 덮이는 라이브러리 캐시가 있는지 | 구현 중 실측, P4-C13이 판정 (§6.3) |
| `LENS_LLM_BASE_URL`의 포트 — 고정 vs 빈 포트 탐색 | 구현 중. embed의 `freePort()` 선례 |
| 모델 준비 FE 표시의 위치·형태 | 구현 중. `fe/DESIGN.md` 관례 |
| ~~HF 다운로드 진행 훅의 지점~~ | **2026-09-16 실측으로 확정** — `huggingface_hub 1.20.1`의 두 함수가 `tqdm_class`를 받는다. §6.9에 설치 규칙을 적었다 |
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
- 구현 계획 **둘** — `plans/2026-09-16-electron-phase-4-bundled-runtime.md`(빌드·번들)과
  `plans/2026-09-16-electron-phase-4-runtime-integration.md`(실행·앱·검증). 앞의 것이 끝나야
  뒤가 의미 있다.
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

### 17.2 Codex CLI — 2회차 (대상: 구현 계획 `9ef4b1c` + 이 스펙 `bcdca95`)

계획 검증에서 나온 지적 17건(blocking 10 · important 7) 중 **스펙을 고쳐야 하는 것 여섯**을
이 개정이 받는다. 나머지는 계획 개정이 받는다. 메인 세션이 전부 저장소 코드로 확인했다.

| 지적 | 확인 | 이 스펙의 반영 |
| --- | --- | --- |
| Task 2의 `pnpm worker:sync`가 §5의 `.venv` 절대 불변을 임의로 완화한다 | 맞다. 계획이 스펙에 없는 해석을 썼다 | §5 — **절대 불변/허용 변경 두 부류로 나눴다.** `.venv`와 `~/.local/bin/mlx_lm.server`를 허용 변경으로 옮기고 기준선·복구를 표로 적었다. 기준선은 **첫 Task보다 먼저** 뜬다 |
| `import damwha_worker.embed_service`가 설정을 요구하고 모델을 받는다 | 맞고 심각하다 — `embed_service.py:10-11`이 **모듈 수준**에서 `load_settings()`·`build_text_embedder()`를 부른다. 빌드 진입점 확인이 빌드 머신에 bge-m3 2.2GB를 받는다 | §4.1-17 — import 부작용 제거를 범위에 넣었다. §3 표에 대상 줄 추가 |
| `stopAll`이 죽은 서비스의 `stop()`을 안 부른다 | 맞다. `watchForDeath`가 `rt.result=null`(supervisor.ts:453), `stopAll`이 `continue`(:536) | §6.5 — **종료를 A층(서비스별 `stop()`)·B층(앱 종료 회수)으로 나눴다.** B층은 핸들 유무와 무관하게 항상 돌고 `quit-flow.ts`에 산다 |
| 부모와 `--once`가 둘 다 죽으면 LLM 소유를 증명할 수 없다 | 맞다. 초안 §6.2가 run-id를 안 붙이기로 하고 §6.5가 부모 트리에 기댔는데, supervisor는 2회차 신호에 `--once`를 SIGKILL한다 | §6.2 — **`damwha_worker.llm_entry` 얇은 진입 모듈.** 같은 프로세스에서 `mlx_lm.server.main()`을 부르므로 argv에 run-id가 남고 중간 프로세스가 없다. 부수 효과로 **LLM 다운로드 진행 관측이 가능해졌다**(§6.9) |
| 공백이 든 설치 경로를 단순 공백 분할이 못 견딘다 | 맞다. 기존 `worker-discovery.ts:78-85`도 같은 한계다 | §6.5 — **아는 접두사로 먼저 자르는** 판독 규칙. 판독 실패를 "고아 없음"으로 처리하지 않는다 |
| LLM 600초 제한은 감독자가 아니라 Python `_wait_ready`에 있다 | 맞다. 감독자의 `awaitReady()`는 서비스 기동 때만 돈다 | §6.9 — **적용 지점을 둘로 갈랐다.** 초안의 "두 서비스가 같은 규칙을 쓴다"는 거짓이었다. 서비스 구별을 위해 `writer`를 쓴다 |
| 외부 DB 모드 writer 차단의 전달 경로가 없다 | 맞다. 요구만 있었다 | §6.9 — `DAMWHA_SHARED_STATE=off`. 두 writer 모두. URL로 추정하지 않는다 |
| 재귀 `probe(temp_path, runner=runner)`가 기존 monkeypatch를 깬다 | 맞다. `test_ffmpeg.py:49`·`:122`가 `lambda path:`로 모듈 속성을 갈아 끼운다 | §6.6 — **그 변경을 범위에서 뺐다.** 바이너리 경로만 고친다 |
| `repoRoot` nullable이 `api.ts:172`에서 타입 오류를 낸다 | 맞다 | §4.1-19·§3·§10에 추가 |
| 완료 기준의 관찰 지점이 비었다 (C9·C12·C19·C20·C22) | 대부분 맞다 | 다섯 전부 다시 썼다. C19는 **두 경로**(부모만 죽음 / 부모와 `--once` 둘 다 죽음)로 쪼갰다. 새 기준 둘 추가 — C29(오프라인 처리), C30(`config.json` env 재주입 차단) |

**반박 2건에 대한 재판정.**

- **소유 판정 4조건으로 충분하다는 1회차 반박은 부분적으로 틀렸다.** 4조건 자체는 유효하지만
  "부모가 모두 사라진 자손의 소유를 무엇으로 증명하나"를 답하지 못했다. 해소는 pidfile이
  아니라 **표식을 가질 수 없던 프로세스에 표식을 주는 것**(`llm_entry`)이었다. 지적이 옳았고
  제안한 해법(소유 실행 기록)은 채택하지 않았다.
- **PATH 제한이 `env -i`를 대체한다는 반박은 그대로 유지하되 구멍을 막았다.** 지적대로
  `config.json`이 임의 키를 통과시켜 `ctx.env`로 재주입할 수 있었다 — §6.3의 금지 목록을
  **상속분이 아니라 최종 합성 env**에 적용하고, 금지 키가 파일에 있으면 버리고 경고한다.
  P4-C30이 이것을 판정한다.

**계획 개정이 받는 것** (스펙 변경 없음): 빌드 캐시 키의 경로 포함, 셔뱅 래퍼의 `dirname`
의존 제거, numba 프로브의 잠금 버전 사용과 plist 사본 생성, 테스트 예시의 실제 시그니처
(`managed_llm_server(model, settings, *, …)`·`stopWorkerProcess(handle, opts)`), `model_readiness`
merge의 동시성 테스트, 토큰 교체 후 live env 갱신 경로, Task 11–13의 중간 컴파일 실패 제거
(공존 후 삭제), 완료 기준별 구현·검증 연결표.

### 17.3 외부 리뷰 — 3회차 (대상: 스펙 `4180768` + 계획 `eb80de2`)

**판정: 확정 불가 — blocking 8건.** 리뷰어가 지시된 4건(셔뱅 래퍼·merge SQL·기준선 스크립트·
`ps` 판독)을 실제로 돌렸다. 메인 세션이 전부 저장소 코드로 재확인했고 **8건 모두 사실이었다.**

원인이 하나로 모인다 — **Task 3·4·5가 Phase 0의 실제 `build.sh`를 "옮긴다"고 적어 놓고 그
파일을 읽지 않고 재구성했다.** blocking 3건이 여기서 나왔다. 조치로 태그
`archive/electron-phase-0-packaging-validation`의 `experiments/electron-phase-0/python/build.sh`
(511줄)를 꺼내 그 조작을 그대로 옮겼다.

| 지적 | 확인 | 반영 |
| --- | --- | --- |
| ffmpeg LGPL 검사가 항상 실패한다 — configure가 `License:`를 `config.log`에 안 쓴다 | 리뷰어가 ffmpeg 7.1.1 configure를 받아 확인(`echo` 한 곳뿐). Phase 0의 `ffmpeg/fetch.sh:151-161`이 stdout을 파일로 받았다 | 계획 Task 3 — stdout을 `tee`로 받아 검사 + `config.mak`의 `CONFIG_GPL`/`NONFREE` 이중 확인 |
| `direct_url.json`이 저장소 절대 경로를 번들에 싣고 기존 번들 검사가 실패한다 | **실측** — `.venv`의 파일이 `{"url":"file:///Users/…/be/worker"}`. `check-bundle.mjs:90`이 `grep -rlF <repo> Contents`로 Resources 전체를 훑는다 | 계획 Task 4 `relocate()` 3절 — Phase 0 그대로 삭제 |
| `fix_macho`가 `BUILD_PREFIX`를 매칭하는데 그 문자열이 트리에 없다 | Phase 0 `build.sh:370-400` — 필터는 `@*`·번들 안·`/usr/lib`·`/System` **제외 전부**. 58건은 wheel 배포자 경로(`/opt/homebrew` gcc 등) | 계획 Task 4 — 필터 교체, `BUILD_PREFIX` 상수 삭제, **0건이면 `die`** |
| Task 8이 Task 17의 모듈을 import하고 경로도 틀렸다 | 계획 자체 | Task 8은 자리만 주석. **Task 17이 꽂는다** |
| Task 17 본문·커밋·Review가 옛 설계(별도 프로세스)를 담고 있다 | 계획 자체 | 세 곳 정정 |
| **§6.9의 `_wait_ready`가 프로세스 경계를 잘못 뒀다** | `llm_server.py:130` — `_wait_ready`는 `--once` 자식의 코드이고 `llm_entry`는 그것의 **자식**이다. "같은 프로세스"는 `llm_entry`↔`mlx_lm.server.main()` 관계다 | **이 스펙 §6.9 정정** — DB를 읽어야 한다. `--once` 자식의 연결을 `_wait_ready`에 넘긴다 |
| Task 14 Step 6-b가 Task 18의 `restartService`를 쓴다 | 계획 자체 | **Task 19 Step 1-b로 옮겼다.** 번호와 실행 순서가 일치한다 |
| Task 0 Step 3이 `be/.env`에 쓰고 복구가 실패한다 | **실측** — `be/.gitignore:7`이 무시해 `git checkout`이 `pathspec did not match`. probe 줄이 영구히 남는다 | 기준선 **사본**을 조작해 탐지를 실증한다 |

**important 중 스펙에 영향을 준 것 하나.** `install_hf_progress_hook`의 훅 지점이 존재하지
않을 수 있다 — `huggingface_hub`에 전역 훅이 없고 `tqdm_class`를 넘겨야 하는데 `mlx_lm`·
sentence-transformers·pyannote 셋 다 안 넘긴다. §6.9에 그 사실과 **대안**(하트비트만)을 적고
§12의 미확정 표에 올렸다. 계획 Task 17 Step 5-c가 구현 전에 조사한다. **불가로 판정되면
P4-C6을 내려야 하고 그것은 다시 스펙 변경이다.**

**Phase 0의 설계 결정 하나를 의식적으로 뒤집었다.** Phase 0는 셔뱅을 절대 경로로 다시 쓰고
`#!/bin/sh` 트릭을 **기각했다** — "SIP가 `/bin/sh` exec에서 `DYLD_*`를 지워 Task 5의 dyld 실측이
통째로 끊긴다"(`build.sh:274-277`). 그 근거는 Phase 4에 없다(dyld 실측을 하지 않는다). 대신
Phase 4는 반대 제약을 받는다 — 한 빌드 산출물이 두 자리(dev `desktop/build/python`, packaged
`Resources/python`)에 놓이고 electron-builder의 복사 지점에 훅을 걸 수 없어, 절대 경로를 쓰면
**`.app` 안에 dev 트리 경로가 실려** 금지 문자열 검사를 위반한다. 그래서 위치 독립 형태
(`${0%/*}`, 외부 명령 없음)를 쓴다. 리뷰어가 제한된 PATH·공백 경로에서 동작을 실측했다.

### 17.4 외부 리뷰 — 4회차 (스펙 `a8ab4f3` + 계획 `bcf172b`)

**판정: 확정 불가 — blocking 3건.** 메인 세션이 재확인했고 셋 다 사실이었다.

| 지적 | 확인 | 반영 |
| --- | --- | --- |
| **재배치가 캐시 임시 트리에 적용돼 `.app`에 저장소 경로가 실린다** | 리뷰어가 PBS 트리로 계획 순서를 재현 — `_sysconfigdata` prefix가 `<repo>/desktop/.cache/…`로 남고 진입점 확인이 만든 `.pyc` 25개가 같은 경로를 담는다. `check-bundle.mjs:90`의 기존 4번 검사가 Resources 전체를 훑어 잡는다 | **이 스펙 §6.1-b 신설** |
| 훅의 `sys.modules` 훑기가 `getattr`로 던진다 | **메인 세션 실측 — 92개 모듈이 `ModuleNotFoundError`.** transformers의 지연 모듈이 `__getattr__`에서 서브모듈을 import한다. worker·embed·`llm_entry` 셋이 기동 첫머리에서 부르므로 세 프로세스가 전부 죽는다 | 계획 — `vars(mod).get(name)`으로 |
| `parseDamwhaProcesses` 시그니처가 네 모양으로 갈린다 | 인터페이스·테스트·구현·호출부 | 계획 — §계약 한 곳에만 정의 |

**§6.1-b가 이 개정의 중심이다.** 셔뱅은 §17.3에서 "최종 위치가 둘"이라는 제약을 인식해 위치
독립 형태로 갔는데, **같은 제약을 받는 `_sysconfigdata`와 `.pyc`에는 그 사고를 적용하지
않았다.** Phase 0의 `build.sh`가 "한 최종 위치에서 relocate 한 번"을 전제로 쓰였고, 거기에 2층
캐시·세 번의 `mv`/`ditto`·두 최종 위치를 얹으면서 전제가 깨진 것을 스펙이 다루지 않았다.
§6.1-b는 그것을 규칙 하나로 통일한다 — **번들 안에 어떤 절대 경로도 굽지 않는다.**

### 17.5 계획 구조 변경 (2026-09-16)

리뷰어의 진단을 받아들여 셋을 바꿨다. 4회차까지 blocking **11건** 중 **8건**이 "계획에 문자
그대로 적었지만 한 번도 실행하지 않은 코드"에서 나왔다.

1. **§6.1-b 신설** (위).
2. **계획을 둘로 나눴다** — `-bundled-runtime`(Task 1–7)과 `-runtime-integration`(Task 1–12).
   5,249줄 한 문서에서는 한 계약의 사본이 인터페이스·테스트·구현·호출부 네 곳에 흩어지고,
   개정이 그중 하나만 고치면 나머지가 어긋났다.
3. **두 규칙을 계획 머리에 못 박았다** — (a) 계획에 박는 코드는 확정 전에 최소 한 번 실행한
   것만이고 `[실행됨: <명령>]`을 붙인다, (b) 시그니처는 §계약 한 곳에만 적는다. 그래서 Part 2는
   셸 대신 **시그니처·계약·테스트 표**만 싣고 구현 본문은 "구현 시 작성"이다.

### 17.6 메인 세션 리뷰

(작성 예정.)
