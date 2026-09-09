# 검증 증거 — Task 1 (3회차)

- 커밋: 961029faa98d5747282ccebab9db08a63f9d7bb8 (지시된 COMMIT `961029f`와 일치, `git -C $WORKTREE rev-parse HEAD` 확인)
- 계획 문서: `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md` (커밋 cd699ad에서 "## 런처 스크립트의 dyld 실측 규칙" 절 신설, Task 1 Files·Verify V5·Review 변경 — 현재 워크트리 HEAD에서 다시 읽음)
- WORKTREE: `/Users/gim-yeongjae/project/daewha-electron-phase-0`
- 회차: 3회차 (1회차 17bae8d → `task-1-r1.md`, 2회차 f1e1dff → `task-1-r2.md`, 이번 → `task-1-r3.md`)
- 환경:
  - node: v22.21.1 (`/Users/gim-yeongjae/.nvm/versions/node/v22.21.1/bin/node`)
  - pnpm: 10.26.0 (`/Users/gim-yeongjae/.nvm/versions/node/v22.21.1/bin/pnpm`)
  - python3 (verifier 쉘의 시스템 python3, 실험 대상이 아님): `python3.10` alias → `/opt/homebrew/opt/python@3.10/bin/python3.10`, `Python 3.10.21`
  - uv: 0.8.16 (`/Users/gim-yeongjae/.local/bin/uv`)
  - Docker: 기동 상태 확인함. `damwha-postgres`(d32a453aecda, Up 47 hours, healthy), `blog-minio`, `blog-postgres` 실행 중. 이번 회차에서 `damwha_pgdata`/개발 DB(5432)에 쓰기는 발생하지 않았다 (Task 1은 Postgres를 다루지 않음, V12·docker ps 대조로 확인).
- 실행 일시: 2026-09-09T07:09:22Z (검증 시작), 종료 약 2026-09-09T07:11:00Z

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
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
preflight.sh — 사전 점검

디스크
  대상 경로 : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0
  마운트    : /System/Volumes/Data
  여유      : 23 GiB
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
```
</details>

비고: `be/storage(읽기 전용 원본)`이 이 워크트리(`daewha-electron-phase-0`)가 아니라 원본 저장소 `/Users/gim-yeongjae/project/daewha/be/storage`를 가리킨다. `config.sh`의 경로 산정 방식으로 보이며, Task 1 Verify 명령의 실행/판정에는 영향이 없어 사실만 기록한다.

## V2. `bash experiments/electron-phase-0/verify/t1-env-allowlist.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 실행의 환경 변수 집합이 스펙 §4.2 표의 **12개** 이름과 정확히 일치하고, `VIRTUAL_ENV`·`PYTHONPATH`·`UV_*`가 없음
- 실제: 출력 문구 그대로 —
  ```
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
  ```
  나열된 변수 이름 실제 개수: 12개 (`DATABASE_URL, EMBED_SERVICE_HOST, EMBED_SERVICE_PORT, HF_HOME, HF_TOKEN, HOME, LENS_LLM_BASE_URL, LENS_LLM_SERVER_BIN, MODEL_CACHE_DIR, PATH, STORAGE_ROOT, TMPDIR`). 스크립트 자체 표기는 "11개(+ HF_TOKEN = ... 12개)" 문구다.
- 일치: 예
- 종료 코드: 0

## V3. `bash experiments/electron-phase-0/verify/t1-no-dev-tools.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 안에서 `ffmpeg`·`uv`·`node`를 찾을 수 없고, `python3`은 `/usr/bin/python3`이며 `sys.prefix`가 `/Library/Frameworks/Python.framework`도 `.venv`도 아님
- 실제:
  ```
  TOOL python3 /usr/bin/python3
  PYPREFIX /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9
  OK  ffmpeg: 격리 안에서 찾을 수 없다
  OK  uv: 격리 안에서 찾을 수 없다
  OK  node: 격리 안에서 찾을 수 없다
  OK  python3: /usr/bin/python3 (OS 제공)
  OK  sys.prefix가 머신 전역 Python.framework도 개발 가상환경도 아니다
  ```
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
t1-no-dev-tools.sh — 격리 안의 도구 가시성 (스펙 §4.2)
run-isolated: label=t1-nodev  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.MmPz2e/stderr.raw)

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
```
</details>

## V4. `bash experiments/electron-phase-0/verify/t1-home-isolated.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$HOME`이 `experiments/electron-phase-0/sandbox/home`이고 개발자 홈의 `.cache`·`.local`이 보이지 않음
- 실제:
  ```
  HOME /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home
  OK  HOME이 샌드박스다: .../sandbox/home
  OK  HOME 경로가 계획의 $SANDBOX/home 규약과 같다
  OK  HOME의 실경로가 샌드박스 안이다 (심볼릭 링크 탈출 없음)
  OK  격리 안의 HF 캐시가 개발자 캐시와 다른 디렉터리다
  OK  격리 HOME에 .local이 없다 (uv tool 설치본이 배제됐다)
  ```
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
t1-home-isolated.sh — HOME 격리 검사 (스펙 §4.2)
run-isolated: label=t1-home  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.YcquaM/stderr.raw)

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
```
</details>

## V5. `bash experiments/electron-phase-0/verify/t1-detector-negative.sh`
- cwd: `<repo root>`
- 기대: exit 0. 음성 대조군 — (a) `check-macho.sh /opt/homebrew/bin`이 위반을 실제로 검출, (b) 재배치 잔존 경로 3형태(shebang·`pyvenv.cfg`·`*.pc`)가 각각 위반으로 잡힘, (c) re-export 없는 런처가 dyld 0건, 있는 런처가 1건 이상일 때만 통과
- 실제 (전체 4개 절 A/B/C/D 중, 지시받은 대로 D절을 그대로 옮김, A/B/C도 함께 기록):

**D절 (런처 dyld 대조군) — 그대로 옮김:**
```
== D. 런처 dyld 대조군 — re-export 없음 / 있음
run-isolated: label=t1-dyld-launcher-noexport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.f2EWsM/stderr.raw)
  OK   D1: re-export 없는 런처는 dyld 0건이다 (SIP가 /bin/bash exec에서 지웠다)
  OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다 — 통과로 집계되지 않는다
run-isolated: label=t1-dyld-launcher-reexport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.PDW61V/stderr.raw)
  OK   D2: re-export 있는 런처는 dyld 81건을 실측했다
  OK   D2: 실측된 줄이 자식 Mach-O의 것이다 (런처 자신의 목록만 남은 가짜 증거가 아니다)
```
D절 대조군 개수: 2개 (D1 = re-export 없는 런처, D2 = re-export 있는 런처). 각각 별도 단정 줄로 판정됨 — D1은 "dyld 0건" 단정 + "MEASUREMENT_UNAVAILABLE 표시" 단정 2줄, D2는 "dyld 81건 실측" 단정 + "자식 Mach-O 경로 포함" 단정 2줄. 계 4개 단정 줄, 4개 전부 `OK`.

**A/B/C절 요약(정황):**
```
== A. 합성 대조군 — 금지 문자열 9종 + otool -L + LC_RPATH
  OK   check-macho.sh가 비정상 종료했다 (exit 1)
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
  OK   dyld 줄 81건을 실측했다

모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다
```
- 일치: 예 (a·b·c 세 조건 모두 스크립트 자체 단정에서 `OK` — b는 3형태 stale-shebang/stale-pyvenv.cfg/stale-pkgconfig.pc 각각 별도 `OK` 줄로 확인됨)
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
        STRING  .../pattern-1.txt: /opt/homebrew/g1-detector-probe  (금지 문자열: /opt/homebrew)
        STRING  .../pattern-2.txt: /Library/Frameworks/Python.framework/g1-detector-probe  (금지 문자열: /Library/Frameworks/Python.framework)
        STRING  .../pattern-3.txt: /usr/local/bin/g1-detector-probe  (금지 문자열: /usr/local/bin)
        STRING  .../pattern-4.txt: /usr/local/lib/g1-detector-probe  (금지 문자열: /usr/local/lib)
        STRING  .../pattern-5.txt: /usr/local/Cellar/g1-detector-probe  (금지 문자열: /usr/local/Cellar)
        STRING  .../pattern-6.txt: /usr/local/opt/g1-detector-probe  (금지 문자열: /usr/local/opt)
        STRING  .../pattern-7.txt: /Users/gim-yeongjae/g1-detector-probe  (금지 문자열: /Users/gim-yeongjae)
        STRING  .../pattern-8.txt: /.venv/g1-detector-probe  (금지 문자열: /.venv)
        STRING  .../pattern-9.txt: /Library/Developer/CommandLineTools/g1-detector-probe  (금지 문자열: /Library/Developer/CommandLineTools)
        STALE-PATH .../stale-pkgconfig.pc: .../sandbox/stale-prefix  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        STALE-PATH .../stale-pyvenv.cfg: .../downloads/cpython/bin  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        STALE-PATH .../stale-shebang: .../stage/python/bin/python3  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        OTOOL-L .../dep-bad: /tmp/g1-detector-probe/libSystem.B.dylib  (허용 접두사가 아니다)
        LC_RPATH .../rpath-bad: /tmp/g1-detector-probe-rpath  (번들 밖 절대 경로)
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
run-isolated: label=t1-dyld-control  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.cISdBP/stderr.raw)
  OK   dyld 줄 81건을 실측했다
    dyld[3986]: <1847B2BD-6C7D-3600-82B0-AC6B5F8F823F> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g2-dyld-control/echo
    dyld[3986]: <4FDC9AA6-B344-37FE-B8C6-A4C94A038F57> /usr/lib/libSystem.B.dylib
    dyld[3986]: <83E81326-A587-374F-ABC1-BAE48D0FEE0D> /usr/lib/system/libcache.dylib

== D. 런처 dyld 대조군 — re-export 없음 / 있음
run-isolated: label=t1-dyld-launcher-noexport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.f2EWsM/stderr.raw)
  OK   D1: re-export 없는 런처는 dyld 0건이다 (SIP가 /bin/bash exec에서 지웠다)
  OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다 — 통과로 집계되지 않는다
run-isolated: label=t1-dyld-launcher-reexport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.PDW61V/stderr.raw)
  OK   D2: re-export 있는 런처는 dyld 81건을 실측했다
  OK   D2: 실측된 줄이 자식 Mach-O의 것이다 (런처 자신의 목록만 남은 가짜 증거가 아니다)

모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다
```
(경로는 지면상 `...`로 일부 축약함. 실제 원본 stdout은 절대경로 전체를 포함한다.)
</details>

### 런처 dyld 규칙 직접 재현 (verifier 자체 측정, worktree 밖 스크래치 디렉터리)

픽스처 경로: `/private/tmp/claude-501/-Users-gim-yeongjae-project-daewha/ce4fc665-b7b4-47af-bae7-c9645b5363af/scratchpad/dyld-repro` (검사 후 `rm -rf`로 삭제 확인함, 삭제 후 `ls`로 부재 확인).

준비: `/bin/echo`를 복사해 `codesign -f -s -`로 ad-hoc 서명(`flags=0x2(adhoc)`, `Format=Mach-O universal (x86_64 arm64e)`).

| 형태 | 명령 | 실측 방법(`grep -c '^dyld' <stderr파일>; true`) | dyld 줄 수 | exit |
| --- | --- | --- | --- | --- |
| (i) 직접 실행 | `/usr/bin/env -i DYLD_PRINT_LIBRARIES=1 <ad-hoc echo> hello-i` | stderr 캡처 | **81** | 0 |
| (ii) bash 런처, re-export 없음 | `/usr/bin/env -i DYLD_PRINT_LIBRARIES=1 launch-noexport.sh <echo> hello-ii` (런처 내부는 `exec "$1" "$2"`) | stderr 캡처 | **0** | 0 |
| (iii) bash 런처, exec 직전 `export DYLD_PRINT_LIBRARIES=1` | `/usr/bin/env -i launch-reexport.sh <echo> hello-iii` (`export DYLD_PRINT_LIBRARIES=1; exec "$1" "$2"`) | stderr 캡처 | **81** | 0 |
| (iv) (iii) + 자식 stderr `2>/dev/null` | `/usr/bin/env -i launch-reexport-quiet.sh <echo> hello-iv` (`export ...; exec "$1" "$2" 2>/dev/null`) | 런처 자신의 stderr 캡처(자식 stderr는 버려짐) | **0** | 0 |

(i)/(iii)의 stderr 첫 3줄 예시(둘 다 동일 패턴):
```
dyld[<pid>]: <1847B2BD-6C7D-3600-82B0-AC6B5F8F823F> .../dyld-repro/echo
dyld[<pid>]: <4FDC9AA6-B344-37FE-B8C6-A4C94A038F57> /usr/lib/libSystem.B.dylib
dyld[<pid>]: <83E81326-A587-374F-ABC1-BAE48D0FEE0D> /usr/lib/system/libcache.dylib
```
(ii)/(iv)의 stderr는 0바이트(`wc -l` = 0).

계획 "런처 스크립트의 dyld 실측 규칙" 표 값(81 / 0 / 81 / 0)과 이번 재현 측정값(81 / 0 / 81 / 0)을 나란히 적는다 — 값이 같다는 사실만 기록, 판정하지 않음.

`grep -c` 0건 함정: `grep -c '^dyld' err-ii.txt`는 `0`을 출력하며 exit 1을 낸다. `grep -c ... ; true` 형태로 계수해 이후 정수 비교가 깨지지 않게 했다 (`|| echo 0`을 쓰지 않음).

## V6. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/lib`
- cwd: `<repo root>`
- 기대: exit 0. 양성 대조군 — 위반 없는 입력에서 오탐 없음
- 실제:
  ```
  파일 수       : 7
  Mach-O 수     : 0
  위반          : 0건
  ```
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
```
</details>

## V7. `bash experiments/electron-phase-0/verify/t1-evidence-tracked.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$EVIDENCE`의 `.md`/`.txt`가 gitignore에 걸리지 않고, 디렉터리에 `.log` 파일이 없음
- 실제:
  ```
  OK   .log는 무시된다 — 스펙 §6의 근거가 지금도 참이다
  OK   .txt 는 무시되지 않는다
  OK   .md 는 무시되지 않는다
  OK   /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0 에 .log 파일이 없다
  OK   증거 파일 27개
  ```
  (이 시점의 27개 목록은 V2~V5 실행이 만든 `*.prev-<timestamp>.txt` 백업 12개를 포함한다 — 아래 "추가 기록" 참고.)
- 일치: 예
- 종료 코드: 0

## V8. `grep -q 'U-4' experiments/electron-phase-0/probe/deps-survey.md && grep -q 'U-5' experiments/electron-phase-0/probe/deps-survey.md`
- cwd: `<repo root>`
- 기대: exit 0
- 실제: 두 grep 모두 매치, `&&` 체인 성공
- 일치: 예
- 종료 코드: 0

## V9. `test -f experiments/electron-phase-0/sandbox/audio/sample.flac && grep -q 'mtg_' experiments/electron-phase-0/probe/audio-source.txt`
- cwd: `<repo root>`
- 기대: exit 0. 검증 오디오가 복사됐고 출처가 기록됨
- 실제: `test -f`와 `grep -q 'mtg_'` 모두 성공
- 일치: 예
- 종료 코드: 0

## V10. `test ! -f experiments/electron-phase-0/package.json`
- cwd: `<repo root>`
- 기대: exit 0. pnpm 워크스페이스 멤버가 아님
- 실제: `package.json` 없음 확인
- 일치: 예
- 종료 코드: 0

## V11. `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts`
- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음(빈 문자열)
- 일치: 예
- 종료 코드: 0

## V12. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh before && bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`
- cwd: `<repo root>`
- 기대: exit 0. `be/storage` 원본 무변화
- 실제:
  ```
  개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다
  ```
  `before`와 `after`의 `manifest_sha256`이 동일: `a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be` (files: 29, bytes: 2227477523, newest_mtime: 1788857034). docker volume 목록도 before/after 동일 13개(`damwha_pgdata`, `be_pgdata` 등 포함, 변화 없음).
- 일치: 예
- 종료 코드: 0 (두 호출 모두 0, `&&` 체인 성공)
<details><summary>전체 출력 (before)</summary>

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
```
</details>
<details><summary>전체 출력 (after)</summary>

```
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
```
</details>

## 프로세스 정리
- 기동 전(`ps -ax`에서 postgres/embed/mlx_lm/electron-phase-0 관련 필터):
  ```
  26481 26479 nvim --embed
  58162 58161 nvim --embed
  88204     1 .../CoreEmbeddedSpeechRecognition.framework/speechmaintenanced
  88206     1 .../com.apple.siri.embeddedspeech.xpc/Contents/MacOS/com.apple.siri.embeddedspeech
  ```
  (nvim/시스템 XPC 프로세스뿐, 이 검증과 무관 — 손대지 않음)
- 종료 후(동일 필터): 위와 동일. Task 1 Verify는 postgres/embed/mlx_lm 프로세스를 띄우지 않으므로 차이 없음.
- docker ps: 검증 시작 전/후 동일 3개 컨테이너(`damwha-postgres`, `blog-minio`, `blog-postgres`) — 이번 회차에서 새로 기동/종료한 컨테이너 없음.
- V5의 "런처 dyld 규칙 직접 재현" 픽스처(`/private/tmp/.../scratchpad/dyld-repro`)는 검사 완료 후 `rm -rf`로 삭제했고, 삭제 후 `ls`로 디렉터리 부재를 확인했다 (본문 V5 절 참고).

## 추가 기록

### `docs/superpowers/reports/evidence/phase-0/` 파일 목록과 확장자별 개수 (이번 검증 종료 시점)
- 총 27개: `.md` 2개, `.txt` 25개
- 목록:
  ```
  dev-assets-latest.txt
  t1-dyld-control-dyld.prev-20260909T071012Z.txt
  t1-dyld-control-dyld.txt
  t1-dyld-control-env.prev-20260909T071012Z.txt
  t1-dyld-control-env.txt
  t1-dyld-launcher-noexport-dyld.prev-20260909T071012Z.txt
  t1-dyld-launcher-noexport-dyld.txt
  t1-dyld-launcher-noexport-env.prev-20260909T071012Z.txt
  t1-dyld-launcher-noexport-env.txt
  t1-dyld-launcher-reexport-dyld.prev-20260909T071013Z.txt
  t1-dyld-launcher-reexport-dyld.txt
  t1-dyld-launcher-reexport-env.prev-20260909T071013Z.txt
  t1-dyld-launcher-reexport-env.txt
  t1-env-dyld.prev-20260909T070941Z.txt
  t1-env-dyld.txt
  t1-env-env.prev-20260909T070941Z.txt
  t1-env-env.txt
  t1-home-dyld.prev-20260909T070948Z.txt
  t1-home-dyld.txt
  t1-home-env.prev-20260909T070948Z.txt
  t1-home-env.txt
  t1-nodev-dyld.prev-20260909T070946Z.txt
  t1-nodev-dyld.txt
  t1-nodev-env.prev-20260909T070946Z.txt
  t1-nodev-env.txt
  task-1-r1.md
  task-1-r2.md
  ```
  (`task-1-r3.md`는 이 목록을 만든 시점 이후, 이번 증거 파일 자체를 쓰면서 추가됨 — 목록은 그 직전 상태다.)

### `git status --porcelain` 전체 출력 (V1~V12·V5 재현 완료 후, `task-1-r3.md` 작성 직전 스냅샷)
```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
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
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T071012Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T071012Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.prev-20260909T071012Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.prev-20260909T071012Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.prev-20260909T071013Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.prev-20260909T071013Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T070941Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T070941Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T070948Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T070948Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T070946Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T070946Z.txt
?? docs/superpowers/reports/evidence/phase-0/task-1-r1.md
?? docs/superpowers/reports/evidence/phase-0/task-1-r2.md
```

**사실 기록 (판정 아님):** 이 `M`/`??` 변경은 verifier가 손으로 편집한 것이 아니다. V2~V5(`t1-env-allowlist.sh`, `t1-no-dev-tools.sh`, `t1-home-isolated.sh`, `t1-detector-negative.sh`)는 각각 `run-isolated.sh`를 호출하고, `run-isolated.sh`는 계획 인터페이스(Task 1 Interfaces, `run-isolated.sh` 항목)에 정의된 대로 매 실행마다 `$EVIDENCE/<label>-dyld.txt`·`$EVIDENCE/<label>-env.txt`를 덮어쓰며 기존 파일을 `*.prev-<timestamp>.txt`로 보존한다. 이는 스크립트의 설계된 동작이고, Verify 표의 명령을 표에 적힌 그대로 실행한 결과로 발생했다. `task-1-r1.md`/`task-1-r2.md`(1·2회차 증거)는 건드리지 않았다 — 위 diff에도 나타나지 않는다(신규 `??`로만 표시되는 이유는 이전 회차 verifier가 그 시점엔 커밋되지 않은 새 파일로 남겨뒀기 때문으로 보이며, 이번 회차에서 내용을 수정하지 않았다).

`t1-dyld-control-dyld.txt` 등 `.prev-` 접미사가 붙은 12개 파일은 이번 실행이 새로 만든 미추적(`??`) 파일이다. `docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt`도 `snapshot-dev-assets.sh`(V12)가 매 호출마다 갱신하는 파일로 `M`으로 표시된다.
