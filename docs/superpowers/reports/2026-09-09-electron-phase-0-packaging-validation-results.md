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

### 4회차 — Task 1 3회차 리뷰가 넘긴 계획 결함 (2026-09-09)

Task 1이 수정 루프 3회 한도에 걸린 시점에 사용자가 4회차를 승인하면서, Task 2 착수 전에 반영하는 것이 낫다고 판정된 비차단 3건도 함께 계획에 넣었다 (751줄 → 760줄).

| ID | 구분 | 지적 | 조치 |
| --- | --- | --- | --- |
| P-16 | 비차단 | 규칙 2가 `pg_ctl start -l`만 금지하는데, `pg_ctl start`는 `-l` 없이도 내부에서 `/bin/sh -c "exec postgres ... 2>&1 &"`로 서버를 띄운다(`pg_ctl.c` `start_postmaster`). SIP가 `/bin/sh`에서 `DYLD_*`를 지우고 stderr가 stdout으로 합쳐져 fd 2만 캡처하는 래퍼에 안 들어온다 — 규칙 1·2를 지켜도 결과가 같다 | 규칙 2b 신설: `pg_ctl start`를 `-l` 유무와 무관하게 배제하고 `postgres -D ... &`를 직접 띄운다. Task 2 Interfaces 반영, `t2-no-pgctl-start.sh`(V2c) 신설. **이 계획 시점에 번들 `pg_ctl`이 없어 실측하지 못했다 — Task 2가 확인하고 증거에 남긴다** |
| P-17 | 비차단 | V2b·V11의 "`dyld[<pid>]`의 pid가 PID 파일과 일치" 기대값이 부족하다. re-export 뒤 런처가 부르는 `pg_isready` 등 번들 Mach-O도 자기 pid로 dyld 줄을 남겨 파일에 pid가 여럿 섞인다. 또 파일 전체를 grep하면 헤더의 `# argv:` 줄에 걸린다 | 규칙 6 신설: dyld 증거는 `^dyld` 줄로 한정해 읽고, 줄 수뿐 아니라 **그 pid의 로드 목록에 검증 대상 바이너리 경로가 실제로 있는지**까지 본다. V2b·V11 기대값과 Task 2·5·11 Review에 반영 |
| P-18 | 비차단 | 규칙 3을 지켜 런처가 exit 0 해도, 서버의 stderr는 `$RUNTMP` 안 파일을 가리키는데 래퍼의 `trap ... EXIT`가 그 디렉터리를 지운다. 이후 서버 로그가 unlink된 파일로 사라져 Task 2 V7(crash recovery) 진단이 불가능해진다 | 규칙 3b 신설: PostgreSQL은 `logging_collector=on` + `log_directory`로 서버가 직접 쓰게 하고, embed·LLM 서비스는 준비 완료 후 로그 위치를 `$SANDBOX/run/`에 기록한다. Task 2·5 Interfaces·Review 반영 |

규칙 6은 Task 1의 차단 T1-B3에서 일반화한 것이다. 그 함정이 D2 단정 하나에 그치지 않고 Task 2·5·11의 dyld 검사 전부에 해당하므로 전역 규칙으로 올렸다.

### 5회차 — Task 1 PASS 리뷰가 넘긴 계획 결함 (2026-09-09)

Task 1은 통과했으나 reviewer가 Task 2·5 착수 전 반영을 권고한 비차단 7건이 나왔다. 지금까지 미반영 계획 결함이 매번 리뷰 한 회차를 잡아먹었으므로 착수 전에 넣었다 (760줄 → 781줄).

| ID | 지적 | 조치 |
| --- | --- | --- |
| P-19 | 판정 순서가 뒤집혀 있다. Task 1의 `dyld_pid_for`는 **첫 매치 pid 하나만** 낸다. 런처가 기동 전에 같은 바이너리를 한 번 더 부르면(`postgres --version` 류) 첫 매치가 서버 pid가 아니다 — reviewer 모사에서 pid 파일 29521, 첫 매치 29520 | 규칙 6b 신설: **pid를 먼저 고정한 뒤 그 pid의 로드 목록을 본다.** `awk -v p="dyld[$(cat "$PIDFILE")]:" -v d="$BUNDLE_DIR/" '$1==p && index($NF,d)==1'` 형태를 계획에 박았다 |
| P-20 | `mlx_lm.server`·`uvicorn`은 **셔뱅 스크립트**라 dyld의 메인 이미지가 셔뱅의 Python 인터프리터 경로다. 경로 정확 일치로 보면 Task 5는 항상 빈 값이 나온다 | 규칙 6c 신설: `postgres`는 정확 일치, Python 계열은 `bundle/python/` 접두사로 가른다. 계획 V11의 "`bundle/python` 하위"가 그 뜻임을 명시 |
| P-21 | 판정이 `$NF` 기반이라 번들 경로에 공백이 있으면 필드가 갈려 깨진다 | 규칙 6d 신설: `$EXP` 이하에 공백 금지 |
| P-22 | 규칙 3b와 규칙 2가 Task 5에서 충돌한다. embed(uvicorn)·`mlx_lm.server`에는 서버가 파일에 직접 쓰는 로그 옵션이 없어, 런처가 `2> <file>`로 해결하면 **규칙 2 위반이자 D3가 잡는 가짜 증거 형태 그대로**가 된다 | 규칙 3b에 두 규칙을 동시에 만족하는 유일한 형태 `"$BIN" 2> >(tee "$LOG" >&2) &`를 명시. 서버를 bash가 직접 exec하므로 dyld 줄이 tee를 거쳐 래퍼 fd 2에 도달하고 래퍼 exit 후에도 로그가 남는다 |
| P-23 | `logging_collector=on`이면 postmaster exec 시점의 dyld 줄은 래퍼에 남지만, 백엔드가 `vector.so`·`pg_bigm.so`를 dlopen할 때의 dyld 줄은 syslogger를 거쳐 `$SANDBOX/pgdata/log/`로 간다. `t2-start-dyld.txt`에 확장 `.so` 경로가 없다 | 규칙 3b에 명시하고, 확장 로드 경로를 P0-C7 집계에 넣으려면 Task 2가 그 로그의 `dyld[` 줄을 별도 증거로 옮기도록 적었다 |
| P-24 | Task 2 V2c의 `pg_ctl start` 시험 실행이 띄우는 postgres는 `pg.pid` 밖의 프로세스이고, V2의 서버가 같은 데이터 디렉터리를 잡고 있는 동안은 기동 자체가 실패한다. 언제·어떤 라벨로 돌리고 어떻게 내리는지가 없었다 | Task 2 Interfaces에 순서와 소유권을 못 박았다 — V2 이전(또는 V6 정지 직후) 서버가 없는 상태에서 `--label t2-pgctl-trial`로 실행 → `pg_ctl stop` → 그 pid가 `pg.pid`에 들어가지 않았음을 기록 |
| P-25 | 계획 Task 1 Files·Review가 "런처 dyld 대조군 **한 쌍**"인데 구현은 D1·D2·D3 셋이다 | "셋(D1·D2·D3)"으로 정정하고 각각의 기대값을 명시 |

## 단계별 실행·리뷰

| Task | 커밋 범위 | 검토자 (model) | 회차 | 차단 지적 → 조치 | 증거 | 통과 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `4f0b02c..f121570` (`17bae8d`, `f1e1dff`, `961029f`, `f121570`) | electron-reviewer (fable) | 4 | 아래 T1-B1 ~ T1-B3, 전건 해소 | `evidence/phase-0/task-1-r{1,2,3,4}.md` | **PASS** (4회차, 차단 0건) |

| 2 | `e6cfa77..8b8d355` | electron-reviewer (fable) | 1 | 없음 | `evidence/phase-0/task-2-r1.md` | **PASS** |

### Task 2 상세

P0-C1 충족. 후보는 **소스 빌드**(스펙 §9 후보 3) — PostgreSQL 16.15 + pgvector 0.8.6 + pg_bigm 1.2-20240606. ICU·readline·zlib을 끄고 빌드해 21 MB, `otool -L bin/postgres`의 외부 의존이 `/usr/lib/libSystem.B.dylib` 하나다. 16.15는 개발 이미지의 `PG_VERSION=16.15-1.pgdg12+2`와 같은 마이너다.

**탈락은 추측이 아니라 실측이다.**

| 후보 | 결과 |
| --- | --- |
| §9-1 EDB | 배포 페이지의 `osx-binaries.zip`은 9.2.24·9.3.25뿐이고 16.x의 macOS 칸은 설치 프로그램으로만 이어진다. **받을 것이 없다** — 스펙 §9가 적어 둔 전제가 현실과 다르다 |
| §9-4 zonky | `darwin-arm64v8:16.15.0`을 받아 풀었다. `bin/`에 `initdb`·`pg_ctl`·`postgres` 셋뿐이고 `pg_config`·서버 헤더·pgxs가 없어 **확장을 붙일 수단이 아카이브 안에 없다.** 트리 296 MB(소스 빌드본의 14배) |
| §9-2 Postgres.app | 설계상 탈락(미수령). pg_bigm 때문에 어차피 툴체인이 필요해 배포본의 이점이 남지 않고, ICU·OpenSSL 의존이 Task 8·9의 대상을 늘린다 |

**재배치에서 실제로 깨진 것.** 빌드 prefix를 이 머신에 없는 `/opt/damwha-phase0/pg16`으로 두고 `stage/pg` → `bundle/pg`로 옮겼다.

1. **공유 라이브러리 `install_name` 37건** (`bin/` 20 + `lib/` 17). 옮긴 직후 `psql --version`이 exit 134 — `dyld: Library not loaded: /opt/damwha-phase0/pg16/lib/libpq.5.dylib`. **서버는 멀쩡했다** — postgres는 libpq를 링크하지 않는다. 서버만 확인했으면 클라이언트가 전부 죽은 번들을 통과시켰다. `install_name_tool -change`/`-id` + ad-hoc 재서명(arm64는 서명 없는 Mach-O를 실행하지 않는다)으로 해소.
2. **확장에 박힌 빌드 시점 include 경로.** PGXS가 `pg_config`의 절대 경로로 컴파일해 서버 헤더 인라인 함수의 `__FILE__`이 `vector.dylib`에 남는다. **이동 전 `INFO` → 이동 후 `STALE-PATH` 위반**. `-fmacro-prefix-map`으로 해소.
3. `pkglibdir/pgxs`의 `Makefile.global`에 `configure` 탐지 결과(`/opt/homebrew/bin/{ginstall,gmkdir,lz4,openssl,zstd}`)가 남아 G1 위반. 그 디렉터리는 확장을 빌드할 때만 쓰이고 실행 경로가 아니므로 제거.

1차 시도는 이동 후 G1 **exit 1, 위반 8건**이었고 수정 후 **exit 0, 0건**이다 (`t2-relocation-attempt1.txt` vs `t2-build-relocation.txt`).

**빌드 조작이 검사 회피가 아님을 reviewer가 실행으로 확인했다.** `bundle/pg`를 제3의 경로로 다시 복사해 `env -i`로 `initdb` → 포트 55439 기동 → `CREATE EXTENSION` 2종 → `<=>`·`bigm_similarity`·`likequery` 실행. 서버 pid의 dyld 86줄 중 번들 이미지가 전부 복사본 경로였고 복사본·`/usr/lib`·`/System/Library` 밖 이미지 0건. `-fmacro-prefix-map`이 지운 것은 런타임 경로 해석에 관여하지 않는 진단 문자열(`__FILE__`)이고, pgxs가 지운 것은 링크 의존이 아니라 configure 탐지 결과 문자열이다.

**V2c — 계획 규칙 2b가 실측으로 확인됐다.** 규칙 1(exec 직전 재-export)을 지키고 `-l` 없이 띄웠는데도 dyld 줄 162건이 전부 `pg_ctl` 자신의 것이고 시험 postmaster(pid 92536)의 줄은 **0건**. 서버 로그는 `pg_ctl`의 stdout으로 합쳐졌다. Task 1의 D3가 말한 가짜 증거의 실물이며, 규칙 2b가 없었으면 Task 2가 그대로 빠졌을 함정이다.

**핵심 수치.** `_migrations` = 24 (V5·V6·V7·V8 전부). 정상 재기동 pid 1764→2767, SIGKILL 후 crash recovery pid 2767→3067(`automatic recovery in progress` 로그, crash 직전 커밋 행 생존), 멱등 `initdb`는 재초기화 없이 pid 불변. 개발 볼륨 15개·컨테이너 3개 동일, `be/storage` 매니페스트 sha256 전후 동일.

**R-2는 성립하지 않았다.** `make_relative_path` 덕분에 존재하지 않는 prefix로 빌드해도 `initdb`가 `share/postgresql`을 찾았고 `pg_config`가 번들 안을 보고했다. 대신 드러난 `install_name` 37건은 R-1도 R-2도 아닌 **제3의 메커니즘**(PostgreSQL 자체의 링크 시점 절대 `install_name`, `src/Makefile.shlib`)이다. 아래 "기술 결정" 절에 **R-2b**로 등록했다.

### Task 1 상세

Verify는 3회차 모두 V1~V12 전부 기대값과 일치했다. 차단은 전부 **검증 자체의 신뢰성**에서 나왔다 — 검사기가 실제로 위반을 잡는지의 문제다.

| ID | 회차 | 차단 지적 | 조치 | 결과 |
| --- | --- | --- | --- | --- |
| T1-B1 | 1 | `check-macho.sh`의 금지 문자열 면제가 `$EXP_ROOT` 전체라 `stage/`·`downloads/`·`sandbox/`를 가리키는 재배치 잔존 경로를 놓친다. P0-C3이 핵심 관찰 대상으로 못 박은 형태이자 R-9가 정확히 그것이다 | 면제를 `"$ROOT"\|"$ROOT"/*`로 좁히고 `STALE-PATH` 위반 범주 신설. 회귀 대조군 3종(shebang·`pyvenv.cfg`·`*.pc`) 추가 | **해소** (2회차 확인, reviewer가 픽스처 5건으로 재실측) |
| T1-B2 | 2 | README의 Task 2·5 인계 항목이 실측과 반대. 2c "자손 전부가 `DYLD_*`를 물려받는다"는 거짓(플랫폼 바이너리를 거치면 SIP가 지운다), 2a의 증상 서술도 틀렸다(런처가 자식 stderr를 돌리면 `MEASUREMENT_UNAVAILABLE`이 아니라 **런처 자신의 로드 목록**이 정상 측정처럼 남는 가짜 증거) | README 2a 전면 재작성·2c 반전·5a 확장. 계획에 "런처 스크립트의 dyld 실측 규칙" 절 신설(`cd699ad`). D1/D2 대조군 추가 | **문서 수준 해소** (3회차 확인, reviewer 직접 측정값이 README 표와 일치) |
| T1-B3 | 3 | D2의 "실측된 줄이 자식 Mach-O의 것이다" 단정이 **무효**다. `run-isolated.sh:171`이 증거 헤더에 `# argv: <런처> <자식 경로>`를 쓰는데 `t1-detector-negative.sh:284`의 `grep -q -F "$DYFIX/echo" "$D2"`가 파일 전체를 훑으므로, dyld 줄에 자식 경로가 0건이어도 헤더에 항상 매치된다. reviewer가 가짜 증거 런처(ad-hoc 서명 bash + `2>/dev/null`)를 투입하니 dyld 82줄이 전부 런처 것이고 자식 0건인데 D2 두 단정 모두 OK, 스크립트 exit 0 | 판독을 `dyld_lines`/`dyld_pid_for`/`dyld_pids` 세 함수로 분리해 `^dyld\[` 줄로 한정. `dyld_pid_for`는 `awk '/^dyld\[/ && $NF == b'`로 마지막 필드 전체 일치를 본다. 그 가짜 증거 런처를 **D3 대조군으로 추가** | **해소** (4회차) |

**사용자 결정 (2026-09-09):** 수정 루프 3회 한도 도달 시점에 4회차를 승인. 범위는 T1-B3 수정과, Task 2 착수 전 반영이 낫다고 판정된 비차단 3건(계획 규칙 2b·3b·6)으로 제한했다.

**4회차 판정 근거.** reviewer가 worktree 밖에 `lib/`·`verify/`를 복사해 변이 5종을 직접 넣었고 전부 잡혔다.

| 변이 | 결과 |
| --- | --- |
| 무변이 | exit 0 (D1·D2·D3 전부 OK) |
| D2 런처를 가짜 증거 런처로 교체 | `FAIL D2: 자식 Mach-O를 로드한 pid가 dyld 줄에 없다`, exit 1 |
| `dyld_pid_for`를 3회차의 파일 전체 `grep`으로 되돌림 | `FAIL D3: ... 자식을 로드했다고 판정했다 (pid 1)`, exit 1 — 회귀 가드 작동 |
| D2 런처를 re-export 없는 런처로 교체 | D2 두 단정 모두 FAIL, exit 1 |
| D3 가짜 런처의 셔뱅을 플랫폼 `/bin/bash`로 | `FAIL D3: 가짜 증거 런처가 dyld 0건이다`, exit 1 |

접두사 단위 테스트도 통과했다 — `/x/echo` 질의가 `/x/echo2`·`/x/echo/sub`·`/y/x/echo`를 전부 무시한다.

D3의 실측 수치가 함정을 숫자로 남겼다. 커밋된 `t1-dyld-launcher-fake-dyld.txt`에서 `^dyld` 줄 **82건**, 그중 자식 Mach-O를 로드한 줄 **0건**, 파일 전체 grep 매치 **1건**(헤더 `# argv:`). 마지막 1건이 3회차에 통과를 만들어 낸 그것이다.

**Task 1이 네 회차를 쓴 이유.** Verify는 네 회차 모두 V1~V12가 전부 기대값과 일치했다. 차단은 매번 기능이 아니라 **검사기가 진짜로 검사하는가**에서 나왔고, 셋 다 "통과하고 있었지만 사실은 아무것도 보고 있지 않던" 자리였다. Task 1이 이후 열 Task의 증거를 전부 생산하므로 여기서 걸러 내는 편이 싸다.


## 최종 검증

| 완료 기준 | 확인 방법 | 증거 | 충족 |
| --- | --- | --- | --- |

## 후속 작업 (비차단 지적)

Task 1에서 나왔고 수정하지 않기로 한 것들이다.

**하네스 자체**
- `snapshot-dev-assets.sh:81` — `dev-assets-latest.txt`를 보관 없이 덮어쓴다. 스펙 §4.4가 "각 Task 종료 시 기록"을 요구하므로 이대로면 트리에 마지막 Task 기록만 남는다. `task-<N>-dev-assets.txt`로 이름을 나누는 것이 낫다.
- V6 양성 대조군(`lib/`)에 Mach-O가 0개라 `otool` 경로의 오탐 여부가 검증되지 않았다.
- `run-isolated.sh:131` — `HF_TOKEN`이 `env -i` argv에 잠깐 노출된다(같은 사용자의 `ps`). Phase 0 범위에서는 허용 가능.
- 증거 `.txt`가 고정 이름이라 재실행이 커밋된 파일을 덮어쓰고 `.prev-<timestamp>.txt`를 남긴다. git이 이미 이력을 보존하므로 회전본은 중복이다 — 2026-09-09에 삭제했다.
- `run-isolated.sh:27-28,164-167` — `MEASUREMENT_UNAVAILABLE` 주석이 0건의 원인을 "SIP가 플랫폼 바이너리에서 무시"로만 적는다. "런처가 re-export를 빠뜨림"이 더 흔한 원인이므로 두 원인을 병기해야 한다. Task 11 집계기와 사람이 이 문구를 읽는다.

**Task 2 착수 전에 반영하면 회차 손실을 줄이는 것**
- 계획 규칙 2가 `pg_ctl start -l`만 금지하는데, `pg_ctl start`는 `-l` 없이도 내부에서 `/bin/sh -c "exec postgres ... 2>&1 &"`로 서버를 띄운다(`pg_ctl.c start_postmaster`). 그러면 SIP가 `/bin/sh`에서 `DYLD_*`를 지우고 postgres의 stderr는 stdout으로 합쳐져 래퍼(fd 2만 캡처)에 안 들어온다. 규칙에 "`pg_ctl start` 자체를 쓰지 않고 `postgres -D ... &`를 직접 띄운다"를 명시해야 한다. **이 머신에 번들 pg_ctl이 없어 실측은 못 했다 — Task 2에서 확인이 필요하다.**
- Task 2 V2b / Task 5 V11의 "`dyld[<pid>]`의 pid가 PID 파일과 일치" 기대값 — re-export 뒤 런처가 부르는 `pg_isready` 등 번들 Mach-O도 자기 pid로 dyld 줄을 남기므로 파일에는 pid가 여럿 섞인다. `t2-/t5-dyld-measured.sh`는 "PID 파일의 pid를 가진 dyld 줄이 존재하고 그 pid의 로드 목록에 번들 서버 바이너리 경로가 있다"로 판정하고, T1-B3과 같은 `# argv:` 헤더 함정을 피해 `^dyld` 줄로 한정해야 한다.
- 계획 규칙 3 · `run-isolated.sh:75,133` — 런처가 exit 0 한 뒤에도 서버의 stderr는 `$RUNTMP/stderr.raw`를 가리키는데 `trap`이 그 디렉터리를 지운다. 이후 서버 에러 로그가 unlink된 파일로 사라져 Task 2 V7(crash recovery) 진단이 어려워진다. postgres는 `logging_collector=on`+`log_directory`로, 서비스는 준비 후 로그 위치를 별도 기록하는 것이 낫다.

**Task 2에서 나온 것**
- `verify/t2-extensions.sh:85-97` — 확장 dyld 판정이 pid를 고정하지 않고(`/^dyld\[/`만) `$PGDATA/log/*.txt` 전 회차를 합친다. 이번 회차는 pid 1764 줄이 실재해 유효했으나, 다음 회차에 이전 로그만으로 통과할 수 있다 (규칙 6b 위반). `$1 == "dyld[" PID "]:"` 조건을 넣어야 한다.
- `verify/t2-no-pgctl-start.sh:50` — 규칙 2 정적 검사 정규식 `[^&]*2>`가 `&> file`을 잡지 못한다. V2b가 실측 소실을 잡으므로 실해는 없다.
- `t2-extensions.sh:86`·`t2-crash-recovery.sh:61`·`pg/pgctl-trial.sh:110`이 증거 파일을 `> "$OUT"`으로 덮어썼다(스펙 §6 위반). 커밋본이 git에 남아 실해는 없었다. 계획의 "Verify 명령 작성 규칙"에 금지 문구를 추가했다.
- 계획 V6·V7이 `_migrations`=24만 본다. 스펙 P0-C1은 "마이그레이션이 만든 테이블 전량이 남는다"를 요구한다. reviewer가 직접 실측해 crash 회차·정상 재기동 뒤 public 테이블 17개가 V5 시점과 같은 집합임을 확인했으나, Verify 자체에는 `pg_tables` 집합 비교가 없다.
- `pg/pgctl-trial.sh:70-78` — 시험 postmaster의 PID 파일·`trap`이 없어 그 사이 중단되면 55432에 고아 프로세스가 남는다 (스펙 §4.4 PID 파일 규약). 일회성이고 `run.sh start`가 포트 점유 pid를 알려 주므로 복구 가능.
- `pg/run.sh:202-206` 주석의 "postmaster만 죽이면 보조 프로세스가 공유 메모리를 붙들어 다음 기동이 거절된다"는 **미실측 주장**이다. Phase 5에 의미가 있으므로 한 번 재거나 주장으로 표기해야 한다.
- `pg/run.sh`의 `--auth=trust`가 실험 전용이라는 명시가 코드 주석과 `pg/README.md` 표에 있으나, README의 "뒤 Task가 알아야 하는 것" 목록에는 빠져 있다. Task 11이 Phase 3 인계 제약으로 옮겨야 한다.
- G1은 `/opt/damwha-phase0/pg16` 문자열(35개 파일, 컴파일 시점 기본값)을 금지어로 두지 않아 보지 않는다. "재계산되는 기본값"과 "진짜 의존"은 G1로 구분되지 않으며, 옮긴 뒤 실행과 `pg_config` 자기 보고만이 구분한다. 이 구성에서는 그 실행이 있어 문제없었다.

**검증 절차**
- 3회차 verifier의 직접 재현이 4형태까지였고 가짜 증거 형태(비플랫폼 런처+리다이렉트)는 재현하지 않았다. 4회차에서 D3 대조군으로 코드에 고정됐다 — 해소.
- `lib/run-isolated.sh`의 `MEASUREMENT_UNAVAILABLE` 문구가 dyld 0건의 원인을 둘로 병기했으나 셋이다. README 2a 표 4행(플랫폼 bash 런처가 re-export 하고도 자식 stderr를 `2>/dev/null` → 0건)은 규칙 2 위반으로 0건이 나는 세 번째 경로다. 원인 (1)을 "런처가 규칙 1 **또는 2**를 어겼다"로 고쳐야 한다.
- 증거 `.txt`의 `archive_prev` 회전 로직이 그대로라 실행마다 `.prev-<timestamp>.txt`가 다시 생긴다. git이 이력을 보존하므로 중복이며, 회차마다 오케스트레이터가 지우고 있다. 로직 자체를 빼는 것이 낫다.

## 남은 제약·후속 Phase 인계

- 스펙 §11 "Phase 6로 넘기는 검증" 참조. 최종 검증 후 실제 결과를 반영해 갱신한다.

## 기술 결정과 변경 이유

- 2026-09-09: **R-2b 신설 — PostgreSQL 자체의 링크 시점 절대 `install_name`.** Task 2에서 드러났고 스펙의 위험 목록(R-1 확장·`pg_config` 절대 경로, R-2 `initdb` 시점 경로 가정)에 없는 제3의 메커니즘이다. `src/Makefile.shlib`이 공유 라이브러리에 절대 `install_name`을 박아, 번들을 옮기면 `bin/` 20개와 `lib/` 17개가 깨진다. **서버는 살고 클라이언트만 죽는 형태**라 서버만 확인하면 놓친다(`postgres`는 libpq를 링크하지 않는다). `install_name_tool -change`/`-id` + ad-hoc 재서명으로 해소되며 `pg/build.sh` 8단계에 재현 가능하게 남아 있다. **Task 8(재서명)과 Phase 3(재빌드 시 반드시 반복)에 인계한다.** R-2 자체는 성립하지 않았다 — `make_relative_path` 덕분에 존재하지 않는 prefix로 빌드해도 `initdb`와 `pg_config`가 번들 안을 찾는다.
- 2026-09-09: **PostgreSQL 제공 방식은 소스 빌드로 결정**(P0-C12의 (1)에 해당, Task 10이 최종 확정). 배포 바이너리 두 후보가 실측으로 탈락했다 — EDB는 macOS 16.x 아카이브가 아예 없고, zonky는 `pg_config`·서버 헤더·pgxs가 없어 pg_bigm을 붙일 수단이 아카이브 안에 없다. 소스 빌드본은 21 MB로 zonky(296 MB)의 1/14이고 외부 링크 의존이 `libSystem` 하나다.
- 2026-09-09: 검증 환경에서 **별도 macOS 사용자 계정을 쓰지 않기로** 결정. 새 계정은 `/opt/homebrew`·`/Library/Frameworks/Python.framework`(3.9·3.11 실제 설치됨)·`/usr/local/bin` 같은 머신 전역 설치물을 배제하지 못하고, 배제하는 항목(`~/.local/bin`, `~/.cache/huggingface`, 셸 설정, venv)은 이미 `env -i` + `HOME` 격리가 전부 막는다. 대신 G1의 금지 문자열 검사를 실측 목록으로 확장하고, P0-C8을 런타임 자기 보고 검증(`sys.prefix`/`sys.path`/`sysconfig`, `pg_config`/`SHOW data_directory`)으로 재정의했다. 실제 독립 설치 검증은 로드맵이 이미 Phase 6에 두고 있다.
- 2026-09-09: **Apple Developer Program 미가입 상태로 진행.** P0-C9는 ad-hoc 서명(`codesign -s -`) + hardened runtime(`--options runtime`)까지만 다룬다. R-4(MLX Metal 셰이더 런타임 컴파일·torch JIT)와 R-5(서명되지 않은 `.so` 로딩)는 그 조합으로 실측된다. 공증과 Team ID 기반 library validation(R-12)은 Phase 6 선결 조건으로 인계한다.
- 2026-09-09: 마이그레이션 적용에서 **격리 대상의 경계**를 확정(§4.0). 격리하는 것은 번들에 들어갈 산출물과 그 실행 프로세스이고, 그것에 접속하는 클라이언트(Node·`psql`)는 아니다. Node 런타임은 Phase 1에서 Electron이 제공하므로 Phase 0의 기술 위험이 아니다.
