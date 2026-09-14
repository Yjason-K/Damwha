# Electron Phase 3 — PostgreSQL 내장 설계

작성일: 2026-09-14
브랜치: `feat/electron-migration-phase-3-embedded-postgres`
분기점: `dev` (`ff56a36`, PR #22 병합)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 3. PostgreSQL 내장"
선행 Phase 결과: [Phase 2 결과](../reports/2026-09-12-electron-phase-2-service-orchestration-results.md),
[Phase 0 결과](../reports/2026-09-09-electron-phase-0-packaging-validation-results.md)
선행 Phase 스펙: [Phase 2 설계](2026-09-12-electron-phase-2-service-orchestration-design.md)

**상태: 스펙 작성 중. 구현 미착수.** 완료 기준의 판정 값은 계획 실행 단계에서 증거와 함께 채운다.

## 1. 이 Phase가 만드는 것

Docker 없이 담화를 쓴다. 앱이 자기 PostgreSQL 클러스터를 **만들고, 띄우고, 스키마를 올리고, 내린다.**

Phase 2는 `docker compose up -d`를 부르고 컨테이너를 건드리지 않았다. 이 Phase는 그 자리를
번들 PostgreSQL로 바꾸면서, 앱이 처음으로 **사용자 데이터를 담는 저장소의 소유자**가 된다. 소유가
바뀌면 새로 져야 하는 책임이 셋 생긴다 — 이 Phase의 무게 중심은 기동이 아니라 이 셋이다.

1. **데이터 쌍의 무결성** — DB 행과 스토리지 파일은 한 쌍이다. 새 DB의 id 시퀀스가 옛 스토리지의
   파일을 덮어쓰지 않게 한다(§6.2).
2. **스키마 변경의 안전** — 마이그레이션을 실행하는 주체가 사람에서 앱으로 옮겨 온다. 적용 전
   백업, 실패 시 멈춤, 옛 앱이 새 스키마를 여는 것의 거부(§6.5).
3. **프로세스 수명의 소유** — 컨테이너는 Docker가 재시작했지만, 이제 postmaster의 기동·재시작·
   고아·종료를 앱이 진다(§6.4).

이 Phase가 세우는 계약:

1. **데이터 배치·모드 계약** — 내장 모드와 외부 디버그 모드, 그리고 각 모드의 DB·스토리지 쌍.
2. **페어링 계약** — 클러스터와 스토리지가 같은 쌍임을 기동마다 증명한다.
3. **클러스터 수명주기 계약** — `initdb`·기동·준비·재시작·고아·종료.
4. **마이그레이션 실행 게이트 계약** — 상태 조회·백업·실행·안전망, 그리고 자동 재시도를 막는 복구 부류.
5. **번들 계약** — 소스 빌드·재배치 수정·서명·위생 검사.

Phase 2의 서비스 실행 계약(`ServiceSpec`)은 **두 곳만 넓힌다** — 실패에 복구 부류를 싣는 것(§6.7)과
기동 중단 신호(§6.4 "기동 중단")다. 둘 다 Phase 2 어댑터의 동작을 바꾸지 않는 추가다.

## 2. 선행 Phase에서 인계받는 것

| 출처 | 인계 항목 | 이 스펙에서 |
| --- | --- | --- |
| Phase 2 §15 | `postgres` 어댑터의 `launch()`를 번들로 바꾸고 `initdb`·마이그레이션 실행을 넣는다. 감지 게이트를 실행 게이트로 승격 | §6.4·§6.5. **두 가지를 다르게 한다** — 번들 `pg_ctl`이 아니라 `postgres -D` 직접 기동(Phase 0 규칙 2b), 마이그레이션 실행은 postgres 어댑터가 아니라 api 어댑터의 기동 전 단계(§6.5 첫머리의 근거) |
| Phase 2 결과 §5.2-1 | 게이트 실패 뒤 창이 상한 없이 20초마다 자동 재시도 | §6.7의 복구 부류 `manual`. 실행 게이트가 생기면 이 루프는 마이그레이션·백업을 20초마다 반복하게 되므로 **반드시** 같이 고친다 |
| Phase 0 결과 "Phase 3" | 제공 방식은 소스 빌드(PG 16.15 + pgvector 0.8.6 + pg_bigm 1.2-20240606, ICU·readline·zlib off) | §6.8 |
| Phase 0 R-2b | 재빌드마다 `install_name` 37건 수정 + ad-hoc 재서명. **서버는 살고 클라이언트만 죽는** 형태 | §6.8 빌드 조작, §6.9 `env -i psql --version` 검사 |
| Phase 0 | 확장은 `-fmacro-prefix-map`, pgvector `OPTFLAGS=""` | §6.8 |
| Phase 0 | `--auth=trust`는 실험 전용 | §6.3 — 이 스펙은 trust를 **Unix 소켓 한정**으로 쓰고 그 근거를 적는다. TCP는 열지 않는다 |
| Phase 0 | `pg_ctl start` 금지 — 내부 `/bin/sh` 경유로 서버 stderr가 합쳐진다 | §6.4 기동 3단계 |
| Phase 0 | 재배치된 데이터 디렉터리에서 crash recovery 동작 확인 | P3-C3·P3-C15의 전제 |
| Phase 0 → Phase 5 | "postmaster만 죽이면 공유 메모리를 붙들어 다음 기동이 거절된다"는 **미실측 주장** | P3-C15가 한 번 잰다. 결과가 어느 쪽이든 결과 문서에 적는다 |

Phase 2가 만든 기구 중 **그대로 재사용**하는 것: `ServiceSpec`·감독자(`supervisor.ts`)·위상 정렬과
게이트·재시작 정책·역순 종료, `makeSink`와 로그 경로, 상태 창과 원인 카탈로그(`causes.ts`·
`shell-hints.ts`), `loadConfig`와 `refreshEnv`, 단일 인스턴스 락, Phase 2의 stdout 마이그레이션 감지
게이트(`services/api.ts`의 `judgeAfterProbe`).

## 3. 현재 시스템에서 이 Phase가 건드리는 지점

| 지점 | 현재 상태 | Phase 3에서 |
| --- | --- | --- |
| `desktop/src/services/postgres.ts` | `docker compose up -d`·`ps -a --format json`. `stop()`은 무동작, 재시작 `never` | 내장 클러스터 어댑터로 교체. 외부 디버그 모드용 spec을 따로 둔다 |
| `desktop/src/services/api.ts` | 스폰 뒤 stdout에서 미적용 마이그레이션을 감지해 `failed` | 스폰 **전** 실행 게이트(내장 모드). 감지 게이트는 안전망으로 유지 |
| `desktop/src/config.ts` | `defaultConfig`가 `DATABASE_URL`(Docker 주소)·`STORAGE_ROOT`를 첫 실행 config.json에 적는다 | 내장 모드에서 둘은 앱 소유 파생값. `DEBUG_EXTERNAL_DATABASE_URL` 추가. 옛 키 처리 §6.1 |
| `desktop/src/main.ts` | `dockerRun`, docker 실행 파일 탐색, `scheduleRetry` 무조건 자동 재시도(`:597`) | docker 경로 삭제. 자동 재시도가 복구 부류를 본다(§6.7) |
| `desktop/src/services/types.ts`·`supervisor.ts` | 실패는 `detail` 문자열뿐. `stopAll`이 진행 중인 `launch()`를 끝까지 기다린다(`supervisor.ts:512`) | 실패·상태에 `recovery` 추가, `LaunchContext.signal` 추가(§6.4·§6.7) |
| `desktop/src/config.ts`·`config-reload.ts` | 삭제된 restart-only 키는 보고하지 않는다(`config.ts:169-177`) | 모드 변경을 양방향으로 보고(§6.6) |
| `desktop/src/causes.ts`·`shell-hints.ts`·`status-view.ts`·`shell/status.html` | Docker 데몬·`DOCKER_BIN` 원인과 "Docker Desktop을 실행하세요" 화면 분기 | 삭제하고 §6.7의 원인으로 교체 |
| `desktop/src/repo-root.ts` | `be/worker/pyproject.toml`과 `be/docker-compose.yml` 둘 다 요구 | compose 요구 제거 |
| `desktop/scripts/package.mjs`·`check-bundle.mjs` | API 트리만 스테이징·검사 | PG 빌드 호출과 PG 트리 검사 추가(§6.8·§6.9) |
| `desktop/package.json`의 `start:desktop` | `compile && electron .` | 앞에 PG 빌드(캐시) |
| `be/src/database/migrate.ts` | 인자 없이 실행하면 전부 적용 | `--status` 플래그 추가(§10). 인자 없는 동작 불변 |
| `be/docker-compose.yml`·`be/docker/`·루트 `db:up`/`db:down` | 웹 흐름의 DB | **변경 없음** |
| `be/src/`(migrate.ts 제외)·`be/worker/`·`fe/`·`packages/contracts/` | — | **변경 없음** |

## 4. 범위

### 4.1 포함

- PostgreSQL 16 + pgvector + pg_bigm 소스 빌드 스크립트, 재배치 수정, 서명, 캐시, 번들 탑재.
- 데이터 배치(`<userData>/data/…`)와 모드 결정(내장 / 외부 디버그).
- 클러스터·스토리지 페어링 판정과 거부.
- `initdb`, DB 생성, 기동, 준비 판정, 주기 재확인, 재시작, 고아·낡은 락 처리, 정상 종료.
- Unix 소켓 전용 접속과 그 `DATABASE_URL` 파생.
- 마이그레이션 상태 조회·적용 전 백업·실행·실패 멈춤·`unknown` 거부.
- 자동 재시도의 복구 부류(`auto` / `manual`) — Phase 2 §5.2-1 해소.
- desktop의 Docker 경로 삭제. dev 모드도 내장 PG.
- 번들 위생 검사 확장.

### 4.2 제외

| 제외 | 이유 |
| --- | --- |
| 기존 Docker DB·녹음의 이전 | 로드맵이 Phase 5에 둔다. 이 Phase는 옛 데이터를 **읽지도 쓰지도 않는다** |
| 백업 **복원** 자동화 | Phase 5 "백업·복원". 이 Phase는 백업을 만들고 읽히는지까지 확인한다. 수동 `pg_restore` 절차만 결과 문서에 남긴다 |
| PostgreSQL 메이저 버전 업그레이드 (`pg_upgrade`) | 로드맵 공통 원칙이 스키마 마이그레이션과 구분한다. 불일치는 거부만 한다(§6.2). Phase 6 |
| 강제 종료·잠자기·디스크 부족 중 PG 동작의 검증 | Phase 5. 이 Phase는 앱 main의 비정상 종료(P3-C3)와 postmaster 사망(P3-C15)까지만 판정한다 |
| TCP 접속·GUI DB 도구 지원 | §6.3. 디버깅은 `psql -h <소켓 디렉터리>` 또는 외부 디버그 모드 |
| Python·ML·ffmpeg 내장, `REPO_ROOT` 물음 제거 | Phase 4 |
| Developer ID 서명·공증, 소스 아카이브의 서명 검증 | Phase 6. 체크섬은 커밋된 sha256 대조까지(§13 R3-11) |
| `be/docker-compose.yml`과 웹 흐름의 DB 변경 | 웹 개발 흐름은 계속 Docker를 쓴다 |

### 4.3 선행 조건

Phase 2의 선행 조건 중 **1번(Docker Desktop 실행)과 4번(마이그레이션 적용됨)이 사라진다.**

구현·검증 시점에 갖춰져 있어야 하는 것:

1. `uv`와 `be/worker` venv(`uv sync --extra models`) — Phase 4까지 유지.
2. `be/worker/.env`와 `be/.env` — Phase 2와 같다.
3. packaged 검증에는 저장소 체크아웃(`REPO_ROOT`) — Phase 2와 같다.
4. **PG 빌드 도구**: Xcode Command Line Tools(`cc`·`make`·`install_name_tool`·`codesign`·`otool`), `curl`,
   첫 빌드의 네트워크. **빌드하는 사람의 맥에만** 필요하고 앱 실행에는 필요 없다.
5. 디스크 여유 — 빌드 캐시(소스·중간 산출물, 계획 1단계에서 실측)와 번들 +21 MB.

## 5. 데이터 안전 규칙

Phase 2 §5를 잇는다. 달라지는 것과 새로 생기는 것:

- 앱은 **기존 데이터를 읽지도 쓰지도 않는다** — Docker 컨테이너 `damwha-postgres`, 볼륨
  `damwha_pgdata`, `be/storage`, 그리고 **Phase 1·2가 Docker DB와 함께 쓴 `<userData>/storage`**
  (packaged userData에 `meetings/mtg_37`이 실재한다, 2026-09-14 확인). P3-C14가 판정한다.
- 앱은 `config.json`을 **다시 쓰지 않는다.** 옛 키는 무시하고 알린다(§6.1).
- 앱이 **지우는 것은 넷뿐이다.** 넷 다 앱이 만드는 이름 형식과 앱 소유 디렉터리 안인지, 심볼릭 링크가
  아닌지(`lstat`)를 확인한 뒤 지우고, 지운 경로를 `supervisor.log`에 적는다.
  1. 자기가 만든 `initdb` 임시 디렉터리(`data/postgres.initdb-*`).
  2. **낡았음을 증명한** 락 파일(`postmaster.pid`, 소켓 `.lock`) — §6.4의 판정을 통과한 경우만.
  3. 새 백업이 **검증까지 성공한 뒤** 보관 상한(5개)을 넘은 가장 오래된 백업.
  4. 이전 백업 시도가 남긴 `backups/*.dump.partial` — 검증을 통과하지 못해 백업으로 인정되지 않은 파일.
- **거부 경로는 아무것도 지우거나 만들지 않는다.** 페어링 거부·버전 불일치·`unknown` 마이그레이션·
  고아 확인 불가는 원인과 경로를 보여주고 멈춘다.
- 마이그레이션은 **앱이 소유한 내장 클러스터에만** 실행한다. 외부 디버그 모드는 절대 실행하지 않는다(P3-C11).
- **데이터가 있는 DB에 마이그레이션을 적용하기 전에 검증된 백업이 있어야 한다.** 백업이 실패하면 적용하지 않는다(P3-C6).
- 앱은 postmaster에 `SIGKILL`을 보내지 않는다(§6.4 종료).
- `.app` 번들 안에는 쓰지 않는다. 클러스터는 번들 밖이다.

## 6. 구성요소와 계약

### 6.1 데이터 배치와 모드

#### 배치

`<userData>`는 packaged에서 `~/Library/Application Support/Damwha`, dev에서
`~/Library/Application Support/damwha-desktop`이다(Phase 1 결과가 확인한 `productName`/`name` 차이).
**두 모드의 클러스터는 서로 다르다** — dev에서 무엇을 해도 packaged 데이터에 닿지 않는다.

```
<userData>/
  data/                     ← 내장 모드의 "한 쌍". 같이 생기고 같이 검증된다
    postgres/               PGDATA (0700)
    storage/                STORAGE_ROOT
      .damwha-cluster       이 스토리지의 짝 — 클러스터 id와 damwha 데이터베이스 oid (§6.2)
  run/                      소켓 디렉터리 (0700) — .s.PGSQL.5432, .s.PGSQL.5432.lock
  backups/                  마이그레이션 전 pg_dump
  logs/
    postgres/               PG가 직접 쓰는 로그 (logging_collector)
    supervisor.log · api.log · worker.log · embed.log   (Phase 2)
  storage/                  Phase 1·2가 Docker DB와 쓴 스토리지 — 읽지도 쓰지도 않는다 (Phase 5)
  config.json
```

`data/`·`run/`·`backups/`는 0700으로 만든다.

#### 모드

| | 내장 모드 (기본) | 외부 디버그 모드 |
| --- | --- | --- |
| 조건 | `config.json`에 `DEBUG_EXTERNAL_DATABASE_URL`이 **없다** | 그 키가 있다 |
| postgres 서비스 | 번들 클러스터를 띄운다 (§6.4) | 아무것도 띄우지 않는다. 상태는 `외부 DB(디버깅)` |
| `DATABASE_URL` | 앱이 파생 (§6.3) | 그 키의 값 |
| `STORAGE_ROOT` | `<userData>/data/storage` 고정 | `config.json`의 `STORAGE_ROOT`, 없으면 `<userData>/storage` |
| 마이그레이션 | 실행 게이트 (§6.5) | Phase 2 감지 게이트 그대로 — 실행하지 않는다 |
| 페어링 판정 | 한다 (§6.2) | 하지 않는다 |
| 화면 | — | 상태 창과 상태줄에 **상시** 배지 |

외부 디버그 모드는 **제품 경로가 아니다.** 이름에 `DEBUG_`를 넣은 이유는 첫 실행의 config.json이
그 키를 광고하지 않고, 사람이 명시적으로 적어야만 켜지게 하려는 것이다. dev에서 Docker DB에 붙어
재현하는 용도로 남긴다.

모드는 **감독자를 만들 때 한 번** 정한다. 실행 중에 키를 바꾸면 Phase 2의 `refreshEnv`가
`needsRestart`로 보고한다("앱을 다시 켜야 반영됩니다") — 살아 있는 클러스터 옆에서 모드를 바꾸는
경로를 만들지 않는다.

#### 옛 키

Phase 1·2의 `defaultConfig`는 첫 실행에 `DATABASE_URL`(`postgres://postgres:postgres@localhost:5432/damwha`)과
`STORAGE_ROOT`(`<userData>/storage`)를 **config.json에 적었다.** 이 맥의 packaged·dev config.json 둘 다 그
상태다. 그 값이 사람이 고른 것인지 옛 기본값인지는 파일만으로 구별되지 않는다.

- 내장 모드에서 두 키는 **무시한다.**
- 값이 옛 기본값과 **문자 그대로 같으면** `supervisor.log`에 한 줄만 남긴다. 사람이 고른 적 없는 값을
  경고로 띄우면 매 실행 사용자에게 할 일 없는 안내가 뜬다.
- 다르면 상태 창에 경고한다 — "내장 DB 모드에서는 `DATABASE_URL`·`STORAGE_ROOT`를 쓰지 않습니다.
  외부 DB는 `DEBUG_EXTERNAL_DATABASE_URL`".
- `DOCKER_BIN`은 무시하고 로그 한 줄.
- 첫 실행의 새 config.json에는 `DATABASE_URL`·`STORAGE_ROOT`를 **적지 않는다.**

### 6.2 페어링 계약

**왜 필요한가.** 스토리지 키는 `meetings/<meeting.id>/…`이고(`be/src/storage/storage.service.ts:22,26,32`)
`meeting.id`는 `'mtg_' || nextval('mtg_id_seq')`다(`001_init.sql:33-36`). 새 클러스터는 시퀀스가 1부터
시작한다. 다른 DB의 행이 만든 파일이 있는 스토리지를 새 클러스터와 짝지으면, 새 DB가 그 번호에
도달하는 순간 `original.<ext>`를 **덮어쓰거나**, worker가 남의 파일을 자기 회의의 오디오로 읽는다. 이
저장소는 같은 부류의 사고를 이미 겪었다(`restore.sh`가 `be/storage`의 원본을 데모 오디오로 바꾼 일).

**짝의 신원은 두 층이다.** 클러스터만 같아서는 부족하다 — 같은 클러스터 안에서 `damwha` 데이터베이스가
지워지고(디버깅 중 `psql`로 `DROP DATABASE` 등) 다시 만들어지면 시퀀스가 1로 돌아간다. 그래서 마커는
**클러스터**와 **데이터베이스** 둘을 적는다(2026-09-14 외부 리뷰 #1).

**마커.** `data/storage/.damwha-cluster`, JSON 한 객체. 임시 파일에 쓰고 `rename`한다.

```json
{"clusterId": "7412345678901234567", "databaseOid": 16384}
```

- `clusterId` — 번들 `pg_controldata -D <PGDATA>`의 `Database system identifier`. 서버를 띄우지 않고 읽히므로
  판정이 기동보다 먼저 온다. `initdb`마다 새 값이다. `pg_controldata`는 `LC_ALL=C`로 부른다 — 번들은 NLS 없이
  빌드되지만, 라벨을 파싱하는 모든 PG 도구 호출에 로캘을 고정해 빌드 옵션에 판정이 기대지 않게 한다.
- `databaseOid` — `SELECT oid FROM pg_database WHERE datname = 'damwha'`. 데이터베이스를 지우고 다시 만들면
  새 oid가 된다. 데이터베이스를 만들기 전에는 `null`.

**"비어 있다"의 정의.** 스토리지 디렉터리가 없거나, 마커와 `.DS_Store` 말고는 항목이 없다.

**마커는 `initdb`가 끝난 임시 디렉터리를 `data/postgres`로 옮기기 전에 쓴다**(§6.4 기동 3단계). 그러면
"`data/postgres`가 있는데 마커가 없다"는 **앱이 만든 클러스터에서는 생길 수 없는 상태**가 되고, 그 상태는
언제나 거부할 수 있다. 초안은 이 경우를 "initdb 뒤 마커 전 중단"으로 보고 마커를 새로 적었는데, 그러면
누가 가져다 놓았는지 모르는 PGDATA에 앱이 마이그레이션을 실행한다.

**판정표 1 — 클러스터** (기동마다, 서버를 띄우기 전)

| PGDATA | 스토리지(마커 외) | 마커 | 동작 |
| --- | --- | --- | --- |
| 없음 | 비어 있음 | 무관 | `initdb` → 마커 `{clusterId, databaseOid: null}` → rename (§6.4) |
| 없음 | 비어 있지 않음 | 무관 | **거부** |
| 있음 | 무관 | 없음 | **거부** |
| 있음 | 무관 | `clusterId` 불일치 | **거부** |
| 있음 | 무관 | `clusterId` 일치 | 기동 → 판정표 2 |
| `PG_VERSION` ≠ 번들 메이저(`16`) | — | — | **거부** (메이저 업그레이드는 Phase 6) |
| `pg_controldata` 실패 | — | — | **거부** (클러스터를 읽을 수 없다) |

"없음 + 비어 있음"의 마커가 무관인 이유: 마커를 쓴 뒤 rename 전에 중단됐거나, 스토리지가 비어 있어 덮어쓸
파일이 없다. 새 `initdb`가 마커를 새 값으로 덮어쓴다.

**판정표 2 — 데이터베이스** (서버가 물리적으로 준비된 뒤, 게이트를 열기 전 — §6.4 준비 판정)

| `damwha` DB | 마커 `databaseOid` | 스토리지(마커 외) | 동작 |
| --- | --- | --- | --- |
| 없음 | `null` | 비어 있음 | `createdb` → oid 기록 |
| 없음 | `null` | 비어 있지 않음 | **거부** |
| 없음 | 값 있음 | 무관 | **거부** — 데이터베이스가 지워졌다 |
| 있음 | `null` | 비어 있음 | oid 기록 (`createdb` 뒤 기록 전 중단) |
| 있음 | `null` | 비어 있지 않음 | **거부** |
| 있음 | 일치 | 무관 | 통과 |
| 있음 | 불일치 | 무관 | **거부** — 다시 만든 데이터베이스다 |

거부는 원인·두 경로·"폴더나 데이터베이스를 옮기거나 지우지 않았는지 확인하세요"를 보여주고 아무것도
바꾸지 않는다. 복구 부류는 `manual`이다(§6.7). 거부 뒤 되살리는 방법(마커를 고치는 등)은 안내하지 않는다 —
그것은 짝이 맞다는 것을 사람이 증명하는 일이고, Phase 5의 이전 도구가 할 일이다.

### 6.3 접속 계약

**Unix 소켓만 연다.** 기동 인자:

```
listen_addresses = ''
unix_socket_directories = '<userData>/run'
unix_socket_permissions = 0700
port = 5432                  # 소켓 파일 이름(.s.PGSQL.5432)에만 쓰인다
```

- **TCP 리스너가 없으므로** Docker의 5432, Homebrew PostgreSQL, 다른 앱의 내장 PG와 포트가 부딪힐
  수 없다. 로드맵 범위의 "기존 PostgreSQL 인스턴스와의 충돌 방지"를 포트 탐색이 아니라 구조로 푼다.
  P3-C4가 판정한다.
- **인증은 `local` trust, `host` reject.** `initdb --auth-local=trust --auth-host=reject`. Phase 0이 "trust는
  실험 전용"이라 한 것은 TCP까지 열린 상태의 이야기다. 소켓에 닿을 수 있는 주체는 0700 디렉터리를
  통과할 수 있는 주체, 즉 **데이터 파일을 직접 읽을 수 있는 같은 macOS 사용자**뿐이다. 비밀번호는
  그 경계에 아무것도 더하지 않고 분실·보관 문제만 만든다.
- 슈퍼유저 이름은 `damwha`(`initdb -U damwha`). 마이그레이션의 `CREATE EXTENSION vector`·`pg_bigm`이
  슈퍼유저를 요구한다(둘 다 trusted extension이 아니다). 데이터베이스 이름은 `damwha` — Phase 5의
  덤프·복원이 Docker DB와 같은 이름을 쓰게 한다.

**`DATABASE_URL` 파생.**

```
postgresql://damwha@/damwha?host=<run 디렉터리의 percent-encoding>
```

`Application Support`에 공백이 있다. 이 문자열을 받는 소비자는 넷이고 **넷 다 받는지 계획 1단계에서
실측한다**: API(node-pg의 `pg-connection-string`), worker(psycopg 3 / libpq URI), `migrate.js`(node-pg),
번들 `pg_dump`·`createdb`·`psql`(libpq, `-h` 인자로 넘기면 인코딩이 필요 없다). 받지 못하는 소비자가
있으면 그 소비자에만 키-값 형식(`host=… dbname=… user=…`)을 주는 파생으로 바꾸고 결과 문서에 적는다.

**소켓 경로 길이.** macOS `sun_path`는 104바이트라 소켓 경로는 103바이트 이하여야 한다. 이 맥에서
packaged `…/Damwha/run/.s.PGSQL.5432`는 72바이트, dev는 80바이트다. 기동 전에 계산해 넘으면 원인과
바이트 수를 보여주고 거부한다(`manual`). 대체 디렉터리로 폴백하지 않는다 — `/tmp` 류는 다른
사용자와 공유되는 자리라 0700 경계가 무너진다.

**디버깅 접속.** 상태 창의 postgres 행에 `psql -h "<run>" -U damwha damwha`를 표시한다. 번들 `psql`의
경로도 함께 적는다(Homebrew `psql`이 없는 맥).

### 6.4 클러스터 수명주기 계약

`postgres` 어댑터의 `detectExternal`·`launch`·`readiness`·`stop`·`restart`를 바꾼다. `ServiceSpec`에는 §1이
적은 두 추가(`recovery`, `LaunchContext.signal`)만 있다. `specs.ts`의 선언 순서(`postgres → api → embed →
worker`)가 이미 postgres를 **맨 먼저 기동, 맨 나중에 종료**로 만든다(`supervisor.ts` `stopAll`의 `reverse()`).

| 필드 | Phase 2 | Phase 3 내장 모드 |
| --- | --- | --- |
| `gate` | `true` | `true` |
| `detectExternal` | compose 컨테이너가 healthy면 `adopt` | 항상 `absent`. 이전 실행의 고아는 외부가 아니라 `launch()`가 처리한다 |
| `launch` | `compose up -d`, 핸들 `null` | 아래 1~4, 핸들은 **postgres 전용 핸들**(아래 "핸들") |
| `readiness` | compose `Health` | `postmaster.pid` 상태 + 판정표 2 (아래) |
| `readyTimeoutMs` | 기본 60초 | 더 길게 — crash recovery 시간. 값은 계획에서 |
| `healthIntervalMs` | 30초 | 10초 (파일 읽기라 값싸다) |
| `stop` | 무동작 | fast → immediate (아래) |
| `restart` | `never` | `[3s, 8s, 20s]` 3회 |

#### 기동 (`launch`)

1. **사전 판정** — 소켓 경로 길이(§6.3), 페어링(§6.2). 거부면 던진다.
2. **고아·낡은 락 판정** — `PGDATA/postmaster.pid`가 있으면 첫 줄의 pid를 `ps`로 확인한다.
   - 살아 있고 명령이 **번들 `postgres`이며 `-D <우리 PGDATA>`를 가진다** → 이전 실행이 남긴 고아다.
     단일 인스턴스 락이 있으므로 다른 앱 인스턴스일 수 없다. **채택하지 않고** SIGINT(fast)로 내리고
     종료를 기다린 뒤 새로 띄운다. 채택하지 않는 이유: 앱 업데이트 뒤라면 그 postmaster는 옛
     바이너리이고, 채택하면 버전이 어긋난 서버가 조용히 계속 돈다. 그 대가는 크래시 뒤 한 번의
     몇 초다.
   - 살아 있는데 그 명령이 아니다 → pid가 재사용된 **낡은 락**이다. PostgreSQL 자신은 이 경우 기동을
     거부한다("lock file already exists"). 그 명령이 postgres가 아님을 확인했으므로
     `postmaster.pid`와 소켓 락을 지운다(§5의 두 번째 삭제).
   - 죽어 있다 → PostgreSQL이 스스로 낡은 락을 처리한다. 앱은 지우지 않는다.
   - `ps`가 실패하거나 명령을 읽지 못한다 → **증명할 수 없다.** 지우지 않고 거부한다(`manual`).
   - 고아가 fast 종료 유예 안에 끝나지 않으면 SIGQUIT, 그래도 남으면 거부(`manual`, pid 표시).
3. **`initdb`가 필요하면**(§6.2 판정표 1 첫 행) 순서가 계약이다.
   1. 이전 실행이 남긴 `data/postgres.initdb-*`를 지운다(앱이 만든 것, §5).
   2. `data/postgres.initdb-<난수>`에 `initdb -D <tmp> -U damwha --encoding=UTF8 --locale=C
      --auth-local=trust --auth-host=reject`.
   3. `LC_ALL=C pg_controldata -D <tmp>`로 `clusterId`를 읽어 마커 `{clusterId, databaseOid: null}`을 쓴다.
   4. `<tmp>`를 `data/postgres`로 `rename`한다.

   어느 단계에서 중단돼도 다음 실행은 판정표 1의 첫 행으로 돌아온다. 반쯤 만든 클러스터를 정상 PGDATA로
   오인하지 않고, 마커 없는 PGDATA는 앱이 만든 것이 아니다(§6.2).
4. **서버를 직접 스폰**한다 — `<번들>/bin/postgres -D <PGDATA> -c listen_addresses= -c
   unix_socket_directories=<run> -c unix_socket_permissions=0700 -c logging_collector=on -c
   log_directory=<userData>/logs/postgres …`. `pg_ctl start`를 쓰지 않는다(Phase 0 규칙 2b: 내부의
   `/bin/sh -c "exec postgres … 2>&1 &"`가 서버 stderr를 stdout에 합친다). 자기 프로세스 그룹으로
   띄운다(Phase 2의 api·worker·embed와 같다). 앱이 죽어도 postmaster는 살아남으며, 그것을 다음 실행의
   2단계가 처리한다.
   `logging_collector=on`인 이유: 서버 로그를 앱의 파이프가 아니라 **서버가 직접 파일에 쓰게** 해야
   앱이 죽은 뒤 고아가 된 서버의 기록이 남는다. 수집기가 뜨기 전의 초기 오류(권한·락·설정)는
   여전히 stderr로 나오므로 핸들의 `stderrTail()`이 그것을 받는다. 로그 회전 값은 계획에서 정한다.
#### 핸들

postgres는 Phase 1·2의 `launchDev`/`launchPackaged` 핸들을 **쓰지 않는다.** 그 핸들의 `stop()`은 SIGTERM
뒤 유예를 넘기면 **SIGKILL**로 올라가고(`api-process.ts:152-171`의 `escalate`), dev 런처는 프로세스 **그룹**
전체에 신호를 보낸다(`api-process.ts:280-305`). postmaster에는 둘 다 금지다(아래 "종료"). 그래서
`ServiceHandle` 모양을 따르는 postgres 전용 핸들을 둔다.

- 신호는 **postmaster pid 하나에만** 보낸다. 백엔드 자식에게는 postmaster가 전달한다.
- `stop(graceMs)`은 아래 "종료"의 SIGINT → SIGQUIT 절차와 **같은 함수**다. 어댑터 `stop`, 감독자의 기동 중 정리
  (`supervisor.ts:392`), 어느 경로로 불려도 SIGKILL과 그룹 신호가 나가지 않는다.
- stdout·stderr는 Phase 2의 `makeSink`로 `logs/postgres/stderr.log`에 쓰고 꼬리를 유지한다.
- 테스트가 "어떤 경로로도 `SIGKILL`·음수 pid 신호를 보내지 않는다"를 고정한다.

#### 준비 판정 (`readiness`)

두 층이다. **물리적 준비**는 프로세스를 스폰하지 않고 파일로 본다. PostgreSQL 10+는 `postmaster.pid`
8번째 줄에 상태를 적고(`starting` / `stopping` / `ready` / `standby`), `pg_ctl`이 기동 대기에 쓰는 신호가 바로
이것이다. **논리적 준비**는 판정표 2(§6.2)다.

| 조건 | 결과 |
| --- | --- |
| 핸들이 죽었다 | `failed` — `stderrTail()`의 원인 블록 + `logs/postgres/`의 마지막 오류 줄 |
| `postmaster.pid`의 pid ≠ 핸들 pid | `not-ready` (아직 우리 서버의 락 파일이 아니다) |
| 상태 `starting` | `not-ready`. 유예의 절반을 넘기면 detail에 "복구 중일 수 있어요" |
| 상태 `ready` + 소켓 파일 존재, **이 핸들에서 판정표 2를 아직 통과하지 않음** | 판정표 2 수행 → 통과면 `ready`, 거부면 `failed`(`manual`), 도구 실패면 `failed`(`manual`) |
| 상태 `ready` + 소켓 파일 존재, 이 핸들에서 통과함 | `ready` |
| 상태 `stopping` | `degraded` (재확인 중에만 나타난다) |

- 판정표 2를 `readiness` 안에 두는 이유(외부 리뷰 #4): 감독자는 `readiness()`가 `ready`를 내는 즉시 게이트를
  연다(`supervisor.ts:156-166`). 판정표 2를 그 뒤에 두면 api가 `damwha`가 없는 서버에 붙는다. 감독자에
  `afterReady` 훅을 더하는 대신 어댑터 안의 상태로 푼다 — 판정은 **핸들마다 한 번**이고(Phase 2의
  `createMigrationCheckWatch`와 같은 `WeakSet` 기법), 10초 재확인은 물리적 준비만 본다. 재시작으로 새 핸들이
  생기면 다시 한다.
- 판정표 2가 쓰는 도구: `psql -h <run> -U damwha -d postgres -Atc "SELECT oid FROM pg_database WHERE
  datname='damwha'"`, `createdb -h <run> -U damwha damwha`. 둘 다 `LC_ALL=C`와 deadline(아래 "기동 중단")을 갖는다.
- pid 일치를 보는 이유: 2단계에서 고아를 내린 직후나 재시작 직후에는 **이전 postmaster가 남긴 파일의
  `ready`**가 잠깐 남아 있을 수 있다.

#### 기동 중단

감독자의 준비 유예는 `launch()`가 **반환한 뒤에야** 시작하고(`supervisor.ts:381`), `stopAll`은 진행 중인 기동이
끝날 때까지 기다린다(`supervisor.ts:512`). `launch()`나 판정표 2 안의 도구가 멈추면 기동도 ⌘Q도 멈춘다(외부
리뷰 #3). 그래서:

- `LaunchContext`에 `signal: AbortSignal`을 더한다. 감독자는 `stopAll` **첫머리에서** abort한다.
- 이 Phase가 부르는 모든 외부 도구는 공용 실행기 하나를 거친다. 실행기는 **deadline**과 `signal`을 받고, 둘 중
  하나가 먼저 오면 그 자식을 SIGTERM → 짧은 유예 → SIGKILL로 끝낸다(도구 프로세스이지 postmaster가 아니다).
  deadline 값은 계획에서 정한다. 끝나지 않은 도구는 결과를 **실패**로 돌려주고, 판정은 아래 표를 따른다.

| 중단된 도구 | 남는 상태 | 다음 실행 |
| --- | --- | --- |
| `initdb` | `data/postgres.initdb-*` | 판정표 1 첫 행 — 임시 디렉터리를 지우고 다시 |
| `createdb` | DB가 있거나 없음, 마커 oid `null` | 판정표 2 — 없으면 만들고, 있고 스토리지가 비어 있으면 oid 기록 |
| `pg_dump`·`pg_restore --list` | `.dump.partial` | §6.5-3 — `.partial`을 지우고 새로 백업 |
| 마이그레이션 러너 | 실행 중이던 파일의 트랜잭션은 접속 끊김으로 롤백. 앞선 파일은 적용됨 | §6.5 처음부터 — 상태 재조회, 데이터가 있으면 새 백업 |
| 고아 postmaster 종료(2단계) | — | 중단하지 않는다. 그 절차는 fast·immediate 유예로 이미 유한하다 |

마이그레이션 러너를 끊어도 되는 근거는 파일별 트랜잭션이다(`migrate.ts:31-45`). 자동으로 다시 도는 것은
**다음 실행**이지 같은 실행의 재시도가 아니다(§6.7).

#### 재시작

앱이 소유자이므로 Phase 2의 `never`(compose의 `restart: unless-stopped`가 소유)를 `[3s, 8s, 20s]` 3회로
바꾼다. 감독자는 gate 서비스라도 한 번 `ready`에 도달한 뒤의 사망에는 재시작을 건다
(`supervisor.ts:399`). 재시작도 `launch()`를 거치므로 2단계의 고아·낡은 락 판정을 매번 한다.

api·worker는 Phase 2 §6.6·§6.8 그대로다 — DB가 사라지면 `degraded`로 버티다 돌아오면 스스로 `ok`.
**감독자가 postgres 재시작에 맞춰 api·worker를 다시 몰아주지 않는다**(의존 캐스케이드 금지 유지).
P3-C15가 판정한다.

#### 종료 (`stop`)

종료 순서상 api·worker·embed가 이미 내려가 클라이언트가 없는 시점이다.

1. `SIGINT` — fast shutdown. 새 접속을 막고, 진행 중 트랜잭션을 롤백하고, 체크포인트 뒤 끝낸다.
2. 유예(초안 30초, 계획에서 확정) 안에 끝나면 `{stopped:true}`.
3. 넘기면 `SIGQUIT` — immediate shutdown. 체크포인트 없이 끝나고 다음 기동이 crash recovery를 한다.
   커밋된 데이터는 WAL로 보존된다.
4. 짧은 유예 뒤에도 살아 있으면 `{stopped:false, leaked:[pid], detail}`.

- **사람에게 묻지 않는다.** `StopPlan.onGraceExpired`(worker의 "계속 기다리기/강제 종료")를 postgres는
  부르지 않는다. 사람이 판단할 정보(진행 중인 job)가 postgres에는 없다.
- **`SIGKILL`을 보내지 않는다.** postmaster를 `SIGKILL`하면 백엔드 자식과 공유 메모리가 남을 수 있다.
  Phase 0이 이 영향을 "미실측 주장"으로 남겼고, P3-C15가 한 번 잰다.
- 창 닫기는 종료가 아니다(Phase 2 §6.10). postgres도 계속 돈다.

### 6.5 마이그레이션 실행 게이트

**위치: `api` 어댑터 `launch()`의 스폰 전 단계.** postgres 어댑터에 두지 않는 이유 — 마이그레이션
러너와 `.sql`은 **API 트리**에 있고(`be/package.json`의 `build`가 `dist/database/migrations`로 복사,
packaged에서는 `Resources/api/dist/database/`), 그 트리의 dev/packaged 경로를 이미 아는 것이 api
어댑터다. 또 외부 디버그 모드에는 postgres 어댑터가 없는데 감지 게이트는 api에 있으므로, 실행을
postgres에 두면 모드마다 마이그레이션 경로가 두 곳으로 갈린다. 여기 두면 모드 차이가 **api 어댑터의
플래그 하나**로 좁혀진다.

API가 재시작될 때도 `launch()`를 거치므로 게이트가 다시 돈다. 한 실행 안에서 `.sql`은 바뀌지 않으므로
그때는 1단계가 `pending 0`을 내고 곧장 스폰으로 간다.

```
1. 상태 조회 ─┬─ unknown ≠ ∅ ─────────────────────→ 거부
              ├─ pending = ∅ ─────────────────────→ 5. API 스폰
              ├─ applied = 0, pending ≠ ∅ ────────→ 4. 실행 → 5
              └─ applied > 0, pending ≠ ∅ ────────→ 3. 백업 → 4. 실행 → 5
```

#### 1. 상태 조회

`migrate.ts`에 `--status`를 더한다(§10). stdout에 **한 줄 JSON**을 찍고 exit 0:

```json
{"applied": 24, "pending": ["025_x.sql"], "unknown": []}
```

- `applied` — `_migrations` 행 수. 테이블이 없으면 0.
- `pending` — 기존 `listPendingMigrations(pool)` 결과 그대로.
- `unknown` — `_migrations`에는 있는데 번들 `.sql`에 없는 이름.

판정을 desktop이 `.sql` 목록과 `_migrations`를 직접 비교해 재구현하지 않는 이유: 두 곳에서 같은 규칙을
유지하면 언젠가 갈라지고, 갈라진 결과는 "마이그레이션을 건너뛰었다" 같은 조용한 실패다. desktop에 pg
클라이언트를 넣지 않는 원칙(Phase 2 §6.7, 번들 위생 P1-C11)도 유지된다.

| | 실행 방법 |
| --- | --- |
| packaged | `utilityProcess.fork(<Resources>/api/dist/database/migrate.js, ["--status"])`, env 주입 |
| dev | `pnpm --filter damwha-be run migrate -- --status` (ts-node — `pnpm be:migrate`와 같은 경로) |

`.sql` 디렉터리가 없거나 읽히지 않으면 `--status`는 exit ≠ 0이고 게이트는 **실패**한다. Phase 2의
"검사 건너뜀"은 advisory였지만, 실행 게이트가 조용히 꺼지면 빈 스키마 위에서 화면이 뜬다(Phase 2 R2-8).

dev의 `be/` cwd에서는 dotenv가 `be/.env`를 읽지만 이미 있는 환경변수를 덮지 않는다. 앱은
`DATABASE_URL`을 **항상** 주입한다.

#### 2. `unknown` 거부

`unknown`이 비어 있지 않으면 이 DB는 **이 앱보다 새 버전의 앱이 스키마를 올린 것**이다. 옛 API 코드가
새 스키마에서 도는 것을 막는다. 복구 부류 `manual`. dev에서 브랜치를 오가면 걸리는 경우이므로
안내에 "외부 디버그 모드를 쓰거나 dev 데이터 폴더(`damwha-desktop/data`)를 정리"를 적는다. 앱은
아무것도 지우지 않는다.

#### 3. 백업

조건: `applied > 0` **그리고** `pending ≠ ∅`. 새 클러스터(`applied = 0`)는 잃을 데이터가 없어 생략한다.

1. 이전 시도가 남긴 `backups/*.dump.partial`을 지운다(§5의 네 번째 삭제).
2. 번들 `pg_dump -h <run> -U damwha -Fc -f <backups>/<UTC>-before-<첫 pending 이름>.dump.partial damwha`.
3. 번들 `pg_restore --list <파일>`이 exit 0이면 `.partial`을 뗀다. 목차를 읽을 수 있음까지를 "검증"으로
   정의한다 — 복원 리허설은 Phase 5.
4. 성공한 뒤에만 보관 상한(최근 5개)을 넘는 가장 오래된 `.dump`를 지운다.
5. 어느 단계든 실패하면(디스크 부족·deadline·중단 포함) **마이그레이션하지 않고** 멈춘다. 복구 부류 `manual`.

백업은 아래 4단계의 advisory lock **밖**에서 한다. 락은 세션 단위라 별도 프로세스인 `pg_dump`와 러너가 나눠
쥘 수 없다. 그 사이에 다른 러너가 마이그레이션을 적용해도 이 백업은 "적용 전"의 올바른 백업이고, 러너는 락을
쥔 뒤 미적용을 다시 계산하므로 같은 파일을 두 번 적용하지 않는다.

`--without-zlib` 빌드라 `-Fc` 덤프는 압축되지 않는다. 크기는 계획 1단계에서 실측한다(현재 개발 DB 기준
발화 1,463건, 임베딩 `vector(1024)`).

#### 4. 실행

인자 없는 `migrate.js`(packaged) / `pnpm --filter damwha-be run migrate`(dev). 파일별 `BEGIN`/`COMMIT`은
기존 그대로(`migrate.ts:31-45`) — 실패한 파일은 롤백되고 앞서 성공한 파일은 남는다.

**러너 전체를 한 세션의 `pg_advisory_lock`으로 감싼다**(§10, 외부 리뷰 #6). 지금의 러너는 파일마다 "조회 후
실행"만 하므로 두 러너가 겹치면 둘 다 같은 파일을 미적용으로 보고, 늦은 쪽이 `already exists`로 실패한다 —
실제로는 적용이 끝났는데 게이트는 마이그레이션 실패를 띄운다. 겹치는 경로는 실재한다: dev에서 앱 main이
죽으면 `pnpm … migrate` 자식이 살아남고 다음 실행이 러너를 또 띄운다. 락을 쥔 뒤 미적용을 다시 계산한다. 락은
웹 흐름의 `pnpm be:migrate`에도 똑같이 옳다.

실패하면:

- API·worker를 띄우지 않는다.
- stderr의 원인 블록, 백업 경로(있으면), 로그 경로를 보여준다.
- 복구 부류 `manual`. 자동 재시도로 같은 마이그레이션을 반복하지 않는다.

#### 5. 안전망

스폰 뒤 Phase 2의 stdout 감지 게이트(`judgeAfterProbe`)는 **그대로 둔다.** 실행 게이트를 통과했는데 API가
미적용을 말하면 두 트리가 어긋난 것이다(러너가 본 `.sql`과 API가 본 `.sql`이 다르다). 이때 원인 문구는
"마이그레이션을 실행한 뒤에도 미적용이 남았어요"로 Phase 2의 "`pnpm be:migrate`를 실행하세요"와 구별한다.

#### 외부 디버그 모드

1~4를 모두 끈다. 5만 남아 **Phase 2와 동일하게** 동작한다 — 감지하고 멈추고 `pnpm be:migrate`를
안내하며, 자동 재시도도 Phase 2대로 둔다(사람이 터미널에서 적용하면 클릭 없이 회복하던 경로, Phase 2
결과 §5.2-1 "참고할 점").

### 6.6 설정·env 계약

Phase 2 §6.4의 표를 잇는다. 달라지는 것만 적는다.

| 키 | 내장 모드 | 외부 디버그 모드 | 파일에 적히나 |
| --- | --- | --- | --- |
| `DEBUG_EXTERNAL_DATABASE_URL` | (없음) | 그대로 `DATABASE_URL`이 된다 | 사람이 적을 때만 |
| `DATABASE_URL` | 앱 파생(§6.3). 파일 값 무시(§6.1 옛 키) | 무시 | 첫 실행에 적지 않는다 |
| `STORAGE_ROOT` | `<userData>/data/storage` 고정. 파일 값 무시 | 파일 값 또는 `<userData>/storage` | 첫 실행에 적지 않는다 |
| `DOCKER_BIN` | 무시(로그 한 줄) | 무시 | — |
| `REPO_ROOT`·`EXTRA_PATH`·`UV_BIN`·`PORT`·`EMBED_SERVICE_PORT` | Phase 2와 같다 | 같다 | 같다 |

- 내장 모드의 `DATABASE_URL`·`STORAGE_ROOT`는 **앱 소유 키**다. `loadConfig`가 모드를 판정해 그 모드의
  파생값을 파일 값보다 **뒤에** 얹는다(Phase 2 `withAppOwned`와 같은 자리). 그러면 재시도의 `refreshEnv`가 보는
  새 env에도 파일의 옛 값이 들어오지 않아, 이 두 키는 갱신도 "다시 켜야 바뀐다" 보고도 생기지 않는다 — 다시
  켜도 바뀌지 않는 값이므로 그 보고는 거짓이다. 사람이 적은 옛 값의 경고는 §6.1이 한다.
- **모드는 키 단위가 아니라 모드 자체로 비교한다**(외부 리뷰 #5). `refreshEnv`는 파일에서 **사라진**
  restart-only 키를 보고하지 않는다(`config.ts:169-177`). `DEBUG_EXTERNAL_DATABASE_URL`을 restart-only 키로만
  넣으면, 그 키를 지워 내장 모드로 돌아가려는 사람에게 아무 말도 하지 않는다. 그래서 재적용기(`config-reload.ts`)가
  감독자 생성 때의 모드(`embedded` 또는 `external:<URL>`)와 새로 읽은 파일이 뜻하는 모드를 비교해, **추가·삭제·값
  변경 모두** "앱을 다시 켜야 반영됩니다"로 보고한다. 살아 있는 env의 `DATABASE_URL`·`STORAGE_ROOT`는 어떤
  경우에도 바꾸지 않는다.
- 주입 대상은 Phase 2와 같다 — `DATABASE_URL`은 api·worker, 그리고 이 Phase의 `migrate.js`(두 호출
  모두). `STORAGE_ROOT`는 api·worker.

### 6.7 실패 표시와 자동 재시도

**복구 부류를 도입한다.** Phase 2 `main.ts`의 `scheduleRetry`(`:597-609`)는 원인을 받지 않고, 게이트가 서지
않으면 무조건 3초·8초 뒤 20초마다 재시도한다(`:897-901`, Phase 2 결과 §5.2-1). 실행 게이트가 생긴 뒤 그대로 두면
**마이그레이션 실패가 20초마다 재실행되고, 매번 백업이 하나씩 쌓인다.**

**부류는 문구가 아니라 구조로 싣는다**(외부 리뷰 #2).

```ts
type Recovery = "auto" | "manual";
// ReadinessResult의 failed에:   { kind: "failed"; detail: string; recovery?: Recovery }
// launch()가 던지는 오류에:      class ServiceFailure extends Error { recovery: Recovery }
// ServiceStatus에:              recovery?: Recovery
```

- 감독자가 `failed`를 적을 때 `recovery`를 상태로 옮긴다. `scheduleRetry`는 게이트 서비스 중 `failed`인 것이
  **하나라도 `manual`이면 걸지 않는다.**
- **postgres 어댑터와 api의 실행 게이트(§6.5 1~4)는 `launch()`·`readiness()` 본문 전체를 감싸 부류를 붙인다.
  명시적으로 `auto`라고 적은 경로가 아니면 `manual`이다.** 새 코드가 예상하지 못한 오류(도구의 낯선 종료 코드,
  카탈로그에 없는 `initdb` 문구)가 자동 재시도로 새지 않게 한다. 정규식 카탈로그는 **화면 문구와 안내**를 고르는
  데만 쓴다.
- Phase 2의 기존 어댑터(api 스폰 이후·worker·embed)는 부류를 붙이지 않으며, 감독자는 부류 없는 실패를 `auto`로
  읽는다 — Phase 2의 복구 경로(Phase 2 결과 §5.2-1의 "Docker를 켰을 때 이것이 복구 경로였다" 류)를 이 Phase가
  조용히 끄지 않게 한다.
- 테스트가 두 성질을 고정한다: 이 Phase의 모든 실패 경로가 부류를 갖는다, `manual`이 하나라도 있으면 타이머가
  걸리지 않는다.

| 원인 | 화면이 말하는 것 | 부류 |
| --- | --- | --- |
| 페어링 거부 (§6.2) | 두 경로, "폴더를 옮기거나 지우지 않았는지 확인하세요" | `manual` |
| `PG_VERSION` 불일치 | 데이터 폴더의 버전과 앱의 버전 | `manual` |
| `pg_controldata` 실패 | 클러스터를 읽을 수 없음, PGDATA 경로 | `manual` |
| 소켓 경로 초과 | 경로와 바이트 수 | `manual` |
| 고아·락 확인 불가 | pid, 락 파일 경로 | `manual` |
| 고아가 내려가지 않음 | pid | `manual` |
| `initdb`·`createdb` 실패 | 원인 블록, 로그 경로 | `manual` |
| 마이그레이션 상태 조회 실패 | 원인 블록 | `manual` |
| `unknown` 마이그레이션 | "더 새 버전의 앱이 이 데이터를 업데이트했어요" | `manual` |
| 백업 실패 | 원인(디스크 등), "마이그레이션은 적용하지 않았어요" | `manual` |
| 마이그레이션 실패 | 원인 블록, 백업 경로 | `manual` |
| 실행 후에도 미적용 (§6.5-5) | 두 트리 불일치 | `manual` |
| PG가 준비 전에 죽음 / 준비 유예 초과 | 원인 블록, `logs/postgres/` 경로 | `auto` |
| ready 뒤 PG 사망 (재시작 중) | "데이터베이스를 다시 시작하는 중" | `auto` |
| 외부 디버그 모드의 미적용 | Phase 2 문구 | `auto` (Phase 2 동작 유지) |

- `manual`은 **"다시 시도" 버튼과 메뉴로만** 재시도한다. 화면에 자동 재시도 카운트다운을 띄우지 않는다.
- 위 표의 `auto` 두 행은 postgres 어댑터가 **명시적으로** `auto`를 붙이는 경로다.
- 삭제: `dockerDaemonDown`·`dockerMissing`과 그 안내, `status-view.ts`의 `db-unreachable` 화면 분기 중 Docker
  문구. `repoRootMissing` 안내에서 `be/docker-compose.yml` 언급.
- 상태 창의 postgres 로그 링크는 `supervisor.log`(Phase 2: 컨테이너라 자기 로그가 없었다)에서
  `logs/postgres/`로 바꾼다.

### 6.8 번들 계약

#### 빌드 스크립트 `desktop/scripts/build-postgres.sh`

Phase 0 `experiments/electron-phase-0/pg/build.sh`(태그 `archive/electron-phase-0-packaging-validation`)에서
검증 하네스(G1·dyld 증거)를 걷어낸 이식본이다. **Phase 0이 실측으로 확정한 조작을 바꾸지 않는다.**

| 단계 | 내용 | 근거 |
| --- | --- | --- |
| 버전 | PostgreSQL 16.15, pgvector 0.8.6, pg_bigm 1.2-20240606 | Phase 0. 개발 이미지와 같은 마이너, `be/docker/postgres-bigm/Dockerfile`과 같은 pg_bigm |
| 체크섬 | `desktop/scripts/postgres-checksums.txt`(커밋)의 sha256과 대조, 불일치면 중단 | Phase 0 `pg/checksums.txt` |
| 구성 | 중립 prefix + DESTDIR 스테이징, `--without-icu --without-readline --without-zlib`, `PG_SYSROOT=<없는 경로>` | Phase 0 — 개발 머신 경로가 산출물에 박히지 않게 |
| 확장 | pgvector `OPTFLAGS=""`, 두 확장 `PG_CPPFLAGS=-fmacro-prefix-map=<스테이지>=<중립 prefix>` | Phase 0 — `-march=native` 제거, `__FILE__` 경로 |
| 슬림화 | `include/`, `lib/postgresql/pgxs`, `lib/pkgconfig`, `lib/*.a` 제거 | Phase 0 — 빌드 전용, 실행 경로 아님 |
| 재배치 수정 | 중립 prefix를 가리키는 의존을 `@loader_path` 상대로, dylib id를 `@rpath/`로, 해당 `LC_RPATH` 삭제 | Phase 0 R-2b (`bin/` 20 + `lib/` 17) |
| 서명 | 수정한 Mach-O 전부 ad-hoc 재서명 | arm64는 서명 없는 Mach-O를 실행하지 않는다 |

- **캐시.** 산출물을 `desktop/.cache/postgres/<키>/`에 둔다(`desktop/.gitignore`에 `.cache/` 추가).
  키 = 세 버전 + 체크섬 파일 sha + **스크립트 자신의 sha**. 스크립트를 고치면 캐시가 무효가 된다.
  적중하면 복사만 한다.
- **스테이징.** 캐시에서 `desktop/build/postgres/`로 복사한다. 그 트리의 `bin/postgres`로 떠 있는 프로세스가
  있으면 교체를 거부한다(dev 앱이 쓰는 중).
- 캐시 미스의 빌드 시간과 캐시 크기는 계획 1단계에서 실측한다.

#### 패키징

- `package.mjs`가 기존 순서의 맨 앞(desktop 컴파일 앞)에서 `build-postgres.sh`를 부른다.
- `electron-builder.yml`의 `extraResources: from: build`가 이미 `build/` 전체를 `Resources/`로 복사하므로
  `Resources/postgres/`는 설정 변경 없이 실린다.
- 마지막 `codesign --force --deep --sign -`이 `Resources/` 아래 Mach-O의 개별 서명을 망가뜨리지 않는지
  §6.9의 실행 검사가 판정한다.

#### 바이너리 해석

| | 경로 |
| --- | --- |
| packaged | `process.resourcesPath/postgres/bin/…` |
| dev | `<desktop 패키지>/build/postgres/bin/…` |

실행 파일 탐색(`resolve.ts`)과 `PATH`를 쓰지 않는다 — 번들 경로는 앱이 안다. Homebrew `postgres`가
`PATH`에 있어도 잡히지 않는다. 필요한 바이너리: `postgres`·`initdb`·`pg_controldata`·`createdb`·`psql`·
`pg_dump`·`pg_restore`. 번들에서 없으면 기동 전에 원인 표시(`manual`, "`pnpm desktop:build`를 다시
실행하세요").

### 6.9 번들 위생 검사

`desktop/scripts/check-bundle.mjs`에 더한다.

1. `Resources/postgres/bin/`에 §6.8의 일곱 바이너리가 있다.
2. `Resources/postgres` 아래 **모든** Mach-O의 `otool -L` 의존이 `@loader_path/`·`@rpath/`·`/usr/lib/`·
   `/System/Library/` 중 하나로 시작한다.
3. 같은 Mach-O 전부 `codesign --verify`가 통과한다.
4. **`env -i`로 `postgres --version`과 `psql --version`을 둘 다** 실행해 exit 0. 서버만 보면 R-2b의
   "클라이언트만 죽는" 번들을 통과시킨다(Phase 0 Task 2에서 실제로 그랬다).
5. `Resources/postgres`에서도 **저장소 절대 경로 문자열 0건**(P1-C11을 PG 트리까지 확장).
6. `lib/postgresql/`에 `vector.dylib`·`pg_bigm.dylib`, `share/postgresql/extension/`에 두 확장의 control 파일.

## 7. 사용자 동작

| 동작 | 기대 |
| --- | --- |
| Docker Desktop이 꺼진 맥에서 앱 첫 실행 | 준비 화면을 지나 **빈** 담화 화면. 뒤에서 클러스터 생성·스키마 적용이 끝나 있다 |
| 업로드·녹음·검색 | Phase 2와 같다. 데이터는 `<userData>/data/`에 쌓인다 |
| 앱 종료 후 재실행 | 같은 회의가 그대로 있다 |
| 앱이 강제로 죽은 뒤 재실행 | 몇 초 더 걸리고 정상 진입. 데이터는 커밋된 만큼 남아 있다 |
| 새 마이그레이션이 든 앱으로 교체 후 실행 | 백업을 만든 뒤 적용하고 진입. 백업은 `<userData>/backups/` |
| 마이그레이션이 실패 | 원인과 백업 경로가 뜨고 멈춘다. 저절로 다시 돌지 않는다 |
| `data/postgres`를 지우거나 옮긴 채 실행 | 거부 화면. 아무것도 새로 만들지 않는다 |
| Docker의 5432가 떠 있는 채 실행 | 아무 충돌 없이 진입 |
| 디버깅 | 상태 창의 `psql -h …` 명령으로 접속. 또는 `DEBUG_EXTERNAL_DATABASE_URL` |
| 창 닫기 | Phase 2와 같다. DB도 계속 돈다 |

## 8. 실패·복구 동작

Phase 2 §8을 잇는다. Docker 관련 행은 없어지고 아래가 더해진다. 복구 부류는 §6.7.

| 실패 | 앱의 처리 |
| --- | --- |
| 번들에 PG 바이너리 없음 | 기동 전 원인. 재빌드 안내 |
| 소켓 경로 103바이트 초과 | 거부. 경로·바이트 수 |
| 페어링 불일치 | 거부. 두 경로. 아무것도 바꾸지 않는다 |
| `PG_VERSION` 불일치 | 거부 |
| 이전 실행의 고아 postmaster | fast 종료 → 새로 기동. 로그에 pid |
| pid 재사용된 낡은 락 | 락 제거 → 기동. 로그에 판정 근거 |
| 락의 주인을 확인할 수 없음 | 거부. 지우지 않는다 |
| `initdb` 중단 | 다음 실행이 임시 디렉터리를 지우고 다시 |
| `initdb`·`createdb` 실패 | 원인 블록 |
| PG가 준비 전에 죽음 | `stderrTail` + PG 로그 마지막 오류 |
| ready 뒤 PG 사망 | 백오프 재시작 3회. api·worker는 `degraded` → 스스로 회복 |
| 마이그레이션 상태 조회 실패 | 멈춤 |
| `unknown` 마이그레이션 | 거부 |
| 백업 실패 | 적용하지 않고 멈춤 |
| 마이그레이션 실패 | 멈춤. 원인 + 백업 경로 |
| 종료 시 PG가 fast 유예를 넘김 | immediate → 그래도 남으면 pid 보고 |

## 9. 완료 기준

각 기준은 식별자 · 확인 환경 · 확인 방법 · 성공 판정으로 구성한다. **아직 실행되지 않았다.**

"packaged 환경"은 `pnpm desktop:build`로 만든 `desktop/out/mac-arm64/Damwha.app`을 Finder에서 실행한 상태다.
"번들 postgres 프로세스"는 명령 경로가 그 `.app`(또는 dev의 `desktop/build/postgres`) 아래인 프로세스다.

### 축 A — 실사용 동작

**P3-C1. Docker 없이 신규 DB로 실행·처리·검색**

- 확인 환경: packaged. Docker Desktop **완전 종료**(`docker info`가 실패함을 기록). **기존 packaged userData
  위에서** 실행한다 — `config.json`에 옛 `DATABASE_URL`·`STORAGE_ROOT`가, `storage/meetings/mtg_37`이 있는 상태.
  업그레이드 경로 그 자체다.
- 확인 방법: 실행 전에 `<userData>/storage` 전체의 목록·체크섬과 `config.json`의 sha를 기록한다. Finder로 실행.
  오디오로 회의를 만들고 처리 완료까지 둔다. 두 검색어로 검색한다 — (a) 전사에 **글자 그대로 있는 한글 고유명사**
  (키워드 경로), (b) 키워드로 설명되지 않는 결과가 나오는 검색어(의미 경로). 처리 중에 상태 창의 `psql` 명령으로
  `SELECT backend_type, client_addr, datname FROM pg_stat_activity WHERE datname = 'damwha'`.
- 성공 판정:
  - 담화 화면에 진입한다. `<userData>/data/postgres`가 생기고 `_migrations` = 번들 `.sql` 수(현재 24).
  - 업로드한 회의가 `done`이고 전사가 보인다. 그 오디오 파일이 `<userData>/data/storage/meetings/<그 id>/`에 **있고**
    `<userData>/storage` 아래에는 새 항목이 **없다.**
  - `pg_stat_activity`에 `client backend`가 둘 이상(api 풀, worker) 있고 **모두 `client_addr`가 NULL**(Unix 소켓)이다.
    Docker가 꺼져 있으므로 `localhost:5432` 폴백이 있었다면 여기까지 오지 못한다 — 같은 폴백을 Docker가 켜진 채로
    잡는 것은 P3-C4다(R3-2).
  - (a)가 그 발화를 찾는다(키워드 경로 — pg_bigm이 `--locale=C` 클러스터에서 한글을 찾는다). (b)가 결과를 내고
    embed.log에 같은 시각 `POST /embed 200`이 있다.
  - `<userData>/storage`의 목록·체크섬이 **전부** 같다. `config.json`의 sha가 같다. 옛 키는 기본값이므로 상태 창에
    경고가 **없고** `supervisor.log`에 한 줄 있다.

**P3-C2. 재시작 후 데이터 유지**

- 확인 환경: packaged. P3-C1 직후.
- 확인 방법: ⌘Q로 종료. 다시 실행.
- 성공 판정: 같은 회의가 같은 전사로 보인다. 마커의 `clusterId`·`databaseOid`와 `pg_controldata`의 system
  identifier가 종료 전과 같다(재초기화·재생성 없음). 종료 시 PG 로그에 `database system is shut down`, 재기동 로그에 recovery가 **없다.**

**P3-C3. 앱 비정상 종료 뒤 고아 처리**

- 확인 환경: packaged. 네 서비스 준비 상태.
- 확인 방법: 테스트 회의 제목을 바꿔 커밋되게 한다. 앱 main 프로세스를 `kill -9`. 번들 postgres가 살아
  있음을 기록한다. 앱을 다시 실행한다.
- 성공 판정: `supervisor.log`에 고아 pid와 fast 종료가 적힌다. 새 postmaster pid ≠ 고아 pid. 바꾼 제목이
  남아 있다. 번들 postgres 프로세스는 postmaster 트리 하나뿐이다.

### 축 B — 격리와 수명주기

**P3-C4. TCP를 열지 않고 기존 PG와 공존**

- 확인 환경: packaged. **Docker Desktop을 켜고 `damwha-postgres`가 5432에 떠 있는** 상태(이 기준만 Docker를 켠다).
- 확인 방법: 실행 전에 Docker DB의 `meeting` 행 수와 `SELECT count(*) FROM pg_stat_activity WHERE datname='damwha'
  AND backend_type='client backend'`를 기록한다(`pnpm dev`·터미널 worker는 꺼 둔다). 앱 실행. `lsof -nP -iTCP
  -sTCP:LISTEN`, `stat -f %Lp <userData>/run`. 상태 창의 `psql -h …` 명령으로 `SELECT count(*) FROM _migrations`와
  P3-C1과 같은 `pg_stat_activity` 조회. Docker DB의 `pg_stat_activity` 조회를 다시 한다.
- 성공 판정:
  - 번들 postgres의 TCP 리스너가 **0개**. 5432의 리스너는 Docker뿐이다. `run/`이 `700`. 번들 `psql` 접속이 성공한다.
  - 내장 클러스터의 `pg_stat_activity`에 api·worker의 소켓 접속(`client_addr` NULL)이 있다.
  - **Docker DB의 client backend 수가 실행 전과 같다** — 앱의 어떤 소비자도 `localhost:5432`로 새지 않았다.
  - 앱 화면의 회의 목록이 내장 클러스터의 것이다(Docker DB의 회의가 보이지 않는다).

**P3-C5. 종료 후 번들 postgres 0개**

- 확인 환경: packaged. 처리 중인 job이 없는 상태.
- 확인 방법: ⌘Q. 앱 main 프로세스가 사라진 시점부터 **fast 유예 + immediate 유예 + 5초**(계획이 정한 값의 합)
  동안 0.5초 간격으로 번들 postgres 프로세스를 추적한다. 그 뒤 `run/`과 PG 로그를 본다.
- 성공 판정: 끝에 번들 postgres 프로세스 0개. 소켓 파일이 없다. PG 로그에 `received fast shutdown request`와
  `database system is shut down`이 있고 `immediate shutdown`은 **없다**(클라이언트가 없는 정상 종료는 fast로 끝나야
  한다 — immediate로 끝났다면 기준은 실패로 적고 원인을 본다). `supervisor.log`에 postgres `stopped`가 api 뒤에
  적혀 있다(역순). 추적 기록에서 postgres가 사라진 시각을 결과 문서에 적는다.

**P3-C15. postmaster 사망 시 재시작과 의존 서비스 회복**

- 확인 환경: packaged. 네 서비스 준비 상태.
- 확인 방법: postmaster pid에 `kill -9`. 상태 창과 로그를 60초 이상 본다.
- 성공 판정: 감독자가 백오프 안에 postgres를 다시 띄워 `running/ok`에 도달한다. api는 `degraded`를 거쳐 재시작
  없이 `ok`, worker도 `ok`로 돌아온다. 데이터가 보인다. **추가 기록:** 재기동이 공유 메모리·락 때문에 거절된
  적이 있는지 — Phase 0이 미실측 주장으로 남긴 항목의 답을 결과 문서에 적는다(어느 쪽이든 판정은 "자동으로
  회복했는가"로 한다).

### 축 C — 마이그레이션

**P3-C6. 데이터가 있는 DB에 새 마이그레이션 — 백업 후 적용**

- 확인 환경: packaged. P3-C1의 데이터가 있는 클러스터. **검증 전용 마이그레이션**
  `be/src/database/migrations/900_p3_probe.sql`(무해한 `CREATE TABLE p3_probe(id int)`)을 커밋하지 않고 넣어 빌드한다.
  이 파일은 P3-C7이 끝날 때까지 **빼지 않는다** — 적용된 뒤 번들에서 빠지면 그 행이 `unknown`이 되어 다음 실행이
  §6.5-2로 거부된다.
- 확인 방법: 앱 실행. `backups/`와 `_migrations`를 본다.
- 성공 판정: `backups/`에 `…-before-900_p3_probe.sql.dump`가 생겼고 **그 mtime이 `_migrations`의 `900_p3_probe.sql`
  `applied_at`보다 앞선다.** 번들 `pg_restore --list`가 그 파일에 exit 0. `_migrations` = 25. 앱이 정상 진입한다.
  `.partial`이 남아 있지 않다.

**P3-C7. 마이그레이션 실패 — 멈추고 반복하지 않음**

- 확인 환경: packaged. P3-C6의 클러스터. `900_p3_probe.sql`을 **남긴 채** 오류 나는 검증 전용 마이그레이션
  `901_p3_broken.sql`(존재하지 않는 테이블 `ALTER`)을 커밋하지 않고 더해 빌드한다.
- 확인 방법: 앱 실행. 화면을 보고 **2분** 둔다. 프로세스 목록, `backups/`, `_migrations`, `api.log`를 본다.
- 성공 판정: 실패 화면에 오류 원인과 백업 경로가 있다. API·worker 프로세스가 **0개**다. 2분 동안 마이그레이션
  실행 기록이 **1회**이고 `backups/`의 새 파일도 **1개**다. 자동 재시도 카운트다운이 없다. `_migrations`에 `901`이 없다.
- 정리: 실패 화면이 떠 있는 동안(postgres 게이트는 통과해 서버가 떠 있다) 상태 창의 `psql` 명령으로
  `_migrations`의 `900_p3_probe.sql` 행과 `p3_probe` 테이블을 지운다. ⌘Q 한 **뒤** 두 파일을 빼고 다시 빌드한다. 그
  앱으로 실행해 정상 진입하면 정리가 끝난 것이다. 순서를 바꾸면 P3-C8과 같은 거부를 만난다.

**P3-C8. `unknown` 마이그레이션 거부**

- 확인 환경: dev(`pnpm desktop:dev`)의 클러스터. 앱이 떠 있는 동안 상태 창의 `psql` 명령으로 `_migrations`에
  `INSERT … VALUES ('999_from_future.sql')`한 뒤 ⌘Q.
- 확인 방법: 앱을 다시 실행한다.
- 성공 판정: 거부 화면에 "더 새 버전의 앱" 원인과 이름이 있다. API가 뜨지 않는다. `_migrations` 행이 그대로다.
  확인 뒤 거부 화면이 떠 있는 동안(서버는 떠 있다) 그 행을 지운다.

### 축 D — 거부

**P3-C9. 페어링 거부**

- 확인 환경: packaged. 데이터가 있는 클러스터. 앱을 끄고 `data/postgres`를 `data/postgres.p3c9-moved`로 이름을 바꾼다.
- 확인 방법: 앱 실행. `data/` 목록을 본다. 이름을 되돌리고 다시 실행한다.
- 성공 판정: 거부 화면에 두 경로가 있다. `data/`에 새 `postgres`·`postgres.initdb-*`가 **없다.** `data/storage`의
  체크섬이 불변이다. 자동 재시도 카운트다운이 없다. 되돌린 뒤 정상 진입하고 데이터가 보인다.

**P3-C9b. 데이터베이스를 다시 만든 클러스터 거부** (판정표 2)

- 확인 환경: dev 클러스터. 업로드한 회의가 하나 이상 있어 `data/storage`가 비어 있지 않은 상태. **이 기준은 dev
  클러스터의 데이터를 버린다** — 확인 뒤 사람이 dev `data/`를 지워 정리한다(앱은 지우지 않는다).
- 확인 방법: 앱이 떠 있는 동안 상태 창의 `psql` 명령으로 `postgres` 데이터베이스에 접속해
  `DROP DATABASE damwha WITH (FORCE)`. ⌘Q 뒤 다시 실행한다.
- 성공 판정: 거부 화면에 "데이터베이스가 지워졌다" 원인이 있다. `damwha` 데이터베이스가 **다시 만들어지지 않았다**
  (`pg_database`에 없다). 마커 파일과 `data/storage` 체크섬이 불변이다. API가 뜨지 않는다.

**P3-C10. PostgreSQL 메이저 불일치 거부**

- 확인 환경: dev 클러스터. 앱을 끄고 `PG_VERSION`을 백업한 뒤 내용을 `15`로 바꾼다.
- 확인 방법: 앱 실행.
- 성공 판정: 거부 화면에 두 버전이 있다. 번들 postgres가 뜨지 않았다. `PG_VERSION` 외의 PGDATA 파일 체크섬이 불변이다.
  원복 뒤 정상 진입.

**P3-C11. 외부 디버그 모드**

- 확인 환경: dev. Docker Desktop과 `damwha-postgres` 실행. `config.json`에
  `DEBUG_EXTERNAL_DATABASE_URL`=Docker DB 주소.
- 확인 방법: 앱 실행. 상태 창, 프로세스 목록, `data/`를 본다. 확인 뒤 키를 지운다.
- 성공 판정: 번들 postgres 프로세스 0개. 상태 창과 상태줄에 `외부 DB(디버깅)`. 기존 회의 목록이 보인다.
  Docker DB의 `_migrations` 행 수가 불변이다. dev `data/`의 목록·체크섬이 불변이다. `backups/`에 새 파일이 없다.

### 축 E — 번들·회귀·데이터 보존

**P3-C12. 번들 위생**

- 확인 환경: `pnpm desktop:build` 직후.
- 확인 방법: `node desktop/scripts/check-bundle.mjs`.
- 성공 판정: Phase 2의 13항목과 §6.9의 6항목이 전부 PASS. 그리고 검사가 실제로 잡는지 한 번 확인한다 —
  빌드된 `.app`의 `Resources/postgres/bin/psql`이 가리키는 `libpq` 의존을 중립 prefix 절대 경로로 되돌리고
  ad-hoc 재서명한 뒤 검사하면 §6.9-2와 §6.9-4가 FAIL한다. 확인 뒤 다시 빌드한다.

**P3-C13. 회귀 없음**

- 확인 환경: 앱을 실행하지 않은 상태, 그리고 dev.
- 확인 방법: 루트 `pnpm install`·`build`·`test`·`lint`, `pnpm worker:test`,
  `docker build -f deploy/api.Dockerfile .`, `pnpm dev`로 웹 흐름(목록·전사·검색), `pnpm desktop:dev`.
- 성공 판정: 전부 통과. `pnpm build`가 PG를 빌드하지 않고 `.app`을 만들지 않는다. `pnpm dev`가 Electron을 띄우지
  않는다. `pnpm desktop:dev`가 내장 PG로 네 서비스 `ok`에 도달한다. `pnpm be:migrate`(인자 없음)의 동작이
  변하지 않았다(`be` 마이그레이션 테스트 통과).

**P3-C14. 기존 데이터 보존**

- 확인 환경: 전 구간.
- 확인 방법: 첫 실행 전에 기록한다 — `be/storage` 전체 목록·체크섬, packaged·dev `<userData>/storage` 목록·체크섬,
  두 `config.json`의 sha, Docker 볼륨 `damwha_pgdata`·컨테이너 `damwha-postgres`의 생성 시각, Docker DB의
  `meeting`·`utterance`·`_migrations` 행 수. P3-C1~C15 수행 뒤 같은 것을 다시 뜬다.
- 성공 판정: 전부 같다. 단 P3-C11이 실행한 앱 API가 Docker DB에 쓴 행(있다면)은 증거에 적고 행 수 비교에서
  그 몫만 뺀다 — 앱은 그 모드에서 마이그레이션을 실행하지 않았어야 하고 `_migrations`는 **정확히** 같아야 한다.

### 비고 — 단위 테스트로만 판정하는 것

실앱에서 조건을 만들기 어려워 결과 문서에 "단위 테스트만"으로 적는다.

- 소켓 경로 103바이트 초과 거부.
- 낡은 락의 pid 재사용 판정(살아 있는 비-postgres pid)과 `ps` 실패 시 거부.
- 판정표 1·2(§6.2)의 **모든 행** — 실앱 기준은 C9·C9b·C10이 대표 행만 밟는다.
- `initdb` 각 하위 단계에서의 중단과 다음 실행의 복귀(§6.4 기동 3단계).
- 기동 중단(§6.4): `stopAll`이 abort하면 진행 중인 도구가 끝나고 `stopAll`이 반환한다. deadline 초과가 `manual`
  실패가 된다.
- postgres 핸들이 어떤 경로로도 `SIGKILL`·음수 pid 신호를 보내지 않는다. 종료의 immediate 단계와 leaked 보고.
- 복구 부류(§6.7): 이 Phase의 모든 실패 경로가 부류를 갖고, `manual`이 있으면 자동 재시도 타이머가 걸리지 않는다.
- 모드 변경 보고(§6.6): `DEBUG_EXTERNAL_DATABASE_URL`의 추가·삭제·변경이 모두 보고되고 살아 있는 env는 불변.
- 마이그레이션 러너의 advisory lock: 겹친 두 러너가 둘 다 exit 0이고 각 파일이 한 번만 적용된다(`be` 테스트).

## 10. 제품 코드 변경 목록

`desktop/` 변경과 루트 스크립트 외에, 기존 코드 변경은 **하나**다.

**`be/src/database/migrate.ts`** — `--status` 플래그와 러너의 advisory lock.

- `runMigrations`가 풀에서 클라이언트 하나를 빌려 `pg_advisory_lock(<고정 키>)`를 쥐고, 그 세션에서 미적용을 다시
  계산하고 파일별 트랜잭션을 돌린 뒤 `pg_advisory_unlock`한다(§6.5-4). 웹 흐름의 `pnpm be:migrate`에도 적용되며
  동작이 바뀌는 것은 두 러너가 겹칠 때뿐이다(늦은 쪽이 기다렸다가 할 일이 없음을 보고 exit 0). 겹친 두 러너
  테스트를 `be/test/migration.spec.ts`에 더한다.
- `require.main === module` 블록에서 `process.argv`에 `--status`가 있으면 `listPendingMigrations`와
  `_migrations` 전체 이름을 읽어 §6.5-1의 한 줄 JSON을 stdout에 쓰고 exit 0. 없으면 기존 `runMigrations` 그대로.
- 판정 함수를 export해 `be/test/migration.spec.ts`(testcontainers)에 세 경우를 고정한다 — 빈 DB(`applied 0`,
  `pending` 전부), 전부 적용(`pending []`), `_migrations`에 모르는 이름(`unknown`에 나타남).
- **utilityProcess에서 `require.main === module`이 참인지는 미확정이다**(§12). 거짓이면 `--status`도 인자 없는
  실행도 **아무 일도 하지 않고 exit 0**으로 끝나 게이트가 조용히 통과한다. 그 경우 `be/src/database/`에
  `require.main` 검사가 없는 전용 엔트리 파일을 하나 더하고 이 절을 결과 문서에서 갱신한다. 어느 쪽이든
  게이트는 `--status`의 JSON을 **파싱할 수 있어야 통과**하도록 해, 무출력 exit 0을 성공으로 읽지 않는다.

**변경하지 않는 것:** `be/src/`(위 한 파일 제외), `be/worker/`, `fe/`, `packages/contracts/`,
`be/docker-compose.yml`, `be/docker/`, 모든 `.env`.

## 11. 빌드와 실행 흐름

| | dev (`pnpm desktop:dev`) | packaged |
| --- | --- | --- |
| PG 바이너리 | `build-postgres.sh`(캐시) → `desktop/build/postgres` | `Resources/postgres` |
| userData | `damwha-desktop` | `Damwha` |
| postgres | 번들 `postgres -D` | 같다 |
| 마이그레이션 조회·실행 | `pnpm --filter damwha-be run migrate [-- --status]` | `utilityProcess.fork(Resources/api/dist/database/migrate.js)` |
| api·worker·embed | Phase 2와 같다 | Phase 2와 같다 |

- `desktop/package.json`의 `start:desktop` 앞에 `build-postgres.sh`를 둔다(캐시 적중이면 즉시).
- `pnpm build`·`pnpm dev`·`pnpm be:*`·`pnpm db:*`는 손대지 않는다.

## 12. 미확정 사항

구현에 영향을 주는 것은 계획 1단계(사전 실측)에서 닫는다.

| 항목 | 성격 | 언제 닫히나 |
| --- | --- | --- |
| 공백 포함 소켓 URI를 node-pg·psycopg 3·`migrate.js`가 받는가 | 기술 위험 | 계획 1단계. 못 받으면 소비자별 파생 |
| `utilityProcess.fork`에서 `require.main === module` | 기술 위험 | 계획 1단계. 거짓이면 전용 엔트리(§10) |
| `--locale=C` 클러스터에서 pg_bigm 한글 검색·정렬이 Docker DB(로캘 실측)와 같은가 | 기술 위험 | 계획 1단계. 같은 시드로 `search.repository.ts`와 같은 질의를 두 DB에 돌려 비교. **다르면 구현 전에 스펙으로 돌아와 로캘을 다시 정한다.** 실앱 판정은 P3-C1 (a) |
| `--without-zlib`의 `pg_dump -Fc` 동작과 크기 | 기술 확인 | 계획 1단계 |
| 최종 `codesign --deep`이 `Resources/postgres`의 개별 서명을 유지하는가 | 기술 확인 | 계획 1단계 또는 §6.9 첫 실행 |
| PG 캐시 미스 빌드 시간·캐시 크기 | 구현 값 | 계획 1단계 |
| postgres 준비 유예·fast 종료 유예·고아 종료 유예 | 구현 값 | 계획. 근거는 결과 문서 |
| PG 로그 회전(`log_filename`·`log_rotation_*`) | 구현 값 | 계획 |
| 백업 보관 개수 (초안 5) | 구현 값 | 계획 |
| 도구별 deadline(`initdb`·`createdb`·`psql`·`--status`·`pg_dump`·`pg_restore --list`·러너) | 구현 값 | 계획. `pg_dump`·러너는 데이터 크기에 비례하므로 상한을 두지 않고 중단 신호만 받는 선택지도 계획이 판단한다 |
| 상태 창 배지·원인 문안 | 구현 세부 | 구현. `fe/DESIGN.md` 톤 |

## 13. 기술 위험

| 식별자 | 위험 | 관찰 방법 | 대응 |
| --- | --- | --- | --- |
| R3-1 | 새 DB의 id 시퀀스가 옛 스토리지 파일을 덮어쓴다 | P3-C1(`mtg_37` 불변), P3-C9 | §6.2 페어링과 `data/storage` 분리 |
| R3-2 | 공백 포함 소켓 URI를 어떤 드라이버가 못 받아 조용히 TCP `localhost:5432`(Docker DB)로 붙는다 | 계획 1단계, P3-C4 | 실측 후 소비자별 파생. **P3-C4를 Docker가 떠 있는 채로 판정하는 이유가 이것이다** — 잘못 붙으면 Docker DB의 회의가 보인다 |
| R3-3 | utilityProcess에서 러너가 무출력 exit 0 → 게이트가 조용히 통과 | 계획 1단계 | §10 — JSON 파싱을 통과 조건으로 |
| R3-4 | 재배치 수정·서명 누락으로 클라이언트 바이너리만 죽는다 (Phase 0 R-2b) | P3-C12 | §6.9-4 `env -i psql --version` |
| R3-5 | 마이그레이션 실패가 자동 재시도로 반복되고 백업이 쌓인다 | P3-C7 | §6.7 `manual` |
| R3-6 | 옛 앱이 새 스키마 위에서 돈다 | P3-C8 | §6.5-2 `unknown` 거부 |
| R3-7 | 앱 크래시 뒤 고아 postmaster가 락을 쥐어 다음 기동이 막힌다 / 옛 바이너리가 계속 돈다 | P3-C3 | §6.4 기동 2단계 |
| R3-8 | 낡은 락의 pid가 재사용돼 PG가 기동을 거부한다 | 단위 테스트 | §6.4 기동 2단계 |
| R3-9 | postmaster `SIGKILL` 뒤 공유 메모리가 남아 재기동이 거절된다 (Phase 0 미실측 주장) | P3-C15 | 앱은 SIGKILL하지 않는다. 외부 사망은 P3-C15로 한 번 잰다 |
| R3-10 | C 로캘이 검색·정렬 결과를 Docker DB와 다르게 만든다 | 계획 1단계 | 차이가 제품 동작에 영향 있으면 스펙으로 돌아온다 |
| R3-11 | 소스 아카이브 체크섬이 첫 수신값의 자기 관측이다(pgvector·pg_bigm은 공식 sha256 없음) | — | 커밋된 sha256 대조까지. 서명 검증·재현 가능 빌드는 Phase 6 |
| R3-12 | 최종 `codesign --deep`이 Resources의 Mach-O 서명을 무효화한다 | 계획 1단계, P3-C12 | §6.9-3·4 |
| R3-13 | 소켓 경로가 긴 사용자 이름에서 103바이트를 넘는다 | 단위 테스트 | §6.3 거부. 폴백 없음 |
| R3-14 | 외부 디버그 모드가 제품 경로로 새어 사용자가 Docker DB를 쓰게 된다 | P3-C11 | `DEBUG_` 이름, 첫 실행 config에 광고하지 않음, 상시 배지 |
| R3-15 | 같은 클러스터에서 `damwha` DB만 지워지고 자동 `createdb`가 빈 DB를 옛 스토리지와 다시 짝짓는다 | P3-C9b | §6.2 판정표 2 — 마커의 `databaseOid` |
| R3-16 | `launch()` 안의 도구가 멈춰 기동과 ⌘Q가 무기한 대기한다 (`stopAll`이 진행 중 기동을 기다림) | 단위 테스트 | §6.4 기동 중단 — `signal`과 deadline |
| R3-17 | 크래시 뒤 살아남은 러너와 새 러너가 겹쳐 적용이 끝났는데 실패로 보인다 | 단위 테스트(`be`) | §6.5-4 advisory lock |
| R3-18 | 공용 핸들의 SIGKILL·그룹 신호가 postmaster에 닿는다 | 단위 테스트 | §6.4 핸들 — postgres 전용 |
| R3-19 | 새 코드의 예상 못 한 오류가 부류 없이 자동 재시도로 샌다 | 단위 테스트 | §6.7 — 새 경로 기본 `manual` |

## 14. 로드맵 완료 기준과의 대응

| 로드맵 Phase 3 완료 기준 | 이 스펙의 기준 |
| --- | --- |
| Docker 없이 신규 DB로 앱 실행·검색 성공 | P3-C1, P3-C4 |
| 앱 재시작 후 데이터 유지 | P3-C2, P3-C3, P3-C15 |
| 기존 개발용 DB·볼륨을 변경하거나 덮어쓰지 않음 | P3-C14, P3-C11 |

로드맵 범위와의 대응:

| 로드맵 Phase 3 범위 | 이 스펙 |
| --- | --- |
| PostgreSQL 실행 파일과 필요한 확장 패키징 | §6.8·§6.9, P3-C12 |
| 최초 DB 생성, 준비 확인, 스키마 마이그레이션, 정상 종료 | §6.4·§6.5, P3-C1·C5·C6·C7·C8 |
| 영구 데이터 경로, 접속 설정과 기존 PostgreSQL 인스턴스와의 충돌 방지 | §6.1·§6.2·§6.3, P3-C4·C9·C9b·C10 |

## 15. 후속 Phase에 넘기는 것

- **Phase 4** — Phase 2가 넘긴 것 그대로(`FFMPEG_BIN`/`FFPROBE_BIN`, `UV_BIN` 재시도 반영). 더해서, 번들
  바이너리를 `resolve.ts`의 `PATH` 탐색이 아니라 **앱이 아는 경로**로 부르는 이 Phase의 방식(§6.8 바이너리 해석)을
  worker·embed·ffmpeg에도 적용할지 결정한다.
- **Phase 5**
  - Docker DB → 내장 클러스터 이전. 대상 스토리지는 `<userData>/storage`(Phase 1·2 앱 업로드)와 `be/storage`(웹 흐름).
    둘 다 **Docker DB와 짝**이므로 DB 행과 함께 옮겨야 하고, 이전 뒤 §6.2의 마커를 새 `clusterId`·`databaseOid`로 적어야
    한다. 이 Phase가 거부만 하는 짝 불일치를 "사람이 짝을 증명하고 마커를 고치는" 도구도 여기서 다룬다.
  - 백업 복원 절차와 그 검증(이 Phase는 만들고 목차를 읽는 것까지).
  - 강제 종료·잠자기·디스크 부족 중 PG 동작.
- **Phase 6**
  - PostgreSQL 메이저 업그레이드(`pg_upgrade`) — 이 Phase는 거부만 한다.
  - 업데이트 전 백업 정책의 일반화 — 이 Phase의 마이그레이션 전 백업이 첫 조각이다.
  - 소스 아카이브 서명 검증과 재현 가능 빌드, `Resources/postgres`의 Developer ID 서명·hardened runtime.
  - Phase 2가 넘긴 job lease token, `enableCors`·API 인증.

## 16. 산출물

- `desktop/scripts/build-postgres.sh`, `desktop/scripts/postgres-checksums.txt`.
- `desktop/src/services/postgres.ts`(내장·외부 디버그 두 spec), api 어댑터의 실행 게이트, 복구 부류.
- `check-bundle.mjs`·`package.mjs`·`desktop/package.json`·`desktop/.gitignore` 갱신.
- `be/src/database/migrate.ts`의 `--status`·advisory lock과 그 테스트.
- `desktop/src/services/types.ts`·`supervisor.ts`의 `recovery`와 `LaunchContext.signal`, `config-reload.ts`의 모드 비교.
- 결과 문서 `docs/superpowers/reports/2026-09-14-electron-phase-3-embedded-postgres-results.md` — 스펙 리뷰,
  계획 검증, 단계별 실행·리뷰, 최종 검증을 구분해 기록.
- 로드맵의 Phase 3 상태 갱신. `be/CLAUDE.md`(마이그레이션 `--status`), 데스크톱 운영 문서(데이터 위치·디버깅 접속·
  외부 디버그 모드·백업 위치) 갱신.

## 17. 외부 리뷰 기록

사용자 요청으로 쓰인 스펙 전체(`b8470db`)를 **Codex CLI**(`codex exec`, read-only 샌드박스,
`model_reasoning_effort=high`)에 넘겨 저장소를 직접 읽고 반박하게 했다. 세션 `01a09d8b-4026-7b21-988d-b4e7919c2760`.
프롬프트는 내가 고른 선택지의 채점이 아니라 **코드와 어긋나는 주장·데이터 안전 구멍·빠진 실패 경로·관찰 불가능한
기준**을 찾게 했고, 이미 확인한 7건(V1~V7)을 적어 중복을 막았다. 11건 지적, **11건 전부 메인 세션이 코드로 재확인해
성립했고 전부 반영했다.**

| # | 등급 | 지적 | 재확인한 근거 | 반영 |
| --- | --- | --- | --- | --- |
| 1 | 차단 | 클러스터 id만으로는 짝이 증명되지 않는다 — DB만 지워지면 `createdb`가 빈 DB를 옛 스토리지와 다시 짝짓는다. "PGDATA 있음 + 마커 없음 → 마커 기록"은 출처 모를 PGDATA에 마이그레이션을 실행한다 | 초안 §6.2 판정표 3행, §6.4 기동 5단계 | §6.2 마커 `{clusterId, databaseOid}`, 판정표 1·2, 마커를 rename 전에 기록. P3-C9b, R3-15 |
| 2 | 차단 | 카탈로그 밖 원인을 `transient`로 두면 새 도구 오류가 다시 자동 재시도로 샌다 | `main.ts:597-609`의 `scheduleRetry`가 원인을 받지 않고 `:897-901`에서 무조건 호출 | §6.7 `recovery`를 구조로 싣고 새 경로 기본 `manual`. R3-19 |
| 3 | 중요 | `launch()` 안의 도구에는 준비 유예가 적용되지 않아 멈추면 기동·⌘Q가 무기한 대기 | `supervisor.ts:363-381`(유예는 launch 반환 뒤), `:499-512`(`stopAll`이 pending을 기다림) | §6.4 "기동 중단" — `LaunchContext.signal`, 도구별 deadline, 중단 뒤 상태표. R3-16 |
| 4 | 중요 | post-ready `createdb`·마커의 위치를 계획으로 미루면 게이트가 일찍 열린다 | `types.ts:83-109`에 post-ready 훅 없음, `supervisor.ts:156-166`이 `ready` 즉시 통과 | §6.4 준비 판정에 판정표 2를 넣고 핸들당 1회로 확정. §12의 해당 미확정 행 삭제 |
| 5 | 중요 | 외부 모드 키를 restart-only로만 넣으면 **삭제**가 보고되지 않는다 | `config.ts:169-177`이 사라진 restart-only 키를 건너뜀 | §6.6 모드 자체 비교, 양방향 보고. 내장 모드 DB 키는 restart-only가 아니라 앱 소유 파생 |
| 6 | 중요 | 조회·백업·실행을 나누면서 러너 상호 배제가 없다 | `migrate.ts:31-45`가 파일별 조회 후 실행만 함 | §6.5-4·§10 advisory lock, 백업을 락 밖에 두는 근거. R3-17 |
| 7 | 중요 | 공용 핸들을 쓰면 "postmaster에 SIGKILL 없음"이 깨진다 | `api-process.ts:152-171`의 `escalate`가 SIGKILL, `:280-305`가 그룹 신호 | §6.4 postgres 전용 핸들. R3-18 |
| 8 | 중요 | P3-C5의 "5초 뒤 0개"가 fast 유예 초안 30초와 모순 | 초안 §6.4 종료 vs P3-C5 | P3-C5 관측 창을 유예 합으로, fast/immediate 로그 구분 |
| 9 | 중요 | C1·C4가 소비자들이 실제로 소켓 DB·새 스토리지를 썼다는 증거를 요구하지 않는다 | 초안 P3-C1(`mtg_37` 하나), P3-C4(`psql` 접속만) | P3-C1·C4에 `pg_stat_activity`(`client_addr` NULL), Docker DB 접속 수 불변, 새 파일 위치, 스토리지 전체 manifest |
| 10 | 중요 | `pg_controldata` 라벨 파싱이 로캘에 기댄다. C 로캘의 pg_bigm 한글 검색을 기준이 판정하지 않는다 | 초안 §6.2, P3-C1이 의미 검색만 요구 | PG 도구 `LC_ALL=C`, P3-C1 (a) 한글 키워드 검색, §12 비교가 다르면 스펙 재검토 |
| 11 | 경미 | `.partial` 삭제가 §5의 삭제 목록 밖이다 | 초안 §5 vs §6.5-3 | §5 네 번째 삭제, 형식·경로·`lstat` 확인과 로그 |

**이 반영으로 바뀌지 않은 것:** 사용자가 승인한 범위와 주요 동작 — 내장 기본·외부 디버그 탈출구, Unix 소켓 전용,
적용 전 백업을 동반한 자동 마이그레이션, 역할 분담 구조(A), 데이터 배치. 계약의 추가 두 개(`recovery`,
`LaunchContext.signal`)는 그 동작을 지키기 위한 설계 세부다.

Codex가 일관하다고 확인한 것: `postgres -D` 직접 기동과 `pg_ctl start` 회피, SIGINT/SIGQUIT의 의미, 소켓 전용 +
`--auth-local=trust --auth-host=reject` + `unix_socket_permissions=0700`의 일관성, `--without-zlib`와 재배치 뒤 `psql`
검증의 반영.
