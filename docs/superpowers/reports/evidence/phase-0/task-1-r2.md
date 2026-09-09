# 검증 증거 — Task 1 (2회차)

- 커밋: f1e1dfffa973c5ec52c0b326c2843ff6f5d4675c (요청된 COMMIT `f1e1dff`와 일치, `git -C <worktree> rev-parse HEAD` 실측값)
- 1회차 커밋: 17bae8d (이번은 그 리뷰 FAIL에 대한 수정 커밋 `f1e1dff`를 검증)
- 환경:
  - node: v22.21.1
  - pnpm: 10.26.0
  - python3 (경로 `python3` 별칭): Python 3.10.21 (`which python3` → `python3.10`)
  - 격리 내부 python3(V3 참고): `/usr/bin/python3`, Command Line Tools 제공, `sys.prefix=/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9`
  - Docker: `damwha-postgres` 컨테이너가 검증 시작 전부터 떠 있었다 (OrbStack이 5432를 LISTEN). 이 세션이 띄우거나 멈추지 않았다.
  - 실험 격리 포트 55432/58000/58100: V1 실측 결과 모두 free
- 실행 일시: 2026-09-09 06:40 ~ 06:41 UTC (KST 15:40 전후)

## 사전 확인

- `git -C /Users/gim-yeongjae/project/daewha-electron-phase-0 rev-parse HEAD` → `f1e1dfffa973c5ec52c0b326c2843ff6f5d4675c` — COMMIT과 일치.
- 검증 시작 전 `ps aux`에 postgres/mlx_lm/embed 프로세스 없음(호스트 프로세스 기준; damwha-postgres는 Docker 컨테이너로 별도 확인, 아래 "개발 DB 무변화" 참고).

## V1. `bash experiments/electron-phase-0/lib/preflight.sh 5`
- cwd: `<repo root>` (worktree 루트)
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

## V2. `bash experiments/electron-phase-0/verify/t1-env-allowlist.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 실행의 환경 변수 집합이 스펙 §4.2 표의 11개 이름과 정확히 일치하고, `VIRTUAL_ENV`·`PYTHONPATH`·`UV_*`가 없음
- 실제 (자식 프로세스에 실제로 나열된 변수 이름 전체, 그대로 옮김):
  ```
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
  ```
  (12개 이름, 알파벳순)
- 스크립트가 출력한 판정 문구(그대로 옮김):
  ```
  OK  주입 변수 11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)가 정확히 일치한다
  OK  VIRTUAL_ENV / PYTHONPATH / PYTHONHOME / UV_* / HUGGINGFACE_HUB_CACHE 가 모두 없다
  OK  HF_TOKEN 주입 상태가 be/worker/.env와 일치한다 (set=1)
  OK  증거에 HF_TOKEN이 set/unset으로만 적혀 있다
  OK  증거 디렉터리 어디에도 HF_TOKEN 값이 없다
  ```
- 1회차 대비 기록: 1회차 stdout은 "11개"라고만 적어 11개 이름과 실제 나열 12개가 어긋났다. 이번 회차는 "주입 변수 11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)"로 문구가 바뀌었고, 나열된 변수 이름은 위 12개(값 기록 대상 11개 + HF_TOKEN)로 1회차와 이름 자체는 동일하다. 문구만 12를 명시하도록 바뀌었다.
- 일치: 예 (변수 이름 집합 자체는 스펙 §4.2와 일치. 개수 표기 문구는 이번 회차에 "12"를 명시함)
- 종료 코드: 0

## V3. `bash experiments/electron-phase-0/verify/t1-no-dev-tools.sh`
- cwd: `<repo root>`
- 기대: exit 0. 격리 안에서 `ffmpeg`·`uv`·`node`를 찾을 수 없고, `python3`은 `/usr/bin/python3`이며 `sys.prefix`가 `/Library/Frameworks/Python.framework`도 `.venv`도 아님
- 실제:
  ```
  TOOL ffmpeg (not found)
  TOOL uv (not found)
  TOOL node (not found)
  TOOL python3 /usr/bin/python3
  PYPREFIX /Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9
  OK  sys.prefix가 머신 전역 Python.framework도 개발 가상환경도 아니다
  ```
- 일치: 예
- 종료 코드: 0

## V4. `bash experiments/electron-phase-0/verify/t1-home-isolated.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$HOME`이 `experiments/electron-phase-0/sandbox/home`이고 개발자 홈의 `.cache`·`.local`이 보이지 않음
- 실제:
  ```
  HOME /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home
  OK  HOME이 샌드박스다: .../sandbox/home
  OK  격리 안의 HF 캐시가 개발자 캐시와 다른 디렉터리다
  OK  격리 HOME에 .local이 없다 (uv tool 설치본이 배제됐다)
  ```
- 일치: 예
- 종료 코드: 0

## V5. `bash experiments/electron-phase-0/verify/t1-detector-negative.sh`
- cwd: `<repo root>`
- 기대: exit 0. **음성 대조군** — `check-macho.sh /opt/homebrew/bin`이 위반을 실제로 검출(비정상 종료)했을 때만 통과
- 실제: 대조군 3종을 검사했고 각각의 결과 줄은 다음과 같다.

  **A. 합성 대조군** — 금지 문자열 9종 + otool -L 의존 위반 + LC_RPATH 위반 + STALE-PATH(재배치 잔존 경로) 3종. 픽스처는 `$SANDBOX/tmp/g1-detector-fixture`에 스크립트가 자체 생성.
  ```
  OK   check-macho.sh가 비정상 종료했다 (exit 1)
  위반          : 14건
  OK   금지 문자열 9종을 모두 검출했다 (스펙 §4.1 표 7행 전부)
  OK   otool -L 의존 경로 위반을 검출했다
  OK   LC_RPATH 위반을 검출했다
  OK   재배치 잔존 경로를 검출했다: stale-shebang
  OK   재배치 잔존 경로를 검출했다: stale-pyvenv.cfg
  OK   재배치 잔존 경로를 검출했다: stale-pkgconfig.pc
  OK   fat 바이너리 경로를 아키텍처 꼬리표 없이 다뤘다
  ```
  (STALE-PATH 위반 3줄 원문)
  ```
  STALE-PATH .../g1-detector-fixture/stale-pkgconfig.pc: .../experiments/electron-phase-0/sandbox/stale-prefix  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
  STALE-PATH .../g1-detector-fixture/stale-pyvenv.cfg: .../experiments/electron-phase-0/downloads/cpython/bin  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
  STALE-PATH .../g1-detector-fixture/stale-shebang: .../experiments/electron-phase-0/stage/python/bin/python3  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
  ```

  **B. 실물 대조군** — 계획 V5가 지정한 대상 그대로 `check-macho.sh /opt/homebrew/bin`:
  ```
  OK   비정상 종료했다 (exit 1)
    검출한 위반 줄 수: 6
    위반          : 6건
  ```

  **C. dyld 실측 대조군** — 플랫폼 바이너리가 아닌 Mach-O(ad-hoc 서명한 `/bin/echo` 복사본)를 격리 실행:
  ```
  OK   dyld 줄 81건을 실측했다
    dyld[71146]: <...> .../sandbox/tmp/g2-dyld-control/echo
    dyld[71146]: <...> /usr/lib/libSystem.B.dylib
    dyld[71146]: <...> /usr/lib/system/libcache.dylib
  ```

  종합: `모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다`
- 일치: 예
- 종료 코드: 0

## V6. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/lib`
- cwd: `<repo root>`
- 기대: exit 0. **양성 대조군** — 위반 없는 입력에서 오탐 없음
- 실제:
  ```
  파일 수       : 7
  Mach-O 수     : 0
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
  ```
- 일치: 예
- 종료 코드: 0

## V7. `bash experiments/electron-phase-0/verify/t1-evidence-tracked.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$EVIDENCE`의 `.md`/`.txt`가 gitignore에 걸리지 않고, 디렉터리에 `.log` 파일이 없음
- 실제:
  ```
  OK   .log는 무시된다 — 스펙 §6의 근거가 지금도 참이다
  OK   .txt 는 무시되지 않는다
  OK   .md 는 무시되지 않는다
  OK   .../phase-0 에 .log 파일이 없다
  OK   증거 파일 18개
  ```
  (`.gitignore` 하위 sandbox/stage/bundle/pgdata/run/downloads/signed 확인, lib/config.sh·verify/t1-evidence-tracked.sh·probe/deps-survey.md 커밋 대상 확인 — 전부 OK)
- 일치: 예
- 종료 코드: 0
- 부수 관찰(격리 러너 증거 회전): V2~V5 실행 중 `run-isolated.sh`가 기존 `t1-env-*.txt`/`t1-home-*.txt`/`t1-nodev-*.txt`/`t1-dyld-control-*.txt`를 갱신하면서 이전 내용을 `<이름>.prev-<timestamp>.txt`로 회전 보존했다. V7 출력의 "증거 파일 18개" 목록에 다음 8개의 `.prev-*.txt`가 새로 나타난다: `t1-dyld-control-dyld.prev-20260909T064103Z.txt`, `t1-dyld-control-env.prev-20260909T064103Z.txt`, `t1-env-dyld.prev-20260909T064035Z.txt`, `t1-env-env.prev-20260909T064035Z.txt`, `t1-home-dyld.prev-20260909T064041Z.txt`, `t1-home-env.prev-20260909T064041Z.txt`, `t1-nodev-dyld.prev-20260909T064039Z.txt`, `t1-nodev-env.prev-20260909T064039Z.txt`.

## V8. `grep -q 'U-4' experiments/electron-phase-0/probe/deps-survey.md && grep -q 'U-5' experiments/electron-phase-0/probe/deps-survey.md`
- cwd: `<repo root>`
- 기대: exit 0
- 실제: 조합 명령이 exit 0으로 종료 (두 `grep -q` 모두 매치). `deps-survey.md`는 134줄.
- 일치: 예
- 종료 코드: 0

## V9. `test -f experiments/electron-phase-0/sandbox/audio/sample.flac && grep -q 'mtg_' experiments/electron-phase-0/probe/audio-source.txt`
- cwd: `<repo root>`
- 기대: exit 0. 검증 오디오가 복사됐고 출처가 기록됨
- 실제: exit 0. `audio-source.txt`에 `선택한 회의 : mtg_28`, `원본 경로 : /Users/gim-yeongjae/project/daewha/be/storage/meetings/mtg_28/original.flac` 기록 확인 (93줄, mtg_28을 최소 길이/크기 회의로 선정한 근거 표 포함).
- 일치: 예
- 종료 코드: 0

## V10. `test ! -f experiments/electron-phase-0/package.json`
- cwd: `<repo root>`
- 기대: exit 0. pnpm 워크스페이스 멤버가 아님
- 실제: `package.json` 없음 확인, exit 0
- 일치: 예
- 종료 코드: 0

## V11. `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts`
- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음 (빈 문자열)
- 일치: 예
- 종료 코드: 0

## V12. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh before && bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`
- cwd: `<repo root>`
- 기대: exit 0. `be/storage` 원본 무변화
- 실제:
  ```
  be/storage
    root: /Users/gim-yeongjae/project/daewha/be/storage
    files: 29
    bytes: 2227477523
    newest_mtime: 1788857034
    manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
  개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다
  ```
  before/after 모두 docker volume 목록(damwha_pgdata 포함 13개) 동일, be/storage 매니페스트 sha256 동일.
- 일치: 예
- 종료 코드: 0

<details><summary>V1~V12 전체 stdout (원문, 순서대로)</summary>

```
$ bash experiments/electron-phase-0/lib/preflight.sh 5
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

$ bash experiments/electron-phase-0/verify/t1-env-allowlist.sh
t1-env-allowlist.sh — G2 주입 화이트리스트 검사 (스펙 §4.2)
run-isolated: label=t1-env  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.NOJLyY/stderr.raw)

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

$ bash experiments/electron-phase-0/verify/t1-no-dev-tools.sh
t1-no-dev-tools.sh — 격리 안의 도구 가시성 (스펙 §4.2)
run-isolated: label=t1-nodev  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.MsPnuk/stderr.raw)

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

$ bash experiments/electron-phase-0/verify/t1-home-isolated.sh
t1-home-isolated.sh — HOME 격리 검사 (스펙 §4.2)
run-isolated: label=t1-home  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.y9P3F6/stderr.raw)

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

$ bash experiments/electron-phase-0/verify/t1-detector-negative.sh
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
run-isolated: label=t1-dyld-control  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.GqXyZj/stderr.raw)
  OK   dyld 줄 81건을 실측했다
    dyld[71146]: <1847B2BD-6C7D-3600-82B0-AC6B5F8F823F> .../sandbox/tmp/g2-dyld-control/echo
    dyld[71146]: <4FDC9AA6-B344-37FE-B8C6-A4C94A038F57> /usr/lib/libSystem.B.dylib
    dyld[71146]: <83E81326-A587-374F-ABC1-BAE48D0FEE0D> /usr/lib/system/libcache.dylib

모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다
EXIT:0

$ bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/lib
check-macho.sh (G1, 스펙 §4.1)
  대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/lib
  파일 수       : 7
  Mach-O 수     : 0
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 1개 파일
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
EXIT:0

$ bash experiments/electron-phase-0/verify/t1-evidence-tracked.sh
t1-evidence-tracked.sh — 증거 경로와 gitignore (스펙 §6)
  EVIDENCE: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0
  OK   .log는 무시된다 — 스펙 §6의 근거가 지금도 참이다
  OK   .txt 는 무시되지 않는다
  OK   .md 는 무시되지 않는다
  OK   .../phase-0 에 .log 파일이 없다
  OK   증거 파일 18개
    docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T064103Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T064103Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T064035Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T064035Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-env-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T064041Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T064041Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-home-env.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T064039Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T064039Z.txt
    docs/superpowers/reports/evidence/phase-0/t1-nodev-env.txt
    docs/superpowers/reports/evidence/phase-0/task-1-r1.md

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

$ grep -q 'U-4' experiments/electron-phase-0/probe/deps-survey.md && grep -q 'U-5' experiments/electron-phase-0/probe/deps-survey.md
EXIT:0

$ test -f experiments/electron-phase-0/sandbox/audio/sample.flac && grep -q 'mtg_' experiments/electron-phase-0/probe/audio-source.txt
EXIT:0

$ test ! -f experiments/electron-phase-0/package.json
EXIT:0

$ git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts
(출력 없음)
EXIT:0

$ bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh before && bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after
before 기록: .../sandbox/state/dev-assets-before.txt
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
(동일 13개 목록)
## be/storage
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
EXIT:0
```
</details>

## 1. 1회차 차단 지적의 수정 여부 — 수동 픽스처 3종

1회차 리뷰 지적: `check-macho.sh`의 금지 문자열 면제가 검사 대상 디렉터리 루트(`$ROOT`)가 아니라 실험 디렉터리 전체(`$EXP_ROOT`)로 넓게 걸려 있어서, `stage/`·`downloads/`·`sandbox/`를 가리키는 재배치 잔존 경로가 INFO로 빠지고 위반 0건이 됐다.

이번 회차에 `t1-detector-negative.sh`에 내장된 회귀 대조군(A절, stale-shebang/stale-pyvenv.cfg/stale-pkgconfig.pc)과는 별개로, **직접 만든 임시 픽스처**로 재확인했다. 스크래치패드가 아니라 시스템 임시 디렉터리(`mktemp -d /tmp/task1-r2-fixture.XXXXXX` → `/private/tmp/task1-r2-fixture.HKMpQO`)에 검사 대상 파일 3개를 두고 `check-macho.sh <그 디렉터리>`로 검사했다. 이 디렉터리는 `$EXP_ROOT`(`experiments/electron-phase-0`) 밖에 있으므로, 파일 안에 박힌 `$EXP_ROOT/stage/...` 등의 경로는 검사기 관점에서 "검사 대상($ROOT) 자신"이 아니라 "실험 디렉터리 안이지만 검사 대상 밖"인 STALE-PATH 케이스로 분류돼야 한다.

- 픽스처 1 — shebang 한 줄: `#!/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/stage/python/bin/python3` (파일명 `console-script`)
- 픽스처 2 — `pyvenv.cfg`: `home = /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/downloads/cpython/bin`
- 픽스처 3 — `.pc` 파일 (`libfoo.pc`): `prefix=/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/x`

실제 실행 결과 (`bash experiments/electron-phase-0/lib/check-macho.sh /private/tmp/task1-r2-fixture.HKMpQO`):
```
check-macho.sh (G1, 스펙 §4.1)
  대상          : /private/tmp/task1-r2-fixture.HKMpQO
  파일 수       : 3
  Mach-O 수     : 0
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 3개 파일
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 3건
    STALE-PATH /private/tmp/task1-r2-fixture.HKMpQO/console-script: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/stage/python/bin/python3  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
    STALE-PATH /private/tmp/task1-r2-fixture.HKMpQO/libfoo.pc: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/x  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
    STALE-PATH /private/tmp/task1-r2-fixture.HKMpQO/pyvenv.cfg: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/downloads/cpython/bin  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
EXIT:1
```

세 형태 모두 STALE-PATH로 위반 목록에 나왔고 종료 코드는 1이다 (INFO로 빠진 항목 없음, `검사 대상 내부 절대경로(INFO): 0건`).

픽스처 디렉터리는 검사 직후 삭제했다: `rm -rf /private/tmp/task1-r2-fixture.HKMpQO`. 삭제 후 `ls -d /tmp/task1-r2-fixture.*` → `no matches found`로 재확인. worktree의 추적 파일은 건드리지 않았다 (아래 `git status --porcelain` 전체 출력에 이 픽스처 관련 항목 없음).

## 2. V2 변수 개수 표기

1회차 stdout: "11개"라고만 표기, 실제 나열은 12개였음 (리뷰 지적).

이번 회차(2회차) `t1-env-allowlist.sh` stdout 원문:
```
OK  주입 변수 11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)가 정확히 일치한다
```

실제로 나열된 변수 이름 전체 (자식 프로세스 환경, 12개, 스크립트 출력 순서 그대로):
```
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
```
문구가 "11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)"로 바뀌어 11과 12 두 숫자를 모두 명시하고 있고, 나열된 이름 수는 12개로 일치한다.

## 3. V5 대조군 — 몇 개를 검사하는지와 각각의 결과 줄

`t1-detector-negative.sh`는 대조군을 **3개** 절(A/B/C)로 나눠 검사한다.

- **A. 합성 대조군** — `$SANDBOX/tmp/g1-detector-fixture`에 스크립트가 직접 만든 픽스처. 세부적으로는:
  - 금지 문자열 9종(패턴 파일 9개, `forbidden-strings.txt`에서 읽어 생성 — 계획 문서의 "7종" 표기와 달리 실제 패턴 파일 행 수는 9)
  - otool -L 의존 경로 위반 1건(`dep-bad`, fat 바이너리)
  - LC_RPATH 위반 1건(`rpath-bad`)
  - STALE-PATH(재배치 잔존 경로) 3건(`stale-shebang`, `stale-pyvenv.cfg`, `stale-pkgconfig.pc`)
  - 결과 줄:
    ```
    OK   check-macho.sh가 비정상 종료했다 (exit 1)
    OK   금지 문자열 9종을 모두 검출했다 (스펙 §4.1 표 7행 전부)
    OK   otool -L 의존 경로 위반을 검출했다
    OK   LC_RPATH 위반을 검출했다
    OK   재배치 잔존 경로를 검출했다: stale-shebang
    OK   재배치 잔존 경로를 검출했다: stale-pyvenv.cfg
    OK   재배치 잔존 경로를 검출했다: stale-pkgconfig.pc
    OK   fat 바이너리 경로를 아키텍처 꼬리표 없이 다뤘다
    ```
- **B. 실물 대조군** — 계획 V5가 지정한 그대로 `/opt/homebrew/bin` (`CHECK_MACHO_MAX_VIOLATIONS=3`로 조기 종료).
  - 결과 줄:
    ```
    OK   비정상 종료했다 (exit 1)
      검출한 위반 줄 수: 6
      위반          : 6건
    ```
- **C. dyld 실측 대조군** — ad-hoc 서명한 `/bin/echo` 복사본(`$SANDBOX/tmp/g2-dyld-control/echo`)을 `run-isolated.sh`로 격리 실행해 `DYLD_PRINT_LIBRARIES` 실측이 동작하는지 확인.
  - 결과 줄:
    ```
    OK   dyld 줄 81건을 실측했다
    ```

세 절 전부 "OK"이고 스크립트 최종 출력은 `모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다`, 종료 코드 0.

## 개발 DB / be/storage 쓰기 여부

- V12 (`snapshot-dev-assets.sh before` → `after`) 결과: `be/storage` 매니페스트(`files=29, bytes=2227477523, manifest_sha256=a18870e6...`)와 docker volume 목록(13개, `damwha_pgdata` 포함)이 before/after 동일. 무변화.
- `damwha-postgres` Docker 컨테이너(포트 5432)는 검증 시작 전부터 OrbStack에서 이미 LISTEN 중이었다. 이 세션이 새로 띄우거나 멈추지 않았다.
- 이 회차 전체를 통틀어 `be/storage`나 포트 5432 DB에 대한 쓰기 시도는 없었다 (Verify 명령 어디에도 해당 경로에 쓰는 명령이 없다).

## `docs/superpowers/reports/evidence/phase-0/` 파일 목록과 확장자별 개수

`t1-evidence-tracked.sh` 실행 시점(V7) 기준 18개 (검증 실행 중 증거 회전으로 8개의 `.prev-*.txt`가 새로 생겼다). 확장자별:
```
   1 .md
  17 .txt
```
(`.md` 1개는 `task-1-r1.md`. 이 파일이 EVIDENCE 작성 완료되면 `task-1-r2.md`가 추가돼 `.md` 2개가 된다.)

## `git status --porcelain` 전체 출력 (검증 종료 시점)

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
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T064103Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T064103Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-dyld.prev-20260909T064035Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-env-env.prev-20260909T064035Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-dyld.prev-20260909T064041Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-home-env.prev-20260909T064041Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-dyld.prev-20260909T064039Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-nodev-env.prev-20260909T064039Z.txt
?? docs/superpowers/reports/evidence/phase-0/task-1-r1.md
```
(이 목록은 이 EVIDENCE 파일(`task-1-r2.md`) 자체를 쓰기 전 시점이다. `task-1-r1.md`는 1회차 산출물로 이미 추적되지 않은 상태로 존재하던 것이며 이번 회차가 만들지 않았다.)

이 M/?? 항목 전부가 `experiments/electron-phase-0/lib/run-isolated.sh`의 증거 회전 동작(기존 `-env.txt`/`-dyld.txt`를 갱신하며 이전 내용을 `.prev-<timestamp>.txt`로 남김)과 V7 실행 결과이며, `be/src`·`be/worker/damwha_worker`·`be/worker/scripts`·`fe/src`·`packages/contracts` 쪽에는 아무 항목도 없다 (V11과 일치).

## 프로세스 정리

- 기동 전 (`ps aux | grep -iE "postgres|mlx_lm|embed"`, grep 자신 제외): nvim 프로세스 2개만 있었고 postgres/mlx_lm/embed 관련 호스트 프로세스는 없었음. `damwha-postgres` Docker 컨테이너는 검증 시작 전부터 떠 있었음(직접 확인은 검증 종료 후 `docker ps`로 했다 — 이 컨테이너는 이 세션이 띄운 것이 아니므로 시작·종료 시점 모두 손대지 않았다).
- 이 회차에서 직접 띄운 것: `t1-detector-negative.sh`의 C절이 `run-isolated.sh`로 격리 실행한 ad-hoc 서명 `/bin/echo` 복사본 1건. 이 프로세스는 즉시 실행·종료되는 `echo` 명령이라 스크립트 안에서 실행과 동시에 종료됐다 (별도 정리 불필요, 데몬화 없음).
- 종료 후 (`ps aux | grep -iE "postgres|mlx_lm|embed"`): nvim 프로세스 2개만 남음. postgres/mlx_lm/embed 관련 호스트 프로세스 없음. `damwha-postgres` 컨테이너는 여전히 떠 있음(이 세션이 만든 상태 변화 아님).
