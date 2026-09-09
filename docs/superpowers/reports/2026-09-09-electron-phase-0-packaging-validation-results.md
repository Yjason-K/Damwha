# Electron Phase 0 — 패키징 기술 검증 실행 결과

작성 시작: 2026-09-09
브랜치: `feat/electron-migration-phase-0-packaging-validation`
worktree: `/Users/gim-yeongjae/project/daewha-electron-phase-0`
브랜치 분기점: `494d44c` (`dev`)
BASE 커밋: 스펙·계획 확정 커밋 `docs: Electron Phase 0 패키징 검증 스펙과 계획을 확정한다`. Task 리뷰 범위의 시작점이며, 실제 해시는 아래 "단계별 실행·리뷰" 표의 Task 1 커밋 범위가 가리킨다.
스펙: [2026-09-09-electron-phase-0-packaging-validation-design.md](../specs/2026-09-09-electron-phase-0-packaging-validation-design.md)
계획: [2026-09-09-electron-phase-0-packaging-validation.md](../plans/2026-09-09-electron-phase-0-packaging-validation.md)

## 스펙 리뷰

| 회차 | 대상 버전 | 검토자 | 지적 | 조치 | 통과 |
| --- | --- | --- | --- | --- | --- |
| 1 | 초안 (358줄, 미커밋) | 메인 세션 | 사용자 확인 항목 3건(U-1 오디오 출처, U-2 계정 분리, U-3 Developer Program) | U-1 복사로 확정. U-2는 근거 조사 후 미채택하고 §4.3 신설 + P0-C8 재정의. U-3는 미가입 확정, P0-C9 범위를 ad-hoc 서명까지로 축소하고 R-12·§11 인계 추가 | 통과 |
| 2 | 409줄 | 메인 세션 | 아래 F-1 ~ F-11 (차단 5, 비차단 6) | 전건 반영, 454줄 | 통과 |
| 3 | 454줄 (재검토) | 메인 세션 | §4.0 신설로 P0-C1·C2·C4의 "확인 환경" 표기가 어긋남. U-6 포트가 실측으로 해소됨 | 확인 환경 3건 정정, U-6를 해결 항목으로 이동 | 통과 |

### 2회차 지적 상세

차단 지적은 로드맵 §2의 "범위·계약·데이터 안전성·완료 기준에 영향을 주는 지적" 기준으로 분류했다.

| ID | 구분 | 지적 | 근거 | 조치 |
| --- | --- | --- | --- | --- |
| F-1 | **차단** | 마이그레이션을 `.sql` 직접 실행으로 적기했다. `be/CLAUDE.md`는 `src/database/migrate.ts` + `_migrations` 테이블을 단일 진실 원천으로 못 박았고, 손으로 실행하면 `_migrations`에 기록이 남지 않아 그 계약이 깨진다. 동시에 `pnpm be:migrate`는 `ts-node`라 G2의 `PATH`에서 실행 불가 | `be/package.json:14` `"migrate": "ts-node src/database/migrate.ts"`, `be/src/database/migrate.ts` | §4.0 "격리하는 것과 하지 않는 것" 신설. 격리 대상은 서버 프로세스이고 접속 클라이언트는 아님을 명시. 마이그레이션은 `pnpm be:migrate`로 적용하고 `DATABASE_URL`만 실험 DB로 돌린다 |
| F-2 | **차단** | P0-C4가 `scripts/smoke_process_meeting.py`를 쓴다고 적었으나 그 스크립트는 `PostgresContainer("damwha/postgres-bigm:pg16")`로 **Docker를 띄운다**. Phase 0이 제거하려는 의존 그 자체이고, `testcontainers`는 `dev` 그룹이라 번들에 없다 | `be/worker/scripts/smoke_process_meeting.py:22,87` | `experiments/electron-phase-0/`에 자체 드라이버를 두기로 변경. smoke 스크립트는 읽기 참조 전용, 실행·수정 금지 |
| F-3 | **차단** | `env -i`가 워커 기동 필수값까지 지운다. `Settings.database_url`·`lens_llm_base_url`은 기본값이 없어 `ValidationError`로 죽고, `HF_TOKEN`이 없으면 게이트 모델을 못 받는다. 스펙에는 주입 규칙이 "번들 안을 가리키는 값만"뿐이라 자격 증명을 다룰 수 없었다 | `be/worker/damwha_worker/config.py:12,38` | §4.2에 주입 허용 변수 표 추가(11개). `HF_TOKEN`은 값이 아니라 `set`/`unset`만 증거에 남기도록 규정 |
| F-4 | **차단** | P0-C13이 "프리셋별 초기 다운로드 용량 실측"을 요구하는데, `quality` 프리셋의 `Qwen3.5-27B-8bit` 하나가 수십 GB다. 기준 호스트 데이터 볼륨 여유는 **27 GiB(94% 사용)** 로 불가능하고, 밀어붙이면 개발 환경까지 죽는다 | `df -h /System/Volumes/Data` | P0-C13을 `실측`/`산정` 구분으로 변경. 27B는 HF 파일 메타데이터로 산정. §4.4에 디스크 여유 사전 점검 규칙, R-14 추가 |
| F-5 | **차단** | 증거 파일이 조용히 커밋에서 빠진다. 루트 `.gitignore:37`의 `*.log`가 경로 무관하게 걸리고, dyld 로드 로그는 자연히 `.log`로 저장된다 | `git check-ignore -v docs/superpowers/reports/evidence/phase-0/probe.log` → `.gitignore:37:*.log`. 같은 경로의 `.txt`는 추적됨 | §6에 증거 확장자를 `.md`/`.txt`로 강제하는 행 추가 |
| F-6 | 비차단 | P0-C3·C4가 `damwha_worker`를 import하는데 번들 반입 방식이 없어 §3.2 "제품 코드를 고치지 않는다"와 충돌해 보였다 | — | 런타임에 **설치**하는 것이며 소스 수정이 아님을 명시. 개발 venv를 `PYTHONPATH`로 끌어오는 방식은 금지 |
| F-7 | 비차단 | embed 서비스와 `mlx_lm.server` 포트가 "충돌 없는 포트"로만 적혀 있어 55432를 고정한 결정과 어긋났다 | — | 58100(embed), 58000(`mlx_lm.server`)으로 고정 |
| F-8 | 비차단 | 로드맵 §2가 요구하는 "시작 실패·중단·재시작" 조건이 실험 자체에는 적용되지 않았다 | 로드맵 §2 | §4.4에 중단·재실행 규칙 추가 — PID 파일 기반 정리, `initdb` 멱등, `--fresh`는 샌드박스만, 다운로드 이어받기, Task 종료 시 개발 자산 무변화 확인 |
| F-9 | 비차단 | P0-C2의 시드 대상이 추상적이었다 | `be/src/search/search.repository.ts:50-75`, `be/src/database/migrations/002_search.sql:5` | 실제 테이블·조건으로 구체화 — `utterance` / `utterance_embedding`(`model='BAAI/bge-m3'`, `dimension=1024`), `kw`/`sem`/`fused` CTE 구조 |
| F-10 | 비차단 | P0-C10의 whisper 저장소 목록이 추측이었다 | `be/worker/damwha_worker/models/whisper_mlx.py:19-26` | `_REPO`의 실제 6종으로 교체 |
| F-11 | 비차단 | P0-C1이 정상 종료만 확인했다. Phase 3 완료 기준("앱 재시작 후 데이터 유지")과 Phase 5("강제 종료")의 전제가 재배치된 데이터 디렉터리의 crash recovery인데 검증되지 않았다 | 로드맵 Phase 3·5 완료 기준 | P0-C1에 `SIGKILL` 후 재기동 복구 확인 추가. `_migrations` 행 수 대조도 성공 판정에 포함 |

### 리뷰 통과 판정

로드맵 §2 항목별 확인 결과.

| 검토 항목 | 결과 |
| --- | --- |
| Phase 목표·범위가 로드맵에 부합하는가 | 부합. §10이 로드맵 Phase 0 완료 기준 3개를 식별자에 대응시킨다 |
| 기존 코드·계약과 충돌하지 않는가 | 초안에 충돌 2건(F-1 `_migrations` 계약, F-2 Docker 의존)이 있었고 해소했다 |
| 시작 실패·중단·재시작·데이터 보존 조건을 검토했는가 | F-8·F-11로 보강. §4.4가 데이터 보존과 중단·재실행을, P0-C1이 crash recovery를 담당한다 |
| 완료 기준이 관찰·검증 가능한가 | 15개 기준 모두 확인 환경·방법·성공 판정을 가진다. P0-C9·C12는 "성공/실패"가 아니라 "제약·결정이 특정되었는가"로 판정함을 명시했다 |
| 요구사항 간 모순·누락이 없는가 | 3회차에서 §4.0 신설로 생긴 표기 불일치 3건을 정정했다 |
| 범위·계약·데이터 안전성·완료 기준에 영향을 주는 지적이 남아 있는가 | 없음 |

**사용자 승인:** 대기 중. 승인 전에는 구현 계획을 작성하지 않는다 (로드맵 §2).

## 계획 검증

| 회차 | 대상 버전 | 검토자 | 지적 | 조치 | 통과 |
| --- | --- | --- | --- | --- | --- |
| 1 | 초안 (667줄) | 메인 세션 | 아래 P-1 ~ P-8 (차단 3, 비차단 5) | 전건 반영해 재작성 (716줄) | 통과 |
| 2 | 716줄 (형식·커버리지 자동 검사) | 메인 세션 | Task 4 V5에 파이프 잔존. Task 11 V11의 `pnpm test`가 Docker를 요구 | 두 건 수정 (717줄) | 통과 |

### 1회차 지적 상세

| ID | 구분 | 지적 | 근거 | 조치 |
| --- | --- | --- | --- | --- |
| P-1 | **차단** | Verify 표의 여러 셀에 파이프(`\|`)와 `\|\|`가 들어 있었다. 마크다운 표에서 이스케이프가 필요한데, verifier가 이스케이프된 문자열을 그대로 실행하면 명령이 깨진다. `plan-task-format.md`는 "Verify의 명령은 verifier가 그대로 실행한다"고 못 박는다 | `plan-task-format.md` | "Verify 명령 작성 규칙" 절 신설. 합성 검사는 `$EXP/verify/t<N>-<이름>.sh` 스크립트로 옮기고 표는 스크립트 하나만 호출. 전 Task에 `verify/` 파일 추가. 자동 검사로 87개 Verify 행 전수 확인 |
| P-2 | **차단** | Task 7 V5가 `utterance.speaker_cluster_id`를 조회했다. **그런 컬럼이 없다.** 화자 분리 결과는 `diar_label`이다 | `be/src/database/migrations/001_init.sql:67-84` | `diar_label`로 정정. Task 6·7의 Interfaces에 실제 컬럼·제약(`UNIQUE (meeting_id, order_index)`, `status` 체크)을 명시 |
| P-3 | **차단** | Task 4가 `sandbox/audio/sample.flac`을 입력으로 쓰는데 그 복사가 Task 7의 Steps에 있었다. Task 4는 Task 7보다 먼저 실행되므로 파일이 없다 | 계획 내 의존 순서 | 오디오 복사를 Task 1의 `sandbox.sh copy-audio`로 옮기고 U-1을 Task 1 Spec에 추가. Task 4·7이 같은 파일을 공유 |
| P-4 | 비차단 | Task 7의 발화 수 검증이 Task 6이 같은 DB에 시드한 발화까지 셌다 | 계획 내 Task 간 간섭 | 드라이버가 만든 `meeting` id를 증거에 남기고 모든 결과 검증을 그 id로 스코프. Task 6도 자기 meeting id를 기록 |
| P-5 | 비차단 | Task 11의 로드맵 갱신 확인이 `grep -c 'Phase 0'` 증가였다 — 갱신해도 개수가 안 늘 수 있어 불안정 | — | 결과 문서 링크 존재를 확인하는 `t11-roadmap-updated.sh`로 교체 |
| P-6 | 비차단 | Task 11 V13의 `pnpm -r exec node -e "0"`이 아무것도 검증하지 않는 군더더기였다 | — | 제거 |
| P-7 | 비차단 | Task 5 V8이 읽는 `t5-llm-binpath.txt`를 누가 쓰는지 Interfaces에 없었다 | — | `llm.sh start`가 기록하도록 Interfaces에 명시 |
| P-8 | 비차단 | 검증 스크립트를 구현자가 직접 쓰므로 "무조건 exit 0"인 스크립트로 검증을 우회할 수 있다 | — | "Verify 명령 작성 규칙"에 리뷰어가 스크립트 내용을 diff에서 확인한다고 명시하고, 전 Task Review에 해당 항목 추가 |

### 2회차 지적 상세

| ID | 구분 | 지적 | 조치 |
| --- | --- | --- | --- |
| P-9 | **차단** | 자동 검사에서 Task 4 V5에 파이프가 남아 있었다 (`grep -qE 'enable-gpl\|LGPL\|enable-nonfree'`) | `t4-license-recorded.sh`로 교체 |
| P-10 | 비차단 | Task 11 V11의 `pnpm test`는 `be` 테스트가 testcontainers로 Docker Postgres를 띄운다 — Phase 0이 제거하려는 의존을 검증 단계가 다시 요구하고, 기존 실패에 걸려 가짜 차단이 될 수 있다 | `pnpm lint`로 교체. 제품 코드 무변경은 V9가 이미 증명하므로 전량 회귀는 추가 증거가 없다. 그 판단 근거를 Task 11에 적어 남김 |

### 계획 검증 통과 판정

로드맵 §4 항목별 확인 결과.

| 검토 항목 | 결과 |
| --- | --- |
| 모든 스펙 완료 기준이 구현 단계와 검증 절차에 연결됐는가 | 15개(P0-C1~C14 + C5b) 전부가 Task의 `**Spec:**` 헤더에 있다. 자동 검사로 확인 |
| 단계 순서·의존성이 맞는가 | P-3(Task 4의 입력을 Task 7이 만들던 문제)를 해소. `**Depends:**`가 전 Task에 있다 |
| 파일 경로·명령·도구가 실제 저장소와 맞는가 | P-2(없는 컬럼), P-1(실행 불가 명령), P-10(Docker 요구)을 해소. 마이그레이션 24개, `presets.ts`, `whisper_mlx.py::_REPO` 6종, `search.repository.ts` CTE 구조를 실제 파일로 대조 |
| 각 단계가 개별 리뷰 가능한가 | Task 11개 전부가 `Files`/`Interfaces`/`Steps`/`Verify`/`Review`를 갖는다. 자동 검사로 확인 |
| 데이터 변경·프로세스 종료·실패 복구가 빠지지 않았는가 | 데이터 안전 Verify(`snapshot-dev-assets.sh`)가 Task 1·2·6·7·9·11에, PID 기반 종료 규칙이 Task 2·5·7·11에, `Rollback`이 위험 Task 8개에 있다 |
| 계획에 스펙 밖의 작업이 들어갔는가 | 없음. 제품 코드 무변경이 Task 1·2·3·7·11의 Verify로 강제된다 |
| `plan-task-format.md` 형식을 갖췄는가 | 자동 검사 통과. `superpowers:executing-plans` 안내 줄 0건 |

**확정.** 계획 실행 단계로 넘어갈 수 있다.

### 3회차 — 실행 중 발견된 계획 결함 (2026-09-09)

Task 1 재리뷰가 찾아냈고 메인 세션이 측정으로 확인했다. 계획을 수정했다(717줄 → 751줄).

| ID | 구분 | 지적 | 근거 | 조치 |
| --- | --- | --- | --- | --- |
| P-11 | **차단** | SIP가 플랫폼 바이너리(`/bin/bash`, `/bin/sh`)를 exec할 때마다 환경에서 `DYLD_*`를 지운다. 계획의 Task 2 V2, Task 5 V2·V6, Task 11 V3은 전부 bash 런처를 거치므로 dyld 실측이 **0건**이 되고, 래퍼는 이를 SIP 탓(`MEASUREMENT_UNAVAILABLE`)으로 적어 원인을 잘못 귀속한다. 환경 격리(PATH·HOME) 자체는 멀쩡해서 겉으로는 통과처럼 보인다 | 메인 세션 측정 — `env -i DYLD_PRINT_LIBRARIES=1 <번들 Mach-O>` 81줄 / 같은 것을 bash 런처로 감싸면 0줄 / 런처가 exec 직전 re-export하면 81줄 | "런처 스크립트의 dyld 실측 규칙" 절 신설. 런처가 번들 Mach-O를 exec하기 직전에 `export DYLD_PRINT_LIBRARIES=1`을 다시 설정하도록 규칙화하고, Task 1의 `t1-detector-negative.sh`에 대조군 한 쌍(re-export 없음 → 0건 / 있음 → 1건 이상)을 넣어 코드로 고정. Task 2·5에 `t2-dyld-measured.sh`·`t5-dyld-measured.sh` 신설(V2b·V11) |
| P-12 | **차단** | 런처가 비플랫폼 바이너리인데 자식 stderr를 리다이렉트하면(`pg_ctl start -l`) **런처 자신의 로드 목록**이 남는다. dyld 줄 수가 0이 아니므로 래퍼는 통과로 보는데 서버의 라이브러리는 하나도 없다 — 위반 0건짜리 가짜 증거 | Task 1 재리뷰 실측 (C 재현), 메인 세션 재확인 | 규칙 2로 stderr 리다이렉트를 금지하고 `pg_ctl start -l`을 명시적으로 배제. V2b·V11이 `dyld[<pid>]`와 PID 파일의 PID 일치를 요구하도록 해 런처 자신의 로드 목록으로는 통과하지 못하게 함 |
| P-13 | **차단** | `run-isolated.sh`는 자식 종료까지 블로킹하고 증거도 그 뒤에 쓴다. Task 2 V2와 Task 5 V2·V6은 서버가 계속 떠 있기를 기대하면서 `exit 0`과 PID 파일 생성을 요구하므로, 서버를 래퍼 아래 포그라운드로 두면 그 행이 영영 돌아오지 않는다 | Task 1 재리뷰, `run-isolated.sh:133,175-178` | 규칙 3·4 신설 — 서버 런처의 `start`는 백그라운드 기동 후 준비 대기(`pg_isready`·`/health`·`/v1/models`)를 런처 안에서 끝내고 exit 0 한다. 준비가 끝난 시점이면 초기 로드 dyld 줄은 이미 전부 나와 캡처에 담긴다. PID 파일에는 래퍼 bash가 아니라 **서버 자신의 PID**를 쓴다 |
| P-14 | 비차단 | Task 11 집계기가 "dyld 0건"과 "측정 불가"를 구분하지 않으면, 런처가 re-export를 빠뜨린 미측정이 위반 없음으로 집계된다. 또 `bundle/` 전체를 한 번에 `$ROOT`로 잡으면 형제 번들 참조가 INFO로 흡수돼 Task 3의 번들별 판정과 결과가 달라진다 | Task 1 재리뷰 | Task 11 Interfaces에 두 규칙을 추가하고 Review 체크리스트에 항목 신설 |
| P-15 | 비차단 | 계획의 "스펙 §4.2 표의 11개 변수"가 오산이다. 표의 행은 10개지만 이름은 `HF_TOKEN`까지 12개다 (`MODEL_CACHE_DIR, HF_HOME` 행과 `EMBED_SERVICE_HOST/PORT` 행이 각각 이름 둘) | 스펙 §4.2 표 | 계획 2곳을 12로 정정하고 행/이름 수 차이를 본문에 명시 |

**사용자 결정 (2026-09-09):** P-11의 해법으로 "런처 re-export + 회귀 대조군" 채택. exec 심 방식은 심이 다시 bash를 exec하는 순간 `DYLD_*`가 또 지워지므로 성립하지 않는다.

## 단계별 실행·리뷰

| Task | 커밋 범위 | 검토자 (model) | 회차 | 차단 지적 → 조치 | 증거 | 통과 |
| --- | --- | --- | --- | --- | --- | --- |

## 최종 검증

| 완료 기준 | 확인 방법 | 증거 | 충족 |
| --- | --- | --- | --- |

## 후속 작업 (비차단 지적)

-

## 남은 제약·후속 Phase 인계

- 스펙 §11 "Phase 6로 넘기는 검증" 참조. 최종 검증 후 실제 결과를 반영해 갱신한다.

## 기술 결정과 변경 이유

- 2026-09-09: 검증 환경에서 **별도 macOS 사용자 계정을 쓰지 않기로** 결정. 새 계정은 `/opt/homebrew`·`/Library/Frameworks/Python.framework`(3.9·3.11 실제 설치됨)·`/usr/local/bin` 같은 머신 전역 설치물을 배제하지 못하고, 배제하는 항목(`~/.local/bin`, `~/.cache/huggingface`, 셸 설정, venv)은 이미 `env -i` + `HOME` 격리가 전부 막는다. 대신 G1의 금지 문자열 검사를 실측 목록으로 확장하고, P0-C8을 런타임 자기 보고 검증(`sys.prefix`/`sys.path`/`sysconfig`, `pg_config`/`SHOW data_directory`)으로 재정의했다. 실제 독립 설치 검증은 로드맵이 이미 Phase 6에 두고 있다.
- 2026-09-09: **Apple Developer Program 미가입 상태로 진행.** P0-C9는 ad-hoc 서명(`codesign -s -`) + hardened runtime(`--options runtime`)까지만 다룬다. R-4(MLX Metal 셰이더 런타임 컴파일·torch JIT)와 R-5(서명되지 않은 `.so` 로딩)는 그 조합으로 실측된다. 공증과 Team ID 기반 library validation(R-12)은 Phase 6 선결 조건으로 인계한다.
- 2026-09-09: 마이그레이션 적용에서 **격리 대상의 경계**를 확정(§4.0). 격리하는 것은 번들에 들어갈 산출물과 그 실행 프로세스이고, 그것에 접속하는 클라이언트(Node·`psql`)는 아니다. Node 런타임은 Phase 1에서 Electron이 제공하므로 Phase 0의 기술 위험이 아니다.
