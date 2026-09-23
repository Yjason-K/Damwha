# Electron Phase 3 — PostgreSQL 내장 실행 결과

브랜치: `feat/electron-migration-phase-3-embedded-postgres`
분기점: `dev` (`ff56a36`)
스펙: [2026-09-14-electron-phase-3-embedded-postgres-design.md](../specs/2026-09-14-electron-phase-3-embedded-postgres-design.md)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 3. PostgreSQL 내장"

**상태 (2026-09-14): 구현 13개 Task·최종 whole-branch 리뷰·packaged 통합 검증 완료. 완료 기준 16건(P3-C1~C15, C9b) 전부 충족.**
통합 검증이 결함 1건(실패 화면이 10초마다 다시 로드됨)을 드러내 같은 브랜치에서 고친 뒤 실앱에서 다시 확인했다(`0f97171`).

이 문서는 로드맵이 정한 네 기록을 구분해 담는다 — 스펙 리뷰, 계획 검증, 단계별 실행·리뷰, 최종 검증.
**실행하지 않은 검증을 성공으로 가정하지 않는다.** 조건을 달고 통과로 적은 기준은 §4.1의 비고에 조건을 적었다.

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

실행 방식은 **Subagent-Driven Development**다 — Task마다 새 구현자(sonnet)를 붙이고, 그 diff만 보는 리뷰어를
따로 붙였다(Task 8·9·12는 opus). 지적이 남으면 같은 구현자에게 수정 라운드를 열고 범위를 좁힌 재리뷰로 닫았다.
수정 루프 상한은 로드맵 규칙대로 3회이고, 넘긴 Task는 없다. 판정(Ruling)은 전부 원장
(`.superpowers/sdd/2026-09-14-electron-phase-3-embedded-postgres/progress.md`)에 남겼다.

Phase 2의 규칙을 처음부터 적용했다 — **변이 증거와 TDD RED/GREEN 원문**을 리뷰의 필수 제출물로 두고, 보고서가
재구성한 출력은 그 자체를 지적했다. Task 14(packaged 통합 검증)는 서브에이전트에 넘기지 않고 메인 세션이 사용자와
함께 했다.

### 3.1 단계별 결과

| Task | 내용 | 커밋 범위 | 수정 라운드 | 그 라운드가 연 이유 |
| --- | --- | --- | --- | --- |
| 1 | PG 번들 빌드 스크립트 | `ec3963e..b7117a4` | 0 | — |
| 2 | `migrate.ts --status` · advisory lock | `b7117a4..4e0a221` | 0 | — |
| 3 | 사전 실측 | `4e0a221..34055c4` | 1 | `lc_collate` 판정의 원문 증거가 없었다. PG16에 그 GUC가 없음을 두 환경 원문으로 붙였고, 계획 Task 8의 통합 테스트를 `pg_database.datcollate`로 고쳤다(`5736053`) |
| 4 | 복구 부류 · `LaunchContext.signal` | `34055c4..a4a1721` | 0 | — |
| 5 | 배치·페어링·락 파일 순수 판정 | `a4a1721..9bb03b9` | 0 | — |
| 6 | 도구 실행기 · postmaster 핸들 | `9bb03b9..0716eb7` | 0 | — |
| 7 | 원인 카탈로그 · 안내 | `0716eb7..6b4873d` | 1 | 페어링 거부 안내가 스펙의 "옮기거나 **지우지** 않았는지"를 "바꾸지"로 적었다(계획 원문) |
| 8 | 내장·외부 postgres 어댑터 | `6b4873d..b35a73b` | 1 | 락 거부가 디렉터리를 만든 뒤라 §5 위반, 판정표 2 전 `stopping`이 게이트를 연다, 죽은 핸들 행에 부류 없음 (§3.2) |
| 9 | 마이그레이션 실행 게이트 | `b35a73b..720a38e` | 1 | 검증 실패 시 prune하지 않음을 잡는 테스트 없음, 러너 실패 원인이 잘리고 로그에 안 남음 (§3.2) |
| 10 | 설정의 DB 모드 · 재적용 | `720a38e..99ff0d4` | 0 | — |
| 11 | 화면 — 내장 DB 표시, Docker 화면 제거 | `99ff0d4..f368f14` | 0 | — |
| 12 | main 배선 · Docker 경로 제거 | `f368f14..1f7f449` | 1 | manual 실패가 창 재열기·이전 타이머로 다시 돈다 (§3.2) |
| 13 | 패키징 · 번들 위생 검사 | `1f7f449..393a665` | 0 | — |
| 최종 | whole-branch 리뷰(fable) → 수정 1회 + 재리뷰 1회 | `393a665..aa537d1` | 1 | 비밀번호가 경고·로그에 그대로 실림 외 4건 (§3.2) |
| 14 | packaged 통합 검증 | `aa537d1..0f97171` | 1 | 실패 화면이 10초마다 다시 로드됨 (§4.2) |

계획의 테스트 수 표기는 Task 5(38→36)·6(17→16)·8(25→24)에서 틀렸다. 리뷰가 브리프의 테스트 코드를 직접 세어 빠진
테스트가 없음을 확인했다.

### 3.2 이 단계들에서 실제로 잡힌 결함

전부 리뷰 또는 컨트롤러의 독립 확인이 잡았고, 대부분이 **계획 원문을 그대로 옮긴 코드**의 결함이었다. 구현자의 자기
보고로 드러난 것은 테스트 수 오기와 URL 검증 방식(아래 마지막 항목)뿐이다.

**락 거부가 파일시스템을 바꿨다 (Task 8).** 스펙 §5는 "고아 확인 불가"를 아무것도 만들거나 지우지 않는 거부로
명시했는데, 계획의 `launch()`는 `ensureDirs()`·`removeInitdbLeftovers()`를 락 판정보다 먼저 불렀다. `ps`가 실패하거나
고아가 내려가지 않아 거부할 때 이미 `run/`·`backups/`가 생기고 `postgres.initdb-*`가 지워진 뒤였다. 기존 거부 테스트는
그 디렉터리의 부재를 보지 않아 초록이었다.

**판정표 2 전에 게이트가 열렸다 (Task 8).** `postmaster.pid`가 `stopping`이면 계획 코드는 무조건 `degraded`를 냈고,
감독자는 `degraded`를 준비 완료로 본다. 기동 중 누가 서버를 내리면 `damwha` DB 확인 없이 api가 뜬다.

**"검증 실패 시 옛 백업을 지우지 않는다"를 지키는 테스트가 없었다 (Task 9).** 계획의 해당 테스트는 `pg_dump`를
실패시켜 prune 코드에 닿기 전에 끝났다. 변이 "prune을 검증 앞으로"가 모든 테스트를 통과했다 — 데이터를 지우는
경로다. 기존 `.dump` 6개 + 덤프 성공 + `pg_restore --list` 실패 테스트로 잠갔고, 시계가 거꾸로 가면 방금 만든 백업이
지워지는 결함도 함께 고쳤다.

**마이그레이션 실패의 원인이 사라졌다 (Task 9).** 게이트는 stderr 꼬리 12줄을 보였는데 `migrate.ts`는
`console.error(DatabaseError)`를 찍는다. 그 꼬리 12줄은 `routine: 'parserOpenTable' }` 같은 속성 덤프라 오류 문장과
code가 잘렸고, 러너 출력 전체는 어느 로그에도 남지 않았다. 게이트가 출력 전체를 `supervisor.log`에 남기고 화면에는
stderr **앞쪽**의 첫 오류 줄을 싣게 했다. P3-C7의 실패 화면이 `error: relation "p3_nope" does not exist`를 보인 것이 이
수정이다.

**manual 실패가 되살아났다 (Task 12).** (1) 앞선 auto 실패가 걸어 둔 타이머가 manual 실패 뒤에도 한 번 더 돌아
게이트를 재실행했다 — 백업이 하나 더 쌓인다. (2) 창을 다시 열면 `window-flow.ts`가 `start()`를 무조건 불러 manual
실패를 재실행했다. 스펙 §6.7은 "manual은 버튼과 메뉴로만"이다. 둘 다 테스트할 수 없는 `main.ts`에서 리뷰가 읽어
잡았다.

**최종 리뷰가 잡은 것 (5건).**
- 내장 모드에서 `config.json`의 옛 `DATABASE_URL`이 기본값과 다르면, 경고가 그 값을 비밀번호째 화면과
  `supervisor.log`에 실었다. 가림 처리를 공용 함수로 뽑았다(`mask-db-url.ts`).
- initdb 실패 뒤 임시 디렉터리 삭제에 로그 줄이 없었다(§5).
- `spawnNotFound`의 정규식이 Phase 3 원인 블록 속 `spawn … ENOENT`를 먼저 잡아 원인·안내가 바뀌었다.
- 낡은 주석 2곳.
- 상태 창 postgres 줄에 서버 로그 폴더(`logs/postgres/`) 안내가 없었다.

재리뷰는 새로 쓴 주석 하나가 "postgres만 따로 백오프를 갖는다"는 사실과 다른 설명을 지어냈다고 지적했고,
컨트롤러가 직접 고쳤다(`aa537d1`).

**계획이 틀렸던 곳 (구현자 보고).** 계획의 `embeddedDatabaseUrl` 테스트는 `new URL("postgresql://damwha@/damwha?…")`로
검증했는데, WHATWG URL은 userinfo와 빈 host의 조합을 스킴과 무관하게 거부한다. 구현 문자열은 스펙대로 두고,
테스트만 `pg-connection-string`과 같은 방식(`@/` → 더미 호스트)으로 바꿨다.

### 3.3 판정 기록

원장의 Ruling 중 결과에 영향을 준 것만 옮긴다.

| 판정 | 이유 | 틀렸다면 |
| --- | --- | --- |
| 수정 루프 상한 3회 (스킬의 5회 대신) | 로드맵 규칙 | 3회 뒤 사용자에게 한 번 묻는 대기 |
| Task 14는 메인 세션이 사용자와 함께 | Docker 종료·데이터 격리를 매 단계 확인해야 한다 | 메인 컨텍스트 사용 증가 |
| Task 12 dev 실행의 GUI 확인은 로그·`ps`·번들 `psql`로, 화면 문구는 Task 14로 | 서브에이전트는 창을 볼 수 없다 | dev 화면 결함이 늦게 드러남 |
| 상태 창 postgres 로그 링크는 `logs/postgres.log`로 두고 폴더는 안내 줄로 | `logPathOf`는 로그 싱크와 같은 함수라 폴더로 바꾸면 싱크가 깨진다 | 스펙 §6.7 문구와 한 곳 다름 (§5.2) |
| 최종 리뷰를 packaged 검증 **앞**으로 | 리뷰 수정이 들어가면 사용자와 한 검증 증거가 낡는다 | 리뷰가 Task 14 결과를 못 본다 — 실제로 Task 14가 결함 1건을 따로 냈다 |
| utilityProcess `'exit'` 뒤 stdout 유실 가능성은 코드를 고치지 않고 콜드 기동 10회로 측정 | 사용자 공간 완화책이 없다(Electron이 exit 뒤 stdout을 null로 만든다) | 가끔 "상태 줄을 내지 않았어요"로 수동 재시도 |
| P3-C1의 "config.json sha 불변"은 "`REPO_ROOT` 추가 외 불변"으로 | 이 userData에는 `REPO_ROOT`가 없어 packaged가 Phase 2 규칙대로 물어 저장한다(유일한 쓰기 예외) | C1·C14의 config 항목이 조건부 |
| 실패 화면 깜빡임은 검증 도중 수정하고 같은 조건으로 재확인 | 사용자가 재시도로 오인했다. 수정이 다른 기준의 판정을 바꾸지 않는다 | 한 번 더 격리 절차 |

### 3.4 이월 항목

per-Task 리뷰의 경미 지적과 parked 항목은 최종 리뷰가 하나씩 분류했다(FIX-NOW 1건은 위 비밀번호 노출). 남긴 것은 §5.2·§5.3에 적었다.

## 4. 최종 검증

packaged는 `pnpm desktop:build`로 만든 `desktop/out/mac-arm64/Damwha.app`을 실행했다. 실데이터에 닿는 조작(OrbStack
종료·기동, 검증 전용 마이그레이션 빌드, `data/` 격리 복사·되돌리기, postmaster·앱 `kill -9`, `config.json` 키 편집)은
매번 직전에 사용자 확인을 받았다. 증거는 저장소 밖 `~/.cache/damwha-p3-evidence/`에 있다.

**환경 차이.** 이 맥의 Docker 런타임은 Docker Desktop이 아니라 **OrbStack**이다. 스펙의 "Docker Desktop 완전 종료"는
OrbStack 종료로 수행했고(`docker info` 실패 기록), 같은 런타임의 다른 프로젝트 컨테이너도 함께 멈췄다.

**시작 상태.** Task 12의 dev 실행이 실제 userData에 만든 `data/`·`run/`·`backups/`는 P3-C1이 "기존 userData 위의 첫
실행"을 보도록 증거 폴더(`t12-dev-data/`)로 옮기고 시작했다.

### 4.1 판정

| 기준 | 판정 | 빌드 커밋 | 근거 (증거 파일) |
| --- | --- | --- | --- |
| P3-C1 Docker 없이 첫 실행·처리·검색 | **충족 (조건)** | `aa537d1` | `docker info` 실패. 새 클러스터·DB 생성, `_migrations` 24. 한국어 오디오 1건 `done`, 파일은 `data/storage/meetings/mtg_1/`에만 생겼다. 처리 중 `pg_stat_activity`의 client backend 5개가 전부 `client_addr` NULL. (a) 고유명사 `일론 머스크` 키워드 검색, (b) 전사에 없는 표현 `로켓 회사의 재무 성과` 의미 검색이 모두 발화를 찾았다(사용자 확인, `api.log`의 `POST /api/search`). userData `storage/` 체크섬 불변. 옛 키 경고는 화면에 없고 로그에 한 줄씩. **조건:** `config.json`은 `REPO_ROOT` 추가만 달라졌다(packaged 폴더 선택). `embed.log`에 시각이 없어 "같은 시각의 `POST /embed 200`"은 증명하지 못하고 호출 존재만 확인했다 (`c1-*.txt`) |
| P3-C2 재시작 후 데이터 유지 | **충족** | `aa537d1` | ⌘Q 뒤 재실행. 마커 `{7685289567798622822, 16384}`와 `pg_controldata` id가 종료 전과 같다. PG 로그 `database system was shut down` 뒤 곧바로 ready, recovery 줄 없음. 회의·전사가 보였다(사용자 확인) (`c2-after-restart.txt`) |
| P3-C3 앱 비정상 종료 뒤 고아 처리 | **충족** | `aa537d1` | 제목을 바꾼 뒤 앱 main `kill -9`. postmaster 47001이 ppid 1로 생존. 재실행 시 `supervisor.log`에 "이전 실행이 남긴 postmaster(pid 47001)를 내린다" → "종료 결과 — fast"(PG 로그상 4ms). 새 postmaster 48655 ≠ 47001, postmaster 트리 하나, 제목 유지 (`c3.txt`) |
| P3-C4 TCP를 열지 않고 기존 PG와 공존 | **충족** | `aa537d1` | `damwha-postgres`가 5432에 떠 있는 상태. 번들 postmaster와 자식의 TCP 소켓 0개, 5432 리스너는 OrbStack뿐, `run/` 700. 내장 클러스터의 client backend 전부 소켓 접속. Docker DB의 client backend 수가 실행 전후 모두 1(측정용 psql 자신). 앱 화면의 회의 목록은 내장 클러스터의 1건(사용자 확인) (`c4.txt`) |
| P3-C5 종료 후 번들 postgres 0개 | **충족** | `aa537d1` | 앱 main이 사라진 뒤 45초 동안 0.5초 간격 추적에서 번들 postgres가 한 번도 보이지 않았다 — main보다 먼저 내려갔다(`supervisor.log`상 postgres stopped 07:36:53.505Z, main 소멸 07:36:53.99Z). PG 로그 `received fast shutdown request` → `database system is shut down`(6ms), `immediate` 없음. `run/` 비어 있음. 종료 순서 worker → embed → api → postgres (`c5-track.txt`) |
| P3-C6 데이터가 있는 DB에 새 마이그레이션 | **충족** | `aa537d1` + 미커밋 `900_p3_probe.sql` | `…-before-900_p3_probe.sql.dump`의 mtime 08:22:41.774Z < `applied_at` 08:22:41.857Z. `pg_restore --list` exit 0. `_migrations` 25. `.partial` 없음. 정상 진입 (`c6.txt`) |
| P3-C7 마이그레이션 실패 — 멈추고 반복하지 않음 | **충족** | `aa537d1` + 미커밋 `900`·`901` | 120초 동안 10초 간격: 게이트 실행 1회, 새 백업 1개, API·worker 프로세스 0개. `_migrations`에 901 없음. 실패 화면에 원인(`relation "p3_nope" does not exist`)과 백업 경로, 카운트다운 없음(사용자 확인). 정리: 실패 화면에서 psql로 900 행·`p3_probe` 삭제 → 두 파일 삭제 → 재빌드(번들에 9xx 0개) → 정상 진입 (`c7*.txt`) |
| P3-C8 `unknown` 마이그레이션 거부 | **충족** | `aa537d1` | 격리 절차 안. `999_from_future.sql` 삽입 뒤 재실행 → "더 새 버전의 앱이 이 데이터를 업데이트했어요 (999_from_future.sql)". API 0, 재시도 0, `_migrations` 불변. 되돌린 뒤 정상 진입 (`step8.txt`) |
| P3-C9 페어링 거부 | **충족** | `aa537d1` | `data/postgres` 이름 변경 → "파일 저장소에 파일이 있는데 데이터베이스가 없어요"와 두 경로. `data/`에 새 `postgres`·`postgres.initdb-*` 없음, `data/storage` 체크섬 불변, 카운트다운 없음. 되돌린 뒤 정상 진입 |
| P3-C9b 데이터베이스를 다시 만든 클러스터 거부 | **충족** | `aa537d1` | 격리 절차 안. `DROP DATABASE damwha WITH (FORCE)` 뒤 재실행 → "데이터베이스(damwha)가 지워졌어요". `base/`에 시스템 DB 셋(1·4·5)만 — 다시 만들어지지 않았다. 마커·`data/storage` 체크섬 불변. API 0. 되돌린 뒤 정상 진입. `pg_database` 대신 `base/` 목록으로 판정했다 — 거부 뒤 감독자가 postmaster를 내려 조회할 서버가 없다 |
| P3-C10 PostgreSQL 메이저 불일치 거부 | **충족** | `aa537d1` | 격리 절차 안. `PG_VERSION` 16→15 → "데이터 폴더의 PostgreSQL 버전(15)이 앱의 버전(16)과 달라요". 번들 postgres 0. `PG_VERSION` 외 PGDATA 체크섬 불변. 되돌린 뒤 정상 진입 |
| P3-C11 외부 디버그 모드 | **충족** | `0f97171` (dev) | 사람이 `DEBUG_EXTERNAL_DATABASE_URL`을 적고 `pnpm desktop:dev`. 번들 postgres 0, `run/` 비어 있음. 상태 창에 `외부 DB(디버깅)`(사용자 확인). API의 회의 목록 12건(Docker DB). Docker `_migrations` 24 불변, `data/` 파일 1374개 체크섬 불변, `backups/` 새 파일 없음. 키 삭제 뒤 `config.json` sha가 C11 전과 같다 (`c11.txt`) |
| P3-C12 번들 위생 | **충족** | `57c08bd`, `aa537d1`, `0f97171` | 20줄 전부 PASS(Phase 2 13 + PG 7줄, §6.9 항목 5는 기존 저장소 경로 grep이 덮는다). 변이 — `psql`의 `libpq` 의존을 중립 prefix로 되돌림 → deps·`env -i psql` FAIL, `pg_bigm.control` 삭제 → 확장 항목 FAIL, 재빌드 뒤 전부 PASS(Task 13) (`c12-desktop-build.log`) |
| P3-C13 회귀 없음 | **충족 (비고)** | `0f97171` | 루트 `pnpm install`·`build`·`lint` 통과, `pnpm build`가 PG를 빌드하지 않고 `.app`을 바꾸지 않았다. `pnpm test`: desktop 675/675, fe 578/578, be 474/475 — 실패 1건은 `meetings.e2e-spec`의 `socket hang up`이며 그 파일만 3회 재실행해 41/41씩 통과했다(이 브랜치의 be 변경은 `migrate.ts`뿐). `pnpm worker:test` 526 통과. `docker build -f deploy/api.Dockerfile .` 성공. `pnpm dev` 웹 흐름(목록·전사·검색) 사용자 확인, Electron 안 뜸. `pnpm desktop:dev`가 packaged가 만든 클러스터를 dev 바이너리로 열어 네 서비스 `ok` (`c13*.txt`) |
| P3-C14 기존 데이터 보존 | **충족 (조건)** | 전 구간 | `be/storage`·userData `storage/` 체크섬 불변. `damwha_pgdata` 볼륨·`damwha-postgres` 컨테이너 생성 시각 불변. Docker DB `meeting`·`utterance`·`_migrations` = 12·4620·24로 기준선과 같다. 앱이 Docker DB에 쓴 것은 P3-C11 중 worker 기동의 `app_setting.worker_capabilities` 갱신(11:52:06Z) 한 행이다. **조건:** `config.json`은 `REPO_ROOT` 추가만 달라졌다 (`c14.txt`) |
| P3-C15 postmaster 사망 시 재시작과 회복 | **충족 (비고)** | `aa537d1` | postmaster `kill -9` → 감독자가 3초 백오프로 재기동, 3.5초 만에 `running/ok`, 60초 안정 뒤 예산 복원. **공유 메모리·락 때문에 재기동이 거절된 적은 없다** — crash recovery(redo)가 0.08초에 끝났다. api·worker는 재시작 없이 `ok`, 데이터 유지. **비고:** 끊긴 시간(3.5초)이 api 헬스 확인 간격보다 짧아 api의 `degraded` 경유는 관찰되지 않았다 (`c15.txt`) |

**추가 측정 — packaged 마이그레이션 상태 줄 유실.** 최종 리뷰가 "utilityProcess는 `'exit'` 직후 stdout을 끊어 마지막
상태 줄을 잃을 수 있다"고 지적해, 정상 종료 → 콜드 기동을 10회 반복했다. 10회 모두 12~15초 안에 네 서비스가 준비됐고
`마이그레이션 상태를 확인하지 못했어요`는 0회였다 (`cold-launches.txt`).

### 4.2 검증이 잡은 결함

**실패 화면이 10초마다 다시 로드됐다 (`0f97171`).** P3-C8 거부 화면을 본 사용자가 "깜빡이는 걸 보니 재시도하는 것
같다"고 했다. 로그상 기동 실패는 1회뿐이고 러너 프로세스도 없었다. 원인은 감독자가 바뀐 것이 없어도 헬스 확인마다
상태를 내보내고, `main.ts`가 그때마다 `showStatus` → `win.loadFile(status.html, query)`로 페이지를 **다시 로드**하는
것이었다. Phase 2부터 있던 경로이지만 Phase 2의 compose 헬스 간격은 30초였고, 이 Phase의 postgres는 10초라 세 배
자주 보인다. 같은 파일·같은 쿼리면 다시 로드하지 않는 순수 판정(`shell-url.ts`)을 두고, 확신이 없으면 로드한다.
리뷰 뒤 같은 조건(격리 절차 안의 999 행)으로 30초 넘게 봐 깜빡임이 사라진 것을 사용자가 확인했다.

### 4.3 비고

- **dev와 packaged가 한 클러스터를 쓴다는 설계 가정이 실측됐다.** packaged가 만든 클러스터를 `pnpm desktop:dev`가
  `desktop/build/postgres` 바이너리로 열어 정상 동작했다(P3-C13).
- **Task 3의 C 로캘 판정이 실사용에서도 성립했다.** `--locale=C` 클러스터에서 한글 고유명사 키워드 검색이 발화를
  찾았다(P3-C1). 정렬 순서가 Docker 이미지와 다르다는 사전 실측(§2.4)은 제품이 그 순서에 기대는 곳이 없어 영향이
  없었다.
- **검증 중 남은 백업.** P3-C6·C7이 만든 덤프 2개(`…-before-900_p3_probe.sql.dump`, `…-before-901_p3_broken.sql.dump`)가
  실제 userData `backups/`에 남아 있다. 앱의 보관 규칙(최근 5개)에 맡긴다.

## 5. 남은 제약과 후속 Phase 인계

### 5.1 구현 값과 근거

| 값 | 어디 | 근거 |
| --- | --- | --- |
| 준비 유예 180초 | `PG_READY_TIMEOUT_MS` | crash recovery 포함 상한. 실측 기동 약 0.5초, P3-C15의 crash recovery(redo) 0.08초 |
| 헬스 간격 10초 | `PG_HEALTH_INTERVAL_MS` | `postmaster.pid` 파일 읽기라 값싸다 |
| fast 30초 → immediate 10초 | `PG_FAST_GRACE_MS`·`PG_IMMEDIATE_GRACE_MS` | 클라이언트가 없는 시점의 종료. 실측 fast 종료 4~6ms |
| 도구 deadline | `PG_TOOL_DEADLINES` initdb 120s · controldata 10s · psql 15s · createdb 30s | 실측의 수십 배 |
| 마이그레이션 상태 조회 60초, `pg_restore --list` 60초, `pg_dump`는 deadline 없음 | `migration-gate.ts` | 덤프는 데이터 크기에 비례해 종료 신호로만 끊는다 |
| 백업 보관 5개 | `KEEP_BACKUPS` | 스펙 §6.5-3 |
| 재시작 `[3s, 8s, 20s]` 3회 | `pg-service.ts` | 스펙 §6.4. P3-C15에서 1회차로 회복 |

### 5.2 이번 검증에서 드러났지만 고치지 않은 것

1. **packaged 마이그레이션 상태 줄 유실 가능성.** 10회 측정에서 0회였지만 원리상 남는다. 실패하면 manual로 멈추고
   (fail-closed) 사용자는 "다시 시도"를 누른다. 관찰되면 `migrate.ts --status-file <경로>`로 파일을 통해 받는 설계가
   대안이다.
2. **앱 main이 강제 종료되면 worker 트리가 고아로 남고 새 실행이 정리하지 않는다 (Phase 2 동작).** P3-C3에서 옛 worker와
   새 worker가 함께 돌았다. 고아 embed는 한 번은 채택됐지만, 그 뒤 실행에서는 채택되지 않고 새 embed가 따로 떠 둘이 모델
   메모리를 썼다. 채택한 embed는 앱이 소유하지 않아 종료 뒤에도 남는다. 검증자가 SIGTERM으로 정리했다. job 테이블 잠금이
   중복 처리를 막지만, worker의 고아 처분은 Phase 6의 job lease token과 함께 다룰 일이다.
3. **준비 판정(판정표 2) 거부는 `supervisor.log`에 사유가 남지 않는다.** 기동 실패는 `기동 실패 — …`로 남는데, 준비
   판정 실패는 상태 줄(`postgres=failed`)만 남아 사유는 화면에서만 보인다.
4. **게이트 실패 화면의 `로그:` 경로가 `api.log`다.** 러너 출력 전체는 `supervisor.log`에 있고 안내 문구가 그렇게
   말하지만, 경로 줄은 그 로그를 가리키지 않는다.
5. **`be` 빌드가 마이그레이션을 두 번 복사한다 (기존 동작).** `nest build`의 assets가 `dist/database/migrations`를 채운
   뒤 `cp -r`이 그 안에 `migrations/`를 한 겹 더 만든다. `deleteOutDir`가 매 빌드 지워 파일 삭제는 반영되고,
   `migrate.ts`는 `.sql`로 끝나는 항목만 읽어(`migrate.ts:19`) 동작에는 영향이 없다.
6. **be e2e 테스트 1건의 간헐 실패.** `meetings.e2e-spec`의 reprocess 테스트가 전체 실행 부하에서 `socket hang up`을
   한 번 냈다.

### 5.3 최종 리뷰·per-Task 리뷰에서 남긴 것

- **dev 마이그레이션 러너는 중단 신호로 손자까지 끝나지 않는다.** 실행기가 `pnpm`만 끝내고 `ts-node` 손자는 남으며
  `'close'`를 기다린다 — dev에서 긴 마이그레이션 중 ⌘Q가 실행 끝까지 늦어진다. advisory lock이 겹친 러너를 막아 데이터는
  안전하다. packaged 러너(utilityProcess)는 해당 없다.
- **postgres `stop()`은 감독자의 짧은 정리 유예를 무시한다.** 준비 전 postmaster 정리도 fast 30초 + immediate 10초를
  쓴다 — 최악의 ⌘Q 지연 40초. 스펙 §6.4가 "같은 함수"를 요구한 결과다.
- **psql exit 2를 전부 "아직 접속 불가"로 본다.** 영구 접속 실패(역할 없음 등)도 180초 준비 유예를 다 쓰고 auto로
  재시도된다. 앱이 만든 클러스터에서는 거의 생기지 않는 조건이고 백업·마이그레이션에는 닿지 않는다.
- **`readiness()` 본문 전체가 부류 래퍼로 감싸이지 않았다** (스펙 §6.7:589). 래퍼 밖의 줄은 실사용에서 던지지 않는다.
- **준비 전에 죽은 서버의 화면 사유에 `logs/postgres/`의 마지막 오류 줄이 없다.** 감독자가 `alive()`를 먼저 봐 자기
  종료 사유를 쓰고, 안내가 `logs/postgres/` 폴더를 가리킨다.
- **상태 창 postgres 줄의 로그 경로는 `logs/postgres.log`(초기 stderr)다.** 스펙 §6.7은 `logs/postgres/`를 적었다.
  폴더는 같은 줄의 안내(`서버 로그: …/logs/postgres/`)로 보인다.
- **`configWarning`은 "다시 시도"의 설정 재적용에서 갱신되지 않는다.** `config.json`을 고친 뒤에도 앱을 다시 켤 때까지
  옛 경고가 남는다.
- **실패 화면 재로드 제거로, 렌더러가 멈췄을 때 주기적 재로드가 우연히 해 주던 복구가 사라졌다.** 지금 코드에는 렌더러
  크래시 처리가 없어 회귀는 아니다.
- 경미: `debugCommand`의 큰따옴표가 경로 속 `$`·`` ` ``·`"`를 막지 않는다. `check-bundle.mjs`의 `file -b` 실행 실패 시
  예외, PG 트리가 통째로 없을 때 두 줄이 빈 목록으로 PASS(다른 세 줄이 FAIL). `readStorageFacts`가 읽기 실패한 마커를
  "마커 없음"으로 합친다(둘 다 거부).

### 5.4 후속 Phase 인계 (스펙 §15를 실제 결과로 갱신)

- **Phase 4**
  - Phase 2가 넘긴 것 그대로(`FFMPEG_BIN`/`FFPROBE_BIN`, `UV_BIN` 재시도 반영).
  - 번들 바이너리를 `PATH` 탐색이 아니라 앱이 아는 경로로 부르는 이 Phase의 방식(`pgBinaries`)을 worker·embed·ffmpeg에
    적용할지 결정한다.
  - §5.2-2의 강제 종료 뒤 고아 worker·embed 처분 — worker·embed를 번들하며 소유 판정을 다시 짠다.
- **Phase 5**
  - Docker DB → 내장 클러스터 이전. 대상 스토리지는 `<userData>/storage`(Phase 1·2 앱 업로드)와 `be/storage`(웹 흐름)이며
    둘 다 Docker DB와 짝이다. 이전 뒤 마커를 새 `clusterId`·`databaseOid`로 적는다.
  - 이 Phase가 거부만 하는 짝 불일치를 사람이 짝을 증명하고 마커를 고치는 도구.
  - 백업 복원 절차와 그 검증(이 Phase는 만들고 목차를 읽는 것까지).
  - 강제 종료·잠자기·디스크 부족 중 PG 동작. 이번 검증은 postmaster·앱 `kill -9`까지만 했다.
- **Phase 6**
  - PostgreSQL 메이저 업그레이드(`pg_upgrade`) — 이 Phase는 거부만 한다(P3-C10).
  - 업데이트 전 백업 정책의 일반화 — 이 Phase의 마이그레이션 전 백업이 첫 조각이다.
  - 소스 아카이브 서명 검증과 재현 가능 빌드, `Resources/postgres`의 Developer ID 서명·hardened runtime.
  - Phase 2가 넘긴 job lease token, `enableCors`·API 인증.
  - §5.2-1 상태 줄 유실이 관찰되면 `--status-file`.
