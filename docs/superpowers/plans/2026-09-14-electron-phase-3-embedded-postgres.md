# Electron Phase 3 — PostgreSQL 내장 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Docker 없이 담화를 쓴다 — 앱이 번들 PostgreSQL 클러스터를 만들고, 띄우고, 스키마를 올리고(적용 전 백업), 내린다.

**Architecture:** Phase 2 감독자의 `postgres` 자리를 번들 클러스터 어댑터로 바꾼다. 어댑터는 클러스터 수명주기(페어링 검증·`initdb`·`postgres -D` 직접 기동·`postmaster.pid` 준비 판정·SIGINT→SIGQUIT 종료)만 지고, 마이그레이션 상태 조회·백업·실행은 api 어댑터의 스폰 전 게이트가 진다. 감독자 계약은 두 곳만 넓힌다 — 실패의 복구 부류(`recovery`)와 기동 중단 신호(`LaunchContext.signal`). Unix 소켓만 열고, 클러스터와 스토리지는 마커로 짝을 증명한다.

**Tech Stack:** Electron 44 main(TypeScript), vitest 4, Node `child_process`, PostgreSQL 16.15 + pgvector 0.8.6 + pg_bigm 1.2-20240606 소스 빌드(bash, Xcode CLT), NestJS `be/`의 `migrate.ts`(jest + testcontainers), psycopg 3(측정만).

**Spec:** [docs/superpowers/specs/2026-09-14-electron-phase-3-embedded-postgres-design.md](../specs/2026-09-14-electron-phase-3-embedded-postgres-design.md)

**Results doc:** [docs/superpowers/reports/2026-09-14-electron-phase-3-embedded-postgres-results.md](../reports/2026-09-14-electron-phase-3-embedded-postgres-results.md) — Task 3이 §2.4를, Task 14가 §3~§5를 채운다.

## Global Constraints

이 절은 모든 Task의 요구사항에 암묵적으로 포함된다. 값은 스펙에서 그대로 옮겼다.

- **`desktop/package.json`의 `dependencies`는 비어 있어야 한다.** desktop에 pg 클라이언트를 넣지 않는다. DB에 묻는 일은 번들 `psql`·`pg_controldata`와 `migrate.js`가 한다.
- **`npm install`을 `be/`에서 실행하지 않는다.** 루트에서 `pnpm install`만. 패키지를 루트에서 실행하지 않는다(`pnpm --filter`·`uv run --directory`).
- **`.env` 파일(`be/.env`·`be/worker/.env`·`fe/.env`)을 고치지 않는다.** 루트 `.env`를 만들지 않는다.
- **앱은 기존 데이터를 읽지도 쓰지도 않는다** — Docker 컨테이너 `damwha-postgres`, 볼륨 `damwha_pgdata`, `be/storage`, `<userData>/storage`. **앱은 `config.json`을 다시 쓰지 않는다**(Phase 2의 `REPO_ROOT` 저장은 예외로 남는다).
- **앱이 지우는 것은 넷뿐이다**: `data/postgres.initdb-*`(앱이 만든 임시 디렉터리), 낡음을 증명한 `postmaster.pid`·소켓 `.lock`, 검증된 새 백업 뒤 5개 초과분 `.dump`, `backups/*.dump.partial`. 지우기 전에 이름 형식과 `lstat`(심볼릭 링크 아님)을 확인하고 `supervisor.log`에 적는다.
- **거부 경로는 아무것도 지우거나 만들지 않는다.**
- **마이그레이션은 앱 소유 내장 클러스터에만 실행한다.** 외부 디버그 모드(`DEBUG_EXTERNAL_DATABASE_URL`)는 감지만 한다.
- **postmaster에 `SIGKILL`을 보내지 않고, 음수 pid(그룹) 신호도 보내지 않는다.** SIGINT(fast) → SIGQUIT(immediate)만.
- **Unix 소켓만 연다**: `listen_addresses=''`, `unix_socket_permissions=0700`, `initdb --auth-local=trust --auth-host=reject`. 슈퍼유저·DB 이름 `damwha`.
- **PG 도구는 `LC_ALL=C`로 부른다.** `psql`에는 `-X`를 준다(`~/.psqlrc` 무시).
- **dev와 packaged는 같은 userData `~/Library/Application Support/Damwha`와 같은 클러스터를 쓴다**(`desktop/src/main.ts:71`의 `app.setName`). 파괴적 검증은 스펙 §9의 "파괴적 검증의 격리" 절차 안에서만 한다.
- **렌더러 → main 채널을 새로 만들지 않는다.** main → 렌더러 `executeJavaScript` 한 방향.
- Node `>=22 <23`, pnpm `10.26.0`, Python `>=3.12,<3.13`. PostgreSQL `16.15`, pgvector `0.8.6`, pg_bigm `1.2-20240606`.
- 주석과 커밋 메시지는 한국어. 기존 `desktop/src/*.ts`의 어투를 따른다 — "왜"를 적고 "무엇"은 적지 않는다.
- 각 Task는 커밋 하나 이상으로 끝난다. 커밋 메시지 끝에 `Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR`를 붙인다.
- 계획을 순서대로 실행한다. Task 3(사전 실측)의 결과가 뒤 Task의 가정과 어긋나면 **그 Task를 시작하기 전에** 계획을 고치고 결과 문서에 적는다.

## 파일 구조

| 파일 | 책임 | Task |
| --- | --- | --- |
| `desktop/scripts/build-postgres.sh` | PG 소스 빌드·재배치 수정·서명·캐시·`desktop/build/postgres` 스테이징 | 1 |
| `desktop/scripts/postgres-checksums.txt` | 세 소스 아카이브의 sha256 | 1 |
| `be/src/database/migrate.ts` | `migrationStatus`, advisory lock, `runCli`(한 줄 JSON) — 제품 코드 변경 1 | 2 |
| `be/test/migrate-status.spec.ts` | 상태·락·CLI 출력 고정 | 2 |
| `desktop/src/services/types.ts` | `Recovery`, `ServiceStatus.recovery`, `ReadinessResult.failed.recovery`, `LaunchContext.signal`, `bins`에서 docker 제거 | 4 |
| `desktop/src/services/failure.ts` | `ServiceFailure`, `recoveryOf`, `manualUnlessTagged` | 4 |
| `desktop/src/services/supervisor.ts` | 부류 전달, manual이면 재시작 안 함, `stopAll`이 abort | 4 |
| `desktop/src/retry-policy.ts` | `mayAutoRetry` — 자동 재시도 판정 | 4 |
| `desktop/src/services/pg-layout.ts` | 경로·소켓 길이·`DATABASE_URL` 파생·바이너리 경로·도구 env | 5 |
| `desktop/src/services/pg-pairing.ts` | 마커 읽기/쓰기, 스토리지 사실, 판정표 1·2, `pg_controldata` 파싱 | 5 |
| `desktop/src/services/pg-pidfile.ts` | `postmaster.pid` 파싱, 락 주인 분류 | 5 |
| `desktop/src/services/tool-runner.ts` | deadline·중단 신호를 받는 외부 도구 실행기 | 6 |
| `desktop/src/services/pg-handle.ts` | postmaster 스폰·SIGINT→SIGQUIT 종료·`psInfo`·고아 종료 | 6 |
| `desktop/src/causes.ts`·`shell-hints.ts` | 내장 DB·마이그레이션 원인과 안내 추가(7), Docker 원인 삭제(12) | 7, 12 |
| `desktop/src/services/pg-service.ts` | `embeddedPostgresSpec`·`externalPostgresSpec` | 8 |
| `desktop/src/services/migration-gate.ts` | 상태 파싱·백업·실행·보관, dev 러너 | 9 |
| `desktop/src/migrate-process.ts` | packaged 러너 — `utilityProcess.fork`로 `migrate.js` | 9 |
| `desktop/src/services/api.ts` | 스폰 전 게이트 호출, 안전망 문구 | 9 |
| `desktop/src/config.ts`·`config-reload.ts` | DB 모드, 옛 키, DB 키를 재적용에서 제외, 모드 변경 보고 | 10 |
| `desktop/src/status-view.ts`·`shell-window.ts`·`shell/status.html`·`shell/services.html`·`repo-root.ts` | db-unreachable 화면 삭제, 외부 모드 배지·설정 경고·디버그 명령·서버 로그 링크 | 11 |
| `desktop/src/services/specs.ts`·`desktop/src/main.ts` | 모드별 postgres 선택, 게이트·러너 배선, 부류를 보는 자동 재시도 | 12 |
| `desktop/src/services/postgres.ts`·`desktop/tests/postgres.test.ts` | compose 어댑터 — **삭제** | 12 |
| `desktop/scripts/package.mjs`·`desktop/scripts/check-bundle.mjs`·`desktop/package.json`·`desktop/.gitignore` | 패키징·위생 검사 | 1, 13 |
| `desktop/CLAUDE.md`(신규)·루트 `CLAUDE.md`·`be/CLAUDE.md`·로드맵·결과 문서 | 운영 문서와 기록 | 2, 14 |

**스펙과 이름이 다른 곳 (의도):** 스펙 §16은 어댑터를 `services/postgres.ts`로 적었다. 계획은 `pg-service.ts`에 새로 쓰고 compose 어댑터를 Task 12에서 지운다 — main이 배선을 바꾸기 전까지 compose 어댑터가 필요해 한 파일을 제자리에서 갈아엎으면 Task 8~11 동안 앱이 컴파일되지 않는다. 스펙 §6.4 "핸들"의 `logs/postgres/stderr.log`는 `LaunchContext.logFile(id)` 계약(`logs/<id>.log`)을 따라 `logs/postgres.log`가 된다.

---

## Task 1: PostgreSQL 번들 빌드 스크립트

Phase 0 `experiments/electron-phase-0/pg/build.sh`(태그 `archive/electron-phase-0-packaging-validation`)를 제품 스크립트로 옮긴다. **빌드 조작은 바꾸지 않는다** — 각각이 실측으로 정해졌다(스펙 §6.8). 검증 하네스(G1·dyld 증거)만 걷어낸다.

**Files:**
- Create: `desktop/scripts/build-postgres.sh`
- Create: `desktop/scripts/postgres-checksums.txt`
- Modify: `desktop/.gitignore`

**Interfaces:**
- Consumes: 없음
- Produces: `desktop/build/postgres/{bin,lib,share}` — 재배치·서명이 끝난 트리. `bin/`에 `postgres`·`initdb`·`pg_controldata`·`createdb`·`psql`·`pg_dump`·`pg_restore`. `desktop/build/postgres/.build-key`(캐시 키 한 줄). Task 3·7·11·12가 이 경로를 쓴다.

- [ ] **Step 1: 체크섬 파일을 만든다**

`desktop/scripts/postgres-checksums.txt`:

```text
# build-postgres.sh가 shasum -a 256 -c 로 대조하는 소스 아카이브의 sha256.
#
# postgresql-16.15.tar.bz2는 배포처가 함께 공개하는 값과 같다:
#   https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2.sha256
# pgvector·pg_bigm의 GitHub 태그 아카이브는 공개 체크섬이 없어 2026-09-09(Electron Phase 0 Task 2)에 받은
# 값을 적는다. 첫 수신값의 자기 관측이다 — 서명 검증과 재현 가능 빌드는 Phase 6 (스펙 §13 R3-11).
c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed  postgresql-16.15.tar.bz2
10bf9938906e5d643bbc4a7eea104b6f57ba4898e5b76b20e60484ea1d5a7f8f  pgvector-0.8.6.tar.gz
69eabf7a6af19909fc8a33525768854b08c94929d7f9fa94fe31e737c04748ff  pg_bigm-1.2-20240606.tar.gz
```

- [ ] **Step 2: 빌드 스크립트를 쓴다**

`desktop/scripts/build-postgres.sh`:

```bash
#!/bin/bash
# desktop/scripts/build-postgres.sh
#
# 내장 PostgreSQL 트리를 만든다 — PostgreSQL 16.15 + pgvector 0.8.6 + pg_bigm 1.2-20240606.
# 결과는 desktop/build/postgres/. electron-builder의 extraResources(from: build)가 그대로
# Resources/postgres/로 싣고, dev 앱은 이 자리를 직접 쓴다 (Electron Phase 3 스펙 §6.8).
#
# Electron Phase 0의 experiments/electron-phase-0/pg/build.sh(태그
# archive/electron-phase-0-packaging-validation)를 옮겼다. 검증 하네스만 걷어냈고 빌드 조작은
# 하나도 바꾸지 않았다 — 하나하나가 실측으로 정해진 것이라 근거를 그 자리에 적는다.
#
#   bash desktop/scripts/build-postgres.sh           캐시가 있으면 스테이징만
#   bash desktop/scripts/build-postgres.sh --fresh   이 키의 캐시를 버리고 다시 빌드

set -euo pipefail

PG_VERSION=16.15
PGVECTOR_VERSION=0.8.6
PG_BIGM_VERSION=1.2-20240606
# 이 머신에 없는 중립 prefix. 최종 경로와 일부러 다르게 둬야 "재배치가 되는가"가 빌드 때 드러난다.
# 같게 두면 install_name 37건(Phase 0 R-2b)이 개발 머신에서만 우연히 맞는다.
BUILD_PREFIX=/opt/damwha-embedded-pg16

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$DESKTOP/.." && pwd -P)"
SCRIPT="$DESKTOP/scripts/build-postgres.sh"
SUMS="$DESKTOP/scripts/postgres-checksums.txt"
CACHE="$DESKTOP/.cache/postgres"
DL="$CACHE/downloads"
STAGED="$DESKTOP/build/postgres"

die() { echo "build-postgres: $*" >&2; exit 1; }
say() { echo "== $*"; }

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "") ;;
  *) die "usage: build-postgres.sh [--fresh]" ;;
esac

for t in curl tar make cc otool install_name_tool codesign shasum file ditto pgrep; do
  command -v "$t" >/dev/null 2>&1 || die "$t 가 없다 — Xcode Command Line Tools가 필요하다"
done

# 캐시 키 = 버전·prefix·체크섬 파일·이 스크립트 자신. 조작을 고치고 옛 산출물을 쓰는 것이 가장 조용한
# 실패라, 스크립트를 한 글자라도 고치면 다시 빌드한다.
KEY=$( { echo "$PG_VERSION $PGVECTOR_VERSION $PG_BIGM_VERSION $BUILD_PREFIX"; shasum -a 256 "$SUMS" "$SCRIPT" | awk '{print $1}'; } | shasum -a 256 | cut -c1-16)
WORK="$CACHE/work-$KEY"
OUT="$CACHE/pg-$KEY"
DONE="$CACHE/pg-$KEY.complete"

if [ "$FRESH" = 1 ]; then
  rm -rf "$WORK" "$OUT" "$OUT.tmp" "$DONE"
fi

fetch() {
  local url="$1" out="$2"
  [ -f "$DL/$out" ] && return 0
  curl -fsSL -o "$DL/$out.part" "$url" || die "내려받기 실패: $url"
  mv "$DL/$out.part" "$DL/$out"
}

machos() {
  # 심볼릭 링크는 따라가지 않는다 — lib/libpq.dylib → libpq.5.16.dylib 같은 링크를 두 번 고치게 된다.
  find "$1" -type f -print0 | xargs -0 file 2>/dev/null | grep -a 'Mach-O' \
    | sed -e 's/:[[:space:]]*Mach-O.*$//' -e 's/ (for architecture [^)]*)$//' | sort -u
}

relocate() {
  local root="$1" f rel up idline dep leaf rp changed
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    changed=0
    rel=$(dirname "${f#"$root"/}")
    if [ "$rel" = "." ]; then up=""; else up=$(echo "$rel" | awk -F/ '{s=""; for (i=1;i<=NF;i++) s = s "../"; print s}'); fi
    # (a) dylib 자신의 install_name. src/Makefile.shlib이 빌드 시점 libdir 절대 경로를 박는다.
    idline=$(otool -D "$f" 2>/dev/null | sed -n '2p')
    case "$idline" in
      "$BUILD_PREFIX"/*) install_name_tool -id "@rpath/$(basename "$idline")" "$f"; changed=1 ;;
    esac
    # (b) 의존 경로. 서버(postgres)는 libpq를 링크하지 않아 멀쩡하고 클라이언트만 죽는다 — 서버만 보면 놓친다.
    while IFS= read -r dep; do
      case "$dep" in
        "$BUILD_PREFIX"/*) leaf="${dep#"$BUILD_PREFIX"/}"; install_name_tool -change "$dep" "@loader_path/$up$leaf" "$f"; changed=1 ;;
      esac
    done < <(otool -L "$f" 2>/dev/null | sed -n 's/^[[:space:]]\{1,\}\(.*\) (compatibility.*$/\1/p' | sort -u)
    # (c) 번들 밖을 가리키는 LC_RPATH.
    while IFS= read -r rp; do
      [ -n "$rp" ] || continue
      case "$rp" in
        @*|/usr/lib*|/System/Library*) ;;
        *) install_name_tool -delete_rpath "$rp" "$f"; changed=1 ;;
      esac
    done < <(otool -l "$f" 2>/dev/null | awk '/^ *cmd LC_RPATH/{r=1;next} r&&/^ *path /{print $2; r=0}' | sort -u)
    # (d) install_name_tool은 서명을 무효화하고, arm64는 서명 없는 Mach-O를 실행하지 않는다.
    if [ "$changed" = 1 ]; then
      codesign -f -s - "$f" 2>/dev/null || die "재서명 실패: $f"
    fi
  done < <(machos "$root")
}

verify_tree() {
  local root="$1" f dep bad=0 b x
  for b in postgres initdb pg_controldata createdb psql pg_dump pg_restore; do
    [ -x "$root/bin/$b" ] || die "bin/$b 가 없다"
  done
  for x in vector pg_bigm; do
    [ -f "$root/lib/postgresql/$x.dylib" ] || die "lib/postgresql/$x.dylib 가 없다"
    [ -f "$root/share/postgresql/extension/$x.control" ] || die "share/postgresql/extension/$x.control 가 없다"
  done
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    while IFS= read -r dep; do
      case "$dep" in
        @loader_path/*|@rpath/*|/usr/lib/*|/System/Library/*) ;;
        *) echo "  허용되지 않는 의존: $f -> $dep" >&2; bad=1 ;;
      esac
    done < <(otool -L "$f" 2>/dev/null | sed -n 's/^[[:space:]]\{1,\}\(.*\) (compatibility.*$/\1/p')
    codesign --verify "$f" 2>/dev/null || { echo "  서명 검증 실패: $f" >&2; bad=1; }
  done < <(machos "$root")
  [ "$bad" = 0 ] || die "재배치·서명 검사 실패"
  env -i "$root/bin/postgres" --version >/dev/null || die "env -i postgres --version 실패"
  env -i "$root/bin/psql" --version >/dev/null || die "env -i psql --version 실패"
  # 저장소 경로가 산출물에 박히면 packaged 번들의 위생 검사(P1-C11)에서 걸린다. 여기서 먼저 막는다.
  if grep -rlF -- "$REPO" "$root" >/dev/null 2>&1; then
    grep -rlF -- "$REPO" "$root" | head -5 >&2
    die "저장소 절대 경로가 산출물에 있다"
  fi
}

build() {
  local started=$SECONDS src stage destdir pgc xmap pkglib
  mkdir -p "$DL" "$WORK/src"

  say "1. 소스 내려받기 + 체크섬"
  fetch "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" "postgresql-$PG_VERSION.tar.bz2"
  fetch "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz" "pgvector-$PGVECTOR_VERSION.tar.gz"
  fetch "https://github.com/pgbigm/pg_bigm/archive/refs/tags/v$PG_BIGM_VERSION.tar.gz" "pg_bigm-$PG_BIGM_VERSION.tar.gz"
  ( cd "$DL" && grep -v '^[[:space:]]*#' "$SUMS" | grep -v '^[[:space:]]*$' | shasum -a 256 -c - ) || die "체크섬이 다르다"

  say "2. 풀기"
  tar xjf "$DL/postgresql-$PG_VERSION.tar.bz2" -C "$WORK/src"
  tar xzf "$DL/pgvector-$PGVECTOR_VERSION.tar.gz" -C "$WORK/src"
  tar xzf "$DL/pg_bigm-$PG_BIGM_VERSION.tar.gz" -C "$WORK/src"

  say "3. PostgreSQL $PG_VERSION"
  src="$WORK/src/postgresql-$PG_VERSION"
  stage="$WORK/stage"
  destdir="$WORK/destdir"
  # --without-icu     : ICU는 Homebrew에서 오고 번들이 /opt/homebrew에 묶인다. --locale=C로 충분하다.
  # --without-readline: macOS에 없다. psql 줄 편집만 포기한다.
  # --without-zlib    : Phase 0이 검증한 구성 그대로다. pg_dump -Fc는 무압축으로 동작한다 (스펙 §6.5-3).
  # PG_SYSROOT=<없는 경로>: -isysroot가 pg_config·Makefile.global에 CommandLineTools 경로로 박히지 않게 한다.
  ( cd "$src" && PG_SYSROOT=/damwha-no-sysroot ./configure --prefix="$BUILD_PREFIX" \
      --without-icu --without-readline --without-zlib > "$WORK/configure.out" 2>&1 ) \
    || { tail -n 40 "$WORK/configure.out"; die "configure 실패"; }
  ( cd "$src" && make -j"$(sysctl -n hw.ncpu)" > "$WORK/make.out" 2>&1 ) \
    || { tail -n 40 "$WORK/make.out"; die "make 실패"; }
  rm -rf "$destdir" "$stage"
  ( cd "$src" && make install DESTDIR="$destdir" > "$WORK/install.out" 2>&1 ) \
    || { tail -n 40 "$WORK/install.out"; die "make install 실패"; }
  mv "$destdir$BUILD_PREFIX" "$stage"
  rm -rf "$destdir"

  say "4. pgvector $PGVECTOR_VERSION / pg_bigm $PG_BIGM_VERSION"
  pgc="$stage/bin/pg_config"
  # PGXS가 pg_config의 절대 include 경로로 컴파일해 서버 헤더 인라인 함수의 __FILE__이 dylib에 남는다.
  # 이동 전에는 멀쩡하고 이동 뒤에 STALE-PATH가 된다(Phase 0 1차 시도). 중립 prefix로 되돌린다.
  xmap="-fmacro-prefix-map=$stage=$BUILD_PREFIX"
  # pgvector는 기본 CFLAGS에 -march=native를 넣는다. 그대로면 빌드한 맥에서만 도는 바이너리다.
  ( cd "$WORK/src/pgvector-$PGVECTOR_VERSION" \
      && make USE_PGXS=1 PG_CONFIG="$pgc" OPTFLAGS="" PG_CPPFLAGS="$xmap" \
      && make USE_PGXS=1 PG_CONFIG="$pgc" install ) > "$WORK/pgvector.out" 2>&1 \
    || { tail -n 30 "$WORK/pgvector.out"; die "pgvector 빌드 실패"; }
  ( cd "$WORK/src/pg_bigm-$PG_BIGM_VERSION" \
      && make USE_PGXS=1 PG_CONFIG="$pgc" PG_CPPFLAGS="$xmap" \
      && make USE_PGXS=1 PG_CONFIG="$pgc" install ) > "$WORK/pg_bigm.out" 2>&1 \
    || { tail -n 30 "$WORK/pg_bigm.out"; die "pg_bigm 빌드 실패"; }

  say "5. 빌드 전용 산출물 제거"
  # PGXS는 lib/pgxs가 아니라 pkglibdir(lib/postgresql) 아래에 있다. 그 Makefile.global에 빌드 트리 절대
  # 경로와 configure 탐지 결과(/opt/homebrew/bin/openssl 등)가 들어 있다 — Phase 0 1차 시도가 놓친 자리다.
  pkglib=$("$pgc" --pkglibdir)
  rm -rf "$pkglib/pgxs" "$stage/lib/pgxs" "$stage/include" "$stage/lib/pkgconfig"
  rm -f "$stage"/lib/*.a
  [ ! -d "$pkglib/pgxs" ] || die "pgxs를 지우지 못했다: $pkglib/pgxs"

  say "6. 재배치 수정 + ad-hoc 재서명"
  rm -rf "$OUT.tmp"
  mv "$stage" "$OUT.tmp"
  relocate "$OUT.tmp"
  mv "$OUT.tmp" "$OUT"
  say "빌드 $((SECONDS - started))초"
}

stage() {
  # dev 앱이 이 트리의 postgres를 쓰는 중이면 갈아엎지 않는다. 실행 중인 서버의 파일을 지우면 그 서버가
  # 다음 백엔드 fork에서 죽는다.
  if pgrep -f -- "$STAGED/bin/postgres" >/dev/null 2>&1; then
    die "$STAGED/bin/postgres 가 실행 중이다 — 앱을 끄고 다시 실행한다"
  fi
  if [ -f "$STAGED/.build-key" ] && [ "$(cat "$STAGED/.build-key")" = "$KEY" ]; then
    say "이미 스테이징됨: $STAGED ($KEY)"
    return 0
  fi
  mkdir -p "$(dirname "$STAGED")"
  rm -rf "$STAGED.tmp"
  # ditto는 심볼릭 링크와 코드 서명을 그대로 옮긴다.
  ditto "$OUT" "$STAGED.tmp"
  echo "$KEY" > "$STAGED.tmp/.build-key"
  rm -rf "$STAGED"
  mv "$STAGED.tmp" "$STAGED"
  say "스테이징: $STAGED ($(du -sh "$STAGED" | cut -f1))"
}

if [ -f "$DONE" ] && [ -x "$OUT/bin/postgres" ]; then
  say "캐시 적중: $OUT"
else
  rm -rf "$WORK" "$OUT" "$OUT.tmp" "$DONE"
  build
  verify_tree "$OUT"
  touch "$DONE"
fi
stage
```

- [ ] **Step 3: 캐시 디렉터리를 무시한다**

`desktop/.gitignore`를 다음으로 바꾼다:

```gitignore
# pnpm deploy 산출물과 electron-builder 산출물. dist/는 루트 .gitignore가 덮는다.
build/
out/
# build-postgres.sh의 소스·중간 산출물·완성 트리 캐시 (Electron Phase 3 스펙 §6.8).
.cache/
```

- [ ] **Step 4: 첫 빌드를 돌리고 시간을 잰다**

```bash
cd /Users/gim-yeongjae/project/daewha
chmod +x desktop/scripts/build-postgres.sh
time bash desktop/scripts/build-postgres.sh 2>&1 | tail -n 20
du -sh desktop/.cache/postgres desktop/build/postgres
```

Expected: 마지막 줄이 `== 스테이징: …/desktop/build/postgres (약 21M)`이고 exit 0. `real` 시간과 두 `du` 값을 Task 3이 결과 문서에 옮기도록 적어 둔다.

- [ ] **Step 5: 두 번째 실행이 캐시를 쓰는지 확인한다**

```bash
time bash desktop/scripts/build-postgres.sh
```

Expected: `== 캐시 적중: …`와 `== 이미 스테이징됨: …`, 10초 이내.

- [ ] **Step 6: 스테이징된 트리로 서버를 한 번 띄워 본다 (스크래치)**

```bash
PG=/Users/gim-yeongjae/project/daewha/desktop/build/postgres/bin
T=$(mktemp -d /tmp/dwp3t1.XXXX)
mkdir -m 700 "$T/run"
env -i LC_ALL=C "$PG/initdb" -D "$T/pg" -U damwha --encoding=UTF8 --locale=C --auth-local=trust --auth-host=reject >/dev/null
env -i LC_ALL=C "$PG/postgres" -D "$T/pg" -c listen_addresses= -c "unix_socket_directories=$T/run" -c unix_socket_permissions=0700 > "$T/stderr.txt" 2>&1 &
PM=$!
for i in $(seq 1 50); do [ -S "$T/run/.s.PGSQL.5432" ] && break; sleep 0.1; done
env -i LC_ALL=C "$PG/psql" -X -h "$T/run" -U damwha -d postgres -Atc "CREATE EXTENSION vector; CREATE EXTENSION pg_bigm; SELECT likequery('예산'), '[1,0]'::vector <=> '[0,1]'::vector, current_setting('listen_addresses') = ''"
kill -INT "$PM"; wait "$PM"
rm -rf "$T"
```

Expected: psql 출력 마지막 줄이 `%예산%|1|t`. `wait`가 돌아온다.

- [ ] **Step 7: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/build-postgres.sh desktop/scripts/postgres-checksums.txt desktop/.gitignore
git commit -F - <<'MSG'
build(desktop): 내장 PostgreSQL 트리를 소스에서 빌드하는 스크립트를 더한다

Phase 0 pg/build.sh의 조작을 그대로 옮겼다 — 중립 prefix와 DESTDIR, ICU·readline·zlib off,
pgvector의 -march=native 제거, 확장의 -fmacro-prefix-map, pgxs 제거, install_name 재작성과
ad-hoc 재서명. 캐시 키에 스크립트 자신의 sha를 넣어 조작을 고치면 다시 빌드한다.

서버만 확인하면 클라이언트가 전부 죽은 트리를 통과시킨다(R-2b). 완성 트리마다 env -i로
postgres와 psql을 둘 다 부르고, 모든 Mach-O의 의존과 서명, 저장소 경로 문자열을 본다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 4: exit 0, `desktop/build/postgres/bin/`에 일곱 바이너리.
- Step 5: 캐시 적중 두 줄.
- Step 6: `%예산%|1|t`.
- `for f in $(find desktop/build/postgres -type f | xargs file | grep Mach-O | cut -d: -f1); do otool -L "$f" | tail -n +2; done | grep -vE '@loader_path/|@rpath/|/usr/lib/|/System/Library/' | grep -v '^$'` → 출력 0줄.
- `git status --short` → 위 세 파일 외에 추적 대상 변경 없음(`desktop/.cache`·`desktop/build`는 무시됨).

**Review:**
- Phase 0 `pg/build.sh`의 3~8단계 조작이 **하나도 빠지거나 바뀌지 않았는가.** 태그에서 `git show "archive/electron-phase-0-packaging-validation:experiments/electron-phase-0/pg/build.sh"`로 대조한다. 특히 `OPTFLAGS=""`, `-fmacro-prefix-map`, `pkglibdir/pgxs` 제거, `PG_SYSROOT`.
- `verify_tree`가 `postgres`와 `psql`을 **둘 다** `env -i`로 부르는가.
- 캐시 키에 스크립트 sha가 들어가는가. `stage`가 실행 중인 트리를 덮지 않는가.
- 스크립트가 `desktop/.cache`·`desktop/build/postgres` 밖을 지우지 않는가(`rm -rf` 대상 전수 확인).

---

## Task 2: 마이그레이션 러너 — `--status`와 advisory lock (제품 코드 변경 1)

스펙 §6.5-1·§6.5-4·§10. 데스크톱의 실행 게이트가 `migrate.js`에서 받을 두 가지 — 상태 한 줄 JSON, 겹친 러너의 상호 배제.

**Files:**
- Modify: `be/src/database/migrate.ts` (전체 교체)
- Create: `be/test/migrate-status.spec.ts`
- Modify: `be/CLAUDE.md` (마이그레이션 설명에 한 문단)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export interface MigrationStatus { applied: number; pending: string[]; unknown: string[] }`
  - `export async function migrationStatus(pool: Pool): Promise<MigrationStatus>`
  - `export async function listPendingMigrations(pool: Pool): Promise<string[]>` (시그니처 불변)
  - `export async function runMigrations(pool: Pool): Promise<void>` (시그니처 불변, 이제 락을 쥔다)
  - `export async function runCli(argv: readonly string[], pool: Pool, write: (line: string) => void): Promise<void>`
  - CLI 계약: `node dist/database/migrate.js [--status]` → stdout 마지막 줄이 `{"applied":N,"pending":[…],"unknown":[…]}` + `\n`, exit 0. 인자 없으면 적용한 **뒤의** 상태를 찍는다. Task 8이 이 줄을 파싱한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/migrate-status.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { startTestDb, StartedTestDb } from './db';
import { migrationStatus, runCli, runMigrations } from '../src/database/migrate';

const FILES = fs
  .readdirSync(path.join(__dirname, '..', 'src', 'database', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('migrate — status, runner lock, CLI line', () => {
  let db: StartedTestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db?.stop();
  });

  /** startTestDb의 DB는 이미 적용돼 있다. 빈 DB가 필요한 테스트는 같은 컨테이너에 새로 만든다. */
  async function freshDatabase(name: string): Promise<{ url: string; pool: Pool }> {
    await db.pool.query(`CREATE DATABASE ${name}`);
    const url = new URL(db.url);
    url.pathname = `/${name}`;
    return { url: url.toString(), pool: new Pool({ connectionString: url.toString() }) };
  }

  it('reports every file as pending on a database without _migrations', async () => {
    const { pool } = await freshDatabase('status_fresh');
    try {
      expect(await migrationStatus(pool)).toEqual({ applied: 0, pending: FILES, unknown: [] });
    } finally {
      await pool.end();
    }
  });

  it('reports nothing pending once everything is applied', async () => {
    expect(await migrationStatus(db.pool)).toEqual({ applied: FILES.length, pending: [], unknown: [] });
  });

  it('lists applied names the bundle does not know as unknown', async () => {
    // 데스크톱 게이트가 "더 새 버전의 앱이 올린 DB"를 거부하는 근거다 (스펙 §6.5-2).
    const { pool } = await freshDatabase('status_unknown');
    try {
      await runMigrations(pool);
      await pool.query(`INSERT INTO _migrations(name) VALUES ('999_from_future.sql')`);
      expect(await migrationStatus(pool)).toEqual({
        applied: FILES.length + 1,
        pending: [],
        unknown: ['999_from_future.sql'],
      });
    } finally {
      await pool.end();
    }
  });

  it('lets two overlapping runners both succeed and applies each file once', async () => {
    // 락이 없으면 둘 다 같은 파일을 미적용으로 보고 늦은 쪽이 already exists로 실패한다 — 적용은 끝났는데
    // 게이트가 실패를 띄운다 (스펙 §6.5-4).
    const { url, pool: a } = await freshDatabase('status_overlap');
    const b = new Pool({ connectionString: url });
    try {
      await Promise.all([runMigrations(a), runMigrations(b)]);
      const { rows } = await a.query<{ n: number }>('SELECT count(*)::int AS n FROM _migrations');
      expect(rows[0].n).toBe(FILES.length);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('prints exactly one JSON line — the state alone with --status, the state after applying without it', async () => {
    const { pool } = await freshDatabase('status_cli');
    const lines: string[] = [];
    try {
      await runCli(['--status'], pool, (l) => lines.push(l));
      await runCli([], pool, (l) => lines.push(l));
      expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        { applied: 0, pending: FILES, unknown: [] },
        { applied: FILES.length, pending: [], unknown: [] },
      ]);
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/migrate-status.spec.ts`
Expected: FAIL — `migrationStatus`·`runCli`가 export되지 않아 TS 컴파일 오류(`has no exported member 'migrationStatus'`).

- [ ] **Step 3: `migrate.ts`를 교체한다**

`be/src/database/migrate.ts`:

```ts
import 'dotenv/config';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { loadEnv } from '../config/env';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * 러너끼리의 상호 배제 키(pg_advisory_lock). 값에 뜻은 없다 — 다른 advisory lock과 겹치지 않는 고정값이면 된다.
 *
 * 데스크톱 앱은 러너를 자식으로 띄우는데, 앱 main이 죽으면 그 러너가 살아남고 다음 실행이 러너를 또 띄운다
 * (Electron Phase 3 스펙 §6.5-4). 락이 없으면 둘 다 같은 파일을 미적용으로 보고 늦은 쪽이 `already exists`로
 * 실패해, 적용은 끝났는데 실패가 보고된다.
 */
const MIGRATION_LOCK_KEY = 4_815_162_342;

function migrationFiles(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export interface MigrationStatus {
  /** `_migrations` 행 수. 테이블이 없으면 0. */
  applied: number;
  /** 아직 적용되지 않은 파일명(정렬). */
  pending: string[];
  /** `_migrations`에는 있는데 이 트리에 `.sql`이 없는 이름(정렬) — 더 새 코드가 올린 스키마다. */
  unknown: string[];
}

export async function migrationStatus(pool: Pool): Promise<MigrationStatus> {
  const files = migrationFiles();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('_migrations') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return { applied: 0, pending: files, unknown: [] };
  const applied = (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name);
  const done = new Set(applied);
  const known = new Set(files);
  return {
    applied: applied.length,
    pending: files.filter((f) => !done.has(f)),
    unknown: applied.filter((n) => !known.has(n)).sort(),
  };
}

/** 아직 `_migrations`에 기록되지 않은 파일명(정렬). 테이블 자체가 없으면 전부. */
export async function listPendingMigrations(pool: Pool): Promise<string[]> {
  return (await migrationStatus(pool)).pending;
}

export async function runMigrations(pool: Pool): Promise<void> {
  // 세션 단위 락이라 한 연결에서 쥐고, 같은 연결로 미적용을 다시 계산하고 적용한다.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS _migrations (
           name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      for (const file of migrationFiles()) {
        const done = await client.query('SELECT 1 FROM _migrations WHERE name=$1', [file]);
        if (done.rowCount) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations(name) VALUES($1)', [file]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    } finally {
      // 연결이 이미 끊겼으면 락도 함께 풀렸다. 여기서 던지면 원래 오류를 덮는다.
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * CLI 본문. `--status`면 상태만, 아니면 적용한 **뒤의** 상태를 한 줄 JSON으로 쓴다. 데스크톱 앱의 실행 게이트는
 * 이 줄을 파싱할 수 있어야 통과한다 — 러너가 아무것도 하지 않고 exit 0으로 끝나는 경우를 성공으로 읽지 않기
 * 위해서다 (Electron Phase 3 스펙 §10).
 */
export async function runCli(argv: readonly string[], pool: Pool, write: (line: string) => void): Promise<void> {
  if (!argv.includes('--status')) await runMigrations(pool);
  write(`${JSON.stringify(await migrationStatus(pool))}\n`);
}

if (require.main === module) {
  const pool = new Pool({ connectionString: loadEnv().DATABASE_URL });
  runCli(process.argv.slice(2), pool, (line) => process.stdout.write(line))
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `pnpm --filter damwha-be exec jest test/migrate-status.spec.ts test/migration.spec.ts test/database.service.spec.ts`
Expected: PASS — 세 스위트. `migration.spec.ts`와 `database.service.spec.ts`는 기존 그대로 통과한다(`runMigrations`·`listPendingMigrations` 시그니처 불변).

- [ ] **Step 5: 락이 실제로 지키는지 변이로 확인한다**

Step 3의 파일을 보관하고, `runMigrations`의 `pg_advisory_lock` 호출 줄과 `pg_advisory_unlock` 호출 줄을 임시로 주석 처리한 뒤 겹침 테스트만 3회 돌리고 원래대로 되돌린다.

```bash
cd /Users/gim-yeongjae/project/daewha
cp be/src/database/migrate.ts /tmp/dwp3-migrate.bak
sed -i '' -e "s|^\(.*pg_advisory_lock(\$1::bigint)\)|// MUTATION \1|" -e "s|^\(.*pg_advisory_unlock(\$1::bigint)\)|// MUTATION \1|" be/src/database/migrate.ts
grep -c "MUTATION" be/src/database/migrate.ts   # 2
for i in 1 2 3; do pnpm --filter damwha-be exec jest test/migrate-status.spec.ts -t overlapping 2>&1 | grep -E "Tests:|✕|✓"; done
cp /tmp/dwp3-migrate.bak be/src/database/migrate.ts && rm /tmp/dwp3-migrate.bak
grep -c "MUTATION" be/src/database/migrate.ts   # 0
```

Expected: 3회 중 1회 이상 `✕ lets two overlapping runners…`(`duplicate key`·`already exists`·`pg_extension_name_index`류). **3회 모두 통과하면** 경쟁이 재현되지 않은 것이므로 그 사실과 출력을 결과 문서 §3에 적고 리뷰가 판단하게 한다. 되돌린 뒤 Step 4를 다시 돌려 PASS를 확인한다.

- [ ] **Step 6: CLI를 실제 프로세스로 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm --filter damwha-be run build >/dev/null
node -e "const s=require('fs').readFileSync('be/src/database/migrate.ts','utf8'); if(!s.includes('require.main === module')) process.exit(1)"
```

Expected: exit 0 — `deploy/api.Dockerfile:72`의 `node dist/database/migrate.js`가 쓰는 진입 방식이 남아 있다.

- [ ] **Step 7: `be/CLAUDE.md`에 계약을 적는다**

`be/CLAUDE.md`에서 `_migrations`를 설명하는 문단(`grep -n "_migrations" be/CLAUDE.md`로 찾는다) 바로 뒤에 다음 문단을 넣는다:

```markdown
- **`migrate.ts`의 CLI 출력은 데스크톱 앱과의 계약이다.** `node dist/database/migrate.js [--status]`(dev는 `pnpm be:migrate [-- --status]`)는 stdout 마지막 줄에 `{"applied":N,"pending":[…],"unknown":[…]}`를 찍는다 — `--status`면 상태만, 인자가 없으면 적용한 **뒤의** 상태다. Electron 앱의 마이그레이션 게이트(`desktop/src/services/migration-gate.ts`)가 이 줄을 파싱할 수 있어야 통과하고, `unknown`이 비어 있지 않으면(더 새 코드가 올린 스키마) 거부한다. `runMigrations`는 한 연결에서 `pg_advisory_lock`을 쥐고 적용한다 — 앱이 죽어 살아남은 러너와 다음 실행의 러너가 겹쳐도 파일마다 한 번만 적용된다. `test/migrate-status.spec.ts`가 셋을 고정한다.
```

- [ ] **Step 8: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm --filter damwha-be run build   # be에는 lint 스크립트가 없다 — nest build의 tsc가 타입 검사다
git add be/src/database/migrate.ts be/test/migrate-status.spec.ts be/CLAUDE.md
git commit -F - <<'MSG'
feat(be): 마이그레이션 러너가 상태를 한 줄 JSON으로 말하고 advisory lock을 쥔다

데스크톱 앱이 마이그레이션을 실행하게 되면서(Electron Phase 3) 두 가지가 필요해졌다. 게이트가
러너의 결과를 파싱할 수 있어야 무출력 exit 0을 성공으로 읽지 않고, 앱이 죽어 살아남은 러너와
다음 러너가 겹쳐도 같은 파일을 두 번 적용하지 않아야 한다.

`--status`는 상태만, 인자 없으면 적용한 뒤의 상태를 찍는다. `unknown`은 이 트리에 없는 적용된
이름이다 — 옛 코드가 새 스키마를 여는 것을 앱이 거부하는 근거다. listPendingMigrations와
runMigrations의 시그니처는 그대로라 API의 경고와 Docker 배포의 진입점이 바뀌지 않는다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 4 PASS(세 스위트), Step 5의 변이 결과(재현 여부 포함)가 기록됐다, Step 6 exit 0.
- `pnpm --filter damwha-be run build` exit 0(타입 검사).
- `git diff HEAD~1 --stat` → 세 파일.

**Review:**
- `listPendingMigrations`의 **동작**이 그대로인가(테이블 없으면 전부, 정렬). `database.service.ts`의 경고가 이것을 쓴다.
- 락을 쥔 **같은 연결**로 미적용을 다시 계산하고 적용하는가. 풀에서 연결을 따로 빌리면 락이 아무것도 지키지 않는다.
- `finally`의 unlock이 원래 오류를 덮지 않는가.
- `require.main === module` 블록이 남아 Docker 배포 진입점(`deploy/api.Dockerfile:72`)이 동작하는가.
- Step 5의 변이 증거가 제출됐는가. 재현되지 않았다면 그 사실이 적혔는가.

---

## Task 3: 사전 실측 — 번들 PG 위에서 스펙 §12의 미확정을 닫는다

**코드를 남기지 않는다.** 산출물은 결과 문서 §2.4의 측정표이고, 그 값이 Task 5~8·12의 가정을 확인하거나 고친다. 두 항목은 계획 작성 중에 이미 쟀다(결과 문서 §2.4에 있다) — utilityProcess에서 `require.main === module`이 참이고 인자가 `process.argv`로 온다, node-pg와 psycopg가 공백 포함 소켓 URI를 소켓 경로로 해석한다. 여기서는 **실제 서버에 붙는 것**을 잰다.

**Files:**
- Modify: `docs/superpowers/reports/2026-09-14-electron-phase-3-embedded-postgres-results.md` (§2.4)

**Interfaces:**
- Consumes: Task 1의 `desktop/build/postgres`, Task 2의 `migrate.ts`
- Produces: 측정값. 특히 Task 5가 쓰는 `postmaster.pid` 8번째 줄 형식과 `ps -o comm=`·`ps -o args=` 형식, Task 12가 쓰는 `codesign --deep` 영향, 그리고 **C 로캘 판정**(다르면 멈춘다).

**측정 규칙:** 모든 서버는 `/tmp/dwp3.*` 아래 스크래치 클러스터다. 개발 DB(`damwha-postgres`)와 `~/Library/Application Support/Damwha`는 건드리지 않는다. Docker는 Step 5에서 **임시 컨테이너**(`--rm`, 볼륨 없음, 이름 `dw-p3-locale`)로만 쓴다.

- [ ] **Step 1: 공백 포함 경로에 스크래치 클러스터를 띄우고 준비 신호를 잰다**

```bash
PG=/Users/gim-yeongjae/project/daewha/desktop/build/postgres/bin
R=$(mktemp -d /tmp/dwp3.XXXX); M="$R/App Support"
mkdir -p "$M/logs"; mkdir -m 700 "$M/run"
time env -i LC_ALL=C "$PG/initdb" -D "$M/pg" -U damwha --encoding=UTF8 --locale=C --auth-local=trust --auth-host=reject > "$M/initdb.txt"
env -i LC_ALL=C "$PG/pg_controldata" -D "$M/pg" | grep 'Database system identifier'
env -i LC_ALL=C "$PG/postgres" -D "$M/pg" -c listen_addresses= -c "unix_socket_directories=$M/run" \
  -c unix_socket_permissions=0700 -c port=5432 -c logging_collector=on -c "log_directory=$M/logs" \
  -c log_filename=postgres-%a.log -c log_rotation_age=1d -c log_rotation_size=10MB -c log_truncate_on_rotation=on \
  > "$M/stderr.txt" 2>&1 &
PM=$!; echo "PM=$PM R=$R"
for i in $(seq 1 60); do sed -n 8p "$M/pg/postmaster.pid" 2>/dev/null | cat -e; sleep 0.05; done | uniq
ls -la "$M/run"; stat -f '%Lp' "$M/run/.s.PGSQL.5432"
ps -o comm= -p "$PM"; ps -o args= -p "$PM"
lsof -nP -a -p "$PM" -iTCP 2>/dev/null | wc -l
```

적는 것: `initdb` 시간, `Database system identifier:` 줄의 정확한 모양, 8번째 줄의 값 변화(예: `starting$` → `ready   $`), 소켓 권한, `ps -o comm=`의 출력(전체 경로인가 이름뿐인가), `ps -o args=`에 `-D <공백 포함 경로>`가 어떻게 나오는가, TCP 소켓 수(0이어야 한다).

**`ps -o comm=`이 전체 경로가 아니거나 `ps -o args=`가 `-D` 값을 그대로 보여주지 않으면** Task 5 `classifyLockOwner`의 판정 입력을 실제 형식에 맞게 고치고(계획 수정) 결과 문서에 적는다.

- [ ] **Step 2: node-pg·`migrate.ts`·psycopg가 그 소켓에 붙는지 잰다**

```bash
cd /Users/gim-yeongjae/project/daewha
env -i LC_ALL=C "$PG/createdb" -h "$M/run" -U damwha damwha
export DATABASE_URL="postgresql://damwha@/damwha?host=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$M/run")"
pnpm --filter damwha-be run migrate -- --status | tail -n 1
pnpm --filter damwha-be run migrate | tail -n 1
uv run --directory be/worker python -c "import os, psycopg; c = psycopg.connect(os.environ['DATABASE_URL']); print(c.execute(\"select current_database(), inet_client_addr() is null, current_setting('lc_collate'), (select count(*) from _migrations)\").fetchone())"
unset DATABASE_URL
```

Expected: 첫 줄 `{"applied":0,"pending":[…24개…],"unknown":[]}`, 둘째 줄 `{"applied":24,"pending":[],"unknown":[]}`, psycopg `('damwha', True, 'C', 24)`. `pnpm … -- --status`에서 pnpm이 `--`를 그대로 넘기는지(여전히 `--status`로 동작하는지)도 적는다.

- [ ] **Step 3: 준비 신호의 종료 쪽과 postmaster `SIGKILL` 뒤를 잰다**

```bash
kill -KILL "$PM"; sleep 1
pgrep -fl -- "$M/pg" || echo "자식 없음"
sed -n 1p "$M/pg/postmaster.pid"; ls "$M/run"
env -i LC_ALL=C "$PG/postgres" -D "$M/pg" -c listen_addresses= -c "unix_socket_directories=$M/run" -c unix_socket_permissions=0700 > "$M/stderr2.txt" 2>&1 &
PM=$!
for i in $(seq 1 100); do L=$(sed -n 8p "$M/pg/postmaster.pid" 2>/dev/null); [ "$L" = "ready   " ] && break; sleep 0.1; done
echo "restart pm=$PM status=[$L]"; cat "$M/stderr2.txt" | head -20
kill -INT "$PM"
for i in $(seq 1 50); do sed -n 8p "$M/pg/postmaster.pid" 2>/dev/null | cat -e; kill -0 "$PM" 2>/dev/null || break; sleep 0.05; done | uniq
wait "$PM" 2>/dev/null; echo "exit=$?"
ls "$M/run"; grep -h "shutdown\|shut down\|recovery" "$M/logs"/*.log "$M/stderr2.txt" | tail -n 8
```

적는 것: SIGKILL 뒤 백엔드 자식이 사라지는 시간, 재기동이 **거절됐는가**(`pre-existing shared memory block`·`lock file` 문구) 또는 recovery 뒤 `ready`에 닿았는가, SIGINT 중의 8번째 줄 값(`stopping`), 종료 뒤 소켓 파일이 사라지는가, `received fast shutdown request` 문구. 이것이 Phase 0의 미실측 주장(R3-9)에 대한 첫 답이다 — P3-C15가 실앱에서 다시 판정한다.

- [ ] **Step 4: 백업 크기와 `pg_restore --list`를 잰다**

Step 3에서 내렸으므로 다시 띄우고 발화 1,500건 + 임베딩 1,500건을 넣는다.

```bash
env -i LC_ALL=C "$PG/postgres" -D "$M/pg" -c listen_addresses= -c "unix_socket_directories=$M/run" -c unix_socket_permissions=0700 > /dev/null 2>&1 &
PM=$!; for i in $(seq 1 100); do [ -S "$M/run/.s.PGSQL.5432" ] && break; sleep 0.1; done; sleep 0.5
env -i LC_ALL=C "$PG/psql" -X -h "$M/run" -U damwha -d damwha -q <<'SQL'
INSERT INTO meeting(title, audio_key) VALUES ('실측 회의', 'meetings/mtg_1/original.m4a');
INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, order_index, processing_version, text)
  SELECT 'mtg_1', 'SPEAKER_00', g*1000, g*1000+900, g, 0, '예산 검토 회의 발화 ' || g FROM generate_series(1, 1500) g;
INSERT INTO utterance_embedding(utterance_id, embedding, model, dimension, processing_version)
  SELECT u.id, (SELECT ('[' || string_agg(random()::text, ',') || ']') FROM generate_series(1, 1024))::vector, 'BAAI/bge-m3', 1024, 0
  FROM utterance u;
SQL
time env -i LC_ALL=C "$PG/pg_dump" -h "$M/run" -U damwha -Fc -f "$M/test.dump.partial" damwha
ls -l "$M/test.dump.partial"
env -i LC_ALL=C "$PG/pg_restore" --list "$M/test.dump.partial" | head -n 5; echo "list exit=${PIPESTATUS[0]}"
kill -INT "$PM"; wait "$PM" 2>/dev/null
```

적는 것: 덤프 시간·크기, `pg_restore --list` exit 0, 경고 문구(압축 관련) 유무.

- [ ] **Step 5: C 로캘이 키워드 검색·정렬을 Docker 이미지와 다르게 만드는지 잰다 — 판정 게이트**

같은 이미지(`damwha/postgres-bigm:pg16`, 기본 로캘)로 **임시** 컨테이너를 띄워 같은 자료로 같은 질의를 돌린다.

```bash
cd /Users/gim-yeongjae/project/daewha
docker run --rm -d --name dw-p3-locale -e POSTGRES_PASSWORD=p3 -e POSTGRES_DB=damwha -p 127.0.0.1:55433:5432 damwha/postgres-bigm:pg16
sleep 8
DOCKER_URL=postgres://postgres:p3@127.0.0.1:55433/damwha
DATABASE_URL="$DOCKER_URL" pnpm --filter damwha-be run migrate | tail -n 1
docker exec dw-p3-locale psql -U postgres -d damwha -Atc "show lc_collate; show lc_ctype"

env -i LC_ALL=C "$PG/postgres" -D "$M/pg" -c listen_addresses= -c "unix_socket_directories=$M/run" -c unix_socket_permissions=0700 > /dev/null 2>&1 &
PM=$!; for i in $(seq 1 100); do [ -S "$M/run/.s.PGSQL.5432" ] && break; sleep 0.1; done; sleep 0.5

cat > "$R/fixture.sql" <<'SQL'
DELETE FROM utterance_embedding; DELETE FROM utterance; DELETE FROM meeting;
INSERT INTO meeting(id, title, audio_key) VALUES
  ('mtg_901', '가을 예산 회의', 'k1'), ('mtg_902', 'Budget review', 'k2'), ('mtg_903', 'ábaco 점검', 'k3'),
  ('mtg_904', '나눔 워크숍', 'k4'), ('mtg_905', 'zeta 정리', 'k5'), ('mtg_906', 'Éclair 회고', 'k6');
INSERT INTO utterance(meeting_id, diar_label, start_ms, end_ms, order_index, processing_version, text) VALUES
  ('mtg_901','S',0,1,0,0,'올해 예산을 다시 검토하겠습니다'), ('mtg_901','S',1,2,1,0,'예산안 초안은 다음 주에 나옵니다'),
  ('mtg_902','S',0,1,0,0,'Budget 예산 line items'), ('mtg_903','S',0,1,0,0,'50% 절감 목표를 세웠어요'),
  ('mtg_904','S',0,1,0,0,'재무팀이 비용 절감안을 검토하고 있습니다'), ('mtg_905','S',0,1,0,0,'예 산 이라고 띄어 쓴 경우'),
  ('mtg_906','S',0,1,0,0,'ÉCLAIR éclair Éclair');
SQL
cat > "$R/queries.sql" <<'SQL'
SELECT 'kw1', u.text, round(bigm_similarity(u.text, '예산')::numeric, 6) FROM utterance u
  WHERE u.status='ok' AND u.text IS NOT NULL AND u.text LIKE likequery('예산') ORDER BY bigm_similarity(u.text, '예산') DESC, u.id;
SELECT 'kw2', u.text FROM utterance u WHERE u.text LIKE likequery('50% 절감') ORDER BY u.id;
SELECT 'kw3', u.text FROM utterance u WHERE u.text LIKE likequery('éclair') ORDER BY u.id;
SELECT 'ord', title FROM meeting ORDER BY title;
SELECT 'case', lower('ÉCLAIR 예산'), upper('éclair');
SQL
env -i LC_ALL=C "$PG/psql" -X -h "$M/run" -U damwha -d damwha -q -f "$R/fixture.sql"
env -i LC_ALL=C "$PG/psql" -X -h "$M/run" -U damwha -d damwha -At -f "$R/queries.sql" > "$R/embedded.txt"
psql_docker() { docker exec -i dw-p3-locale psql -U postgres -d damwha "$@"; }
psql_docker -q < "$R/fixture.sql"
psql_docker -At < "$R/queries.sql" > "$R/docker.txt"
diff "$R/docker.txt" "$R/embedded.txt"; echo "diff exit=$?"

kill -INT "$PM"; wait "$PM" 2>/dev/null
docker stop dw-p3-locale
```

**판정:**
- `kw1`·`kw2`·`kw3` 줄이 두 파일에서 **같다** → 키워드 검색은 로캘의 영향을 받지 않는다. 진행한다.
- `kw*` 줄이 **하나라도 다르다** → **여기서 멈춘다.** 두 파일을 결과 문서에 붙이고 사용자에게 보고한다. 스펙 §12의 "다르면 구현 전에 스펙으로 돌아와 로캘을 다시 정한다"가 발동한 것이다.
- `ord`·`case` 줄이 다르면(예상: C는 코드포인트 순, `lower`가 비ASCII를 접지 않는다) 그 차이를 적는다. 제품에서 제목 정렬·대소문자 접기를 쓰는 곳을 `grep -rn "ORDER BY .*title\|lower(\|ILIKE" be/src`로 찾아 영향이 있는지 함께 적는다. 영향이 있으면 멈추고 보고한다.

- [ ] **Step 6: 최종 `codesign --deep`이 Resources의 개별 서명을 유지하는지 잰다**

```bash
A="$R/Skel.app"
mkdir -p "$A/Contents/MacOS" "$A/Contents/Resources"
cp /usr/bin/true "$A/Contents/MacOS/Skel"
plutil -create xml1 "$A/Contents/Info.plist"
plutil -insert CFBundleExecutable -string Skel "$A/Contents/Info.plist"
plutil -insert CFBundleIdentifier -string kr.damwha.p3probe "$A/Contents/Info.plist"
ditto /Users/gim-yeongjae/project/daewha/desktop/build/postgres "$A/Contents/Resources/postgres"
codesign --force --deep --sign - "$A"
codesign --verify --deep --strict "$A"; echo "app verify=$?"
codesign --verify "$A/Contents/Resources/postgres/bin/psql"; echo "psql verify=$?"
codesign -dv "$A/Contents/Resources/postgres/lib/libpq.5.dylib" 2>&1 | grep -E 'Signature|Identifier'
env -i "$A/Contents/Resources/postgres/bin/psql" --version
env -i "$A/Contents/Resources/postgres/bin/postgres" --version
```

적는 것: 넷의 exit와 출력. `psql`·`postgres`가 실행되지 않으면 Task 12의 `package.mjs`에 "재서명 뒤 PG 트리 Mach-O를 다시 ad-hoc 서명" 단계를 더하도록 계획을 고친다.

- [ ] **Step 7: 스크래치를 정리하고 결과를 기록한다**

```bash
pgrep -fl -- "$R" && echo "남은 프로세스가 있다 — kill -INT로 내린다" || rm -rf "$R"
docker ps -a --filter name=dw-p3-locale --format '{{.Names}}'   # 빈 출력이어야 한다
```

결과 문서 §2.4(계획 작성 중 실측 두 행이 이미 있는 표)에 Step 1~6의 값을 행으로 더한다. 각 행은 "항목 / 측정값 / 이 값이 확인하거나 바꾼 계획 가정"이다. Task 1 Step 4의 빌드 시간·캐시 크기도 여기 옮긴다.

```bash
cd /Users/gim-yeongjae/project/daewha
git add docs/superpowers/reports/2026-09-14-electron-phase-3-embedded-postgres-results.md
git commit -F - <<'MSG'
docs: Phase 3 사전 실측 — 번들 PG의 준비 신호·소켓 접속·C 로캘·백업·서명

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- 결과 문서 §2.4에 Step 1~6 각각의 값이 있다. Step 5의 `diff exit` 값과 판정이 있다.
- `docker ps -a --filter name=dw-p3-locale` → 비어 있다. `docker ps --filter name=damwha-postgres`의 컨테이너 생성 시각이 실측 전후로 같다.
- `ls ~/Library/Application\ Support/Damwha` → `data`·`run`·`backups`가 **없다**(측정이 실제 userData에 쓰지 않았다).

**Review:**
- Step 5의 판정이 규칙대로 내려졌는가. `kw*`가 달랐는데 진행하지 않았는가.
- Step 1의 `ps` 형식이 Task 5의 가정과 맞는가. 다르면 계획이 고쳐졌는가.
- 측정에 쓴 모든 서버가 내려갔고 임시 컨테이너가 사라졌는가.
- 개발 DB에 어떤 명령도 보내지 않았는가(`DATABASE_URL`이 `55433` 임시 컨테이너 또는 스크래치 소켓만 가리켰는가).

---

## Task 4: 서비스 계약 확장 — 복구 부류와 기동 중단 신호

스펙 §1(계약의 두 추가)·§6.4 "기동 중단"·§6.7. Phase 2 어댑터의 동작은 바꾸지 않는다 — 부류 없는 실패는 지금처럼 `auto`로 읽힌다.

**Files:**
- Modify: `desktop/src/services/types.ts`
- Create: `desktop/src/services/failure.ts`
- Modify: `desktop/src/services/supervisor.ts`
- Create: `desktop/src/retry-policy.ts`
- Modify: `desktop/src/main.ts` (타입만 — `bins`에서 docker 제거, `ctx` 타입)
- Modify(테스트 ctx 헬퍼): `desktop/tests/supervisor.test.ts`, `desktop/tests/embed-spec.test.ts`, `desktop/tests/launch-with-uv.test.ts`, `desktop/tests/worker-spec.test.ts`, `desktop/tests/status-view.test.ts`, `desktop/tests/config-reload.test.ts`
- Create: `desktop/tests/failure.test.ts`, `desktop/tests/retry-policy.test.ts`
- Test: `desktop/tests/supervisor.test.ts` (추가)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `types.ts`: `export type Recovery = "auto" | "manual"`; `ServiceStatus.recovery?: Recovery`; `ReadinessResult`의 `{ kind: "failed"; detail: string; recovery?: Recovery }`; `LaunchContext.bins: { uv: string | null }`; `LaunchContext.signal: AbortSignal`.
  - `failure.ts`: `export class ServiceFailure extends Error { readonly recovery: Recovery }`, `export function recoveryOf(e: unknown): Recovery | undefined`, `export async function manualUnlessTagged<T>(body: () => Promise<T>): Promise<T>`.
  - `supervisor.ts`: `createSupervisor(specs, ctx: Omit<LaunchContext, "signal">, hooks)` — 감독자가 `signal`을 붙인다. `stopAll`이 가장 먼저 abort한다.
  - `retry-policy.ts`: `export function mayAutoRetry(statuses: readonly ServiceStatus[] | null, thrown?: unknown): boolean`.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — `failure.ts`와 `retry-policy.ts`**

`desktop/tests/failure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { manualUnlessTagged, recoveryOf, ServiceFailure } from "../src/services/failure";

describe("ServiceFailure", () => {
  it("carries its recovery class and message", () => {
    const e = new ServiceFailure("짝이 맞지 않아요", "manual");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("짝이 맞지 않아요");
    expect(recoveryOf(e)).toBe("manual");
  });

  it("has no class for a plain error — the supervisor reads that as auto (Phase 2 adapters)", () => {
    expect(recoveryOf(new Error("x"))).toBeUndefined();
    expect(recoveryOf("x")).toBeUndefined();
  });
});

describe("manualUnlessTagged", () => {
  it("turns an unexpected error into a manual failure — new code paths must not leak into auto retry", async () => {
    // 스펙 §6.7(외부 리뷰 #2). 도구의 낯선 종료 코드나 카탈로그에 없는 initdb 문구가 20초마다 다시 돌면 안 된다.
    const r = manualUnlessTagged(async () => {
      throw new Error("알 수 없는 initdb 출력");
    });
    await expect(r).rejects.toBeInstanceOf(ServiceFailure);
    await expect(r).rejects.toMatchObject({ recovery: "manual", message: "알 수 없는 initdb 출력" });
  });

  it("keeps an explicit auto tag", async () => {
    const r = manualUnlessTagged(async () => {
      throw new ServiceFailure("잠깐 기다리면 풀려요", "auto");
    });
    await expect(r).rejects.toMatchObject({ recovery: "auto" });
  });

  it("passes the value through", async () => {
    await expect(manualUnlessTagged(async () => 7)).resolves.toBe(7);
  });
});
```

`desktop/tests/retry-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mayAutoRetry } from "../src/retry-policy";
import { ServiceFailure } from "../src/services/failure";
import type { ServiceStatus } from "../src/services/types";

const st = (over: Partial<ServiceStatus>): ServiceStatus => ({
  id: "postgres",
  process: "failed",
  health: "unknown",
  owned: true,
  restarts: 0,
  ...over,
});

describe("mayAutoRetry", () => {
  it("retries a failure that carries no class — Phase 2's recovery paths stay as they were", () => {
    expect(mayAutoRetry([st({ detail: "프로세스가 종료됐어요 (코드 1)." })])).toBe(true);
  });

  it("retries an explicit auto failure", () => {
    expect(mayAutoRetry([st({ recovery: "auto" })])).toBe(true);
  });

  it("does not retry when any failed service needs a person — a migration failure must not rerun every 20 seconds", () => {
    // Phase 2 결과 §5.2-1. 그대로 두면 마이그레이션이 20초마다 재실행되고 백업이 하나씩 쌓인다.
    expect(mayAutoRetry([st({ recovery: "manual" }), st({ id: "api", process: "stopped" })])).toBe(false);
  });

  it("ignores a manual tag left on a service that is no longer failed", () => {
    expect(mayAutoRetry([st({ process: "running", health: "ok", recovery: "manual" })])).toBe(true);
  });

  it("does not retry a manual failure thrown before the supervisor exists", () => {
    expect(mayAutoRetry(null, new ServiceFailure("번들에 PG가 없어요", "manual"))).toBe(false);
    expect(mayAutoRetry(null, new Error("저장소 폴더를 확인하지 못했어요."))).toBe(true);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/failure.test.ts tests/retry-policy.test.ts`
Expected: FAIL — `Failed to resolve import "../src/services/failure"`.

- [ ] **Step 3: 타입과 두 모듈을 쓴다**

`desktop/src/services/types.ts`에서 다음을 바꾼다.

`HealthState` 정의 바로 뒤에 더한다:

```ts
/**
 * 실패를 사람 손 없이 다시 시도해도 되는가 (Phase 3 스펙 §6.7). 없으면 auto로 읽는다 — Phase 2의 어댑터는 이 값을
 * 붙이지 않고, 그 복구 경로(Docker를 켜면 자동 재시도가 진입시키던 것 같은)를 이 추가가 조용히 끄면 안 된다.
 * manual은 마이그레이션 실패·페어링 거부처럼 같은 시도를 반복해도 결과가 같고, 반복이 해로운(백업이 쌓이는) 원인이다.
 */
export type Recovery = "auto" | "manual";
```

`ServiceStatus`의 `restarts: number;` 뒤에 더한다:

```ts
  /** failed일 때만 뜻이 있다. 감독자가 실패의 부류를 여기로 옮기고, 다시 뜨거나 ready가 되면 지운다. */
  recovery?: Recovery;
```

`LaunchContext`의 `bins` 줄을 바꾸고 `signal`을 더한다:

```ts
  bins: { uv: string | null };
  /**
   * 기동 중단 신호. 감독자가 붙이고 stopAll 첫머리에서 abort한다 (Phase 3 스펙 §6.4). 감독자의 준비 유예는 launch()가
   * 반환한 뒤에야 시작하고 stopAll은 진행 중인 기동을 끝까지 기다리므로, launch() 안의 도구(initdb·pg_dump·마이그레이션
   * 러너)가 멈추면 이 신호 없이는 ⌘Q도 멈춘다.
   */
  signal: AbortSignal;
```

`ReadinessResult`의 failed 행을 바꾼다:

```ts
  | { kind: "failed"; detail: string; recovery?: Recovery };
```

`desktop/src/services/failure.ts`:

```ts
import type { Recovery } from "./types";

/**
 * 복구 부류를 싣는 실패. 문구로 부류를 가르지 않는 이유(Phase 3 스펙 §6.7, 외부 리뷰 #2): 카탈로그의 정규식은 원인을
 * 알아볼 때만 맞고, 알아보지 못한 원문은 부류를 잃는다. 새 코드가 던지는 예상 밖의 오류가 그렇게 자동 재시도로 샌다.
 */
export class ServiceFailure extends Error {
  readonly recovery: Recovery;

  constructor(message: string, recovery: Recovery) {
    super(message);
    this.name = "ServiceFailure";
    this.recovery = recovery;
  }
}

export function recoveryOf(e: unknown): Recovery | undefined {
  return e instanceof ServiceFailure ? e.recovery : undefined;
}

/**
 * 본문 전체를 감싸, 명시적으로 부류를 붙이지 않은 실패를 manual로 만든다. postgres 어댑터와 마이그레이션 게이트가
 * 이것으로 launch()를 감싼다 — "명시적으로 auto라고 적은 경로가 아니면 manual"이 스펙의 규칙이다.
 */
export async function manualUnlessTagged<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof ServiceFailure) throw e;
    throw new ServiceFailure(e instanceof Error ? e.message : String(e), "manual");
  }
}
```

`desktop/src/retry-policy.ts`:

```ts
import { recoveryOf } from "./services/failure";
import type { ServiceStatus } from "./services/types";

/**
 * 실패 화면이 자동 재시도 타이머를 걸어도 되는가 (Phase 3 스펙 §6.7).
 *
 * Phase 2의 scheduleRetry는 원인을 받지 않고 게이트가 서지 않으면 무조건 3·8·20초로 재시도했다(Phase 2 결과
 * §5.2-1). 실행 게이트가 생긴 뒤에는 그 루프가 마이그레이션을 20초마다 재실행하고 백업을 하나씩 쌓는다. 실패한
 * 서비스 중 하나라도 manual이면 걸지 않는다 — 사람이 "다시 시도"를 누를 때까지 기다린다. 감독자를 세우기 전에 던진
 * 실패는 그 예외의 부류를 본다.
 */
export function mayAutoRetry(statuses: readonly ServiceStatus[] | null, thrown?: unknown): boolean {
  if (recoveryOf(thrown) === "manual") return false;
  return !(statuses ?? []).some((s) => s.process === "failed" && s.recovery === "manual");
}
```

- [ ] **Step 4: 두 테스트 통과를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/failure.test.ts tests/retry-policy.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: 감독자 테스트를 더한다 (실패 확인용)**

`desktop/tests/supervisor.test.ts` 맨 위 import에 `import { ServiceFailure } from "../src/services/failure";`를 더하고, `ctx()` 헬퍼의 `bins` 줄을 `bins: { uv: "/opt/homebrew/bin/uv" },`로 바꾸고 그 아래에 `signal: new AbortController().signal,`를 더한다. 파일 끝에 다음 describe를 더한다:

```ts
describe("supervisor — recovery class and launch abort (Phase 3)", () => {
  it("copies a manual class from a launch failure onto the status", async () => {
    const s = createSupervisor(
      [spec("postgres", { launch: async () => { throw new ServiceFailure("짝이 맞지 않아요", "manual"); } })],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0]).toMatchObject({ process: "failed", recovery: "manual", detail: "짝이 맞지 않아요" });
  });

  it("copies a manual class from a failed readiness onto the status", async () => {
    const s = createSupervisor(
      [spec("api", { readiness: async () => ({ kind: "failed", detail: "마이그레이션 실패", recovery: "manual" }) })],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0]).toMatchObject({ process: "failed", recovery: "manual" });
  });

  it("leaves the class empty for an untagged failure — Phase 2 adapters keep auto", async () => {
    const s = createSupervisor(
      [spec("api", { launch: async () => { throw new Error("spawn ENOENT"); } })],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0].recovery).toBeUndefined();
  });

  it("clears the class when the service is tried again", async () => {
    let first = true;
    const s = createSupervisor(
      [
        spec("postgres", {
          launch: async () => {
            if (first) {
              first = false;
              throw new ServiceFailure("거부", "manual");
            }
            return { handle: null, owned: true };
          },
        }),
      ],
      ctx(),
      {},
    );
    await s.start();
    expect(s.statuses()[0].recovery).toBe("manual");
    await s.retry();
    expect(s.statuses()[0]).toMatchObject({ process: "running", recovery: undefined });
  });

  it("does not schedule a restart for a manual readiness failure of a background service", async () => {
    // 재시작해도 같은 판정이 나오고(짝이 맞지 않는다), 반복이 도구를 또 부른다.
    const log: string[] = [];
    const s = createSupervisor(
      [
        spec("embed", {
          gate: false,
          readiness: async () => ({ kind: "failed", detail: "거부", recovery: "manual" }),
          restart: { maxAttempts: 3, backoffMs: [1, 1, 1] },
        }),
      ],
      ctx(),
      { log: (l) => void log.push(l) },
    );
    await s.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.statuses()[0]).toMatchObject({ process: "failed", restarts: 0 });
    expect(log.some((l) => l.includes("재시작"))).toBe(false);
  });

  it("aborts ctx.signal at the start of stopAll so a hung launch() cannot hold ⌘Q", async () => {
    // 클로저 안에서 대입하는 let은 TS가 null로 좁혀 버린다. 상자에 담는다.
    const box: { signal?: AbortSignal } = {};
    const s = createSupervisor(
      [
        spec("postgres", {
          launch: (c) =>
            new Promise<LaunchResult>((_, reject) => {
              box.signal = c.signal;
              c.signal.addEventListener("abort", () => reject(new ServiceFailure("중단됨", "manual")));
            }),
        }),
      ],
      ctx(),
      {},
    );
    const starting = s.start();
    await new Promise((r) => setTimeout(r, 10));
    const stopped = await Promise.race([
      s.stopAll({ graceMs: 10 }).then(() => "stopped"),
      new Promise((r) => setTimeout(() => r("hung"), 1_000)),
    ]);
    expect(stopped).toBe("stopped");
    expect(box.signal?.aborted).toBe(true);
    await starting;
  });
});
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/supervisor.test.ts -t "Phase 3"`
Expected: FAIL — `recovery`가 `undefined`, 마지막 테스트가 `"hung"`.

- [ ] **Step 6: 감독자를 고친다**

`desktop/src/services/supervisor.ts`:

(a) import에 `import { recoveryOf } from "./failure";`를 더한다.

(b) `createSupervisor`의 시그니처와 첫머리를 바꾼다:

```ts
export function createSupervisor(
  specs: readonly ServiceSpec[],
  baseCtx: Omit<LaunchContext, "signal">,
  hooks: SupervisorHooks,
) {
  /**
   * 기동 중단 신호 (Phase 3 스펙 §6.4). 호출자의 ctx 객체에 **제자리로** 붙인다 — main.ts는 그 객체의 env를 재시도마다
   * 다시 채우므로(refreshEnv) 새 객체를 만들면 둘이 갈라진다.
   */
  const aborter = new AbortController();
  const ctx: LaunchContext = Object.assign(baseCtx, { signal: aborter.signal });
  const ordered = orderOf(specs);
```

(c) `applyReadiness`의 두 `set` 호출에 `recovery: undefined`를 더한다:

```ts
    if (r.kind === "ready") {
      set(id, { process: "running", health: "ok", detail: undefined, recovery: undefined });
      return true;
    }
    if (r.kind === "degraded") {
      // 재시작을 유발하지 않는다 — 재시작해도 의존이 돌아오지 않으면 같고 백오프만 태운다.
      set(id, { process: "running", health: "degraded", detail: r.detail, recovery: undefined });
      return true;
    }
```

(d) `awaitReady`의 catch와 끝부분을 바꾼다:

```ts
      } catch (e) {
        last = { kind: "failed", detail: CAUSES.readinessThrew.text(reason(e)), recovery: recoveryOf(e) };
        log(`${rt.spec.id}: 준비 확인에서 예외 — ${reason(e)}`);
      }
```

```ts
    const detail = last.kind === "failed" ? last.detail : CAUSES.readyTimeout.text;
    const recovery = last.kind === "failed" ? last.recovery : undefined;
    set(rt.spec.id, { process: "failed", health: "unknown", detail, recovery });
    return false;
```

(e) `bringOnce`의 detectExternal catch, `set(spec.id, { process: "starting" … })`, launch catch를 바꾼다:

```ts
      const detail = CAUSES.externalCheckFailed.text(reason(e));
      set(spec.id, { process: "failed", health: "unknown", detail, recovery: recoveryOf(e) });
```

```ts
    set(spec.id, { process: "starting", health: "unknown", recovery: undefined });
```

```ts
      } catch (e) {
        const detail = reason(e);
        set(spec.id, { process: "failed", health: "unknown", detail, recovery: recoveryOf(e) });
        log(`${spec.id}: 기동 실패 — ${detail}`);
        return false;
      }
```

(f) `bringOnce` 끝의 재시작 조건을 바꾼다:

```ts
    // 기동 중 실패한 **게이트**에는 재시작을 걸지 않는다. start()는 이미 반환했고 창은 실패
    // 화면이므로, 백오프 뒤 이 서비스만 running이 되어도 뒤 서비스는 영원히 안 뜬다. 그
    // 경우의 복구는 메뉴의 "다시 시도"다 (스펙 §6.8) — retry()가 그 진입점이다.
    // manual 실패에도 걸지 않는다 — 같은 판정이 반복되고, 반복이 도구를 또 부른다 (Phase 3 스펙 §6.7).
    if ((!spec.gate || rt.everReady) && rt.status.recovery !== "manual") scheduleRestart(spec, "기동 실패");
    return false;
```

(g) `watchForDeath`의 `set`에 `recovery: undefined`를 더한다(사망은 auto다).

(h) `stopAll` 첫 줄 뒤에 abort를 더한다:

```ts
  async function stopAll(plan: StopPlan): Promise<StopOutcome> {
    stopping = true;
    // 진행 중인 launch() 안의 도구를 먼저 끝낸다. 아래 pending 대기가 그것을 기다리므로, 순서가 뒤면 멈춘 도구 하나가
    // 종료 전체를 붙잡는다 (Phase 3 스펙 §6.4).
    aborter.abort();
    for (const t of timers) clearTimeout(t);
```

- [ ] **Step 7: `main.ts`와 테스트 헬퍼의 타입을 맞춘다**

`desktop/src/main.ts`의 `createSupervisorFor`에서:

```ts
  const ctx: Omit<LaunchContext, "signal"> = {
    repoRoot: resolved,
    userData,
    packaged: app.isPackaged,
    env: cfg.env,
    bins: { uv },
    searchDirs: dirs,
    logFile: logPathOf,
  };
```

그리고 전역 `launchCtx`의 타입을 `let launchCtx: { ctx: Omit<LaunchContext, "signal">; baseline: ApiEnv } | null = null;`로 바꾼다. `docker` 지역 변수와 `dockerRun`은 Task 11까지 그대로 둔다(postgres compose 어댑터가 아직 쓴다). 953행 주석의 `ctx.bins(uv·docker)`는 `ctx.bins(uv)`로 고친다.

테스트 헬퍼 — 다음 여섯 곳에서 `docker: …`를 지우고 `LaunchContext`를 만드는 헬퍼에는 `signal: new AbortController().signal,`을 더한다:

| 파일 | 줄 | 바꾼 뒤 |
| --- | --- | --- |
| `tests/embed-spec.test.ts` | 12 | `bins: { uv: "/opt/homebrew/bin/uv" },` + `signal` |
| `tests/embed-spec.test.ts` | 100 | `spec.launch({ ...ctx(), bins: { uv: null } })` |
| `tests/launch-with-uv.test.ts` | 25 | `bins: { uv: "/opt/homebrew/bin/uv" },` + `signal` |
| `tests/worker-spec.test.ts` | 29, 195 | `bins: { uv: "/opt/homebrew/bin/uv" },` + `signal` / `ctx({ bins: { uv: null } })` |
| `tests/status-view.test.ts` | 320, 348 | 같은 모양 |
| `tests/config-reload.test.ts` | 194 | `bins: { uv: "/opt/homebrew/bin/uv" },` + `signal` (203행의 `SpecDeps.docker`는 Task 12가 바꾼다) |
| `tests/recovery-hint.test.ts` | 209, 237, 445, 481 | 헬퍼(209)에 `signal`, 네 곳 모두 `docker` 제거 |
| `tests/shell-html.test.ts` | 277 | `bins: { uv: null },` + `signal` (이 describe는 Task 11이 지운다) |
| `tests/postgres.test.ts` | 15 | `bins: { uv: "/opt/homebrew/bin/uv" },` + `signal` (파일은 Task 12가 지운다) |

`grep -rn "docker:" desktop/tests | grep "bins"` → 0건이 될 때까지 고친다.

- [ ] **Step 8: 전체 테스트와 타입 검사**

Run: `pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint`
Expected: 전부 PASS, `tsc` 오류 0. Phase 2의 기존 테스트 수 + 16.

- [ ] **Step 9: 변이로 두 성질을 확인한다**

(a) `stopAll`의 `aborter.abort();` 줄을 지우고 `-t "aborts ctx.signal"`을 돌린다 → FAIL(`"hung"`). 되돌린다.
(b) Step 6 (f)의 `&& rt.status.recovery !== "manual"`을 지우고 `-t "does not schedule a restart for a manual"`을 돌린다 → FAIL(`restarts`가 0이 아님). 되돌린다.

두 FAIL의 출력 줄을 리뷰에 제출한다.

- [ ] **Step 10: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/services/types.ts desktop/src/services/failure.ts desktop/src/services/supervisor.ts desktop/src/retry-policy.ts desktop/src/main.ts desktop/tests/
git commit -F - <<'MSG'
feat(desktop): 실패에 복구 부류를 싣고 종료가 진행 중인 기동을 중단시킨다

Phase 3의 새 실패(마이그레이션·페어링 거부)는 같은 시도를 반복하면 해롭다 — 마이그레이션이
20초마다 다시 돌고 백업이 쌓인다. 부류를 문구가 아니라 ServiceFailure로 싣고, 감독자가 상태에
옮기고, manual이면 재시작을 걸지 않는다. 부류가 없는 실패는 지금처럼 auto다.

감독자의 준비 유예는 launch()가 반환한 뒤에야 시작하고 stopAll은 진행 중인 기동을 기다린다.
launch() 안의 도구가 멈추면 ⌘Q도 멈추므로, 감독자가 ctx에 AbortSignal을 붙이고 stopAll
첫머리에서 abort한다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 8 전부 PASS, lint 0.
- Step 9 두 변이가 각각 FAIL을 냈다(출력 첨부).
- `grep -n "docker" desktop/src/services/types.ts` → 0건.

**Review:**
- 부류 없는 실패의 동작이 Phase 2와 **같은가.** `recovery`가 없을 때 `scheduleRestart` 조건이 이전과 같은지 본다.
- `Object.assign(baseCtx, …)`가 호출자의 객체를 제자리에서 고치는가. 새 객체를 만들면 main.ts의 `launchCtx.ctx.env` 재적용이 감독자에 닿지 않는다.
- `recovery`가 ready·degraded·starting·사망에서 지워지는가. 지워지지 않으면 복구된 서비스가 자동 재시도를 계속 막는다.
- `abort()`가 `pending` 대기보다 **앞**인가.

---

## Task 5: 내장 PG의 순수 판정 — 배치·페어링·락 파일

스펙 §6.1·§6.2·§6.3·§6.4(기동 2단계, 준비 판정의 파일 형식). 전부 electron·프로세스 없이 부를 수 있는 모듈이다.

**Files:**
- Create: `desktop/src/services/pg-layout.ts`
- Create: `desktop/src/services/pg-pairing.ts`
- Create: `desktop/src/services/pg-pidfile.ts`
- Test: `desktop/tests/pg-layout.test.ts`, `desktop/tests/pg-pairing.test.ts`, `desktop/tests/pg-pidfile.test.ts`

**Interfaces:**
- Consumes: Task 3 Step 1의 `postmaster.pid` 8번째 줄 형식, `ps -o comm=`·`args=` 형식, `pg_controldata` 줄 모양. **측정이 아래 가정과 다르면 이 Task를 시작하기 전에 고친다.** 가정: 8번째 줄은 `ready`를 공백으로 8자까지 채운다(`"ready   "`), `comm`은 실행 파일 전체 경로, `args`는 `<경로> -D <PGDATA> -c …`를 공백으로 이은 한 줄, `Database system identifier:           7412…`.
- Produces:
  - `pg-layout.ts`: `PG_MAJOR = "16"`, `PG_SOCKET_PORT = 5432`, `DB_NAME = "damwha"`, `DB_SUPERUSER = "damwha"`, `SOCKET_PATH_MAX_BYTES = 103`, `interface PgLayout { userData; dataDir; pgdata; storage; marker; runDir; socketFile; backups; logDir }`, `pgLayout(userData: string): PgLayout`, `socketPathTooLong(layout): number | null`, `embeddedDatabaseUrl(layout): string`, `PG_BINARY_NAMES`, `interface PgBinaries { dir; postgres; initdb; pgControldata; createdb; psql; pgDump; pgRestore }`, `pgBinaries(bundleDir: string): PgBinaries`, `pgToolEnv(): Record<string, string>`.
  - `pg-pairing.ts`: `interface ClusterMarker { clusterId: string; databaseOid: number | null }`, `parseMarker(text: string): ClusterMarker | null`, `serializeMarker(m): string`, `interface StorageFacts { markerText: string | null; hasFiles: boolean }`, `readStorageFacts(storageDir: string): StorageFacts`, `writeMarkerAtomic(markerPath: string, m: ClusterMarker): void`, `parseControldataClusterId(stdout: string): string | null`, `type ClusterRefusal`, `type ClusterDecision`, `decideCluster(f: ClusterFacts): ClusterDecision`, `type DatabaseRefusal`, `type DatabaseDecision`, `decideDatabase(input): DatabaseDecision`.
  - `pg-pidfile.ts`: `type PmStatus`, `interface PostmasterPid { pid: number; dataDir: string; status: PmStatus }`, `parsePostmasterPid(text: string): PostmasterPid | null`, `interface ProcessInfo { comm: string; args: string }`, `type LockOwner`, `classifyLockOwner(pgdata: string, info: ProcessInfo | null, pid: number): LockOwner`.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — `pg-layout`**

`desktop/tests/pg-layout.test.ts`:

```ts
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  embeddedDatabaseUrl,
  pgBinaries,
  pgLayout,
  pgToolEnv,
  PG_BINARY_NAMES,
  SOCKET_PATH_MAX_BYTES,
  socketPathTooLong,
} from "../src/services/pg-layout";

const UD = "/Users/someone/Library/Application Support/Damwha";

describe("pgLayout", () => {
  it("pairs the cluster and the storage under data/ and keeps the Phase 1·2 storage out of it", () => {
    const l = pgLayout(UD);
    expect(l.pgdata).toBe(path.join(UD, "data", "postgres"));
    expect(l.storage).toBe(path.join(UD, "data", "storage"));
    expect(l.marker).toBe(path.join(UD, "data", "storage", ".damwha-cluster"));
    expect(l.socketFile).toBe(path.join(UD, "run", ".s.PGSQL.5432"));
    expect(l.backups).toBe(path.join(UD, "backups"));
    expect(l.logDir).toBe(path.join(UD, "logs", "postgres"));
    // Phase 1·2가 Docker DB와 쓴 <userData>/storage는 이 배치의 어느 경로와도 같지 않다 (스펙 §6.2).
    expect(Object.values(l)).not.toContain(path.join(UD, "storage"));
  });
});

describe("socketPathTooLong", () => {
  it("accepts this machine's path (72 bytes)", () => {
    expect(socketPathTooLong(pgLayout("/Users/gim-yeongjae/Library/Application Support/Damwha"))).toBeNull();
  });

  it("measures bytes, not characters, and draws the line at 103", () => {
    const tail = "/run/.s.PGSQL.5432".length;
    const at = (bytes: number) => "/" + "a".repeat(bytes - tail - 1);
    expect(socketPathTooLong(pgLayout(at(SOCKET_PATH_MAX_BYTES)))).toBeNull();
    expect(socketPathTooLong(pgLayout(at(SOCKET_PATH_MAX_BYTES + 1)))).toBe(SOCKET_PATH_MAX_BYTES + 1);
    // 한글 한 글자는 UTF-8 3바이트다. 이 경로는 49글자지만 109바이트라, 글자 수로 세면 통과시킨다.
    const korean = pgLayout("/" + "가".repeat(30));
    expect(korean.socketFile.length).toBeLessThan(SOCKET_PATH_MAX_BYTES);
    expect(socketPathTooLong(korean)).toBe(Buffer.byteLength(korean.socketFile, "utf8"));
  });
});

describe("embeddedDatabaseUrl", () => {
  it("names the socket directory as host so no client can fall back to TCP localhost:5432", () => {
    const l = pgLayout(UD);
    const url = new URL(embeddedDatabaseUrl(l));
    expect(url.username).toBe("damwha");
    expect(url.hostname).toBe("");
    expect(url.pathname).toBe("/damwha");
    expect(url.searchParams.get("host")).toBe(l.runDir);
    expect(embeddedDatabaseUrl(l)).toContain("Application%20Support");
  });
});

describe("pgBinaries / pgToolEnv", () => {
  it("points every tool the adapter calls into the bundle's bin/", () => {
    const b = pgBinaries("/B/postgres");
    expect(b.postgres).toBe("/B/postgres/bin/postgres");
    expect(b.pgControldata).toBe("/B/postgres/bin/pg_controldata");
    expect(PG_BINARY_NAMES).toEqual(["postgres", "initdb", "pg_controldata", "createdb", "psql", "pg_dump", "pg_restore"]);
  });

  it("pins the locale so label parsing does not depend on the build's NLS option", () => {
    expect(pgToolEnv()).toMatchObject({ LC_ALL: "C", LANG: "C" });
  });
});
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — `pg-pairing`**

`desktop/tests/pg-pairing.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideCluster,
  decideDatabase,
  parseControldataClusterId,
  parseMarker,
  readStorageFacts,
  serializeMarker,
  writeMarkerAtomic,
  type ClusterFacts,
} from "../src/services/pg-pairing";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pair-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const MARK = serializeMarker({ clusterId: "7412345678901234567", databaseOid: 16384 });
const facts = (over: Partial<ClusterFacts>): ClusterFacts => ({
  pgdataExists: true,
  pgVersion: "16",
  clusterId: "7412345678901234567",
  storage: { markerText: MARK, hasFiles: true },
  ...over,
});

describe("marker", () => {
  it("round-trips", () => {
    expect(parseMarker(serializeMarker({ clusterId: "1", databaseOid: null }))).toEqual({ clusterId: "1", databaseOid: null });
    expect(parseMarker(MARK)).toEqual({ clusterId: "7412345678901234567", databaseOid: 16384 });
  });

  it("rejects anything that is not exactly the marker shape", () => {
    for (const bad of ["", "{", "[]", "null", '{"clusterId":7}', '{"clusterId":"1"}', '{"clusterId":"1","databaseOid":"16384"}', '{"clusterId":"","databaseOid":null}', '{"clusterId":"1","databaseOid":0}']) {
      expect(parseMarker(bad)).toBeNull();
    }
  });

  it("writes atomically and creates the storage directory", () => {
    const marker = path.join(dir, "storage", ".damwha-cluster");
    writeMarkerAtomic(marker, { clusterId: "42", databaseOid: null });
    expect(parseMarker(fs.readFileSync(marker, "utf8"))).toEqual({ clusterId: "42", databaseOid: null });
    expect(fs.readdirSync(path.dirname(marker))).toEqual([".damwha-cluster"]);
  });
});

describe("readStorageFacts", () => {
  it("treats a missing directory as empty", () => {
    expect(readStorageFacts(path.join(dir, "nope"))).toEqual({ markerText: null, hasFiles: false });
  });

  it("does not count the marker or .DS_Store as files", () => {
    fs.writeFileSync(path.join(dir, ".damwha-cluster"), MARK);
    fs.writeFileSync(path.join(dir, ".DS_Store"), "x");
    expect(readStorageFacts(dir)).toEqual({ markerText: MARK, hasFiles: false });
  });

  it("counts anything else, including an empty meetings/ directory", () => {
    fs.mkdirSync(path.join(dir, "meetings"));
    expect(readStorageFacts(dir).hasFiles).toBe(true);
  });
});

describe("parseControldataClusterId", () => {
  it("reads the id from the C-locale label", () => {
    const out = "pg_control version number:            1300\nDatabase system identifier:           7412345678901234567\nDatabase cluster state:               shut down\n";
    expect(parseControldataClusterId(out)).toBe("7412345678901234567");
  });

  it("returns null when the label is missing", () => {
    expect(parseControldataClusterId("Datenbanksystemidentifikation: 1\n")).toBeNull();
  });
});

describe("decideCluster — 판정표 1 (스펙 §6.2)", () => {
  it("initdb when there is no cluster and nothing in storage (marker from an interrupted run does not matter)", () => {
    expect(decideCluster(facts({ pgdataExists: false, storage: { markerText: null, hasFiles: false } }))).toEqual({ kind: "initdb" });
    expect(decideCluster(facts({ pgdataExists: false, storage: { markerText: MARK, hasFiles: false } }))).toEqual({ kind: "initdb" });
  });

  it("refuses storage with files but no cluster — a fresh cluster would reuse mtg_1… over those files", () => {
    expect(decideCluster(facts({ pgdataExists: false }))).toMatchObject({ kind: "refuse", reason: "storage-without-cluster" });
  });

  it("refuses a cluster without a marker even when storage is empty — the app writes the marker before the cluster exists", () => {
    expect(decideCluster(facts({ storage: { markerText: null, hasFiles: false } }))).toMatchObject({ kind: "refuse", reason: "cluster-without-marker" });
  });

  it("refuses an unreadable marker", () => {
    expect(decideCluster(facts({ storage: { markerText: "{", hasFiles: true } }))).toMatchObject({ kind: "refuse", reason: "marker-unreadable" });
  });

  it("refuses a marker from another cluster", () => {
    expect(decideCluster(facts({ clusterId: "999" }))).toMatchObject({ kind: "refuse", reason: "marker-mismatch" });
  });

  it("refuses another major version before reading the control file", () => {
    expect(decideCluster(facts({ pgVersion: "15", clusterId: null }))).toEqual({ kind: "refuse", reason: "version-mismatch", detail: "15" });
    expect(decideCluster(facts({ pgVersion: null, clusterId: null }))).toEqual({ kind: "refuse", reason: "version-mismatch", detail: null });
  });

  it("refuses a cluster whose control file could not be read", () => {
    expect(decideCluster(facts({ clusterId: null }))).toMatchObject({ kind: "refuse", reason: "controldata-failed" });
  });

  it("starts a matching cluster and hands over the marker", () => {
    expect(decideCluster(facts({}))).toEqual({ kind: "start", marker: { clusterId: "7412345678901234567", databaseOid: 16384 } });
  });
});

describe("decideDatabase — 판정표 2 (스펙 §6.2)", () => {
  const m = (databaseOid: number | null) => ({ clusterId: "1", databaseOid });

  it("creates the database only when nothing says one existed", () => {
    expect(decideDatabase({ oid: null, marker: m(null), storageHasFiles: false })).toEqual({ kind: "createdb" });
  });

  it("refuses a missing database when storage has files", () => {
    expect(decideDatabase({ oid: null, marker: m(null), storageHasFiles: true })).toMatchObject({ kind: "refuse", reason: "storage-without-database" });
  });

  it("refuses a dropped database — the marker remembers it", () => {
    expect(decideDatabase({ oid: null, marker: m(16384), storageHasFiles: false })).toMatchObject({ kind: "refuse", reason: "database-dropped" });
  });

  it("records the oid when createdb finished but the marker was not yet written", () => {
    expect(decideDatabase({ oid: 16384, marker: m(null), storageHasFiles: false })).toEqual({ kind: "record-oid", oid: 16384 });
  });

  it("refuses an unrecorded database next to files", () => {
    expect(decideDatabase({ oid: 16384, marker: m(null), storageHasFiles: true })).toMatchObject({ kind: "refuse", reason: "storage-without-database" });
  });

  it("passes the database the marker names", () => {
    expect(decideDatabase({ oid: 16384, marker: m(16384), storageHasFiles: true })).toEqual({ kind: "ok" });
  });

  it("refuses a recreated database", () => {
    expect(decideDatabase({ oid: 20000, marker: m(16384), storageHasFiles: false })).toMatchObject({ kind: "refuse", reason: "database-recreated" });
  });
});
```

- [ ] **Step 3: 실패하는 테스트를 쓴다 — `pg-pidfile`**

`desktop/tests/pg-pidfile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyLockOwner, parsePostmasterPid } from "../src/services/pg-pidfile";

const PGDATA = "/Users/someone/Library/Application Support/Damwha/data/postgres";
const pidfile = (status: string) =>
  ["4242", PGDATA, "1757800000", "5432", "/Users/someone/Library/Application Support/Damwha/run", "", "  5432001    65536", status, ""].join("\n");

describe("parsePostmasterPid", () => {
  it("reads pid, data directory and the padded status line", () => {
    expect(parsePostmasterPid(pidfile("ready   "))).toEqual({ pid: 4242, dataDir: PGDATA, status: "ready" });
    expect(parsePostmasterPid(pidfile("starting"))).toMatchObject({ status: "starting" });
    expect(parsePostmasterPid(pidfile("stopping"))).toMatchObject({ status: "stopping" });
  });

  it("reports unknown while the postmaster has not written the status line yet", () => {
    expect(parsePostmasterPid(["4242", PGDATA, "1757800000"].join("\n"))).toMatchObject({ pid: 4242, status: "unknown" });
  });

  it("returns null for a file whose first line is not a pid", () => {
    for (const bad of ["", "abc\n", "-1\n", "0\n"]) expect(parsePostmasterPid(bad)).toBeNull();
  });
});

describe("classifyLockOwner — 기동 2단계 (스펙 §6.4)", () => {
  it("none when the pid is not running — PostgreSQL clears that lock itself", () => {
    expect(classifyLockOwner(PGDATA, null, 4242)).toEqual({ kind: "none" });
  });

  it("orphan for a postgres of any bundle path holding our data directory (dev and packaged share the cluster)", () => {
    for (const bin of ["/Applications/Damwha.app/Contents/Resources/postgres/bin/postgres", "/Users/x/project/daewha/desktop/build/postgres/bin/postgres"]) {
      expect(classifyLockOwner(PGDATA, { comm: bin, args: `${bin} -D ${PGDATA} -c listen_addresses=` }, 4242)).toEqual({ kind: "orphan", pid: 4242 });
      expect(classifyLockOwner(PGDATA, { comm: bin, args: `${bin} -D ${PGDATA}` }, 4242)).toEqual({ kind: "orphan", pid: 4242 });
    }
  });

  it("stale for a reused pid — another program, or a postgres on another data directory", () => {
    expect(classifyLockOwner(PGDATA, { comm: "/usr/bin/vim", args: "vim notes.txt" }, 4242)).toEqual({ kind: "stale", pid: 4242 });
    expect(classifyLockOwner(PGDATA, { comm: "/opt/homebrew/bin/postgres", args: "/opt/homebrew/bin/postgres -D /opt/homebrew/var/postgresql@16" }, 4242)).toEqual({ kind: "stale", pid: 4242 });
  });

  it("does not take a longer data directory that merely starts with ours", () => {
    const args = `/b/postgres -D ${PGDATA}-copy -c port=5432`;
    expect(classifyLockOwner(PGDATA, { comm: "/b/postgres", args }, 4242)).toEqual({ kind: "stale", pid: 4242 });
  });
});
```

- [ ] **Step 4: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/pg-layout.test.ts tests/pg-pairing.test.ts tests/pg-pidfile.test.ts`
Expected: FAIL — 세 모듈을 해석하지 못한다.

- [ ] **Step 5: 세 모듈을 쓴다**

`desktop/src/services/pg-layout.ts`:

```ts
import * as path from "path";

/**
 * 내장 PostgreSQL의 배치와 접속 (Phase 3 스펙 §6.1·§6.3). electron을 import하지 않는 순수 모듈이다.
 *
 * dev와 packaged는 같은 userData를 쓴다(main.ts의 app.setName) — 그래서 이 배치도 하나이고 클러스터도 하나다.
 */

export const PG_MAJOR = "16";
/** 소켓 파일 이름(.s.PGSQL.5432)에만 쓰인다. TCP는 열지 않는다. */
export const PG_SOCKET_PORT = 5432;
export const DB_NAME = "damwha";
/** 마이그레이션의 CREATE EXTENSION vector·pg_bigm이 슈퍼유저를 요구한다 — 둘 다 trusted extension이 아니다. */
export const DB_SUPERUSER = "damwha";
/** macOS sun_path는 104바이트이고 NUL이 한 자리를 쓴다. */
export const SOCKET_PATH_MAX_BYTES = 103;

export interface PgLayout {
  userData: string;
  /** 클러스터와 스토리지의 "한 쌍"이 사는 곳. */
  dataDir: string;
  pgdata: string;
  storage: string;
  marker: string;
  runDir: string;
  socketFile: string;
  backups: string;
  /** logging_collector가 쓰는 디렉터리. 앱이 죽어도 서버가 계속 기록한다. */
  logDir: string;
}

export function pgLayout(userData: string): PgLayout {
  const dataDir = path.join(userData, "data");
  const runDir = path.join(userData, "run");
  return {
    userData,
    dataDir,
    pgdata: path.join(dataDir, "postgres"),
    storage: path.join(dataDir, "storage"),
    marker: path.join(dataDir, "storage", ".damwha-cluster"),
    runDir,
    socketFile: path.join(runDir, `.s.PGSQL.${PG_SOCKET_PORT}`),
    backups: path.join(userData, "backups"),
    logDir: path.join(userData, "logs", "postgres"),
  };
}

/** 소켓 경로가 한도를 넘으면 그 바이트 수, 아니면 null. 폴백하지 않는다 — /tmp 류는 다른 사용자와 나누는 자리다. */
export function socketPathTooLong(layout: PgLayout): number | null {
  const bytes = Buffer.byteLength(layout.socketFile, "utf8");
  return bytes > SOCKET_PATH_MAX_BYTES ? bytes : null;
}

/**
 * API·worker·마이그레이션 러너가 받는 주소. host가 소켓 디렉터리라 어떤 소비자도 TCP localhost:5432(개발자의 Docker
 * DB)로 떨어지지 않는다 — node-pg는 host가 `/`로 시작하면 소켓에 붙고, libpq(psycopg)도 같다(2026-09-14 실측).
 * `Application Support`의 공백은 percent-encoding으로 싣는다.
 */
export function embeddedDatabaseUrl(layout: PgLayout): string {
  return `postgresql://${DB_SUPERUSER}@/${DB_NAME}?host=${encodeURIComponent(layout.runDir)}`;
}

export const PG_BINARY_NAMES = ["postgres", "initdb", "pg_controldata", "createdb", "psql", "pg_dump", "pg_restore"] as const;

export interface PgBinaries {
  /** 번들 루트 (그 아래 bin/·lib/·share/). */
  dir: string;
  postgres: string;
  initdb: string;
  pgControldata: string;
  createdb: string;
  psql: string;
  pgDump: string;
  pgRestore: string;
}

export function pgBinaries(bundleDir: string): PgBinaries {
  const bin = (name: (typeof PG_BINARY_NAMES)[number]) => path.join(bundleDir, "bin", name);
  return {
    dir: bundleDir,
    postgres: bin("postgres"),
    initdb: bin("initdb"),
    pgControldata: bin("pg_controldata"),
    createdb: bin("createdb"),
    psql: bin("psql"),
    pgDump: bin("pg_dump"),
    pgRestore: bin("pg_restore"),
  };
}

/**
 * PG 도구와 서버에 주는 env. 앱의 env를 물려주지 않는다 — PG가 읽는 PGHOST·PGDATABASE 같은 변수가 셸에서 새어 들어오면
 * 도구가 엉뚱한 서버에 붙는다. LC_ALL=C는 pg_controldata 라벨 파싱을 빌드의 NLS 옵션에서 떼어 낸다 (스펙 §6.2).
 */
export function pgToolEnv(): Record<string, string> {
  return { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin" };
}
```

`desktop/src/services/pg-pairing.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { PG_MAJOR } from "./pg-layout";

/**
 * 클러스터와 스토리지가 같은 쌍임을 증명하는 판정 (Phase 3 스펙 §6.2).
 *
 * 스토리지 키는 `meetings/<meeting.id>/…`이고 id는 시퀀스라, 새 클러스터는 1번부터 다시 센다. 다른 DB의 행이 만든
 * 파일 옆에 새 DB를 짝지으면 그 번호에 닿는 순간 원본을 덮는다. 신원은 두 층이다 — 클러스터(system identifier)와
 * 데이터베이스(damwha의 oid). 같은 클러스터에서 DB만 지우고 다시 만들어도 시퀀스는 1로 돌아간다(외부 리뷰 #1).
 */

export interface ClusterMarker {
  clusterId: string;
  /** damwha 데이터베이스를 만들기 전에는 null. */
  databaseOid: number | null;
}

export function serializeMarker(m: ClusterMarker): string {
  return `${JSON.stringify({ clusterId: m.clusterId, databaseOid: m.databaseOid })}\n`;
}

export function parseMarker(text: string): ClusterMarker | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { clusterId, databaseOid } = value as Record<string, unknown>;
  if (typeof clusterId !== "string" || clusterId === "") return null;
  if (databaseOid === null) return { clusterId, databaseOid: null };
  if (typeof databaseOid !== "number" || !Number.isInteger(databaseOid) || databaseOid <= 0) return null;
  return { clusterId, databaseOid };
}

/** 임시 파일에 쓰고 rename한다. 반쯤 쓴 마커는 짝을 증명하지 못한다. */
export function writeMarkerAtomic(markerPath: string, m: ClusterMarker): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const tmp = `${markerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, serializeMarker(m), { mode: 0o600 });
  fs.renameSync(tmp, markerPath);
}

export interface StorageFacts {
  markerText: string | null;
  /** 마커·그 임시 파일·.DS_Store 말고 무엇이든 있으면 true. 빈 meetings/도 센다 — 누가 왜 만들었는지 모른다. */
  hasFiles: boolean;
}

const MARKER_NAME = ".damwha-cluster";

export function readStorageFacts(storageDir: string): StorageFacts {
  let names: string[];
  try {
    names = fs.readdirSync(storageDir);
  } catch {
    return { markerText: null, hasFiles: false };
  }
  let markerText: string | null = null;
  if (names.includes(MARKER_NAME)) {
    try {
      markerText = fs.readFileSync(path.join(storageDir, MARKER_NAME), "utf8");
    } catch {
      markerText = null;
    }
  }
  const hasFiles = names.some((n) => n !== MARKER_NAME && n !== ".DS_Store" && !n.startsWith(`${MARKER_NAME}.tmp-`));
  return { markerText, hasFiles };
}

/** `LC_ALL=C pg_controldata`의 한 줄. */
export function parseControldataClusterId(stdout: string): string | null {
  const m = /^Database system identifier:\s+(\d+)\s*$/m.exec(stdout);
  return m === null ? null : m[1];
}

export interface ClusterFacts {
  pgdataExists: boolean;
  /** PG_VERSION의 내용. 없거나 못 읽으면 null. */
  pgVersion: string | null;
  /** pg_controldata가 준 id. 부르지 않았거나 실패하면 null. */
  clusterId: string | null;
  storage: StorageFacts;
}

export type ClusterRefusal =
  | "storage-without-cluster"
  | "cluster-without-marker"
  | "marker-unreadable"
  | "marker-mismatch"
  | "version-mismatch"
  | "controldata-failed";

export type ClusterDecision =
  | { kind: "initdb" }
  | { kind: "start"; marker: ClusterMarker }
  | { kind: "refuse"; reason: ClusterRefusal; detail?: string | null };

/**
 * 판정표 1. 마커는 initdb가 끝난 임시 디렉터리를 data/postgres로 옮기기 **전에** 쓰므로(스펙 §6.4 기동 3단계),
 * "클러스터는 있는데 마커가 없다"는 앱이 만든 클러스터에서 생길 수 없다 — 누가 가져다 놓았는지 모르는 클러스터에
 * 마이그레이션을 실행하지 않도록 언제나 거부한다.
 */
export function decideCluster(f: ClusterFacts): ClusterDecision {
  if (!f.pgdataExists) {
    return f.storage.hasFiles ? { kind: "refuse", reason: "storage-without-cluster" } : { kind: "initdb" };
  }
  if (f.pgVersion !== PG_MAJOR) return { kind: "refuse", reason: "version-mismatch", detail: f.pgVersion };
  if (f.clusterId === null) return { kind: "refuse", reason: "controldata-failed" };
  if (f.storage.markerText === null) return { kind: "refuse", reason: "cluster-without-marker" };
  const marker = parseMarker(f.storage.markerText);
  if (marker === null) return { kind: "refuse", reason: "marker-unreadable" };
  if (marker.clusterId !== f.clusterId) return { kind: "refuse", reason: "marker-mismatch" };
  return { kind: "start", marker };
}

export type DatabaseRefusal = "database-dropped" | "database-recreated" | "storage-without-database";

export type DatabaseDecision =
  | { kind: "createdb" }
  | { kind: "record-oid"; oid: number }
  | { kind: "ok" }
  | { kind: "refuse"; reason: DatabaseRefusal };

/** 판정표 2. 서버가 물리적으로 준비된 뒤, 게이트를 열기 전에 한다. */
export function decideDatabase(input: { oid: number | null; marker: ClusterMarker; storageHasFiles: boolean }): DatabaseDecision {
  const { oid, marker, storageHasFiles } = input;
  if (oid === null) {
    if (marker.databaseOid !== null) return { kind: "refuse", reason: "database-dropped" };
    return storageHasFiles ? { kind: "refuse", reason: "storage-without-database" } : { kind: "createdb" };
  }
  if (marker.databaseOid === null) {
    return storageHasFiles ? { kind: "refuse", reason: "storage-without-database" } : { kind: "record-oid", oid };
  }
  return marker.databaseOid === oid ? { kind: "ok" } : { kind: "refuse", reason: "database-recreated" };
}
```

`desktop/src/services/pg-pidfile.ts`:

```ts
/**
 * postmaster.pid와 락 주인 판정 (Phase 3 스펙 §6.4). 순수 모듈이다 — ps를 부르는 일은 pg-handle.ts의 psInfo가 한다.
 */

export type PmStatus = "starting" | "stopping" | "ready" | "standby" | "unknown";

export interface PostmasterPid {
  pid: number;
  dataDir: string;
  /** 8번째 줄. PostgreSQL 10+가 pg_ctl의 기동 대기용으로 쓰는 값이고, 공백으로 8자를 채운다("ready   "). */
  status: PmStatus;
}

const STATUSES: readonly PmStatus[] = ["starting", "stopping", "ready", "standby"];

export function parsePostmasterPid(text: string): PostmasterPid | null {
  const lines = text.split("\n");
  const pid = Number((lines[0] ?? "").trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const raw = (lines[7] ?? "").trim() as PmStatus;
  return { pid, dataDir: (lines[1] ?? "").trim(), status: STATUSES.includes(raw) ? raw : "unknown" };
}

export interface ProcessInfo {
  /** `ps -o comm=` — 실행 파일 경로. */
  comm: string;
  /** `ps -o args=` — 인자를 공백으로 이은 한 줄. PGDATA의 공백은 그대로 나온다. */
  args: string;
}

export type LockOwner = { kind: "none" } | { kind: "orphan"; pid: number } | { kind: "stale"; pid: number };

/**
 * 락 파일의 pid가 누구인가.
 *
 * - 없음(프로세스가 없다) → PostgreSQL이 낡은 락을 스스로 처리한다.
 * - 실행 파일 **이름**이 postgres이고 `-D <우리 PGDATA>`를 가진다 → 이전 실행의 고아. 경로는 보지 않는다 — dev와
 *   packaged가 같은 클러스터를 다른 경로의 바이너리로 열고, 빌드된 .app의 위치도 정해져 있지 않다. 같은 PGDATA를
 *   쥔 postmaster는 PostgreSQL의 락 때문에 하나뿐이다.
 * - 그 밖 → pid가 재사용된 낡은 락. PostgreSQL은 이 경우 "lock file already exists"로 기동을 거부한다.
 */
export function classifyLockOwner(pgdata: string, info: ProcessInfo | null, pid: number): LockOwner {
  if (info === null) return { kind: "none" };
  const name = info.comm.split("/").pop() ?? "";
  const flag = ` -D ${pgdata}`;
  const at = info.args.indexOf(flag);
  const holdsOurs = at >= 0 && (at + flag.length === info.args.length || info.args[at + flag.length] === " ");
  return name === "postgres" && holdsOurs ? { kind: "orphan", pid } : { kind: "stale", pid };
}
```

- [ ] **Step 6: 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop exec vitest run tests/pg-layout.test.ts tests/pg-pairing.test.ts tests/pg-pidfile.test.ts && pnpm --filter damwha-desktop run lint`
Expected: PASS — 38 tests. lint 0.

- [ ] **Step 7: 변이로 두 판정을 확인한다**

(a) `decideCluster`의 `if (f.storage.markerText === null) return … "cluster-without-marker"` 줄을 지운다 → `refuses a cluster without a marker even when storage is empty` FAIL. 되돌린다.
(b) `classifyLockOwner`의 `holdsOurs` 조건에서 뒤쪽 경계 검사(`&& (… === " ")` 부분)를 지운다 → `does not take a longer data directory` FAIL. 되돌린다.

- [ ] **Step 8: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/services/pg-layout.ts desktop/src/services/pg-pairing.ts desktop/src/services/pg-pidfile.ts desktop/tests/pg-layout.test.ts desktop/tests/pg-pairing.test.ts desktop/tests/pg-pidfile.test.ts
git commit -F - <<'MSG'
feat(desktop): 내장 PG의 배치·페어링·락 파일 판정을 순수 모듈로 더한다

새 클러스터는 meeting id를 1부터 다시 세므로 다른 DB의 파일 옆에 짝지으면 원본을 덮는다.
클러스터 id와 damwha 데이터베이스 oid를 마커에 적고 두 판정표로 짝을 증명한다. 마커는
initdb 결과를 옮기기 전에 쓰므로, 마커 없는 클러스터는 언제나 거부할 수 있다.

락 주인 판정은 실행 파일 이름과 -D만 본다. dev와 packaged가 한 클러스터를 다른 경로의
바이너리로 열기 때문이다. 접속 주소는 소켓 디렉터리를 host로 적어 TCP로 새지 않게 한다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 6 PASS, lint 0. Step 7 두 변이 FAIL(출력 첨부).
- 세 소스 파일에 `from "electron"`이 없다.

**Review:**
- 판정표 1·2의 **모든 행**이 스펙 §6.2와 1:1인가. 테스트 이름에 행이 드러나는가.
- `readStorageFacts`가 무엇을 "파일 없음"으로 보는지 스펙의 정의(마커와 `.DS_Store`만)와 같은가.
- `classifyLockOwner`가 경로가 아니라 이름을 보는 근거가 주석에 있는가. Task 3 Step 1의 실측 형식과 맞는가.
- `embeddedDatabaseUrl`이 `host` 쿼리로 소켓 디렉터리를 싣는가.

---

## Task 6: 도구 실행기와 postmaster 핸들

스펙 §6.4 "핸들"·"기동 중단"·"종료". 외부 도구는 모두 deadline과 중단 신호를 받는 한 실행기를 거친다. postmaster에는 SIGINT·SIGQUIT만 닿는다.

**Files:**
- Create: `desktop/src/services/tool-runner.ts`
- Create: `desktop/src/services/pg-handle.ts`
- Test: `desktop/tests/tool-runner.test.ts`, `desktop/tests/pg-handle.test.ts`

**Interfaces:**
- Consumes: Task 4 `ServiceHandle`(=`ApiHandle`), `makeSink`/`sinkTails`(`desktop/src/api-process.ts`); Task 5 `PgLayout`·`PgBinaries`·`pgToolEnv`·`PG_SOCKET_PORT`·`ProcessInfo`.
- Produces:
  - `tool-runner.ts`: `type SpawnFn`, `interface ToolResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; spawnError?: string }`, `interface ToolOptions { env: Record<string, string>; cwd?: string; deadlineMs?: number; signal?: AbortSignal; killGraceMs?: number; spawnFn?: SpawnFn }`, `runTool(bin, args, opts): Promise<ToolResult>`, `toolOk(r): boolean`, `describeToolFailure(what: string, r: ToolResult): string`.
  - `pg-handle.ts`: `type PostmasterSignal = "SIGINT" | "SIGQUIT"`, `type PostmasterStopResult = "fast" | "immediate" | "leaked"`, `interface PostmasterStopDeps { signal(pid: number, sig: PostmasterSignal): void; alive(): boolean; pollMs?: number }`, `stopPostmaster(pid: number | undefined, fastGraceMs: number, immediateGraceMs: number, deps): Promise<PostmasterStopResult>`, `postmasterArgs(layout: PgLayout): string[]`, `interface PostmasterLaunch { binaries; layout; logFile; immediateGraceMs; spawnFn? }`, `spawnPostmaster(o: PostmasterLaunch): ServiceHandle`, `psInfo(pid: number): Promise<ProcessInfo | null>`, `processExists(pid: number): boolean`, `stopOrphanPostmaster(pid: number, fastGraceMs: number, immediateGraceMs: number): Promise<PostmasterStopResult>`.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — `tool-runner`**

`desktop/tests/tool-runner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { describeToolFailure, runTool, toolOk } from "../src/services/tool-runner";

const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

describe("runTool", () => {
  it("collects exit code and both streams separately", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], { env });
    expect(r).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false, aborted: false });
    expect(toolOk(r)).toBe(false);
    expect(toolOk(await runTool("/usr/bin/true", [], { env }))).toBe(true);
  });

  it("ends a tool that outlives its deadline", async () => {
    const started = Date.now();
    const r = await runTool("/bin/sleep", ["5"], { env, deadlineMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(toolOk(r)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("ends a tool when the signal aborts — this is what lets ⌘Q through a hung initdb", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await runTool("/bin/sleep", ["5"], { env, signal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  it("does not spawn at all when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const spawnFn = vi.fn();
    const r = await runTool("/bin/sleep", ["5"], { env, signal: ac.signal, spawnFn: spawnFn as never });
    expect(r.aborted).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL for a tool that ignores SIGTERM", async () => {
    const started = Date.now();
    const r = await runTool("/bin/sh", ["-c", 'trap "" TERM; while :; do :; done'], { env, deadlineMs: 100, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await runTool("/nowhere/initdb", [], { env });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(describeToolFailure("initdb", r)).toMatch(/^initdb: 실행하지 못했어요/);
  });

  it("describes a failure with its reason and the tail of stderr", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo 'FATAL: boom' >&2; exit 1"], { env });
    expect(describeToolFailure("pg_dump", r)).toBe("pg_dump: 종료 코드 1\nFATAL: boom");
  });
});
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — `pg-handle`**

`desktop/tests/pg-handle.test.ts`:

```ts
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postmasterArgs, spawnPostmaster, stopPostmaster, type PostmasterSignal } from "../src/services/pg-handle";
import { pgBinaries, pgLayout } from "../src/services/pg-layout";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeProcess(diesOn: PostmasterSignal | null) {
  let alive = true;
  const sent: string[] = [];
  return {
    sent,
    deps: {
      pollMs: 5,
      alive: () => alive,
      signal: (_pid: number, sig: PostmasterSignal) => {
        sent.push(sig);
        if (sig === diesOn) alive = false;
      },
    },
  };
}

describe("stopPostmaster", () => {
  it("stops on SIGINT (fast shutdown) and sends nothing else", async () => {
    const p = fakeProcess("SIGINT");
    expect(await stopPostmaster(4242, 200, 200, p.deps)).toBe("fast");
    expect(p.sent).toEqual(["SIGINT"]);
  });

  it("goes to SIGQUIT (immediate) when fast shutdown outlives its grace", async () => {
    const p = fakeProcess("SIGQUIT");
    expect(await stopPostmaster(4242, 30, 200, p.deps)).toBe("immediate");
    expect(p.sent).toEqual(["SIGINT", "SIGQUIT"]);
  });

  it("reports a leak rather than escalating further — never SIGKILL a postmaster", async () => {
    const p = fakeProcess(null);
    expect(await stopPostmaster(4242, 20, 20, p.deps)).toBe("leaked");
    expect(p.sent).toEqual(["SIGINT", "SIGQUIT"]);
  });

  it("does nothing for a process that is already gone, and refuses a pid it cannot trust", async () => {
    const gone = { pollMs: 5, alive: () => false, signal: vi.fn() };
    expect(await stopPostmaster(4242, 20, 20, gone)).toBe("fast");
    expect(gone.signal).not.toHaveBeenCalled();
    const p = fakeProcess("SIGINT");
    expect(await stopPostmaster(undefined, 20, 20, p.deps)).toBe("leaked");
    expect(await stopPostmaster(0, 20, 20, p.deps)).toBe("leaked");
    expect(p.sent).toEqual([]);
  });

  it("cannot even be asked to send SIGKILL", () => {
    // @ts-expect-error — PostmasterSignal에 SIGKILL이 없다. 이 줄이 컴파일되면 타입이 넓어진 것이다.
    const s: PostmasterSignal = "SIGKILL";
    expect(s).toBe("SIGKILL");
  });
});

describe("postmasterArgs", () => {
  it("opens no TCP listener, a private socket, and a server-written log", () => {
    const l = pgLayout("/U/Damwha");
    const a = postmasterArgs(l);
    expect(a.slice(0, 2)).toEqual(["-D", l.pgdata]);
    expect(a).toContain("listen_addresses=");
    expect(a).toContain(`unix_socket_directories=${l.runDir}`);
    expect(a).toContain("unix_socket_permissions=0700");
    expect(a).toContain("logging_collector=on");
    expect(a).toContain(`log_directory=${l.logDir}`);
  });
});

describe("spawnPostmaster", () => {
  it("spawns the bundle's postgres directly in its own group with the pinned tool env", () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: vi.fn() });
    const spawnFn = vi.fn(() => child);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pm-"));
    try {
      const h = spawnPostmaster({
        binaries: pgBinaries("/B/postgres"),
        layout: pgLayout("/U/Damwha"),
        logFile: path.join(dir, "postgres.log"),
        immediateGraceMs: 10,
        spawnFn: spawnFn as never,
      });
      const [bin, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], { detached: boolean; env: Record<string, string> }];
      expect(bin).toBe("/B/postgres/bin/postgres");
      expect(args).not.toContain("start"); // pg_ctl start를 거치지 않는다 (Phase 0 규칙 2b)
      expect(opts.detached).toBe(true);
      expect(opts.env.LC_ALL).toBe("C");
      expect(h.pid).toBe(4242);
      child.stderr.emit("data", Buffer.from("FATAL: lock file exists\n"));
      expect(h.stderrTail()).toContain("lock file exists");
      child.emit("exit", 1, null);
      expect(h.alive()).toBe(false);
      expect(h.exitCode()).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops by signalling the postmaster pid only — no group, no SIGKILL", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, kill: vi.fn() });
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, sig: string) => {
      if (sig === "SIGINT") setTimeout(() => child.emit("exit", 0, null), 5);
      return true;
    }) as never);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pm-"));
    try {
      const h = spawnPostmaster({
        binaries: pgBinaries("/B/postgres"),
        layout: pgLayout("/U/Damwha"),
        logFile: path.join(dir, "postgres.log"),
        immediateGraceMs: 10,
        spawnFn: (() => child) as never,
      });
      await h.stop(500);
      expect(kill.mock.calls).toEqual([[4242, "SIGINT"]]);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps SIGKILL and group signals out of the source", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "pg-handle.ts"), "utf8");
    expect(src).not.toMatch(/SIGKILL/);
    expect(src).not.toMatch(/process\.kill\(\s*-/);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/tool-runner.test.ts tests/pg-handle.test.ts`
Expected: FAIL — 두 모듈을 해석하지 못한다.

- [ ] **Step 4: 두 모듈을 쓴다**

`desktop/src/services/tool-runner.ts`:

```ts
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";

/**
 * 외부 도구 실행기 (Phase 3 스펙 §6.4 "기동 중단"). initdb·pg_controldata·psql·createdb·pg_dump·pg_restore·마이그레이션
 * 러너(dev)가 이것 하나를 거친다. deadline과 중단 신호 중 먼저 오는 쪽이 도구를 끝낸다 — 도구 프로세스이지
 * postmaster가 아니므로 SIGTERM 뒤 SIGKILL로 올라가도 된다.
 *
 * 던지지 않는다. 실행 파일이 없어도, 시간이 넘어도, 중단돼도 결과로 돌려준다. 부르는 쪽이 그것을 원인 문구와 부류로
 * 바꾼다.
 */

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ToolResult {
  /** 신호로 끝났거나 실행하지 못했으면 null. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export interface ToolOptions {
  env: Record<string, string>;
  cwd?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** SIGTERM 뒤 SIGKILL까지. */
  killGraceMs?: number;
  spawnFn?: SpawnFn;
}

/** 스트림 하나당 보관하는 꼬리. pg_dump는 -f로 파일에 쓰므로 stdout이 크지 않다. */
const OUTPUT_LIMIT = 256_000;

export function runTool(bin: string, args: readonly string[], opts: ToolOptions): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted === true) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const child = (opts.spawnFn ?? spawn)(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;

    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // 이미 끝났다.
      }
      killer ??= setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 이미 끝났다.
        }
      }, opts.killGraceMs ?? 2_000);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, ...(spawnError === undefined ? {} : { spawnError }) });
    };

    child.stdout?.on("data", (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-OUTPUT_LIMIT);
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.deadlineMs);
    }
    // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
    child.on("error", (e: Error) => {
      spawnError = e.message;
      finish(null);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

export function toolOk(r: ToolResult): boolean {
  return r.code === 0 && !r.timedOut && !r.aborted && r.spawnError === undefined;
}

/** 원인 블록. 사람에게 보이는 첫 줄과 stderr 꼬리 열두 줄. */
export function describeToolFailure(what: string, r: ToolResult): string {
  const why =
    r.spawnError !== undefined
      ? `실행하지 못했어요 (${r.spawnError})`
      : r.aborted
        ? "종료 중이라 멈췄어요"
        : r.timedOut
          ? "시간 안에 끝나지 않았어요"
          : `종료 코드 ${r.code}`;
  const tail = r.stderr.trim().split("\n").slice(-12).join("\n");
  return tail === "" ? `${what}: ${why}` : `${what}: ${why}\n${tail}`;
}
```

`desktop/src/services/pg-handle.ts`:

```ts
import { execFile, spawn } from "child_process";
import { makeSink, sinkTails } from "../api-process";
import { pgToolEnv, PG_SOCKET_PORT, type PgBinaries, type PgLayout } from "./pg-layout";
import type { ProcessInfo } from "./pg-pidfile";
import type { SpawnFn } from "./tool-runner";
import type { ServiceHandle } from "./types";

/**
 * postmaster의 프로세스 수준 (Phase 3 스펙 §6.4 "핸들"·"종료").
 *
 * Phase 1·2의 launchDev/launchPackaged 핸들을 쓰지 않는다. 그 stop()은 유예를 넘기면 끝을 보장하려고 더 센 신호로
 * 올라가고(api-process.ts의 escalate), dev 런처는 프로세스 그룹 전체에 신호를 보낸다. postmaster에는 둘 다 금지다 —
 * 백엔드 자식과 공유 메모리를 남기고, 자식에게 신호를 전달하는 것은 postmaster 자신의 일이다. 그래서 이 파일의 신호
 * 타입에는 SIGINT(fast)와 SIGQUIT(immediate)만 있다.
 */

export type PostmasterSignal = "SIGINT" | "SIGQUIT";
export type PostmasterStopResult = "fast" | "immediate" | "leaked";

export interface PostmasterStopDeps {
  signal(pid: number, sig: PostmasterSignal): void;
  alive(): boolean;
  pollMs?: number;
}

export async function stopPostmaster(
  pid: number | undefined,
  fastGraceMs: number,
  immediateGraceMs: number,
  deps: PostmasterStopDeps,
): Promise<PostmasterStopResult> {
  if (!deps.alive()) return "fast";
  // 믿을 수 없는 pid에는 신호를 보내지 않는다. process.kill(0, …)은 우리 프로세스 그룹 전체다.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return "leaked";
  const pollMs = deps.pollMs ?? 100;
  const gone = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (deps.alive() && Date.now() < until) await new Promise((r) => setTimeout(r, pollMs));
    return !deps.alive();
  };
  deps.signal(pid, "SIGINT");
  if (await gone(fastGraceMs)) return "fast";
  // immediate도 커밋된 데이터는 WAL로 보존한다. 다음 기동이 crash recovery를 한다.
  deps.signal(pid, "SIGQUIT");
  if (await gone(immediateGraceMs)) return "immediate";
  return "leaked";
}

export function postmasterArgs(layout: PgLayout): string[] {
  const c = (setting: string) => ["-c", setting];
  return [
    "-D",
    layout.pgdata,
    // TCP를 열지 않는다. Docker의 5432·Homebrew PostgreSQL과 포트가 부딪힐 수 없게 구조로 막는다 (스펙 §6.3).
    ...c("listen_addresses="),
    ...c(`unix_socket_directories=${layout.runDir}`),
    ...c("unix_socket_permissions=0700"),
    ...c(`port=${PG_SOCKET_PORT}`),
    // 서버 로그를 앱의 파이프가 아니라 서버가 직접 파일에 쓰게 한다. 앱이 죽어 고아가 된 서버의 기록도 남는다.
    ...c("logging_collector=on"),
    ...c(`log_directory=${layout.logDir}`),
    ...c("log_filename=postgres-%a.log"),
    ...c("log_rotation_age=1d"),
    ...c("log_rotation_size=10MB"),
    ...c("log_truncate_on_rotation=on"),
  ];
}

export interface PostmasterLaunch {
  binaries: PgBinaries;
  layout: PgLayout;
  /** 수집기가 뜨기 전의 초기 오류(권한·락·설정)가 stderr로 온다. 그것을 받는 파일. */
  logFile: string;
  immediateGraceMs: number;
  spawnFn?: SpawnFn;
}

export function spawnPostmaster(o: PostmasterLaunch): ServiceHandle {
  const sink = makeSink(o.logFile);
  // pg_ctl start를 쓰지 않는다 — 내부의 /bin/sh -c "exec postgres … 2>&1 &"가 서버 stderr를 합친다 (Phase 0 규칙 2b).
  // 자기 프로세스 그룹으로 띄운다: 없으면 dev 터미널의 Ctrl-C가 종료 순서(worker → embed → api → postgres)를 건너뛰고
  // postmaster에 먼저 닿는다.
  const child = (o.spawnFn ?? spawn)(o.binaries.postgres, postmasterArgs(o.layout), {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: pgToolEnv(),
  });
  let code: number | null = null;
  const listeners: Array<(c: number) => void> = [];
  const settle = (c: number) => {
    if (code !== null) return;
    code = c;
    sink.close();
    for (const l of listeners) {
      try {
        l(c);
      } catch {
        // 알릴 곳이 없다. 자식은 이미 죽었다.
      }
    }
  };
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (c: number | null) => settle(c ?? 1));
  child.on("error", (e: Error) => {
    sink.write(`spawn failed: ${e.message}\n`, true);
    settle(-1);
  });
  const pid = child.pid;
  const signal = (p: number, sig: PostmasterSignal) => {
    try {
      process.kill(p, sig);
    } catch {
      // 이미 죽었다(ESRCH).
    }
  };
  return {
    get pid() {
      return pid;
    },
    alive: () => code === null,
    ...sinkTails(sink),
    exitCode: () => code,
    onExit(listener: (c: number) => void) {
      if (code !== null) listener(code);
      else listeners.push(listener);
    },
    async stop(graceMs: number) {
      await stopPostmaster(pid, graceMs, o.immediateGraceMs, { signal, alive: () => code === null });
    },
  };
}

/** 그 pid가 살아 있나. 신호 0은 존재만 묻는다. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM은 "있는데 우리 것이 아니다"다.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps -o comm=`·`-o args=`. 그 pid가 없으면 null, ps 자체가 실패하면 던진다 — 락 판정은 그것을 "증명 불가"로 읽는다. */
export async function psInfo(pid: number): Promise<ProcessInfo | null> {
  const field = (name: "comm" | "args") =>
    new Promise<string | null>((resolve, reject) => {
      execFile("/bin/ps", ["-o", `${name}=`, "-p", String(pid)], { timeout: 2_000 }, (err, stdout) => {
        if (err === null) {
          resolve(stdout.trim());
          return;
        }
        // ps는 그 pid가 없으면 exit 1에 빈 출력이다. 그것은 "없다"이지 실패가 아니다.
        if ((err as { code?: unknown }).code === 1 && stdout.trim() === "") {
          resolve(null);
          return;
        }
        reject(err);
      });
    });
  const comm = await field("comm");
  if (comm === null) return null;
  const args = await field("args");
  return args === null ? null : { comm, args };
}

/** 이전 실행이 남긴 postmaster(우리 자식이 아니다)를 내린다. */
export function stopOrphanPostmaster(pid: number, fastGraceMs: number, immediateGraceMs: number): Promise<PostmasterStopResult> {
  return stopPostmaster(pid, fastGraceMs, immediateGraceMs, {
    signal: (p, sig) => {
      try {
        process.kill(p, sig);
      } catch {
        // 이미 죽었다.
      }
    },
    alive: () => processExists(pid),
  });
}
```

- [ ] **Step 5: 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop exec vitest run tests/tool-runner.test.ts tests/pg-handle.test.ts && pnpm --filter damwha-desktop run lint`
Expected: PASS — 17 tests. lint 0(`@ts-expect-error` 줄이 실제로 오류를 기대하므로 lint가 통과한다는 것은 `PostmasterSignal`이 SIGKILL을 받지 않는다는 뜻이다).

- [ ] **Step 6: 변이로 확인한다**

(a) `PostmasterSignal`에 `| "SIGKILL"`을 더하고 `pnpm --filter damwha-desktop run lint` → `Unused '@ts-expect-error' directive`로 실패. 되돌린다.
(b) `runTool`의 `opts.signal?.addEventListener("abort", onAbort, …)` 줄을 지우고 `-t "ends a tool when the signal aborts"` → FAIL(5초 대기 뒤 `aborted: false`). 되돌린다.

- [ ] **Step 7: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/services/tool-runner.ts desktop/src/services/pg-handle.ts desktop/tests/tool-runner.test.ts desktop/tests/pg-handle.test.ts
git commit -F - <<'MSG'
feat(desktop): 중단 가능한 도구 실행기와 SIGINT→SIGQUIT만 쓰는 postmaster 핸들을 더한다

initdb·psql·pg_dump가 멈추면 감독자의 준비 유예도 ⌘Q도 그것을 기다린다. 모든 도구가
deadline과 AbortSignal을 받는 한 실행기를 거치게 했다.

postmaster에는 Phase 1·2 핸들을 쓰지 않는다 — 그 stop은 SIGKILL로 올라가고 dev 런처는
그룹에 신호를 보낸다. 신호 타입을 SIGINT·SIGQUIT로 좁혀 컴파일러가 막게 했고, 남으면
leaked로 보고한다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 5 PASS, lint 0. Step 6 두 변이 실패(출력 첨부).
- `grep -n "SIGKILL" desktop/src/services/pg-handle.ts` → 0건.

**Review:**
- `stopPostmaster`가 pid를 검증하는가(`0`·음수·undefined에 신호를 보내지 않는다).
- `psInfo`가 "없음"(exit 1 + 빈 출력)과 "실패"를 구별하는가. 뒤섞이면 락 판정이 증명 없이 락을 지운다.
- `runTool`이 어떤 경우에도 던지지 않는가(`error`·`close` 둘 다 한 번만 resolve).
- `spawnPostmaster`의 env가 앱의 env를 물려주지 않는가(`PGHOST` 류가 새지 않는다).

---

## Task 7: 원인 카탈로그와 안내 — 내장 DB·마이그레이션 원인을 더한다

스펙 §6.7의 표. 어댑터(Task 8·9)가 원인 문구를 여기서 가져다 쓰므로 먼저 둔다. Docker 원인(`dockerDaemonDown`·`dockerMissing`)은 compose 어댑터가 아직 쓰므로 **이 Task에서 지우지 않는다** — Task 12가 compose 어댑터와 함께 지운다.

**Files:**
- Modify: `desktop/src/causes.ts`
- Modify: `desktop/src/shell-hints.ts`
- Modify: `desktop/tests/recovery-hint.test.ts` (`SAMPLE_ARGS`와 새 테스트)

**Interfaces:**
- Consumes: 없음
- Produces: `CAUSES`의 새 키와 텍스트 함수 시그니처 — 뒤 Task가 정확히 이 이름으로 부른다.

| 키 | `text` 시그니처 |
| --- | --- |
| `pgBundleMissing` | `(names: readonly string[]) => string` |
| `pgSocketPathTooLong` | `(socketPath: string, bytes: number) => string` |
| `pgPairingRefused` | `(why: string, pgdata: string, storage: string) => string` |
| `pgVersionMismatch` | `(found: string, want: string) => string` |
| `pgControldataFailed` | `(detail: string) => string` |
| `pgLockUnprovable` | `(pid: number, file: string, why: string) => string` |
| `pgOrphanStuck` | `(pid: number) => string` |
| `pgInitdbFailed` | `(block: string) => string` |
| `pgCreatedbFailed` | `(block: string) => string` |
| `pgQueryFailed` | `(block: string) => string` |
| `pgStopLeaked` | `(pid: number \| string) => string` |
| `pgStopping` | `string` |
| `migrationStatusFailed` | `(block: string) => string` |
| `migrationUnknown` | `(names: readonly string[]) => string` |
| `backupFailed` | `(block: string) => string` |
| `migrationFailed` | `(block: string, backup: string \| null) => string` |
| `migrationsStillPending` | `(count: number, names: string) => string` |
| `externalDatabase` | `string` |

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/recovery-hint.test.ts`의 `SAMPLE_ARGS`에 다음 항목을 더한다(타입이 템플릿 원인 전부를 요구하므로 빠뜨리면 lint가 걸린다):

```ts
  pgBundleMissing: [["initdb", "psql"]],
  pgSocketPathTooLong: ["/x/run/.s.PGSQL.5432", 120],
  pgPairingRefused: ["파일 저장소가 다른 데이터베이스의 것이에요", "/u/data/postgres", "/u/data/storage"],
  pgVersionMismatch: ["15", "16"],
  pgControldataFailed: ["pg_controldata: 종료 코드 1"],
  pgLockUnprovable: [4242, "/u/data/postgres/postmaster.pid", "ps가 실패했어요"],
  pgOrphanStuck: [4242],
  pgInitdbFailed: ["initdb: 종료 코드 1"],
  pgCreatedbFailed: ["createdb: 종료 코드 1"],
  pgQueryFailed: ["psql: 종료 코드 1"],
  pgStopLeaked: [4242],
  migrationStatusFailed: ["마이그레이션 러너: 종료 코드 1"],
  migrationUnknown: [["999_from_future.sql"]],
  backupFailed: ["pg_dump: 종료 코드 1"],
  migrationFailed: ["마이그레이션 러너: 종료 코드 1\nERROR: relation \"x\" does not exist", "/u/backups/20260914T101500Z-before-025_x.sql.dump"],
  migrationsStillPending: [1, "025_x.sql"],
```

같은 파일 `recoveryHint — 스펙 §6.12의 표가 말하는 것`의 `rows`에서 worker `readyTimeout` 행을 바꾼다 — Phase 3부터 `DATABASE_URL`은 앱이 파생하므로 안내가 config.json을 가리키면 틀린 말이다:

```ts
    // P2-C10: 유예를 넘긴 worker에는 DB 연결 문제일 수 있다는 원인이 보여야 한다 (Phase 2 스펙 §8).
    ["readyTimeout", "worker", /데이터베이스에 연결하지 못해.*데이터베이스 줄의 상태/],
```

파일 끝에 다음 describe를 더한다:

```ts
describe("Phase 3 causes", () => {
  it("names the backup in a migration failure so the person knows where the data before it is", () => {
    const text = CAUSES.migrationFailed.text("boom", "/u/backups/b.dump");
    expect(text).toContain("/u/backups/b.dump");
    expect(CAUSES.migrationFailed.text("boom", null)).not.toContain("백업");
  });

  it("never tells a person to delete the data folder — dev and packaged share one cluster", () => {
    // 스펙 §6.1·§6.5-2. 안내가 data 폴더를 지우라고 하면 실제 데이터를 지우라는 말이다.
    for (const id of CAUSE_IDS) {
      const hint = HINTS[id];
      const texts = hint === null ? [] : typeof hint === "string" ? [hint] : Object.values(hint);
      for (const t of texts) expect(t, id).not.toMatch(/(data|데이터) ?폴더를 (지우|삭제|정리)/);
    }
  });

  it("points a postgres readiness timeout and a postgres exit at the server's own logs", () => {
    expect(recoveryHint(s({ id: "postgres", detail: CAUSES.readyTimeout.text }))).toMatch(/logs\/postgres\//);
    expect(recoveryHint(s({ id: "postgres", detail: CAUSES.processExited.text(1) }))).toMatch(/logs\/postgres\//);
  });

  it("does not tell the worker to fix DATABASE_URL in config.json — the app derives it now", () => {
    expect(recoveryHint(s({ id: "worker", detail: CAUSES.readyTimeout.text }))).not.toMatch(/DATABASE_URL/);
  });
});
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/recovery-hint.test.ts`
Expected: FAIL — `SAMPLE_ARGS`의 키가 `CAUSES`에 없어 타입 오류, 새 describe 실패.

- [ ] **Step 2: `causes.ts`에 원인을 더한다**

`desktop/src/causes.ts`에서 `repoRootMissing` 항목 **바로 뒤**(`apiDbUnreachable` 앞)에 다음을 넣는다. 키 순서가 매칭 우선순위라, 구체적인 원인을 감독자의 일반 문구보다 앞에 둔다.

```ts
  /** postgres — 번들에 PG 실행 파일이 없다 (Phase 3 스펙 §6.8). */
  pgBundleMissing: {
    match: /내장 데이터베이스 실행 파일이 없어요/,
    text: (names: readonly string[]) => `내장 데이터베이스 실행 파일이 없어요 (${names.join(", ")}).`,
    selfRecovers: false,
  },
  /** postgres — macOS sun_path 한도 (스펙 §6.3). */
  pgSocketPathTooLong: {
    match: /데이터베이스 소켓 경로가 너무 길어요/,
    text: (socketPath: string, bytes: number) =>
      `데이터베이스 소켓 경로가 너무 길어요 (${bytes}바이트, 최대 103바이트): ${socketPath}`,
    selfRecovers: false,
  },
  /** postgres — 판정표 1·2의 거부 (스펙 §6.2). why는 어떤 행인지를 사람 말로 적는다. */
  pgPairingRefused: {
    match: /짝이 맞지 않아 데이터베이스를 열지 않았어요/,
    text: (why: string, pgdata: string, storage: string) =>
      `데이터와 파일 저장소의 짝이 맞지 않아 데이터베이스를 열지 않았어요 — ${why} (데이터베이스: ${pgdata}, 파일 저장소: ${storage})`,
    selfRecovers: false,
  },
  /** postgres — PG_VERSION이 번들 메이저와 다르다. 메이저 업그레이드는 Phase 6. */
  pgVersionMismatch: {
    match: /데이터 폴더의 PostgreSQL 버전\(/,
    text: (found: string, want: string) => `데이터 폴더의 PostgreSQL 버전(${found})이 앱의 버전(${want})과 달라요.`,
    selfRecovers: false,
  },
  /** postgres — pg_controldata가 클러스터를 읽지 못했다. */
  pgControldataFailed: {
    match: /데이터베이스 폴더를 읽지 못했어요/,
    text: (detail: string) => `데이터베이스 폴더를 읽지 못했어요 — ${detail}`,
    selfRecovers: false,
  },
  /** postgres — 락 파일의 pid가 누구인지 증명하지 못했다 (ps 실패). 지우지 않는다. */
  pgLockUnprovable: {
    match: /데이터베이스 잠금 파일의 주인/,
    text: (pid: number, file: string, why: string) =>
      `데이터베이스 잠금 파일의 주인(pid ${pid})을 확인하지 못했어요 (${file}) — ${why}`,
    selfRecovers: false,
  },
  /** postgres — 이전 실행의 고아 postmaster가 SIGINT·SIGQUIT에도 남았다. */
  pgOrphanStuck: {
    match: /이전 실행이 남긴 데이터베이스\(pid/,
    text: (pid: number) => `이전 실행이 남긴 데이터베이스(pid ${pid})가 종료되지 않아요.`,
    selfRecovers: false,
  },
  pgInitdbFailed: {
    match: /데이터베이스 클러스터를 만들지 못했어요/,
    text: (block: string) => `새 데이터베이스 클러스터를 만들지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  pgCreatedbFailed: {
    match: /데이터베이스\(damwha\)를 만들지 못했어요/,
    text: (block: string) => `데이터베이스(damwha)를 만들지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  /** postgres — 판정표 2의 psql 조회 자체가 실패했다. */
  pgQueryFailed: {
    match: /데이터베이스 상태를 확인하지 못했어요/,
    text: (block: string) => `데이터베이스 상태를 확인하지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  /** postgres 종료 — fast·immediate 유예 뒤에도 postmaster가 남았다. 앱은 SIGKILL하지 않는다. */
  pgStopLeaked: {
    match: /데이터베이스\(pid [^)]*\)가 종료되지 않았어요/,
    text: (pid: number | string) => `데이터베이스(pid ${pid})가 종료되지 않았어요.`,
    selfRecovers: false,
  },
  /** postgres degraded — postmaster.pid가 stopping이다. */
  pgStopping: {
    match: /데이터베이스가 종료되는 중이에요/,
    text: "데이터베이스가 종료되는 중이에요.",
    selfRecovers: false,
  },
  /** api 게이트 — 러너가 실패했거나 상태 줄을 내지 않았다. 무출력 exit 0도 여기다 (스펙 §10). */
  migrationStatusFailed: {
    match: /마이그레이션 상태를 확인하지 못했어요/,
    text: (block: string) => `마이그레이션 상태를 확인하지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  /** api 게이트 — 번들에 없는 이름이 적용돼 있다. 옛 앱이 새 스키마를 열지 않는다 (스펙 §6.5-2). */
  migrationUnknown: {
    match: /더 새 버전의 앱이 이 데이터를 업데이트했어요/,
    text: (names: readonly string[]) => `더 새 버전의 앱이 이 데이터를 업데이트했어요 (${names.join(", ")}).`,
    selfRecovers: false,
  },
  /** api 게이트 — 적용 전 백업 실패. 적용하지 않았다. */
  backupFailed: {
    match: /백업을 만들지 못해 마이그레이션을 적용하지 않았어요/,
    text: (block: string) => `마이그레이션 전 백업을 만들지 못해 마이그레이션을 적용하지 않았어요.\n${block}`,
    selfRecovers: false,
  },
  /** api 게이트 — 러너가 실패했다. 백업이 있으면 그 경로를 싣는다. */
  migrationFailed: {
    match: /^마이그레이션을 적용하지 못했어요/m,
    text: (block: string, backup: string | null) =>
      `마이그레이션을 적용하지 못했어요.${backup === null ? "" : ` 적용 전 백업: ${backup}`}\n${block}`,
    selfRecovers: false,
  },
  /** api — 실행 게이트를 통과했는데 러너나 API가 미적용을 말한다. 두 트리가 어긋났다 (스펙 §6.5-5). */
  migrationsStillPending: {
    match: /마이그레이션을 실행했는데 \d+개가 여전히 적용되지 않았어요/,
    text: (count: number, names: string) => `마이그레이션을 실행했는데 ${count}개가 여전히 적용되지 않았어요 (${names}).`,
    selfRecovers: false,
  },
  /** postgres — DEBUG_EXTERNAL_DATABASE_URL로 붙었다. 실패가 아니라 상시 경고다 (스펙 §6.1). */
  externalDatabase: {
    match: /외부 DB\(디버깅\)/,
    text: "외부 DB(디버깅) — DEBUG_EXTERNAL_DATABASE_URL로 연결했어요. 앱은 이 데이터베이스를 띄우지도, 마이그레이션하지도 않아요.",
    selfRecovers: false,
  },
```

- [ ] **Step 3: `shell-hints.ts`에 안내를 더한다**

`HINTS` 객체의 `repoRootMissing` 줄 뒤에 넣는다:

```ts
  pgBundleMissing:
    "앱을 다시 설치해 주세요. 개발 중이면 `bash desktop/scripts/build-postgres.sh`를 실행한 뒤 다시 시도해 주세요.",
  pgSocketPathTooLong: "지금 macOS 계정에서는 내장 데이터베이스를 열 수 없어요. 계정 이름이 짧은 계정에서 실행해 주세요.",
  pgPairingRefused:
    "data 폴더와 그 안의 postgres·storage를 옮기거나 바꾸지 않았는지 확인해 주세요. 앱은 아무것도 지우거나 새로 만들지 않았어요.",
  pgVersionMismatch: "이 데이터를 만든 버전의 앱으로 열어 주세요. 앱은 데이터를 바꾸지 않았어요.",
  pgControldataFailed: "data/postgres가 손상되지 않았는지 확인해 주세요. 앱은 아무것도 바꾸지 않았어요.",
  pgLockUnprovable: "활성 상태 보기에서 그 pid가 무엇인지 확인한 뒤 다시 시도해 주세요. 앱은 잠금 파일을 지우지 않았어요.",
  pgOrphanStuck: "활성 상태 보기에서 그 postgres 프로세스를 종료한 뒤 다시 시도해 주세요.",
  pgInitdbFailed: "logs/postgres.log를 확인한 뒤 다시 시도해 주세요.",
  pgCreatedbFailed: "logs/postgres/ 폴더의 최근 로그를 확인한 뒤 다시 시도해 주세요.",
  pgQueryFailed: "logs/postgres/ 폴더의 최근 로그를 확인한 뒤 다시 시도해 주세요.",
  // 종료 경고와 재확인 중의 상태다. 사람이 할 일은 종료 대화상자가 말한다.
  pgStopLeaked: null,
  pgStopping: null,
  migrationStatusFailed: "logs/supervisor.log를 확인한 뒤 다시 시도해 주세요.",
  migrationUnknown:
    "이 데이터를 업데이트한 브랜치나 앱 버전으로 실행하거나, config.json의 DEBUG_EXTERNAL_DATABASE_URL로 외부 DB를 쓰세요.",
  backupFailed: "디스크 여유 공간을 확인한 뒤 다시 시도해 주세요.",
  migrationFailed: "원인을 고친 앱으로 다시 실행해 주세요. 적용 전 데이터는 위 백업에 있어요.",
  migrationsStillPending: "앱을 다시 만들어 주세요 — 마이그레이션 러너와 API가 서로 다른 파일을 보고 있어요.",
  externalDatabase: null,
```

기존 두 항목을 바꾼다:

```ts
  // worker만 원인을 좁힐 수 있다: ready 줄은 DB에 붙은 **뒤에** 찍히므로, 프로세스가 살아서
  // 유예를 넘겼다면 DB 연결에서 멈춰 있는 것이다 (Phase 2 스펙 §8, 완료 기준 P2-C10). Phase 3부터
  // DATABASE_URL은 앱이 파생하므로 config.json을 가리키지 않는다. postgres는 crash recovery가 길 수 있다.
  readyTimeout: {
    worker: "데이터베이스에 연결하지 못해 멈춰 있을 수 있어요. 데이터베이스 줄의 상태를 확인한 뒤 다시 시도해 주세요.",
    postgres: "데이터베이스가 복구 중이면 오래 걸릴 수 있어요. logs/postgres/ 폴더를 확인한 뒤 다시 시도해 주세요.",
  },
```

```ts
  // 뒤따르는 stderr 블록이 원인이다. 그 블록이 아는 원인(spawnNotFound 등)이면 그쪽이 먼저 맞는다.
  // postgres는 logging_collector가 뜬 뒤의 오류가 stderr가 아니라 서버 로그에 있다.
  processExited: { postgres: "logs/postgres/ 폴더의 최근 로그를 확인한 뒤 다시 시도해 주세요." },
```

- [ ] **Step 4: 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop exec vitest run tests/recovery-hint.test.ts tests/status-view.test.ts && pnpm --filter damwha-desktop run lint`
Expected: PASS. `every cause is recognised as itself`가 새 원인 18개를 포함해 통과한다. lint 0.

만약 `status-view.test.ts`의 기존 테스트가 worker `readyTimeout` 안내 문구를 문자열로 단언해 실패하면, 그 단언을 `HINTS.readyTimeout`에서 읽도록 바꾼다(문구를 두 곳에 적지 않는다).

- [ ] **Step 5: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/causes.ts desktop/src/shell-hints.ts desktop/tests/
git commit -F - <<'MSG'
feat(desktop): 내장 DB와 마이그레이션 게이트의 원인·안내를 카탈로그에 더한다

어댑터가 원인 문구를 한 곳에서 가져다 쓰도록 먼저 넣는다. 안내는 사람이 할 일만 말하고,
앱이 아무것도 지우지 않았다는 사실을 거부 원인마다 적는다. dev와 packaged가 한 클러스터를
쓰므로 어떤 안내도 data 폴더를 지우라고 하지 않는다 — 테스트가 그것을 본다.

worker의 준비 유예 안내는 더 이상 config.json의 DATABASE_URL을 가리키지 않는다. Phase 3부터
그 값은 앱이 파생한다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 4 PASS, lint 0.
- `node -e` 없이도 `every cause is recognised as itself`가 새 원인 전부를 샘플로 돈다(`SAMPLE_ARGS`에 18개 중 템플릿 16개가 있다).

**Review:**
- 새 원인의 `match`가 서로, 그리고 기존 원인(`pendingMigrations`의 `/적용되지 않은 마이그레이션이/` 등)과 겹치지 않는가.
- 거부 원인의 안내가 "앱은 아무것도 바꾸지 않았다"를 말하는가. 데이터 폴더 삭제를 권하는 문구가 없는가.
- `migrationFailed`가 백업 경로를 싣는가.

---

## Task 8: 내장·외부 postgres 어댑터

스펙 §6.4 전부와 §6.1의 외부 디버그 모드. **새 파일** `pg-service.ts`에 둔다 — compose 어댑터(`services/postgres.ts`)는 main이 아직 쓰므로 Task 12가 배선을 바꾸면서 지운다.

**Files:**
- Create: `desktop/src/services/pg-service.ts`
- Test: `desktop/tests/pg-service.test.ts`
- Test: `desktop/tests/pg-service.integration.test.ts` (실번들, 없으면 건너뜀)

**Interfaces:**
- Consumes: Task 4 `ServiceFailure`·`manualUnlessTagged`·`LaunchContext.signal`; Task 5 전부; Task 6 `ToolOptions`·`ToolResult`·`toolOk`·`describeToolFailure`·`PostmasterStopResult`; Task 7 `CAUSES.pg*`·`externalDatabase`; `desktop/src/stderr.ts`의 `failureBlock`.
- Produces:
  - `PG_READY_TIMEOUT_MS = 180_000`, `PG_HEALTH_INTERVAL_MS = 10_000`, `PG_FAST_GRACE_MS = 30_000`, `PG_IMMEDIATE_GRACE_MS = 10_000`, `PG_TOOL_DEADLINES = { initdb: 120_000, controldata: 10_000, psql: 15_000, createdb: 30_000 }`
  - `interface EmbeddedPostgresDeps { binaries: PgBinaries; layout: PgLayout; runTool(bin, args, opts): Promise<ToolResult>; psInfo(pid: number): Promise<ProcessInfo | null>; spawnPostmaster(logFile: string): ServiceHandle; stopOrphan(pid: number): Promise<PostmasterStopResult>; log(line: string): void }`
  - `embeddedPostgresSpec(deps: EmbeddedPostgresDeps): ServiceSpec`
  - `externalPostgresSpec(): ServiceSpec`

값의 근거: 준비 유예 180초는 crash recovery를 포함한 상한이고 Task 13이 실측과 대조한다. fast 30초·immediate 10초는 클라이언트가 없는 시점의 종료이므로 여유다. 도구 deadline은 Task 3의 `initdb` 실측(수 초)의 수십 배다.

- [ ] **Step 1: 실패하는 단위 테스트를 쓴다**

`desktop/tests/pg-service.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceFailure } from "../src/services/failure";
import { pgBinaries, pgLayout, PG_BINARY_NAMES, type PgLayout } from "../src/services/pg-layout";
import { parseMarker, serializeMarker } from "../src/services/pg-pairing";
import {
  embeddedPostgresSpec,
  externalPostgresSpec,
  PG_FAST_GRACE_MS,
  type EmbeddedPostgresDeps,
} from "../src/services/pg-service";
import type { ToolResult } from "../src/services/tool-runner";
import type { LaunchContext, LaunchResult, ServiceHandle } from "../src/services/types";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-pgsvc-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
const fail = (code: number, stderr = "boom"): ToolResult => ({ code, stdout: "", stderr, timedOut: false, aborted: false });

type FakeHandle = ServiceHandle & { markReady(status?: string): void; stops: number[]; die(): void };

function fakeHandle(layout: PgLayout, pid = 5151): FakeHandle {
  let alive = true;
  const stops: number[] = [];
  return {
    pid,
    alive: () => alive,
    stderrTail: () => "",
    stdoutTail: () => "",
    exitCode: () => (alive ? null : 1),
    onExit: () => undefined,
    async stop(graceMs: number) {
      stops.push(graceMs);
    },
    stops,
    die() {
      alive = false;
    },
    markReady(status = "ready   ") {
      fs.writeFileSync(
        path.join(layout.pgdata, "postmaster.pid"),
        [String(pid), layout.pgdata, "0", "5432", layout.runDir, "", "", status, ""].join("\n"),
      );
      fs.mkdirSync(layout.runDir, { recursive: true });
      fs.writeFileSync(layout.socketFile, "");
    },
  };
}

function setup(over: Partial<EmbeddedPostgresDeps> = {}) {
  const layout = pgLayout(path.join(root, "ud"));
  const bundleDir = path.join(root, "bundle");
  fs.mkdirSync(path.join(bundleDir, "bin"), { recursive: true });
  for (const n of PG_BINARY_NAMES) {
    const f = path.join(bundleDir, "bin", n);
    fs.writeFileSync(f, "#!/bin/sh\n");
    fs.chmodSync(f, 0o755);
  }
  const world = {
    clusterId: "7412345678901234567",
    oid: null as number | null,
    calls: [] as Array<{ tool: string; args: readonly string[]; signal?: AbortSignal }>,
    override: {} as Partial<Record<string, (args: readonly string[]) => ToolResult>>,
  };
  const log: string[] = [];
  const handles: FakeHandle[] = [];
  const orphans: number[] = [];
  const deps: EmbeddedPostgresDeps = {
    binaries: pgBinaries(bundleDir),
    layout,
    log: (l) => void log.push(l),
    runTool: async (bin, args, opts) => {
      const tool = path.basename(bin);
      world.calls.push({ tool, args, signal: opts.signal });
      const custom = world.override[tool];
      if (custom !== undefined) return custom(args);
      if (tool === "initdb") {
        const d = args[args.indexOf("-D") + 1];
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "PG_VERSION"), "16\n");
        return ok();
      }
      if (tool === "pg_controldata") return ok(`pg_control version number:            1300\nDatabase system identifier:           ${world.clusterId}\n`);
      if (tool === "psql") return ok(world.oid === null ? "\n" : `${world.oid}\n`);
      if (tool === "createdb") {
        world.oid = 16384;
        return ok();
      }
      return fail(127, `unexpected ${tool}`);
    },
    psInfo: async () => null,
    stopOrphan: async (pid) => {
      orphans.push(pid);
      return "fast";
    },
    spawnPostmaster: () => {
      const h = fakeHandle(layout);
      handles.push(h);
      return h;
    },
    ...over,
  };
  const ctx: LaunchContext = {
    repoRoot: "/r",
    userData: layout.userData,
    packaged: false,
    env: {},
    bins: { uv: null },
    searchDirs: [],
    logFile: (id) => path.join(layout.userData, "logs", `${id}.log`),
    signal: new AbortController().signal,
  };
  const existing = (opts: { marker?: string | null; storageFile?: boolean; pgVersion?: string } = {}) => {
    fs.mkdirSync(layout.pgdata, { recursive: true });
    fs.writeFileSync(path.join(layout.pgdata, "PG_VERSION"), `${opts.pgVersion ?? "16"}\n`);
    fs.mkdirSync(layout.storage, { recursive: true });
    const marker = opts.marker === undefined ? serializeMarker({ clusterId: world.clusterId, databaseOid: 16384 }) : opts.marker;
    if (marker !== null) fs.writeFileSync(layout.marker, marker);
    if (opts.storageFile === true) {
      fs.mkdirSync(path.join(layout.storage, "meetings", "mtg_1"), { recursive: true });
      fs.writeFileSync(path.join(layout.storage, "meetings", "mtg_1", "original.m4a"), "audio");
    }
  };
  return { layout, world, log, handles, orphans, deps, ctx, existing, spec: embeddedPostgresSpec(deps) };
}

const tools = (w: { calls: Array<{ tool: string }> }) => w.calls.map((c) => c.tool);

async function refusal(p: Promise<unknown>): Promise<ServiceFailure> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ServiceFailure);
  expect((e as ServiceFailure).recovery).toBe("manual");
  return e as ServiceFailure;
}

describe("embeddedPostgresSpec.launch — first run", () => {
  it("creates the cluster in a temporary directory, writes the marker, then moves it into place", async () => {
    const t = setup();
    const r = await t.spec.launch(t.ctx);
    expect(tools(t.world)).toEqual(["initdb", "pg_controldata"]);
    const initdbArgs = t.world.calls[0].args;
    expect(initdbArgs[initdbArgs.indexOf("-D") + 1]).toMatch(/data\/postgres\.initdb-[0-9a-f]{8}$/);
    expect(initdbArgs).toEqual(expect.arrayContaining(["-U", "damwha", "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject"]));
    expect(t.world.calls[1].args[1]).toBe(initdbArgs[initdbArgs.indexOf("-D") + 1]); // 옮기기 전의 임시 디렉터리에서 id를 읽는다
    expect(fs.existsSync(path.join(t.layout.pgdata, "PG_VERSION"))).toBe(true);
    expect(parseMarker(fs.readFileSync(t.layout.marker, "utf8"))).toEqual({ clusterId: t.world.clusterId, databaseOid: null });
    expect(fs.readdirSync(t.layout.dataDir).sort()).toEqual(["postgres", "storage"]);
    expect(r).toMatchObject({ owned: true });
    expect(t.handles).toHaveLength(1);
  });

  it("removes the temporary directory and leaves no cluster and no marker when initdb fails", async () => {
    const t = setup();
    t.world.override.initdb = (args) => {
      fs.mkdirSync(args[args.indexOf("-D") + 1], { recursive: true });
      return fail(1, "initdb: could not create directory");
    };
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/데이터베이스 클러스터를 만들지 못했어요/);
    expect(fs.existsSync(t.layout.pgdata)).toBe(false);
    expect(fs.existsSync(t.layout.marker)).toBe(false);
    expect(fs.readdirSync(t.layout.dataDir)).toEqual([]);
    expect(t.handles).toHaveLength(0);
  });

  it("clears a previous run's initdb leftovers but never follows a symlink with that name", async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.layout.dataDir, "postgres.initdb-deadbeef"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(t.layout.dataDir, "postgres.initdb-cafebabe"));
    await t.spec.launch(t.ctx);
    expect(fs.existsSync(path.join(t.layout.dataDir, "postgres.initdb-deadbeef"))).toBe(false);
    expect(fs.lstatSync(path.join(t.layout.dataDir, "postgres.initdb-cafebabe")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("embeddedPostgresSpec.launch — refusals change nothing", () => {
  it("refuses storage with files and no cluster, without running initdb", async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.layout.storage, "meetings", "mtg_37"), { recursive: true });
    fs.writeFileSync(path.join(t.layout.storage, "meetings", "mtg_37", "original.m4a"), "audio");
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/짝이 맞지 않아/);
    expect(tools(t.world)).toEqual([]);
    expect(fs.existsSync(t.layout.pgdata)).toBe(false);
  });

  it("refuses a cluster without a marker", async () => {
    const t = setup();
    t.existing({ marker: null });
    await refusal(t.spec.launch(t.ctx));
    expect(t.handles).toHaveLength(0);
  });

  it("refuses a marker from another cluster", async () => {
    const t = setup();
    t.existing({ marker: serializeMarker({ clusterId: "999", databaseOid: 16384 }) });
    await refusal(t.spec.launch(t.ctx));
    expect(t.handles).toHaveLength(0);
  });

  it("refuses another major version without reading the control file", async () => {
    const t = setup();
    t.existing({ pgVersion: "15" });
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/PostgreSQL 버전\(15\)/);
    expect(tools(t.world)).toEqual([]);
  });

  it("refuses when the bundle is incomplete and names what is missing", async () => {
    const t = setup();
    fs.rmSync(t.deps.binaries.pgDump);
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/pg_dump/);
    expect(fs.existsSync(t.layout.dataDir)).toBe(false);
  });

  it("turns an unexpected throw into a manual failure", async () => {
    const t = setup({ runTool: async () => { throw new Error("EACCES"); } });
    await refusal(t.spec.launch(t.ctx));
  });
});

describe("embeddedPostgresSpec.launch — the lock left by a previous run", () => {
  const pidfile = (t: ReturnType<typeof setup>, pid: number) =>
    fs.writeFileSync(path.join(t.layout.pgdata, "postmaster.pid"), [String(pid), t.layout.pgdata, "0", "5432", t.layout.runDir, "", "", "ready   ", ""].join("\n"));

  // 어댑터는 deps.psInfo를 부를 때마다 속성으로 읽는다. args에 레이아웃 경로가 들어가야 해서 setup 뒤에 바꿔 끼운다.
  const ourPostgres = (t: ReturnType<typeof setup>) => async () => ({
    comm: "/Applications/Damwha.app/Contents/Resources/postgres/bin/postgres",
    args: `/Applications/Damwha.app/Contents/Resources/postgres/bin/postgres -D ${t.layout.pgdata} -c port=5432`,
  });

  it("stops an orphaned postmaster on our data directory, then starts a new one", async () => {
    const t = setup();
    t.existing();
    pidfile(t, 4242);
    t.deps.psInfo = ourPostgres(t);
    await t.spec.launch(t.ctx);
    expect(t.orphans).toEqual([4242]);
    expect(t.handles).toHaveLength(1);
    expect(t.log.join("\n")).toMatch(/4242/);
  });

  it("refuses when the orphan will not stop", async () => {
    const t = setup({ stopOrphan: async () => "leaked" });
    t.existing();
    pidfile(t, 4242);
    t.deps.psInfo = ourPostgres(t);
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/pid 4242/);
    expect(t.handles).toHaveLength(0);
  });

  it("removes a stale lock whose pid now belongs to another program", async () => {
    const t = setup({ psInfo: async () => ({ comm: "/usr/bin/vim", args: "vim notes.txt" }) });
    t.existing();
    pidfile(t, 4242);
    fs.mkdirSync(t.layout.runDir, { recursive: true });
    fs.writeFileSync(`${t.layout.socketFile}.lock`, "4242\n");
    await t.spec.launch(t.ctx);
    expect(fs.existsSync(path.join(t.layout.pgdata, "postmaster.pid"))).toBe(false);
    expect(fs.existsSync(`${t.layout.socketFile}.lock`)).toBe(false);
    expect(t.orphans).toEqual([]);
    expect(t.handles).toHaveLength(1);
  });

  it("refuses and deletes nothing when ps cannot say who holds the lock", async () => {
    const t = setup({ psInfo: async () => { throw new Error("ps timed out"); } });
    t.existing();
    pidfile(t, 4242);
    const e = await refusal(t.spec.launch(t.ctx));
    expect(e.message).toMatch(/잠금 파일의 주인\(pid 4242\)/);
    expect(fs.existsSync(path.join(t.layout.pgdata, "postmaster.pid"))).toBe(true);
    expect(t.handles).toHaveLength(0);
  });

  it("leaves a lock of a dead pid to PostgreSQL", async () => {
    const t = setup({ psInfo: async () => null });
    t.existing();
    pidfile(t, 4242);
    await t.spec.launch(t.ctx);
    expect(fs.existsSync(path.join(t.layout.pgdata, "postmaster.pid"))).toBe(true);
    expect(t.handles).toHaveLength(1);
  });
});

describe("embeddedPostgresSpec.readiness", () => {
  async function launched(t: ReturnType<typeof setup>): Promise<LaunchResult> {
    return t.spec.launch(t.ctx);
  }

  it("is not ready until our own postmaster writes ready and the socket exists", async () => {
    const t = setup();
    const r = await launched(t);
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
    t.handles[0].markReady("starting");
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
    // 이전 postmaster의 파일에 남은 ready는 우리 것이 아니다.
    fs.writeFileSync(path.join(t.layout.pgdata, "postmaster.pid"), ["9999", t.layout.pgdata, "0", "5432", t.layout.runDir, "", "", "ready   ", ""].join("\n"));
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
  });

  it("creates the database once on a fresh cluster, records its oid, and does not ask again", async () => {
    const t = setup();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.calls.length = 0;
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "ready" });
    expect(tools(t.world)).toEqual(["psql", "createdb", "psql"]);
    expect(t.world.calls[0].args).toEqual(expect.arrayContaining(["-X", "-h", t.layout.runDir, "-d", "postgres"]));
    expect(parseMarker(fs.readFileSync(t.layout.marker, "utf8"))).toEqual({ clusterId: t.world.clusterId, databaseOid: 16384 });
    t.world.calls.length = 0;
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "ready" });
    expect(tools(t.world)).toEqual([]);
  });

  it("refuses a dropped database and does not recreate it", async () => {
    const t = setup();
    t.existing({ storageFile: true });
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.oid = null;
    const out = await t.spec.readiness(r, t.ctx);
    expect(out).toMatchObject({ kind: "failed", recovery: "manual" });
    expect(tools(t.world)).not.toContain("createdb");
  });

  it("refuses a recreated database", async () => {
    const t = setup();
    t.existing();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.oid = 20000;
    expect(await t.spec.readiness(r, t.ctx)).toMatchObject({ kind: "failed", recovery: "manual" });
  });

  it("waits when psql cannot connect yet (exit 2)", async () => {
    const t = setup();
    t.existing();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.override.psql = () => fail(2, "psql: error: connection to server failed");
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "not-ready" });
  });

  it("reports stopping as degraded", async () => {
    const t = setup();
    t.existing();
    const r = await launched(t);
    t.handles[0].markReady();
    t.world.oid = 16384;
    expect(await t.spec.readiness(r, t.ctx)).toEqual({ kind: "ready" });
    t.handles[0].markReady("stopping");
    expect(await t.spec.readiness(r, t.ctx)).toMatchObject({ kind: "degraded" });
  });

  it("hands the launch signal to every tool so ⌘Q can end them", async () => {
    const t = setup();
    const r = await launched(t);
    t.handles[0].markReady();
    await t.spec.readiness(r, t.ctx);
    expect(t.world.calls.every((c) => c.signal === t.ctx.signal)).toBe(true);
  });
});

describe("embeddedPostgresSpec.stop", () => {
  it("uses its own fast grace, not the supervisor's, and reports a leak without escalating", async () => {
    const t = setup();
    const r = await t.spec.launch(t.ctx);
    expect(await t.spec.stop(r, { graceMs: 5 })).toEqual({ stopped: false, leaked: [5151], detail: expect.stringMatching(/pid 5151/) });
    expect(t.handles[0].stops).toEqual([PG_FAST_GRACE_MS]);
    t.handles[0].die();
    expect(await t.spec.stop(r, { graceMs: 5 })).toEqual({ stopped: true, leaked: [] });
  });

  it("restarts with backoff now that the app owns the process", () => {
    const t = setup();
    expect(t.spec.restart).toEqual({ maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] });
    expect(t.spec.gate).toBe(true);
    expect(t.spec.dependsOn).toEqual([]);
  });
});

describe("externalPostgresSpec", () => {
  it("adopts the debug database and never launches or stops anything", async () => {
    const s = externalPostgresSpec();
    const ctx = {} as LaunchContext;
    expect(await s.detectExternal(ctx)).toEqual({ kind: "adopt", detail: expect.stringMatching(/외부 DB\(디버깅\)/) });
    expect(await s.stop({ handle: null, owned: false }, { graceMs: 1 })).toEqual({ stopped: true, leaked: [] });
    expect(s.restart).toBe("never");
  });
});
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/pg-service.test.ts`
Expected: FAIL — `../src/services/pg-service`를 해석하지 못한다.

- [ ] **Step 2: `pg-service.ts`를 쓴다**

`desktop/src/services/pg-service.ts`:

```ts
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../causes";
import { failureBlock } from "../stderr";
import { manualUnlessTagged, ServiceFailure } from "./failure";
import { DB_NAME, DB_SUPERUSER, PG_BINARY_NAMES, PG_MAJOR, pgToolEnv, socketPathTooLong, type PgBinaries, type PgLayout } from "./pg-layout";
import type { PostmasterStopResult } from "./pg-handle";
import {
  decideCluster,
  decideDatabase,
  parseControldataClusterId,
  parseMarker,
  readStorageFacts,
  writeMarkerAtomic,
  type ClusterRefusal,
  type DatabaseRefusal,
} from "./pg-pairing";
import { classifyLockOwner, parsePostmasterPid, type ProcessInfo } from "./pg-pidfile";
import { describeToolFailure, toolOk, type ToolOptions, type ToolResult } from "./tool-runner";
import type { LaunchContext, LaunchResult, ReadinessResult, ServiceHandle, ServiceSpec } from "./types";

/** crash recovery를 포함한 상한. Task 13이 실측과 대조한다. */
export const PG_READY_TIMEOUT_MS = 180_000;
/** 재확인은 파일 읽기라 값싸다. */
export const PG_HEALTH_INTERVAL_MS = 10_000;
/** 종료 순서상 클라이언트가 이미 없다 — 보통 1초 안에 끝난다. */
export const PG_FAST_GRACE_MS = 30_000;
export const PG_IMMEDIATE_GRACE_MS = 10_000;
export const PG_TOOL_DEADLINES = { initdb: 120_000, controldata: 10_000, psql: 15_000, createdb: 30_000 } as const;

export interface EmbeddedPostgresDeps {
  binaries: PgBinaries;
  layout: PgLayout;
  runTool(bin: string, args: readonly string[], opts: ToolOptions): Promise<ToolResult>;
  psInfo(pid: number): Promise<ProcessInfo | null>;
  spawnPostmaster(logFile: string): ServiceHandle;
  stopOrphan(pid: number): Promise<PostmasterStopResult>;
  log(line: string): void;
}

const REASON_TEXT: Record<Exclude<ClusterRefusal, "version-mismatch" | "controldata-failed"> | DatabaseRefusal, string> = {
  "storage-without-cluster": "파일 저장소에 파일이 있는데 데이터베이스가 없어요",
  "cluster-without-marker": "데이터베이스는 있는데 파일 저장소의 짝 표시가 없어요",
  "marker-unreadable": "파일 저장소의 짝 표시를 읽을 수 없어요",
  "marker-mismatch": "파일 저장소가 다른 데이터베이스의 것이에요",
  "database-dropped": "데이터베이스(damwha)가 지워졌어요",
  "database-recreated": "데이터베이스(damwha)가 새로 만들어진 것이에요",
  "storage-without-database": "파일 저장소에 파일이 있는데 데이터베이스(damwha)가 없어요",
};

const INITDB_LEFTOVER = /^postgres\.initdb-[0-9a-f]{8}$/;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 거부. 부류는 manual이고, 부르기 전에 아무것도 바꾸지 않았어야 한다 (스펙 §5). */
function refuse(text: string): never {
  throw new ServiceFailure(text, "manual");
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 번들 PostgreSQL 클러스터 (Phase 3 스펙 §6.4). 이 어댑터는 클러스터의 수명주기만 진다 — 마이그레이션은 api 어댑터의
 * 스폰 전 게이트가 한다(§6.5).
 */
export function embeddedPostgresSpec(deps: EmbeddedPostgresDeps): ServiceSpec {
  const { binaries, layout } = deps;
  const env = pgToolEnv();
  /** 판정표 2를 통과한 핸들. 핸들마다 한 번이고, 10초 재확인은 물리적 준비만 본다. */
  const verified = new WeakSet<ServiceHandle>();
  const pairing = (reason: keyof typeof REASON_TEXT) => CAUSES.pgPairingRefused.text(REASON_TEXT[reason], layout.pgdata, layout.storage);
  const tool = (bin: string, args: readonly string[], deadlineMs: number, signal: AbortSignal) =>
    deps.runTool(bin, args, { env, deadlineMs, signal });

  async function readClusterId(pgdata: string, signal: AbortSignal): Promise<{ id: string | null; failure?: string }> {
    const r = await tool(binaries.pgControldata, ["-D", pgdata], PG_TOOL_DEADLINES.controldata, signal);
    if (!toolOk(r)) return { id: null, failure: describeToolFailure("pg_controldata", r) };
    const id = parseControldataClusterId(r.stdout);
    return id === null ? { id: null, failure: "pg_controldata 출력에서 클러스터 id를 찾지 못했어요" } : { id };
  }

  function ensureDirs(): void {
    for (const dir of [layout.dataDir, layout.runDir, layout.backups]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    fs.mkdirSync(layout.logDir, { recursive: true });
  }

  /** §5의 첫 번째 삭제 — 앱이 만든 이름이고 실제 디렉터리일 때만. 심볼릭 링크를 따라가 지우지 않는다. */
  function removeInitdbLeftovers(): void {
    for (const name of fs.readdirSync(layout.dataDir)) {
      if (!INITDB_LEFTOVER.test(name)) continue;
      const p = path.join(layout.dataDir, name);
      if (!fs.lstatSync(p).isDirectory()) continue;
      fs.rmSync(p, { recursive: true, force: true });
      deps.log(`postgres: 이전 실행이 남긴 initdb 임시 디렉터리를 지웠다 — ${p}`);
    }
  }

  async function initCluster(signal: AbortSignal): Promise<void> {
    const tmp = path.join(layout.dataDir, `postgres.initdb-${randomBytes(4).toString("hex")}`);
    const r = await tool(
      binaries.initdb,
      ["-D", tmp, "-U", DB_SUPERUSER, "--encoding=UTF8", "--locale=C", "--auth-local=trust", "--auth-host=reject"],
      PG_TOOL_DEADLINES.initdb,
      signal,
    );
    if (!toolOk(r)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      refuse(CAUSES.pgInitdbFailed.text(describeToolFailure("initdb", r)));
    }
    const c = await readClusterId(tmp, signal);
    if (c.id === null) {
      fs.rmSync(tmp, { recursive: true, force: true });
      refuse(CAUSES.pgInitdbFailed.text(c.failure ?? "pg_controldata"));
    }
    // 마커를 옮기기 **전에** 쓴다. 그래야 "클러스터는 있는데 마커가 없다"가 앱이 만든 클러스터에서 생길 수 없다 (§6.2).
    writeMarkerAtomic(layout.marker, { clusterId: c.id, databaseOid: null });
    fs.renameSync(tmp, layout.pgdata);
    deps.log(`postgres: 새 클러스터를 만들었다 — ${layout.pgdata} (id ${c.id})`);
  }

  async function handleLock(): Promise<void> {
    const pidPath = path.join(layout.pgdata, "postmaster.pid");
    const text = readIfExists(pidPath);
    const pidfile = text === null ? null : parsePostmasterPid(text);
    if (pidfile === null) return;
    let info: ProcessInfo | null;
    try {
      info = await deps.psInfo(pidfile.pid);
    } catch (e) {
      refuse(CAUSES.pgLockUnprovable.text(pidfile.pid, pidPath, reasonOf(e)));
    }
    const owner = classifyLockOwner(layout.pgdata, info, pidfile.pid);
    if (owner.kind === "none") return;
    if (owner.kind === "orphan") {
      deps.log(`postgres: 이전 실행이 남긴 postmaster(pid ${owner.pid})를 내린다 — 채택하지 않는다(옛 바이너리일 수 있다)`);
      const how = await deps.stopOrphan(owner.pid);
      deps.log(`postgres: 고아 postmaster(pid ${owner.pid}) 종료 결과 — ${how}`);
      if (how === "leaked") refuse(CAUSES.pgOrphanStuck.text(owner.pid));
      return;
    }
    // pid가 재사용됐다. 그 pid가 우리 postgres가 아님을 확인했으므로 락은 낡았다 (§5 두 번째 삭제).
    for (const lock of [pidPath, `${layout.socketFile}.lock`]) {
      try {
        if (!fs.lstatSync(lock).isFile()) continue;
      } catch {
        continue;
      }
      fs.rmSync(lock);
      deps.log(`postgres: 낡은 락을 지웠다 — ${lock} (pid ${owner.pid}는 ${info?.comm ?? "?"})`);
    }
  }

  /** "retry"는 서버가 아직 접속을 받지 않는다는 뜻이다(psql exit 2). 준비 유예가 상한이다. */
  async function queryDatabaseOid(signal: AbortSignal): Promise<number | null | "retry"> {
    const r = await tool(
      binaries.psql,
      ["-X", "-A", "-t", "-h", layout.runDir, "-U", DB_SUPERUSER, "-d", "postgres", "-c", `SELECT oid FROM pg_database WHERE datname = '${DB_NAME}'`],
      PG_TOOL_DEADLINES.psql,
      signal,
    );
    if (r.code === 2 && !r.timedOut && !r.aborted) return "retry";
    if (!toolOk(r)) refuse(CAUSES.pgQueryFailed.text(describeToolFailure("psql", r)));
    const out = r.stdout.trim();
    if (out === "") return null;
    const oid = Number(out);
    if (!Number.isInteger(oid) || oid <= 0) refuse(CAUSES.pgQueryFailed.text(`알아볼 수 없는 psql 출력: ${out.slice(0, 80)}`));
    return oid;
  }

  /** 판정표 2 (§6.2). */
  async function verifyDatabase(signal: AbortSignal): Promise<"ok" | "retry"> {
    const marker = parseMarker(readIfExists(layout.marker) ?? "");
    if (marker === null) refuse(pairing("cluster-without-marker"));
    const oid = await queryDatabaseOid(signal);
    if (oid === "retry") return "retry";
    const decision = decideDatabase({ oid, marker, storageHasFiles: readStorageFacts(layout.storage).hasFiles });
    if (decision.kind === "ok") return "ok";
    if (decision.kind === "refuse") refuse(pairing(decision.reason));
    if (decision.kind === "record-oid") {
      writeMarkerAtomic(layout.marker, { ...marker, databaseOid: decision.oid });
      deps.log(`postgres: 데이터베이스 ${DB_NAME}의 oid ${decision.oid}를 마커에 적었다`);
      return "ok";
    }
    const created = await tool(binaries.createdb, ["-h", layout.runDir, "-U", DB_SUPERUSER, DB_NAME], PG_TOOL_DEADLINES.createdb, signal);
    if (!toolOk(created)) refuse(CAUSES.pgCreatedbFailed.text(describeToolFailure("createdb", created)));
    const after = await queryDatabaseOid(signal);
    if (after === null || after === "retry") refuse(CAUSES.pgCreatedbFailed.text("만든 뒤에도 데이터베이스가 보이지 않아요"));
    writeMarkerAtomic(layout.marker, { ...marker, databaseOid: after });
    deps.log(`postgres: 데이터베이스 ${DB_NAME}를 만들었다 (oid ${after})`);
    return "ok";
  }

  return {
    id: "postgres",
    dependsOn: [],
    gate: true,
    readyTimeoutMs: PG_READY_TIMEOUT_MS,
    healthIntervalMs: PG_HEALTH_INTERVAL_MS,
    async detectExternal() {
      // 이전 실행의 고아는 "외부"가 아니다. 채택하지 않고 launch()가 내린다.
      return { kind: "absent" };
    },
    launch(ctx: LaunchContext): Promise<LaunchResult> {
      return manualUnlessTagged(async () => {
        const missing = PG_BINARY_NAMES.filter((n) => !isExecutable(path.join(binaries.dir, "bin", n)));
        if (missing.length > 0) refuse(CAUSES.pgBundleMissing.text(missing));
        const tooLong = socketPathTooLong(layout);
        if (tooLong !== null) refuse(CAUSES.pgSocketPathTooLong.text(layout.socketFile, tooLong));

        // 판정에는 디렉터리가 필요 없다. 디렉터리 생성과 임시 디렉터리 정리를 판정 **뒤로** 둬, 거부 경로가 아무것도
        // 만들거나 지우지 않게 한다 (스펙 §5).
        const pgdataExists = fs.existsSync(layout.pgdata);
        const pgVersion = pgdataExists ? (readIfExists(path.join(layout.pgdata, "PG_VERSION"))?.trim() ?? null) : null;
        let clusterId: string | null = null;
        let controldataFailure: string | undefined;
        if (pgdataExists && pgVersion === PG_MAJOR) {
          const c = await readClusterId(layout.pgdata, ctx.signal);
          clusterId = c.id;
          controldataFailure = c.failure;
        }
        const decision = decideCluster({ pgdataExists, pgVersion, clusterId, storage: readStorageFacts(layout.storage) });
        if (decision.kind === "refuse") {
          if (decision.reason === "version-mismatch") refuse(CAUSES.pgVersionMismatch.text(decision.detail ?? "(없음)", PG_MAJOR));
          if (decision.reason === "controldata-failed") refuse(CAUSES.pgControldataFailed.text(controldataFailure ?? layout.pgdata));
          refuse(pairing(decision.reason));
        }
        ensureDirs();
        removeInitdbLeftovers();
        if (decision.kind === "initdb") await initCluster(ctx.signal);
        else await handleLock();
        return { handle: deps.spawnPostmaster(ctx.logFile("postgres")), owned: true };
      });
    },
    async readiness(result, ctx): Promise<ReadinessResult> {
      const handle = result.handle;
      if (handle === null) return { kind: "failed", detail: CAUSES.noHandle.text, recovery: "manual" };
      // 부류를 붙이지 않는다(auto). 서버가 준비 전에 죽은 것은 다시 띄워 볼 만하다 (스펙 §6.7 표).
      if (!handle.alive()) return { kind: "failed", detail: failureBlock(handle.stderrTail()) || CAUSES.processExited.text(handle.exitCode() ?? "?") };
      const text = readIfExists(path.join(layout.pgdata, "postmaster.pid"));
      const pidfile = text === null ? null : parsePostmasterPid(text);
      // pid를 대조한다. 고아를 내린 직후나 재시작 직후에는 이전 postmaster의 ready가 파일에 남아 있을 수 있다.
      if (pidfile === null || pidfile.pid !== handle.pid) return { kind: "not-ready" };
      if (pidfile.status === "stopping") return { kind: "degraded", detail: CAUSES.pgStopping.text };
      if (pidfile.status !== "ready" || !fs.existsSync(layout.socketFile)) return { kind: "not-ready" };
      if (verified.has(handle)) return { kind: "ready" };
      try {
        if ((await verifyDatabase(ctx.signal)) === "retry") return { kind: "not-ready" };
      } catch (e) {
        return { kind: "failed", detail: reasonOf(e), recovery: "manual" };
      }
      verified.add(handle);
      return { kind: "ready" };
    },
    async stop(result) {
      // plan.graceMs와 onGraceExpired를 쓰지 않는다. 사람이 판단할 정보(진행 중인 job)가 postgres에는 없고, 종료 순서상
      // 클라이언트가 이미 없다. 감독자의 기동 중 정리(5초)가 부를 때도 같은 절차다 (스펙 §6.4 종료).
      const handle = result.handle;
      if (handle === null) return { stopped: true, leaked: [] };
      await handle.stop(PG_FAST_GRACE_MS);
      if (!handle.alive()) return { stopped: true, leaked: [] };
      const pid = handle.pid;
      return { stopped: false, leaked: pid === undefined ? [] : [pid], detail: CAUSES.pgStopLeaked.text(pid ?? "?") };
    },
    // 앱이 소유자다. Phase 2의 never는 compose의 restart: unless-stopped가 소유했기 때문이었다.
    restart: { maxAttempts: 3, backoffMs: [3_000, 8_000, 20_000] },
  };
}

/**
 * 외부 디버그 모드 (스펙 §6.1). 아무것도 띄우지 않고 내리지 않는다. DB에 닿는지는 api의 /api/health가 보여준다 —
 * desktop에 pg 클라이언트를 넣지 않는다.
 */
export function externalPostgresSpec(): ServiceSpec {
  return {
    id: "postgres",
    dependsOn: [],
    gate: true,
    async detectExternal() {
      return { kind: "adopt", detail: CAUSES.externalDatabase.text };
    },
    async launch() {
      return { handle: null, owned: false };
    },
    async readiness() {
      return { kind: "ready" };
    },
    async stop() {
      return { stopped: true, leaked: [] };
    },
    restart: "never",
  };
}
```

- [ ] **Step 3: 단위 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop exec vitest run tests/pg-service.test.ts && pnpm --filter damwha-desktop run lint`
Expected: PASS — 25 tests. lint 0.

- [ ] **Step 4: 실번들 통합 테스트를 쓴다**

`desktop/tests/pg-service.integration.test.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processExists, psInfo, spawnPostmaster, stopOrphanPostmaster } from "../src/services/pg-handle";
import { pgBinaries, pgLayout, pgToolEnv } from "../src/services/pg-layout";
import { parseMarker } from "../src/services/pg-pairing";
import { parsePostmasterPid } from "../src/services/pg-pidfile";
import { embeddedPostgresSpec, type EmbeddedPostgresDeps } from "../src/services/pg-service";
import { runTool } from "../src/services/tool-runner";
import type { LaunchContext, LaunchResult, ServiceSpec } from "../src/services/types";

const BUNDLE = path.join(__dirname, "..", "build", "postgres");
const HAVE_BUNDLE = fs.existsSync(path.join(BUNDLE, "bin", "postgres"));

/**
 * Task 1의 실제 번들로 initdb·기동·판정표 2·종료·고아 인수를 돈다. 번들이 없으면(웹 흐름만 쓰는 체크아웃) 건너뛴다 —
 * 그때 이 테스트는 아무것도 증명하지 않으므로, packaged 검증(Task 13)이 같은 경로를 다시 밟는다.
 */
describe.skipIf(!HAVE_BUNDLE)("embedded postgres against the real bundle", () => {
  let ud: string;
  const started: LaunchResult[] = [];

  beforeAll(() => {
    // /tmp를 쓴다 — os.tmpdir()의 /var/folders/… 경로에 소켓 경로를 더하면 한도에 가깝다.
    ud = fs.mkdtempSync("/tmp/dwpgi-");
  });

  afterAll(async () => {
    for (const r of started) if (r.handle?.alive()) await r.handle.stop(10_000);
    fs.rmSync(ud, { recursive: true, force: true });
  });

  function deps(): EmbeddedPostgresDeps {
    const layout = pgLayout(ud);
    const binaries = pgBinaries(BUNDLE);
    return {
      binaries,
      layout,
      runTool,
      psInfo,
      stopOrphan: (pid) => stopOrphanPostmaster(pid, 30_000, 10_000),
      spawnPostmaster: (logFile) => spawnPostmaster({ binaries, layout, logFile, immediateGraceMs: 10_000 }),
      log: () => undefined,
    };
  }

  function ctx(): LaunchContext {
    return {
      repoRoot: "/r",
      userData: ud,
      packaged: false,
      env: {},
      bins: { uv: null },
      searchDirs: [],
      logFile: (id) => path.join(ud, "logs", `${id}.log`),
      signal: new AbortController().signal,
    };
  }

  async function bringUp(spec: ServiceSpec, c: LaunchContext): Promise<LaunchResult> {
    const r = await spec.launch(c);
    started.push(r);
    const until = Date.now() + 60_000;
    for (;;) {
      const ready = await spec.readiness(r, c);
      if (ready.kind === "ready") return r;
      if (ready.kind === "failed") throw new Error(ready.detail);
      if (Date.now() > until) throw new Error("준비 시간 초과");
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  const psql = (sql: string) =>
    runTool(pgBinaries(BUNDLE).psql, ["-X", "-A", "-t", "-h", pgLayout(ud).runDir, "-U", "damwha", "-d", "damwha", "-c", sql], { env: pgToolEnv(), deadlineMs: 15_000 });

  it("creates a socket-only cluster with the damwha database and marks the pair", async () => {
    const spec = embeddedPostgresSpec(deps());
    const r = await bringUp(spec, ctx());
    const layout = pgLayout(ud);
    const q = await psql("SELECT current_setting('listen_addresses'), current_setting('lc_collate'), current_database()");
    expect(q.stdout.trim()).toBe("|C|damwha");
    expect((fs.statSync(layout.runDir).mode & 0o777).toString(8)).toBe("700");
    const marker = parseMarker(fs.readFileSync(layout.marker, "utf8"));
    expect(marker?.databaseOid).toBeGreaterThan(0);
    const out = await spec.stop(r, { graceMs: 5 });
    expect(out).toEqual({ stopped: true, leaked: [] });
    expect(fs.existsSync(layout.socketFile)).toBe(false);
  }, 120_000);

  it("opens the same cluster on the next launch without initdb", async () => {
    const layout = pgLayout(ud);
    const before = fs.readFileSync(layout.marker, "utf8");
    const spec = embeddedPostgresSpec(deps());
    const r = await bringUp(spec, ctx());
    expect(fs.readFileSync(layout.marker, "utf8")).toBe(before);
    await spec.stop(r, { graceMs: 5 });
  }, 120_000);

  it("takes over a postmaster left behind by a run that never stopped it", async () => {
    const layout = pgLayout(ud);
    const first = await bringUp(embeddedPostgresSpec(deps()), ctx());
    const orphanPid = first.handle!.pid!;
    // 앱이 죽었다고 치고, 새 어댑터가 같은 클러스터를 연다.
    const spec = embeddedPostgresSpec(deps());
    const second = await bringUp(spec, ctx());
    expect(processExists(orphanPid)).toBe(false);
    expect(parsePostmasterPid(fs.readFileSync(path.join(layout.pgdata, "postmaster.pid"), "utf8"))?.pid).toBe(second.handle!.pid);
    await spec.stop(second, { graceMs: 5 });
  }, 180_000);
});
```

- [ ] **Step 5: 통합 테스트를 돌린다**

Run: `pnpm --filter damwha-desktop exec vitest run tests/pg-service.integration.test.ts`
Expected: PASS — 3 tests(번들이 있으므로 건너뛰지 않는다). 끝난 뒤 `pgrep -fl /tmp/dwpgi-` → 출력 없음.

- [ ] **Step 6: 변이로 확인한다**

(a) `initCluster`의 initdb 실패 분기에서 `fs.rmSync(tmp, …)` 줄을 지운다 → `removes the temporary directory and leaves no cluster` FAIL. 되돌린다. (마커를 rename **전에** 쓰는 순서는 단위 테스트로 관찰할 수 없다 — 그 순서가 틀렸을 때 생기는 상태를 `decideCluster`가 거부한다는 것을 `pg-pairing.test.ts`의 `refuses a cluster without a marker even when storage is empty`가 지키고, 순서 자체는 리뷰가 읽는다.)
(b) `readiness`의 `if (verified.has(handle)) return { kind: "ready" };` 줄을 지운다 → `creates the database once … does not ask again` FAIL. 되돌린다.
(c) `handleLock`의 `catch`에서 `refuse(...)` 대신 `return;`으로 바꾼다 → `refuses and deletes nothing when ps cannot say` FAIL. 되돌린다.

- [ ] **Step 7: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/services/pg-service.ts desktop/tests/pg-service.test.ts desktop/tests/pg-service.integration.test.ts
git commit -F - <<'MSG'
feat(desktop): 번들 PostgreSQL 클러스터 어댑터와 외부 디버그 어댑터를 더한다

클러스터 수명주기만 진다 — 페어링 검증, 임시 디렉터리 initdb와 rename 전 마커, 이전 실행의
고아 인수(채택하지 않고 내린다), 증명한 낡은 락만 제거, postgres -D 직접 기동, postmaster.pid의
pid 대조 준비 판정, 핸들당 한 번의 판정표 2와 createdb, SIGINT→SIGQUIT 종료.

본문 전체를 manualUnlessTagged로 감싸 예상 못 한 실패가 자동 재시도로 새지 않게 하고, 서버가
준비 전에 죽은 경우만 부류 없이(auto) 둔다. 실번들 통합 테스트가 소켓 전용·C 로캘·마커·재기동·
고아 인수를 실제 서버로 돈다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 3 PASS(25), Step 5 PASS(3), lint 0. Step 6 (b)(c) FAIL 출력 첨부, (a)는 판정표 행의 존재를 적었다.
- `grep -nE "SIGKILL|process\.kill" desktop/src/services/pg-service.ts` → 0건(신호는 전부 핸들·`stopOrphan`이 보낸다).

**Review:**
- 거부 경로(`refuse` 호출 전)에서 파일·디렉터리를 만들거나 지우는 코드가 없는가. `ensureDirs()`와 `removeInitdbLeftovers()`가 판정표 1 **뒤**에 있는가(스펙 §5).
- `initCluster`의 순서: initdb(임시) → id → **마커 → rename**. 실패 시 임시 디렉터리만 지우는가.
- `readiness`가 pid 대조를 하는가. `verified`가 핸들 단위인가.
- `stop`이 `plan.onGraceExpired`를 부르지 않는가.
- 통합 테스트가 끝난 뒤 postmaster가 남지 않는가.

---

## Task 9: 마이그레이션 실행 게이트

스펙 §6.5 전부. 게이트 본체(`migration-gate.ts`), packaged 러너(`migrate-process.ts`), api 어댑터의 호출 자리.

**Files:**
- Create: `desktop/src/services/migration-gate.ts`
- Create: `desktop/src/migrate-process.ts`
- Modify: `desktop/src/services/api.ts`
- Test: `desktop/tests/migration-gate.test.ts`
- Test: `desktop/tests/api-spec.test.ts` (추가)

**Interfaces:**
- Consumes: Task 2의 CLI 계약(마지막 줄 JSON), Task 4 `ServiceFailure`·`manualUnlessTagged`, Task 5 `PgLayout`·`PgBinaries`·`pgToolEnv`·`DB_NAME`·`DB_SUPERUSER`, Task 6 `ToolResult`·`ToolOptions`·`toolOk`·`describeToolFailure`, Task 7 `CAUSES.migration*`·`backupFailed`.
- Produces:
  - `migration-gate.ts`: `interface MigrationStatus`, `parseStatusOutput(stdout: string): MigrationStatus | null`, `interface MigrationRunner { status(signal: AbortSignal): Promise<ToolResult>; run(signal: AbortSignal): Promise<ToolResult> }`, `MIGRATION_STATUS_DEADLINE_MS = 60_000`, `RESTORE_LIST_DEADLINE_MS = 60_000`, `KEEP_BACKUPS = 5`, `interface MigrationGateDeps { runner; runTool; binaries; layout; log; now? }`, `type GateOutcome`, `backupStamp(d: Date): string`, `runMigrationGate(deps, signal: AbortSignal): Promise<GateOutcome>`, `devMigrationRunner(o: { repoRoot: string; env: Record<string, string>; runTool }): MigrationRunner`.
  - `migrate-process.ts`: `forkNodeTool(entry: string, args: readonly string[], opts: { cwd: string; env: Record<string, string>; deadlineMs?: number; signal?: AbortSignal }): Promise<ToolResult>`, `packagedMigrationRunner(o: { apiDir: string; env: Record<string, string> }): MigrationRunner`.
  - `api.ts`: `ApiDeps.migrationGate?: (signal: AbortSignal) => Promise<unknown>`.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — 게이트**

`desktop/tests/migration-gate.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceFailure } from "../src/services/failure";
import {
  backupStamp,
  devMigrationRunner,
  KEEP_BACKUPS,
  parseStatusOutput,
  runMigrationGate,
  type MigrationGateDeps,
} from "../src/services/migration-gate";
import { pgBinaries, pgLayout } from "../src/services/pg-layout";
import type { ToolOptions, ToolResult } from "../src/services/tool-runner";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gate-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = (stdout = ""): ToolResult => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
const fail = (code: number, stderr = "boom"): ToolResult => ({ code, stdout: "", stderr, timedOut: false, aborted: false });
const statusLine = (applied: number, pending: string[], unknown: string[] = []) => `${JSON.stringify({ applied, pending, unknown })}\n`;
const NOW = new Date("2026-09-14T10:15:00.000Z");

function setup(status: ToolResult, run: ToolResult = ok(statusLine(25, []))) {
  const layout = pgLayout(path.join(root, "ud"));
  const events: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const tools: Partial<Record<string, (args: readonly string[]) => ToolResult>> = {};
  const deps: MigrationGateDeps = {
    layout,
    binaries: pgBinaries("/B/postgres"),
    now: () => NOW,
    log: (l) => void events.push(`log ${l}`),
    runner: {
      status: async (signal) => {
        events.push("status");
        signals.push(signal);
        return status;
      },
      run: async (signal) => {
        events.push("run");
        signals.push(signal);
        return run;
      },
    },
    runTool: async (bin: string, args: readonly string[], opts: ToolOptions) => {
      const tool = path.basename(bin);
      events.push(tool);
      signals.push(opts.signal);
      const custom = tools[tool];
      if (custom !== undefined) return custom(args);
      if (tool === "pg_dump") {
        fs.writeFileSync(args[args.indexOf("-f") + 1], "PGDMP");
        return ok();
      }
      if (tool === "pg_restore") return ok(";\n; Archive created at …\n");
      return fail(127);
    },
  };
  return { layout, events, signals, tools, deps };
}

async function manual(p: Promise<unknown>): Promise<ServiceFailure> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ServiceFailure);
  expect((e as ServiceFailure).recovery).toBe("manual");
  return e as ServiceFailure;
}

const actions = (events: string[]) => events.filter((e) => !e.startsWith("log "));
const signal = new AbortController().signal;

describe("parseStatusOutput", () => {
  it("takes the last valid status line and ignores pnpm's banner", () => {
    const out = `\n> damwha-be@0.2.3 migrate /r/be\n> ts-node src/database/migrate.ts --status\n\n${statusLine(24, ["025_x.sql"])}`;
    expect(parseStatusOutput(out)).toEqual({ applied: 24, pending: ["025_x.sql"], unknown: [] });
  });

  it("returns null for no line, a broken line, or the wrong shape — silence is not success", () => {
    for (const bad of ["", "ok\n", "{\n", '{"applied":"24","pending":[],"unknown":[]}\n', '{"applied":24,"pending":[1],"unknown":[]}\n']) {
      expect(parseStatusOutput(bad)).toBeNull();
    }
  });
});

describe("backupStamp", () => {
  it("is a sortable UTC stamp safe for a file name", () => {
    expect(backupStamp(NOW)).toBe("20260914T101500Z");
  });
});

describe("runMigrationGate", () => {
  it("fails when the runner fails", async () => {
    const t = setup(fail(1, "Error: connect ENOENT"));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/마이그레이션 상태를 확인하지 못했어요/);
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("fails when the runner exits 0 without a status line (스펙 §10)", async () => {
    const t = setup(ok(""));
    await manual(runMigrationGate(t.deps, signal));
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("refuses unknown migrations without backing up or running anything", async () => {
    const t = setup(ok(statusLine(25, [], ["999_from_future.sql"])));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/999_from_future\.sql/);
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("does nothing when nothing is pending", async () => {
    const t = setup(ok(statusLine(24, [])));
    expect(await runMigrationGate(t.deps, signal)).toEqual({ kind: "up-to-date" });
    expect(actions(t.events)).toEqual(["status"]);
  });

  it("applies a fresh database without a backup — there is nothing to lose", async () => {
    const all = ["001_init.sql", "002_search.sql"];
    const t = setup(ok(statusLine(0, all)), ok(statusLine(2, [])));
    expect(await runMigrationGate(t.deps, signal)).toEqual({ kind: "migrated", applied: all, backup: null });
    expect(actions(t.events)).toEqual(["status", "run"]);
  });

  it("backs up and verifies before applying to a database with data", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    const out = await runMigrationGate(t.deps, signal);
    const final = path.join(t.layout.backups, "20260914T101500Z-before-025_x.sql.dump");
    expect(out).toEqual({ kind: "migrated", applied: ["025_x.sql"], backup: final });
    expect(actions(t.events)).toEqual(["status", "pg_dump", "pg_restore", "run"]);
    expect(fs.readdirSync(t.layout.backups)).toEqual([path.basename(final)]);
    expect(t.signals.every((s) => s === signal)).toBe(true);
  });

  it("does not apply when pg_dump fails", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    t.tools.pg_dump = () => fail(1, "pg_dump: error: could not write");
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/백업을 만들지 못해/);
    expect(actions(t.events)).not.toContain("run");
  });

  it("does not apply when the dump cannot be read back, and does not keep it as a backup", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    t.tools.pg_restore = () => fail(1, "pg_restore: error: input file does not appear to be a valid archive");
    await manual(runMigrationGate(t.deps, signal));
    expect(actions(t.events)).not.toContain("run");
    expect(fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump"))).toEqual([]);
  });

  it("clears an earlier partial dump but leaves other files and symlinks alone", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    const old = path.join(t.layout.backups, "20260901T000000Z-before-024_z.sql.dump.partial");
    fs.writeFileSync(old, "half");
    fs.writeFileSync(path.join(t.layout.backups, "notes.txt"), "keep");
    const outside = path.join(root, "outside.dump.partial");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(t.layout.backups, "20260902T000000Z-before-024_z.sql.dump.partial"));
    await runMigrationGate(t.deps, signal);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(t.layout.backups, "notes.txt"))).toBe(true);
    expect(fs.lstatSync(path.join(t.layout.backups, "20260902T000000Z-before-024_z.sql.dump.partial")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it(`keeps the newest ${KEEP_BACKUPS} backups, pruning only after a verified new one`, async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    const old = ["20260901", "20260902", "20260903", "20260904", "20260905"].map((d) => `${d}T000000Z-before-02${d.slice(-1)}_x.sql.dump`);
    for (const n of old) fs.writeFileSync(path.join(t.layout.backups, n), "PGDMP");
    await runMigrationGate(t.deps, signal);
    const left = fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump")).sort();
    expect(left).toHaveLength(KEEP_BACKUPS);
    expect(left).not.toContain(old[0]);
    expect(left).toContain("20260914T101500Z-before-025_x.sql.dump");
  });

  it("does not prune when the new backup fails", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])));
    fs.mkdirSync(t.layout.backups, { recursive: true });
    for (const d of ["01", "02", "03", "04", "05", "06"]) fs.writeFileSync(path.join(t.layout.backups, `202609${d}T000000Z-before-x.sql.dump`), "PGDMP");
    t.tools.pg_dump = () => fail(1);
    await manual(runMigrationGate(t.deps, signal));
    expect(fs.readdirSync(t.layout.backups).filter((n) => n.endsWith(".dump"))).toHaveLength(6);
  });

  it("names the backup when the runner fails", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])), fail(1, "error: relation \"nope\" does not exist"));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/마이그레이션을 적용하지 못했어요/);
    expect(e.message).toContain("20260914T101500Z-before-025_x.sql.dump");
    expect(e.message).toContain("relation \"nope\" does not exist");
  });

  it("fails when the runner says it finished but something is still pending", async () => {
    const t = setup(ok(statusLine(24, ["025_x.sql"])), ok(statusLine(24, ["025_x.sql"])));
    const e = await manual(runMigrationGate(t.deps, signal));
    expect(e.message).toMatch(/여전히 적용되지 않았어요/);
  });

  it("fails when the runner exits 0 without a line after applying", async () => {
    const t = setup(ok(statusLine(0, ["001_init.sql"])), ok(""));
    await manual(runMigrationGate(t.deps, signal));
  });
});

describe("devMigrationRunner", () => {
  it("runs the same script as `pnpm be:migrate`, with a deadline only on --status", async () => {
    const calls: Array<{ bin: string; args: readonly string[]; opts: ToolOptions }> = [];
    const r = devMigrationRunner({
      repoRoot: "/r",
      env: { DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fx" },
      runTool: async (bin, args, opts) => {
        calls.push({ bin, args, opts });
        return ok();
      },
    });
    await r.status(signal);
    await r.run(signal);
    expect(calls[0]).toMatchObject({ bin: "pnpm", args: ["--filter", "damwha-be", "run", "migrate", "--", "--status"] });
    expect(calls[0].opts).toMatchObject({ cwd: "/r", deadlineMs: 60_000, signal });
    expect(calls[1].args).toEqual(["--filter", "damwha-be", "run", "migrate"]);
    expect(calls[1].opts.deadlineMs).toBeUndefined();
    expect(calls[1].opts.env.DATABASE_URL).toContain("host=");
  });
});
```

- [ ] **Step 2: 실패하는 테스트를 더한다 — api 어댑터**

`desktop/tests/api-spec.test.ts`의 import에 `import { ServiceFailure } from "../src/services/failure";`를 더하고, 기존 `import type { ServiceHandle } from "../src/services/types";`를 `import type { LaunchContext, ServiceHandle } from "../src/services/types";`로 바꾼 뒤 파일 끝에 다음을 더한다:

```ts
describe("apiSpec — migration gate (Phase 3)", () => {
  const baseDeps = (over: Partial<ApiDeps> = {}): ApiDeps => ({
    verifyOwnListener: async () => true,
    isPortOccupied: async () => true,
    onPendingMigrations: () => undefined,
    onMigrationCheckSkipped: () => undefined,
    ...over,
  });
  const ctx = (): LaunchContext => ({
    repoRoot: "/r",
    userData: "/u",
    packaged: false,
    env: { PORT: "3000" },
    bins: { uv: null },
    searchDirs: [],
    logFile: () => "/u/logs/api.log",
    signal: new AbortController().signal,
  });

  it("runs the gate before looking for a port, with the launch signal", async () => {
    const order: string[] = [];
    const c = ctx();
    let seen: AbortSignal | undefined;
    const spec = apiSpec(
      baseDeps({
        migrationGate: async (signal) => {
          order.push("gate");
          seen = signal;
        },
        isPortOccupied: async () => {
          order.push("port");
          return true; // 모든 포트가 막혀 스폰까지 가지 않는다
        },
      }),
    );
    await expect(spec.launch(c)).rejects.toThrow(/포트/);
    expect(order[0]).toBe("gate");
    expect(order[1]).toBe("port");
    expect(seen).toBe(c.signal);
  });

  it("does not spawn the API when the gate refuses, and keeps the manual class", async () => {
    const isPortOccupied = vi.fn(async () => false);
    const spec = apiSpec(
      baseDeps({
        isPortOccupied,
        migrationGate: async () => {
          throw new ServiceFailure("마이그레이션을 적용하지 못했어요.", "manual");
        },
      }),
    );
    await expect(spec.launch(ctx())).rejects.toMatchObject({ recovery: "manual" });
    expect(isPortOccupied).not.toHaveBeenCalled();
  });

  it("reports pending migrations after a gate as a manual mismatch, not as `pnpm be:migrate`", async () => {
    const handle = {
      pid: 1,
      alive: () => true,
      stderrTail: () => "",
      stdoutTail: () => WARN,
      exitCode: () => null,
      onExit: () => undefined,
      stop: async () => undefined,
    } as ServiceHandle;
    const withGate = await judgeAfterProbe(handle, "ready", 3000, baseDeps({ migrationGate: async () => undefined }));
    expect(withGate).toMatchObject({ kind: "failed", recovery: "manual", detail: expect.stringMatching(/여전히 적용되지 않았어요/) });
    const withoutGate = await judgeAfterProbe(handle, "ready", 3000, baseDeps());
    expect(withoutGate).toMatchObject({ kind: "failed", detail: expect.stringMatching(/적용되지 않은 마이그레이션이 3개/) });
    expect((withoutGate as { recovery?: string }).recovery).toBeUndefined();
  });
});
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/migration-gate.test.ts tests/api-spec.test.ts`
Expected: FAIL — `migration-gate` 모듈 없음, `migrationGate`가 `ApiDeps`에 없음.

- [ ] **Step 3: 게이트를 쓴다**

`desktop/src/services/migration-gate.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { CAUSES } from "../causes";
import { manualUnlessTagged, ServiceFailure } from "./failure";
import { DB_NAME, DB_SUPERUSER, pgToolEnv, type PgBinaries, type PgLayout } from "./pg-layout";
import { describeToolFailure, toolOk, type ToolOptions, type ToolResult } from "./tool-runner";

/**
 * 마이그레이션 실행 게이트 (Phase 3 스펙 §6.5). api 어댑터가 API를 스폰하기 **전에** 부른다. 내장 모드에서만 돈다.
 *
 * 판정을 desktop이 재구현하지 않는다 — 상태는 be/src/database/migrate.ts가 한 줄 JSON으로 말한다. 그 줄을 파싱할 수
 * 없으면 통과시키지 않는다. 러너가 아무것도 하지 않고 exit 0으로 끝나는 경우를 성공으로 읽지 않기 위해서다.
 */

export interface MigrationStatus {
  applied: number;
  pending: string[];
  unknown: string[];
}

const isNames = (x: unknown): x is string[] => Array.isArray(x) && x.every((n) => typeof n === "string");

/** 마지막으로 나온 올바른 상태 줄. dev의 pnpm은 앞에 배너를 찍는다. */
export function parseStatusOutput(stdout: string): MigrationStatus | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const { applied, pending, unknown } = value as Record<string, unknown>;
    if (typeof applied === "number" && Number.isInteger(applied) && applied >= 0 && isNames(pending) && isNames(unknown)) {
      return { applied, pending, unknown };
    }
  }
  return null;
}

export interface MigrationRunner {
  status(signal: AbortSignal): Promise<ToolResult>;
  run(signal: AbortSignal): Promise<ToolResult>;
}

export const MIGRATION_STATUS_DEADLINE_MS = 60_000;
export const RESTORE_LIST_DEADLINE_MS = 60_000;
export const KEEP_BACKUPS = 5;

export interface MigrationGateDeps {
  runner: MigrationRunner;
  runTool(bin: string, args: readonly string[], opts: ToolOptions): Promise<ToolResult>;
  binaries: PgBinaries;
  layout: PgLayout;
  log(line: string): void;
  now?: () => Date;
}

export type GateOutcome = { kind: "up-to-date" } | { kind: "migrated"; applied: string[]; backup: string | null };

const DUMP_NAME = /^\d{8}T\d{6}Z-before-[A-Za-z0-9._-]+\.dump$/;
const PARTIAL_NAME = /^\d{8}T\d{6}Z-before-[A-Za-z0-9._-]+\.dump\.partial$/;

export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** §5의 셋째·넷째 삭제. 앱이 만드는 이름 형식이고 실제 파일일 때만. */
function removeOwned(file: string, pattern: RegExp, log: (line: string) => void): void {
  if (!pattern.test(path.basename(file))) return;
  try {
    if (!fs.lstatSync(file).isFile()) return;
  } catch {
    return;
  }
  fs.rmSync(file);
  log(`마이그레이션 게이트: 지웠다 — ${file}`);
}

async function backup(deps: MigrationGateDeps, firstPending: string, signal: AbortSignal): Promise<string> {
  const dir = deps.layout.backups;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) removeOwned(path.join(dir, name), PARTIAL_NAME, deps.log);

  const stamp = backupStamp((deps.now ?? (() => new Date()))());
  const final = path.join(dir, `${stamp}-before-${firstPending.replace(/[^A-Za-z0-9._-]/g, "_")}.dump`);
  const partial = `${final}.partial`;
  const env = pgToolEnv();

  // deadline이 없다 — 데이터 크기에 비례한다. 멈추면 종료 신호가 끝낸다 (스펙 §12).
  const dump = await deps.runTool(deps.binaries.pgDump, ["-h", deps.layout.runDir, "-U", DB_SUPERUSER, "-Fc", "-f", partial, DB_NAME], { env, signal });
  if (!toolOk(dump)) throw new ServiceFailure(CAUSES.backupFailed.text(describeToolFailure("pg_dump", dump)), "manual");
  // 목차를 읽을 수 있는가까지가 "검증"이다. 복원 리허설은 Phase 5.
  const list = await deps.runTool(deps.binaries.pgRestore, ["--list", partial], { env, deadlineMs: RESTORE_LIST_DEADLINE_MS, signal });
  if (!toolOk(list)) throw new ServiceFailure(CAUSES.backupFailed.text(describeToolFailure("pg_restore --list", list)), "manual");
  fs.renameSync(partial, final);

  // 새 백업이 검증된 **뒤에만** 오래된 것을 지운다.
  const dumps = fs.readdirSync(dir).filter((n) => DUMP_NAME.test(n)).sort();
  for (const name of dumps.slice(0, Math.max(0, dumps.length - KEEP_BACKUPS))) removeOwned(path.join(dir, name), DUMP_NAME, deps.log);
  deps.log(`마이그레이션 게이트: 적용 전 백업 — ${final}`);
  return final;
}

export function runMigrationGate(deps: MigrationGateDeps, signal: AbortSignal): Promise<GateOutcome> {
  return manualUnlessTagged(async () => {
    const s = await deps.runner.status(signal);
    const status = toolOk(s) ? parseStatusOutput(s.stdout) : null;
    if (status === null) {
      const why = toolOk(s)
        ? `마이그레이션 러너가 상태 줄을 내지 않았어요\n${s.stdout.trim().split("\n").slice(-6).join("\n")}`
        : describeToolFailure("마이그레이션 러너", s);
      throw new ServiceFailure(CAUSES.migrationStatusFailed.text(why), "manual");
    }
    // 옛 API 코드가 새 스키마에서 돌지 않게 한다. 아무것도 지우지 않는다 (스펙 §6.5-2).
    if (status.unknown.length > 0) throw new ServiceFailure(CAUSES.migrationUnknown.text(status.unknown), "manual");
    if (status.pending.length === 0) return { kind: "up-to-date" };

    const backupPath = status.applied > 0 ? await backup(deps, status.pending[0], signal) : null;
    deps.log(`마이그레이션 게이트: ${status.pending.length}개 적용 — ${status.pending.join(", ")}`);
    const r = await deps.runner.run(signal);
    if (!toolOk(r)) {
      throw new ServiceFailure(CAUSES.migrationFailed.text(describeToolFailure("마이그레이션 러너", r), backupPath), "manual");
    }
    const after = parseStatusOutput(r.stdout);
    if (after === null || after.pending.length > 0) {
      const left = after?.pending ?? status.pending;
      throw new ServiceFailure(CAUSES.migrationsStillPending.text(left.length, left.join(", ")), "manual");
    }
    return { kind: "migrated", applied: status.pending, backup: backupPath };
  });
}

/** dev — `pnpm be:migrate`와 같은 스크립트(ts-node). cwd가 be/라 dotenv가 be/.env를 읽지만 주입한 env를 덮지 않는다. */
export function devMigrationRunner(o: { repoRoot: string; env: Record<string, string>; runTool: MigrationGateDeps["runTool"] }): MigrationRunner {
  const base = ["--filter", "damwha-be", "run", "migrate"];
  return {
    status: (signal) => o.runTool("pnpm", [...base, "--", "--status"], { cwd: o.repoRoot, env: o.env, deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    // 실행에는 deadline을 두지 않는다 — 데이터 크기에 비례하고, 멈추면 종료 신호가 끝낸다.
    run: (signal) => o.runTool("pnpm", base, { cwd: o.repoRoot, env: o.env, signal }),
  };
}
```

`desktop/src/migrate-process.ts`:

```ts
import * as path from "path";
import type { MigrationRunner } from "./services/migration-gate";
import { MIGRATION_STATUS_DEADLINE_MS } from "./services/migration-gate";
import type { ToolResult } from "./services/tool-runner";

/**
 * packaged 러너 — Electron의 Node로 `Resources/api/dist/database/migrate.js`를 돌린다 (Phase 3 스펙 §6.5-1).
 * utilityProcess에서 `require.main === module`이 참이고 인자가 process.argv로 온다(2026-09-14 실측, 결과 문서 §2.4).
 *
 * electron을 값으로 import하지 않는다(api-process.ts와 같은 이유). 이 파일은 vitest가 부르지 않는다 — packaged 검증이
 * 판정한다(Task 13).
 */
function electronUtilityProcess() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("electron") as typeof import("electron")).utilityProcess;
}

const OUTPUT_LIMIT = 256_000;

export function forkNodeTool(
  entry: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; deadlineMs?: number; signal?: AbortSignal },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted === true) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    const child = electronUtilityProcess().fork(entry, [...args], { cwd: opts.cwd, stdio: "pipe", env: opts.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const terminate = () => {
      try {
        child.kill();
      } catch {
        // 이미 끝났다.
      }
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    child.stdout?.on("data", (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-OUTPUT_LIMIT);
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.deadlineMs);
    }
    child.on("error", (type, location) => {
      spawnError = `${type} ${location}`;
    });
    child.on("exit", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, ...(spawnError === undefined ? {} : { spawnError }) });
    });
  });
}

export function packagedMigrationRunner(o: { apiDir: string; env: Record<string, string> }): MigrationRunner {
  const entry = path.join(o.apiDir, "dist", "database", "migrate.js");
  return {
    status: (signal) => forkNodeTool(entry, ["--status"], { cwd: o.apiDir, env: o.env, deadlineMs: MIGRATION_STATUS_DEADLINE_MS, signal }),
    run: (signal) => forkNodeTool(entry, [], { cwd: o.apiDir, env: o.env, signal }),
  };
}
```

`utilityProcess.kill()`은 SIGTERM이고, 러너를 끊어도 되는 근거는 파일별 트랜잭션이다(스펙 §6.4 중단 표). SIGKILL로 올리지 않는 이유: 러너는 짧게 끝나며, 멈춘 러너를 끝까지 추적하는 것은 종료를 붙잡는다 — 남은 러너는 다음 실행의 advisory lock이 막는다(Task 2).

- [ ] **Step 4: api 어댑터에 게이트 자리를 만든다**

`desktop/src/services/api.ts`:

(a) `ApiDeps`에 필드를 더한다:

```ts
  /**
   * 내장 모드의 마이그레이션 실행 게이트 (Phase 3 스펙 §6.5). 있으면 스폰 **전에** 부르고, 거부하면 launch()가 그 실패를
   * 그대로 던진다(부류 manual). 외부 디버그 모드에서는 없다 — 그때는 Phase 2의 감지 게이트만 남는다.
   */
  migrationGate?: (signal: AbortSignal) => Promise<unknown>;
```

(b) `judgeAfterProbe`의 pending 분기를 바꾼다:

```ts
    if (pending !== null) {
      deps.onPendingMigrations(pending);
      // 실행 게이트를 통과했는데 API가 미적용을 말하면 러너가 본 .sql과 API가 본 .sql이 다르다. `pnpm be:migrate`를
      // 안내하면 틀린 말이고, 자동 재시도는 같은 결과를 반복한다 (Phase 3 스펙 §6.5-5).
      if (deps.migrationGate !== undefined) {
        return { kind: "failed", detail: CAUSES.migrationsStillPending.text(pending.count, pending.names), recovery: "manual" };
      }
      // "`pnpm be:migrate`를 실행하세요"는 shell-hints.ts의 안내가 붙인다.
      return { kind: "failed", detail: CAUSES.pendingMigrations.text(pending.count, pending.names) };
    }
```

(c) `launch`의 첫 줄에 게이트를 넣는다:

```ts
    async launch(ctx): Promise<LaunchResult> {
      // 스키마를 먼저 맞춘다. API가 뜬 뒤에 적용하면 부팅 중인 API가 빈 스키마를 본다.
      if (deps.migrationGate !== undefined) await deps.migrationGate(ctx.signal);
      const requested = Number(ctx.env.PORT ?? "3000");
```

- [ ] **Step 5: 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop exec vitest run tests/migration-gate.test.ts tests/api-spec.test.ts && pnpm --filter damwha-desktop run lint`
Expected: PASS. lint 0.

- [ ] **Step 6: 변이로 확인한다**

(a) `backup`의 prune 루프를 `renameSync` **앞으로** 옮긴다 → `does not prune when the new backup fails` FAIL. 되돌린다.
(b) `runMigrationGate`의 `if (status.unknown.length > 0) throw …` 줄을 지운다 → `refuses unknown migrations` FAIL. 되돌린다.
(c) `parseStatusOutput`의 `isNames(pending)` 조건을 지운다 → `returns null for … the wrong shape` FAIL. 되돌린다.

- [ ] **Step 7: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/services/migration-gate.ts desktop/src/migrate-process.ts desktop/src/services/api.ts desktop/tests/migration-gate.test.ts desktop/tests/api-spec.test.ts
git commit -F - <<'MSG'
feat(desktop): API를 띄우기 전에 마이그레이션을 백업과 함께 실행하는 게이트를 더한다

migrate.ts의 한 줄 JSON을 파싱할 수 있어야 통과한다 — 러너가 아무것도 하지 않고 끝나도
성공으로 읽지 않는다. 번들에 없는 이름이 적용돼 있으면 옛 앱이 새 스키마를 열지 않게 거부한다.

데이터가 있는 DB에는 pg_dump -Fc로 먼저 백업하고 pg_restore --list로 읽히는지 본 뒤에만 적용한다.
보관은 새 백업이 검증된 뒤에만 줄인다. 모든 실패는 manual이라 자동 재시도가 마이그레이션을
반복하지 않는다. 실행 뒤에도 API가 미적용을 말하면 러너와 API 트리의 어긋남으로 따로 알린다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 5 PASS, lint 0. Step 6 세 변이 FAIL(출력 첨부).
- `grep -n "migrationGate" desktop/src/services/api.ts` → `ApiDeps`·`judgeAfterProbe`·`launch` 세 곳.

**Review:**
- 게이트가 **스폰 전**인가. 거부하면 포트 탐색·스폰이 한 번도 일어나지 않는가.
- 백업 → 검증 → rename → prune 순서. 실패 경로에서 prune하지 않는가.
- 지우는 파일이 이름 형식 + `lstat`로 제한되는가(§5).
- `migrate-process.ts`가 electron을 값으로 import하지 않는가(`require` 지연).
- 외부 디버그 모드(게이트 없음)의 동작이 Phase 2와 같은가 — 기존 `api-spec.test.ts` 전부가 그대로 통과하는가.

---

## Task 10: 설정의 DB 모드와 재적용

스펙 §6.1(모드·옛 키)·§6.6. `loadConfig`가 모드를 정하고 그 모드의 `DATABASE_URL`·`STORAGE_ROOT`를 파일 값보다 뒤에 얹는다. 재적용은 DB 키를 건드리지 않고 모드 변경을 양방향으로 보고한다.

**Files:**
- Modify: `desktop/src/config.ts`
- Modify: `desktop/src/config-reload.ts`
- Modify: `desktop/src/main.ts` (컴파일 유지 두 줄 — `cfg.dockerBin`, `launchCtx`)
- Test: `desktop/tests/config.test.ts`, `desktop/tests/config-reload.test.ts`

**Interfaces:**
- Consumes: Task 5 `pgLayout`·`embeddedDatabaseUrl`.
- Produces:
  - `config.ts`: `export type DatabaseMode = { kind: "embedded" } | { kind: "external"; url: string }`; `LoadedConfig`에서 `dockerBin` 제거, `notes: string[]`(로그 전용)·`databaseMode: DatabaseMode` 추가; `export const LEGACY_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/damwha"`; `export const DB_ENV_KEYS = ["DATABASE_URL", "STORAGE_ROOT"] as const`; `export function withoutDbKeys(env: ApiEnv): ApiEnv`; `defaultConfig(userDataDir)`는 `{ PORT, EMBED_SERVICE_PORT }`만.
  - `config-reload.ts`: `ConfigReloadDeps.live(): { env: ApiEnv; baseline: ApiEnv; mode: DatabaseMode } | null`; `export function describeMode(m: DatabaseMode): string`(비밀번호 가림).
  - main.ts의 `launchCtx`는 `{ ctx; baseline: withoutDbKeys(cfg.env); mode: cfg.databaseMode }`를 든다 — Task 12가 이것을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다 — `config.ts`**

`desktop/tests/config.test.ts`에서 아래 기존 테스트를 이렇게 바꾼다.

import 줄: `import { DB_ENV_KEYS, defaultConfig, LEGACY_DATABASE_URL, loadConfig, refreshEnv, withoutDbKeys } from "../src/config";`와 `import { embeddedDatabaseUrl, pgLayout } from "../src/services/pg-layout";`.

`describe("defaultConfig")`의 첫 두 테스트를 교체한다:

```ts
  it("does not put the database or the storage into the first config.json — the app derives both (Phase 3)", () => {
    // Phase 1·2는 여기에 Docker DB 주소와 <userData>/storage를 적었고, 그 값이 사람이 고른 것인지 옛 기본값인지
    // 파일만으로 구별되지 않게 됐다 (Phase 3 스펙 §6.1 옛 키).
    const env = defaultConfig("/tmp/ud");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STORAGE_ROOT).toBeUndefined();
  });

  it("carries the keys the app owns defaults for — and not WORKER_ID, which is per run", () => {
    expect(Object.keys(defaultConfig("/tmp/ud")).sort()).toEqual(["EMBED_SERVICE_PORT", "PORT"]);
  });
```

`describe("loadConfig")`의 `creates config.json with the defaults on first run`을 교체한다:

```ts
  it("creates config.json with the defaults on first run", () => {
    const r = loadConfig(dir);
    expect(r.created).toBe(true);
    expect(r.warning).toBeUndefined();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect("DATABASE_URL" in onDisk).toBe(false);
    expect(onDisk.PORT).toBe("3000");
    expect("EMBED_SERVICE_HOST" in onDisk).toBe(false);
    expect(r.env.EMBED_SERVICE_HOST).toBe("127.0.0.1");
    expect(r.databaseMode).toEqual({ kind: "embedded" });
    expect(r.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
  });
```

`resolves a relative STORAGE_ROOT…`와 `keeps an absolute STORAGE_ROOT as given`을 외부 모드로 옮긴다:

```ts
  it("resolves a relative STORAGE_ROOT against the user data directory in external debug mode", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ DEBUG_EXTERNAL_DATABASE_URL: "postgres://x@h/db", STORAGE_ROOT: "./audio" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe(path.join(dir, "audio"));
  });

  it("keeps an absolute STORAGE_ROOT as given in external debug mode", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ DEBUG_EXTERNAL_DATABASE_URL: "postgres://x@h/db", STORAGE_ROOT: "/srv/damwha" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe("/srv/damwha");
  });
```

`reads REPO_ROOT, UV_BIN and DOCKER_BIN as app settings, not child env`를 교체한다:

```ts
  it("reads REPO_ROOT and UV_BIN as app settings, and ignores DOCKER_BIN with a log note (Phase 3)", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ REPO_ROOT: "/r", UV_BIN: "/x/uv", DOCKER_BIN: "/x/docker" }),
    );
    const c = loadConfig(dir);
    expect(c.repoRoot).toBe("/r");
    expect(c.uvBin).toBe("/x/uv");
    expect("dockerBin" in c).toBe(false);
    for (const key of ["REPO_ROOT", "UV_BIN", "DOCKER_BIN"]) expect(key in c.env).toBe(false);
    expect(c.warning).toBeUndefined();
    expect(c.notes.join("\n")).toMatch(/DOCKER_BIN/);
  });
```

파일 끝에 다음 describe를 더한다:

```ts
describe("loadConfig — database mode (Phase 3 스펙 §6.1)", () => {
  const write = (obj: Record<string, unknown>) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(obj));

  it("derives the embedded database and its paired storage by default", () => {
    write({ PORT: "3000" });
    const c = loadConfig(dir);
    const layout = pgLayout(dir);
    expect(c.databaseMode).toEqual({ kind: "embedded" });
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(layout));
    expect(c.env.STORAGE_ROOT).toBe(layout.storage);
  });

  it("ignores the Phase 1·2 defaults quietly — a note for the log, nothing on screen, the file untouched", () => {
    write({ DATABASE_URL: LEGACY_DATABASE_URL, STORAGE_ROOT: path.join(dir, "storage"), PORT: "3000" });
    const before = fs.readFileSync(path.join(dir, "config.json"));
    const c = loadConfig(dir);
    expect(c.warning).toBeUndefined();
    expect(c.notes).toHaveLength(2);
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
    expect(c.env.STORAGE_ROOT).toBe(pgLayout(dir).storage);
    expect(fs.readFileSync(path.join(dir, "config.json")).equals(before)).toBe(true);
  });

  it("warns on screen about a DATABASE_URL someone chose, and still uses the embedded database", () => {
    write({ DATABASE_URL: "postgres://me:pw@db.internal:5432/other" });
    const c = loadConfig(dir);
    expect(c.warning).toMatch(/DATABASE_URL/);
    expect(c.warning).toMatch(/DEBUG_EXTERNAL_DATABASE_URL/);
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
  });

  it("switches to external debug mode only when DEBUG_EXTERNAL_DATABASE_URL is written, and keeps that key out of the child env", () => {
    write({ DEBUG_EXTERNAL_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha" });
    const c = loadConfig(dir);
    expect(c.databaseMode).toEqual({ kind: "external", url: "postgres://postgres:postgres@localhost:5432/damwha" });
    expect(c.env.DATABASE_URL).toBe("postgres://postgres:postgres@localhost:5432/damwha");
    expect(c.env.STORAGE_ROOT).toBe(path.join(dir, "storage"));
    expect("DEBUG_EXTERNAL_DATABASE_URL" in c.env).toBe(false);
  });

  it("rejects a DEBUG_EXTERNAL_DATABASE_URL that is not a non-empty string and stays embedded", () => {
    write({ DEBUG_EXTERNAL_DATABASE_URL: 5432 });
    const c = loadConfig(dir);
    expect(c.databaseMode).toEqual({ kind: "embedded" });
    expect(c.warning).toMatch(/DEBUG_EXTERNAL_DATABASE_URL/);
  });

  it("stays embedded when config.json is broken", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    const c = loadConfig(dir);
    expect(c.databaseMode).toEqual({ kind: "embedded" });
    expect(c.env.DATABASE_URL).toBe(embeddedDatabaseUrl(pgLayout(dir)));
  });

  it("strips exactly the database keys for the reload baseline", () => {
    expect(DB_ENV_KEYS).toEqual(["DATABASE_URL", "STORAGE_ROOT"]);
    expect(withoutDbKeys({ DATABASE_URL: "a", STORAGE_ROOT: "b", PORT: "3000" })).toEqual({ PORT: "3000" });
  });
});
```

- [ ] **Step 2: 실패하는 테스트를 쓴다 — `config-reload.ts`**

`desktop/tests/config-reload.test.ts`:

(a) import에 `type DatabaseMode`를 더한다: `import type { ApiEnv, DatabaseMode, LoadedConfig } from "../src/config";`.

(b) `harness`를 모드를 받게 바꾼다(기존 호출은 그대로 둔다):

```ts
function harness(live: { env: ApiEnv; baseline: ApiEnv } | null, liveMode: DatabaseMode = { kind: "embedded" }) {
  const log: string[] = [];
  let next: LoadedConfig = { env: {}, created: false, extraPath: [], notes: [], databaseMode: { kind: "embedded" } };
  let loads = 0;
  const reload = createConfigReloader({
    load: () => {
      loads += 1;
      return next;
    },
    live: () => (live === null ? null : { env: live.env, baseline: live.baseline, mode: liveMode }),
    log: (line) => void log.push(line),
  });
  return {
    log,
    reload,
    loadCount: () => loads,
    file(env: ApiEnv, warning?: string, databaseMode: DatabaseMode = { kind: "embedded" }) {
      next = { env, created: false, extraPath: [], notes: [], databaseMode, ...(warning === undefined ? {} : { warning }) };
    },
  };
}
```

(c) `puts a corrected pass-through value into the live env and names it once`의 키를 `DATABASE_URL`에서 `SUMMARY_LLM_MODEL`로 바꾼다(값 `"a/wrong"` → `"a/right"`, 로그 기대값 `바뀐 키: SUMMARY_LLM_MODEL`). DB 키는 이제 재적용 대상이 아니다.

(d) 파일 끝에 더한다:

```ts
describe("createConfigReloader — database mode (Phase 3 스펙 §6.6)", () => {
  it("never writes DATABASE_URL or STORAGE_ROOT into the live env, whatever the file says", () => {
    const live = {
      env: { DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu%2Frun", STORAGE_ROOT: "/u/data/storage", PORT: "3000" },
      baseline: { PORT: "3000" },
    };
    const h = harness(live);
    h.file({ DATABASE_URL: "postgres://elsewhere", STORAGE_ROOT: "/elsewhere", PORT: "3000" });
    h.reload();
    expect(live.env.DATABASE_URL).toBe("postgresql://damwha@/damwha?host=%2Fu%2Frun");
    expect(live.env.STORAGE_ROOT).toBe("/u/data/storage");
  });

  it("does not delete the live database keys when the file has none", () => {
    const live = { env: { DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu", STORAGE_ROOT: "/u/data/storage" }, baseline: {} };
    const h = harness(live);
    h.file({});
    h.reload();
    expect(live.env).toMatchObject({ DATABASE_URL: "postgresql://damwha@/damwha?host=%2Fu", STORAGE_ROOT: "/u/data/storage" });
  });

  it("says a restart is needed when the file adds external debug mode", () => {
    const live = { env: { STORAGE_ROOT: "/u/data/storage" }, baseline: {} };
    const h = harness(live);
    h.file({ STORAGE_ROOT: "/u/storage" }, undefined, { kind: "external", url: "postgres://postgres:secret@localhost:5432/damwha" });
    const r = h.reload();
    expect(r.notice).toMatch(/다시 켜야/);
    expect(r.notice).toMatch(/외부 DB/);
    expect(r.notice).not.toContain("secret");
  });

  it("says a restart is needed when the file removes external debug mode — the direction refreshEnv could not see", () => {
    const live = { env: { STORAGE_ROOT: "/u/storage" }, baseline: {} };
    const h = harness(live, { kind: "external", url: "postgres://x@h/db" });
    h.file({ STORAGE_ROOT: "/u/data/storage" });
    expect(h.reload().notice).toMatch(/내장 DB.*다시 켜야|다시 켜야.*내장 DB/);
  });

  it("says a restart is needed when the external URL or its storage changes", () => {
    const live = { env: { STORAGE_ROOT: "/u/storage" }, baseline: {} };
    const h = harness(live, { kind: "external", url: "postgres://x@h/db" });
    h.file({ STORAGE_ROOT: "/u/storage" }, undefined, { kind: "external", url: "postgres://x@h/other" });
    expect(h.reload().notice).toMatch(/다시 켜야/);
    h.file({ STORAGE_ROOT: "/srv/audio" }, undefined, { kind: "external", url: "postgres://x@h/db" });
    expect(h.reload().notice).toMatch(/다시 켜야/);
  });

  it("says nothing when the mode and storage agree", () => {
    const live = { env: { STORAGE_ROOT: "/u/data/storage" }, baseline: {} };
    const h = harness(live);
    h.file({ STORAGE_ROOT: "/u/data/storage" });
    expect(h.reload()).toEqual({ notice: null, isNew: false });
  });
});
```

Run: `pnpm --filter damwha-desktop exec vitest run tests/config.test.ts tests/config-reload.test.ts`
Expected: FAIL — `DB_ENV_KEYS`·`LEGACY_DATABASE_URL`·`withoutDbKeys` 없음, `notes`·`databaseMode` 없음.

- [ ] **Step 3: `config.ts`를 고친다**

(a) import에 `import { embeddedDatabaseUrl, pgLayout } from "./services/pg-layout";`를 더한다.

(b) `LoadedConfig`를 바꾼다:

```ts
export interface LoadedConfig {
  env: ApiEnv;
  /** config.json을 이번 실행에서 만들었으면 true */
  created: boolean;
  /** 화면에 보일 경고. 사람이 적은 값을 앱이 쓰지 않았을 때. */
  warning?: string;
  /** 로그에만 남기는 사실. 사람이 고른 적 없는 옛 기본값을 무시한 것처럼, 화면에 띄우면 할 일 없는 안내가 되는 것. */
  notes: string[];
  /** 저장소 체크아웃. 없으면 main.ts가 추측하거나 사람에게 묻는다 (Phase 2 스펙 §6.4). */
  repoRoot?: string;
  uvBin?: string;
  /** PATH 탐색에 앞세울 디렉터리. 기본 목록을 이긴다 (services/resolve.ts). */
  extraPath: string[];
  /** 감독자를 만들 때 한 번 정한다. 실행 중에는 바꾸지 않고 재적용기가 보고만 한다 (Phase 3 스펙 §6.1). */
  databaseMode: DatabaseMode;
}

/** 내장 모드가 기본이다. 외부 모드는 사람이 DEBUG_EXTERNAL_DATABASE_URL을 적었을 때만 켜지는 디버깅 탈출구다. */
export type DatabaseMode = { kind: "embedded" } | { kind: "external"; url: string };

/** Phase 1·2의 defaultConfig가 첫 실행 config.json에 적던 값. 이 값과 문자 그대로 같으면 사람이 고른 것이 아니다. */
export const LEGACY_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/damwha";

/** 모드가 정하는 키. 재적용(refreshEnv)의 대상이 아니다 — 다시 켜도 파일 값으로 바뀌지 않는 값이다 (스펙 §6.6). */
export const DB_ENV_KEYS = ["DATABASE_URL", "STORAGE_ROOT"] as const;

export function withoutDbKeys(env: ApiEnv): ApiEnv {
  const out: ApiEnv = { ...env };
  for (const key of DB_ENV_KEYS) delete out[key];
  return out;
}
```

(c) `defaultConfig`를 바꾼다:

```ts
/**
 * 앱이 기본값을 갖는 키. 첫 실행의 config.json이 **그대로 이것**이다. DATABASE_URL·STORAGE_ROOT는 여기 없다 —
 * Phase 3부터 모드가 정하는 앱 소유 값이고(withDatabase), 파일에 적으면 사람에게 "고쳐도 되는 값"으로 광고된다.
 * WORKER_ID도 없다 — 위 RUN_WORKER_ID.
 */
export function defaultConfig(_userDataDir: string): ApiEnv {
  return {
    PORT: "3000",
    EMBED_SERVICE_PORT: "8100",
  };
}
```

(d) `APP_SETTING_KEYS`를 `const APP_SETTING_KEYS = ["REPO_ROOT", "EXTRA_PATH", "UV_BIN", "DEBUG_EXTERNAL_DATABASE_URL"];`로 바꾼다.

(e) `withAppOwned` 위에 모드 적용 함수를 더한다:

```ts
/** 내장 모드의 DB 쌍 (스펙 §6.1). 파일 값보다 **뒤에** 얹는다 — 앱이 주장하는 값이지 물려받는 값이 아니다. */
function withEmbeddedDatabase(env: ApiEnv, userDataDir: string): ApiEnv {
  const layout = pgLayout(userDataDir);
  return { ...env, DATABASE_URL: embeddedDatabaseUrl(layout), STORAGE_ROOT: layout.storage };
}
```

(f) `loadConfig`를 교체한다:

```ts
export function loadConfig(userDataDir: string): LoadedConfig {
  const file = path.join(userDataDir, "config.json");
  const defaults = defaultConfig(userDataDir);
  // 파일을 못 쓰거나 읽지 못해도 내장 모드다. 외부 모드는 사람이 명시적으로 적어야만 켜진다.
  const embedded = (): Pick<LoadedConfig, "env" | "notes" | "extraPath" | "databaseMode"> => ({
    env: withAppOwned(withEmbeddedDatabase(defaults, userDataDir)),
    notes: [],
    extraPath: [],
    databaseMode: { kind: "embedded" },
  });

  if (!fs.existsSync(file)) {
    // 이 두 줄은 원래 try 밖이라 userData가 읽기 전용이거나 디스크가 찼을 때 그대로
    // 던졌다. 호출부인 startOnce()는 showStatus({state:"starting"}) 직후라 그 예외가
    // 실패 화면에 닿지 못하고 앱이 "준비 중"에 영원히 머문다. 파일을 남기지 못하는 것은
    // 기본값으로 계속 갈 수 없는 이유가 아니다 — 경고로 바꾼다.
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(defaults, null, 2)}\n`);
      return { ...embedded(), created: true };
    } catch (e) {
      return { ...embedded(), created: false, warning: `config.json을 만들 수 없어 기본값으로 실행합니다: ${reason(e)}` };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // 덮어쓰지 않는다 — 사용자가 직접 고칠 수 있어야 한다 (스펙 §8).
    return { ...embedded(), created: false, warning: `config.json을 읽을 수 없어 기본값으로 실행합니다: ${reason(e)}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...embedded(), created: false, warning: "config.json이 객체가 아니라 기본값으로 실행합니다." };
  }

  const env: ApiEnv = { ...defaults };
  const settings: { repoRoot?: string; uvBin?: string; externalUrl?: string; extraPath: string[] } = { extraPath: [] };
  const fileDb: Partial<Record<(typeof DB_ENV_KEYS)[number], string>> = {};
  // 값을 버렸으면 왜 버렸는지 적는다. 조용히 무시하면 사용자는 자기가 적은 경로가 왜 안 먹는지
  // 알 길이 없고, 다음에 보는 화면은 엉뚱한 원인을 말한다.
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (APP_OWNED_KEYS.includes(key)) {
      warnings.push(
        `config.json의 ${key}는 앱이 ${LOOPBACK}으로 고정합니다. 파일 값은 무시했습니다: ${JSON.stringify(value)}`,
      );
      continue;
    }
    if (key === "DOCKER_BIN") {
      notes.push("config.json의 DOCKER_BIN은 쓰지 않아요 — Phase 3부터 앱은 Docker를 부르지 않습니다.");
      continue;
    }
    if ((DB_ENV_KEYS as readonly string[]).includes(key)) {
      // 모드가 정한다. 여기서는 옛 키 판정을 위해 파일 값만 기억한다.
      if (typeof value === "string") fileDb[key as (typeof DB_ENV_KEYS)[number]] = value;
      continue;
    }
    if (APP_SETTING_KEYS.includes(key)) {
      if (key === "EXTRA_PATH") {
        // 문자열 **목록만** 받는다. (Phase 2 주석 그대로 유지)
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          settings.extraPath = value as string[];
        } else {
          warnings.push(
            `config.json의 EXTRA_PATH는 문자열 목록이어야 해요. 이 값은 무시했습니다: ${JSON.stringify(value)}`,
          );
        }
      } else if (key === "DEBUG_EXTERNAL_DATABASE_URL") {
        if (typeof value === "string" && value.trim() !== "") settings.externalUrl = value;
        else warnings.push(`config.json의 DEBUG_EXTERNAL_DATABASE_URL은 비어 있지 않은 문자열이어야 해요. 내장 DB로 실행합니다: ${JSON.stringify(value)}`);
      } else if (typeof value === "string") {
        if (key === "REPO_ROOT") settings.repoRoot = value;
        else settings.uvBin = value;
      }
      continue;
    }
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    // 그 밖의 타입은 무시한다. 값의 유효성은 API의 zod가 판정한다.
  }

  let databaseMode: DatabaseMode;
  let withDb: ApiEnv;
  if (settings.externalUrl !== undefined) {
    databaseMode = { kind: "external", url: settings.externalUrl };
    // 상대 경로가 남으면 packaged 앱의 cwd가 .app 안이라 번들 내부를 가리킨다 (Phase 1 스펙 §6.3).
    withDb = { ...env, DATABASE_URL: settings.externalUrl, STORAGE_ROOT: path.resolve(userDataDir, fileDb.STORAGE_ROOT ?? "storage") };
    if (fileDb.DATABASE_URL !== undefined) notes.push("외부 DB 모드는 DEBUG_EXTERNAL_DATABASE_URL을 써요 — config.json의 DATABASE_URL은 무시했습니다.");
  } else {
    databaseMode = { kind: "embedded" };
    withDb = withEmbeddedDatabase(env, userDataDir);
    for (const key of DB_ENV_KEYS) {
      const value = fileDb[key];
      if (value === undefined) continue;
      const legacy = key === "DATABASE_URL" ? value === LEGACY_DATABASE_URL : path.resolve(userDataDir, value) === path.join(userDataDir, "storage");
      if (legacy) notes.push(`config.json의 ${key}는 Phase 1·2의 기본값이에요 — 내장 DB 모드에서는 쓰지 않습니다.`);
      else warnings.push(`내장 DB 모드에서는 config.json의 ${key}를 쓰지 않아요 (파일 값: ${JSON.stringify(value)}). 외부 DB로 디버깅하려면 DEBUG_EXTERNAL_DATABASE_URL을 적어 주세요.`);
    }
  }

  return {
    env: withAppOwned(withDb),
    created: false,
    notes,
    databaseMode,
    extraPath: settings.extraPath,
    ...(settings.repoRoot === undefined ? {} : { repoRoot: settings.repoRoot }),
    ...(settings.uvBin === undefined ? {} : { uvBin: settings.uvBin }),
    ...(warnings.length > 0 ? { warning: warnings.join(" / ") } : {}),
  };
}
```

EXTRA_PATH 분기의 긴 주석은 기존 파일의 것을 그대로 옮긴다(위에서는 줄였다).

- [ ] **Step 4: `config-reload.ts`를 고친다**

(a) import를 `import { refreshEnv, withoutDbKeys, type ApiEnv, type DatabaseMode, type LoadedConfig } from "./config";`로 바꾼다.

(b) `ConfigReloadDeps.live`의 타입과 주석을 바꾼다:

```ts
  /**
   * 살아 있는 감독자의 env와, 그것을 만든 파일 값(baseline — DB 키를 뺀 것), 그리고 감독자를 만들 때 정한 DB 모드.
   * 감독자가 아직 없으면 null.
   */
  live(): { env: ApiEnv; baseline: ApiEnv; mode: DatabaseMode } | null;
```

(c) 모드 설명 함수를 더한다:

```ts
/** 화면·로그에 싣는 모드 이름. URL의 비밀번호는 가린다 — 이 문구는 supervisor.log와 대화상자에 남는다. */
export function describeMode(m: DatabaseMode): string {
  if (m.kind === "embedded") return "내장 DB";
  try {
    const u = new URL(m.url);
    if (u.password !== "") u.password = "***";
    return `외부 DB(디버깅) ${u.toString()}`;
  } catch {
    return "외부 DB(디버깅)";
  }
}

function sameMode(a: DatabaseMode, b: DatabaseMode): boolean {
  if (a.kind === "embedded" || b.kind === "embedded") return a.kind === b.kind;
  return a.url === b.url;
}
```

(d) 재적용기 본문에서 `refreshEnv` 호출과 안내 조립을 바꾼다:

```ts
    // DB 키는 넘기지 않는다. 모드가 정하는 값이라 파일로 바뀌지 않고, 지운다고 사라지지도 않는다 (스펙 §6.6).
    const { changed, removed, needsRestart } = refreshEnv(
      live.env,
      live.baseline,
      withoutDbKeys(cfg.env),
      RESTART_ONLY_KEYS,
    );
```

```ts
    const notices: string[] = [];
    if (needsRestart.length > 0) {
      notices.push(
        `${needsRestart.map((r) => `${r.key}은(는) 파일에 ${r.file}, 실행 중인 값은 ${r.live}`).join(" / ")} — 이 키는 앱을 다시 켜야 바뀌어요.`,
      );
    }
    // 키 단위가 아니라 모드 자체를 비교한다. refreshEnv는 파일에서 **사라진** restart-only 키를 보고하지 않으므로,
    // DEBUG_EXTERNAL_DATABASE_URL을 지워 내장 모드로 돌아가려는 사람에게 아무 말도 하지 않는다 (외부 리뷰 #5).
    if (!sameMode(cfg.databaseMode, live.mode) || cfg.env.STORAGE_ROOT !== live.env.STORAGE_ROOT) {
      notices.push(
        `데이터베이스가 파일에서는 ${describeMode(cfg.databaseMode)}(파일 저장소 ${cfg.env.STORAGE_ROOT}), 실행 중에는 ${describeMode(live.mode)}(파일 저장소 ${live.env.STORAGE_ROOT})예요 — 앱을 다시 켜야 바뀌어요.`,
      );
    }
    if (notices.length === 0) {
      // 리셋이 빠지면 어긋남이 풀렸다가 **같은 모양으로** 다시 났을 때 두 번째를 아무도
      // 적지 않고 아무도 말하지 않는다 — 로그도 대화상자도 첫 번째로 끝난다.
      lastNotice = "";
      return { notice: null, isNew: false };
    }
    const notice = notices.join(" / ");
```

(그 아래 `isNew` 계산과 반환은 그대로다.)

`describe mode` 테스트의 `says nothing when the mode and storage agree`에서 파일 env에 `STORAGE_ROOT`가 있어야 비교가 성립한다 — 실제 `loadConfig`는 두 모드 모두 `STORAGE_ROOT`를 채운다.

- [ ] **Step 5: `main.ts`의 컴파일을 맞춘다**

`createSupervisorFor`에서:

```ts
  // DOCKER_BIN은 config.ts가 더 이상 읽지 않는다. compose 어댑터는 Task 12에서 사라진다.
  const docker = findExecutable("docker", dirs);
```

그리고 `cfg.warning` 로그 줄 뒤에 `for (const note of cfg.notes) appendSupervisorLog(note);`를 더한다. `launchCtx`의 타입과 대입을 바꾼다:

```ts
let launchCtx: { ctx: Omit<LaunchContext, "signal">; baseline: ApiEnv; mode: DatabaseMode } | null = null;
```

```ts
  launchCtx = { ctx, baseline: withoutDbKeys(cfg.env), mode: cfg.databaseMode };
```

`reloadConfig`의 `live`를 `() => (launchCtx === null ? null : { env: launchCtx.ctx.env, baseline: launchCtx.baseline, mode: launchCtx.mode })`로 바꾸고, import에 `withoutDbKeys`·`type DatabaseMode`를 더한다.

- [ ] **Step 6: 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint`
Expected: 전부 PASS, lint 0.

- [ ] **Step 7: 변이로 확인한다**

(a) `config-reload.ts`에서 `withoutDbKeys(cfg.env)`를 `cfg.env`로 되돌린다 → `never writes DATABASE_URL or STORAGE_ROOT into the live env` FAIL. 되돌린다.
(b) `sameMode` 비교를 지우고 STORAGE_ROOT 비교만 남긴다 → `says a restart is needed when the external URL … changes`의 첫 단언 FAIL. 되돌린다.
(c) `loadConfig`의 옛 키 `legacy` 판정을 `false`로 고정한다 → `ignores the Phase 1·2 defaults quietly` FAIL. 되돌린다.

- [ ] **Step 8: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/config.ts desktop/src/config-reload.ts desktop/src/main.ts desktop/tests/config.test.ts desktop/tests/config-reload.test.ts
git commit -F - <<'MSG'
feat(desktop): 설정이 DB 모드를 정하고 재적용이 모드 변경을 양방향으로 알린다

기본은 내장 모드다. DATABASE_URL과 STORAGE_ROOT는 모드가 파생하는 앱 소유 값이라 첫 실행
config.json에 적지 않는다. Phase 1·2가 적어 둔 옛 기본값은 로그 한 줄로만 무시하고, 사람이
고른 값이면 화면에 경고한다. 외부 DB는 DEBUG_EXTERNAL_DATABASE_URL을 적었을 때만 켜진다.

재적용은 DB 키를 넘기지 않는다. 대신 모드와 파일 저장소를 비교해, 외부 모드를 더할 때도
지울 때도 "다시 켜야 바뀐다"고 말한다 — refreshEnv는 사라진 키를 보지 못했다. 안내의 URL은
비밀번호를 가린다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 6 PASS, lint 0. Step 7 세 변이 FAIL(출력 첨부).
- `grep -n "dockerBin\|DOCKER_BIN" desktop/src/config.ts` → `DOCKER_BIN` note 한 곳만.

**Review:**
- 내장 모드의 DB 값이 파일 값 **뒤에** 얹히는가. 첫 실행 config.json에 DB 키가 없는가.
- 옛 기본값 판정이 **문자 그대로** 같은 경우만 조용한가(`STORAGE_ROOT`는 해석한 절대 경로로 비교).
- `launchCtx.baseline`이 DB 키를 뺀 값인가. 빼지 않으면 refreshEnv의 삭제 루프가 살아 있는 `DATABASE_URL`을 지운다.
- `describeMode`가 비밀번호를 가리는가.

---

## Task 11: 화면 — 내장 DB 표시와 Docker 화면 걷어내기

스펙 §6.3(디버깅 접속 명령)·§6.7(로그 링크, db-unreachable 화면 삭제)·§6.1(외부 모드 상시 배지, 설정 경고)·Phase 2 `REPO_ROOT` 검증에서 compose 요구 제거.

**Files:**
- Modify: `desktop/src/status-view.ts`
- Modify: `desktop/src/shell-window.ts`
- Modify: `desktop/shell/status.html`
- Modify: `desktop/shell/services.html`
- Modify: `desktop/src/repo-root.ts`
- Modify: `desktop/src/shell-hints.ts` (`repoRootMissing` 안내)
- Test: `desktop/tests/status-view.test.ts`, `desktop/tests/shell-html.test.ts`, `desktop/tests/repo-root.test.ts`

**Interfaces:**
- Consumes: Task 7 `CAUSES.externalDatabase`.
- Produces:
  - `status-view.ts`: `statusLine(s: ServiceStatus, externalDatabase?: boolean): string`; `ShellInput`·`ServicesInput`에 `externalDatabase?: boolean`, `configWarning?: string | null`; `ServicesInput.debugCommand?: string | null`; `ServiceRow.command?: string`; `EXTERNAL_DATABASE_NOTE = "외부 DB(디버깅)"`; `logIdOf` 삭제(서비스 id가 곧 로그 이름).
  - `shell-window.ts`: `ShellState = "starting" | "quitting" | "failed"`.
  - `repo-root.ts`: 표식은 `be/worker/pyproject.toml` 하나.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/repo-root.test.ts`를 교체한다:

```ts
import { describe, expect, it } from "vitest";
import { isRepoRoot } from "../src/repo-root";

describe("isRepoRoot", () => {
  const present = (paths: string[]) => (p: string) => paths.includes(p);

  it("accepts a dir that holds the worker project — the compose file is not needed since Phase 3", () => {
    expect(isRepoRoot("/r", present(["/r/be/worker/pyproject.toml"]))).toBe(true);
  });

  it("rejects a dir missing the worker project", () => {
    expect(isRepoRoot("/r", present(["/r/be/docker-compose.yml"]))).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isRepoRoot("", () => true)).toBe(false);
  });
});
```

`desktop/tests/status-view.test.ts`에서:

(a) `puts the cause and then the hint under a failed service`의 원인을 Docker에서 페어링 거부로 바꾼다:

```ts
  it("puts the cause and then the hint under a failed service", () => {
    const detail = CAUSES.pgPairingRefused.text("파일 저장소가 다른 데이터베이스의 것이에요", "/u/data/postgres", "/u/data/storage");
    const line = statusLine(st("postgres", { process: "failed", health: "unknown", detail }));
    expect(line).toBe(`데이터베이스: 실패\n    ${detail}\n    ${HINT_PREFIX}${HINTS.pgPairingRefused}`);
  });
```

(b) `uses the db-unreachable screen when postgres failed on the Docker daemon, with the supervisor log` 테스트와 `does not use the db-unreachable screen for a raw compose error…` 테스트, 그리고 `화면이 싣는 해결 문구` describe의 `P2-C7: Docker daemon down…` 테스트를 **지우고**, 그 자리에 다음을 넣는다:

```ts
  it("always uses the plain failure screen for a postgres failure, with the server's own log (Phase 3)", () => {
    const detail = CAUSES.pgVersionMismatch.text("15", "16");
    const shell = shellStatusFrom({
      statuses: [st("postgres", { process: "failed", health: "unknown", detail }), st("api", { process: "stopped", health: "unknown" })],
      restartNotice: null,
      logPathOf,
    });
    expect(shell.state).toBe("failed");
    expect(shell.logPath).toBe("/logs/postgres.log");
    expect(shell.detail).toContain(HINTS.pgVersionMismatch as string);
  });
```

(`never puts a retry countdown…`의 원인도 `CAUSES.pgVersionMismatch.text("15", "16")`로 바꾼다.)

(c) `servicesView` describe에 더한다:

```ts
  it("marks the adopted debug database on the row and in the status line, as a warning that does not go away", () => {
    const statuses = [st("postgres", { owned: false }), st("api")];
    const view = servicesView({ statuses, restartNotice: null, logPathOf, externalDatabase: true });
    expect(view.rows[0].tone).toBe("warn");
    expect(view.rows[0].notes).toContain("외부 DB(디버깅)");
    expect(view.rows[0].notes).not.toContain("앱이 띄우지 않음");
    expect(view.rows[0].warning).toBe(CAUSES.externalDatabase.text);
    expect(statusLine(statuses[0], true)).toBe("데이터베이스: 실행 중 (외부 DB(디버깅))");
  });

  it("shows the psql command on a running embedded database row only", () => {
    const cmd = `"/B/postgres/bin/psql" -h "/u/run" -U damwha damwha`;
    const up = servicesView({ statuses: [st("postgres")], restartNotice: null, logPathOf, debugCommand: cmd });
    expect(up.rows[0].command).toBe(cmd);
    const down = servicesView({ statuses: [st("postgres", { process: "failed", health: "unknown" })], restartNotice: null, logPathOf, debugCommand: cmd });
    expect(down.rows[0].command).toBeUndefined();
    const external = servicesView({ statuses: [st("postgres", { owned: false })], restartNotice: null, logPathOf, externalDatabase: true, debugCommand: cmd });
    expect(external.rows[0].command).toBeUndefined();
  });

  it("puts a config warning among the notices and on the failure screen", () => {
    const warning = "내장 DB 모드에서는 config.json의 DATABASE_URL를 쓰지 않아요";
    expect(servicesView({ statuses: [st("api")], restartNotice: null, logPathOf, configWarning: warning }).notices).toContain(warning);
    const shell = shellStatusFrom({ statuses: [st("api")], restartNotice: null, logPathOf, configWarning: warning });
    expect(shell.detail).toContain(warning);
  });

  it("links postgres to its own log, not the supervisor's", () => {
    expect(servicesView({ statuses: [st("postgres")], restartNotice: null, logPathOf }).rows[0].log).toBe("/logs/postgres.log");
  });
```

지운 테스트가 쓰던 import(`postgresSpec` 등)가 파일에서 더 쓰이지 않으면 함께 지운다 — Task 12가 `services/postgres.ts`를 지우면 남은 import가 컴파일을 깬다.

`desktop/tests/shell-html.test.ts`에서 `describe("status.html")`의 첫 테스트(`no longer tells the user to run \`pnpm db:up\``)와 `describe("the body follows the cause…")` 전체를 **지우고**(그 describe만 쓰던 `postgresSpec`·`shellStatusFrom`·`LaunchContext` import도 더 쓰이지 않으면 지운다) 다음을 넣는다:

```ts
  it("has no Docker screen — the app runs its own database (Phase 3)", () => {
    const { html } = loadPage("status.html");
    expect(codeOf(html)).not.toMatch(/db-unreachable|Docker/);
  });
```

`describe("services.html")`에 더한다:

```ts
  it("renders the debug command as text", () => {
    const { byId, sandbox } = loadPage("services.html");
    const render = (sandbox.window as { __damwha_render: (v: unknown) => void }).__damwha_render;
    render({
      notices: [],
      rows: [{ id: "postgres", name: "데이터베이스", state: "실행 중", tone: "ok", notes: [], log: "/l", command: `psql -h "<img src=x onerror=alert(1)>"` }],
    });
    const rows = byId.get("rows")!;
    expect(JSON.stringify(rows)).toContain("<img src=x onerror=alert(1)>");
    expect(JSON.stringify(rows)).toMatch(/디버깅 접속/);
  });
```

(이 파일의 `loadPage`가 돌려주는 가짜 DOM에서 자식 요소 텍스트를 읽는 방법이 기존 `services.html` 테스트와 다르면, 같은 describe의 기존 테스트가 쓰는 조회 방식을 따른다 — 판정은 "명령 문자열이 `textContent`로 들어갔다"와 "`디버깅 접속` 머리말이 있다" 두 가지다.)

Run: `pnpm --filter damwha-desktop exec vitest run tests/repo-root.test.ts tests/status-view.test.ts tests/shell-html.test.ts`
Expected: FAIL.

- [ ] **Step 2: `repo-root.ts`와 안내를 고친다**

`desktop/src/repo-root.ts`:

```ts
/**
 * packaged .app 안에는 be/worker가 없다 — Phase 4가 번들할 것이라 그때까지 저장소 체크아웃을 가리켜야 한다. 빌드 시점에
 * 굽지 않는 이유는 Phase 1의 번들 위생 기준이 "번들 안에 저장소 절대 경로 0건"을 요구하기 때문이다 (Phase 2 스펙 §6.4).
 * Phase 3부터 앱이 Docker를 부르지 않으므로 be/docker-compose.yml은 표식이 아니다.
 */
const MARKERS = ["be/worker/pyproject.toml"] as const;
```

`desktop/src/shell-hints.ts`의 `repoRootMissing`을 `"be/worker가 있는 담화 저장소 폴더를 골라 주세요.",`로 바꾼다. `desktop/src/main.ts` `resolveRepoRoot`의 대화상자 `message`를 `"be/worker가 있는 담화 저장소 폴더입니다."`로 바꾼다.

- [ ] **Step 3: `status-view.ts`를 고친다**

(a) import에서 `causeIn`을 지우고 `CAUSES`를 더한다: `import { CAUSES } from "./causes";`.

(b) `logIdOf` 함수를 지우고 상수를 더한다:

```ts
/** 외부 디버그 모드의 postgres 줄에 붙는 표시. 실패가 아니라 상시 경고다 (Phase 3 스펙 §6.1). */
export const EXTERNAL_DATABASE_NOTE = "외부 DB(디버깅)";
```

(c) `statusLine`을 바꾼다:

```ts
export function statusLine(s: ServiceStatus, externalDatabase = false): string {
  const adopted =
    s.process === "running" && !s.owned
      ? s.id === "postgres" && externalDatabase
        ? ` (${EXTERNAL_DATABASE_NOTE})`
        : " (앱이 띄우지 않음)"
      : "";
  const degraded = s.health === "degraded" ? " — 동작이 제한돼요" : "";
  const shown = s.detail !== undefined && (s.process === "failed" || s.health === "degraded");
  const why = shown ? `\n    ${indent(causeWithFix(s.detail ?? "", recoveryHint(s)), "    ")}` : "";
  return `${SERVICE_LABELS[s.id]}: ${PROCESS_LABELS[s.process]}${adopted}${degraded}${why}`;
}
```

(d) `ShellInput`에 `externalDatabase?: boolean; configWarning?: string | null;`를 더하고 `shellStatusFrom`을 바꾼다:

```ts
export function shellStatusFrom(input: ShellInput): ShellStatus {
  const lines = [
    ...input.statuses.map((s) => statusLine(s, input.externalDatabase === true)),
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
    ...(input.configWarning === undefined || input.configWarning === null ? [] : [input.configWarning]),
  ];
  const failed = input.statuses.find((s) => s.process === "failed");
  if (failed === undefined) return { state: "starting", detail: lines.join("\n") };
  // Phase 2의 db-unreachable 화면("Docker Desktop이 실행 중인지 확인해 주세요")은 없다 — 앱이 Docker를 부르지 않는다.
  // 어떤 실패든 일반 실패 화면이 원인과 해결 줄을 그대로 보인다.
  return { state: "failed", detail: lines.join("\n"), logPath: input.logPathOf(failed.id) };
}
```

(e) `ServiceRow`에 `/** 실행 중인 내장 DB에 붙는 디버깅 접속 명령 (스펙 §6.3). 렌더러는 글자로만 넣는다. */ command?: string;`를, `ServicesInput`에 `externalDatabase?: boolean; configWarning?: string | null; debugCommand?: string | null;`를 더한다.

(f) `servicesView`를 바꾼다:

```ts
export function servicesView(input: ServicesInput): ServicesView {
  const notices = [
    ...(input.statuses === null ? [NO_SERVICES_YET] : []),
    ...(input.restartNotice === null ? [] : [input.restartNotice]),
    ...(input.configWarning === undefined || input.configWarning === null ? [] : [input.configWarning]),
  ];
  const external = input.externalDatabase === true;
  const rows = (input.statuses ?? []).map((s): ServiceRow => {
    const cause = causeOf(s);
    const debugDb = s.id === "postgres" && external;
    const notes = [
      ...(s.process === "running" && !s.owned ? [debugDb ? EXTERNAL_DATABASE_NOTE : "앱이 띄우지 않음"] : []),
      ...(s.restarts > 0 ? [`재시작 ${s.restarts}회`] : []),
    ];
    const row: ServiceRow = {
      id: s.id,
      name: SERVICE_LABELS[s.id],
      state: `${PROCESS_LABELS[s.process]}${s.health === "degraded" ? " · 동작 제한" : ""}`,
      tone: toneOf(s, cause),
      notes,
      log: input.logPathOf(s.id),
    };
    const hint = recoveryHint(s);
    if (cause !== undefined) row.cause = cause;
    if (hint !== undefined) row.hint = hint;
    if (s.id === "api" && s.process === "running" && input.migrationCheckSkipped === true) {
      row.warning = MIGRATION_CHECK_SKIPPED_WARNING;
      if (row.tone === "ok") row.tone = "warn";
    }
    if (debugDb && s.process === "running") {
      // 제품 경로가 아니다. 사용자가 Docker DB를 쓰고 있다는 사실을 상태 창이 치우지 않는다 (R3-14).
      row.warning = CAUSES.externalDatabase.text;
      row.tone = "warn";
    }
    if (s.id === "postgres" && !external && s.process === "running" && typeof input.debugCommand === "string") {
      row.command = input.debugCommand;
    }
    return row;
  });
  return { rows, notices };
}
```

- [ ] **Step 4: 셸 화면을 고친다**

`desktop/src/shell-window.ts`: `export type ShellState = "starting" | "quitting" | "failed";`.

`desktop/shell/status.html`: 상태 표에서 `"db-unreachable": [ … ],` 항목과 그 위의 주석 세 줄(52~54행, "앱이 `docker compose up -d`로 Postgres를 직접 띄운다…")을 지운다. 그 밖에 `db-unreachable`을 가리키는 코드가 있으면 함께 지운다(`grep -n "db-unreachable\|Docker" desktop/shell/status.html` → 0건이 될 때까지).

`desktop/shell/services.html`:

CSS의 `.warning::before` 규칙 뒤에 더한다:

```css
      .command { margin: 6px 0 0; font-size: 12px; }
      .command code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; user-select: all; }
```

`row(r)` 함수에서 `warning` 줄 뒤에 더한다:

```js
          if (typeof r.command === "string") {
            const p = el("p", "command", "디버깅 접속: ");
            p.append(el("code", "", r.command));
            item.append(p);
          }
```

- [ ] **Step 5: 테스트 통과·타입 검사**

Run: `pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint`
Expected: 전부 PASS, lint 0. `logIdOf`를 import하던 곳이 있으면 lint가 가리킨다 — 그 자리를 서비스 id로 바꾼다.

- [ ] **Step 6: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/status-view.ts desktop/src/shell-window.ts desktop/shell/status.html desktop/shell/services.html desktop/src/repo-root.ts desktop/src/shell-hints.ts desktop/src/main.ts desktop/tests/
git commit -F - <<'MSG'
feat(desktop): 상태 화면이 내장 DB의 디버깅 접속·외부 모드 배지·서버 로그를 보인다

앱이 Docker를 부르지 않으므로 db-unreachable 화면("Docker Desktop을 실행하세요")을 걷어내고
postgres 실패도 일반 실패 화면이 원인과 해결 줄을 보이게 했다. postgres 줄의 로그는 이제
감독자 로그가 아니라 postgres.log다.

외부 디버그 모드는 제품 경로가 아니라서 postgres 줄에 경고로 상시 남긴다. 실행 중인 내장 DB에는
psql 접속 명령을 글자로 싣는다. 저장소 폴더 표식에서 docker-compose.yml을 뺐다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 5 PASS, lint 0.
- `grep -rn "db-unreachable" desktop/src desktop/shell` → 0건.

**Review:**
- 외부 모드 경고가 postgres가 실행 중인 동안 **항상** 붙는가(원인 유무와 무관).
- `statusLine`을 `.map(statusLine)`처럼 함수 그대로 넘기는 곳이 남지 않았는가 — 두 번째 인자로 배열 index가 들어가 `externalDatabase` 자리를 차지한다(index 0은 거짓, 1 이상은 참).
- 디버깅 명령이 `textContent`로만 들어가는가(`innerHTML` 없음).
- 실패 화면이 postgres 실패에서 `logs/postgres.log`를 가리키는가.

---

## Task 12: main 배선 — Docker 경로 제거와 내장 DB 연결

스펙 §6.8 바이너리 해석, §6.7 자동 재시도, §6.1 모드별 서비스 선택. compose 어댑터와 Docker 원인을 지운다.

**Files:**
- Modify: `desktop/src/services/specs.ts`
- Modify: `desktop/src/main.ts`
- Delete: `desktop/src/services/postgres.ts`, `desktop/tests/postgres.test.ts`
- Modify: `desktop/src/causes.ts`, `desktop/src/shell-hints.ts` (Docker 원인 삭제)
- Modify(테스트): `desktop/tests/specs.test.ts`, `desktop/tests/config-reload.test.ts`, `desktop/tests/recovery-hint.test.ts`, `desktop/tests/status-view.test.ts`, `desktop/tests/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 4 `mayAutoRetry`; Task 5 `pgLayout`·`pgBinaries`·`pgToolEnv`·`DB_SUPERUSER`·`DB_NAME`; Task 6 `runTool`·`psInfo`·`spawnPostmaster`·`stopOrphanPostmaster`; Task 8 `embeddedPostgresSpec`·`externalPostgresSpec`·`PG_FAST_GRACE_MS`·`PG_IMMEDIATE_GRACE_MS`; Task 9 `runMigrationGate`·`devMigrationRunner`·`packagedMigrationRunner`; Task 10 `cfg.databaseMode`·`cfg.notes`; Task 11 `servicesView`/`shellStatusFrom`의 새 입력.
- Produces:
  - `specs.ts`: `interface SpecDeps { postgres: ServiceSpec; api: ApiDeps; embed: EmbedDeps; worker: WorkerDeps }` — postgres는 main이 모드에 따라 만든 spec을 그대로 넘긴다.
  - main.ts: `pgBundleDir()`(packaged `process.resourcesPath/postgres`, dev `app.getAppPath()/build/postgres`), `debugCommand()`.

- [ ] **Step 1: `specs.ts`와 그 테스트를 바꾼다**

`desktop/src/services/specs.ts`:

```ts
import { apiSpec, type ApiDeps } from "./api";
import { embedSpec, type EmbedDeps } from "./embed";
import { workerSpec, type WorkerDeps } from "./worker";
import type { ServiceSpec } from "./types";

export interface SpecDeps {
  /**
   * 모드가 고른 postgres spec — 내장(embeddedPostgresSpec) 또는 외부 디버그(externalPostgresSpec). main.ts가 감독자를
   * 만들 때 한 번 고른다 (Phase 3 스펙 §6.1). 이 배열의 판정(종료 순서·게이트 집합)은 어느 쪽이든 같다.
   */
  postgres: ServiceSpec;
  api: ApiDeps;
  embed: EmbedDeps;
  worker: WorkerDeps;
}
```

`buildSpecs`의 본문 첫 줄을 `deps.postgres,`로 바꾸고(나머지 주석은 그대로), 주석 중 "postgresSpec.stop()은 의도적으로 아무것도 하지 않는다 — 컨테이너는 앱의 소유가 아니다"를 "postgres는 마지막이다 — 내장 모드면 클라이언트가 모두 내려간 뒤 fast 종료로 끝난다"로 고친다.

`desktop/tests/specs.test.ts`의 `fakes`에서 `docker:` 줄을 `postgres: externalPostgresSpec(),`로 바꾸고 import에 `import { externalPostgresSpec } from "../src/services/pg-service";`를 더한다. 파일 끝에 더한다:

```ts
  it("keeps the same order and gates with the embedded postgres", () => {
    const embedded = { ...fakes, postgres: { ...externalPostgresSpec(), restart: { maxAttempts: 3, backoffMs: [1] } } as never };
    expect([...orderOf(buildSpecs(embedded))].reverse().map((s) => s.id)).toEqual(["worker", "embed", "api", "postgres"]);
  });
```

`desktop/tests/config-reload.test.ts`의 `specFakes`에서도 `docker:` 줄을 `postgres: externalPostgresSpec(),`로 바꾸고 같은 import를 더한다.

- [ ] **Step 2: compose 어댑터와 Docker 원인을 지운다**

```bash
cd /Users/gim-yeongjae/project/daewha
git rm desktop/src/services/postgres.ts desktop/tests/postgres.test.ts
```

`desktop/src/causes.ts`에서 `dockerDaemonDown`·`dockerMissing` 항목을 지운다. `spawnNotFound`의 주석에서 "main.ts의 dockerRun이 … (postgres)" 문장을 지운다. `selfRecovers`의 주석에서 Docker 예시를 "부팅 뒤 데이터베이스가 종료 중(pgStopping)으로 degraded가 된 postgres"로 바꾼다.

`desktop/src/shell-hints.ts`:

```ts
const INSTALL_OR_CONFIGURE = "설치했는지 확인하거나, config.json의 UV_BIN에 경로를 적어 주세요.";
```

`HINTS`에서 `dockerDaemonDown`·`dockerMissing` 줄을 지우고 `spawnNotFound`를 `{ worker: INSTALL_OR_CONFIGURE, embed: INSTALL_OR_CONFIGURE },`로 바꾼다(주석의 "docker를 부르는 것은 postgres다"도 지운다). `recoveryHint`의 주석에서 Docker 예시를 지운다.

`desktop/tests/recovery-hint.test.ts`:
- import에서 `postgresSpec`을 지운다.
- `it("tells the user to start Docker", …)`를 지운다.
- `스펙 §6.12의 표` `rows`에서 `dockerDaemonDown`·`dockerMissing` 두 행을 지운다.
- `실제 어댑터가 낸 원인에서` describe의 `postgres: Docker daemon down (compose up -d)`, `postgres: Docker Desktop quit after boot …`, `postgres: \`docker compose stop postgres\` leaves the container exited …` 세 테스트와 `describe("recoveryHint — DOCKER_BIN이 가리키는 곳에 파일이 없을 때")` 전체를 지운다.
- 그 자리(`실제 어댑터가 낸 원인에서` describe 안)에 내장 어댑터가 낸 원인으로 같은 성질을 다시 건다:

```ts
  it("postgres: a pairing refusal from the real adapter gets its fix, and says the app changed nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dw-rh-"));
    try {
      const layout = pgLayout(path.join(root, "ud"));
      const bundle = path.join(root, "bundle");
      fs.mkdirSync(path.join(bundle, "bin"), { recursive: true });
      for (const n of PG_BINARY_NAMES) {
        fs.writeFileSync(path.join(bundle, "bin", n), "");
        fs.chmodSync(path.join(bundle, "bin", n), 0o755);
      }
      fs.mkdirSync(path.join(layout.storage, "meetings", "mtg_37"), { recursive: true });
      fs.writeFileSync(path.join(layout.storage, "meetings", "mtg_37", "original.m4a"), "x");
      const spec = embeddedPostgresSpec({
        binaries: pgBinaries(bundle),
        layout,
        runTool: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false }),
        psInfo: async () => null,
        spawnPostmaster: () => {
          throw new Error("스폰까지 오면 안 된다");
        },
        stopOrphan: async () => "fast",
        log: () => undefined,
      });
      const detail = await spec.launch({ ...ctx(), userData: layout.userData }).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(recoveryHint(s({ id: "postgres", detail }))).toBe(HINTS.pgPairingRefused);
      expect(HINTS.pgPairingRefused).toMatch(/아무것도 지우거나 새로 만들지 않았어요/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("postgres: a database that is stopping is degraded and does not claim to recover on its own", () => {
    expect(recoveryHint(s({ id: "postgres", process: "running", health: "degraded", detail: CAUSES.pgStopping.text }))).toBeUndefined();
  });
```

(이 describe의 기존 `ctx()` 헬퍼를 쓴다. import에 `embeddedPostgresSpec`(`../src/services/pg-service`), `pgBinaries`·`pgLayout`·`PG_BINARY_NAMES`(`../src/services/pg-layout`)를 더한다. 파일 맨 위에 `fs`·`os`·`path`가 이미 import돼 있다.)

`desktop/tests/status-view.test.ts`의 `P2-C8: docker not found before the supervisor exists …` 테스트를 지운다. `desktop/tests/supervisor.test.ts`의 667·709·721·733행 주석과 문자열에 남은 docker 예시(`spawn /nowhere/docker ENOENT`)는 동작과 무관한 샘플이므로 `spawn /nowhere/postgres ENOENT`와 "postgres의 readiness는 postmaster.pid를 읽는다"로 바꾼다.

- [ ] **Step 3: `main.ts`를 배선한다**

(a) import를 정리한다. 지운다: `dockerRun` 함수 전체(707~722행). 더한다:

```ts
import { mayAutoRetry } from "./retry-policy";
import { packagedMigrationRunner } from "./migrate-process";
import { devMigrationRunner, runMigrationGate } from "./services/migration-gate";
import { DB_NAME, DB_SUPERUSER, pgBinaries, pgLayout } from "./services/pg-layout";
import { psInfo, spawnPostmaster, stopOrphanPostmaster } from "./services/pg-handle";
import { embeddedPostgresSpec, externalPostgresSpec, PG_FAST_GRACE_MS, PG_IMMEDIATE_GRACE_MS } from "./services/pg-service";
import { runTool } from "./services/tool-runner";
```

(b) 모듈 전역에 설정 경고를 든다(`restartNotice` 선언 옆):

```ts
/** config.json이 말했지만 앱이 쓰지 않은 값의 경고(loadConfig의 warning). 화면과 상태 창의 안내 줄에 남긴다. */
let configWarning: string | null = null;
```

(c) 번들 경로와 디버그 명령:

```ts
/** 번들 PostgreSQL 트리. packaged는 Resources, dev는 build-postgres.sh가 스테이징한 자리다 (Phase 3 스펙 §6.8). */
function pgBundleDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "postgres") : path.join(app.getAppPath(), "build", "postgres");
}

/** 상태 창의 postgres 줄에 싣는 디버깅 접속 명령 (스펙 §6.3). 번들 psql을 쓴다 — Homebrew psql이 없는 맥이다. */
function debugCommand(): string {
  const layout = pgLayout(app.getPath("userData"));
  return `"${pgBinaries(pgBundleDir()).psql}" -h "${layout.runDir}" -U ${DB_SUPERUSER} ${DB_NAME}`;
}

function currentDatabaseMode(): DatabaseMode | null {
  return launchCtx?.mode ?? null;
}
```

(d) `shellStatusOf`와 `servicesViewNow`에 새 입력을 넘긴다:

```ts
function shellStatusOf(): ShellStatus {
  return shellStatusFrom({
    statuses: supervisor?.statuses() ?? [],
    restartNotice,
    configWarning,
    externalDatabase: currentDatabaseMode()?.kind === "external",
    logPathOf,
  });
}

function servicesViewNow() {
  const mode = currentDatabaseMode();
  return servicesView({
    statuses: supervisor?.statuses() ?? null,
    restartNotice,
    configWarning,
    externalDatabase: mode?.kind === "external",
    debugCommand: mode?.kind === "embedded" ? debugCommand() : null,
    logPathOf,
    migrationCheckSkipped: migrationWatch.skippedFor(supervisor?.runtimeOf("api")?.result?.handle),
  });
}
```

(e) 자동 재시도가 부류를 본다. `startServices`의 게이트 분기:

```ts
  if (!gateUp(supervisor?.statuses() ?? null)) {
    const target = activeWindow(mine);
    if (target === null) return;
    // 사람 손이 필요한 실패면 타이머를 걸지 않는다 — 마이그레이션이 20초마다 재실행되고 백업이 쌓인다 (Phase 3 스펙 §6.7).
    const retryInSeconds = mayAutoRetry(supervisor?.statuses() ?? null) ? scheduleRetry() : undefined;
    await showShell(target, { ...shellStatusOf(), retryInSeconds });
    return;
  }
```

`reportFailure`:

```ts
async function reportFailure(mine: number, what: string, e: unknown): Promise<void> {
  appendSupervisorLog(`${what} — ${reasonOf(e)}`);
  const target = activeWindow(mine);
  if (target === null) return;
  const seconds = mayAutoRetry(null, e) ? scheduleRetry() : undefined;
  await showShell(target, {
    state: "failed",
    detail: failureDetail(what, reasonOf(e)),
    retryInSeconds: seconds,
    logPath: logPathOf("supervisor"),
  }).catch(() => undefined);
}
```

(f) `createSupervisorFor`를 바꾼다. Task 10이 넣은 `for (const note of cfg.notes) appendSupervisorLog(note);` 줄 바로 뒤에 `configWarning = cfg.warning ?? null;`를 더한다(`withoutDbKeys`·`DatabaseMode` import도 Task 10에서 이미 들어왔다).

`docker` 탐색 두 줄(`const docker = findExecutable("docker", dirs);`, `if (docker === null) throw …`)을 지운다. `rotateIfNeeded` 목록을 `["supervisor", "api", "worker", "embed", "postgres"] as const`로 바꾼다. `buildSpecs` 호출 앞에 모드별 postgres와 게이트를 만든다:

```ts
  const mode = cfg.databaseMode;
  const layout = pgLayout(userData);
  const binaries = pgBinaries(pgBundleDir());
  const postgres =
    mode.kind === "external"
      ? externalPostgresSpec()
      : embeddedPostgresSpec({
          binaries,
          layout,
          runTool,
          psInfo,
          spawnPostmaster: (logFile) => spawnPostmaster({ binaries, layout, logFile, immediateGraceMs: PG_IMMEDIATE_GRACE_MS }),
          stopOrphan: (pid) => stopOrphanPostmaster(pid, PG_FAST_GRACE_MS, PG_IMMEDIATE_GRACE_MS),
          log: appendSupervisorLog,
        });
  // 러너의 env는 API와 같다 — inheritedEnv 위에 자식 env. DATABASE_URL을 **항상** 싣는다: dev의 cwd(be/)에서 dotenv가
  // be/.env를 읽지만 이미 있는 값을 덮지 않는다 (스펙 §6.5-1).
  const runnerEnv = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
    return { ...out, ...ctx.env };
  };
  const migrationGate =
    mode.kind === "external"
      ? undefined
      : (signal: AbortSignal) =>
          runMigrationGate(
            {
              runner: app.isPackaged
                ? packagedMigrationRunner({ apiDir: path.join(process.resourcesPath, "api"), env: runnerEnv() })
                : devMigrationRunner({ repoRoot: resolved, env: runnerEnv(), runTool }),
              runTool,
              binaries,
              layout,
              log: appendSupervisorLog,
            },
            signal,
          );
```

`buildSpecs({ docker: …, api: {…}, … })`를 바꾼다:

```ts
  const created = createSupervisor(
    buildSpecs({
      postgres,
      api: {
        verifyOwnListener,
        isPortOccupied,
        onPendingMigrations: () => undefined,
        onMigrationCheckSkipped: (handle) => migrationWatch.skipped(handle),
        ...(migrationGate === undefined ? {} : { migrationGate }),
      },
      embed: { probe: (url) => probeEmbedContract(url, wantEmbed), freePort },
      worker: { listExternal: listExternalWorkers, stop: stopOwnWorker },
    }),
    ctx,
    { onStatus: renderStatus, log: appendSupervisorLog },
  );
```

`runnerEnv`는 `ctx`를 참조하므로 `ctx` 선언 **뒤**에 둔다. `launchCtx` 대입은 Task 10의 모양 그대로다.

(g) `createSupervisorFor`의 PORT 검증 실패 분기에서 `const seconds = scheduleRetry();`는 그대로 둔다(Phase 2 동작, 부류 없음).

(h) 953행 주석의 "postgresSpec은 docker 경로를 클로저로…" 문장을 "번들 경로와 모드도 감독자 생성 때 한 번 정해진다"로 고친다. 1036~1038행 주석의 "docker compose up -d와 detached 자식 둘"을 "postmaster와 detached 자식 둘"로 고친다.

- [ ] **Step 4: 남은 Docker 참조를 전수 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
grep -rn -i "docker" desktop/src desktop/shell desktop/tests | grep -v "desktop/tests/config.test.ts" 
```

Expected: 출력 0줄, 또는 남은 줄이 전부 **동작과 무관한 설명**(예: `config.test.ts`의 DOCKER_BIN 무시 테스트, 로드맵 인용)이다. 동작에 닿는 줄이 있으면 지운다.

- [ ] **Step 5: 테스트·타입 검사·dev 실행**

```bash
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
```

Expected: 전부 PASS, lint 0.

그다음 dev로 한 번 띄운다. **이 단계는 실제 userData(`~/Library/Application Support/Damwha`)에 `data/`를 처음 만든다** — 그 폴더에는 아직 아무 데이터도 없고 `storage/`(Phase 1·2)는 건드리지 않는다. 시작 전에 `storage/` 목록·체크섬과 `config.json`의 sha를 적어 둔다.

```bash
UD="$HOME/Library/Application Support/Damwha"
(cd "$UD" && find storage -type f -exec shasum -a 256 {} + | sort > /tmp/dwp3-t12-storage-before.txt; shasum -a 256 config.json > /tmp/dwp3-t12-config-before.txt)
cd /Users/gim-yeongjae/project/daewha
bash desktop/scripts/build-postgres.sh
pnpm --filter damwha-desktop run start:desktop
```

앱 창에서 상태 창(메뉴 → 서비스 → 서비스 상태)을 연다. 확인하고 ⌘Q 한다.

Expected:
- 데이터베이스·API·검색 임베딩·작업 처리기가 `실행 중`. 데이터베이스 줄에 `디버깅 접속: "…/desktop/build/postgres/bin/psql" -h "…/Damwha/run" -U damwha damwha`.
- `supervisor.log`에 `postgres: 새 클러스터를 만들었다`, `데이터베이스 damwha를 만들었다`, `마이그레이션 게이트: 24개 적용`.
- ⌘Q 뒤 `pgrep -fl "desktop/build/postgres/bin/postgres"` → 없음.
- `(cd "$UD" && find storage -type f -exec shasum -a 256 {} + | sort | diff - /tmp/dwp3-t12-storage-before.txt && shasum -a 256 config.json | diff - /tmp/dwp3-t12-config-before.txt) && echo 불변` → `불변`.

실패하면 `supervisor.log`·`postgres.log`·`logs/postgres/`의 해당 줄을 붙여 리뷰에 낸다.

- [ ] **Step 6: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add -A desktop/src desktop/tests desktop/shell
git commit -F - <<'MSG'
feat(desktop): 감독자가 Docker 대신 번들 PostgreSQL을 띄우고 마이그레이션 게이트를 건다

모드에 따라 postgres spec을 고른다 — 기본은 내장 클러스터, DEBUG_EXTERNAL_DATABASE_URL이면
아무것도 띄우지 않는 외부 디버그 spec. 내장 모드에서만 API 앞에 마이그레이션 게이트를 걸고,
러너는 packaged면 utilityProcess로 migrate.js, dev면 pnpm be:migrate와 같은 스크립트다.

자동 재시도는 실패의 부류를 본다. manual이면 타이머를 걸지 않고 사람이 다시 시도할 때까지
기다린다. compose 어댑터, dockerRun, Docker 원인과 안내, 그 테스트를 지웠다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 5 테스트 PASS, lint 0, dev 실행의 네 기대가 성립(로그 줄 첨부).
- Step 4의 grep 결과를 리뷰에 첨부.
- `git show --stat HEAD` → `services/postgres.ts`·`tests/postgres.test.ts` 삭제 포함.

**Review:**
- `scheduleRetry`를 부르는 **모든** 자리가 부류를 보거나, Phase 2 동작을 의도적으로 유지하는 자리(PORT 검증)인가.
- 외부 모드에서 `migrationGate`가 **없는가**. 내장 모드에서 러너 env에 `DATABASE_URL`이 있는가.
- `pgBundleDir()`가 dev에서 `desktop/build/postgres`를 가리키는가(`app.getAppPath()`는 dev에서 `desktop/`).
- `rotateIfNeeded`에 `postgres`가 있는가.
- dev 실행이 `<userData>/storage`와 `config.json`을 바꾸지 않았는가.

---

## Task 13: 패키징과 번들 위생 검사

스펙 §6.8 패키징·§6.9. `pnpm desktop:build`가 PG를 빌드(캐시)해 싣고, `check-bundle.mjs`가 PG 트리를 검사한다.

**Files:**
- Modify: `desktop/scripts/package.mjs`
- Modify: `desktop/scripts/check-bundle.mjs`
- Modify: `desktop/package.json`

**Interfaces:**
- Consumes: Task 1의 스크립트, Task 3 Step 6의 `codesign --deep` 실측(서명이 깨졌다면 이 Task에 재서명 단계를 더하도록 계획이 이미 고쳐졌다).
- Produces: `desktop/out/mac-arm64/Damwha.app/Contents/Resources/postgres/`, 위생 검사 항목 9~14.

- [ ] **Step 1: 패키징이 PG를 먼저 준비하게 한다**

`desktop/scripts/package.mjs`에서 desktop 컴파일 **앞**(`fs.rmSync(path.join(desktop, "dist"), …)` 줄 앞)에 넣는다:

```js
// 내장 PostgreSQL 트리를 desktop/build/postgres에 스테이징한다. extraResources(from: build)가 그대로 Resources/postgres로
// 싣는다 (Electron Phase 3 스펙 §6.8). 캐시가 있으면 복사만 한다. 번들 쪽 준비가 실패하면 여기서 멈춘다 — PG가 없는
// .app은 첫 실행에서야 "내장 데이터베이스 실행 파일이 없어요"로 드러난다.
run("bash", [path.join("scripts", "build-postgres.sh")], desktop);
```

`desktop/package.json`의 `start:desktop`을 바꾼다:

```json
    "start:desktop": "bash scripts/build-postgres.sh && pnpm run compile && electron .",
```

- [ ] **Step 2: 위생 검사를 더한다**

`desktop/scripts/check-bundle.mjs`에서 `if (failures.length > 0) {` 앞에 넣는다:

```js
// 9~14. 내장 PostgreSQL 트리 (Electron Phase 3 스펙 §6.9)
const pgDir = path.join(contents, "Resources", "postgres");
const pgBins = ["postgres", "initdb", "pg_controldata", "createdb", "psql", "pg_dump", "pg_restore"];
const missingBins = pgBins.filter((b) => {
  try {
    fs.accessSync(path.join(pgDir, "bin", b), fs.constants.X_OK);
    return false;
  } catch {
    return true;
  }
});
check("postgres tree has every binary the app calls", missingBins.length === 0, missingBins.join(", "));

const extFiles = ["lib/postgresql/vector.dylib", "lib/postgresql/pg_bigm.dylib", "share/postgresql/extension/vector.control", "share/postgresql/extension/pg_bigm.control"];
const missingExt = extFiles.filter((f) => !fs.existsSync(path.join(pgDir, f)));
check("postgres tree has pgvector and pg_bigm", missingExt.length === 0, missingExt.join(", "));

// 심볼릭 링크는 따라가지 않는다 — 같은 dylib을 두 번 센다.
const pgMachos = fs.existsSync(pgDir)
  ? execFileSync("find", [pgDir, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.length > 0)
      .filter((f) => spawnSync("file", ["-b", f], { encoding: "utf8" }).stdout.startsWith("Mach-O"))
  : [];
check("postgres tree has Mach-O files to check", pgMachos.length > 0, `${pgMachos.length}`);

const badDeps = [];
for (const f of pgMachos) {
  const out = spawnSync("otool", ["-L", f], { encoding: "utf8" }).stdout ?? "";
  for (const line of out.split("\n").slice(1)) {
    const dep = line.trim().replace(/ \(compatibility.*$/, "");
    if (dep === "") continue;
    if (!/^(@loader_path\/|@rpath\/|\/usr\/lib\/|\/System\/Library\/)/.test(dep)) badDeps.push(`${path.relative(pgDir, f)} -> ${dep}`);
  }
}
check("postgres Mach-O files depend only on the bundle and the system", badDeps.length === 0, badDeps.slice(0, 5).join("; "));

const unsigned = pgMachos.filter((f) => spawnSync("codesign", ["--verify", f], { encoding: "utf8" }).status !== 0);
check("postgres Mach-O files carry a valid signature", unsigned.length === 0, unsigned.slice(0, 5).map((f) => path.relative(pgDir, f)).join(", "));

// 서버만 보면 클라이언트가 전부 죽은 트리를 통과시킨다 (Phase 0 R-2b). env -i로 둘 다 부른다.
for (const bin of ["postgres", "psql"]) {
  const r = spawnSync("env", ["-i", path.join(pgDir, "bin", bin), "--version"], { encoding: "utf8" });
  check(`env -i ${bin} --version runs from the bundle`, r.status === 0, (r.stdout || r.stderr || "").trim());
}
```

(항목 4의 저장소 경로 grep은 `contents` 전체를 보므로 PG 트리도 이미 덮는다 — 추가하지 않는다.)

- [ ] **Step 3: 빌드하고 검사한다**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm desktop:build 2>&1 | tail -n 30
```

Expected: 마지막에 `Bundle hygiene: all checks passed.`, `PASS  postgres …` 여섯 줄과 `PASS  env -i … --version` 두 줄, 기존 13항목 PASS.

- [ ] **Step 4: 검사가 실제로 잡는지 확인한다 (변이)**

```bash
APP=/Users/gim-yeongjae/project/daewha/desktop/out/mac-arm64/Damwha.app/Contents/Resources/postgres
cp "$APP/bin/psql" /tmp/dwp3-psql.bak
DEP=$(otool -L "$APP/bin/psql" | awk '/libpq/{print $1}')
install_name_tool -change "$DEP" /opt/damwha-embedded-pg16/lib/libpq.5.dylib "$APP/bin/psql"
codesign -f -s - "$APP/bin/psql"
node /Users/gim-yeongjae/project/daewha/desktop/scripts/check-bundle.mjs 2>&1 | grep -E "FAIL|failed"
cp /tmp/dwp3-psql.bak "$APP/bin/psql" && rm /tmp/dwp3-psql.bak
```

Expected: `FAIL  postgres Mach-O files depend only on the bundle and the system`과 `FAIL  env -i psql --version runs from the bundle`, 그리고 앱 서명 항목(`codesign --verify --deep --strict`)이 실패할 수 있다. 되돌린 뒤 `pnpm desktop:build`를 다시 돌려 전부 PASS를 확인한다(되돌린 파일로는 앱 봉인이 맞지 않으므로 반드시 재빌드한다).

- [ ] **Step 5: 커밋한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs desktop/package.json
git commit -F - <<'MSG'
build(desktop): 패키징이 내장 PostgreSQL을 싣고 번들 위생 검사가 그 트리를 본다

package.mjs와 desktop:dev가 build-postgres.sh를 먼저 부른다(캐시가 있으면 복사만). 위생 검사는
일곱 바이너리와 두 확장, 모든 Mach-O의 의존이 번들·시스템뿐인지와 서명, 그리고 env -i로
postgres와 psql을 둘 다 실행하는지를 본다 — 서버만 보면 클라이언트가 죽은 트리를 통과시킨다.

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- Step 3 전부 PASS. Step 4 변이 FAIL 출력 첨부, 재빌드 뒤 전부 PASS.
- `pnpm build`(루트)가 `build-postgres.sh`를 부르지 않는다: `pnpm build 2>&1 | grep -c build-postgres` → 0.

**Review:**
- PG 준비가 electron-builder **앞**인가.
- 검사가 심볼릭 링크를 따라가지 않는가. `env -i`로 `psql`까지 부르는가.
- 루트 `pnpm build`·`pnpm dev`에 PG 빌드가 끼어들지 않는가.

---

## Task 14: 통합 검증과 결과 기록

스펙 §9의 P3-C1~C15(+C9b)를 packaged에서 판정하고, 결과 문서·로드맵·운영 문서를 갱신한다. **실데이터에 닿는 조작은 사용자에게 매번 직전에 확인받는다** — Docker Desktop 종료·기동, 임시 컨테이너, 검증 전용 마이그레이션을 넣은 빌드, 파괴적 검증의 격리 절차(`data/` 복사·되돌리기).

**Files:**
- Modify: `docs/superpowers/reports/2026-09-14-electron-phase-3-embedded-postgres-results.md` (§3·§4·§5)
- Modify: `docs/electron-migration-roadmap.md` (Phase 3 상태)
- Create: `desktop/CLAUDE.md`
- Modify: 루트 `CLAUDE.md` (모노레포 표에 `desktop/`)

**Interfaces:**
- Consumes: Task 1~13 전부.
- Produces: 판정표와 증거. 증거 파일은 저장소 밖 `~/.cache/damwha-p3-evidence/`에 둔다(Phase 2와 같다).

- [ ] **Step 1: 기준선을 뜬다 (P3-C14 전)**

```bash
E=~/.cache/damwha-p3-evidence; mkdir -p "$E"
UD="$HOME/Library/Application Support/Damwha"
cd /Users/gim-yeongjae/project/daewha
find be/storage -type f -exec shasum -a 256 {} + | sort > "$E/be-storage-before.txt"
(cd "$UD" && find storage -type f -exec shasum -a 256 {} + | sort) > "$E/ud-storage-before.txt"
shasum -a 256 "$UD/config.json" > "$E/config-before.txt"
docker volume inspect damwha_pgdata --format '{{.CreatedAt}}' > "$E/volume-before.txt"
docker inspect damwha-postgres --format '{{.Created}}' > "$E/container-before.txt"
docker exec damwha-postgres psql -U postgres -d damwha -Atc "select (select count(*) from meeting), (select count(*) from utterance), (select count(*) from _migrations)" > "$E/dockerdb-before.txt"
ls -la "$UD" > "$E/ud-before.txt"
```

Task 12 Step 5의 dev 실행이 이미 `data/`를 만들었다. **P3-C1은 "기존 userData 위의 첫 실행"을 판정해야 하므로**, 사용자 확인 뒤 앱을 끄고 그 `data/`·`run/`·`backups/`를 `~/.cache/damwha-p3-evidence/t12-dev-data/`로 옮긴다(Task 12의 dev 검증이 만든 것이고 실데이터가 아니다).

- [ ] **Step 2: P3-C12 — 번들 위생**

`pnpm desktop:build` → 전부 PASS(Task 13에서 확인한 변이 결과를 증거로 옮긴다).

- [ ] **Step 3: P3-C1 — Docker 없이 첫 실행·처리·검색**

사용자 확인 → Docker Desktop 완전 종료(`docker info` 실패 기록). Finder로 `desktop/out/mac-arm64/Damwha.app` 실행. 스펙 §9 P3-C1의 확인 방법·성공 판정을 그대로 수행하고, `pg_stat_activity` 조회는 상태 창의 디버깅 명령으로 한다. 증거: `supervisor.log` 발췌, `_migrations` 수, `pg_stat_activity` 출력, 업로드 파일 경로 목록, `ud-storage-after.txt` diff, `config.json` sha.

- [ ] **Step 4: P3-C2 · P3-C5 — 재시작과 종료**

⌘Q(0.5초 간격 프로세스 추적을 스펙 P3-C5의 창만큼) → 로그 확인 → 다시 실행 → 스펙 P3-C2 판정.

- [ ] **Step 5: P3-C3 · P3-C15 — 비정상 종료와 postmaster 사망**

P3-C3: 회의 제목 변경 → 앱 main pid에 `kill -9`(pid는 `pgrep -f "Damwha.app/Contents/MacOS/Damwha"`) → 번들 postgres 생존 기록 → 재실행 → 판정.
P3-C15: 네 서비스 준비 → postmaster pid(`sed -n 1p "$UD/data/postgres/postmaster.pid"`)에 `kill -9` → 60초 이상 관찰 → 판정. 재기동 거절(공유 메모리·락) 여부를 결과 문서 §4에 적는다.

- [ ] **Step 6: P3-C4 — 기존 PG와 공존**

사용자 확인 → Docker Desktop과 `damwha-postgres` 기동, `pnpm dev`·터미널 worker 없음 확인 → 스펙 P3-C4 절차. Docker DB에는 **읽기 조회만** 보낸다.

- [ ] **Step 7: P3-C6 · P3-C7 — 마이그레이션 백업·실패**

사용자 확인 → `be/src/database/migrations/900_p3_probe.sql`(`CREATE TABLE p3_probe(id int);`) 작성(커밋하지 않는다) → `pnpm desktop:build` → 실행 → P3-C6 판정 → `901_p3_broken.sql`(`ALTER TABLE p3_nope ADD COLUMN x int;`) 추가 → 재빌드 → 실행 → 2분 관찰 → P3-C7 판정 → 스펙의 정리 순서(실패 화면에서 psql로 `DELETE FROM _migrations WHERE name='900_p3_probe.sql'; DROP TABLE p3_probe;` → ⌘Q → 두 파일 삭제 → 재빌드 → 실행해 정상 진입). `git status --short be/src/database/migrations` → 빈 출력.

- [ ] **Step 8: P3-C8 · P3-C9 · P3-C9b · P3-C10 — 거부 (격리 절차 안)**

각 기준마다 스펙 §9 "파괴적 검증의 격리"를 따른다: 사용자 확인 → 앱 정지·번들 postgres 0개 확인 → `ditto "$UD/data" "$UD/data.p3-<기준>-backup"` → 기준 수행 → 앱 정지 → `mv "$UD/data" "$UD/data.p3-<기준>-after" && mv "$UD/data.p3-<기준>-backup" "$UD/data"` → 실행해 정상 진입·데이터 확인 → `rm -rf "$UD/data.p3-<기준>-after"`. P3-C9는 이름 바꾸기만 하므로 격리 없이 스펙 절차 그대로 한다.

- [ ] **Step 9: P3-C11 — 외부 디버그 모드**

사용자 확인 → Docker 기동 → `config.json`에 `DEBUG_EXTERNAL_DATABASE_URL`을 **사람이** 적는다(앱은 쓰지 않는다) → dev 실행(`pnpm desktop:dev`) → 스펙 P3-C11 판정 → 키 삭제(사람) → config.json sha가 기준선과 같은지 확인.

- [ ] **Step 10: P3-C13 — 회귀**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm install && pnpm build && pnpm test && pnpm lint && pnpm worker:test
docker build -f deploy/api.Dockerfile .
```

`pnpm dev` 웹 흐름(목록·전사·검색)을 사용자와 확인, Electron이 뜨지 않음을 확인. `pnpm desktop:dev`가 내장 PG로 네 서비스 `ok`.

- [ ] **Step 11: P3-C14 — 데이터 보존**

Step 1의 기준선을 다시 떠서 diff. P3-C11에서 앱 API가 Docker DB에 쓴 행이 있으면 적고 그 몫만 뺀다. `_migrations`는 정확히 같아야 한다.

- [ ] **Step 12: 운영 문서를 쓴다**

`desktop/CLAUDE.md`:

```markdown
# desktop/ — Damwha macOS 앱 (Electron)

Electron main이 네 서비스를 감독한다 — 번들 PostgreSQL, NestJS API(자식), worker·embed(`uv run`, Phase 4 전까지 저장소 체크아웃). 설계는 `docs/superpowers/specs/2026-09-1{1,2,4}-electron-phase-{1,2,3}-*-design.md`.

## 명령

```bash
pnpm desktop:dev     # build-postgres.sh(캐시) → tsc → electron .
pnpm desktop:build   # build-postgres.sh → be·fe build → pnpm deploy → electron-builder → ad-hoc 서명 → check-bundle
bash desktop/scripts/build-postgres.sh [--fresh]   # 내장 PG만. 캐시는 desktop/.cache/postgres (gitignore)
```

## 데이터 위치 — dev와 packaged가 **같은** 곳을 쓴다

`~/Library/Application Support/Damwha` (`main.ts`의 `app.setName("Damwha")`). 클러스터도 하나다.

| 경로 | 무엇 |
| --- | --- |
| `data/postgres/` | 내장 클러스터 (PGDATA) |
| `data/storage/` | 그 클러스터와 짝인 파일 저장소. `.damwha-cluster` 마커가 짝을 증명한다 — 지우거나 옮기면 앱이 기동을 거부한다 |
| `run/` | 소켓 디렉터리(0700). TCP는 열지 않는다 |
| `backups/` | 데이터가 있는 DB에 마이그레이션을 적용하기 전의 `pg_dump -Fc`, 최근 5개 |
| `logs/` | `supervisor.log`·`api.log`·`worker.log`·`embed.log`·`postgres.log`(초기 stderr), `postgres/`(서버 로그) |
| `storage/` | Phase 1·2가 Docker DB와 쓴 파일. 앱은 읽지도 쓰지도 않는다 (Phase 5가 옮긴다) |
| `config.json` | 사람이 고치는 설정. 앱은 다시 쓰지 않는다(`REPO_ROOT` 저장 제외) |

## 디버깅

- 내장 DB 접속: 상태 창(메뉴 → 서비스 → 서비스 상태)의 데이터베이스 줄에 명령이 있다 — `"<번들>/bin/psql" -h "<userData>/run" -U damwha damwha`.
- Docker 개발 DB에 붙여 재현: `config.json`에 `"DEBUG_EXTERNAL_DATABASE_URL": "postgres://postgres:postgres@localhost:5432/damwha"`. 내장 PG를 띄우지 않고, 마이그레이션은 **감지만** 하며, 상태 창에 `외부 DB(디버깅)`이 상시 뜬다. 모드 변경은 앱을 다시 켜야 반영된다.

## 지키는 것

- postmaster에는 SIGINT(fast)·SIGQUIT(immediate)만. `pg-handle.ts`의 신호 타입이 SIGKILL을 막는다.
- 앱이 지우는 것은 넷뿐 — `data/postgres.initdb-*`, 증명한 낡은 락, 5개 초과 백업, `*.dump.partial`.
- 마이그레이션 실패·페어링 거부 같은 `manual` 실패는 자동 재시도하지 않는다(`retry-policy.ts`).
- `desktop/package.json`의 `dependencies`는 비어 있다(번들 위생). DB에는 번들 `psql`·`pg_controldata`와 `migrate.js`로만 묻는다.
```

루트 `CLAUDE.md`의 "Monorepo map" 표에 `be/worker/` 행 뒤에 한 행을 더한다:

```markdown
| `desktop/` | `damwha-desktop` | Electron macOS 앱 — 번들 PostgreSQL·API·worker·embed를 감독한다. Read [`desktop/CLAUDE.md`](desktop/CLAUDE.md). |
```

- [ ] **Step 13: 결과 문서와 로드맵을 채운다**

결과 문서:
- §2 계획 검증 — 이 계획의 검증 기록(메인 세션이 계획 확정 전에 채운다 — 이미 채워져 있으면 그대로).
- §3 — Task별 커밋 범위·수정 라운드·리뷰가 잡은 결함·변이 증거(Phase 2 결과 §3의 표 모양).
- §4 — P3-C1~C15·C9b 판정표(기준 / 판정 / 빌드 커밋 / 증거). 실행하지 않은 기준은 "미실행"으로 적는다.
- §5 — 남은 제약(단위 테스트로만 판정한 항목 포함)과 Phase 4·5·6 인계(스펙 §15를 실제 결과로 갱신), Task 3의 C 로캘 판정.

로드맵 `docs/electron-migration-roadmap.md`:
- 머리말 상태 줄에 Phase 3 완료 문장을 더한다(Phase 2와 같은 모양).
- "Phase 3. PostgreSQL 내장" 절 끝에 상태 단락과 완료 기준 3개 판정표(근거와 남은 것)를 더한다.

```bash
cd /Users/gim-yeongjae/project/daewha
git add docs/ desktop/CLAUDE.md CLAUDE.md
git commit -F - <<'MSG'
docs: Electron Phase 3 통합 검증 결과·로드맵·desktop 운영 문서를 기록한다

Claude-Session: https://claude.ai/code/session_012Zc2UfXdtuDvbtRu9sK1TR
MSG
```

**Verify:**
- 결과 문서 §4에 16개 기준 각각의 판정과 증거 경로가 있다. 실행하지 않은 것이 성공으로 적히지 않았다.
- `git status --short` → 추적 대상 변경 없음. `be/src/database/migrations/`에 `9xx_p3_*` 파일이 없다.
- `pgrep -fl "bin/postgres -D"` → 검증에서 띄운 번들 postgres 0개. `docker ps -a --filter name=dw-p3` → 비어 있다.

**Review:**
- 각 기준이 스펙 §9의 **확인 방법 그대로** 수행됐는가(바꾼 곳이 있으면 이유가 적혔는가).
- 파괴적 검증이 전부 격리 절차 안에서 했고 `data/`가 원래대로 돌아왔는가.
- P3-C14의 diff가 0이거나, 차이가 P3-C11의 기록된 행뿐인가.
- 로드맵과 결과 문서의 문장이 증거와 어긋나지 않는가.

---

## 자기 검토 (계획 작성자)

### 스펙 대응

| 스펙 | 만드는 Task | 판정 |
| --- | --- | --- |
| §6.1 배치·모드·옛 키 | 5(배치), 10(모드·옛 키), 11(배지·경고), 12(모드별 선택) | P3-C1, C11, 단위 |
| §6.2 페어링 판정표 1·2 | 5(판정), 8(적용) | P3-C9, C9b, C10, 단위(전 행) |
| §6.3 소켓 전용·`DATABASE_URL`·103바이트·디버그 명령 | 5, 6(`postmasterArgs`), 11·12(명령) | P3-C4, 단위 |
| §6.4 기동(고아·낡은 락·initdb·스폰) | 6, 8 | P3-C1, C3, 통합 테스트 |
| §6.4 준비 판정·판정표 2·createdb | 8 | P3-C1, C2, 통합 테스트 |
| §6.4 기동 중단 | 4(signal), 6(실행기), 8·9(전달) | 단위 |
| §6.4 재시작 | 8(정책), 4(manual이면 안 함) | P3-C15 |
| §6.4 종료·핸들 | 6, 8 | P3-C5, 단위 |
| §6.5 상태·unknown·백업·실행·안전망·advisory lock | 2, 9 | P3-C6, C7, C8, 단위 |
| §6.6 설정·env·모드 비교 | 10 | 단위, P3-C11 |
| §6.7 원인·안내·복구 부류·자동 재시도 | 4, 7, 12 | P3-C7, C9, 단위 |
| §6.8 빌드·캐시·스테이징·패키징·바이너리 해석 | 1, 12, 13 | P3-C12, C13 |
| §6.9 위생 검사 | 13 | P3-C12 |
| §5 데이터 안전(삭제 넷·거부는 무변경) | 8, 9(삭제 규칙), 14(대조) | P3-C14 |
| §9 완료 기준 16개 | 14 | — |
| §12 미확정 | 3(실측), 계획 작성 중 실측 2건 | 결과 문서 §2.4 |
| §16 산출물 | 1~14 | — |

### 형식과 일관성 점검

- 14개 Task 전부에 `Files`·`Interfaces`·Steps·`Verify`·`Review`가 있다.
- 자리표시(`TBD`·"적절히"·"나중에") 0건. 코드 단계는 전부 코드 블록을 갖는다.
- 이름 대조: `ServiceFailure`·`recoveryOf`·`manualUnlessTagged`(4) → 8·9에서 같은 이름. `pgLayout`·`pgBinaries`·`pgToolEnv`·`embeddedDatabaseUrl`(5) → 6·8·9·10·12. `ProcessInfo`는 `pg-pidfile.ts`(5)에 있고 6·8이 거기서 가져온다. `runTool`·`toolOk`·`describeToolFailure`(6) → 8·9·12. `embeddedPostgresSpec`·`externalPostgresSpec`·`PG_FAST_GRACE_MS`·`PG_IMMEDIATE_GRACE_MS`(8) → 12. `runMigrationGate`·`devMigrationRunner`(9)·`packagedMigrationRunner`(9) → 12. `DatabaseMode`·`withoutDbKeys`·`notes`·`databaseMode`(10) → 12. `CAUSES` 새 키 18개(7) → 8·9·11.
- Task 순서가 매 Task 끝에서 `pnpm --filter damwha-desktop run test`·`lint`를 초록으로 둔다: compose 어댑터와 Docker 원인은 모든 소비자가 바뀌는 Task 12에서 한꺼번에 지운다.

### 알려진 한계

- `migrate-process.ts`(utilityProcess 러너)와 `main.ts` 배선은 vitest가 부를 수 없다(electron import). packaged 검증(Task 14 P3-C1·C6·C7)이 판정한다.
- 마커를 rename **전에** 쓰는 순서는 단위 테스트로 관찰할 수 없다. 틀렸을 때 생기는 상태를 판정표 1이 거부한다는 것만 테스트가 지키고, 순서 자체는 Task 8 리뷰가 읽는다.
- Task 2 Step 5의 겹친 러너 변이는 경쟁이라 재현이 보장되지 않는다. 재현되지 않으면 그 사실을 기록한다.
