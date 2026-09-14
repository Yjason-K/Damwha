# Electron Phase 3 — PostgreSQL 내장 실행 결과

브랜치: `feat/electron-migration-phase-3-embedded-postgres`
분기점: `dev` (`ff56a36`)
스펙: [2026-09-14-electron-phase-3-embedded-postgres-design.md](../specs/2026-09-14-electron-phase-3-embedded-postgres-design.md)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 3. PostgreSQL 내장"

**상태 (2026-09-14): 스펙 리뷰·구현 계획·계획 검증 완료. 구현 미착수.**

이 문서는 로드맵이 정한 네 기록을 구분해 담는다 — 스펙 리뷰, 계획 검증, 단계별 실행·리뷰, 최종 검증.
아직 채워지지 않은 절은 그 사실을 적어 둔다. **실행하지 않은 검증을 성공으로 가정하지 않는다.**

## 1. 스펙 리뷰

### 1.1 설계 대화에서 확정한 결정

스펙을 쓰기 전에 사용자와 절 단위로 확정했다(2026-09-14). 각 절은 제시 → 사용자 "진행"으로 승인됐다.

| 결정 | 선택 | 버린 대안 |
| --- | --- | --- |
| 앱이 쓰는 DB | 내장 기본 + **디버깅 전용** 외부 탈출구(`DEBUG_EXTERNAL_DATABASE_URL`) | 내장만 / Docker 경로 유지 + 내장 선택 |
| 접속 | Unix 소켓만, `local` trust · `host` reject | TCP + 앱 생성 비밀번호 / 소켓 + 디버그용 TCP |
| 마이그레이션 | 자동 실행 + 데이터가 있으면 적용 전 `pg_dump` 백업 | 자동만 / 사람 확인 후 실행 |
| 구조 | A. 역할 분담 — postgres 어댑터 = 클러스터 수명주기, api 어댑터 기동 전 단계 = 백업·실행, 감지 게이트는 안전망 | B. postgres 어댑터가 전부 / C. one-shot `migrate` 서비스 |
| 설계 절 1~5 | 데이터 배치·모드·페어링 / 클러스터 수명주기 / 마이그레이션 게이트 / 빌드·번들·dev·Docker 제거 / 데이터 안전·실패 표시·완료 기준 | — |

설계 탐색이 드러낸 사실 하나가 스펙의 무게 중심을 바꿨다 — **스토리지 키가 `meetings/mtg_N/…`이고 새 DB는
시퀀스가 1부터 시작한다.** packaged userData(`~/Library/Application Support/Damwha/storage`)에 Docker DB 소속
`meetings/mtg_37`이 이미 있어, 같은 스토리지 루트를 쓰면 새 DB가 37번에 닿는 순간 덮어쓴다. 스펙 §6.2 페어링이
여기서 나왔다.

### 1.2 외부 리뷰 — Codex CLI (쓰인 스펙 대상)

| | |
| --- | --- |
| 검토자 | Codex CLI 0.154.0 (`codex exec`, read-only 샌드박스, `model_reasoning_effort=high`) |
| 세션 | `01a09d8b-4026-7b21-988d-b4e7919c2760` |
| 대상 커밋 | `b8470db` — `docs: Electron Phase 3 — PostgreSQL 내장 스펙을 쓴다` |
| 프롬프트 방식 | 선택지 채점이 아니라 저장소를 읽고 **코드와 어긋나는 주장·데이터 안전 구멍·빠진 실패 경로·관찰 불가능한 기준·잊은 소비자·PG 특유의 실수**를 찾는 열린 과제. 이미 확인한 7건(V1~V7)을 명시해 중복을 막았다 |
| 결과 | 11건(차단 2, 중요 7, 경미 2). **전부 메인 세션이 코드로 재확인해 성립, 전부 반영** |

지적별 근거와 반영 위치는 스펙 §17의 표에 있다. 설계를 실제로 바꾼 것은 넷이다.

| 지적 | 바뀐 설계 |
| --- | --- |
| #1 차단 — 클러스터 id만으로는 짝이 증명되지 않는다 | 마커가 `{clusterId, databaseOid}` 두 층이 됐고, 마커를 `initdb` 임시 디렉터리의 rename **전에** 쓴다. 그 결과 "PGDATA 있음 + 마커 없음"은 앱이 만든 클러스터에서 생길 수 없는 상태가 되어 항상 거부된다. 초안은 그 경우 마커를 새로 적어 출처 모를 클러스터에 마이그레이션을 실행했다 |
| #2 차단 — 카탈로그 밖 오류가 자동 재시도로 샌다 | 복구 부류가 정규식이 아니라 `recovery` 필드로 실린다. 이 Phase의 새 경로는 명시하지 않으면 `manual` |
| #3 중요 — `launch()` 안 도구가 멈추면 ⌘Q도 멈춘다 | `LaunchContext.signal`과 도구별 deadline. 중단 뒤의 상태를 도구마다 정의했다 |
| #7 중요 — 공용 핸들이 postmaster에 SIGKILL을 보낸다 | postgres 전용 핸들 |

### 1.3 내부 리뷰 — 메인 세션

| | |
| --- | --- |
| 검토자 | 메인 세션 (로드맵 §"스펙 리뷰"는 이 단계를 서브 에이전트에 넘기지 않는다) |
| 대상 | `b8470db` 작성 중 자기 점검 + Codex 반영본 |
| 검토 항목 | 로드맵 범위·완료 기준 부합, 기존 코드·계약과의 충돌, 실패·중단·재시작·데이터 보존, 기준의 관찰 가능성, 내부 모순 |

**로드맵 부합** — Phase 3 범위 3항목과 완료 기준 3개가 모두 스펙의 절·기준에 대응한다(스펙 §14). 누락 없음.

**기존 계약과의 충돌** — Codex #5·#7이 찾은 둘(`refreshEnv`의 삭제 키, 공용 핸들의 SIGKILL) 외에 없음. 확인한 것:

- 웹 흐름(`be/docker-compose.yml`, `pnpm db:*`, `pnpm be:migrate`)은 advisory lock 추가 말고 불변이다. 락은 러너가
  겹칠 때만 동작을 바꾼다.
- `be/src/`의 변경은 `migrate.ts` 한 파일이다. worker·fe·contracts는 불변이다.
- Phase 2의 복구 경로(부류 없는 실패 = 자동 재시도)는 유지된다(스펙 §6.7).

**지적 3건. 전부 조치했다.**

| # | 등급 | 지적 | 조치 |
| --- | --- | --- | --- |
| S-1 | 차단 | **P3-C6·C7의 검증 전용 마이그레이션 순서가 모순이었다.** C6가 적용한 `900_p3_probe`를 C7 빌드에서 빼면, C7은 `901`에 닿기 전에 §6.5-2의 `unknown` 거부로 멈춘다 — 판정하려던 성질을 밟지 못한다 | C6 파일을 C7 끝까지 유지하고, C7 정리 순서(행·테이블 삭제 → 파일 제거 → 재빌드)를 명시 (`b8470db` 커밋 전 반영) |
| S-2 | 차단 | **C7 정리와 C8 준비가 "앱을 끈 상태에서 번들 `psql`"이었다.** 앱이 꺼지면 postgres도 꺼지므로(§6.4 종료) 그 명령은 접속하지 못한다 | 둘 다 앱이 떠 있는 동안(실패·거부 화면에서도 postgres 게이트는 통과해 서버가 떠 있다) 상태 창의 `psql`로 하도록 바꿨다 |
| S-3 | 경미 | Codex #1 반영 뒤 §6.1 배치도와 P3-C2가 여전히 "클러스터 system identifier"만 말했다 | 두 곳을 `clusterId`·`databaseOid`로 맞췄다 |
| S-4 | 차단 | **dev와 packaged가 같은 userData를 쓴다는 사실을 스펙이 반대로 적었다** (계획 작성 중 발견). 초판 §6.1은 dev가 `damwha-desktop`을 써 클러스터가 둘이라 했지만 `desktop/src/main.ts:71`의 `app.setName("Damwha")`가 둘을 한 경로로 고정한다 — 이 맥의 `damwha-desktop`은 그 전의 잔재다. 그대로 두면 (1) 고아 판정이 "번들 postgres 경로"를 보면 dev가 띄운 postmaster를 packaged가 고아로 못 알아보고 락에 막히며, (2) P3-C8·C9b·C10이 "버려도 되는 dev 클러스터"에서 한다던 파괴적 조작이 **실제 클러스터**에 닿고, (3) `unknown` 안내가 실제 데이터 폴더를 지우라고 말한다 | §6.1 정정, §6.4 고아 판정을 실행 파일 이름 + `-D`로, §6.5-2 안내 변경, §9에 "파괴적 검증의 격리"(앱 정지 → `data/` 통째 복사 → 수행 → 되돌림) 신설, C8·C9b·C10·C11·C14와 §11 표 갱신. 승인된 범위·주요 동작은 바뀌지 않았고 검증 절차만 바뀌었다 |

**재검토 결과: 통과.** 범위·계약·데이터 안전성·완료 기준에 영향을 주는 지적이 남아 있지 않다.

### 1.4 사용자 승인

- 2026-09-14, 설계 절 1~5를 대화에서 차례로 승인.
- 같은 날, 사용자가 "전체 스펙 codex 리뷰 받고 진행 시작"으로 **리뷰 반영 뒤 구현 계획 작성까지 진행**을 지시했다.
  Codex 반영은 승인된 범위와 주요 동작(내장 기본·디버그 탈출구, 소켓 전용, 백업 동반 자동 마이그레이션, 구조 A,
  데이터 배치)을 바꾸지 않았으므로 추가 승인 없이 계획 작성으로 넘어간다. 바뀐 것은 그 동작을 지키는 설계
  세부이며 §1.2에 적었다.

| 커밋 | 내용 |
| --- | --- |
| `b8470db` | 스펙 최초 작성 |
| `e12ee65` | Codex 지적 11건·내부 리뷰 S-2·S-3 반영, 결과 문서 개설 |
| `54e74c0` | 내부 리뷰 S-4 — dev·packaged userData 공유 정정 |
| `1cae368` | 구현 계획(14 Task), 계획 작성 중 실측으로 닫힌 스펙 §12 두 항목 반영 |

## 2. 계획 검증

| | |
| --- | --- |
| 검토자 | 메인 세션 (로드맵 §"계획 검증"은 이 단계를 서브 에이전트에 넘기지 않는다) |
| 대상 커밋 | `1cae368` — `docs: Phase 3 구현 계획을 쓴다 — 14 Task` |
| 계획 | [2026-09-14-electron-phase-3-embedded-postgres.md](../plans/2026-09-14-electron-phase-3-embedded-postgres.md) — 14 Task |

### 2.1 완료 기준과 구현 단계의 연결

**16건 전부 연결됐다.** 판정은 전부 Task 14가 packaged에서 하고, 단위·통합 테스트가 앞 Task에서 같은 성질을 먼저 잠근다.

| 기준 | 만드는 Task | 앞선 자동 판정 | 판정 |
| --- | --- | --- | --- |
| P3-C1 Docker 없이 첫 실행·처리·검색 | 1, 2, 5, 8, 9, 10, 12, 13 | Task 8 통합 테스트, Task 12 dev 실행 | 14 Step 3 |
| P3-C2 재시작 후 데이터 유지 | 5, 8 | Task 8 통합 테스트 2 | 14 Step 4 |
| P3-C3 앱 비정상 종료 뒤 고아 | 6, 8 | Task 8 통합 테스트 3, 단위(고아·낡은 락·ps 실패) | 14 Step 5 |
| P3-C4 TCP 없음·기존 PG 공존 | 5, 6 | Task 8 통합 테스트 1(`listen_addresses`), Task 3 Step 1 | 14 Step 6 |
| P3-C5 종료 후 0개 | 6, 8 | 단위(`stopPostmaster`), 통합(소켓 소멸) | 14 Step 4 |
| P3-C6 백업 후 적용 | 2, 9 | 단위(순서·검증·보관) | 14 Step 7 |
| P3-C7 실패 멈춤·반복 없음 | 4, 9, 12 | 단위(`mayAutoRetry`, 게이트 실패) | 14 Step 7 |
| P3-C8 `unknown` 거부 | 2, 9 | 단위(be·desktop) | 14 Step 8 |
| P3-C9 페어링 거부 | 5, 8 | 단위(판정표 1 전 행) | 14 Step 8 |
| P3-C9b DB 재생성 거부 | 5, 8 | 단위(판정표 2 전 행) | 14 Step 8 |
| P3-C10 메이저 불일치 | 5, 8 | 단위 | 14 Step 8 |
| P3-C11 외부 디버그 모드 | 8, 9, 10, 11, 12 | 단위(모드·배지·게이트 없음) | 14 Step 9 |
| P3-C12 번들 위생 | 1, 13 | Task 13 변이 | 14 Step 2 |
| P3-C13 회귀 | 전 Task | 매 Task의 test·lint | 14 Step 10 |
| P3-C14 데이터 보존 | 8, 9, 10 | Task 12 dev 실행 전후 대조 | 14 Step 1·11 |
| P3-C15 postmaster 사망 | 4, 8 | Task 3 Step 3 실측 | 14 Step 5 |

### 2.2 지적 8건. 전부 조치했다.

계획을 쓰는 동안 자기 점검으로 고친 것(ensureDirs 위치, 테스트의 TS 좁히기·바이트 계산, C6/C7 순서)은 여기 세지 않는다. 아래는 계획 전체를 저장소와 대조한 검증에서 나온 것이다.

| # | 등급 | 지적 | 조치 |
| --- | --- | --- | --- |
| V-1 | 차단 | **없는 명령** — Task 2가 `pnpm --filter damwha-be run lint`를 부른다. `be/package.json`에 `lint` 스크립트가 없다(실측: `build start dev start:dev migrate test test:e2e`) | `pnpm --filter damwha-be run build`(nest build의 tsc)로 교체 |
| V-2 | 차단 | **Task 4가 컴파일을 깬다** — `LaunchContext.bins`에서 docker를 빼고 `signal`을 더하는데, 고칠 테스트 헬퍼 표에 `recovery-hint.test.ts`(4곳)·`shell-html.test.ts`·`postgres.test.ts`가 빠졌다. 실측 `grep "bins:" desktop/tests`로 찾았다 | 표에 세 파일을 더하고 "`grep … bins` 0건까지"를 완료 조건으로 |
| V-3 | 차단 | **중복 선언** — Task 10이 main.ts에 `withoutDbKeys`·`DatabaseMode` import와 `cfg.notes` 로그 줄을 넣고, Task 12가 같은 것을 또 넣으라고 적었다 | Task 12에서 두 지시를 지우고 "Task 10에서 이미 들어왔다"로 |
| V-4 | 중간 | **Task 11 뒤 Task 12가 컴파일을 깰 수 있다** — Task 11이 compose 어댑터를 쓰던 테스트를 지우면서 그 import(`postgresSpec`)를 남기면, Task 12가 `services/postgres.ts`를 지우는 순간 테스트 파일이 컴파일되지 않는다 | Task 11에 "쓰이지 않게 된 import를 함께 지운다"를 명시 |
| V-5 | 중간 | **판정 경로 오판 위험** — 현재 `status-view.ts:87`이 `input.statuses.map(statusLine)`이다. Task 11이 `statusLine`에 두 번째 인자를 더하면 `map`의 index가 그 자리에 들어간다 | 계획 코드는 화살표로 감싼다. Task 11 Review에 "함수 그대로 넘기는 곳이 없는가"를 추가 |
| V-6 | 경미 | Task 9 api 테스트의 `ctx()`가 `as const`라 `LaunchContext`와의 호환이 우연에 기댄다 | `(): LaunchContext =>`로 타입을 단다 |
| V-7 | 경미 | Task 9 `forkNodeTool`에 쓰이지 않는 `pid` 추적과 `void pid;`가 남았다 | 지웠다 |
| V-8 | 경미 | 계획 머리말의 결과 문서 담당 Task 번호와 파일 구조 표가 Task를 나눈 뒤의 번호와 어긋났다(원인 카탈로그를 먼저, compose 제거를 배선 Task로 옮기면서 13→14 Task) | 표·머리말을 현재 번호로 |

### 2.3 그 밖에 확인한 것

- **명령이 실제로 존재한다.** `pnpm --filter damwha-desktop exec vitest run …`(vitest 4.1.9, `describe.skipIf` 있음), `pnpm --filter damwha-desktop run test|lint|compile`, `pnpm --filter damwha-be exec jest …`, `pnpm --filter damwha-be run build|migrate`, `pnpm desktop:build`·`desktop:dev`, `uv run --directory be/worker`, `node desktop/scripts/check-bundle.mjs`.
- **경로가 맞다.** `app.getAppPath()`는 dev에서 `desktop/`(shell-window.ts의 주석), packaged 산출물은 `desktop/out/mac-arm64/Damwha.app`(electron-builder `directories.output: out`), `extraResources: from: build`가 `build/postgres`를 `Resources/postgres`로 싣는다.
- **파괴적 명령을 전수 확인했다.**
  - `rm -rf`: Task 1은 `desktop/.cache/postgres/*`·`desktop/build/postgres(.tmp)`만, Task 3은 `/tmp/dwp3.*`만, 앱 코드는 §5의 네 삭제만(이름 형식·`lstat` 검사 포함).
  - 실제 userData에 닿는 것: Task 12 Step 5의 dev 실행이 **처음으로** `data/`를 만든다(전후로 `storage/`·`config.json` 대조). Task 14 Step 1이 사용자 확인 뒤 그것을 증거 폴더로 옮긴다. Task 14 Step 8의 격리 절차(`ditto`·`mv`·`rm -rf data.p3-*-after`)는 매번 사용자 확인.
  - Docker: Task 3은 임시 컨테이너 `dw-p3-locale`(`--rm`, 볼륨 없음)만. 개발 DB에는 Task 14의 읽기 조회만.
  - 검증 전용 마이그레이션(Task 14 Step 7)은 커밋하지 않고, 정리 순서가 적혀 있다.
- **각 Task가 개별 리뷰 가능하고 끝마다 초록이다.** compose 어댑터·Docker 원인은 모든 소비자가 바뀌는 Task 12에서 한꺼번에 지운다. 새 어댑터를 새 파일(`pg-service.ts`)에 두는 이유가 그것이다.
- **스펙 밖의 작업이 없다.** 새 파일(`desktop/CLAUDE.md`)은 스펙 §16의 "데스크톱 운영 문서"다. 스펙과 이름이 다른 두 곳(`pg-service.ts`, `logs/postgres.log`)은 계획 머리말에 이유와 함께 적었고 스펙 본문도 맞췄다(`1cae368`).

**재검증 결과: 통과.** 지적 8건 반영 뒤 이름 대조(계획 "자기 검토" 절), 자리표시 0건, `Verify`·`Review` 블록 14/14를 다시 확인했다.

### 2.4 사전 실측

**계획 작성 중 (2026-09-14, 메인 세션).** 계획의 분기를 줄이려고 싸게 잴 수 있는 둘을 먼저 쟀다.

| 항목 | 측정값 | 이 값이 정한 것 |
| --- | --- | --- |
| utilityProcess에서 `require.main === module` (Electron 44.3.0, `utilityProcess.fork(child.js, ["--status"])`) | `true`. `process.argv` = `[Electron Helper 경로, child.js, "--status"]` | packaged 러너가 `Resources/api/dist/database/migrate.js`를 그대로 fork한다. 전용 엔트리 파일 불필요(스펙 §10·R3-3) |
| node-pg 8.23.0이 `postgresql://damwha@/damwha?host=%2FUsers%2F…%2FApplication%20Support%2FDamwha%2Frun`를 해석 | `host`=`/Users/gim-yeongjae/Library/Application Support/Damwha/run`, `database`/`user`=`damwha`. 서버 없이 접속하면 `ENOENT …/run/.s.PGSQL.5432` — **TCP로 새지 않는다** | `embeddedDatabaseUrl`의 형식(Task 5). R3-2의 파싱 측면 해소 |
| psycopg 3.3.4 `conninfo_to_dict` (같은 URI) | `{'user': 'damwha', 'dbname': 'damwha', 'host': '/Users/gim-yeongjae/Library/Application Support/Damwha/run'}` | 같다 |
| 이 맥의 소켓 경로 길이 | 72바이트 (한도 103) | Task 5의 경계 테스트 |

**Task 3 (구현 1단계, 2026-09-14, 스크래치 클러스터 `/tmp/dwp3.*`).**

| 항목 | 측정값 | 이 값이 확인하거나 바꾼 계획 가정 |
| --- | --- | --- |
| (Task 1 Step 4 이관) 첫 빌드 시간 | 빌드 단계 77초, zsh `time` total 1:20.30 | Task 1의 빌드 시간 예산 |
| (Task 1 Step 4 이관) 캐시·스테이징 크기 | `desktop/.cache/postgres` 267M, `desktop/build/postgres` 21M | `extraResources`로 앱에 실리는 크기(21M)와 소스 캐시 크기(267M, `.gitignore` 대상)가 다르다는 전제를 확인 |
| Step 1: `initdb -D "<공백 포함 경로>"` 소요 시간 | 0.554초 (`real`) | 공백 포함 경로에서도 `initdb`가 그대로 동작 |
| Step 1: `Database system identifier:` 줄 | `Database system identifier:           7685220739933878966` (레이블 뒤 공백 정렬 + 숫자만) | Task 5가 이 줄을 파싱할 때 쓸 정확한 포맷 |
| Step 1: `postmaster.pid` 8번째 줄의 상태 전이 | 0.05초 폴링 60회 동안 `ready   $` 한 줄만 관측됨 — `starting`이 포착되지 않을 만큼 전이가 빠르다(폴링 해상도 미달) | Task 5의 `starting→ready` 전이 감지 로직은 "starting을 본다"를 전제하면 안 된다 — "ready 도달"만으로 판정해야 한다(가정 일부 수정, 아래 참고) |
| Step 1: 소켓 파일 권한 | `.s.PGSQL.5432` 700 (`stat -f '%Lp'`) | `unix_socket_permissions=0700`이 실제로 걸린다 |
| Step 1: `ps -o comm=` | `/Users/gim-yeongjae/project/daewha/desktop/build/postgres/bin/postgres` (전체 경로, 프로세스 타이틀 변경 없음) | Task 5 `classifyLockOwner`의 가정과 **일치** — 전체 경로다 |
| Step 1: `ps -o args=` | `... postgres -D /tmp/dwp3.Vy2S/App Support/pg -c listen_addresses= ...` — `-D` 뒤 공백 포함 경로가 그대로, 인용부호 없이 이어진다(경로 자체에 공백이 있어도 `-D`의 값으로 남은 문자열 전체를 취급하면 파싱 가능) | Task 5 `classifyLockOwner`가 `-D` 다음 토큰을 "다음 ` -c`/` -`까지"로 자르면 안 되고 알려진 접두 플래그들을 걷어낸 나머지로 판단해야 한다는 점을 확인. `-D` 값 자체는 그대로 살아있다는 가정은 **일치** |
| Step 1: TCP 리스닝 소켓 수 | 0 (`lsof -iTCP` 결과 없음) | `listen_addresses=''`가 TCP를 전혀 열지 않는다는 P3-C4 전제 확인 |
| Step 2: `migrate.ts --status` / 적용 후 | `{"applied":0,"pending":[…24개…],"unknown":[]}` → `{"applied":24,"pending":[],"unknown":[]}` (문자 그대로 기대값과 일치) | Task 2의 출력 형식, Task 5·8이 그대로 파싱해도 되는 근거 |
| Step 2: `pnpm --filter damwha-be run migrate -- --status` | `--`가 그대로 전달되어 `--status`로 동작 | pnpm이 `--` 뒤 인자를 손대지 않는다는 전제 확인 |
| Step 2: node-pg·psycopg 소켓 접속 | 두 클라이언트 모두 `host=<공백 포함 URL 인코딩 경로>`로 접속 성공. psycopg: `('damwha', True, 'C', 24)`(`inet_client_addr() is null`=True → TCP 아님) | R3-2 재확인. **단, `current_setting('lc_collate')`/`SHOW lc_collate`는 이 빌드·Docker 이미지 양쪽 모두에서 실패한다 — 원문 증거로 재확인(fix round 1):** Docker(`dw-p3-locale` 재기동 후) `psql -U postgres -d damwha -c "show server_version" -c "show lc_collate"` → `server_version` 행은 `16.15 (Debian 16.15-1.pgdg12+2)`를 정상 출력하고 바로 다음 줄이 `ERROR:  unrecognized configuration parameter "lc_collate"`, `select current_setting('lc_collate')`도 같은 오류. 임베디드(별도 스크래치 클러스터, `/tmp/dwp3fix.*`) `psql -X -h <run> -U damwha -d postgres -f <show server_version; show lc_collate; select current_setting('lc_collate')>` → `server_version`은 `16.15`를 출력하고 2·3번째 줄에 각각 `ERROR:  unrecognized configuration parameter "lc_collate"`. 즉 서버 접속·다른 GUC 조회는 정상인데 `lc_collate`만 못 읽는다 — 접속 실패나 오타가 아니다. 이유: PostgreSQL 16에서 `lc_collate`/`lc_ctype`는 `pg_settings`에 없는(즉 `SHOW`/`current_setting`이 못 읽는) 이름이고, 실제 값은 DB 속성인 `pg_database.datcollate`/`datctype`에만 있다(브리프 Step 2·5 SQL 자체의 오류, 이 실측 이후 발견). `SELECT datcollate FROM pg_database WHERE datname=current_database()`로 대체해 `'C'`를 확인했다 — Task 5·14가 로캘 값을 읽어야 하면 이 방식을 쓴다 |
| Step 3: `SIGKILL` 뒤 자식 소멸 | 1초 이내(`pgrep`로 무자식 확인) — postmaster 자체가 유일한 프로세스였고 즉시 사라짐 | P3-C15의 "죽은 뒤 잔존 자식이 없다" 경로 확인 |
| Step 3: `SIGKILL` 직후 소켓·잠금 파일 잔존 여부 | **남는다.** (별도 반복 실험으로 확인 — 브리프의 `ls "$M/run"`은 점파일을 감추는 bare `ls`라 오판 위험이 있어 `ls -la`로 재확인) `SIGKILL` 뒤 `.s.PGSQL.5432`·`.s.PGSQL.5432.lock`이 그대로 남는다 | Task 5 고아 판정은 소켓 파일 존재만으로 "살아있다"고 오판하면 안 되고 `postmaster.pid`의 pid 생존 여부(`kill -0`)로 판정해야 한다는 전제를 강화 |
| Step 3: `SIGKILL` 뒤 재기동 | **거절되지 않았다.** `pre-existing shared memory block`/lock 오류 없이 곧바로 crash recovery 로그(`database system was not properly shut down; automatic recovery in progress` → `redo` → `checkpoint` → `ready to accept connections`)를 남기고 `ready`에 도달(첫 폴링에서 이미 ready, 전이가 폴링 해상도보다 빠름) | R3-9 첫 답 — "`SIGKILL` 뒤 재기동이 거절된다"는 가정은 **틀렸다**. 죽은 pid가 확실하면 postgres가 스스로 stale lock을 무시하고 자동 복구한다. Task 5·14의 "재기동 거절" 분기는 "동일 pid가 아직 살아있는 다른 postmaster가 같은 데이터 디렉터리를 쓰는 경우"에만 발생한다고 좁혀야 한다(§12·P3-C15 재판정은 Task 14에서 실앱으로) |
| Step 3: `SIGINT` 중 8번째 줄 | 폴링 해상도(0.05초) 안에서 `stopping`이 관측되지 않고 곧바로 프로세스 소멸 — 셧다운이 그보다 빠르다 | 8번째 줄 `stopping` 감지에 의존하는 로직이 있다면 타이밍 경합에 약하다는 점을 기록(현재 계획엔 없음) |
| Step 3: `SIGINT` 정상 종료 뒤 | `postmaster.pid` 삭제됨, `run/` 디렉터리 완전히 빔(소켓·잠금 파일 모두 제거, `ls -la`로 확인), 로그에 `received fast shutdown request` → `database system is shut down` | 정상 종료와 `SIGKILL`의 차이(파일 잔존 여부)가 Task 5 고아 판정의 핵심 신호라는 점 확인 |
| Step 4: 발화 1,500 + 임베딩(1024차원) 1,500 적재 후 `pg_dump -Fc` | 0.507초, 16,663,747바이트(약 15.9MiB) | Task 12·14의 백업 시간·용량 예산 |
| Step 4: `pg_restore --list` | exit 0, `Compression: none`(경고 문구 없음) | 압축 없는 커스텀 포맷 덤프가 그대로 목록화된다는 전제 확인 |
| Step 5 (판정 게이트): `dw-p3-locale`(기본 로캘 `en_US.utf8`/`en_US.utf8`) vs 임베디드(`C`)에서 `kw1`·`kw2`·`kw3` | **완전히 동일**(문자열·정렬·유사도 값까지 일치) — 두 파일 전문은 아래 §2.4-부록 참고 | **진행.** 스펙 §12의 "다르면 로캘을 다시 정한다"는 발동하지 않았다 — `pg_bigm` 기반 키워드 검색은 로캘 영향을 받지 않는다 |
| Step 5: `ord`(제목 정렬)·`case`(대소문자 접기) | 다르다 — `ord`: Docker(en_US.utf8)는 로캘 콜레이션 순, 임베디드(C)는 코드포인트 순(대문자·기호가 한글보다 앞으로 옴). `case`: `lower('ÉCLAIR 예산')`가 C에서는 `Éclair 예산`(É 유지), en_US.utf8에서는 `éclair 예산`(é로 접힘). `upper`도 대칭적으로 다르다 | `grep -rn "ORDER BY .*title\|lower(\|ILIKE" be/src` **0건** — 제품 코드가 제목 정렬·대소문자 접기·`ILIKE`를 쓰지 않는다. **영향 없음 → 진행**(멈추지 않음) |
| Step 5: `diff "$R/docker.txt" "$R/embedded.txt"` | exit 1 (차이는 `ord`·`case`만, 위에서 영향 없음으로 판정) | 판정 게이트 통과 근거 |
| Step 6: `codesign --force --deep --sign -` 뒤 4개 확인 | 앱 전체를 `--force --deep --sign -`로 다시 서명한 **뒤** 측정한 상태: `codesign --verify --deep --strict "$A"` exit 0 / `codesign --verify .../bin/psql`(중첩 Mach-O) exit 0 / `codesign -dv .../lib/libpq.5.dylib`가 `Signature=adhoc` 표시 / `env -i psql --version`·`env -i postgres --version` 둘 다 정상 실행(16.15). (재서명 전 개별 서명과의 전후 비교는 측정하지 않았다 — Task 1 스크립트가 만든 Mach-O는 원래도 각각 ad-hoc 서명돼 있었다) | **가정과 일치** — `--force --deep --sign -` 뒤에도 중첩 Mach-O가 `codesign --verify`를 통과하고 `psql`·`postgres`가 정상 실행된다. Task 12에 "재서명 뒤 다시 개별 서명" 단계를 추가할 필요 없음 |
| 정리 확인 | 스크래치(`/tmp/dwp3.*`) 전부 삭제, `dw-p3-locale` 컨테이너 `--rm`으로 자동 제거(재확인 시 목록 없음), `damwha-postgres` 생성 시각(`2026-09-11 15:43:37 +0900 KST`) 실측 전후 불변, `~/Library/Application Support/Damwha`에 `data`·`run`·`backups` 없음(기존 `config.json`·`storage`·`logs` 등은 이 실측과 무관하게 이미 존재) | 측정 규칙 준수 확인 |

**Step 5 두 결과 파일 전문 (`$R/docker.txt` vs `$R/embedded.txt`, `diff` 결과는 위 표 참고):**

```
docker.txt (dw-p3-locale, en_US.utf8):
kw1|Budget 예산 line items|0.142857
kw1|올해 예산을 다시 검토하겠습니다|0.111111
kw1|예산안 초안은 다음 주에 나옵니다|0.105263
kw2|50% 절감 목표를 세웠어요
kw3|ÉCLAIR éclair Éclair
ord|나눔 워크숍
ord|가을 예산 회의
ord|ábaco 점검
ord|Budget review
ord|Éclair 회고
ord|zeta 정리
case|éclair 예산|ÉCLAIR

embedded.txt (스크래치 클러스터, C):
kw1|Budget 예산 line items|0.142857
kw1|올해 예산을 다시 검토하겠습니다|0.111111
kw1|예산안 초안은 다음 주에 나옵니다|0.105263
kw2|50% 절감 목표를 세웠어요
kw3|ÉCLAIR éclair Éclair
ord|Budget review
ord|zeta 정리
ord|Éclair 회고
ord|ábaco 점검
ord|가을 예산 회의
ord|나눔 워크숍
case|Éclair 예산|éCLAIR
```

## 3. 단계별 실행과 리뷰

아직 없다.

## 4. 최종 검증

아직 없다. 완료 기준 P3-C1~C15(+C9b)는 하나도 실행되지 않았다.

## 5. 남은 제약과 후속 Phase 인계

아직 없다.
