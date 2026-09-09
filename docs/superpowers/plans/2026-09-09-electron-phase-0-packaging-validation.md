# Electron Phase 0 — 패키징 기술 검증 구현 계획

**작성일:** 2026-09-09

**상태:** 계획 검증 통과, 확정.

**스펙:** [2026-09-09-electron-phase-0-packaging-validation-design.md](../specs/2026-09-09-electron-phase-0-packaging-validation-design.md) (454줄, 스펙 리뷰 3회차 통과, 2026-09-09 사용자 승인)

**결과 문서:** [2026-09-09-electron-phase-0-packaging-validation-results.md](../reports/2026-09-09-electron-phase-0-packaging-validation-results.md)

**브랜치:** `feat/electron-migration-phase-0-packaging-validation`

**worktree:** `/Users/gim-yeongjae/project/daewha-electron-phase-0` — 아래 모든 `<repo root>`는 이 경로다.

**BASE:** `494d44c`

## 이 계획이 만드는 것

제품 기능이 아니라 **검증 실험**이다. 산출물은 `experiments/electron-phase-0/`의 일회성 실험 코드, `docs/superpowers/reports/evidence/phase-0/`의 증거, 그리고 결과 문서의 기술 결정이다.

`be/src`, `be/worker/damwha_worker`, `be/worker/scripts`, `fe/src`, `packages/contracts`는 **한 줄도 고치지 않는다** (스펙 §3.2). 실행하고 읽는 것은 허용된다.

## 고정값

계획 전체가 공유하는 상수다. 각 Task가 임의로 바꾸지 않는다.

| 이름 | 값 | 근거 |
| --- | --- | --- |
| `EXP` | `<repo root>/experiments/electron-phase-0` | 스펙 §6 |
| `SANDBOX` | `$EXP/sandbox` | 스펙 §6, gitignore |
| `EVIDENCE` | `<repo root>/docs/superpowers/reports/evidence/phase-0` | 스펙 §6 |
| 실험 DB 포트 | `55432` | 스펙 §7.1 U-6 (`lsof` 확인, 개발 5432와 분리) |
| `mlx_lm.server` 포트 | `58000` | 〃 (개발 8000과 분리) |
| embed 서비스 포트 | `58100` | 〃 (개발 8100과 분리) |
| 마이그레이션 파일 수 | **24** (`be/src/database/migrations/*.sql`) | `_migrations` 행 수 대조의 기대값 |
| 증거 파일 확장자 | `.md` / `.txt` **만** | 루트 `.gitignore:37`의 `*.log`가 경로 무관하게 걸린다 (스펙 §6) |
| 증거 파일명 | `$EVIDENCE/task-<N>-r<회차>.md` (+ 부속 `.txt`) | 회차마다 새 파일, 덮어쓰지 않는다 |

## Verify 명령 작성 규칙

**Verify 표의 셀에는 파이프(`|`)와 `||`를 쓰지 않는다.** 마크다운 표에서 이스케이프가 필요해지고, verifier가 이스케이프된 문자열을 그대로 실행하면 명령이 깨진다. 합성이 필요한 검사는 `$EXP/verify/t<N>-<이름>.sh` 스크립트로 만들고 표에서는 그 스크립트 하나만 호출한다.

각 스크립트는 **조건을 만족하면 exit 0, 아니면 exit 1**이며, 판정 근거를 stdout에 출력한다. "exit 1을 기대하는" 검사(음성 대조군)도 스크립트가 뒤집어 exit 0으로 만든다 — verifier가 비정상 종료와 의도된 실패를 구분하지 못하는 상황을 없애기 위해서다.

`&&`는 표에서 그대로 써도 된다 (이스케이프가 필요 없다).

리뷰어는 **verify 스크립트의 내용도 diff에서 확인한다.** 무조건 exit 0인 스크립트는 차단 지적이다.

## 런처 스크립트의 dyld 실측 규칙

**2026-09-09 계획 수정.** Task 1 재리뷰가 찾아낸 사실이며, 측정으로 확인했다.

SIP는 플랫폼 바이너리(`/bin/bash`, `/bin/sh`, `/usr/bin/python3` 등)를 **exec할 때마다** 환경에서 `DYLD_*`를 지운다. 환경 격리(`PATH`·`HOME`·화이트리스트)는 런처를 거쳐도 멀쩡하지만 **dyld 실측만 끊긴다.**

| 실행 형태 | dyld 줄 |
| --- | --- |
| `env -i DYLD_PRINT_LIBRARIES=1 <번들 Mach-O>` | 81 |
| `env -i DYLD_PRINT_LIBRARIES=1 <bash 런처>` → Mach-O | **0** |
| bash 런처가 `exec` 직전 `export DYLD_PRINT_LIBRARIES=1` | 81 |
| 런처가 자식 stderr를 `2>/dev/null` | **0** |

exec 심으로는 못 고친다 — 심이 다시 bash를 exec하는 순간 또 지워진다. 따라서 다음을 규칙으로 한다.

1. **번들 Mach-O를 `exec`하기 직전에 런처가 `export DYLD_PRINT_LIBRARIES=1`을 다시 설정한다.** `$EXP/pg/run.sh`, `$EXP/services/embed.sh`, `$EXP/services/llm.sh`, `$EXP/lib/selfreport-all.sh`가 대상이다.
2. **런처는 그 프로세스의 stderr를 리다이렉트하지 않는다.** `pg_ctl start -l <logfile>`처럼 stderr를 파일로 돌리면 dyld 줄이 그 파일로 새고 증거에는 **런처 자신의 로드 목록**만 남는다. 줄 수가 0이 아니므로 래퍼가 통과로 보는데 정작 서버의 라이브러리는 하나도 없는, 위반 0건짜리 가짜 증거가 된다.
3. **서버 런처의 `start`는 서버를 백그라운드로 띄우고 준비 상태를 기다린 뒤 exit 0 한다.** `run-isolated.sh`는 자식 종료까지 블로킹하고 증거도 그 뒤에 쓰므로, 서버를 포그라운드로 두면 Verify 행이 영영 돌아오지 않는다. 준비 대기(`pg_isready`, `/health`, `/v1/models`)를 런처 안에서 끝내면 서버의 초기 로드 dyld 줄은 그때 이미 전부 나와 래퍼의 캡처에 담긴다.
4. **PID 파일에는 서버 자신의 PID를 쓴다.** 래퍼 bash의 PID가 아니다. 증거의 `dyld[<pid>]`가 그 PID와 일치하는지 확인하는 것이 측정이 진짜인지 보는 방법이다.
5. Task 1의 `verify/t1-detector-negative.sh`가 이 규칙을 코드로 고정한다 — re-export 없는 런처는 dyld 0건, 있는 런처는 1건 이상이어야 하며 어긋나면 exit 1.

## Task 목록과 완료 기준 대응

| Task | 제목 | Tier | Spec |
| --- | --- | --- | --- |
| 1 | 실험 하네스 — 격리 러너·정적 검사·사전 점검 | critical | P0-C7(기반), U-4, U-5 |
| 2 | PostgreSQL 번들 후보 구성과 독립 실행 | critical | P0-C1 |
| 3 | Python·ML 런타임 구성과 재배치 | normal | P0-C3 |
| 4 | ffmpeg / ffprobe 번들 | low | P0-C6 |
| 5 | 임베딩 서비스와 `mlx_lm.server` | normal | P0-C5, P0-C5b |
| 6 | 하이브리드 검색 쿼리 | normal | P0-C2 |
| 7 | 실제 음성 처리 파이프라인 | critical | P0-C4 |
| 8 | 서명·hardened runtime·Gatekeeper 제약 | normal | P0-C9 |
| 9 | 모델 라이선스·게이팅과 용량·초기 비용 | normal | P0-C10, P0-C13 |
| 10 | 기술 결정 — 최소 macOS 버전과 실행 환경 제공 방식 | normal | P0-C11, P0-C12 |
| 11 | Phase 통합 검증과 결과 반영 | critical | P0-C7, P0-C8, P0-C14 |

15개 완료 기준 전부가 Task에 연결된다. P0-C7·P0-C8은 Task별로 증거를 쌓고 Task 11이 전수 집계한다.

---

### Task 1: 실험 하네스 — 격리 러너·정적 검사·사전 점검

**Tier:** critical
**Spec:** P0-C7(기반), 스펙 §4.0 / §4.1 / §4.2 / §4.4, U-1, U-4, U-5
**Depends:** 없음

이 Task가 만드는 러너가 이후 모든 실행 검증의 유일한 통로다. 여기가 느슨하면 나머지 열 Task의 증거가 전부 무효가 되므로 `critical`이다.

**Files**

- Create: `$EXP/.gitignore` — `sandbox/`, `stage/`, `bundle/`, `pgdata/`, `run/`, `downloads/`
- Create: `$EXP/README.md` — 일회성 실험임을 명시, 제품 코드가 아님, Phase 0 종료 후 이식하지 않음
- Create: `$EXP/lib/sandbox.sh` — `SANDBOX` 디렉터리 생성, PID 파일 규약, `--fresh` 처리, 검증 오디오 복사
- Create: `$EXP/lib/run-isolated.sh` — G2 래퍼
- Create: `$EXP/lib/check-macho.sh` — G1 정적 검사
- Create: `$EXP/lib/preflight.sh` — 디스크 여유·포트 점유 확인
- Create: `$EXP/lib/snapshot-dev-assets.sh` — 개발 자산 무변화 확인
- Create: `$EXP/verify/t1-env-allowlist.sh`, `t1-no-dev-tools.sh`, `t1-home-isolated.sh`, `t1-detector-negative.sh`, `t1-evidence-tracked.sh`
  - `t1-detector-negative.sh`는 정적 검사기 대조군에 더해 **런처 dyld 대조군 한 쌍**을 갖는다: re-export 없는 bash 런처 → dyld 0건, re-export 있는 bash 런처 → 1건 이상. 어긋나면 exit 1 (위 "런처 스크립트의 dyld 실측 규칙" 5)
- Create: `$EXP/probe/deps-survey.md` — U-4 / U-5 조사 결과
- Create: `$EXP/probe/audio-source.txt` — U-1: 복사한 회의 id와 원본 경로·크기·mtime

**Interfaces**

- `run-isolated.sh [--label <name>] -- <command...>`
  - `/usr/bin/env -i`로 실행하고 스펙 §4.2 표의 12개 변수**만** 주입한다 (화이트리스트). 표의 행은 10개지만 이름은 `HF_TOKEN`까지 12개다 — `MODEL_CACHE_DIR, HF_HOME` 행과 `EMBED_SERVICE_HOST/PORT` 행이 각각 이름 둘을 담는다.
  - `HF_TOKEN`은 `be/worker/.env`에서 읽어 주입하되 **증거에는 `set`/`unset`만 기록하고 값을 남기지 않는다.**
  - `DYLD_PRINT_LIBRARIES=1`로 한 번 더 실행해 로드된 dylib 경로를 `$EVIDENCE/<label>-dyld.txt`에 남긴다. `DYLD_*`가 무시된 것으로 판단되면 그 파일 첫 줄에 `MEASUREMENT_UNAVAILABLE`을 적는다.
  - 주입한 변수 이름과 값(비밀값 제외)을 `$EVIDENCE/<label>-env.txt`에 남긴다.
- `check-macho.sh <디렉터리>` — 하위 전체를 훑어 (1) 모든 Mach-O의 `otool -L` 의존 경로, (2) `otool -l`의 `LC_RPATH`, (3) Mach-O·텍스트 파일 전체의 금지 문자열(스펙 §4.1 표 7종)을 검사한다. 위반 1건이라도 있으면 **exit 1**, 위반 목록을 stdout에 출력한다.
- `preflight.sh <필요GiB>` — 데이터 볼륨 여유가 인자보다 작으면 exit 1. 포트 55432·58000·58100 점유를 확인해 출력.
- `snapshot-dev-assets.sh {before|after}` — `docker volume ls`, `be/storage` 하위 파일 수와 최신 mtime을 기록. `after`는 `before`와 다르면 exit 1.
- `sandbox.sh copy-audio <meeting_id>` — `be/storage/meetings/<id>/original.flac`을 `$SANDBOX/audio/sample.flac`으로 **복사**하고 원본 경로·크기·mtime을 `probe/audio-source.txt`에 기록한다. **원본에 쓰지 않는다.** 이 오디오를 Task 4와 Task 7이 함께 쓴다.

**Steps**

- [ ] `$EXP` 디렉터리와 `.gitignore`·`README.md` 생성. `package.json`을 만들지 않는다 (pnpm 워크스페이스 멤버가 되면 안 된다).
- [ ] `sandbox.sh` — `$SANDBOX/{home,tmp,storage,run,audio}` 생성. `--fresh`는 `$SANDBOX` 하위만 지운다. 기존 PID 파일의 프로세스가 살아 있으면 새로 시작하지 않는다.
- [ ] `run-isolated.sh` 구현. 주입 변수는 스펙 §4.2 표에 있는 것만 허용하는 화이트리스트로.
- [ ] `check-macho.sh` 구현. `file`로 Mach-O를 판별하고, 텍스트 파일은 금지 문자열을 검색한다.
- [ ] `preflight.sh`, `snapshot-dev-assets.sh` 구현.
- [ ] **U-1:** `be/storage/meetings/` 중 2인 이상 대화가 담긴 회의 하나를 골라 `sandbox.sh copy-audio`로 복사하고 `probe/audio-source.txt`에 기록한다.
- [ ] **U-4 조사:** `sounddevice` / `damwha_worker/audio/source.py`의 마이크 경로가 2026-09-05 브라우저 캡처 전환 이후 실사용 경로에 남아 있는지 호출자를 역추적해 `probe/deps-survey.md`에 결론과 근거(파일·줄)를 적는다. 불확실하면 **번들에 포함**한다.
- [ ] **U-5 조사:** `be/src/settings/presets.ts`가 지정하는 whisper 모델과 `whisper_mlx.py::_REPO`의 6종을 대조해 Task 9의 실측 대상과 산정 대상을 확정하고 `probe/deps-survey.md`에 적는다.
- [ ] `verify/` 스크립트 5종 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/preflight.sh 5` | exit 0. 포트 55432·58000·58100이 `free`로 출력 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t1-env-allowlist.sh` | exit 0. 격리 실행의 환경 변수 집합이 스펙 §4.2 표의 12개 이름과 정확히 일치하고, `VIRTUAL_ENV`·`PYTHONPATH`·`UV_*`가 없음 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t1-no-dev-tools.sh` | exit 0. 격리 안에서 `ffmpeg`·`uv`·`node`를 찾을 수 없고, `python3`은 `/usr/bin/python3`이며 `sys.prefix`가 `/Library/Frameworks/Python.framework`도 `.venv`도 아님 |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t1-home-isolated.sh` | exit 0. `$HOME`이 `experiments/electron-phase-0/sandbox/home`이고 개발자 홈의 `.cache`·`.local`이 보이지 않음 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t1-detector-negative.sh` | exit 0. **음성 대조군** — (a) `check-macho.sh /opt/homebrew/bin`이 위반을 실제로 검출했고, (b) 재배치 잔존 경로 3형태(shebang·`pyvenv.cfg`·`*.pc`)가 각각 위반으로 잡히며, (c) re-export 없는 런처가 dyld 0건, 있는 런처가 1건 이상일 때만 통과 |
| V6 | `<repo root>` | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/lib` | exit 0. **양성 대조군** — 위반 없는 입력에서 오탐 없음 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/verify/t1-evidence-tracked.sh` | exit 0. `$EVIDENCE`의 `.md`/`.txt`가 gitignore에 걸리지 않고, 디렉터리에 `.log` 파일이 없음 |
| V8 | `<repo root>` | `grep -q 'U-4' experiments/electron-phase-0/probe/deps-survey.md && grep -q 'U-5' experiments/electron-phase-0/probe/deps-survey.md` | exit 0 |
| V9 | `<repo root>` | `test -f experiments/electron-phase-0/sandbox/audio/sample.flac && grep -q 'mtg_' experiments/electron-phase-0/probe/audio-source.txt` | exit 0. 검증 오디오가 복사됐고 출처가 기록됨 |
| V10 | `<repo root>` | `test ! -f experiments/electron-phase-0/package.json` | exit 0. pnpm 워크스페이스 멤버가 아님 |
| V11 | `<repo root>` | `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts` | 출력 없음 |
| V12 | `<repo root>` | `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh before && bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after` | exit 0. `be/storage` 원본 무변화 |

**Review**

- [ ] `$EXP`에 `package.json`이 없다 (pnpm 워크스페이스 오염 방지, 스펙 §6)
- [ ] `run-isolated.sh`의 주입 변수가 스펙 §4.2 표와 정확히 일치하고, 표에 없는 변수를 주입하지 않는다
- [ ] `HF_TOKEN` 값이 증거 파일·stdout·커밋 어디에도 남지 않는다
- [ ] `check-macho.sh`의 금지 문자열이 스펙 §4.1 표의 7종을 모두 포함한다 (`/Library/Frameworks/Python.framework` 포함)
- [ ] `check-macho.sh`가 Mach-O뿐 아니라 텍스트 파일(`pyvenv.cfg`, `*.pc`, 셸 래퍼, shebang)도 검사한다
- [ ] V5가 실제로 위반을 검출해서 통과한 것이다 — 검사기가 위반을 못 잡으면 이후 모든 증거가 무의미하다
- [ ] `verify/` 스크립트 5종이 실제 조건을 검사한다. **무조건 `exit 0`인 스크립트가 없다**
- [ ] `sandbox.sh --fresh`가 `$SANDBOX` 밖을 지우지 않는다 (경로 검증 코드가 존재)
- [ ] `sandbox.sh copy-audio`가 원본을 복사만 하고 쓰지 않는다
- [ ] 스크립트 어디에도 `pkill`·`killall`·`docker volume rm`·`docker compose down -v`가 없다 (스펙 §4.4)
- [ ] `.gitignore`가 `$EXP` 국소 파일이며 루트 `.gitignore`를 고치지 않았다
- [ ] U-4 결론에 근거 파일·줄이 있고, 불확실 시 포함 쪽으로 결정했다
- [ ] README의 뒤 Task 인계 항목이 실측과 일치한다. 특히 `DYLD_*`가 자손에게 상속된다고 적혀 있지 않다 — 플랫폼 바이너리를 거치면 끊긴다 (위 "런처 스크립트의 dyld 실측 규칙")
- [ ] `t1-detector-negative.sh`에 런처 dyld 대조군 한 쌍이 있고, 각각을 개별로 단정한다

**Rollback**

- `experiments/electron-phase-0/` 삭제로 원복된다. 저장소의 다른 파일을 만들지 않으므로 추가 조치 없음.

---

### Task 2: PostgreSQL 번들 후보 구성과 독립 실행

**Tier:** critical
**Spec:** P0-C1
**Depends:** Task 1

**Files**

- Create: `$EXP/pg/README.md` — 후보 조사와 선택 근거
- Create: `$EXP/pg/build.sh` — 선택한 후보로 `$EXP/stage/pg` 구성 (pgvector·pg_bigm 포함)
- Create: `$EXP/pg/run.sh` — `initdb` / `start` / `stop` / `kill` 서브커맨드
- Create: `$EXP/pg/psql.sh` — 번들 psql을 55432에 붙이는 얇은 래퍼 (Verify가 반복해서 쓴다)
- Create: `$EXP/verify/t2-extensions.sh`, `t2-migrations.sh`, `t2-restart.sh`, `t2-crash-recovery.sh`, `t2-idempotent.sh`, `t2-dev-db-untouched.sh`, `t2-dyld-measured.sh`

**Interfaces**

- 스펙 §9의 PostgreSQL 후보 4종 중 하나를 고른다. 어느 경우든 `pgvector`와 `pg_bigm 1.2-20240606`은 별도 빌드가 필요하다 (`be/docker/postgres-bigm/Dockerfile`이 컨테이너 안에서 하는 일과 같다).
- `run.sh start`는 포트 **55432**, 데이터 디렉터리 `$SANDBOX/pgdata`로 기동한다. **기존 `damwha_pgdata` 볼륨과 개발 5432 인스턴스를 건드리지 않는다.**
- `run.sh start`는 **백그라운드로 postgres를 띄우고 `pg_isready`로 준비를 기다린 뒤 exit 0** 한다. postgres를 `exec`하기 직전에 `export DYLD_PRINT_LIBRARIES=1`을 다시 설정하고, 그 프로세스의 stderr를 리다이렉트하지 않는다 — `pg_ctl start -l <logfile>` 금지. (위 "런처 스크립트의 dyld 실측 규칙" 1~3)
- `run.sh`는 **postgres 자신의 PID**를 `$SANDBOX/run/pg.pid`에 쓴다. 래퍼 bash의 PID가 아니다. 데이터 디렉터리가 이미 있으면 `initdb`를 다시 하지 않는다 (멱등, 스펙 §4.4).
- `run.sh kill`은 `$SANDBOX/run/pg.pid`의 PID에만 SIGKILL을 보낸다. 이름 기반 kill 금지.
- 마이그레이션은 `DATABASE_URL`을 55432로 지정해 `pnpm be:migrate`로 적용한다. **이 명령은 스펙 §4.0에 따라 격리 대상 밖**이며, 증거에 그렇게 표시한다. (`dotenv`는 이미 설정된 `process.env`를 덮어쓰지 않으므로 `be/.env`의 값이 아니라 주입한 값이 쓰인다 — V2가 그것을 확인한다.)

**Steps**

- [ ] 후보 조사 후 하나를 선택하고 탈락 이유를 `pg/README.md`에 남긴다.
- [ ] `build.sh`로 `$EXP/stage/pg`를 구성한다. `pgvector`·`pg_bigm`을 빌드해 넣는다.
- [ ] `check-macho.sh`로 검사하고 위반을 해소한다. 필요하면 `install_name_tool`로 rpath를 고치되 그 처리를 `build.sh`에 남겨 재현 가능하게 한다.
- [ ] **재배치 검증:** `$EXP/stage/pg`를 `$EXP/bundle/pg`로 옮긴 뒤 이후 단계를 전부 옮긴 경로에서 수행한다.
- [ ] `run.sh initdb` → `run.sh start` → `CREATE EXTENSION vector` / `pg_bigm`.
- [ ] `pnpm be:migrate` 적용.
- [ ] 정상 종료 → 재기동 → 유지 확인. SIGKILL → 재기동 → crash recovery 확인.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/pg` | exit 0. 재배치 후 위반 0건 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t2-start -- experiments/electron-phase-0/pg/run.sh start` | exit 0. `$SANDBOX/run/pg.pid` 생성. 래퍼가 블로킹하지 않고 돌아온다 |
| V2b | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-dyld-measured.sh` | exit 0. `$EVIDENCE/t2-start-dyld.txt`에 dyld 줄 1건 이상이고, 그 `dyld[<pid>]`의 pid가 `pg.pid`의 PID와 일치하며, `MEASUREMENT_UNAVAILABLE`이 아니다 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-extensions.sh` | exit 0. `pg_extension`에 `vector`와 `pg_bigm`(버전 `1.2`)이 모두 존재 |
| V4 | `<repo root>` | `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/damwha pnpm be:migrate` | exit 0 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-migrations.sh` | exit 0. 55432의 `_migrations` 행 수가 `be/src/database/migrations/*.sql` 파일 수(24)와 같음 |
| V6 | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-restart.sh` | exit 0. `pg_ctl stop -m fast` 후 재기동해도 `_migrations`가 24 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-crash-recovery.sh` | exit 0. PID 파일 대상 SIGKILL 후 재기동해도 `_migrations`가 24 |
| V8 | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-idempotent.sh` | exit 0. `run.sh initdb`를 다시 불러도 데이터 디렉터리를 재초기화하지 않고 `_migrations`가 24 유지 |
| V9 | `<repo root>` | `bash experiments/electron-phase-0/verify/t2-dev-db-untouched.sh` | exit 0. `damwha_pgdata` 볼륨이 그대로 존재하고, 개발 컨테이너 수가 Task 시작 시점과 같음 |
| V10 | `<repo root>` | `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after` | exit 0 |
| V11 | `<repo root>` | `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts` | 출력 없음 |

**Review**

- [ ] `pg_bigm`이 `1.2-20240606`(현재 Dockerfile과 같은 버전)이다
- [ ] 데이터 디렉터리가 `$SANDBOX/pgdata`이고 `damwha_pgdata`/`be_pgdata` 볼륨을 참조하지 않는다
- [ ] 포트가 55432로 고정돼 있고 5432가 코드 어디에도 없다
- [ ] 마이그레이션이 `pnpm be:migrate`로 적용됐다 — `.sql` 직접 실행이 아니다 (`_migrations` 계약, 스펙 §4.0)
- [ ] V4가 실제로 55432에 적용됐음이 V5로 확인된다 (개발 DB가 아니다)
- [ ] `run.sh kill`이 PID 파일 대상이다 — `pkill postgres` 같은 이름 기반 kill이 없다
- [ ] `run.sh`가 postgres exec 직전에 `DYLD_PRINT_LIBRARIES`를 다시 export하고 stderr를 리다이렉트하지 않는다. `pg.pid`에 postgres 자신의 PID가 들어간다 (V2b가 그것을 증명)
- [ ] 스테이징 경로가 아니라 **옮긴 뒤의 경로**(`bundle/pg`)에서 V2~V8이 수행됐다 — 재배치 검증이 실제로 이뤄졌다
- [ ] `install_name_tool` 등 사후 처리를 했다면 `build.sh`에 남아 재현 가능하다
- [ ] 스펙 P0-C1의 "SIGKILL 후 재기동" 조건이 V7로 존재한다
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

**Rollback**

- `experiments/electron-phase-0/pg/run.sh stop` → `sandbox.sh --fresh`로 `$SANDBOX` 하위만 삭제.
- 실패해도 개발 DB는 무관하다 — 포트·데이터 디렉터리·볼륨이 전부 분리돼 있다. V9·V10이 그것을 증명한다.

---

### Task 3: Python·ML 런타임 구성과 재배치

**Tier:** normal
**Spec:** P0-C3
**Depends:** Task 1

**Files**

- Create: `$EXP/python/README.md` — 후보 조사와 선택 근거
- Create: `$EXP/python/build.sh` — 독립 Python 3.12 런타임 + `models` extra + `mlx-lm` + `damwha_worker` 설치
- Create: `$EXP/python/selfreport.py` — 런타임 자기 보고 덤프 (P0-C8의 Python 절반)
- Create: `$EXP/verify/t3-imports.sh`, `t3-mps.sh`, `t3-selfreport.sh`, `t3-versions.sh`

**Interfaces**

- 스펙 §9의 Python 후보 4종 중 하나를 고른다. `mlx-lm`은 **같은 런타임 안에** 넣는다 — 현재처럼 uv tool로 분리하면 번들에서 재현되지 않는다 (스펙 §2, R-9).
- `damwha_worker`도 이 런타임에 **설치**한다. `PYTHONPATH`로 개발 venv를 끌어오는 방식은 금지 (스펙 P0-C3).
- `selfreport.py`는 `sys.executable`·`sys.prefix`·`sys.base_prefix`·`sys.path`·`sysconfig.get_paths()`·`site.getsitepackages()`와 주요 모듈의 `__file__`을 JSON으로 stdout에 낸다.
- `t3-versions.sh`가 대조할 기준은 `be/worker/pyproject.toml`의 `models` extra 고정 버전이다 — torch 2.12.1, torchaudio 2.11.0, silero-vad 6.2.1, pyannote.audio 4.0.5, speechbrain 1.1.0, soundfile 0.14.0, numpy 2.4.6, mlx-whisper 0.4.3, faster-whisper 1.2.1, sentence-transformers 5.6.0.

**Steps**

- [ ] 후보 조사 후 선택, 탈락 이유를 `python/README.md`에.
- [ ] `build.sh`로 `$EXP/stage/python` 구성. `models` extra 전량을 그 버전 그대로 설치한다.
- [ ] `check-macho.sh` 통과시킨다. 콘솔 스크립트 shebang의 절대 경로(R-9)를 특히 본다.
- [ ] **재배치:** `$EXP/stage/python` → `$EXP/bundle/python`. 이후 전부 옮긴 경로에서.
- [ ] `selfreport.py`와 `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/python` | exit 0 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t3-imports.sh` | exit 0. 격리 실행에서 `torch`·`torchaudio`·`mlx_whisper`·`mlx_lm`·`pyannote.audio`·`speechbrain`·`silero_vad`·`sentence_transformers`·`faster_whisper`·`soundfile`·`numpy`·`fastapi`·`uvicorn`·`damwha_worker` 전부 import 성공 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t3-mps.sh` | exit 0. `damwha_worker.models.device.mps_available()`가 `True` |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t3-selfreport.sh` | exit 0. 덤프된 모든 경로가 `bundle/` 또는 `sandbox/` 하위이고, `/Library/Frameworks/Python.framework`·`/opt/homebrew`·`.venv`가 0건 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t3-versions.sh` | exit 0. 설치된 패키지 버전이 `pyproject.toml`의 `models` extra 고정 버전과 전부 일치 |
| V6 | `<repo root>` | `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts` | 출력 없음 |

**Review**

- [ ] `mlx-lm`이 같은 런타임 안에 설치됐다 (uv tool 분리가 아니다, R-9)
- [ ] `damwha_worker`가 설치된 것이지 `PYTHONPATH`로 개발 venv를 끌어온 것이 아니다 (`selfreport.py`의 `damwha_worker.__file__`이 번들 안)
- [ ] `models` extra의 버전이 `pyproject.toml`과 정확히 일치한다 — 하한만 맞춘 설치가 아니다 (`pyproject.toml`의 `==` 고정 사유 주석 참조)
- [ ] 재배치 **후** 경로에서 V2~V5가 수행됐다
- [ ] 콘솔 스크립트 shebang에 번들 밖 절대 경로가 없다
- [ ] `.metallib` 등 비 Mach-O 자산의 경로도 텍스트 검사에 걸렸다
- [ ] V3이 `damwha_worker.models.device`의 실제 함수를 부른다 — 별도로 다시 구현한 판정이 아니다
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

**Rollback**

- `$EXP/stage/python`·`$EXP/bundle/python` 삭제. 개발 venv(`be/worker/.venv`)는 건드리지 않으므로 영향 없음.

---

### Task 4: ffmpeg / ffprobe 번들

**Tier:** low
**Spec:** P0-C6
**Depends:** Task 1

**Files**

- Create: `$EXP/ffmpeg/README.md` — 후보와 라이선스 구성 기록
- Create: `$EXP/ffmpeg/fetch.sh` — 번들 대상 ffmpeg·ffprobe를 `$EXP/stage/ffmpeg`에 배치
- Create: `$EXP/verify/t4-probe.sh`, `t4-normalize.sh`, `t4-no-homebrew.sh`, `t4-license-recorded.sh`

**Interfaces**

- `be/worker/damwha_worker/pipeline/ffmpeg.py`가 실제로 쓰는 두 명령만 검증 대상이다 — `ffprobe -v error -show_entries format=duration -of json <파일>`과 normalize 변환(16 kHz mono).
- 입력 오디오는 Task 1이 복사한 `$SANDBOX/audio/sample.flac`이다.
- 선택한 빌드의 라이선스 구성(GPL / LGPL, 활성 인코더)을 `README.md`에 기록한다 (R-8).

**Steps**

- [ ] 후보(공개 정적 빌드 / 직접 빌드) 조사 후 선택, 근거를 `README.md`에.
- [ ] `$EXP/stage/ffmpeg` 구성 → `check-macho.sh` 통과 → `$EXP/bundle/ffmpeg`로 재배치.
- [ ] `ffmpeg -version`의 `configuration:` 줄에서 라이선스 관련 플래그(`--enable-gpl`, `--enable-nonfree`)를 확인해 기록.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/ffmpeg` | exit 0 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t4-probe.sh` | exit 0. 번들 `ffprobe`가 `format.duration`을 담은 JSON을 반환 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t4-normalize.sh` | exit 0. normalize 산출물이 생성되고 `sample_rate=16000`, `channels=1` |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t4-no-homebrew.sh` | exit 0. `t4-probe`·`t4-normalize`의 dyld 증거에 `/opt/homebrew`가 0건 — Homebrew ffmpeg 9.0.1이 실행되지 않았다 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t4-license-recorded.sh` | exit 0. `ffmpeg/README.md`에 빌드의 라이선스 구성(GPL / LGPL / nonfree 플래그)이 기록됨 |

**Review**

- [ ] 검증에 쓴 두 명령이 `pipeline/ffmpeg.py`의 실제 명령과 같은 형태다
- [ ] 라이선스 구성이 기록됐고 R-8에 대한 판단이 있다
- [ ] 입력이 Task 1이 복사한 `$SANDBOX/audio/sample.flac`이고 `be/storage` 원본이 그대로다
- [ ] 재배치 후 경로에서 검증했다
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

---

### Task 5: 임베딩 서비스와 `mlx_lm.server`

**Tier:** normal
**Spec:** P0-C5, P0-C5b
**Depends:** Task 3

**Files**

- Create: `$EXP/services/embed.sh` — 번들 런타임으로 embed 서비스를 58100에 기동/종료
- Create: `$EXP/services/llm.sh` — 번들 `mlx_lm.server`를 58000에 기동/종료
- Create: `$EXP/verify/t5-embed-health.sh`, `t5-embed-vector.sh`, `t5-embed-stop.sh`, `t5-llm-models.sh`, `t5-llm-completion.sh`, `t5-llm-stop.sh`, `t5-bundle-paths.sh`, `t5-dyld-measured.sh`

**Interfaces**

- embed 서비스는 `damwha_worker.embed_service`를 **58100**으로 띄운다 (개발 8100과 분리).
- `mlx_lm.server`는 **58000**에서 `mlx-community/Qwen3.5-4B-8bit`로 띄운다 (개발 8000과 분리).
- 둘 다 **서버 자신의 PID**를 `$SANDBOX/run/{embed,llm}.pid`에 쓰고 SIGTERM으로 내린다. 래퍼 bash의 PID가 아니다. 이름 기반 kill 금지.
- 두 `start` 모두 서버를 **백그라운드로 띄우고 준비(`/health`, `/v1/models`)를 기다린 뒤 exit 0** 한다. 서버 프로세스를 `exec`하기 직전에 `export DYLD_PRINT_LIBRARIES=1`을 다시 설정하고 stderr를 리다이렉트하지 않는다 (위 "런처 스크립트의 dyld 실측 규칙" 1~4).
- `llm.sh start`는 실행한 바이너리의 절대 경로를 `$EVIDENCE/t5-llm-binpath.txt`에 기록한다.
- 모델은 샌드박스 `HOME` 아래 캐시에 받는다 — 개발자 `~/.cache/huggingface`를 쓰지 않는다.

**Steps**

- [ ] `preflight.sh`로 디스크 여유 확인 (Qwen3.5-4B-8bit 약 5 GB + bge-m3).
- [ ] `embed.sh` 구현 → 기동 → `/health` → `/embed` → 종료 확인.
- [ ] `llm.sh` 구현 → 기동 → `/v1/models` 대기 → 짧은 `chat/completions` 1회 → SIGTERM → 종료 확인.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/preflight.sh 10` | exit 0 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t5-embed -- experiments/electron-phase-0/services/embed.sh start` | exit 0. 래퍼가 블로킹하지 않고 돌아온다 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-embed-health.sh` | exit 0. `GET /health`가 `{"status":"ok"}` |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-embed-vector.sh` | exit 0. `POST /embed`가 `model=BAAI/bge-m3`, `dimension=1024`, 벡터 1개, 길이 1024 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-embed-stop.sh` | exit 0. `embed.sh stop` 후 58100이 응답하지 않음 |
| V6 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t5-llm -- experiments/electron-phase-0/services/llm.sh start` | exit 0. 래퍼가 블로킹하지 않고 돌아온다 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-llm-models.sh` | exit 0. `GET /v1/models` 응답에 `Qwen3.5-4B-8bit` 포함 |
| V8 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-llm-completion.sh` | exit 0. `POST /v1/chat/completions`가 `choices` 1건을 반환 |
| V9 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-llm-stop.sh` | exit 0. SIGTERM 후 58000이 응답하지 않음 |
| V10 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-bundle-paths.sh` | exit 0. `t5-llm-binpath.txt`가 `bundle/python` 하위 경로이고 `/Users/gim-yeongjae/.local`이 아니며, dyld 증거에 개발자 HF 캐시가 0건 |
| V11 | `<repo root>` | `bash experiments/electron-phase-0/verify/t5-dyld-measured.sh` | exit 0. `t5-embed-dyld.txt`·`t5-llm-dyld.txt` 각각 dyld 줄 1건 이상이고 `dyld[<pid>]`가 해당 PID 파일의 PID와 일치하며 `MEASUREMENT_UNAVAILABLE`이 아니다 |

**Review**

- [ ] 포트가 58100 / 58000이다 (개발 기본값 8100 / 8000이 아니다)
- [ ] `mlx_lm.server`가 번들 안 실행 파일이다 (V10) — `~/.local/bin/mlx_lm.server`가 아니다
- [ ] 모델이 샌드박스 `HOME` 캐시에 받아졌다 (V10)
- [ ] 두 서비스 모두 PID 파일 대상으로만 종료하고 이름 기반 kill이 없다
- [ ] 두 런처가 서버 exec 직전에 `DYLD_PRINT_LIBRARIES`를 다시 export하고 stderr를 리다이렉트하지 않으며, PID 파일에 서버 자신의 PID를 쓴다 (V11이 그것을 증명)
- [ ] 스펙 P0-C5b의 "SIGTERM에 종료된다" 조건이 V9로 확인된다
- [ ] `embed_service`의 `dimension`이 1024이고 `be/worker/.env`의 `SEARCH_EMBEDDING_DIM`과 일치한다
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

**Rollback**

- `embed.sh stop`, `llm.sh stop`. 살아남은 프로세스는 `$SANDBOX/run/`의 PID 파일로 특정해 종료한다. 이름 기반 kill 금지.

---

### Task 6: 하이브리드 검색 쿼리

**Tier:** normal
**Spec:** P0-C2
**Depends:** Task 2, Task 5

**Files**

- Create: `$EXP/drivers/seed_search.py` — `meeting` / `utterance` / `utterance_embedding` 시드
- Create: `$EXP/drivers/query_search.sql` — `kw` / `sem` / `fused` CTE 쿼리
- Create: `$EXP/verify/t6-seed.sh`, `t6-hybrid.sh`, `t6-operators.sh`

**Interfaces**

- `be/src/search/search.repository.ts`의 하이브리드 쿼리 구조를 그대로 쓴다 — `kw`는 `u.text LIKE likequery($1)` + `bigm_similarity(u.text, $1)`, `sem`은 `e.embedding <=> $3::vector` with `e.model=$4 AND e.dimension=$5`, `fused`는 `FULL OUTER JOIN` + RRF.
- 시드 임베딩과 질의 벡터 모두 Task 5의 58100 embed 서비스가 만든다. 손으로 만든 난수·상수 벡터를 쓰지 않는다 — 그러면 `sem` 경로가 실제로 동작하는지 확인되지 않는다.
- `utterance_embedding`의 `model='BAAI/bge-m3'`, `dimension=1024`.
- 시드하는 `meeting`의 id를 `$EVIDENCE/t6-meeting-id.txt`에 남긴다. Task 7이 자기 회의와 구분하는 데 쓴다.
- `utterance`의 실제 컬럼은 `meeting_id`·`speaker_id`·`diar_label`·`start_ms`·`end_ms`·`text`·`status`·`order_index`·`processing_version`이다 (`001_init.sql`). `status` 체크 제약은 `ok`/`silence`/`transcribe_failed`이고 `UNIQUE (meeting_id, order_index)`가 있다.

**Steps**

- [ ] Task 2의 DB 기동, Task 5의 embed 서비스 기동.
- [ ] 한국어 발화 여러 건을 시드하고 각각의 임베딩을 embed 서비스로 만들어 넣는다.
- [ ] `kw` 단독 / `sem` 단독 / `fused` 세 쿼리를 실행한다.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t6-seed -- experiments/electron-phase-0/bundle/python/bin/python3 experiments/electron-phase-0/drivers/seed_search.py` | exit 0. 시드한 utterance 수와 embedding 수를 출력, `$EVIDENCE/t6-meeting-id.txt` 생성 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t6-seed.sh` | exit 0. `utterance_embedding`의 `model='BAAI/bge-m3'` `dimension=1024` 행 수가 시드한 utterance 수와 같고 0보다 큼 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t6-hybrid.sh` | exit 0. `kw` 단독 1건 이상 **그리고** `sem` 단독 1건 이상 **그리고** `fused` 1건 이상 |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t6-operators.sh` | exit 0. `bigm_similarity`와 `likequery`가 동작하고 `<=>` 거리 연산이 동작 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after` | exit 0 |

**Review**

- [ ] 쿼리가 `search.repository.ts`의 CTE 구조와 같다 — `kw`/`sem`/`fused`, `likequery`, `bigm_similarity`, `<=>`, RRF
- [ ] 시드 임베딩이 embed 서비스에서 나온 실제 벡터다 (난수·상수 벡터가 아니다)
- [ ] `e.model`/`e.dimension` 조건이 실제 쿼리처럼 걸려 있다
- [ ] 두 경로가 **각각** 결과를 냈다 — 한쪽이 0건인데 fused만 보고 통과시키지 않았다 (V3이 세 조건을 모두 요구)
- [ ] 시드가 실험 DB(55432)에만 들어갔다
- [ ] 시드가 `001_init.sql`의 실제 컬럼·제약과 맞는다 (`diar_label` 필수, `status` 체크, `UNIQUE (meeting_id, order_index)`)
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

---

### Task 7: 실제 음성 처리 파이프라인

**Tier:** critical
**Spec:** P0-C4
**Depends:** Task 2, Task 3, Task 4

**Files**

- Create: `$EXP/drivers/process_meeting_driver.py` — 시드 + `run_once` 호출 + 결과 출력
- Create: `$EXP/verify/t7-outcome.sh`, `t7-utterances.sh`, `t7-sandbox-models.sh`, `t7-no-dev-paths.sh`

**Interfaces**

- **`be/worker/scripts/smoke_process_meeting.py`를 실행하거나 수정하지 않는다.** 그 스크립트는 `PostgresContainer("damwha/postgres-bigm:pg16")`로 Docker를 띄우고, `testcontainers`는 `dev` 그룹이라 번들에 없다 (스펙 P0-C4). 페이로드 형태와 시드 절차만 **읽어서 참고**한다.
- 드라이버는 `DATABASE_URL`(55432)로 접속하고 `damwha_worker`의 `run_once` 경로를 그대로 호출한다.
- 오디오는 Task 1이 복사한 `$SANDBOX/audio/sample.flac`을 쓴다.
- 드라이버가 만든 `meeting` id를 `$EVIDENCE/t7-meeting-id.txt`에 남긴다. **모든 결과 검증은 이 id로 스코프한다** — Task 6이 같은 DB에 시드한 발화를 세지 않기 위해서다.
- 드라이버는 **번들 런타임 안에서** 실행되므로 격리 대상이다 (스펙 P0-C4의 확인 환경).
- `utterance`에 `speaker_cluster_id` 같은 컬럼은 **없다.** 화자 분리 결과는 `diar_label`에 들어간다 (`001_init.sql:72`).

**Steps**

- [ ] `preflight.sh`로 디스크 여유 확인 (pyannote 3종 + whisper 모델 다운로드분).
- [ ] 드라이버 구현 — 회의·job 시드, `run_once`, 결과 출력, meeting id 기록.
- [ ] 격리 실행. 게이트 모델은 샌드박스 `HOME`에 새로 받는다.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/preflight.sh 40` | exit 0. 디스크 여유 확인 후에만 진행 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t7-pipeline -- experiments/electron-phase-0/bundle/python/bin/python3 experiments/electron-phase-0/drivers/process_meeting_driver.py` | exit 0. stdout에 `outcome: committed`, `$EVIDENCE/t7-meeting-id.txt` 생성 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t7-outcome.sh` | exit 0. `t7-meeting-id.txt`의 회의가 `status='done'` |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t7-utterances.sh` | exit 0. **그 회의의** `status='ok'` 발화가 1건 이상이고 `text`가 비어 있지 않으며, `diar_label`의 서로 다른 값이 1개 이상 (diarization이 실제로 돌았다) |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t7-sandbox-models.sh` | exit 0. 샌드박스 HF 캐시에 pyannote 저장소가 존재 — 게이트 모델을 새로 받았다 |
| V6 | `<repo root>` | `bash experiments/electron-phase-0/verify/t7-no-dev-paths.sh` | exit 0. `t7-pipeline` dyld 증거에 개발자 `~/.cache`·`/opt/homebrew`·`.venv`가 0건이고, ffmpeg 실행 경로가 `bundle/ffmpeg` 하위 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after` | exit 0. `be/storage` 원본 무변화 |
| V8 | `<repo root>` | `git status --porcelain be/worker/scripts` | 출력 없음. smoke 스크립트를 고치지 않았다 |
| V9 | `<repo root>` | `grep -c 'testcontainers' experiments/electron-phase-0/drivers/process_meeting_driver.py` | `0`. 드라이버가 Docker를 쓰지 않는다 |
| V10 | `<repo root>` | `git status --porcelain be/src be/worker/damwha_worker fe/src packages/contracts` | 출력 없음 |

**Review**

- [ ] 드라이버가 `testcontainers`나 Docker를 쓰지 않는다 (V9)
- [ ] `smoke_process_meeting.py`를 실행하지도 수정하지도 않았다 (V8)
- [ ] 오디오가 `be/storage`에서 복사된 것이고 원본이 그대로다 (V7)
- [ ] 결과 검증이 **드라이버가 만든 meeting id로 스코프**된다 — Task 6의 시드 발화를 세지 않는다
- [ ] `diar_label`을 쓴다 — 존재하지 않는 `speaker_cluster_id` 컬럼을 참조하지 않는다
- [ ] 파이프라인 전 단계(normalize/probe → VAD → diarization → ECAPA → STT → align → persist)가 실제로 돌았음이 DB 결과로 확인된다
- [ ] 게이트 모델이 샌드박스 캐시에 새로 받아졌다 — 개발자 캐시 재사용이 아니다 (V5, V6)
- [ ] ffmpeg가 Task 4의 번들 바이너리를 썼다 (V6)
- [ ] 정확도는 판정 대상이 아님을 결과 기록에 명시했다 (스펙 P0-C4 비고)
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

**Rollback**

- 실패 시 `pg/run.sh stop`, 서비스 PID 정리, `sandbox.sh --fresh`. 개발 DB·`be/storage`·개발자 HF 캐시는 어느 경로로도 쓰이지 않으므로 되돌릴 것이 없다. V7이 그것을 증명한다.

---

### Task 8: 서명·hardened runtime·Gatekeeper 제약

**Tier:** normal
**Spec:** P0-C9
**Depends:** Task 2, Task 3, Task 4, Task 5

**Files**

- Create: `$EXP/signing/probe.sh` — ad-hoc 서명 + hardened runtime 적용, `sign` / `quarantine` 서브커맨드
- Create: `$EXP/signing/RESULTS.md` — 서명 실패 목록, 필요한 entitlement, Gatekeeper 동작
- Create: `$EXP/verify/t8-hardened.sh`, `t8-signed-runtime.sh`, `t8-results-complete.sh`

**Interfaces**

- **범위는 ad-hoc 서명(`codesign -s -`)까지다.** Apple Developer Program 미가입이므로 Developer ID·공증은 다루지 않는다 (스펙 §7.1 U-3).
- `--options runtime`으로 hardened runtime을 켜고, entitlement를 하나씩 붙여 가며 최소 집합을 실측한다 — `com.apple.security.cs.allow-jit`, `…allow-unsigned-executable-memory`, `…disable-library-validation`.
- 서명은 **`bundle/`의 사본**(`$EXP/signed/`)에 적용한다. 원본 `bundle/`을 덮어쓰지 않아야 Task 8 실패 시 앞 Task의 산출물이 살아남는다.
- 서명 도구 실행은 격리 대상 밖이다 (스펙 P0-C9 확인 환경). **서명 후 실행 재시도는 격리 러너로** 한다.
- `RESULTS.md`는 서명 실패 파일 목록(0건이어도 "0건"으로), entitlement 결론, Gatekeeper 동작, 공증 선결 조건 목록, R-12 미재현 사각을 모두 담는다.

**Steps**

- [ ] `bundle/` → `$EXP/signed/`로 복사.
- [ ] `signed/` 안 모든 Mach-O에 ad-hoc 서명 + `--options runtime` 적용. 실패 파일을 목록화.
- [ ] hardened runtime 상태로 Task 3의 import·MPS와 Task 5의 `mlx_lm.server`를 재실행. 깨지면 entitlement를 하나씩 추가해 최소 집합을 찾는다.
- [ ] `xattr -w com.apple.quarantine` 부여 후 실행해 Gatekeeper 동작 관찰.
- [ ] 공증 선결 조건을 목록으로만 정리 (제출하지 않는다). R-12를 명시.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/signing/probe.sh sign` | exit 0. 서명 결과와 실패 파일 목록이 `signing/RESULTS.md`에 기록 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t8-hardened.sh` | exit 0. `codesign -dv`가 `signed/` 대표 바이너리에 `runtime` 플래그를 보고 — hardened runtime이 실제로 켜졌다 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t8-signed-runtime.sh` | exit 0. 서명된 런타임에서 `torch`·`mlx_whisper`·`mlx_lm` import와 `mps_available()`가 성공하거나, 실패했다면 그 오류와 필요한 entitlement가 `RESULTS.md`에 기록돼 있음 |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/signing/probe.sh quarantine` | exit 0. Gatekeeper 동작(허용/차단/프롬프트)이 `RESULTS.md`에 기록 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t8-results-complete.sh` | exit 0. `RESULTS.md`에 서명 실패 목록·entitlement 결론·Gatekeeper 동작·공증 선결 조건·`R-12`가 모두 존재 |
| V6 | `<repo root>` | `grep -c 'notarytool' experiments/electron-phase-0/signing/probe.sh` | `0`. 실제 공증 제출을 시도하지 않았다 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle` | exit 0. 원본 `bundle/`이 서명 작업으로 훼손되지 않았다 |

**Review**

- [ ] 범위가 ad-hoc 서명까지다 — Developer ID 인증서를 요구하거나 공증을 제출하지 않는다
- [ ] 서명이 `bundle/` 사본(`signed/`)에 적용됐고 원본이 살아 있다 (V7)
- [ ] hardened runtime이 실제로 켜진 상태에서 실행을 재시도했다 (V2)
- [ ] MLX Metal 셰이더 런타임 컴파일(R-4)과 서명되지 않은 `.so` 로딩(R-5)이 각각 관찰됐다
- [ ] entitlement 결론이 "필요 없음"이든 "이 셋이 필요함"이든 근거 오류 메시지와 함께 기록됐다
- [ ] R-12가 미재현 사각으로 명시되고 Phase 6 인계 목록에 들어갔다
- [ ] 판정이 "성공/실패"가 아니라 "제약이 특정되었는가"로 이뤄졌다 (스펙 P0-C9 비고)
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

**Rollback**

- `$EXP/signed/` 삭제. 서명은 사본에만 적용하므로 `bundle/`과 저장소·개발 환경에 영향 없음.

---

### Task 9: 모델 라이선스·게이팅과 용량·초기 비용

**Tier:** normal
**Spec:** P0-C10, P0-C13
**Depends:** Task 1, Task 3

**Files**

- Create: `$EXP/models/survey.py` — HF 저장소 메타데이터로 파일 용량 산정
- Create: `$EXP/models/MODELS.md` — 라이선스·게이팅·재배포 가능 여부·용량 표
- Create: `$EXP/models/SIZING.md` — 번들 용량 내역과 프리셋별 초기 다운로드 비용
- Create: `$EXP/verify/t9-models-listed.sh`, `t9-measured-vs-estimated.sh`, `t9-disk-safe.sh`

**Interfaces**

- 대상: pyannote `speaker-diarization-3.1` / `segmentation-3.0` / `speaker-diarization-community-1` / `wespeaker-voxceleb-resnet34-LM`, `speechbrain/spkrec-ecapa-voxceleb`, `BAAI/bge-m3`, silero-vad, `whisper_mlx.py::_REPO`의 6종(`mlx-community/whisper-{tiny, base-mlx, small-mlx, medium-mlx, large-v3-turbo, large-v3-mlx}`), `mlx-community/Qwen3.5-{4B,9B,27B}-8bit`.
- **실측과 산정을 구분한다.** 데이터 볼륨 여유가 27 GiB뿐이므로 `Qwen3.5-27B-8bit`는 내려받지 않고 HF 파일 메타데이터로 **산정**한다. `light`·`standard`가 쓰는 모델은 실제로 받아 **실측**한다 (스펙 P0-C13, R-14).
- 프리셋 정의는 `be/src/settings/presets.ts`를 읽어 확인한다. Task 1의 U-5 조사 결과를 따른다.
- `MODELS.md`의 표 열: 저장소 / 라이선스 / 게이트 여부 / 토큰 필요 / **번들 동봉 재배포 허용** / 용량 / 실측·산정.

**Steps**

- [ ] `preflight.sh`로 디스크 여유 확인. 부족하면 시작하지 않고 실패로 보고한다.
- [ ] `survey.py`로 각 저장소의 파일 목록·크기를 조회해 산정값을 만든다.
- [ ] 각 모델의 라이선스·게이트 여부·토큰 필요 여부·번들 동봉 재배포 허용 여부를 조사해 `MODELS.md`에.
- [ ] 빈 샌드박스 캐시에서 `light`·`standard` 프리셋 모델을 받아 용량·시간 실측. 그 회차를 증거에 명시.
- [ ] `bundle/{pg,python,ffmpeg}`의 구성요소별 용량과 압축 후 크기를 `SIZING.md`에.
- [ ] R-6(게이트 모델 동봉 불가 시 사용자 토큰 필요)에 대한 결론을 명시.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/preflight.sh 25` | exit 0 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t9-survey -- experiments/electron-phase-0/bundle/python/bin/python3 experiments/electron-phase-0/models/survey.py` | exit 0. 대상 저장소 전량의 용량이 출력 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t9-models-listed.sh` | exit 0. `MODELS.md`에 대상 모델 전량(pyannote 4종, ECAPA, bge-m3, silero, whisper 6종, Qwen3.5 3종)이 있고 각 행에 라이선스·게이트·재배포 열이 채워짐 |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t9-measured-vs-estimated.sh` | exit 0. `SIZING.md`의 모든 행이 `실측` 또는 `산정`으로 표시되고, `Qwen3.5-27B-8bit`가 `산정`이며, 실측 합계가 샌드박스 HF 캐시 실제 크기와 일치 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t9-disk-safe.sh` | exit 0. 데이터 볼륨 여유가 5 GiB 이상 남았다 — 디스크를 채우지 않았다 |
| V6 | `<repo root>` | `grep -q 'R-6' experiments/electron-phase-0/models/MODELS.md` | exit 0. 사용자 HF 토큰 필요 결론이 존재 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after` | exit 0 |

**Review**

- [ ] `Qwen3.5-27B-8bit`를 실제로 내려받지 않았다 (R-14, V4·V5)
- [ ] 실측 행과 산정 행이 표에서 구분된다 — 산정값을 실측으로 적지 않았다
- [ ] 각 모델의 재배포 허용 여부가 라이선스 근거와 함께 있다
- [ ] "사용자에게 HF 토큰과 라이선스 수락을 요구해야 하는 모델"의 최소 목록이 확정됐다 (R-6)
- [ ] 실측이 **빈 샌드박스 캐시**에서 이뤄졌고 그 회차가 증거에 명시됐다 — 개발자 캐시 재사용이 아니다
- [ ] whisper 대상이 `whisper_mlx.py::_REPO`의 실제 6종이다 (추측 목록이 아니다)
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

**Rollback**

- 다운로드 산출물은 `$SANDBOX` 안에만 있다. `sandbox.sh --fresh`로 회수. 디스크 부족 시 이 Task만 중단해도 앞 Task의 증거는 유지된다.

---

### Task 10: 기술 결정 — 최소 macOS 버전과 실행 환경 제공 방식

**Tier:** normal
**Spec:** P0-C11, P0-C12
**Depends:** Task 2, 3, 4, 5, 8, 9

**Files**

- Create: `$EXP/decisions/DECISIONS.md` — 네 가지 제공 방식 결정과 최소 macOS 버전
- Create: `$EXP/decisions/minos.sh` — 번들 전체의 `LC_BUILD_VERSION` `minos` 수집
- Create: `$EXP/verify/t10-decisions-complete.sh`, `t10-minos.sh`

**Interfaces**

- P0-C11: 번들 구성요소의 `otool -l` `LC_BUILD_VERSION`의 `minos`를 수집하고, MLX·PyTorch·Electron의 공식 최소 요구 버전과 교차해 **최댓값**을 취한다. 기준 호스트가 macOS 27.0뿐이므로 **실측이 아니라 선언값 기반**임을 명시한다 (R-10).
- P0-C12: (1) PostgreSQL 제공 방식, (2) Python 런타임 제공 방식, (3) ffmpeg 제공 방식, (4) 모델 제공 방식 — 네 가지를 각각 결정하고 근거·탈락안·남은 제약을 남긴다. 실패한 항목은 대안 검증 결과를 함께 적는다.

**Steps**

- [ ] `minos.sh`로 `bundle/` 전체의 `minos` 수집, 최댓값과 그 값을 강제하는 구성요소를 특정.
- [ ] Task 2·3·4·5·8·9의 결과를 근거로 네 가지 제공 방식을 결정.
- [ ] 각 결정에 근거·탈락안·남은 제약을 적는다. Phase 3·4가 그대로 착수할 수 있는 수준까지 구체화(후보 이름과 버전까지).
- [ ] 실패한 항목이 있으면 대안 검증 결과와 Phase 범위 조정 제안을 적는다.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/decisions/minos.sh` | exit 0. 구성요소별 `minos` 목록과 최댓값 출력 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t10-minos.sh` | exit 0. `DECISIONS.md`에 최소 macOS 버전 결정값, 그 값을 강제하는 구성요소, "선언값 기반이며 실측 아님"(R-10) 단서가 모두 존재 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/verify/t10-decisions-complete.sh` | exit 0. 네 결정(PostgreSQL / Python 런타임 / ffmpeg / 모델 제공 방식)이 모두 있고 각각 근거·탈락안·남은 제약을 가짐 |

**Review**

- [ ] 네 가지 결정이 모두 있고 각각 근거·탈락안·남은 제약을 갖는다
- [ ] 최소 macOS 버전이 선언값 기반임이 명시됐다 (R-10) — 실측으로 오인되지 않는다
- [ ] 실패한 항목이 있다면 대안 검증 결과가 함께 있다 (로드맵 Phase 0 완료 기준)
- [ ] 결정이 Phase 3·4가 착수할 수 있을 만큼 구체적이다 (후보 이름과 버전까지)
- [ ] 모델 제공 방식 결정이 Task 9의 재배포 가능 여부와 모순되지 않는다
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

---

### Task 11: Phase 통합 검증과 결과 반영

**Tier:** critical
**Spec:** P0-C7, P0-C8, P0-C14 (+ 전 기준 집계)
**Depends:** Task 1 ~ 10

로드맵 §5의 "모든 단계 완료 후 Phase 전체 완료 기준과 통합 동작을 검증하고 최종 리뷰한다"에 해당한다. reviewer는 Tier와 무관하게 `critical`로 처리한다.

**Files**

- Create: `$EXP/lib/aggregate-isolation.sh` — 전 Task의 증거를 훑어 금지 문자열·`MEASUREMENT_UNAVAILABLE` 집계
- Create: `$EXP/lib/selfreport-all.sh` — Python·PostgreSQL·ffmpeg의 런타임 자기 보고 통합 덤프 (P0-C8). 각 번들 Mach-O를 부르기 직전에 `export DYLD_PRINT_LIBRARIES=1`을 다시 설정하고 stderr를 리다이렉트하지 않는다 (위 "런처 스크립트의 dyld 실측 규칙")
- Create: `$EXP/verify/t11-isolation.sh`, `t11-selfreport.sh`, `t11-criteria-recorded.sh`, `t11-roadmap-updated.sh`, `t11-evidence-committed.sh`, `t11-dev-untouched.sh`
- Modify: `docs/superpowers/reports/2026-09-09-electron-phase-0-packaging-validation-results.md` — 최종 검증·남은 제약·기술 결정 채우기
- Modify: `docs/electron-migration-roadmap.md` — Phase 0 상태와 후속 Phase에 영향을 주는 전제 갱신

**Interfaces**

- P0-C7: `bundle/` 전체에 `check-macho.sh`를 다시 돌리고, `$EVIDENCE`의 모든 `*-dyld.txt`에서 금지 문자열을 검색한다. `MEASUREMENT_UNAVAILABLE`로 표시된 실행은 별도 집계하고 P0-C8의 자기 보고로 대체 확인한다.
- **집계기는 dyld 줄이 0건인 것과 측정 자체가 불가능했던 것을 구분한다.** 번들 Mach-O를 실행한 항목인데 dyld 줄이 0건이면 그것은 "위반 없음"이 아니라 **런처가 re-export를 빠뜨린 미측정**이다. 위 "런처 스크립트의 dyld 실측 규칙"을 어긴 것이므로 통과로 집계하지 않는다.
- 집계기의 금지 문자열 면제는 `$SANDBOX` 하위와 **실제로 검사한** `bundle/` 하위로 좁힌다. `bundle/` 전체를 한 번에 `$ROOT`로 잡으면 형제 번들 참조가 INFO로 흡수되므로, 형제 참조 허용 여부는 Task 3이 번들별 검사(`bundle/pg`, `bundle/python`)에서 판정한 결과를 기준으로 한다.
- P0-C8: Python(`sys.prefix`/`sys.path`/`sysconfig`/모듈 `__file__`), PostgreSQL(`pg_config --bindir --libdir --sharedir --pkglibdir`, `SHOW data_directory`, `SHOW dynamic_library_path`), ffmpeg/ffprobe(실행 경로)를 한 번에 덤프해 번들 밖 경로가 0건인지 확인한다.
- 결과 문서의 "최종 검증" 표는 **15개 완료 기준 전부**(P0-C1 ~ C14 + C5b)에 대해 확인 방법·증거 경로·충족 여부를 갖는다. 실행하지 않은 검증을 성공으로 적지 않는다.
- 로드맵 갱신은 Phase 0 절의 상태 문구와 결과 문서 링크를 포함한다. 검증이 뒤집은 전제가 있으면 해당 Phase 설명도 고친다.

**Steps**

- [ ] Task 2·5의 서비스를 기동한 상태에서 `selfreport-all.sh` 실행.
- [ ] `aggregate-isolation.sh`로 전 증거 집계.
- [ ] 결과 문서의 "최종 검증" 표를 15행으로 채운다.
- [ ] "남은 제약·후속 Phase 인계"에 스펙 §11의 4개 항목과 실제로 드러난 제약을 적는다.
- [ ] "기술 결정과 변경 이유"에 Task 10의 결정 4건과 최소 macOS 버전을 옮긴다.
- [ ] "후속 작업(비차단 지적)"을 채운다.
- [ ] `docs/electron-migration-roadmap.md`의 Phase 0 상태를 갱신하고 결과 문서를 링크한다.
- [ ] 실험 프로세스를 전부 정리하고 개발 자산 무변화를 최종 확인.
- [ ] `verify/` 스크립트 구현.

**Verify**

| # | cwd | 명령 | 기대 |
| --- | --- | --- | --- |
| V1 | `<repo root>` | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle` | exit 0. 번들 전체 정적 검사 위반 0건 |
| V2 | `<repo root>` | `bash experiments/electron-phase-0/verify/t11-isolation.sh` | exit 0. 전 Task 증거의 금지 문자열 0건. `MEASUREMENT_UNAVAILABLE` 항목이 있으면 각각 P0-C8 대체 확인에 대응됨 |
| V3 | `<repo root>` | `bash experiments/electron-phase-0/lib/run-isolated.sh --label t11-selfreport -- experiments/electron-phase-0/lib/selfreport-all.sh` | exit 0. Python·PostgreSQL·ffmpeg 자기 보고가 덤프됨 |
| V4 | `<repo root>` | `bash experiments/electron-phase-0/verify/t11-selfreport.sh` | exit 0. 덤프된 모든 경로가 `bundle/` 또는 `sandbox/` 하위이고, `/Library/Frameworks/Python.framework`·`/opt/homebrew`·`/usr/local/bin`·`/usr/local/lib`·`.venv`·개발자 `~/.cache`·`~/.local`이 0건 |
| V5 | `<repo root>` | `bash experiments/electron-phase-0/verify/t11-criteria-recorded.sh` | exit 0. 결과 문서에 15개 식별자(P0-C1~C14, C5b)가 모두 있고 각 행에 확인 방법·증거 경로·충족 여부가 채워짐 |
| V6 | `<repo root>` | `bash experiments/electron-phase-0/verify/t11-roadmap-updated.sh` | exit 0. 로드맵의 Phase 0 상태가 갱신되고 결과 문서가 링크됨 |
| V7 | `<repo root>` | `bash experiments/electron-phase-0/verify/t11-evidence-committed.sh` | exit 0. `$EVIDENCE`에 `.log` 파일이 없고, 추적되지 않은 증거 파일이 없음 |
| V8 | `<repo root>` | `bash experiments/electron-phase-0/verify/t11-dev-untouched.sh` | exit 0. `damwha_pgdata` 볼륨 존재, `be/storage` 무변화, 실험 PID 파일에 살아 있는 프로세스 없음 |
| V9 | `<repo root>` | `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts` | 출력 없음. Phase 전체에서 제품 코드 무변경 |
| V10 | `<repo root>` | `pnpm build` | exit 0. 저장소가 여전히 정상 빌드된다 |
| V11 | `<repo root>` | `pnpm lint` | exit 0. `experiments/` 추가가 워크스페이스 도구 설정을 깨지 않았다 |

**Review**

- [ ] 15개 완료 기준 전부가 결과 문서 "최종 검증" 표에 있고, 각 행이 확인 방법·증거 경로·충족 여부를 갖는다
- [ ] **실행하지 않은 검증이 성공으로 적히지 않았다.** 미충족·측정불가·산정 항목이 그대로 표시된다
- [ ] `MEASUREMENT_UNAVAILABLE`로 남은 dyld 항목이 각각 P0-C8의 자기 보고로 대체 확인됐거나, 안 됐다면 미충족으로 남았다
- [ ] 번들 Mach-O를 실행했는데 dyld 줄이 0건인 항목을 통과로 집계하지 않았다 — 그것은 미측정이지 위반 없음이 아니다
- [ ] "남은 제약·후속 Phase 인계"에 스펙 §11의 4개 항목(다른 맥 독립 설치, 공증, R-12, macOS 최소 버전 실측)이 있다
- [ ] 로드맵의 Phase 0 상태가 갱신됐고, 검증이 뒤집은 전제가 있으면 해당 Phase 설명도 고쳐졌다
- [ ] 제품 코드가 Phase 전체에서 한 줄도 바뀌지 않았다 (V9)
- [ ] 개발 DB 볼륨·`be/storage`가 무변화이고 실험 프로세스가 남아 있지 않다 (V8)
- [ ] 증거가 `.log`가 아니라 `.md`/`.txt`로 저장돼 실제로 커밋됐다 (V7)
- [ ] Task별 커밋 범위가 결과 문서 "단계별 실행·리뷰" 표에 연결돼 있다
- [ ] `verify/` 스크립트가 무조건 exit 0이 아니다

전체 테스트 스위트(`pnpm test`)는 Verify에 넣지 않는다. `be`의 테스트는 testcontainers로 Docker Postgres를 띄우므로, Phase 0이 제거하려는 의존을 검증 단계가 다시 요구하게 된다. 제품 코드가 한 줄도 바뀌지 않았음은 V9가 증명하므로 전량 회귀는 추가 증거를 주지 않는다. `pnpm build`(V10)와 `pnpm lint`(V11)는 Docker 없이 돌고, `experiments/` 추가가 워크스페이스 도구 설정을 깼는지를 실제로 잡는다.

**Rollback**

- 문서 변경만 있으므로 `git revert`로 원복된다.
- 실험 프로세스가 남았다면 `$SANDBOX/run/`의 PID 파일로 특정해 종료한다. 이름 기반 kill 금지.
