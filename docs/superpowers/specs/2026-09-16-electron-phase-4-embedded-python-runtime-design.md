# Electron Phase 4 — Python·ML 실행 환경 내장 구현 스펙

작성일: 2026-09-16
브랜치: `feat/electron-migration-phase-4-embedded-python-runtime`
로드맵: [docs/electron-migration-roadmap.md](../../electron-migration-roadmap.md) — Phase 4

---

## 1. 이 Phase가 만드는 것

앱이 Python·ML 라이브러리·ffmpeg를 자기 안에 싣고, worker·embed를 그 번들로 띄운다.
**Python·uv·Homebrew를 따로 깔지 않은 맥에서 전사·화자 분리·요약·검색이 돈다.**

Phase 3이 Docker 의존을 지웠듯 이 Phase는 개발 도구 의존을 지운다. 끝나면 앱이
저장소 체크아웃 밖의 실행 파일을 하나도 부르지 않는다 — `uv`도, Homebrew `ffmpeg`도,
`be/worker/.venv`도.

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
2. **`mlx-lm`·`mlx` 버전의 단일 진실 원천이 없다.** `pyproject.toml` 밖에 있고
   `python/build.sh:53`이 `mlx-lm==0.31.3`만 고정한다(`mlx` 0.32.2는 전이 해석).
3. **bge-m3가 같은 가중치를 두 벌 받는다** — `pytorch_model.bin`(rev `5617a9f…`)과
   `model.safetensors`(rev `9a0624b…`)로 리비전까지 갈린다. **2.1 GB 낭비.**

**G1 허용 목록 24건**(제3자 wheel·CPython 표준 라이브러리 원본의 금지 문자열)과 그중
**실동작 폴백 3건**(`soundfile.py`, `ctypes/macholib/dyld.py`, `PIL/_imagingft…so`)의
미사용 증명은 **이 Phase가 받지 않는다** — §15에서 Phase 6으로 넘긴다 (§4.2).

### 2.2 Phase 2 (서비스 실행 통합)

- **`FFMPEG_BIN`/`FFPROBE_BIN`을 worker `Settings`에 추가해야 한다.**
  `be/worker/damwha_worker/pipeline/ffmpeg.py`가 `ffmpeg`·`ffprobe`를 이름으로만 부르므로
  (`:24`, `:59`) 번들에 ffmpeg를 넣는 것만으로는 개발 도구가 없는 맥에서 찾지 못한다
  (Phase 2 스펙 §6.2·§15).
- **`UV_BIN`을 고친 뒤 "다시 시도"로는 반영되지 않는다** (Phase 2 결과 §5의 (2)).
  이 Phase가 `uv`를 런타임에서 제거하므로 **이 한계는 함께 소멸한다.**
- 앱 소유/외부 판정: 터미널 `pnpm worker`가 있으면 앱은 자기 worker를 띄우지 않고 경고하며
  (`stand-down`), 외부 embed는 `/embed` 계약이 맞으면 채택한다. 이 규칙은 유지한다.
- **`ps eww`는 SIP 때문에 다른 프로세스의 env를 내주지 않는다** (2026-09-12 실측). 소유 표식을
  env에 둘 수 없는 이유다 (§6.5).
- **강제 종료 4단계의 자손 SIGKILL은 실앱에서 발화한 적이 없다** — 단위 테스트로만 존재한다
  (Phase 2 결과 §4 한계).
- worker supervisor가 **크래시**해 재시작되면 이전 `--once` 자식을 추적하지 않는다.

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

---

## 3. 현재 시스템에서 이 Phase가 건드리는 지점

| 지점 | 지금 | 이 Phase 뒤 |
| --- | --- | --- |
| `desktop/src/process/uv-launcher.ts` | `uv run --directory be/worker <args>` | `launchPython` — `<번들>/bin/python3.12 -m <모듈>` |
| `desktop/src/services/worker.ts:launch` | `ctx.bins.uv` 확인 + `be/worker/.env` 존재 확인 | 번들 python 확인. `.env` 검사 제거 |
| `desktop/src/services/embed.ts:launch` | `damwha-embed` 콘솔 스크립트 | `-m damwha_worker.embed_service` |
| `desktop/src/process/executables.ts` | `searchDirs`가 자식 PATH **앞**에 붙는다 | 번들 경로가 앞, 탐색 목록은 뒤 |
| `desktop/src/config/config.ts` | `UV_BIN` 설정 키 | 제거. `HF_TOKEN`은 앱 소유 키로 거절 |
| `desktop/scripts/package.mjs` | `build-postgres.sh` 하나 | `build-python.sh`·`build-ffmpeg.sh` 추가 |
| `desktop/scripts/check-bundle.mjs` | API·PG 트리 검사 | Python·ffmpeg 트리·서명·문자열 검사 추가 |
| `be/worker/damwha_worker/config.py` | — | `ffmpeg_bin`·`ffprobe_bin` 필드 추가 |
| `be/worker/damwha_worker/pipeline/ffmpeg.py:24,59` | `["ffmpeg", …]`·`["ffprobe", …]` 리터럴 | 인자로 받는다 |
| `be/worker/damwha_worker/embed_service.py` | `main()`만 | `if __name__ == "__main__": main()` 추가 |
| `be/worker/damwha_worker/__main__.py` | argv에서 `--once`만 본다 | `--run-id=<uuid>`를 argv에 실어 소유 표식으로 (파싱은 하지 않는다) |
| `be/worker/damwha_worker/db/core.py` | `worker_capabilities` | `model_readiness` 추가 |
| `be/worker/pyproject.toml` | `mlx-lm==0.31.3`만 고정 | `mlx` 명시 고정 |

**건드리지 않는 것:** `__main__.py:286`의 `--once` 자식 스폰과 `capabilities.py:68`의 프로브.
둘 다 `sys.executable`을 쓰므로 번들 python을 자동으로 승계한다.

---

## 4. 범위

### 4.1 포함

1. Python 런타임·ML 라이브러리·ffmpeg의 빌드·스테이징·번들 적재.
2. 빌드 시점 Mach-O 서명(arm64 전수)과 재배치 3종 반복 적용.
3. worker·embed 실행 계약 교체 — `uv run` 제거, 번들 python 직접 호출.
4. `FFMPEG_BIN`/`FFPROBE_BIN`/`LENS_LLM_SERVER_BIN`의 절대 경로 주입과 worker 쪽 수용.
5. `be/worker/.env` 의존 제거 — 앱이 필요한 값을 전부 env로 주입.
6. 모델·캐시 경로를 `<userData>/models`로 고정 (`HF_HOME`).
7. bge-m3 중복 다운로드 제거 (리비전 고정 + safetensors 단일 경로).
8. HF 토큰 온보딩 — 첫 실행 필수 게이트, 실제 API 검증, Keychain 저장, 설정에서 수정.
9. 모델 준비 상태를 `app_setting.model_readiness`로 올리고 앱·FE가 읽어 진행·실패·재시도 표시.
10. 소유 표식(`--run-id`)과 **기동 시 고아 정리** — Phase 2·3이 넘긴 항목.
11. numba 사망 지점 A/B 재측정과 그 결과에 따른 entitlement·word-timestamp 결정.
12. `mlx-lm`·`mlx` 버전 매니페스트를 `pyproject.toml`로 일원화.
13. dev 루프 — `PYTHONPATH`로 저장소 worker 소스를 앞세운다.
14. 번들 위생 검사 확장(`check-bundle.mjs`).

### 4.2 제외

| 제외 | 어디로 |
| --- | --- |
| Developer ID 서명·공증·DMG·자동 업데이트 | Phase 6 |
| G1 허용 목록 24건 재검토, 실동작 폴백 3건 미사용 증명 (P0-C7 조건부 충족) | Phase 6 — 서명·공증과 같은 회차에서 본다 |
| 기존 데이터(Docker DB·`be/storage`) 이전 | Phase 5 |
| 잠자기·복귀, 디스크 부족 중 동작 검증 | Phase 5 |
| 깨끗한 다른 맥에서의 독립 설치 검증 | Phase 6 (§9 P4-C8이 대체 증명) |
| job lease token (같은 `WORKER_ID` 중복 처리의 근본 해소) | Phase 6 |
| pyannote 비게이트 대안 모델 조사 | 범위 밖 |
| 모델 교체·선택 UI | 범위 밖 — 모델 선택은 payload 책임이다 |
| Intel 맥 | 로드맵 전체에서 제외 |

### 4.3 선행 조건

- 이 맥에 Xcode Command Line Tools (빌드 스크립트가 `cc`·`otool`·`install_name_tool`·
  `codesign`을 쓴다). **빌드 머신의 조건이지 실행 머신의 조건이 아니다.**
- 빌드 시점에 `uv`가 있어야 한다 — `uv pip install --python <번들>`을 부른다. 런타임에는
  필요 없다.
- HF 계정과 `pyannote/speaker-diarization-community-1` 조건 수락. **검증자가 갖고 있어야
  P4-C4·C6을 판정할 수 있다.**
- Phase 3의 내장 PostgreSQL이 동작하는 상태.

---

## 5. 데이터 안전 규칙

1. **기존 개발 자산을 건드리지 않는다.** `be/worker/.venv`, `be/worker/.env`, `~/.cache/huggingface`,
   `damwha_pgdata`, `be/storage`는 이 Phase의 어떤 코드도 쓰지 않는다. 검증 전후 체크섬으로
   증명한다 (P4-C18).
2. **모델 캐시는 앱 밖에 둔다.** `<userData>/models`. `.app` 교체·삭제로 사라지지 않는다.
3. **토큰 평문을 디스크에 남기지 않는다.** Keychain 암호화본만 저장하고, 로그·화면·
   `supervisor.log`·오류 메시지 어디에도 원문을 적지 않는다.
4. **고아 정리는 damwha 소유 프로세스만 내린다.** `--run-id`가 있고 그 값이 내 것이 아닌
   프로세스만 대상이다. 표식이 없는 프로세스(외부 `pnpm worker` 포함)는 손대지 않는다.
5. **빌드가 실패하면 앱을 만들지 않는다.** `package.mjs`가 거기서 멈춘다 — Python이 빠진
   `.app`은 첫 실행에서야 드러난다.

---

## 6. 구성요소와 계약

### 6.1 번들 계약

```
Damwha.app/Contents/Resources/
  api/          (Phase 1·2)
  postgres/     (Phase 3)
  python/       ← 새로
    bin/python3.12
    lib/python3.12/site-packages/   (damwha_worker 포함)
  ffmpeg/       ← 새로
    bin/ffmpeg
    bin/ffprobe
```

dev는 `desktop/build/{python,ffmpeg}`를 같은 자리로 본다 — Phase 3의 `postgres`와 같은 규칙.
`electron-builder.yml`의 `extraResources: - from: build`가 이미 `build/` 아래 전부를 싣는다.
설정 변경은 필요 없다.

**빌드 스크립트 두 개.**

| 스크립트 | 산출물 | 캐시 |
| --- | --- | --- |
| `desktop/scripts/build-python.sh [--fresh]` | `desktop/build/python/` | `desktop/.cache/python/` |
| `desktop/scripts/build-ffmpeg.sh [--fresh]` | `desktop/build/ffmpeg/` | `desktop/.cache/ffmpeg/` |

`build-postgres.sh`와 같은 규칙:

- 버전·`BUILD_PREFIX`·체크섬 파일·**스크립트 자신의 shasum**이 캐시 키다. 조작을 고치고 옛
  산출물을 쓰는 것이 가장 조용한 실패다.
- `BUILD_PREFIX`는 이 머신에 없는 중립 경로(`/opt/damwha-embedded-py312`,
  `/opt/damwha-embedded-ffmpeg`). 최종 경로와 일부러 다르게 둬야 재배치 결함이 빌드 때 드러난다.
- 소스 아카이브는 `*-checksums.txt`로 검증한다. (서명 검증은 Phase 6.)

**`build-python.sh`의 단계:**

1. python-build-standalone 3.12.11 내려받기·검증·전개.
2. `uv pip install --python <트리> -r <해석된 목록>` — `be/worker/pyproject.toml`의
   `[project.optional-dependencies] models` + 기본 의존성.
3. `uv pip install --python <트리> --no-deps <repo>/be/worker` — `damwha_worker` 패키지 자체.
   `--no-deps`인 이유: 2단계가 이미 전부 깔았고, 여기서 해석이 다시 돌면 고정 버전이 흔들린다.
4. **재배치 3종** — `bin/` 셔뱅 65개를 번들 상대로, `_sysconfigdata*.py`의 prefix,
   `__pycache__` 760개 삭제. **매 빌드 반복한다.**
5. **Mach-O 처리** — `LC_RPATH` 58건 삭제, `LC_ID_DYLIB` 64건 정규화. 멱등이다.
6. **arm64 전수 서명** — `codesign -s - --force`를 무서명 Mach-O에 적용.
7. **자기 검사** — `codesign --verify --arch arm64`로 0건 확인. `--arch` 없이 부르지 않는다
   (universal 파일의 x86_64 슬라이스 하나 때문에 파일 전체가 `not signed at all`로 보고된다).

**의존성 매니페스트 일원화.** `be/worker/pyproject.toml`의 `models` extra에 `mlx`를 `==`로
명시 고정한다. `build-python.sh`는 버전을 스스로 적지 않고 이 파일에서만 읽는다 — Phase 0의
`build.sh:53`이 `mlx-lm`만 고정하고 `mlx`는 전이 해석에 맡겼던 것을 닫는다.

**entitlements.** `desktop/build-resources/entitlements.mac.plist`:

```
com.apple.security.cs.allow-unsigned-executable-memory  true
com.apple.security.cs.disable-library-validation        true
```

`allow-jit`은 §6.8의 numba 측정 결과가 요구할 때만 더한다. 요구하지 않으면 넣지 않는다.

### 6.2 실행 계약

`desktop/src/process/uv-launcher.ts` → `desktop/src/process/python-launcher.ts`.

```
<python>/bin/python3.12 -m damwha_worker              --run-id=<uuid>
<python>/bin/python3.12 -m damwha_worker.embed_service --run-id=<uuid>
```

- **콘솔 스크립트(`bin/damwha-worker`·`bin/damwha-embed`)를 부르지 않는다.** 그것들은 셔뱅을
  타고, Phase 0의 R-6가 짚은 대로 옛 경로가 남아 있으면 죽지 않고 **조용히 다른 런타임을
  실행한다**. `-m`은 셔뱅을 타지 않는다. (셔뱅 재배치는 여전히 빌드에서 한다 — 사람이 그
  스크립트를 손으로 부를 수 있고, 일부 라이브러리가 자기 콘솔 스크립트를 부른다.)
- `embed_service.py`에 `if __name__ == "__main__": main()` 한 줄을 더해 `-m`으로 부를 수 있게
  한다. 기존 `[project.scripts] damwha-embed` 진입점은 그대로 둔다 — `deploy/README.md`의
  `uv tool install` 경로가 쓴다.
- **cwd.** `uv run --directory be/worker`가 하던 일을 잃는다. 앱은 cwd를 `<userData>`로 준다.
  worker는 경로를 전부 절대값으로 받으므로(`STORAGE_ROOT`) cwd에 의존하지 않는다.
  **웹 흐름의 `STORAGE_ROOT=../storage` 상대 경로는 이 경로를 타지 않는다** — 그쪽은
  `pnpm worker`가 `uv run --directory`로 그대로 돈다.
- **종료 신호.** `uv` 중간 프로세스가 사라지므로 Phase 2의 "uv pid로 SIGTERM, 그룹 아님"
  우회가 불필요해진다. 이제 SIGTERM이 Python에 바로 닿는다. `detached: true`는 유지한다 —
  dev 터미널의 Ctrl-C 같은 그룹 신호가 종료 절차를 건너뛰고 닿는 것을 막는 것이 그 이유였고,
  그 이유는 그대로다.
- **stdout/stderr 분리는 유지한다.** worker의 ready 줄은 stderr, embed(uvicorn)의 접근 로그는
  stdout이다. 합치면 `stderrTail()`이 노이즈로 밀린다 (Phase 2 실측).
- `ReadinessWatch`(worker)와 `/embed` 계약 프로브(embed)는 그대로다.

**PATH 처리.** 번들 경로가 **앞**, 기존 `searchDirs`가 **뒤**.

```
PATH = <python>/bin : <ffmpeg>/bin : <기존 searchDirs> : <상속 PATH>
```

폴백을 남기는 이유: 예상 못 한 보조 도구가 필요할 때 조용히 죽는 것보다 낫다.
**폴백이 남아 있으면 검증이 무의미해지므로**, P4-C8·C9는 PATH가 아니라 `lsof`로 실제 열린
파일과 `ps -o args`로 실제 실행된 경로를 본다.

### 6.3 env 주입 계약

`be/worker/.env` 존재 검사를 `workerSpec.launch`에서 **지운다.** 번들에는 그 파일이 없고,
앱은 필요한 값을 전부 자기가 넣는다.

| 키 | 값 | 출처 |
| --- | --- | --- |
| `DATABASE_URL`·`STORAGE_ROOT` | 내장 클러스터 짝 | Phase 3 (`withEmbeddedDatabase`) |
| `WORKER_ID` | `desktop-<uuid>` (실행마다 새 값) | Phase 2 (`RUN_WORKER_ID`) |
| `EMBED_SERVICE_HOST`·`PORT`·`URL` | 루프백 고정 + `prepare`의 파생 | Phase 2 |
| `HF_TOKEN` | Keychain 복호화본 | **새로** (§6.4) |
| `HF_HOME` | `<userData>/models` | **새로** |
| `LENS_LLM_BASE_URL` | `http://127.0.0.1:<빈 포트>` | **새로** — 지금 **기본값 없는 필수 설정**이라(`config.py`) 주입하지 않으면 worker가 `ValidationError`로 기동 실패한다 |
| `LENS_LLM_SERVER_BIN` | `<python>/bin/mlx_lm.server` | **새로** — `llm_server.py:92`의 `shutil.which`가 절대 경로를 그대로 돌려준다. 코드 변경 없음 |
| `FFMPEG_BIN`·`FFPROBE_BIN` | `<ffmpeg>/bin/ffmpeg`·`ffprobe` | **새로** (§6.6) |
| `PYTHONPATH` | dev만 `<repo>/be/worker` | **새로** (§6.7) |

**`UV_BIN`을 지운다.** `config.ts`의 `APP_SETTING_KEYS`에서 빼고, `config.json`에 남아 있으면
`DOCKER_BIN`과 같은 방식으로 **로그에만 남기는 note**를 적는다("Phase 4부터 앱은 uv를 부르지
않습니다"). 화면 경고로 올리지 않는다 — 사람이 고른 적 없는 옛 기본값이다.

**`HF_TOKEN`은 앱 소유 키다.** `config.json`에 적혀 있으면 `HOST`·`EMBED_SERVICE_HOST`와 같이
**무시하고 화면 경고**를 낸다. 값 자체는 경고에 싣지 않는다 — 비밀이다.

### 6.4 HF 토큰 계약

**첫 실행 게이트.** 토큰이 없으면 앱이 서비스를 띄우기 전에 토큰 화면을 띄운다. **건너뛸 수
없다.** 화면이 가진 것:

1. `pyannote/speaker-diarization-community-1` 조건 수락 페이지 링크 (외부 브라우저로 연다).
2. HF 토큰 발급 페이지 링크.
3. 입력칸 + "확인".

**저장 전에 실제로 검증한다.** `GET https://huggingface.co/api/whoami-v2`에 `Bearer`로 붙여
200을 받아야 저장한다. 형식만 보면 오타난 토큰이 통과해 몇 분 뒤 job 실패로만 드러난다.
네트워크가 없으면 "지금은 확인할 수 없어요"로 구분해 말하고 저장하지 않는다.

**게이트 수락 여부는 이 시점에 확인하지 않는다.** 수락은 모델 단위이고, 확인하려면 그 모델
파일을 실제로 건드려야 한다. 대신 §6.6의 실패 분류가 403을 "조건 수락 안 함"으로 구별한다.

**저장.** `safeStorage.encryptString(token)` → `<userData>/hf-token.bin` (0600).
복호화는 Electron main만 한다. 자식에게는 `HF_TOKEN` env로만 넘어간다.

- `safeStorage.isEncryptionAvailable()`이 false면 **기동을 막고** 원인과 복구를 띄운다.
  평문 폴백은 두지 않는다.
- 복호화 실패(다른 맥에서 복사해 온 파일 등)는 "토큰을 읽을 수 없어요 — 다시 입력해 주세요"로
  토큰 화면을 다시 띄운다. 파일은 지우지 않는다.

**설정 화면.** 상태 창에 토큰 항목이 있다. 표시는 마스킹(`hf_****…****abcd`), 수정·삭제 가능.
바꾸면 **worker·embed를 재시작해야 반영된다**는 것을 화면이 말하고, 재시작 버튼을 함께 둔다.

**토큰 원문은 어디에도 로그하지 않는다.** 검증 실패 사유는 HTTP 상태와 HF 응답 메시지만 적는다.

### 6.5 소유·고아 처분 계약

**표식은 argv에 둔다, env가 아니라.** `ps eww`는 SIP 때문에 다른 프로세스의 env를 내주지
않는다(Phase 2 실측). `ps -o args`는 argv를 내준다.

앱이 띄우는 모든 Python 프로세스가 `--run-id=<uuid>`를 argv에 갖는다. `uuid`는 이 실행 하나의
값이고 `WORKER_ID`와 별개다 — `WORKER_ID`는 worker 전용이라 embed·`--once` 자식·
`mlx_lm.server`를 덮지 않는다.

**전파.** `--once` 자식은 `__main__.py:286`이 `[sys.executable, "-m", "damwha_worker", "--once"]`로
띄운다. 여기에 부모의 `--run-id`를 이어 붙인다. `mlx_lm.server`는 worker가
`llm_server.py`에서 띄우므로 같은 자리에 붙인다.

**worker는 `--run-id`를 파싱하지 않는다.** `__main__.py:323`은 `"--once" in sys.argv[1:]`만
보므로 모르는 인자가 있어도 안전하다. 표식의 유일한 독자는 앱이다.

**기동 시 정리.** 앱이 뜨면 `ps -axo pid,args`로 `--run-id=`를 가진 프로세스를 훑는다.

| 발견 | 처분 |
| --- | --- |
| `--run-id`가 내 것 | 있을 수 없다 (방금 만든 값) — 발견되면 로그하고 무시 |
| `--run-id`가 다른 값 | **이전 실행의 고아. 내린다** — SIGTERM → 유예 → SIGKILL |
| `--run-id` 없는 damwha worker | 외부 `pnpm worker`. **손대지 않고 stand-down** (Phase 2 규칙) |

고아를 내릴 때 사용자에게 묻지 않는다. 그 프로세스는 이미 죽은 앱의 것이고, 살려 두면
job 테이블 잠금이 있어도 중복 처리 창이 열린다.

**정리는 서비스 기동 **전**에 한다.** 뒤에 하면 새로 띄운 것과 고아가 잠시 공존한다.

**embed 채택 규칙이 좁아진다.** Phase 2는 `/embed` 계약이 맞으면 채택했다. 이제 `--run-id`가
있고 내 것이 아닌 embed는 **채택 대상이 아니라 고아**다 — 먼저 내리고 새로 띄운다.
`--run-id` 없는 외부 embed(터미널 `pnpm embed`)만 채택한다. Phase 3 §5.2-2에서 "고아 embed가
한 번은 채택되고 그 뒤에는 둘이 모델 메모리를 썼다"가 이 규칙으로 닫힌다.

**종료.** 단계는 Phase 2 그대로 — SIGTERM → 유예 → 자손 SIGKILL. `uv`가 사라져 신호가 Python에
바로 닿는다. **Phase 2가 "실앱에서 발화한 적 없다"고 남긴 자손 SIGKILL 단계를 이번에 실측한다**
(P4-C14).

### 6.6 ffmpeg·모델 경로 계약

**worker 코드 변경 3건.**

| 파일 | 변경 |
| --- | --- |
| `config.py` | `ffmpeg_bin: str = "ffmpeg"`, `ffprobe_bin: str = "ffprobe"` 추가. 기본값이 지금 동작이라 웹 흐름에 회귀가 없다 |
| `pipeline/ffmpeg.py` | `probe(path, runner, ffprobe_bin="ffprobe")`, `normalize(src, dst, runner, ffmpeg_bin="ffmpeg", ffprobe_bin="ffprobe")`. 리터럴을 인자로 |
| `process_meeting.py:53`·`enroll_speaker.py:32` | `normalize_fn`/`probe_fn` 기본값을 `functools.partial(ffmpeg.normalize, ffmpeg_bin=settings.ffmpeg_bin, …)`로. **시그니처 타입은 그대로** — 테스트의 monkeypatch 경로가 안 깨진다 |

`normalize` 안의 `probe(temp_path)` 재귀 호출(`ffmpeg.py:82`)도 `ffprobe_bin`을 넘긴다.
넘기지 않으면 정규화 뒤 검증만 PATH의 ffprobe로 떨어진다.

**모델 캐시.** `HF_HOME=<userData>/models` 하나로 hub 캐시와 transformers 캐시를 덮는다.
`model_cache_dir` 설정은 남기되 앱은 쓰지 않는다 — 웹 흐름의 기존 동작이다.

**bge-m3 중복 제거.** `models/bge_embed.py`가 리비전을 고정하고 safetensors만 받게 한다.
Phase 0 실측: `pytorch_model.bin`(rev `5617a9f…`)과 `model.safetensors`(rev `9a0624b…`)를
두 벌, 리비전까지 갈려 받아 2.1 GB를 낭비했다. 검증은 다운로드 뒤 `<userData>/models`
실측 크기로 한다 (P4-C7).

### 6.7 dev 루프 계약

dev 실행만 `PYTHONPATH=<repo>/be/worker`를 앞에 둔다. `sys.path`가 site-packages보다 먼저
거기를 보므로 저장소 소스가 이긴다.

- **빌드 트리에는 dev 흔적이 남지 않는다.** editable 설치(`.pth`에 이 머신의 절대 경로)를
  쓰지 않는 이유다 — dev와 packaged가 같은 `desktop/build/python`을 공유하므로 그 `.pth`가
  그대로 `.app`에 실린다.
- dev와 packaged의 유일한 차이는 이 한 줄이다. `sys.path[0]` 차이는 `supervisor.log`의
  런타임 자기 보고에 그대로 드러나므로 숨지 않는다.
- `pnpm worker`·`pnpm embed`(저장소 `.venv`)는 이 경로를 타지 않는다. 그대로 돈다.

### 6.8 numba 측정 계약

**Task 1에서 잰다.** 결과가 entitlement와 word-timestamp 처리를 가르므로 구현 전에 알아야 한다.

A/B 대조 — hardened runtime + 최소 entitlement로 서명한 번들 python에서 각각 별개 프로세스:

1. `import numba` 만.
2. `@njit` 함수 **정의**만.
3. 그 함수 **호출** (= 컴파일 발화).

SIGKILL이 어디서 나는지로 사망 지점이 갈린다. 크래시 리포트가 안 남으므로 **부모가 자식의
종료 신호를 읽어 판정한다.**

| 결과 | 조치 |
| --- | --- |
| 셋 다 산다 | entitlement 최소 집합 유지. 끝 |
| import에서 죽는다 | `allow-jit` 추가 후 재측정. 그래도 죽으면 mlx-whisper 경로 재검토 |
| 호출(컴파일)에서만 죽는다 | word-timestamp DTW만 영향. `allow-jit` 추가 후 재측정하고, 해소되지 않으면 **word-timestamp를 끄고** 그 사실을 결과 문서와 사용자 안내에 남긴다 |

**이 측정 결과로 계획을 갱신한다.** 측정 전에 뒤 Task를 확정하지 않는다.

### 6.9 모델 준비 상태 계약

`app_setting`의 두 번째 공유 행. `worker_capabilities`와 같은 방향 — **worker·embed가 쓰고
API는 읽기 전용.**

```
app_setting.model_readiness = {
  "updated_at": "<ISO8601>",
  "entries": [
    {
      "key": "BAAI/bge-m3",
      "state": "missing" | "downloading" | "ready" | "failed",
      "bytes_done": 0,
      "bytes_total": 0,
      "error": null
    }
  ]
}
```

- `key`는 HF repo id. 모델 선택은 payload 책임이므로 앱이 미리 알 수 없다 — 행은 **실제로
  건드린 모델만** 담는다.
- 진행 갱신은 **초당 1회 이하**로 누른다. 한 다운로드가 DB를 두들기지 않게.
- `bytes_total`을 모르는 구간(HF가 안 주는 경우)은 `0`으로 두고 화면이 "받는 중"만 보인다.
- **한 행에 여러 writer가 붙는다** — worker supervisor, `--once` 자식, embed. 갱신은
  `key` 단위 merge로 한다. 통째로 덮으면 서로의 항목을 지운다.
- **DB 준비 전 구간을 못 덮는다.** 그 구간의 유일한 다운로드는 embed의 bge-m3이고, embed는
  `dependsOn: []`이라 postgres와 나란히 뜬다. 그래서 **embed는 진행을 메모리에 모았다가 DB가
  붙는 즉시 한 번 쓴다.** 그 전까지 화면은 embed의 기존 `not-ready`를 보인다.

**읽는 쪽.** API가 기존 설정 조회 응답에 얹고, 앱 상태 창과 FE가 같은 값을 본다.

**재시도.** `state: "failed"`면 상태 창에 "다시 시도"가 뜨고, 누르면 그 서비스를 재시작한다.
HF hub가 부분 파일을 이어받으므로 처음부터 다시 받지 않는다.

---

## 7. 사용자 동작

1. **첫 실행** — 앱 아이콘 → 토큰 화면. 조건 수락·토큰 발급 링크를 눌러 브라우저에서 처리하고
   토큰을 붙여 넣는다. 확인이 통과하면 서비스가 뜬다.
2. **첫 업로드** — 모델이 없으므로 받는다. 상태 창과 FE에 진행이 보인다. 다 받으면 전사·
   화자 분리·요약이 이어진다.
3. **첫 검색** — embed가 bge-m3를 받는다(기동 시). 그 전에는 키워드 검색만 되고, 화면이
   그 이유를 말한다.
4. **두 번째 실행** — 모델을 다시 받지 않는다. 네트워크가 없어도 처리가 된다.
5. **토큰 교체** — 상태 창 → 설정 → 토큰 수정 → worker 재시작.
6. **앱 강제 종료 뒤 재실행** — 남은 고아를 앱이 조용히 정리하고 뜬다.

---

## 8. 실패·복구 동작

`desktop/src/diagnostics/causes.ts`의 `CAUSES`에 얹는다.

| 원인 | 화면 |
| --- | --- |
| `Resources/python` 없음 | dev: `bash desktop/scripts/build-python.sh` 안내. packaged: 앱 재설치 안내 |
| `Resources/ffmpeg` 없음 | 같은 형태 |
| 번들 python이 실행되지 않음 (`bad interpreter`·서명 거부) | 번들 손상. 로그 경로 + 재설치 |
| `safeStorage` 사용 불가 | Keychain 잠금 해제 안내. 서비스를 띄우지 않는다 |
| 토큰 없음 | 토큰 화면 (실패 화면이 아니라 온보딩) |
| 토큰 무효 (401) | "토큰이 유효하지 않아요" + 재입력 |
| 토큰 검증 불가 (네트워크) | "지금은 확인할 수 없어요" — 무효와 구분한다 |
| 모델 다운로드 403 | **"이 모델은 사용 조건 수락이 필요해요"** + 그 모델의 수락 페이지 링크. 토큰 무효와 다른 실패다 |
| 모델 다운로드 네트워크 실패 | 사유 + "다시 시도" |
| 디스크 부족 | 남은 용량과 필요한 용량 |
| `LENS_LLM_SERVER_BIN` 없음 | 번들 손상으로 분류 |

**삭제되는 원인:** `uvMissing`, `workerEnvMissing`. 각각 uv 제거와 `.env` 의존 제거로 소멸한다.

Phase 2·3의 나머지 규칙은 유지한다 — manual 실패는 자동 재시도하지 않고, auto 실패는
`[3s, 8s, 20s]` 3회.

---

## 9. 완료 기준

### 축 A — 온보딩과 토큰

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C1 | 토큰 없는 첫 실행에 토큰 화면이 뜨고 건너뛸 수 없다 | 토큰 파일을 지우고 Finder 실행. 진행 시도 → 막힘 |
| P4-C2 | 토큰 평문이 디스크에 없다 | `hf-token.bin`이 바이너리. `grep -r <토큰>` 이 userData·로그 전체에서 0건 |
| P4-C3 | 오타·무효 토큰은 저장 전에 거절된다 | 잘못된 토큰 → 화면에 사유. 파일 안 생김 |
| P4-C4 | 설정에서 토큰을 바꾸면 재시작 뒤 새 값으로 동작한다 | 토큰 교체 → worker 재시작 → 화자 분리 job 성공 |

### 축 B — 실사용 동작

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C5 | 모델 0개 상태에서 업로드 → 전사·화자 분리·요약·검색 전부 성공 | `<userData>/models` 비우고 실오디오 1건 완주. 4단계 결과가 DB에 |
| P4-C6 | 다운로드 진행이 화면에 보인다 | 상태 창·FE에 `downloading`과 진행 |
| P4-C7 | 다운로드를 끊으면 실패로 뜨고, 다시 시도가 이어받는다 | 다운로드 중 네트워크 차단 → `failed` → 복구 → "다시 시도" → 처음부터가 아니라 이어받음 |
| P4-C8 | 게이트 미수락 403과 토큰 무효를 다른 안내로 구별한다 | 수락 안 한 계정의 유효 토큰으로 화자 분리 job → 수락 페이지 링크 |
| P4-C9 | 두 번째 실행은 모델을 다시 받지 않는다 | 캐시 크기 불변, 네트워크 요청 0, 처리 성공 |
| P4-C10 | bge-m3를 한 벌만 받는다 | `<userData>/models` 실측 크기가 Phase 0의 절반 수준. `pytorch_model.bin` 부재 |

### 축 C — 격리

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C11 | 앱의 모든 Python 프로세스가 번들 런타임을 쓴다 | worker·embed·`--once`의 `sys.executable`·`sys.prefix`·`sys.path`를 `supervisor.log`에 자기 보고. 전부 `Resources/python` 아래 (dev는 `desktop/build/python`) |
| P4-C12 | 번들 밖 런타임·도구를 열지 않는다 | 처리 중 `lsof -p <각 pid>`에 `/opt/homebrew`·`be/worker/.venv`·`~/.local`·`/Library/Frameworks/Python.framework` 0건 |
| P4-C13 | 실제 쓰인 ffmpeg·ffprobe·`mlx_lm.server`가 번들 것이다 | 처리 중 `ps -axo args`와 `lsof`로 경로 확인 |
| P4-C14 | 모델·캐시가 `.app` 밖에 있고 `.app`을 교체해도 재사용된다 | `.app` 지우고 다시 빌드·설치 → 모델 재다운로드 0 |
| P4-C15 | `.app`에 arm64 무서명 Mach-O 0건, 개발 머신 경로 문자열 0건 | `check-bundle.mjs` — `codesign --verify --arch arm64` 전수, 금지 문자열 스캔 |

### 축 D — 수명주기

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C16 | ⌘Q 뒤 앱이 만든 Python 프로세스가 하나도 안 남는다 | `mlx_lm.server`가 뜬 렌즈 job 중 ⌘Q → `ps`에 `--run-id` 0건 |
| P4-C17 | 앱 강제 종료 뒤 남은 고아를 다음 실행이 정리한다 | `kill -9` main → 고아 확인 → 재실행 → 옛 `--run-id` 사라짐, 새 것만 |
| P4-C18 | 자손 SIGKILL 4단계가 실제로 발화한다 | SIGTERM을 무시하는 자식으로 유예 초과를 유도. Phase 2가 못 밟은 경로 |
| P4-C19 | 외부 `pnpm worker`는 앱이 손대지 않고 종료 뒤에도 산다 | Phase 2 P2-C6 재실행. `--run-id` 없는 프로세스는 대상 아님 |

### 축 E — 회귀와 데이터 보존

| ID | 기준 | 확인 |
| --- | --- | --- |
| P4-C20 | dev에서 worker 소스 수정이 재빌드 없이 반영된다 | `damwha_worker/__main__.py`에 로그 한 줄 추가 → `pnpm desktop:dev` 재기동 → 그 줄이 나온다 |
| P4-C21 | 기존 웹 흐름에 회귀가 없다 | `pnpm build`·`test`·`lint` 통과. `pnpm worker`·`pnpm embed`가 `.venv`로 기동하고 job을 처리한다 |
| P4-C22 | 기존 DB·저장소·개발 자산이 불변이다 | `damwha_pgdata`·`be/storage`·`be/worker/.venv`·`be/worker/.env`·`~/.cache/huggingface` 체크섬이 기준선과 같다. userData `data/`도 |
| P4-C23 | numba 사망 지점이 측정되고 그 결과가 문서에 있다 | §6.8 A/B 결과와 조치가 결과 문서에 |

### 비고 — 단위 테스트로만 판정하는 것

- `safeStorage` 사용 불가 경로 (Keychain을 실제로 잠그기 어렵다).
- 복호화 실패 경로 (파일을 손상시켜 재현하되 실사용 발화는 아니다).
- 디스크 부족 안내 문구.

---

## 10. 제품 코드 변경 목록

**desktop/**

| 파일 | 변경 |
| --- | --- |
| `scripts/build-python.sh` | 신규 |
| `scripts/build-ffmpeg.sh` | 신규 |
| `scripts/python-checksums.txt`·`ffmpeg-checksums.txt` | 신규 |
| `scripts/package.mjs` | 두 스크립트 호출 추가 |
| `scripts/check-bundle.mjs` | Python·ffmpeg 트리·서명·문자열 검사 |
| `build-resources/entitlements.mac.plist` | 신규 |
| `src/process/python-launcher.ts` | `uv-launcher.ts` 대체 |
| `src/process/executables.ts` | 번들 경로를 PATH 앞에 |
| `src/process/runtime-paths.ts` | 신규 — `pgBinaries`와 같은 모양의 `pythonBinaries`·`ffmpegBinaries` |
| `src/process/orphans.ts` | 신규 — `--run-id` 스캔과 정리 |
| `src/services/worker.ts` | `.env`·uv 검사 제거, `--run-id` |
| `src/services/embed.ts` | `-m` 진입, 채택 규칙 좁힘 |
| `src/config/config.ts` | `UV_BIN` 제거, `HF_TOKEN` 앱 소유 키 |
| `src/config/token-store.ts` | 신규 — `safeStorage` 읽기·쓰기 |
| `src/windows/token-window.ts` | 신규 — 온보딩 화면 |
| `src/windows/status-view.ts` | 모델 준비·토큰 항목 |
| `src/diagnostics/causes.ts` | §8의 원인 |
| `src/main.ts` | 토큰 게이트와 고아 정리를 기동 흐름에 |

**be/worker/**

| 파일 | 변경 |
| --- | --- |
| `pyproject.toml` | `mlx` 명시 고정 |
| `damwha_worker/config.py` | `ffmpeg_bin`·`ffprobe_bin` |
| `damwha_worker/pipeline/ffmpeg.py` | 바이너리를 인자로 |
| `damwha_worker/pipeline/process_meeting.py`·`enroll_speaker.py` | `partial`로 묶어 주입 |
| `damwha_worker/embed_service.py` | `if __name__ == "__main__"` |
| `damwha_worker/__main__.py` | `--run-id` 전파, 런타임 자기 보고 로그 |
| `damwha_worker/llm_server.py` | `--run-id` 전파 |
| `damwha_worker/models/bge_embed.py` | 리비전 고정·safetensors 단일 |
| `damwha_worker/models/downloads.py` | 신규 — HF 진행 훅 → `model_readiness` |
| `damwha_worker/db/core.py` | `model_readiness` upsert (merge) |

**be/**

| 파일 | 변경 |
| --- | --- |
| `src/system/capabilities.ts` 인접 | `model_readiness` 읽기 |
| 설정 조회 응답 | `modelReadiness` 필드 |

**fe/** — 모델 준비 표시. 최소 범위.

---

## 11. 빌드와 실행 흐름

```
pnpm desktop:dev
  build-postgres.sh (캐시) → build-python.sh (캐시) → build-ffmpeg.sh (캐시)
  → tsc → electron .            [PYTHONPATH=<repo>/be/worker]

pnpm desktop:build
  build-postgres.sh → build-python.sh → build-ffmpeg.sh
  → be build → fe build → pnpm deploy → SPA 복사
  → electron-builder --dir → ad-hoc 서명 → check-bundle.mjs
```

첫 `build-python.sh`는 1.5 GB를 만든다 — 다운로드·설치·서명까지 수십 분. 캐시가 있으면
스테이징(복사)만 한다.

---

## 12. 미확정 사항

| 항목 | 언제 정해지나 |
| --- | --- |
| numba 사망 지점과 `allow-jit` 필요 여부 | **Task 1의 측정.** 계획이 그 결과로 갱신된다 (§6.8) |
| `LENS_LLM_BASE_URL`의 포트 선정 — 고정 포트 vs 빈 포트 탐색 | 구현 중. embed의 `freePort()` 선례가 있다 |
| 모델 준비 FE 표시의 위치·형태 | 구현 중. DESIGN.md 관례를 따른다 |
| `.app` 최종 크기 | 빌드 뒤 실측. 예상 1.6~1.8 GB |

**미확정이지만 구현을 막지 않는 것**만 여기 있다. 범위·계약·데이터 안전에 걸리는 미확정은
없다.

---

## 13. 기술 위험

| ID | 위험 | 막는 것 |
| --- | --- | --- |
| R4-1 | 번들을 옮기면 조용히 다른 런타임을 실행한다 (Phase 0 R-6) | `-m` 진입(셔뱅 미경유) + 빌드 셔뱅 재배치 + P4-C11의 `sys.executable` 자기 보고 |
| R4-2 | 무서명 `.so` 하나가 남아 특정 모델에서만 죽는다 | 빌드 전수 서명 + `check-bundle.mjs`의 `--arch arm64` 전수 검사 (P4-C15) |
| R4-3 | numba가 메시지 없이 SIGKILL한다 | §6.8의 A/B 측정을 Task 1에 둔다 |
| R4-4 | PATH 폴백이 남아 Homebrew ffmpeg가 조용히 쓰인다 | P4-C12·C13을 PATH가 아니라 `lsof`·`ps`로 판정 |
| R4-5 | 고아 정리가 남의 프로세스를 죽인다 | `--run-id` 있고 내 것이 아닌 것만. 표식 없는 것은 stand-down |
| R4-6 | `model_readiness`를 여러 writer가 덮어쓴다 | `key` 단위 merge. 통째 덮기 금지 (§6.9) |
| R4-7 | 토큰이 로그·화면에 샌다 | 마스킹 + P4-C2의 전수 grep |
| R4-8 | 1.5 GB 번들이 빌드·서명 시간을 크게 늘린다 | 캐시 키로 재빌드 회피. 첫 회차만 수십 분 |
| R4-9 | `.env` 검사를 지우면서 필수 env 하나를 빠뜨려 worker가 `ValidationError`로 죽는다 | §6.3 표가 목록이다. `LENS_LLM_BASE_URL`이 기본값 없는 유일한 필수 키 |
| R4-10 | dev `PYTHONPATH`와 packaged site-packages의 버전이 갈려 dev에서만 되는 현상 | 자기 보고가 `sys.path[0]`을 적는다. P4-C20이 반영을 확인하되 packaged 검증은 별도 |

---

## 14. 로드맵 완료 기준과의 대응

| 로드맵 기준 | 이 스펙의 기준 |
| --- | --- |
| 개발 도구가 없는 지원 대상 맥에서 모델 준비 후 전사·화자 분리·요약·검색 성공 | P4-C5, C6, C7, C8, C11, C12, C13 |
| 앱 번들 외부의 개발용 가상환경이나 도구를 참조하지 않음 | P4-C11, C12, C13, C15 |
| 모델과 캐시가 앱 패키지 외부에 저장되어 재실행 시 재사용됨 | P4-C9, C10, C14 |

로드맵 범위의 "모델 이용 동의·토큰 설정과 초기 준비 상태 안내"는 축 A 전체와 P4-C6·C8이 받는다.

"개발 도구가 없는 지원 대상 맥"은 **이 맥에서 런타임 자기 보고와 `lsof`로 증명한다** —
Phase 0이 별도 계정을 기각하며 세운 방식의 확장이다. 깨끗한 다른 맥에서의 실제 독립 설치
검증은 로드맵이 Phase 6에 두고 있다.

---

## 15. 후속 Phase에 넘기는 것

**Phase 5**
- 기존 데이터 이전 — Docker DB·`be/storage`·`~/.cache/huggingface`의 기존 모델을
  `<userData>/models`로 옮길지 결정.
- 잠자기·복귀, 디스크 부족 중 모델 다운로드·처리 동작.
- 중단된 다운로드의 부분 파일 위생 (HF hub가 남기는 `.incomplete`).

**Phase 6**
- G1 허용 목록 24건 재검토와 실동작 폴백 3건(`soundfile.py`·`ctypes/macholib/dyld.py`·
  `PIL/_imagingft…so`) 미사용 증명 — P0-C7의 조건부 충족을 닫는다.
- `Resources/python`·`Resources/ffmpeg`의 Developer ID 서명·hardened runtime·공증.
  1.5 GB 트리의 공증 시간이 이 Phase에서 처음 드러난다.
- R-12 (Team ID 기반 library validation) — ad-hoc 서명에서는 재현 불가.
- 앱 업데이트 시 두 런타임 버전 공존 — Phase 0 R-6의 셔뱅 함정이 실제로 나타나는 조건.
- 소스 아카이브 서명 검증과 재현 가능 빌드.
- job lease token.

---

## 16. 산출물

- 이 스펙.
- 구현 계획 `docs/superpowers/plans/2026-09-16-electron-phase-4-embedded-python-runtime.md`.
- 결과 문서 `docs/superpowers/reports/2026-09-16-electron-phase-4-embedded-python-runtime-results.md`.
- 제품 코드 (§10).
- 로드맵·`desktop/CLAUDE.md`·`be/worker` 문서 갱신.

---

## 17. 외부 리뷰 기록

(스펙 리뷰에서 채운다.)
