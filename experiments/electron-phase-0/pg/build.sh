#!/bin/bash
# Task 2 — PostgreSQL 16 + pgvector + pg_bigm 번들 후보를 구성한다 (스펙 P0-C1, §9).
#
#   build.sh [--fresh]
#
# 후보 선택 근거와 탈락시킨 후보는 pg/README.md에 있다. 여기서는 **어떻게**
# 만드는지와, 재배치에서 무엇이 깨져 무엇으로 고쳤는지를 코드로 고정한다.
#
# 이 스크립트 자신은 격리 대상이 아니다 (스펙 §4.0 — 빌드 도구는 피검사 대상이
# 아니라 산출물을 만드는 수단이다). 격리 대상은 여기서 만든 산출물과 그것을
# 실행하는 프로세스이고, 그쪽은 pg/run.sh가 run-isolated.sh를 통해 돈다.
#
# ## 핵심 설계: 빌드 시점 prefix와 최종 경로를 **일부러 다르게** 둔다
#
# configure --prefix에 최종 경로를 넣으면 "재배치가 되는가"를 한 번도 묻지
# 않은 채로 통과한다. 그래서 중립 prefix($BUILD_PREFIX, 이 머신에 존재하지
# 않는 경로)로 빌드해 DESTDIR로 스테이징하고, 그 트리를 bundle/pg로 **옮긴
# 뒤에** 실행 검증을 한다. 이렇게 하면 R-1(pg_config 절대 경로)과 R-2(initdb
# 시점 경로 가정)가 실제로 드러난다.
#
# 단계마다 G1(check-macho.sh)을 돌려 증거에 남긴다 — 이동 직전/직후를 갈라
# 기록해야 "무엇이 이동 때문에 깨졌는지"가 증거로 남는다.
#
# ## 이동 뒤에 실제로 깨진 것 (측정 결과. 자세한 값은 증거 파일에)
#
# PostgreSQL은 macOS에서 공유 라이브러리의 install_name에 **빌드 시점 libdir의
# 절대 경로**를 박는다(src/Makefile.shlib의 -install_name $(libdir)/...). 그래서
# 이동 후 bin/psql 같은 클라이언트가 dyld 단계에서 죽는다:
#   dyld: Library not loaded: $BUILD_PREFIX/lib/libpq.5.dylib
# 서버(postgres)는 libpq를 링크하지 않아 기동 자체는 되지만, 같은 종류의
# 경로가 otool -L에 남아 G1 위반이 된다.
#
# 반대로 **파일 경로 해석은 깨지지 않았다.** PostgreSQL은 실행 파일 자신의
# 위치에서 share/lib 경로를 다시 계산하기 때문이다(src/port/path.c의
# make_relative_path). 컴파일 시점 문자열($BUILD_PREFIX)이 바이너리에 남아
# 있어도 런타임 경로는 번들 안을 가리킨다 — 그것을 P0-C8 자기 보고로 확인한다.
#
# 고친 방법(아래 step_relocate_fix): 이동한 트리에서 Mach-O를 전수 조사해
#   - $BUILD_PREFIX/lib/X 의존을 @loader_path 상대 경로로 바꾸고
#   - dylib의 install_name(-id)을 @rpath/X로 바꾸고
#   - $BUILD_PREFIX를 가리키는 LC_RPATH를 지우고
#   - 수정된 Mach-O를 ad-hoc으로 다시 서명한다 (install_name_tool이 기존
#     서명을 무효화하는데, arm64에서는 서명 없는 바이너리가 실행되지 않는다)
# 새 경로 문자열이 옛 경로보다 짧아서 로드 커맨드 공간 문제가 없다.
#
# ## 번들에서 뺀 것 (빌드 전용 산출물)
#
# lib/pgxs, include/, lib/pkgconfig, lib/*.a는 **확장을 빌드할 때만** 필요하고
# 앱 실행에는 쓰이지 않는다. 남겨 두면 재배치와 무관한 빌드 기록이 G1 위반으로
# 잡힌다 — lib/pgxs/src/Makefile.global에는 빌드 트리 절대 경로(abs_top_srcdir)가
# 들어 있다. 지우기 전/후 G1 출력을 둘 다 증거에 남겨 "무엇을 왜 뺐는지"가
# 검증 가능하게 한다. Phase 3의 실제 앱도 확장을 앱 안에서 빌드하지 않는다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

PG_VERSION=16.15
PGVECTOR_VERSION=0.8.6
PG_BIGM_VERSION=1.2-20240606

# 이 머신에 존재하지 않는 중립 prefix. 재배치가 실제로 일어나게 하는 장치다.
# /opt/homebrew가 아니고 /usr/local도 아니므로 G1 금지 문자열에 걸리지 않는다.
BUILD_PREFIX=/opt/damwha-phase0/pg16

DL="$EXP_ROOT/downloads"
SRC="$EXP_ROOT/stage/src"
STAGE="$EXP_ROOT/stage/pg"
DESTDIR="$EXP_ROOT/stage/destdir"
BUNDLE_PARENT="$EXP_ROOT/bundle"
BUNDLE="$BUNDLE_PARENT/pg"
CHECK="$EXP_LIB_DIR/check-macho.sh"
LOG="$EVIDENCE/t2-build-relocation.txt"

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "")      ;;
  *)       echo "usage: build.sh [--fresh]" >&2; exit 2 ;;
esac

for t in curl tar make cc otool install_name_tool codesign shasum; do
  command -v "$t" >/dev/null 2>&1 || exp_die "$t 가 없다 (Command Line Tools 필요)"
done

exp_ensure_sandbox
mkdir -p "$DL" "$SRC" "$BUNDLE_PARENT"

# 실행 중인 실험 서버가 있으면 번들을 갈아엎지 않는다 (스펙 §4.4).
if exp_pid_alive pg; then
  exp_die "실험 PostgreSQL이 살아 있다 (pid $(cat "$(exp_pid_file pg)")) — pg/run.sh stop 을 먼저 부른다"
fi

if [ "$FRESH" = 1 ]; then
  echo "--fresh: stage/ 와 bundle/pg 를 지운다 (sandbox/pgdata는 건드리지 않는다)"
  rm -rf "$EXP_ROOT/stage" "$BUNDLE"
  mkdir -p "$SRC" "$BUNDLE_PARENT"
fi

if [ -x "$BUNDLE/bin/postgres" ] && [ "$FRESH" = 0 ]; then
  echo "이미 구성돼 있다: $BUNDLE (다시 만들려면 --fresh)"
  "$BUNDLE/bin/postgres" --version
  exit 0
fi

say() { echo; echo "== $*"; }
log() { tee -a "$LOG"; }

# 스펙 §6: 증거는 회차마다 새 파일이며 덮어쓰지 않는다. 뒤 Task와 결과 문서가
# 고정 이름을 참조하므로 최신 회차를 고정 이름에 두고 이전 회차를 옆으로 옮긴다.
if [ -f "$LOG" ]; then
  mv "$LOG" "${LOG%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
fi
{
  echo "# Task 2 — PostgreSQL 번들 구성과 재배치 실측 (스펙 P0-C1 / R-1 / R-2)"
  echo "# 이 파일은 pg/build.sh가 생성한다. 손으로 고치지 않는다."
  echo "utc               : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "격리 대상         : 아니오 — 빌드는 산출물을 만드는 수단이다 (스펙 §4.0)"
  echo "PostgreSQL        : $PG_VERSION (개발 이미지 damwha/postgres-bigm:pg16의 PG_VERSION=16.15와 같은 계열)"
  echo "pgvector          : $PGVECTOR_VERSION"
  echo "pg_bigm           : $PG_BIGM_VERSION (be/docker/postgres-bigm/Dockerfile과 같은 버전)"
  echo "빌드 시점 prefix  : $BUILD_PREFIX  (이 머신에 존재하지 않는 중립 경로)"
  echo "스테이징          : $STAGE"
  echo "최종 번들         : $BUNDLE"
} > "$LOG"

# ---------------------------------------------------------------------------
# 1. 내려받기 + 체크섬
# ---------------------------------------------------------------------------
say "1. 소스 내려받기"
fetch() {
  local url="$1" out="$2"
  if [ -f "$DL/$out" ]; then
    echo "  이미 있음: $out"
  else
    echo "  받는다: $url"
    curl -fsSL -o "$DL/$out.part" "$url" || exp_die "내려받기 실패: $url"
    mv "$DL/$out.part" "$DL/$out"
  fi
}
fetch "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2" "postgresql-$PG_VERSION.tar.bz2"
fetch "https://github.com/pgvector/pgvector/archive/refs/tags/v$PGVECTOR_VERSION.tar.gz"  "pgvector-$PGVECTOR_VERSION.tar.gz"
fetch "https://github.com/pgbigm/pg_bigm/archive/refs/tags/v$PG_BIGM_VERSION.tar.gz"      "pg_bigm-$PG_BIGM_VERSION.tar.gz"

SUMS="$EXP_ROOT/pg/checksums.txt"
[ -f "$SUMS" ] || exp_die "체크섬 파일이 없다: $SUMS"
( cd "$DL" && grep -v '^[[:space:]]*#' "$SUMS" | grep -v '^[[:space:]]*$' | shasum -a 256 -c - ) \
  || exp_die "내려받은 아카이브의 체크섬이 다르다"
{ echo; echo "## 1. 아카이브 체크섬 (pg/checksums.txt 대조 통과)"; \
  ( cd "$DL" && shasum -a 256 "postgresql-$PG_VERSION.tar.bz2" "pgvector-$PGVECTOR_VERSION.tar.gz" "pg_bigm-$PG_BIGM_VERSION.tar.gz" ); } >> "$LOG"

# ---------------------------------------------------------------------------
# 2. 풀기
# ---------------------------------------------------------------------------
say "2. 소스 풀기"
[ -d "$SRC/postgresql-$PG_VERSION" ]  || tar xjf "$DL/postgresql-$PG_VERSION.tar.bz2" -C "$SRC"
[ -d "$SRC/pgvector-$PGVECTOR_VERSION" ] || tar xzf "$DL/pgvector-$PGVECTOR_VERSION.tar.gz" -C "$SRC"
[ -d "$SRC/pg_bigm-$PG_BIGM_VERSION" ]   || tar xzf "$DL/pg_bigm-$PG_BIGM_VERSION.tar.gz" -C "$SRC"

# ---------------------------------------------------------------------------
# 3. PostgreSQL 빌드 + DESTDIR 설치
# ---------------------------------------------------------------------------
say "3. PostgreSQL $PG_VERSION 빌드"
# --without-icu     : ICU는 Homebrew에서 오고, 그러면 번들이 /opt/homebrew에
#                     묶인다. libc 로캘 제공자로 충분하다(initdb --locale=C).
# --without-readline: macOS에 readline이 없다. psql 줄 편집만 포기한다.
# --without-zlib    : pg_dump 압축만 쓰는데 이 실험에 필요 없다.
# PG_SYSROOT=<없는 경로>: src/tools/darwin_sysroot가 디렉터리가 아닌 값을
#   버리므로 CPPFLAGS/LDFLAGS에 -isysroot가 들어가지 않는다. 그대로 두면
#   /Library/Developer/CommandLineTools/... 가 pg_config와 Makefile.global에
#   문자열로 박혀 G1 금지 문자열(스펙 §4.1 행 7)에 걸린다. clang은 -isysroot
#   없이도 CLT SDK를 기본으로 찾으므로 빌드에는 지장이 없다.
BUILD_DIR="$SRC/postgresql-$PG_VERSION"
if [ ! -f "$BUILD_DIR/src/Makefile.global" ]; then
  ( cd "$BUILD_DIR" && PG_SYSROOT="/damwha-phase0-no-sysroot" ./configure \
      --prefix="$BUILD_PREFIX" \
      --without-icu --without-readline --without-zlib \
      > "$SRC/configure.out" 2>&1 ) || { tail -n 40 "$SRC/configure.out"; exp_die "configure 실패"; }
fi
grep -n '^PG_SYSROOT' "$BUILD_DIR/src/Makefile.global" | sed 's/^/  /'
( cd "$BUILD_DIR" && make -j"$(sysctl -n hw.ncpu)" > "$SRC/make.out" 2>&1 ) \
  || { tail -n 40 "$SRC/make.out"; exp_die "make 실패"; }

say "3b. DESTDIR로 스테이징"
rm -rf "$DESTDIR" "$STAGE"
( cd "$BUILD_DIR" && make install DESTDIR="$DESTDIR" > "$SRC/install.out" 2>&1 ) \
  || { tail -n 40 "$SRC/install.out"; exp_die "make install 실패"; }
mv "$DESTDIR$BUILD_PREFIX" "$STAGE"
rm -rf "$DESTDIR"
"$STAGE/bin/postgres" --version | sed 's/^/  /'

{
  echo
  echo "## 3. 빌드 구성"
  echo "configure 인자: --prefix=$BUILD_PREFIX --without-icu --without-readline --without-zlib"
  echo "PG_SYSROOT: 일부러 없는 경로를 줘 -isysroot가 박히지 않게 했다"
  grep -n '^PG_SYSROOT\|^CPPFLAGS\|^LDFLAGS ' "$BUILD_DIR/src/Makefile.global"
  echo "설치 직후 pg_config가 보고하는 경로 (스테이징 위치 기준으로 재계산된다):"
  "$STAGE/bin/pg_config" --bindir --libdir --pkglibdir --sharedir --configure 2>&1 | sed 's/^/  /'
} >> "$LOG"

# ---------------------------------------------------------------------------
# 4. 확장 2종 (PGXS — pg_config가 알려 주는 경로에 설치된다: R-1의 자리)
# ---------------------------------------------------------------------------
say "4. pgvector $PGVECTOR_VERSION / pg_bigm $PG_BIGM_VERSION 빌드"
PGC="$STAGE/bin/pg_config"
# PGXS는 pg_config가 알려 주는 **절대** include 경로(-I$STAGE/pg/include/...)로
# 컴파일한다. 서버 헤더의 인라인 함수 안에 있는 Assert의 __FILE__이 그 절대
# 경로 그대로 확장돼 vector.dylib에 문자열로 박힌다. 이동 전에는 검사 대상
# 안이라 INFO였다가 **이동한 뒤에 STALE-PATH 위반**이 된다 — 1차 시도에서
# 실제로 그랬고 그 기록이 $EVIDENCE/t2-relocation-attempt1.txt에 있다.
# R-1("pg_config 기준 절대 경로가 산출물에 박혀 재배치가 깨진다")의 두 번째
# 얼굴이다. -fmacro-prefix-map으로 __FILE__을 중립 prefix로 되돌린다. 코어
# postgres 바이너리가 애초에 갖는 형태와 같아진다.
XMAP="-fmacro-prefix-map=$STAGE=$BUILD_PREFIX"
# pgvector는 기본 CFLAGS에 -march=native를 넣는다. 배포 번들에 그대로 두면
# 빌드한 머신에서만 도는 바이너리가 되므로 OPTFLAGS=""로 끈다(pgvector README).
( cd "$SRC/pgvector-$PGVECTOR_VERSION" && make clean > /dev/null 2>&1; \
  cd "$SRC/pgvector-$PGVECTOR_VERSION" && make USE_PGXS=1 PG_CONFIG="$PGC" OPTFLAGS="" PG_CPPFLAGS="$XMAP" \
    > "$SRC/pgvector.out" 2>&1 && make USE_PGXS=1 PG_CONFIG="$PGC" install >> "$SRC/pgvector.out" 2>&1 ) \
  || { tail -n 30 "$SRC/pgvector.out"; exp_die "pgvector 빌드 실패"; }
( cd "$SRC/pg_bigm-$PG_BIGM_VERSION" && make clean > /dev/null 2>&1; \
  cd "$SRC/pg_bigm-$PG_BIGM_VERSION" && make USE_PGXS=1 PG_CONFIG="$PGC" PG_CPPFLAGS="$XMAP" \
    > "$SRC/pg_bigm.out" 2>&1 && make USE_PGXS=1 PG_CONFIG="$PGC" install >> "$SRC/pg_bigm.out" 2>&1 ) \
  || { tail -n 30 "$SRC/pg_bigm.out"; exp_die "pg_bigm 빌드 실패"; }
ls -1 "$STAGE/lib/postgresql/" | grep -E 'vector|bigm' | sed 's/^/  /'
{
  echo
  echo "## 4. 확장 설치 결과 (PGXS가 pg_config의 경로에 넣는다 — R-1의 자리)"
  ls -l "$STAGE/lib/postgresql/vector.dylib" "$STAGE/lib/postgresql/pg_bigm.dylib" 2>&1
  ls -1 "$STAGE/share/postgresql/extension/" | grep -E '^(vector|pg_bigm)' | tr '\n' ' '
  echo
} >> "$LOG"

# ---------------------------------------------------------------------------
# 5. G1 측정 A — 슬림화 전 스테이지
# ---------------------------------------------------------------------------
say "5. G1 측정 A — 슬림화 전 스테이지"
{
  echo
  echo "## 5. G1 측정 A — 슬림화 전 스테이지 ($STAGE)"
  echo "# 빌드 전용 산출물(lib/pgxs, include, lib/pkgconfig)이 아직 들어 있는 상태다."
  bash "$CHECK" "$STAGE" 2>&1
  echo "(check-macho.sh exit: $?)"
} >> "$LOG"

# ---------------------------------------------------------------------------
# 6. 슬림화 — 빌드 전용 산출물 제거
# ---------------------------------------------------------------------------
say "6. 빌드 전용 산출물 제거 (lib/postgresql/pgxs, include, lib/pkgconfig, lib/*.a)"
BEFORE_SZ=$(du -sk "$STAGE" | awk '{print $1}')
# **경로 주의:** PGXS는 lib/pgxs가 아니라 pkglibdir 아래에 설치된다. prefix에
# "postgres"/"pgsql"이 들어 있지 않으면 pkglibdir = prefix/lib/postgresql이므로
# 여기서는 lib/postgresql/pgxs다. 1차 시도가 lib/pgxs만 지우는 바람에
# Makefile.global이 번들에 남았고, 그 안의 /opt/homebrew/bin/openssl 같은
# configure 탐지 결과가 G1 금지 문자열로 잡혔다
# ($EVIDENCE/t2-relocation-attempt1.txt).
PKGLIBDIR=$("$STAGE/bin/pg_config" --pkglibdir)
rm -rf "$PKGLIBDIR/pgxs" "$STAGE/lib/pgxs" "$STAGE/include" "$STAGE/lib/pkgconfig"
rm -f "$STAGE"/lib/*.a
[ -d "$PKGLIBDIR/pgxs" ] && exp_die "pgxs를 지우지 못했다: $PKGLIBDIR/pgxs"
AFTER_SZ=$(du -sk "$STAGE" | awk '{print $1}')
{
  echo
  echo "## 6. 슬림화"
  echo "제거: lib/pgxs (Makefile.global에 빌드 트리 절대 경로가 들어 있다), include/, lib/pkgconfig/, lib/*.a"
  echo "이유: 확장 빌드 전용이며 앱 실행 경로가 아니다. Phase 3의 앱도 확장을 앱 안에서 빌드하지 않는다."
  echo "크기: ${BEFORE_SZ} KiB -> ${AFTER_SZ} KiB"
} >> "$LOG"

say "6b. G1 측정 B — 슬림화 후, 이동 전"
{
  echo
  echo "## 6b. G1 측정 B — 슬림화 후 / 이동 전 ($STAGE)"
  bash "$CHECK" "$STAGE" 2>&1
  echo "(check-macho.sh exit: $?)"
} >> "$LOG"

# ---------------------------------------------------------------------------
# 7. 재배치 — 여기서부터 모든 검증은 옮긴 경로에서 한다
# ---------------------------------------------------------------------------
say "7. 재배치: $STAGE -> $BUNDLE"
rm -rf "$BUNDLE"
mv "$STAGE" "$BUNDLE"

say "7b. 이동 직후 실측 (고치기 전)"
PSQL_BEFORE=$("$BUNDLE/bin/psql" --version 2>&1); PSQL_RC_BEFORE=$?
POSTGRES_BEFORE=$("$BUNDLE/bin/postgres" --version 2>&1); PG_RC_BEFORE=$?
{
  echo
  echo "## 7. 재배치 직후 (고치기 전) — R-1 / R-2가 드러나는 자리"
  echo "이동: $STAGE -> $BUNDLE"
  echo
  echo "### bin/psql 실행 (libpq를 링크하는 클라이언트)"
  echo "exit: $PSQL_RC_BEFORE"
  printf '%s\n' "$PSQL_BEFORE" | sed 's/^/  /'
  echo
  echo "### bin/postgres 실행 (libpq를 링크하지 않는 서버)"
  echo "exit: $PG_RC_BEFORE"
  printf '%s\n' "$POSTGRES_BEFORE" | sed 's/^/  /'
  echo
  echo "### 이동 후 pg_config가 보고하는 경로 (make_relative_path의 결과)"
  "$BUNDLE/bin/pg_config" --bindir --libdir --pkglibdir --sharedir 2>&1 | sed 's/^/  /'
  echo
  echo "### G1 측정 C — 이동 후 / 고치기 전 ($BUNDLE)"
  bash "$CHECK" "$BUNDLE" 2>&1
  echo "(check-macho.sh exit: $?)"
} >> "$LOG"

# ---------------------------------------------------------------------------
# 8. 사후 처리 — install_name_tool + ad-hoc 재서명
# ---------------------------------------------------------------------------
say "8. 재배치 사후 처리 (install_name_tool + codesign)"
FIXLOG=$(mktemp "${TMPDIR:-/tmp}/t2fix.XXXXXX")
machos() {
  find -L "$BUNDLE" -type f -print0 \
    | xargs -0 file -L 2>/dev/null | grep -a 'Mach-O' \
    | sed -e 's/:[[:space:]]*Mach-O.*$//' -e 's/ (for architecture [^)]*)$//' | sort -u
}
# 파일이 있는 디렉터리에서 번들 루트까지 거슬러 올라가는 ../ 열
up_prefix() {
  local rel="${1#$BUNDLE/}"
  rel=$(dirname "$rel")
  case "$rel" in .) echo "" ; return ;; esac
  echo "$rel" | awk -F/ '{s=""; for (i=1;i<=NF;i++) s = s "../"; print s}'
}
while IFS= read -r f; do
  [ -n "$f" ] || continue
  changed=0
  up=$(up_prefix "$f")
  # (a) dylib 자신의 install_name(-id)
  idline=$(otool -D "$f" 2>/dev/null | sed -n '2p')
  case "$idline" in
    "$BUILD_PREFIX"/*)
      install_name_tool -id "@rpath/$(basename "$idline")" "$f" 2>>"$FIXLOG" \
        && { echo "  ID     $f: $idline -> @rpath/$(basename "$idline")" | tee -a "$FIXLOG" >/dev/null; changed=1; }
      ;;
  esac
  # (b) 의존 경로
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    case "$dep" in
      "$BUILD_PREFIX"/*)
        leaf="${dep#$BUILD_PREFIX/}"
        new="@loader_path/$up$leaf"
        install_name_tool -change "$dep" "$new" "$f" 2>>"$FIXLOG" \
          && { echo "  CHANGE $f: $dep -> $new" >> "$FIXLOG"; changed=1; }
        ;;
    esac
  done <<EOT
$(otool -L "$f" 2>/dev/null | sed -n 's/^[[:space:]]\{1,\}\(.*\) (compatibility.*$/\1/p' | sort -u)
EOT
  # (c) 번들 밖을 가리키는 LC_RPATH
  while IFS= read -r rp; do
    [ -n "$rp" ] || continue
    case "$rp" in
      @*|"$BUNDLE"/*|/usr/lib*|/System/Library*) ;;
      *) install_name_tool -delete_rpath "$rp" "$f" 2>>"$FIXLOG" \
           && { echo "  RPATH- $f: $rp" >> "$FIXLOG"; changed=1; } ;;
    esac
  done <<EOT
$(otool -l "$f" 2>/dev/null | awk '/^ *cmd LC_RPATH/{r=1;next} r&&/^ *path /{print $2; r=0}' | sort -u)
EOT
  # (d) install_name_tool은 코드 서명을 무효화한다. arm64에서는 서명 없는
  #     Mach-O가 실행되지 않으므로 ad-hoc으로 다시 서명한다. ad-hoc 서명은
  #     플랫폼 바이너리로 만들지 않으므로 DYLD_* 실측도 그대로 살아 있다.
  if [ "$changed" = 1 ]; then
    codesign -f -s - "$f" 2>>"$FIXLOG" || echo "  SIGN!  $f 재서명 실패" >> "$FIXLOG"
  fi
done <<EOT
$(machos)
EOT
{
  echo
  echo "## 8. 사후 처리 (이 처리가 build.sh 안에 있어 재현 가능하다)"
  echo "install_name_tool로 고친 항목:"
  sed 's/^/  /' "$FIXLOG"
  echo "수정한 Mach-O는 codesign -f -s - 로 ad-hoc 재서명했다 (arm64 실행 조건)."
} >> "$LOG"
rm -f "$FIXLOG"

# ---------------------------------------------------------------------------
# 9. G1 측정 D — 최종
# ---------------------------------------------------------------------------
say "9. G1 측정 D — 최종 번들"
PSQL_AFTER=$("$BUNDLE/bin/psql" --version 2>&1); PSQL_RC_AFTER=$?
CHECK_OUT=$(bash "$CHECK" "$BUNDLE" 2>&1); CHECK_RC=$?
{
  echo
  echo "## 9. 사후 처리 후 최종 상태 ($BUNDLE)"
  echo "### bin/psql 실행"
  echo "exit: $PSQL_RC_AFTER"
  printf '%s\n' "$PSQL_AFTER" | sed 's/^/  /'
  echo
  echo "### G1 측정 D"
  printf '%s\n' "$CHECK_OUT"
  echo "(check-macho.sh exit: $CHECK_RC)"
  echo
  echo "### 번들 크기"
  du -sh "$BUNDLE" 2>/dev/null
} >> "$LOG"

printf '%s\n' "$CHECK_OUT" | tail -n 5
echo
echo "완료: $BUNDLE"
echo "증거: $LOG"
[ "$CHECK_RC" -eq 0 ] || exp_die "최종 번들이 G1을 통과하지 못했다 (위 목록 참조)"
[ "$PSQL_RC_AFTER" -eq 0 ] || exp_die "사후 처리 후에도 bin/psql이 실행되지 않는다"
exit 0
