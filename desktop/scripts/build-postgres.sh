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
