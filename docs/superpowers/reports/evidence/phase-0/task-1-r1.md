# 검증 증거 — Task 1

- 커밋: `17bae8da250340863e80d281bc4adfe13f36c167`
  - 확인: `git -C /Users/gim-yeongjae/project/daewha-electron-phase-0 rev-parse HEAD` = `17bae8da250340863e80d281bc4adfe13f36c167` (COMMIT과 일치, 시작 전 확인함)
- 환경:
  - node: `v22.21.1`
  - pnpm: `10.26.0`
  - python3 (시스템, `/usr/bin/python3` 아님 — Command Line Tools 제공): `Python 3.10.21` (참고: 이 값은 로그인 셸의 `python3`이며, 격리 실행 안의 `python3`은 `/usr/bin/python3` → 실측 `sys.prefix = /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9`, V3 참조)
  - Docker: 기동 중. `docker ps`에 `damwha-postgres`(Up 46 hours, healthy) 포함. `docker volume ls`에 `damwha_pgdata`, `be_pgdata` 존재.
  - 개발 DB(5432): `lsof -i :5432`에 `OrbStack`이 LISTEN 상태로 점유 (검증 시작 시점부터 기동 중이었음, 이 세션이 띄운 것 아님).
- 실행 일시: 2026-09-09T15:21:38+09:00 (KST, 명령 실행 시작 시각) ~ 15:22 무렵 (V1~V12 순차 실행)

## 사전 확인

```
$ git -C /Users/gim-yeongjae/project/daewha-electron-phase-0 rev-parse HEAD
17bae8da250340863e80d281bc4adfe13f36c167
```
COMMIT(`17bae8d`)의 전개형과 일치.

## V1. `bash experiments/electron-phase-0/lib/preflight.sh 5`
- cwd: `<repo root>` = `/Users/gim-yeongjae/project/daewha-electron-phase-0`
- 기대: exit 0. 포트 55432·58000·58100이 `free`로 출력
- 실제:
  ```
  55432 (실험 DB): free
  58000 (mlx_lm.server): free
  58100 (embed): free
  ```
  추가로 `be/storage(읽기 전용 원본): /Users/gim-yeongjae/project/daewha/be/storage`가 출력됨 — worktree(`/Users/gim-yeongjae/project/daewha-electron-phase-0`)가 아니라 메인 체크아웃의 `be/storage`를 가리킴.
- 일치: 예 (포트 3개 모두 `free`, exit 0)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
preflight.sh — 사전 점검

디스크
  대상 경로 : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0
  마운트    : /System/Volumes/Data
  여유      : 25 GiB
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
- 기대: exit 0. 격리 실행의 환경 변수 집합이 스펙 §4.2 표의 11개 이름과 정확히 일치하고, `VIRTUAL_ENV`·`PYTHONPATH`·`UV_*`가 없음
- 실제: 종료 코드 0. 스크립트는 `주입 변수 11개가 스펙 §4.2 표와 정확히 일치한다`고 출력했으나, 바로 위에 나열된 자식 프로세스 변수 이름 목록은 12개다:
  `DATABASE_URL`, `EMBED_SERVICE_HOST`, `EMBED_SERVICE_PORT`, `HF_HOME`, `HF_TOKEN`, `HOME`, `LENS_LLM_BASE_URL`, `LENS_LLM_SERVER_BIN`, `MODEL_CACHE_DIR`, `PATH`, `STORAGE_ROOT`, `TMPDIR`
  (`grep -c '^  [A-Z]'`로 재확인해도 12줄.) `VIRTUAL_ENV`/`PYTHONPATH`/`PYTHONHOME`/`UV_*`/`HUGGINGFACE_HUB_CACHE`는 목록에 없음(스크립트가 별도로 `OK`로 확인).
- 일치: 아니오 (스크립트 exit 코드는 기대와 일치하나, "11개"라는 스크립트 자체 판정 문구와 실제 나열된 변수 개수(12개)가 다름 — 이 불일치를 그대로 기록함, 판정은 하지 않음)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-env-allowlist.sh — G2 주입 화이트리스트 검사 (스펙 §4.2)
run-isolated: label=t1-env  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.WHQCBH/stderr.raw)

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

OK  주입 변수 11개가 스펙 §4.2 표와 정확히 일치한다
OK  VIRTUAL_ENV / PYTHONPATH / PYTHONHOME / UV_* / HUGGINGFACE_HUB_CACHE 가 모두 없다
OK  HF_TOKEN 주입 상태가 be/worker/.env와 일치한다 (set=1)
OK  증거에 HF_TOKEN이 set/unset으로만 적혀 있다
OK  증거 디렉터리 어디에도 HF_TOKEN 값이 없다
EXIT:0
```
</details>

부속 증거(스크립트가 기록): `docs/superpowers/reports/evidence/phase-0/t1-env-env.txt`, `docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt` — HF_TOKEN 값이 포함되는지 grep으로 대조:

```
$ grep -i 'HF_TOKEN=' docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
```
(별도 확인은 아래 "부속 확인" 절 참조.)

## V3. `bash experiments/electron-phase-0/verify/t1-no-dev-tools.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 안에서 `ffmpeg`·`uv`·`node`를 찾을 수 없고, `python3`은 `/usr/bin/python3`이며 `sys.prefix`가 `/Library/Frameworks/Python.framework`도 `.venv`도 아님
- 실제: `ffmpeg`, `ffprobe`, `uv`, `node`, `npm`, `pnpm`, `psql`, `pg_ctl`, `initdb`, `mlx_lm.server` 모두 `(not found)`. `python3 = /usr/bin/python3`. `sys.prefix = /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9` (`/Library/Frameworks/Python.framework`가 아니고 `.venv`도 아님).
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-no-dev-tools.sh — 격리 안의 도구 가시성 (스펙 §4.2)
run-isolated: label=t1-nodev  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.SoBg7D/stderr.raw)

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
- 실제: `HOME = /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home` (실경로 동일, 심볼릭 링크 탈출 없음). 개발자 HF 캐시 id(`16777233:750166329`)와 격리 HF 캐시 id(`16777233:846849250`)가 다름. 격리 HOME에 `.local` 없음. `HFHUB_ENTRIES 0`.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
t1-home-isolated.sh — HOME 격리 검사 (스펙 §4.2)
run-isolated: label=t1-home  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.EBL2UV/stderr.raw)

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
- 기대: exit 0. **음성 대조군** — `check-macho.sh /opt/homebrew/bin`이 위반을 실제로 검출(비정상 종료)했을 때만 통과. (지시사항: 이 스크립트가 exit 0을 내는 것 자체가 정상이며, 내부에서 `check-macho.sh /opt/homebrew/bin`이 exit 1을 낸 것을 스크립트 종료 코드 그대로 기록함.)
- 실제: 3단계 모두 `OK`.
  - A. 합성 대조군: 격리 픽스처(`sandbox/tmp/g1-detector-fixture`, 11개 파일, Mach-O 2개)에서 `check-macho.sh`가 exit 1로 종료, 위반 11건 검출(금지 문자열 9종 + `otool -L` 1건 + `LC_RPATH` 1건).
  - B. 실물 대조군: `check-macho.sh /opt/homebrew/bin`이 exit 1로 종료, 위반 6건 검출.
  - C. dyld 실측 대조군: 격리 실행에서 dyld 로그 81줄 실측.
  - 최종 줄: `모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다`
- 일치: 예 (래퍼 스크립트 exit 0, 내부 `check-macho.sh /opt/homebrew/bin` 호출은 exit 1로 위반 검출 — 지시사항이 요구한 대로 래퍼의 종료 코드를 그대로 기록)
- 종료 코드: 0 (내부 `check-macho.sh /opt/homebrew/bin` 자체의 종료 코드는 1, 위 "B" 항목 stdout에 `비정상 종료했다 (exit 1)`로 표기됨)

<details><summary>전체 출력</summary>

```
== A. 합성 대조군 — 금지 문자열 9종 + otool -L + LC_RPATH
  금지 문자열 대조 파일 9개 생성
  OK   check-macho.sh가 비정상 종료했다 (exit 1)
    check-macho.sh (G1, 스펙 §4.1)
      대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g1-detector-fixture
      파일 수       : 11
      Mach-O 수     : 2
      금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
      문자열 후보   : 9개 파일
      번들 내부 절대경로(INFO): 0건
      위반          : 11건
        STRING  .../pattern-1.txt: /opt/homebrew/g1-detector-probe  (금지 문자열: /opt/homebrew)
        STRING  .../pattern-2.txt: /Library/Frameworks/Python.framework/g1-detector-probe  (금지 문자열: /Library/Frameworks/Python.framework)
        STRING  .../pattern-3.txt: /usr/local/bin/g1-detector-probe  (금지 문자열: /usr/local/bin)
        STRING  .../pattern-4.txt: /usr/local/lib/g1-detector-probe  (금지 문자열: /usr/local/lib)
        STRING  .../pattern-5.txt: /usr/local/Cellar/g1-detector-probe  (금지 문자열: /usr/local/Cellar)
        STRING  .../pattern-6.txt: /usr/local/opt/g1-detector-probe  (금지 문자열: /usr/local/opt)
        STRING  .../pattern-7.txt: /Users/gim-yeongjae/g1-detector-probe  (금지 문자열: /Users/gim-yeongjae)
        STRING  .../pattern-8.txt: /.venv/g1-detector-probe  (금지 문자열: /.venv)
        STRING  .../pattern-9.txt: /Library/Developer/CommandLineTools/g1-detector-probe  (금지 문자열: /Library/Developer/CommandLineTools)
        OTOOL-L .../dep-bad: /tmp/g1-detector-probe/libSystem.B.dylib  (허용 접두사가 아니다)
        LC_RPATH .../rpath-bad: /tmp/g1-detector-probe-rpath  (번들 밖 절대 경로)
  OK   금지 문자열 9종을 모두 검출했다 (스펙 §4.1 표 7행 전부)
  OK   otool -L 의존 경로 위반을 검출했다
  OK   LC_RPATH 위반을 검출했다
  OK   fat 바이너리 경로를 아키텍처 꼬리표 없이 다뤘다

== B. 실물 대조군 — check-macho.sh /opt/homebrew/bin
  OK   비정상 종료했다 (exit 1)
    검출한 위반 줄 수: 6
      위반          : 6건

== C. dyld 실측 대조군 — 플랫폼 바이너리가 아닌 Mach-O
run-isolated: label=t1-dyld-control  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.7OyHX5/stderr.raw)
  OK   dyld 줄 81건을 실측했다
    dyld[56593]: <1847B2BD-6C7D-3600-82B0-AC6B5F8F823F> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/tmp/g2-dyld-control/echo
    dyld[56593]: <4FDC9AA6-B344-37FE-B8C6-A4C94A038F57> /usr/lib/libSystem.B.dylib
    dyld[56593]: <83E81326-A587-374F-ABC1-BAE48D0FEE0D> /usr/lib/system/libcache.dylib

모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다
EXIT:0
```
</details>

## V6. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/lib`
- cwd: `<repo root>`
- 기대: exit 0. **양성 대조군** — 위반 없는 입력에서 오탐 없음
- 실제: 파일 수 7, Mach-O 수 0, 문자열 후보 1개 파일, 위반 0건.
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
  번들 내부 절대경로(INFO): 0건
  위반          : 0건
EXIT:0
```
</details>

## V7. `bash experiments/electron-phase-0/verify/t1-evidence-tracked.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$EVIDENCE`의 `.md`/`.txt`가 gitignore에 걸리지 않고, 디렉터리에 `.log` 파일이 없음
- 실제: `.log`는 무시됨(확인), `.txt`/`.md`는 무시되지 않음(확인), 디렉터리에 `.log` 파일 0개, 증거 파일 17개 나열(전부 `.txt`, V2~V5 실행이 만든 `.prev-<timestamp>.txt` 회전 파일 8개 포함). `experiments/electron-phase-0/.gitignore` 동작도 개별 확인(`sandbox/`, `stage/`, `bundle/`, `pgdata/`, `run/`, `downloads/`, `signed/` 모두 무시; `lib/config.sh`, `verify/t1-evidence-tracked.sh`, `probe/deps-survey.md`는 커밋 대상).
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
  OK   증거 파일 17개
    docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T062225Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T062225Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T062148Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T062148Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T062202Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T062202Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T062157Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T062157Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-env.txt

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
- 실제: 출력 없음(grep -q 특성). 직접 확인한 매치 줄:
  ```
  1:# Phase 0 의존성 조사 — U-4 / U-5
  10:## U-4 — `sounddevice`(PortAudio)가 실사용 경로에 남아 있는가
  42:- 스펙 §7.2 U-4의 기본 제안이 "불확실하면 포함한다 — 빼서 깨지는 쪽이 더
  1:# Phase 0 의존성 조사 — U-4 / U-5
  62:## U-5 — Whisper 카탈로그 중 무엇을 Task 9의 실측 대상으로 삼는가
  65:스펙 §7.2 U-5의 기본 제안("프리셋이 쓰는 것 + `large-v3-turbo`")을 따르되,
  ```
- 일치: 예
- 종료 코드: 0

## V9. `test -f experiments/electron-phase-0/sandbox/audio/sample.flac && grep -q 'mtg_' experiments/electron-phase-0/probe/audio-source.txt`
- cwd: `<repo root>`
- 기대: exit 0. 검증 오디오가 복사됐고 출처가 기록됨
- 실제: `sample.flac` 존재 (147 MB, mtime 2026-09-09 15:12:54). `probe/audio-source.txt`에 `mtg_` 매치:
  ```
  6:선택한 회의    : mtg_28
  7:원본 경로      : /Users/gim-yeongjae/project/daewha/be/storage/meetings/mtg_28/original.flac
  18:mtg_20  있음  184184148  2056.333000
  ...
  ```
  원본 경로가 worktree가 아니라 메인 체크아웃(`/Users/gim-yeongjae/project/daewha/be/storage`)을 가리킴 — `experiments/electron-phase-0/lib/config.sh:62-80`에 그 이유가 주석으로 남아 있음: worktree에는 `be/storage`가 없다(루트 `.gitignore`가 `/be/storage/`를 무시해 `git worktree add`가 만들지 않음), 그래서 메인 체크아웃의 `be/storage`로 폴백한다.
- 일치: 예
- 종료 코드: 0

## V10. `test ! -f experiments/electron-phase-0/package.json`
- cwd: `<repo root>`
- 기대: exit 0. pnpm 워크스페이스 멤버가 아님
- 실제: `experiments/electron-phase-0/package.json` 없음(`ls`로 확인: `No such file or directory`)
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
- 실제:
  - `before`: docker 볼륨 13개 나열(`be_pgdata`, `damwha_pgdata` 포함). `be/storage` — root: `/Users/gim-yeongjae/project/daewha/be/storage`, files: 29, bytes: 2227477523, newest_mtime: 1788857034, manifest_sha256: `a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`. exit 0.
  - `after`: `개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다`. 볼륨 목록·files/bytes/mtime/manifest_sha256 전부 before와 동일. exit 0.
- 일치: 예 (`be/storage` 매니페스트 SHA256과 파일 수·바이트 수·최신 mtime이 before/after 동일, docker 볼륨 목록 동일)
- 종료 코드(before): 0
- 종료 코드(after): 0

<details><summary>전체 출력</summary>

```
== running before ==
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
EXIT_BEFORE:0
== running after ==
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
EXIT_AFTER:0
```
</details>

## 프로세스 정리
- 기동 전: `ps -eo pid,ppid,comm | grep -iE 'run-isolated|check-macho|mlx_lm|embed_service|postgres.*55432|python3.*sandbox'` — 출력 없음
- 종료 후: 동일 명령 — 출력 없음
- V1~V12 중 어느 것도 지속 실행 서비스(embed/llm 등)를 띄우지 않았다. `run-isolated.sh`가 V2/V3/V4/V5(C)에서 호출한 자식 프로세스(`python3 -c ...`, `echo` 등)는 단명 실행으로 스크립트 종료 시점에 이미 종료돼 있었다. V12용으로 별도 실행한 `ps` 확인(`snapshot-dev-assets|postgres` 필터)도 실행 전/후 모두 출력 없음.
- 참고: `damwha-postgres`(5432) 컨테이너는 이 세션이 띄운 것이 아니라 검증 시작 전부터 기동 중이었으므로(`docker ps` 최초 확인 시 `Up 46 hours`) 건드리지 않았다.

## 추가 기록 — verify/ 스크립트 종료 코드와 stdout 판정 근거 줄 (요약)

| 스크립트 | 종료 코드 | 판정 근거 줄(발췌) |
| --- | --- | --- |
| `lib/preflight.sh 5` | 0 | `여유 : 25 GiB` / `필요 : 5 GiB` / `판정 : 충분`; 55432·58000·58100 각각 `free` |
| `verify/t1-env-allowlist.sh` | 0 | `OK  주입 변수 11개가 스펙 §4.2 표와 정확히 일치한다` (단, 실제 나열 변수는 12개 — V2 항목 참조) |
| `verify/t1-no-dev-tools.sh` | 0 | `OK  sys.prefix가 머신 전역 Python.framework도 개발 가상환경도 아니다` |
| `verify/t1-home-isolated.sh` | 0 | `OK  격리 안의 HF 캐시가 개발자 캐시와 다른 디렉터리다` |
| `verify/t1-detector-negative.sh` | 0 | `모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다` (내부 `check-macho.sh /opt/homebrew/bin` 자체는 exit 1) |
| `lib/check-macho.sh experiments/electron-phase-0/lib` | 0 | `위반          : 0건` |
| `verify/t1-evidence-tracked.sh` | 0 | `OK   /.../phase-0 에 .log 파일이 없다` |
| `lib/snapshot-dev-assets.sh before` | 0 | `manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be` |
| `lib/snapshot-dev-assets.sh after` | 0 | `개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다` |

## 추가 기록 — `docs/superpowers/reports/evidence/phase-0/` 파일 목록과 확장자 (검증 실행 후 시점)

```
$ find docs/superpowers/reports/evidence/phase-0 -type f | sort
docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T062225Z.txt
docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T062225Z.txt
docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T062148Z.txt
docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt
docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T062148Z.txt
docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T062202Z.txt
docs/superpowers/reports/evidence/phase-0/t1-home-dyld.txt
docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T062202Z.txt
docs/superpowers/reports/evidence/phase-0/t1-home-env.txt
docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T062157Z.txt
docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.txt
docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T062157Z.txt
docs/superpowers/reports/evidence/phase-0/t1-nodev-env.txt

$ find docs/superpowers/reports/evidence/phase-0 -type f | sed 's/.*\.//' | sort | uniq -c
  17 txt
```

이 파일(`task-1-r1.md`)은 이 목록 생성 이후에 이 verifier가 새로 작성했으므로 위 목록에는 없다. `.log` 파일은 0개.

주의: 위 17개 중 `t1-*-env.txt`/`t1-*-dyld.txt` 9개는 이 실행(V2~V5) 이전부터 저장소에 커밋돼 있던 파일이며, 이번 verifier 실행으로 **덮어써졌다** (`run-isolated.sh`가 라벨별 최신 증거를 갱신하는 설계). 덮어쓰기 전 내용은 스크립트가 자동으로 `*.prev-<timestamp>.txt`로 회전시켜 보존했다 (8개, 아래 git status 참고). 이 덮어쓰기는 verifier가 직접 편집한 것이 아니라, 계획에 적힌 V2~V5 명령을 그대로 실행한 결과다.

## 추가 기록 — `git status --porcelain` 전체 출력 (검증 실행 후, worktree 전체)

```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-home-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-home-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-nodev-env.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T062225Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T062225Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T062148Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T062148Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T062202Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T062202Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T062157Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T062157Z.txt
```

`be/src`, `be/worker/damwha_worker`, `be/worker/scripts`, `fe/src`, `packages/contracts`, `experiments/electron-phase-0/` 하위 스크립트·문서에는 변경 없음(위 목록에 없음) — V11의 별도 확인과 일치.

이 증거 파일(`task-1-r1.md`) 자체는 이 `git status` 실행 시점에는 아직 쓰이지 않았으므로 목록에 없다.

## 요약 (일치 여부만)

| # | 일치 |
| --- | --- |
| V1 | 예 |
| V2 | 아니오 (exit 0은 기대와 일치하나 "11개" 판정 문구와 실제 나열 변수 12개가 다름) |
| V3 | 예 |
| V4 | 예 |
| V5 | 예 |
| V6 | 예 |
| V7 | 예 |
| V8 | 예 |
| V9 | 예 |
| V10 | 예 |
| V11 | 예 |
| V12 | 예 |
