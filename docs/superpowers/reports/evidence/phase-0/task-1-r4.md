# 검증 증거 — Task 1 (4회차, 계획 수정 커밋 2b8d49d 반영 후)

- 커밋: `f12157054a687ee2e2e51fb9597689ddda244b3f` (`git -C <worktree> rev-parse HEAD` 실측, COMMIT 지정값 `f121570`과 접두사 일치)
- 이전 회차: 17bae8d(1) → f1e1dff(2) → 961029f(3) → f121570(4, 이번)
- 환경:
  - `node --version`: `v22.21.1` (`/Users/gim-yeongjae/.nvm/versions/node/v22.21.1/bin/node`)
  - `pnpm --version`: `10.26.0`
  - `python3 --version` (쉘 기본, 이 verifier 자신의 셸): `Python 3.10.21` (`python3: aliased to python3.10`) — 격리 실행(`run-isolated.sh`) 안에서 보이는 `python3`은 이것과 다르며 V3에서 별도로 기록됨 (`/usr/bin/python3`, `PYPREFIX=/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9`)
  - Docker: `damwha-postgres` 컨테이너가 `running` 상태로 `0.0.0.0:5432->5432/tcp`에 떠 있음(개발 DB, 건드리지 않음). `blog-minio`, `blog-postgres`도 별도로 떠 있음(본 검증과 무관)
  - 실험 DB(55432)·mlx_lm.server(58000)·embed(58100) 서비스는 이번 회차에 기동하지 않음 (Task 1 Verify는 그것을 요구하지 않음)
- 실행 일시: 2026-09-09T07:36:38Z 시작 (UTC, `date -u`), 실행 로그의 UTC 타임스탬프는 07:36~07:38Z 구간

계획 문서 재확인: `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md`를 다시 읽었다. "## 런처 스크립트의 dyld 실측 규칙" 절에 규칙 2b·3b·6이 추가된 상태(현재 파일 49~171행)를 확인했다. Task 1 Verify 표(139~154행)의 V1~V12를 표에 적힌 순서·명령 그대로 실행했다.

---

## V1. `bash experiments/electron-phase-0/lib/preflight.sh 5`
- cwd: `<repo root>` (`/Users/gim-yeongjae/project/daewha-electron-phase-0`)
- 기대: exit 0. 포트 55432·58000·58100이 `free`로 출력
- 실제:
  ```
  55432 (실험 DB): free
  58000 (mlx_lm.server): free
  58100 (embed): free
  판정      : 충분
  ```
  (`be/storage(읽기 전용 원본): /Users/gim-yeongjae/project/daewha/be/storage` — 워크트리가 아니라 메인 저장소 경로를 가리킴, `config.sh`의 경로 해석 결과 그대로 기록)
- 일치: 예 (포트 3개 모두 `free`로 출력, exit 0)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
preflight.sh — 사전 점검

디스크
  대상 경로 : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0
  마운트    : /System/Volumes/Data
  여유      : 22 GiB
  필요      : 5 GiB
  판정      : 충분

포트 (개발 기본값 5432 / 8000 / 8100과 분리된 실험 포트, 스펙 §7.1 U-6)
  55432 (실험 DB): free
  58000 (mlx_lm.server): free
  58100 (embed): free

검사 도구 (스펙 §4.0 — 피검사 대상이 아니라 측정 수단이다)
  otool: /usr/bin/otool
  file: /usr/bin/file
  lsof: /usr/sbin/lsof
  shasum: /usr/bin/shasum
  df: /bin/df

be/storage(읽기 전용 원본): /Users/gim-yeongjae/project/daewha/be/storage
EXIT:0
```
</details>

## V2. `bash experiments/electron-phase-0/verify/t1-env-allowlist.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 실행의 환경 변수 집합이 스펙 §4.2 표의 12개 이름과 정확히 일치하고, `VIRTUAL_ENV`·`PYTHONPATH`·`UV_*`가 없음
- 실제: 자식 프로세스 변수 이름 12개(`DATABASE_URL, EMBED_SERVICE_HOST, EMBED_SERVICE_PORT, HF_HOME, HF_TOKEN, HOME, LENS_LLM_BASE_URL, LENS_LLM_SERVER_BIN, MODEL_CACHE_DIR, PATH, STORAGE_ROOT, TMPDIR`) 나열, `OK  주입 변수 11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)가 정확히 일치한다`, `OK  VIRTUAL_ENV / PYTHONPATH / PYTHONHOME / UV_* / HUGGINGFACE_HUB_CACHE 가 모두 없다`
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-env-allowlist.sh — G2 주입 화이트리스트 검사 (스펙 §4.2)
run-isolated: label=t1-env  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.FST52M/stderr.raw)

자식 프로세스의 변수 이름 (값은 출력하지 않는다):
  DATABASE_URL
  EMBED_SERVICE_HOST
  EMBED_SERVICE_PORT
  HF_HOME
  HF_TOKEN
  HOME
  LENS_LLM_BASE_URL
  LENS_LLM_SERVER_BIN
  MODEL_CACHE_DIR
  PATH
  STORAGE_ROOT
  TMPDIR

OK  주입 변수 11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)가 정확히 일치한다
OK  VIRTUAL_ENV / PYTHONPATH / PYTHONHOME / UV_* / HUGGINGFACE_HUB_CACHE 가 모두 없다
OK  HF_TOKEN 주입 상태가 be/worker/.env와 일치한다 (set=1)
OK  증거에 HF_TOKEN이 set/unset으로만 적혀 있다
OK  증거 디렉터리 어디에도 HF_TOKEN 값이 없다
EXIT:0
```
</details>

## V3. `bash experiments/electron-phase-0/verify/t1-no-dev-tools.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 안에서 `ffmpeg`·`uv`·`node`를 찾을 수 없고, `python3`은 `/usr/bin/python3`이며 `sys.prefix`가 `/Library/Frameworks/Python.framework`도 `.venv`도 아님
- 실제: `TOOL ffmpeg (not found)`, `TOOL uv (not found)`, `TOOL node (not found)`, `TOOL python3 /usr/bin/python3`, `PYPREFIX /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9`, `OK  sys.prefix가 머신 전역 Python.framework도 개발 가상환경도 아니다`
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-no-dev-tools.sh — 격리 안의 도구 가시성 (스펙 §4.2)
run-isolated: label=t1-nodev  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.53pRSz/stderr.raw)

  TOOL ffmpeg (not found)
  TOOL ffprobe (not found)
  TOOL uv (not found)
  TOOL node (not found)
  TOOL npm (not found)
  TOOL pnpm (not found)
  TOOL psql (not found)
  TOOL pg_ctl (not found)
  TOOL initdb (not found)
  TOOL mlx_lm.server (not found)
  TOOL python3 /usr/bin/python3
  PYPREFIX /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9
  PYEXE /Library/Developer/CommandLineTools/usr/bin/python3

OK  ffmpeg: 격리 안에서 찾을 수 없다
OK  ffprobe: 격리 안에서 찾을 수 없다
OK  uv: 격리 안에서 찾을 수 없다
OK  node: 격리 안에서 찾을 수 없다
OK  npm: 격리 안에서 찾을 수 없다
OK  pnpm: 격리 안에서 찾을 수 없다
OK  mlx_lm.server: 격리 안에서 찾을 수 없다 (uv tool 설치본이 배제됐다)
OK  python3: /usr/bin/python3 (OS 제공)
정보 sys.prefix = /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9
OK  sys.prefix가 머신 전역 Python.framework도 개발 가상환경도 아니다
정보 이 python3은 Command Line Tools가 주는 OS 기본 인터프리터다.
     번들 구성요소가 아니라 격리를 재는 **측정 수단**이므로 G1 금지
     문자열 규칙의 대상이 아니다 (스펙 §4.0 검사 도구 행).
EXIT:0
```
</details>

## V4. `bash experiments/electron-phase-0/verify/t1-home-isolated.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$HOME`이 `experiments/electron-phase-0/sandbox/home`이고 개발자 홈의 `.cache`·`.local`이 보이지 않음
- 실제: `HOME /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home`, `OK  HOME 경로가 계획의 $SANDBOX/home 규약과 같다`, `OK  격리 HOME에 .local이 없다`, `정보 개발자 HF 캐시 id: 16777233:750166329 / 격리 HF 캐시 id: 16777233:846849250`
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-home-isolated.sh — HOME 격리 검사 (스펙 §4.2)
run-isolated: label=t1-home  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.hzi3GC/stderr.raw)

  HOME /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home
  HOME_REAL /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home
  TMPDIR /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp
  HF_HOME /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
  MODEL_CACHE_DIR /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/damwha-models
  STORAGE_ROOT /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/storage
  HFCACHE_ID 16777233:846849250
  HFHUB_ENTRIES 0
  DOTLOCAL absent

OK  HOME이 샌드박스다: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home
OK  HOME 경로가 계획의 $SANDBOX/home 규약과 같다
OK  HOME의 실경로가 샌드박스 안이다 (심볼릭 링크 탈출 없음)
OK  TMPDIR 가 샌드박스 하위다
OK  HF_HOME 가 샌드박스 하위다
OK  MODEL_CACHE_DIR 가 샌드박스 하위다
OK  STORAGE_ROOT 가 샌드박스 하위다
정보 개발자 HF 캐시 id: 16777233:750166329 / 격리 HF 캐시 id: 16777233:846849250
OK  격리 안의 HF 캐시가 개발자 캐시와 다른 디렉터리다
정보 격리 HOME의 HF hub 항목 수: 0 (개발자 캐시 40 GB가 보였다면 이 값이 클 것이다)
OK  격리 HOME에 .local이 없다 (uv tool 설치본이 배제됐다)
EXIT:0
```
</details>

## V5. `bash experiments/electron-phase-0/verify/t1-detector-negative.sh`
- cwd: `<repo root>`
- 기대: exit 0. **음성 대조군** — (a) `check-macho.sh /opt/homebrew/bin`이 위반을 실제로 검출, (b) 재배치 잔존 경로 3형태(shebang·`pyvenv.cfg`·`*.pc`)가 각각 위반으로 잡힘, (c) re-export 없는 런처가 dyld 0건, 있는 런처가 1건 이상일 때만 통과
- 실제: 아래 세 조건 각각의 단정 줄을 원문 그대로 인용.

  **(a) 실물 대조군 — `check-macho.sh /opt/homebrew/bin`**
  ```
  == B. 실물 대조군 — check-macho.sh /opt/homebrew/bin
    OK   비정상 종료했다 (exit 1)
      검출한 위반 줄 수: 6
        위반          : 6건
  ```

  **(b) 재배치 잔존 경로 3형태**
  ```
    OK   재배치 잔존 경로를 검출했다: stale-shebang
    OK   재배치 잔존 경로를 검출했다: stale-pyvenv.cfg
    OK   재배치 잔존 경로를 검출했다: stale-pkgconfig.pc
  ```
  (개별 위반 줄, `A. 합성 대조군` 섹션에서)
  ```
  STALE-PATH .../g1-detector-fixture/stale-pkgconfig.pc: .../sandbox/stale-prefix  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
  STALE-PATH .../g1-detector-fixture/stale-pyvenv.cfg: .../downloads/cpython/bin  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
  STALE-PATH .../g1-detector-fixture/stale-shebang: .../stage/python/bin/python3  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
  ```

  **(c) 런처 dyld 대조군 D1(re-export 없음)·D2(re-export 있음)**
  ```
  == D. 런처 dyld 대조군 — re-export 없음 / 있음 / 가짜 증거
  run-isolated: label=t1-dyld-launcher-noexport  ...
    OK   D1: re-export 없는 런처는 dyld 0건이다 (SIP가 /bin/bash exec에서 지웠다)
    OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다 — 통과로 집계되지 않는다
  run-isolated: label=t1-dyld-launcher-reexport  ...
    OK   D2: re-export 있는 런처는 dyld 81건을 실측했다 (pid: 25951 )
    OK   D2: pid 25951가 자식 Mach-O를 로드했다 — 검증 대상이 실제로 측정됐다
  ```

  **D3(가짜 증거 대조군) — 단정 줄**
  ```
  run-isolated: label=t1-dyld-launcher-fake  ...
    OK   D3: 가짜 증거 런처가 dyld 82건을 남겼다 — 줄 수만 보면 통과처럼 보인다
    OK   D3: 자식 Mach-O를 로드한 pid가 없다고 올바로 판정했다 (pid: 26019 )
    정보 파일 전체를 grep하면 이 가짜 증거도 매치된다 (헤더의 # argv: 줄).
         ^dyld 줄로 한정해야 하는 이유다 (규칙 6).
  ```
  마지막에 `모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다`
- 일치: 예 (A/B/C/D 전 구간 `FAIL` 0건, 스크립트가 exit 0으로 뒤집어 반환)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== A. 합성 대조군 — 금지 문자열 9종 + otool -L + LC_RPATH
  금지 문자열 대조 파일 9개 생성
  OK   check-macho.sh가 비정상 종료했다 (exit 1)
    check-macho.sh (G1, 스펙 §4.1)
      대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture
      파일 수       : 14
      Mach-O 수     : 2
      금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
      문자열 후보   : 12개 파일
      검사 대상 내부 절대경로(INFO): 0건
      위반          : 14건
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-1.txt: /opt/homebrew/g1-detector-probe  (금지 문자열: /opt/homebrew)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-2.txt: /Library/Frameworks/Python.framework/g1-detector-probe  (금지 문자열: /Library/Frameworks/Python.framework)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-3.txt: /usr/local/bin/g1-detector-probe  (금지 문자열: /usr/local/bin)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-4.txt: /usr/local/lib/g1-detector-probe  (금지 문자열: /usr/local/lib)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-5.txt: /usr/local/Cellar/g1-detector-probe  (금지 문자열: /usr/local/Cellar)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-6.txt: /usr/local/opt/g1-detector-probe  (금지 문자열: /usr/local/opt)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-7.txt: /Users/gim-yeongjae/g1-detector-probe  (금지 문자열: /Users/gim-yeongjae)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-8.txt: /.venv/g1-detector-probe  (금지 문자열: /.venv)
        STRING  /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/pattern-9.txt: /Library/Developer/CommandLineTools/g1-detector-probe  (금지 문자열: /Library/Developer/CommandLineTools)
        STALE-PATH /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/stale-pkgconfig.pc: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/stale-prefix  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        STALE-PATH /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/stale-pyvenv.cfg: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/downloads/cpython/bin  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        STALE-PATH /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/stale-shebang: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/stage/python/bin/python3  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        OTOOL-L /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/dep-bad: /tmp/g1-detector-probe/libSystem.B.dylib  (허용 접두사가 아니다)
        LC_RPATH /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture/rpath-bad: /tmp/g1-detector-probe-rpath  (번들 밖 절대 경로)
  OK   금지 문자열 9종을 모두 검출했다 (스펙 §4.1 표 7행 전부)
  OK   otool -L 의존 경로 위반을 검출했다
  OK   LC_RPATH 위반을 검출했다
  OK   재배치 잔존 경로를 검출했다: stale-shebang
  OK   재배치 잔존 경로를 검출했다: stale-pyvenv.cfg
  OK   재배치 잔존 경로를 검출했다: stale-pkgconfig.pc
  OK   fat 바이너리 경로를 아키텍처 꼬리표 없이 다뤘다

== B. 실물 대조군 — check-macho.sh /opt/homebrew/bin
  OK   비정상 종료했다 (exit 1)
    검출한 위반 줄 수: 6
      위반          : 6건

== C. dyld 실측 대조군 — 플랫폼 바이너리가 아닌 Mach-O
run-isolated: label=t1-dyld-control  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.qJoqBk/stderr.raw)
  OK   dyld 줄 81건을 실측했다
    dyld[25819]: <1847B2BD-6C7D-3600-82B0-AC6B5F8F823F> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g2-dyld-control/echo
    dyld[25819]: <4FDC9AA6-B344-37FE-B8C6-A4C94A038F57> /usr/lib/libSystem.B.dylib
    dyld[25819]: <83E81326-A587-374F-ABC1-BAE48D0FEE0D> /usr/lib/system/libcache.dylib

== D. 런처 dyld 대조군 — re-export 없음 / 있음 / 가짜 증거
run-isolated: label=t1-dyld-launcher-noexport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.TOXReo/stderr.raw)
  OK   D1: re-export 없는 런처는 dyld 0건이다 (SIP가 /bin/bash exec에서 지웠다)
  OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다 — 통과로 집계되지 않는다
run-isolated: label=t1-dyld-launcher-reexport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.FpPgMd/stderr.raw)
  OK   D2: re-export 있는 런처는 dyld 81건을 실측했다 (pid: 25951 )
  OK   D2: pid 25951가 자식 Mach-O를 로드했다 — 검증 대상이 실제로 측정됐다
run-isolated: label=t1-dyld-launcher-fake  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.Gtwb4X/stderr.raw)
  OK   D3: 가짜 증거 런처가 dyld 82건을 남겼다 — 줄 수만 보면 통과처럼 보인다
  OK   D3: 자식 Mach-O를 로드한 pid가 없다고 올바로 판정했다 (pid: 26019 )
  정보 파일 전체를 grep하면 이 가짜 증거도 매치된다 (헤더의 # argv: 줄).
       ^dyld 줄로 한정해야 하는 이유다 (규칙 6).

모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다
EXIT:0
```
</details>

### D3 실측 수치 정밀 대조 (이번 회차 중점 지시 1)

`$EVIDENCE/t1-dyld-launcher-fake-dyld.txt` (스크립트가 새로 만든 최신 내용, `t1-dyld-launcher-fake-dyld.prev-20260909T073726Z.txt`로 이전 회차분이 자동 이관됨)에 대해 직접 셌다. 자식 Mach-O 경로는 `/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g2-dyld-control/echo`.

파일 헤더(1~3행) 원문:
```
# run-isolated.sh dyld 실측
# label: t1-dyld-launcher-fake   utc: 2026-09-09T07:37:25Z   exit: 0   dyld 줄 수: 82
# argv: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g2-dyld-control/launch-fake.sh /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g2-dyld-control/echo
```
4행부터 `dyld[26019]: <UUID> /usr/lib/...` 형태로 82줄 이어짐 (예시 4~7행은 위 V5 D3 섹션 참조).

세 수의 실측값 (변수 대입으로 세어 `grep -c`의 exit 1 이중 출력 문제를 피함):

| 항목 | 실측값 |
| --- | --- |
| `^dyld` 로 시작하는 줄의 수 (`grep -c '^dyld' "$F"`) | **82** |
| 그 dyld 줄들 중 자식 Mach-O 경로(`.../g2-dyld-control/echo`)가 마지막 필드(`$NF`)인 줄의 수 (`awk '/^dyld\[/ && $NF==b {c++} END{print c+0}'`) | **0** |
| 파일 전체를 대상으로 자식 경로를 `grep -F`했을 때의 매치 수 (`grep -c -F -- "$CHILD" "$F"`) | **1** (3행의 `# argv:` 헤더에만 매치) |

세 수의 대비: dyld 줄은 82건 있지만 그중 자식 바이너리를 실제로 로드한 것은 0건이다. 그런데 파일 전체를 grep하면 자식 경로가 1건 매치되는데, 이는 `^dyld` 줄이 아니라 헤더의 `# argv:` 줄에서 나온 매치다 — 계획 규칙 6이 경고하는 함정을 그대로 재현했다.

### 판독 함수 원문과 직접 실행 결과 (이번 회차 중점 지시 2)

`t1-detector-negative.sh` 196~220행에서 그대로 옮김:
```bash
dyld_lines() {
  local n
  n=$(grep -c '^dyld' "$1" 2>/dev/null)
  case "$n" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$n" ;;
  esac
}

dyld_pid_for() {
  awk -v b="$2" '
    /^dyld\[/ && $NF == b {
      p = $1; sub(/^dyld\[/, "", p); sub(/\]:$/, "", p); print p; exit
    }' "$1" 2>/dev/null
}

dyld_pids() {
  awk '/^dyld\[/ { p = $1; sub(/^dyld\[/, "", p); sub(/\]:$/, "", p); print p }' "$1" 2>/dev/null \
    | sort -u | tr '\n' ' '
}
```

위 정의를 그대로 셸에 로드하고 `dyld_pid_for "$EVIDENCE/t1-dyld-launcher-fake-dyld.txt" "$CHILD"`를 직접 호출한 결과:
```
dyld_pid_for 결과: '' (빈 문자열이면 정상)
```
빈 문자열이 나왔다. `$NF == b` 조건이 `^dyld\[` 줄에만 적용되므로 헤더의 `# argv:` 줄(3행, `^dyld`로 시작하지 않음)에는 걸리지 않는다.

## V6. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/lib`
- cwd: `<repo root>`
- 기대: exit 0. **양성 대조군** — 위반 없는 입력에서 오탐 없음
- 실제: `파일 수 : 7`, `Mach-O 수 : 0`, `위반 : 0건`
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/lib
  파일 수       : 7
  Mach-O 수     : 0
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 1개 파일
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
EXIT:0
```
</details>

## V7. `bash experiments/electron-phase-0/verify/t1-evidence-tracked.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$EVIDENCE`의 `.md`/`.txt`가 gitignore에 걸리지 않고, 디렉터리에 `.log` 파일이 없음
- 실제: `OK   .log는 무시된다`, `OK   .txt 는 무시되지 않는다`, `OK   .md 는 무시되지 않는다`, `OK   .../phase-0 에 .log 파일이 없다`, `OK   증거 파일 32개` (V2~V5 재실행으로 각 라벨의 `-dyld.txt`/`-env.txt`가 갱신되고 이전 내용이 `*.prev-<타임스탬프>.txt`로 자동 이관되어, 3회차 종료 시점보다 파일 수가 늘어남 — 아래 "프로세스 정리"·"증거 디렉터리" 절 참조)
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-evidence-tracked.sh — 증거 경로와 gitignore (스펙 §6)
  EVIDENCE: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0
  OK   .log는 무시된다 — 스펙 §6의 근거가 지금도 참이다
  OK   .txt 는 무시되지 않는다
  OK   .md 는 무시되지 않는다
  OK   /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0 에 .log 파일이 없다
  OK   증거 파일 32개
    docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T073725Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T073725Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-dyld.prev-20260909T073726Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-env.prev-20260909T073726Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.prev-20260909T073725Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.prev-20260909T073725Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.prev-20260909T073725Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.prev-20260909T073725Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T073657Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T073657Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T073702Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T073702Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T073700Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T073700Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-env.txt
    docs/superpowers/reports/evidence/phase-0/task-1-r1.md
    docs/superpowers/reports/evidence/phase-0/task-1-r2.md
    docs/superpowers/reports/evidence/phase-0/task-1-r3.md

  experiments/electron-phase-0/.gitignore 동작 확인
  OK   sandbox/ 는 무시된다
  OK   stage/ 는 무시된다
  OK   bundle/ 는 무시된다
  OK   pgdata/ 는 무시된다
  OK   run/ 는 무시된다
  OK   downloads/ 는 무시된다
  OK   signed/ 는 무시된다
  OK   lib/config.sh 는 커밋 대상이다
  OK   verify/t1-evidence-tracked.sh 는 커밋 대상이다
  OK   probe/deps-survey.md 는 커밋 대상이다
EXIT:0
```
</details>

## V8. `grep -q 'U-4' experiments/electron-phase-0/probe/deps-survey.md && grep -q 'U-5' experiments/electron-phase-0/probe/deps-survey.md`
- cwd: `<repo root>`
- 기대: exit 0
- 실제: 출력 없음 (grep -q), 셸 `&&` 체인 전체가 성공
- 일치: 예
- 종료 코드: 0

## V9. `test -f experiments/electron-phase-0/sandbox/audio/sample.flac && grep -q 'mtg_' experiments/electron-phase-0/probe/audio-source.txt`
- cwd: `<repo root>`
- 기대: exit 0. 검증 오디오가 복사됐고 출처가 기록됨
- 실제: 출력 없음, exit 0
- 일치: 예
- 종료 코드: 0

## V10. `test ! -f experiments/electron-phase-0/package.json`
- cwd: `<repo root>`
- 기대: exit 0. pnpm 워크스페이스 멤버가 아님
- 실제: 출력 없음, exit 0 (`experiments/electron-phase-0/package.json` 없음 확인)
- 일치: 예
- 종료 코드: 0

## V11. `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts`
- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음
- 일치: 예
- 종료 코드: 0

## V12. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh before && bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`
- cwd: `<repo root>`
- 기대: exit 0. `be/storage` 원본 무변화
- 실제: `before` 실행이 `## be/storage` 섹션에 `manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`를 기록했고, `after` 실행이 `개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다`를 출력하며 동일한 `manifest_sha256`(`a18870e6...91be`)을 다시 기록. `files: 29`, `bytes: 2227477523`, `newest_mtime: 1788857034` 값도 before/after 동일. 표에 적힌 대로 단일 `&&` 체인 명령으로 실행해 exit 0을 재확인했고, `before`/`after`를 별도 호출로 나눠 재실행한 결과도 동일했다(각각 exit 0, 재실행 케이스는 별도 기록).
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력 (표에 적힌 그대로 단일 &&-체인 실행)</summary>

```
before 기록: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/state/dev-assets-before.txt
## docker volumes
2deac09559ef79effc56c7230c228d0109d309fc4f208051ecc08c1c65c9ccc0
3a0f65c5f8709d0b6b08af645aeb746d96a340603e1d37a12d4413556a16f984
3a559c09626e43a1c2538d4173f17ecb0c710a9cabac042b7d0517f6f3a3d95e
564b2a00aa80cb4b3795532907244d41dd6e245eae5d921bdf32a9bc9425830c
7a6f325733f01c9cf627f80691db77ed6a4ebd06325108e804f01e6b140e5f81
be_pgdata
blog-local_minio_data
blog-local_postgres_data
c9975fd05f0848f0fe72889a84bf13ae1eb2b20bfbea00828398f19ab845473e
damwha_pgdata
docker_mariadb-local-data
e33e9714513e13422fdd6cb4081a173df3460999fde456bd8294619ad0facb52
redpanda_redpanda-data
trb_db_db_data
trb_db_db_logs
## be/storage
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다
## docker volumes
2deac09559ef79effc56c7230c228d0109d309fc4f208051ecc08c1c65c9ccc0
3a0f65c5f8709d0b6b08af645aeb746d96a340603e1d37a12d4413556a16f984
3a559c09626e43a1c2538d4173f17ecb0c710a9cabac042b7d0517f6f3a3d95e
564b2a00aa80cb4b3795532907244d41dd6e245eae5d921bdf32a9bc9425830c
7a6f325733f01c9cf627f80691db77ed6a4ebd06325108e804f01e6b140e5f81
be_pgdata
blog-local_minio_data
blog-local_postgres_data
c9975fd05f0848f0fe72889a84bf13ae1eb2b20bfbea00828398f19ab845473e
damwha_pgdata
docker_mariadb-local-data
e33e9714513e13422fdd6cb4081a173df3460999fde456bd8294619ad0facb52
redpanda_redpanda-data
trb_db_db_data
trb_db_db_logs
## be/storage
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
EXIT:0
```
</details>

---

## `run-isolated.sh` 의 `MEASUREMENT_UNAVAILABLE` 문구 (이번 회차 중점 지시 4)

**헤더 주석 원문** (`experiments/electron-phase-0/lib/run-isolated.sh` 27~34행):
```
# dyld 줄이 0건이면 증거 파일 첫 줄에 MEASUREMENT_UNAVAILABLE을 적는다
# (스펙 §4.2, P0-C7). 원인은 둘이고, 이 래퍼는 둘을 구분하지 못한다.
#   (1) 런처가 re-export를 빠뜨렸다 — 실무에서 더 흔하다. SIP가 /bin/bash 같은
#       플랫폼 바이너리를 exec하며 DYLD_*를 지우므로, 번들 Mach-O를 셸 스크립트로
#       감싸는 순간 실측이 끊긴다 (계획 "런처 스크립트의 dyld 실측 규칙" 1).
#   (2) 검증 대상 자체가 플랫폼 바이너리다 — /usr/bin/env처럼 SIP가 DYLD_*를
#       무시하는 경우다.
# 어느 쪽이든 통과로 기록하지 않는다.
```

**증거 파일 본문에 실제로 적히는 문구** (168~181행, 실행 시 조립되는 그대로):
```
MEASUREMENT_UNAVAILABLE
# DYLD_PRINT_LIBRARIES=1을 켰는데 dyld 줄이 0건이다. 원인은 둘이고
# 이 래퍼는 둘을 구분하지 못한다 — 읽는 쪽이 판단한다.
#   (1) 런처가 re-export를 빠뜨렸다. 더 흔한 원인이다. SIP가 /bin/bash
#       같은 플랫폼 바이너리를 exec하며 DYLD_*를 지우므로, 번들 Mach-O를
#       셸 스크립트로 감싸면 실측이 끊긴다. 그렇다면 런처를 고쳐서
#       (exec 직전 export DYLD_PRINT_LIBRARIES=1) 다시 재야 한다
#       (계획 '런처 스크립트의 dyld 실측 규칙' 1).
#   (2) 검증 대상 자체가 플랫폼 바이너리다(/usr/bin/env 등). SIP가
#       DYLD_*를 무시하므로 이 머신에서는 잴 수 없다 (스펙 §4.2 주의).
# 어느 쪽이든 통과로 기록하지 않고 측정 불가로 남긴다. 대체 확인은
# G1 정적 검사와 P0-C8 런타임 자기 보고가 맡는다.
```

이번 회차 실행에서 실제로 이 문구가 찍힌 파일: `$EVIDENCE/t1-dyld-launcher-noexport-dyld.txt` (V5의 D1). 그 파일의 첫 줄이 정확히 `MEASUREMENT_UNAVAILABLE`이고, 스크립트가 `head -n 1 "$D1" | grep -q '^MEASUREMENT_UNAVAILABLE$'`로 이를 재확인해 `OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다`를 출력했다(V5 출력 참조). D2·D3·C절의 dyld 줄 수는 0이 아니므로(81건, 82건, 81건) 그 파일들에는 이 문구가 찍히지 않았다.

---

## Verify 명령 종료 코드 요약

| # | 명령 | 종료 코드 |
| --- | --- | --- |
| V1 | `preflight.sh 5` | 0 |
| V2 | `t1-env-allowlist.sh` | 0 |
| V3 | `t1-no-dev-tools.sh` | 0 |
| V4 | `t1-home-isolated.sh` | 0 |
| V5 | `t1-detector-negative.sh` | 0 |
| V6 | `check-macho.sh lib` | 0 |
| V7 | `t1-evidence-tracked.sh` | 0 |
| V8 | `grep U-4 && grep U-5` | 0 |
| V9 | `test -f sample.flac && grep mtg_` | 0 |
| V10 | `test ! -f package.json` | 0 |
| V11 | `git status --porcelain ...` | 0 (출력 없음) |
| V12 | `snapshot-dev-assets before && after` | 0 |

## `docs/superpowers/reports/evidence/phase-0/` 파일 목록과 확장자별 개수 (V1~V12 전체 실행 후)

```
$ ls -la docs/superpowers/reports/evidence/phase-0/
drwxr-xr-x  .
drwxr-xr-x  ..
.rw-r--r--  dev-assets-latest.txt
.rw-r--r--  t1-dyld-control-dyld.prev-20260909T073725Z.txt
.rw-r--r--  t1-dyld-control-dyld.txt
.rw-r--r--  t1-dyld-control-env.prev-20260909T073725Z.txt
.rw-r--r--  t1-dyld-control-env.txt
.rw-r--r--  t1-dyld-launcher-fake-dyld.prev-20260909T073726Z.txt
.rw-r--r--  t1-dyld-launcher-fake-dyld.txt
.rw-r--r--  t1-dyld-launcher-fake-env.prev-20260909T073726Z.txt
.rw-r--r--  t1-dyld-launcher-fake-env.txt
.rw-r--r--  t1-dyld-launcher-noexport-dyld.prev-20260909T073725Z.txt
.rw-r--r--  t1-dyld-launcher-noexport-dyld.txt
.rw-r--r--  t1-dyld-launcher-noexport-env.prev-20260909T073725Z.txt
.rw-r--r--  t1-dyld-launcher-noexport-env.txt
.rw-r--r--  t1-dyld-launcher-reexport-dyld.prev-20260909T073725Z.txt
.rw-r--r--  t1-dyld-launcher-reexport-dyld.txt
.rw-r--r--  t1-dyld-launcher-reexport-env.prev-20260909T073725Z.txt
.rw-r--r--  t1-dyld-launcher-reexport-env.txt
.rw-r--r--  t1-env-dyld.prev-20260909T073657Z.txt
.rw-r--r--  t1-env-dyld.txt
.rw-r--r--  t1-env-env.prev-20260909T073657Z.txt
.rw-r--r--  t1-env-env.txt
.rw-r--r--  t1-home-dyld.prev-20260909T073702Z.txt
.rw-r--r--  t1-home-dyld.txt
.rw-r--r--  t1-home-env.prev-20260909T073702Z.txt
.rw-r--r--  t1-home-env.txt
.rw-r--r--  t1-nodev-dyld.prev-20260909T073700Z.txt
.rw-r--r--  t1-nodev-dyld.txt
.rw-r--r--  t1-nodev-env.prev-20260909T073700Z.txt
.rw-r--r--  t1-nodev-env.txt
.rw-r--r--  task-1-r1.md
.rw-r--r--  task-1-r2.md
.rw-r--r--  task-1-r3.md
```
(이 시점에는 `task-1-r4.md`가 아직 생성되기 전 상태 — 이 파일 자신은 이 목록을 만든 다음에 씀)

확장자별 개수:
```
   3 .md
  29 .txt
```

주의: `.prev-<타임스탬프>.txt` 14개는 `run-isolated.sh`가 회차마다 새 파일을 요구하는 스펙 §6과 뒤 Task가 고정 파일명(`<label>-dyld.txt`)을 읽어야 하는 요구를 동시에 만족시키려고 자동으로 만든 것이며, 이번 verify 실행(V2~V5) 자체가 만들어낸 부산물이다. verifier가 EVIDENCE 외 다른 곳에 쓰지 않았다는 원칙과, `run-isolated.sh`/`t1-*.sh`가 스스로 EVIDENCE 안에 쓰는 정상 동작은 구분된다.

## `git status --porcelain` 전체 출력 (V1~V12 실행 후, 저장소 루트 기준)

```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-home-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-home-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-nodev-env.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T073725Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T073725Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-dyld.prev-20260909T073726Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-env.prev-20260909T073726Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.prev-20260909T073725Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.prev-20260909T073725Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.prev-20260909T073725Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.prev-20260909T073725Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T073657Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T073657Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T073702Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T073702Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T073700Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T073700Z.txt
```
(`be/src`, `be/worker/damwha_worker`, `be/worker/scripts`, `fe/src`, `packages/contracts`에 대한 변경은 없음 — V11이 이를 별도로 확인했다. `docs/superpowers/plans/`, `docs/superpowers/reports/evidence/phase-0/task-1-r4.md` 자신, `be/storage`, DB 볼륨에 대한 변경도 없음.)

## 프로세스 정리

- 기동 전 (`ps aux | grep -E "postgres|mlx_lm|embed_service|run-isolated"`): 관련 프로세스 없음 (검색어가 넓어 무관한 `Codex (Renderer)` 등 macOS 앱 프로세스 노이즈가 섞여 나왔으나 실험 관련 프로세스는 0건)
- 이번 회차의 V1~V12는 모두 `run-isolated.sh`를 통해 짧게 실행되고 즉시 종료되는 명령(`echo`, python3 검사 스크립트 등)만 호출했다 — 백그라운드 서비스(Task 2의 postgres, Task 5의 embed/mlx_lm.server)는 기동하지 않았다. `run-isolated.sh` 자신도 매 호출 후 `trap 'rm -rf "$RUNTMP"' EXIT`로 임시 디렉터리를 정리하고 종료한다.
- 종료 후 (`ps aux | grep -E "g2-dyld-control|launch-noexport|launch-reexport|launch-fake|run-isolated\.sh|electron-phase-0/(pg|services)"`): 매치 없음 (exit 1, "no matches" 확인) — V5가 만든 대조군 프로세스(D1~D3의 launcher, C절의 `g2-dyld-control/echo`)는 각각 `run-isolated.sh`가 포그라운드로 실행해 자체 종료했으며 잔존 프로세스가 없다.
- `damwha-postgres`(개발 DB, 5432)는 검증 시작 전부터 `running` 상태였고 이 verifier가 기동·종료하지 않았다 — 건드리지 않았다.
