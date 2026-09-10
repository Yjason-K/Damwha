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

| 3 | `f4c9b78..aaf02f1` | electron-reviewer (fable) | 1 | 없음 | `evidence/phase-0/task-3-r1.md` | **PASS** |

| 4 | `a6fd22b..8f86452` | electron-reviewer (sonnet) | 1 | 없음 | `evidence/phase-0/task-4-r1.md` | **PASS** |

| 5 | `385c1c4..f840679` | electron-reviewer (opus) | 1 | 없음 | `evidence/phase-0/task-5-r1.md` | **PASS** |

| 6 | `3f98475..5ad955b` | electron-reviewer (opus) | 1 | 없음 | `evidence/phase-0/task-6-r1.md` | **PASS** |

| 7 | `350f03f..45aacd6` (`6668045`, `1727761`, `45aacd6`) | electron-reviewer (fable) | 2 | T7-B1 (해소) | `evidence/phase-0/task-7-r{1,2}.md` | **PASS** |

### Task 7 상세

**P0-C4 충족.** 번들 런타임만으로 31분 실제 오디오가 처리됐다 — 개발 venv도 Homebrew도 Docker도 없이.

| 단계 | DB로 확인 | 로그값 |
| --- | --- | --- |
| normalize | `normalized_key` + 43.3 MB 파일 | 1,677 ms |
| probe | `duration_ms=1883254` | — |
| VAD | **DB 행 없음 — 로그만** | 7,046 ms, spans=268 |
| diarization | `diar_label` 5종 | 169,527 ms, segments=1272 |
| ECAPA | centroid 5/5, voiceprint 5 | 28,550 ms |
| identify | provisional 화자 5 = `identified=0/5` | 50 ms |
| STT | text 있는 `ok` 373건 | 315,088 ms, words=4028 |
| align | order_index/start/end 457행 | 64,602 ms |
| persist | `job done/progress=100` | `outcome=committed` |

VAD만 DB 흔적이 없어 로그로 판정했다. reviewer가 타당하다고 봤다 — 그 줄은 제품 코드 `pipeline/timing.py::timed_stage`가 찍고 G2 래퍼가 stderr를 그대로 받은 것이지 구현자의 진술이 아니며, `process_meeting.py:85-87`에서 VAD는 건너뛸 스위치가 없고 STT가 그 `speech_spans`를 입력으로 받으므로 하류 DB 흔적이 있으면 구조적으로 돈 것이다.

**차단 T7-B1 — V5가 멱등하지 않았다.** `RC_NEW`가 **현재** `t7-pipeline.txt`의 `NEW` 표시만 봐서, 캐시가 남는 한 재실행이 영원히 exit 1이었다. 스펙 §4.4는 "재실행은 멱등해야 한다"와 "처음부터 받은 측정은 빈 캐시에서 한 번만 수행하고 **그 회차를 증거에 명시**한다"를 요구한다 — "그 회차 기록"이지 "매 회차 새로 받음"이 아니다. 계획 V5의 기대 문구도 "저장소가 **존재**"였다. **스크립트가 계획보다 엄격해서 생긴 구현 결함이다.**

수정은 (a)+(b) AND — 회전된 `t7-pipeline.prev-*.txt` 전수 탐색으로 회차를 특정하고, blobs가 실체·심볼릭 링크 아님·**`nlink` 전부 1**·생성 시각으로 재실행 멱등을 준다. `nlink=1`이 "개발자 캐시와 실체를 하드링크로 공유하지 않는다"를 **개발자 홈을 읽지 않고** 말해 준다.

**"새로 받았다"의 실제 증거는 nlink가 아니다.** reviewer가 1회차 stderr의 httpx 요청 시각과 blob 생성 시각이 **파일 단위로 1:1 대응**함을 찾았다 — `config.yaml` 15:58:16Z↔`4022db…`, `segmentation/pytorch_model.bin` 15:58:26Z↔`7ad243…`, `plda/xvec_transform.npz` 15:58:29Z↔`325f1c…`, `plda/plda.npz` 15:58:30Z↔`9b77bc…`, `embedding/pytorch_model.bin` 15:58:32Z↔`6f10ff…`. `nlink=1`은 하드링크 공유만 배제하고 `cp`·APFS clone은 배제하지 못한다.

**변이 9종 중 7종이 FAIL을 냈다** — blobs 전부 심볼릭 링크 / nlink 추가 / 회차 기록 제거 / 저장소 삭제 / `blobs/` 심볼릭 링크 / `blobs/` 비움 / 회차 파일 전무. 부수로 scratch 경로에서 돌리자 기록된 `HF_HOME` 대조가 살아 FAIL했다.

**V7 `snapshot-dev-assets.sh after` exit 1 — 일치: 아니오.** 원인은 `before`(00:14:47Z)가 `docker: daemon-unreachable`, `after`가 볼륨 목록인 **docker 프로브 도달성 전환**이며, `be/storage` 매니페스트는 before/after 모두 `a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`(29 files, 2,227,477,523 bytes)로 동일하다. 스펙 §4.4의 "`be/storage` 무변화"는 충족, 검사기 exit 코드는 미충족. 후속: Task 11 `t11-dev-untouched.sh`. **`before`를 다시 찍어 exit 0을 만들지 않는다** — 실험 이전 상태가 아니게 된다.

**V2는 재리뷰 회차에 미실행이다.** 수정(`45aacd6`)이 `verify/t7-lib.sh`(+9)와 `verify/t7-sandbox-models.sh`(+111/-28)만 건드렸고 드라이버·번들·`be/worker`는 무변경이라, V5가 V2의 산출 파일을 읽기만 하므로 파이프라인 재실행이 판정에 새 정보를 주지 않는다. r1 결과(`outcome: committed`, `mtg_2`, 567,389 ms)를 옮겨 적었고 통과로 세지 않았다.

**시간대 버그.** `stat -t '%Y-%m-%dT%H:%M:%SZ'`는 **현지 시각에 리터럴 `Z`를 붙인다** — 같은 blob에 `2026-09-10T00:58:16Z`(KST에 Z) vs `date -u -r`의 `2026-09-09T15:58:16Z`. 9시간·1일 어긋난다. reviewer가 `experiments/electron-phase-0/{lib,verify,pg,services}` 전체를 훑어 `stat`에 `-t`나 `%S` 서식을 쓰는 다른 곳이 **없음**을 확인했다 — 다른 Task 증거의 시각 표기는 틀리지 않았다.

**재실행에서 458→457로 1건 줄었다.** STT 단어 수 4028→4013에 따른 align 차이이고 mlx-whisper GPU 경로의 비결정성이다. `transcribe_failed`는 두 회차 모두 84로 같고 VAD·diarize·embed는 `spans=268`·`segments=1272`·`clusters=5`로 결정적이었다.

### Task 6 상세

P0-C2 충족. 번들 PostgreSQL(55432)과 번들 embed(58100)를 붙여 `search.repository.ts`와 같은 CTE 구조로 질의했다. 질의 `'예산'`, cand_k=100, rrf_k=60 → **kw 3 / sem 12 / fused 12.** 두 경로가 각각 0건이 아니다.

**`sem`이 실제 임베딩으로 동작한다는 증거가 세 회차에서 재현됐다.** `sem` 상위 3건에 **"예산" 글자가 없는** 발화("재무팀이 비용 절감안을 검토하고 있습니다.")가 든다 — `kw`는 절대 못 찾고 임베딩만 찾는 항목이다. 구현자 `utt_28`, verifier `utt_40`, reviewer `utt_40`로 재시드에 따라 id만 갈렸고 텍스트·거리값은 소수점 6자리까지 같다. 고정 모델·고정 문장의 결정적 결과다.

**`fused`가 진짜 FULL OUTER JOIN이다.** cand_k=3에서 kw 3 / sem 3 / **fused 4**(kw만 1, sem만 1, 공통 2). INNER면 2, LEFT·RIGHT면 3이므로 4가 세 대안을 전부 배제한다. kw 전용 행의 점수가 정확히 `1/(60+3)=0.015873…`이라 sem 쪽 `COALESCE`가 0으로 채워졌음까지 확인된다. reviewer가 INNER·LEFT 위조 TSV를 검사기에 넣어 둘 다 exit 1을 확인했다.

**확장이 이름만 있는 게 아니라 C 함수에 연결돼 있다.** `pg_depend`로 `likequery`·`bigm_similarity` → `pg_bigm`(`probin=$libdir/pg_bigm`), `cosine_distance` → `vector`(`$libdir/vector`). reviewer는 `pg_operator`까지 봐서 `<=>`(vector,vector) **연산자 자체가 `vector` 확장 소속**이고 `oprcode=public.cosine_distance`임을 확인했다. `likequery('50% 절감')` → `%50\% 절감%`(이스케이프), `bigm_similarity` 동일 1.0 / 유사 0.5 / 무관 0.0, `<=>` 직교 1 / 동일 0 / 반대 2.

**dyld 증거에 pid 6개가 섞였다.** V1이 두 런처를 자체 기동하는 구조라 `t6-seed-dyld.txt` 2577줄이 embed 915 / driver 715 / resource_tracker 702 / `pg_isready` 82×2 / postgres 81로 갈린다. **규칙 6b(pid 먼저 고정)를 세워 두지 않았으면 통째로 세서 판정했을 것이다** — Task 2에서 `pg_isready` 하나를 보고 넣은 규칙이 여기서 훨씬 심한 형태로 회수됐다.

**판정 강도를 reviewer가 수치로 검토했다.** 채택한 단정의 여유는 C("상위 3건에 off 없음") 0.1333, D("상위 3건에 sem 그룹 1건 이상") 0.0562. 제외한 "주제 6건이 off 6건보다 전부 앞선다"는 0.0097뿐이라 거리표로만 남긴 선택이 맞다(6~14배 차이). 다만 **난수 벡터를 잡는 것은 C 단정 하나뿐이고 우연 통과 확률이 C(6,3)/C(12,3) = 9.1%다.**

### Task 5 상세

P0-C5·P0-C5b 충족. embed는 `127.0.0.1:58100`에서 `/health` → `{"status":"ok"}`, `/embed` → `model=BAAI/bge-m3`·`dimension=1024`. `mlx_lm.server`는 `bundle/python/bin/mlx_lm.server`이고 셔뱅이 번들 python3.12 — **스펙 §2가 지목한 "어떤 매니페스트에도 없는 네 번째 런타임"이 번들에서 떴다.** 인자 형태가 제품 경로(`llm_server.py:106-114`)와 동일하다.

**규칙 3b의 `tee` 형태가 동작했고, 왜 동작하는지가 실측으로 밝혀졌다.** reviewer가 프로세스 트리를 직접 떴다 — `81161`(서버 python3.12) ← `81163`(프로세스 치환 bash) ← `81164`(`/usr/bin/tee`). **tee는 플랫폼 바이너리라 exec 시점에 SIP가 `DYLD_*`를 지워 자기 dyld 줄을 만들지 않는다.** 그래서 파이프 중간 프로세스가 증거를 오염시키지 않고, 서버는 bash가 직접 exec하므로 dyld 줄이 서버 것으로 남는다. 규칙 3b를 세울 때 의도한 근거가 아니었는데 결과적으로 이것이 그 형태가 깨끗한 이유다.

| 항목 | embed | llm |
| --- | --- | --- |
| `^dyld` 총줄 | 1617 | 1802 |
| 서버 pid의 줄 | 915 | 901 |
| 그중 `bundle/python/` 하위 | 202 | 187 |
| 서버 pid의 번들·`/usr/lib`·`/System/Library` 밖 로드 | **0** | **0** |
| `/usr/bin/tee` pid의 dyld 줄 | **0** | **0** |

개발자 자산 6종 전부 0건. 모델 9.1 GB가 전부 샌드박스 `HF_HOME`이고 개발자 `~/.cache/huggingface`는 실행 창 내 변경 0건.

**검사기 결함이 하나 더 드러났다.** dyld 증거에 줄이 두 모양이다 — `dyld[pid]: <UUID> /절대/경로`(로드, 필드 3개)와 **`dyld[pid]: move loaded to delayed: <이름>`(경로 없이 잎 이름만)**. `$NF`로 "번들 밖 경로"를 세면 둘째가 전부 위반으로 잡혀 V11 1회차가 embed·llm 각각 **존재하지 않는 위반 155건**을 냈다. 이미지 로드 줄(`NF==3`)로 한정해 고쳤고, 그 실패 회차를 지우지 않고 `t5-dyld-measured.prev-20260909T141803Z.txt`로 커밋했다.

reviewer가 커버리지 손실이 없음을 확인했다 — 증거의 `move loaded to delayed` 309건의 잎 이름이 **전부** 같은 파일에 전체 경로 로드 줄로도 존재한다(경로 로드 줄이 없는 이름 0개).

**`t2-dyld-measured.sh`에 같은 `$NF` 구조가 남아 있으나 Task 2 판정은 유효하다.** 이 결함은 거짓 FAIL만 만들고 거짓 PASS는 만들지 못하며, `t2-start-dyld.txt`의 비-load 줄이 0건이다(t1~t4 전수 확인: t2 계열 0건, t3 155~255건, t4 111건). t3·t4 판정부는 접두사 아래 로드 수만 세어 영향이 없다.

**규칙 4의 폴백은 취지 안이다.** V11이 stop 뒤에 오는데 stop이 PID 파일을 지우므로 런처가 `$SANDBOX/run/{embed,llm}-start.txt`에 기동 시점 pid를 함께 남긴다. reviewer가 `/bin/bash 3.2.57`에서 `cmd 2> >(tee f >&2) &` 뒤의 `$!`가 프로세스 치환이 아니라 cmd의 pid임을 실측했고, PID 파일 값 = `lsof`가 보고한 포트 소유 pid = `ps`의 서버 프로세스임을 확인했다. 같은 `$!`로 같은 순간에 쓰이므로 값이 갈릴 수 없다.

**모델 다운로드 낭비 발견.** bge-m3가 같은 가중치를 두 벌 받는다 — blob `b5e0ce…`(2,271,145,830 B, `pytorch_model.bin`, rev `5617a9f…`=`refs/main`)와 `993b22…`(2,271,064,456 B, `model.safetensors`, rev `9a0624b…`). 리비전까지 갈린다. **2.1 GB 낭비**이며 Task 9(P0-C13)로 넘겼다.

디스크 21 GiB → **11 GiB**. Task 7·9가 더 받아야 해 R-14가 조여 온다.

### Task 4 상세

P0-C6 충족. 후보는 **소스 빌드**(스펙 §9 후보 2), `--disable-gpl --disable-nonfree --disable-version3`. configure가 스스로 `License: LGPL version 2.1 or later`를 보고한다. 공개 정적 빌드(후보 1)는 관례적으로 `libx264`·`libx265`·`libfdk-aac`를 켜 GPL 또는 nonfree 구성인데, 담화는 비디오를 다루지 않고 손실 인코딩도 하지 않아 그 비용을 치를 이유가 없다. 소스 빌드가 107초로 끝나 "빌드를 피할" 이점도 없었다. **R-8 해소.**

`bundle/ffmpeg` = **42 MB**(`ffmpeg` 21.97 + `ffprobe` 21.78). `include/`·`lib/*.a`·`pkgconfig`·`share/`는 빌드 전용이라 제외했고, `otool -L`에 절대 경로 참조가 전혀 없어 실행에 영향이 없음을 reviewer가 확인했다.

**재배치에서 아무것도 깨지지 않았다 — 세 번들 중 처음이다.** `--enable-static --disable-shared` 완전 정적 링크로 `otool -L` 의존이 `/usr/lib/*`·`/System/Library/Frameworks/*`뿐이고 **`LC_RPATH` 커맨드 자체가 없다.** 이동 전/후 G1 위반이 둘 다 0건이고, reviewer가 제3의 경로로 복사해 격리 실행한 결과 사후 처리 없이 정상 동작했다. Task 2(`install_name` 37건)·Task 3(`LC_RPATH` 58건)과 대비되며, **정적 링크가 재배치 문제를 통째로 없앤다**는 것이 Phase 3·4 결정에 쓸 사실이다.

**Homebrew ffmpeg와의 구분이 이 Task의 핵심 위험이었다.** 이 머신의 Homebrew ffmpeg가 **같은 버전 9.0.1**이고, 두 `ffprobe -version` 첫 줄이 `ffprobe version 9.0.1 Copyright (c) 2007-2026 the FFmpeg developers`로 **글자 그대로 동일**하다(verifier 실측). 버전 문자열로는 구분이 불가능하고 dyld 로그의 메인 이미지 경로만이 근거다. 세 dyld 증거 모두 `^dyld` 688줄에 `/opt/homebrew` **0건**, 메인 이미지가 `bundle/ffmpeg/bin/{ffprobe,ffmpeg}`.

**그 판정 로직 자체를 reviewer가 변이로 검증했다** — `t4-probe-dyld.txt`를 Homebrew 경로가 든 가짜 증거로 바꿔치기하니 정확히 FAIL(`dyld 줄에 /opt/homebrew 가 1건 있다` / `번들 아래 이미지를 연 pid가 없다 — 가짜 증거다`). 원본 복구 후 재확인까지 했다.

**검증 명령이 제품 코드와 일치한다.** reviewer가 `pipeline/ffmpeg.py::probe()`/`normalize()`의 `cmd` 리스트와 `t4-probe.sh`/`t4-normalize.sh`의 인자열을 대조해 순서·값이 정확히 같음을 확인했다. duration `1883.254422`가 원본과 오차 0으로 일치.

체크섬은 Task 2의 pgvector·pg_bigm과 같은 한계다 — ffmpeg.org가 공개 sha256을 제공하지 않고 이 머신에 gpg가 없어 `checksums.txt`는 2026-09-09 TLS 수신값의 자체 관측이다. README에 명시됐다.

### Task 3 상세

P0-C3 충족. 후보는 **python-build-standalone 3.12.11 + `uv pip install --python`**(스펙 §9 후보 1). `bin/python3.12`가 libpython을 `@executable_path/../lib/…`로 참조하고 `LC_RPATH`가 없다. venv를 만들지 않고 배포본 `site-packages`에 직접 설치해 절대 경로가 박히는 층을 하나로 줄였다. `bundle/python` = **1509 MiB**(파일 38420개) — torch 411, mlx 203, llvmlite 124, scipy 81, onnxruntime 75 MiB. 모델은 없다.

**후보 2(`uv venv --relocatable`) 탈락은 reviewer가 재현했다.** `--relocatable`이 상대화하는 것은 activate 스크립트뿐이고 `pyvenv.cfg`의 `home`은 절대 경로다. 기본 base가 `/opt/homebrew/opt/python@3.12`라 옮긴 뒤 `sys.base_prefix`가 `…/Python.framework/Versions/3.12`로 나온다 — G1 금지 문자열 두 개에 정면으로 걸린다. 후보 3(PyInstaller)은 P0-C8이 보는 `sys.prefix` 의미가 달라지고 진입점이 여럿(`mlx_lm.server`·`damwha-worker`·`damwha-embed`·`uvicorn`)이라 전제가 맞지 않는다. 후보 4(conda-pack)는 이 머신에 conda 계열이 없다(실측).

**재배치: 이동 전 136 → 이동 후 201 → 사후 처리 후 0.**

| 항목 | 내용 |
| --- | --- |
| R-9 (예측 적중) | `bin/`의 콘솔 스크립트 **65개 전부**가 stage 절대 경로 shebang. `mlx_lm.server`·`uvicorn`·`damwha-worker`·`damwha-embed` 포함. 이동 전 `INFO` → 이동 후 STALE-PATH 위반 |
| wheel `LC_RPATH` 58건 (신규) | scikit-learn 51, scipy 3(Homebrew `gcc@13`), torchaudio 2, Pillow 1, PyAV 1. **dyld의 실제 검색 경로**라 가장 실질적 |
| `LC_ID_DYLIB` 64건 | delocate `/DLC/…`, torch `/opt/llvm-openmp/…`, protobuf `bazel-out/…` → `@rpath/` 정규화 |
| `_sysconfigdata` prefix | 설치 시점 값이라 `sys.prefix`와 갈림 |
| `__pycache__` | 컴파일 시점 경로가 `.pyc`에 박힘 |
| R-3 (미성립) | torch·mlx의 실제 의존 경로(`LC_LOAD_DYLIB`)가 허용 접두사 밖인 것 **0건** |

**reviewer가 제3의 경로로 다시 옮겨 실측했다.** `relocate`를 다시 돌리면 셔뱅 65/65 재작성·sysconfig 재작성·`__pycache__` 760개 삭제가 일어나고 **`LC_RPATH` 0건·`LC_ID_DYLIB` 0건** — 첫 relocate가 완결적이고 Mach-O 처리는 멱등이다. 옮길 때마다 필요한 것은 셔뱅·sysconfig·pyc 셋뿐이다. `LC_ID_DYLIB` 정규화가 "의존이 아니라 id"라는 판단도 확인됐다 — Mach-O 460개 전체의 `LC_LOAD_DYLIB`에 옛 id 참조가 0건이고, dyld는 로더 쪽 `LC_LOAD_DYLIB`로 해석하지 피로드 dylib의 id를 참조하지 않는다.

**검사기 수정을 reviewer가 직접 실측으로 검증했다.** Task 1이 네 회차로 신뢰를 세운 `check-macho.sh`를 Task 3이 고쳤으므로 Tier(normal)보다 한 단계 위인 fable로 리뷰했다. 결과: 같은 문자열을 다른 파일에 넣으면 위반, 허용된 파일에 다른 금지 문자열을 넣으면 위반, `setuptools/tests_evil.py`·`__pycache__/other…pyc`·태그 없는 `site.pyc`·`.pyc.bak` 전부 위반 — 글롭과 `.pyc→.py` 매핑 모두 우회 수단이 되지 않는다. 허용 목록에 STALE-PATH·OTOOL-L·LC_RPATH 항목을 **억지로 넣어도** 면제되지 않는다(`allow_reason`이 문자열 분기에서만 호출된다). `bundle/pg` 재검사는 exit 0·ALLOW 0건 — Task 2의 통과 판정이 소급해 흔들리지 않는다.

**ALLOW 42건** 중 실동작 폴백은 `soundfile.py` 4, `ctypes/macholib/dyld.py` 1, `PIL/_imagingft…so` 1. `STALE-PATH`·`OTOOL-L`·`LC_RPATH`·`STRING` 전부 0.

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

**Task 3에서 나온 것**
- `lib/check-macho.sh:129-147` — 허용 규칙의 단위가 (경로, **금지 문자열 접두사**)이지 (경로, 토큰)이 아니다. reviewer 픽스처: `site.py`에 `/usr/local/lib/libsndfile.dylib`를 넣어도 `site.py + /usr/local/lib` 규칙으로 ALLOW 된다 — 근거는 "독스트링의 python2.5 예시 경로"인데 다른 토큰이 통과한다. ALLOW 줄에 토큰이 출력되므로 사람이 보면 드러나고 현재 42건은 전부 근거대로였다. 규칙에 4번째 열(토큰 글롭)을 두어 큰 파일의 규칙을 좁혀야 한다. **Task 4 이후 허용 목록에 항목을 추가할 때는 이 한계를 알고 넣어라.**
- `lib/g1-allowlist.txt:81` — `scipy/linalg/_fblas…so` `/opt/homebrew` 규칙이 **죽은 규칙**이다. `LC_RPATH` 삭제와 함께 문자열 자체가 사라져 최종 번들에서 0건이다. 남겨 두면 그 파일에 새로 `/opt/homebrew`가 생겨도 흡수한다. 삭제해야 한다.
- `lib/g1-allowlist.txt:90-92` — `certifi-*/METADATA` 류 글롭의 `*`가 `/`를 넘어가 `certifi-evil/sub/METADATA`도 ALLOW 된다(실측). `certifi-*.dist-info/METADATA`로 좁혀야 한다.
- **`python/README.md:111-131`의 "옮기면 65개가 `bad interpreter`로 죽는다"는 옛 경로가 사라진 경우에만 맞다.** reviewer가 번들을 제3 경로로 복사하고 `relocate` 없이 `bin/uvicorn --version`을 실행하니 정상 종료했고 `sys.executable`이 **원래 `bundle/python/bin/python3.12`** 였다 — 옛 경로가 남아 있으면 죽지 않고 **조용히 다른 런타임을 실행한다.** 앱 업그레이드로 옛 버전이 잠시 공존하는 상황에서 더 위험한 형태다. Phase 4·6 인계 항목이다.
- `python/build.sh:53` — `mlx-lm==0.31.3`만 고정되고 `mlx`(0.32.2)는 전이 해석이다. 매니페스트가 없어 여기 적은 것은 타당하나 **`mlx-lm`·`mlx` 버전의 단일 진실 원천이 아직 없다**(`pyproject.toml` 밖). P0-C12·Phase 4 인계.
- 번들 Mach-O 460개 중 `relocate`가 손대지 않은 파일에 **서명이 아예 없는 것**이 있다(`charset_normalizer/*.so`, `fontTools/*.so`, `_sounddevice_data/…/libportaudio.dylib`; `codesign -v` → `code object is not signed at all`). 지금은 로드된다. **Task 8의 직접 입력**이라 계획에 전수 목록 작성을 넣었다.
- 스펙 §4.4의 `docker volume ls` after 측정이 OrbStack 무응답(26분)으로 빠졌다. Task 3 코드에 docker 호출이 없고 볼륨에 쓰는 경로가 없어 차단으로 보지 않았다. Task 4 시작 시 before 목록(볼륨 15개)과 대조해 사후 보완하도록 계획에 넣었다.
- **리뷰 부수효과(reviewer 자진 신고):** 사본 `damwha-embed --help`를 시험하다 그 진입점이 인자를 무시하고 서버를 띄운다는 것을 몰라 127.0.0.1:8100에 embed 서버가 두 번 떴다. 각각 PID로 종료했고 사전에 8100 리스너가 없어 개발 프로세스와 충돌하지 않았다. 그 실행이 `~/.cache/huggingface/.agent_harnesses.json`(6 KB 메타데이터)을 썼다 — 모델 파일 변경은 없으나 §4.4 문면상 위반이다. **`damwha-embed`·`damwha-worker`는 인자를 무시하고 바로 서비스를 띄우므로 `--help`로 시험하지 마라.**

**Task 7에서 나온 것**
- `verify/t7-sandbox-models.sh:110-119` — `nsym`(심볼릭 링크 수)을 출력만 하고 판정에 쓰지 않는다. reviewer 변이: 가장 큰 blob 26 MB 하나만 실제 캐시로의 심볼릭 링크로 바꿔도 **exit 0**이다(실체 판정이 `nb>=1 && bb>=1MB`뿐이라 나머지 5.9 MB가 문턱을 넘긴다). 1회차 스크립트에도 같은 구조였으므로 이번 수정의 퇴행은 아니고 실제 캐시는 심볼릭 링크 0개다. `[ "$nsym" -eq 0 ]`을 조건에 넣어야 한다.
- 같은 파일 `:120-128` — 실체 파일이 0개일 때 `nbad=0`이 되어 `OK 전부 nlink=1`을 찍는다. 종료 코드는 다른 축에서 FAIL이라 판정은 맞지만 **출력 문장이 거짓**이다.
- 같은 파일 `:130-140`·`:165-190` — 생성 시각과 회차 기록이 **서로 묶여 있지 않다.** 캐시가 NEW 회차 뒤에 지워지고 개발자 캐시에서 `cp`로 채워져도 nlink=1 + NEW 기록으로 통과한다. 실제 증거에서는 httpx 로그와 blob 시각을 사람이 읽어 묶었다.
- `verify/t7-lib.sh:40-48`의 회전 파일명이 **1초 단위**라 같은 초의 두 회차 중 앞의 것이 `mv`로 덮인다. `t7-v5-idempotent.txt`에서 00:53:27 회차가 실제로 사라졌다. **t2·t4·t5·t6 lib와 `process_meeting_driver.py:188`·`seed_search.py:128`도 같은 형태다.** `mv -n` + 접미사 루프로 통일해야 한다.
- `t7-no-docker.sh`의 리터럴 검사가 양쪽으로 약하다. reviewer 변이: `import docker` 추가 → exit 1, 주석 `# Docker is not used here` → exit 1(설명문까지 잡음), **`__import__("test"+"containers")` → exit 0**, `subprocess.run(["/usr/local/bin/"+"doc"+"ker",…])` → exit 0. 검사를 만족시키려고 docstring을 두 번 고치고 README에 "이름을 적지 마라"를 적게 된 것은 **검사가 문서 내용을 좌우하는 신호**다. `ast`로 import 이름·`subprocess` argv를 수집하고 주석·docstring은 제외해야 한다.
- `process_meeting_driver.py:313-321`의 provisional 화자 GC가 **전역 조건**이다. 제품 `db/meetings.py:196-203`과 같은 SQL이라 제품 동작을 벗어나지 않고 현재 고아 0건이지만, 뒤 Task가 고아 provisional 화자를 시드하면 Task 7 재실행이 말없이 지운다.
- 정규화에 쓴 **ffmpeg** 바이너리의 dyld 실측이 이 Task에 없다 — 재호출이 ffprobe만이다. 그 실측은 Task 4의 `t4-normalize-dyld.txt`에 있으므로 결과 기록에서 그 파일을 참조한다.

**Task 6에서 나온 것**
- `verify/t6-seed.sh:95`의 절 제목이 "난수·상수 벡터 차단"인데 **난수는 차단하지 못한다.** reviewer가 12행을 난수 단위벡터로 바꿔 확인했다 — "서로 다른 벡터 12개 / L2 노름 1"이 둘 다 OK로 exit 0이다. 상수·복제·차원 차단은 유효하다. 난수를 실제로 잡은 것은 `t6-hybrid.sh`의 C 단정 하나이고 우연 통과 확률이 9.1%다. 제목을 "상수·복제 벡터 차단"으로 좁히고 난수 차단 책임이 V3 C에 있음을 명시해야 한다.
- `verify/t6-operators.sh:140` — 난수 벡터 상태에서도 exit 0으로 통과했다(우연히 가장 가까운 행이 kw, 가장 먼 행이 off였다). V4의 목적은 연산자 동작 확인이므로 문제는 아니나, **"거리 순서가 주제를 반영한다"를 V4로 근거 삼지 않는다.**
- `drivers/query_search.sql:11-13`의 제품 코드 대조 줄 번호가 셋 어긋난다(`52-79` → 실제 52-83, "80-86" → 실제 77-83). 이 헤더가 "원본이 바뀌면 사본이 낡는다"를 대비하는 유일한 장치라 틀리면 목적을 잃는다.
- **인덱스 경로가 한 번도 타지 않았다.** 시드가 12행뿐이라 `EXPLAIN`이 `sem`은 `Seq Scan` + `Sort`, `kw`도 `Seq Scan`을 낸다. `utterance_embedding_hnsw_idx`(hnsw/`vector_cosine_ops`)와 `utterance_text_bigm_idx`(gin/`gin_bigm_ops`)가 존재하지만 스캔에 쓰이지 않았다. P0-C2의 성공 판정에 인덱스 요구가 없어 차단은 아니다 — **번들 pgvector의 HNSW 스캔 경로는 Phase 0에서 미검증**이며 Phase 3 인계 항목이다.
- 회전 정책이 한 Task 안에서 둘이다 — `seed_search.py:121-130`은 내용이 다를 때만, `t6-lib.sh:47-56`은 무조건 회전한다. 내용 손실은 없으나 `prev-*` 개수로 회차를 세면 어긋난다.

**검증 절차**
- 3회차 verifier의 직접 재현이 4형태까지였고 가짜 증거 형태(비플랫폼 런처+리다이렉트)는 재현하지 않았다. 4회차에서 D3 대조군으로 코드에 고정됐다 — 해소.
- `lib/run-isolated.sh`의 `MEASUREMENT_UNAVAILABLE` 문구가 dyld 0건의 원인을 둘로 병기했으나 셋이다. README 2a 표 4행(플랫폼 bash 런처가 re-export 하고도 자식 stderr를 `2>/dev/null` → 0건)은 규칙 2 위반으로 0건이 나는 세 번째 경로다. 원인 (1)을 "런처가 규칙 1 **또는 2**를 어겼다"로 고쳐야 한다.
- 증거 `.txt`의 `archive_prev` 회전 로직이 그대로라 실행마다 `.prev-<timestamp>.txt`가 다시 생긴다. git이 이력을 보존하므로 중복이며, 회차마다 오케스트레이터가 지우고 있다. 로직 자체를 빼는 것이 낫다.

## 남은 제약·후속 Phase 인계

- 스펙 §11 "Phase 6로 넘기는 검증" 참조. 최종 검증 후 실제 결과를 반영해 갱신한다.

## 기술 결정과 변경 이유

- 2026-09-09: **스펙 §4.1의 "금지 문자열 0건"은 우리가 빌드한 산출물에만 문자 그대로 적용한다.** Task 3이 보고한 스펙 충돌에 대한 결정이며 사용자가 승인했다.

  Task 2(PostgreSQL)는 우리가 소스에서 빌드했으므로 위반 0건을 문자 그대로 달성했다. Python·ML 런타임은 우리가 빌드하지 않은 제3자 wheel 수백 개와 CPython 표준 라이브러리 **원본**으로 이뤄져 있고, 거기에는 금지 문자열이 구조적으로 들어 있다 — 독스트링(`site.py`의 `/usr/local/lib/python2.5/…`), 다른 플랫폼용 분기(torch의 Linux/Xeon·NVSHMEM 경로), wheel 배포자의 빌드 머신 경로, ctypes/dlopen 폴백 목록. **CPython 자신이 이것을 갖고 있고 3.11+에서 `site` 모듈이 동결돼 `libpython3.12.dylib`에 박히므로, 어떤 CPython 배포본을 골라도 마찬가지다.** 지우면 표준 라이브러리가 아니게 된다.

  처리 방식: **재배치를 깨는 것(STALE-PATH·OTOOL-L·LC_RPATH)은 하나도 면제하지 않고 전부 고쳤다** (이동 후 201건 → 사후 처리 후 0건). 번들에서 뺄 수 있는 것(빌드 전용 트리·tkinter·pip)은 뺐다. 남은 24건만 `experiments/electron-phase-0/lib/g1-allowlist.txt`에 (상대 경로, 금지 문자열, 근거)로 분류했다. 경로를 반드시 적게 해 전역 면제를 막았고 — 같은 문자열이 다른 파일에 나오면 여전히 위반이다 — `bundle/pg`에는 한 줄도 걸리지 않는다. 매 회차 `ALLOW`로 근거와 함께 출력하므로 숨기는 것이 아니라 분류하는 것이다.

  **P0-C7의 판정 기준:** "위반 0건"은 우리가 빌드한 산출물과 재배치를 깨는 모든 항목에 대해 적용한다. 제3자 원본 문자열은 "분류·근거·대체 확인"으로 처리하며, 대체 확인은 G2 dyld 실측(스펙 §4.2)과 P0-C8 런타임 자기 보고가 맡는다. 허용 목록 24건 중 **실동작 폴백 3건**(`soundfile.py`, `ctypes/macholib/dyld.py`, `PIL/_imagingft…so`)은 Task 11이 "실제로 쓰이지 않았음"을 증거로 보여야 하며, 보이지 못하면 P0-C7을 충족으로 적지 않는다. Phase 4 인계 항목이기도 하다.

  스펙 문서 자체는 고치지 않는다 — 로드맵이 "확정된 날짜별 스펙·계획은 당시 결정의 기록으로 보존하고, 확정 후 설계 변경은 후속 문서에 원문 링크와 변경 이유를 남긴다"고 정했다. 이 항목이 그 기록이다.
- 2026-09-10: **P0-C4의 "게이트 모델 3종"은 제품 기본 파이프라인이 요구하는 게이트 저장소 전부로 읽는다.** Task 7 reviewer가 낸 SPEC-REVIEW에 대한 결정이며 사용자가 승인했다.

  HF API 실측: `pyannote/speaker-diarization-community-1`은 `gated=auto`이고 **segmentation·embedding·plda를 자기 저장소에 담는다** — 게이트 저장소 **1종**. `speaker-diarization-3.1`(`auto`) + `segmentation-3.0`(`auto`)는 2종이고 `wespeaker-voxceleb-resnet34-LM`은 **`gated=False`**다. 즉 **어떤 설정으로 돌려도 3종이 나오지 않는다.**

  "3종"의 출처는 `be/worker/SMOKE.md:9-12`의 "accept all three"인데, 그것은 **두 파이프라인의 게이트 저장소 합집합**(3.1 + segmentation-3.0 + community-1)이지 한 파이프라인이 3종을 받는다는 뜻이 아니다. 스펙을 쓸 때 이를 "한 번에 3종"으로 오독했다.

  **P0-C4의 판정 기준:** "게이트 모델을 새로 받았다"는 **그 실행이 쓴 파이프라인이 요구하는 게이트 저장소 전부**를 샌드박스에 새로 받았는지로 본다. 제품 기본값(`be/src/config/env.ts:18`, `be/.env:9`)인 `community-1` 경로에서는 1종이며, Task 7이 그것을 받았다. 스펙 §2와 `SMOKE.md`의 "3종"은 pyannote.audio 3.x 시절 기록으로 남는다. 각 저장소의 게이트 여부는 **Task 9(P0-C10)가 실측해 표로 확정한다.**

  스펙 문서 자체는 고치지 않는다 — 로드맵이 "확정된 날짜별 스펙·계획은 당시 결정의 기록으로 보존하고, 확정 후 설계 변경은 후속 문서에 원문 링크와 변경 이유를 남긴다"고 정했다. Task 3의 G1 허용 목록 결정과 같은 방식이다.
- 2026-09-09: **R-3은 성립하지 않았고 대신 wheel 배포자의 `LC_RPATH`가 나왔다.** R-3은 torch·mlx의 `.dylib`/`.metallib`가 빌드 시점 절대 경로를 참조할 위험이었는데, 번들 전체에서 실제 의존 경로(`LC_LOAD_DYLIB`)가 허용 접두사 밖인 것은 0건이었다. 대신 **wheel 배포자의 빌드 머신 `LC_RPATH` 58건**(scikit-learn 51, scipy 3 — Homebrew `gcc@13` 경로, torchaudio 2, Pillow 1, PyAV 1)이 나왔다. dyld의 실제 검색 경로라 실질적이며, `-delete_rpath` + `codesign -f -s -`로 해소했다. **R-9(콘솔 스크립트 shebang)는 예측대로 나타났다** — `bin/`의 65개 전부가 이동 후 `bad interpreter`로 죽었고 `mlx_lm.server`·`uvicorn`·`damwha-worker`·`damwha-embed`가 포함된다.
- 2026-09-09: **R-2b 신설 — PostgreSQL 자체의 링크 시점 절대 `install_name`.** Task 2에서 드러났고 스펙의 위험 목록(R-1 확장·`pg_config` 절대 경로, R-2 `initdb` 시점 경로 가정)에 없는 제3의 메커니즘이다. `src/Makefile.shlib`이 공유 라이브러리에 절대 `install_name`을 박아, 번들을 옮기면 `bin/` 20개와 `lib/` 17개가 깨진다. **서버는 살고 클라이언트만 죽는 형태**라 서버만 확인하면 놓친다(`postgres`는 libpq를 링크하지 않는다). `install_name_tool -change`/`-id` + ad-hoc 재서명으로 해소되며 `pg/build.sh` 8단계에 재현 가능하게 남아 있다. **Task 8(재서명)과 Phase 3(재빌드 시 반드시 반복)에 인계한다.** R-2 자체는 성립하지 않았다 — `make_relative_path` 덕분에 존재하지 않는 prefix로 빌드해도 `initdb`와 `pg_config`가 번들 안을 찾는다.
- 2026-09-09: **PostgreSQL 제공 방식은 소스 빌드로 결정**(P0-C12의 (1)에 해당, Task 10이 최종 확정). 배포 바이너리 두 후보가 실측으로 탈락했다 — EDB는 macOS 16.x 아카이브가 아예 없고, zonky는 `pg_config`·서버 헤더·pgxs가 없어 pg_bigm을 붙일 수단이 아카이브 안에 없다. 소스 빌드본은 21 MB로 zonky(296 MB)의 1/14이고 외부 링크 의존이 `libSystem` 하나다.
- 2026-09-09: 검증 환경에서 **별도 macOS 사용자 계정을 쓰지 않기로** 결정. 새 계정은 `/opt/homebrew`·`/Library/Frameworks/Python.framework`(3.9·3.11 실제 설치됨)·`/usr/local/bin` 같은 머신 전역 설치물을 배제하지 못하고, 배제하는 항목(`~/.local/bin`, `~/.cache/huggingface`, 셸 설정, venv)은 이미 `env -i` + `HOME` 격리가 전부 막는다. 대신 G1의 금지 문자열 검사를 실측 목록으로 확장하고, P0-C8을 런타임 자기 보고 검증(`sys.prefix`/`sys.path`/`sysconfig`, `pg_config`/`SHOW data_directory`)으로 재정의했다. 실제 독립 설치 검증은 로드맵이 이미 Phase 6에 두고 있다.
- 2026-09-09: **Apple Developer Program 미가입 상태로 진행.** P0-C9는 ad-hoc 서명(`codesign -s -`) + hardened runtime(`--options runtime`)까지만 다룬다. R-4(MLX Metal 셰이더 런타임 컴파일·torch JIT)와 R-5(서명되지 않은 `.so` 로딩)는 그 조합으로 실측된다. 공증과 Team ID 기반 library validation(R-12)은 Phase 6 선결 조건으로 인계한다.
- 2026-09-09: 마이그레이션 적용에서 **격리 대상의 경계**를 확정(§4.0). 격리하는 것은 번들에 들어갈 산출물과 그 실행 프로세스이고, 그것에 접속하는 클라이언트(Node·`psql`)는 아니다. Node 런타임은 Phase 1에서 Electron이 제공하므로 Phase 0의 기술 위험이 아니다.
