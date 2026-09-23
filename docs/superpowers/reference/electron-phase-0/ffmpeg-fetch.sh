#!/bin/bash
# Task 4 — ffmpeg / ffprobe 번들 후보를 구성한다 (스펙 P0-C6, §9, R-8).
#
#   fetch.sh [--fresh]
#
# 후보 선택 근거는 ffmpeg/README.md에 있다. 여기서는 **어떻게** 만들었는지와
# 재배치에서 무엇이 깨졌는지(실측: 아무것도 깨지지 않았다)를 코드로 고정한다.
#
# 이 스크립트 자신은 격리 대상이 아니다 (스펙 §4.0 — 빌드 도구는 피검사
# 대상이 아니라 산출물을 만드는 수단이다). 격리 대상은 여기서 만든
# bin/ffmpeg·bin/ffprobe이고, 그쪽은 verify/t4-*.sh가 run-isolated.sh를
# 통해 돈다.
#
# ## 핵심 설계 (Task 2·3과 같은 원칙)
#
# configure --prefix에 최종 경로를 넣으면 "재배치가 되는가"를 한 번도 묻지
# 않은 채로 통과한다. 그래서 이 머신에 존재하지 않는 중립 prefix
# ($BUILD_PREFIX)로 빌드해 DESTDIR로 스테이징하고, bin/ffmpeg·bin/ffprobe만
# 뽑아 stage/ffmpeg에 둔 뒤 bundle/ffmpeg로 **옮긴 뒤에** G1 검증을 한다.
#
# ## 재배치에서 실제로 깨진 것 — PostgreSQL·Python과 다르다
#
# **아무것도 깨지지 않았다.** --enable-static --disable-shared로 완전 정적
# 링크했고, otool -L의 의존이 /usr/lib/*, /System/Library/Frameworks/* 뿐이라
# LC_RPATH 자체가 없다(otool -l에 LC_RPATH 커맨드가 없음, 아래 5·7절 실측).
# PostgreSQL의 공유 라이브러리 install_name이나 Python wheel의 빌드 머신
# rpath 같은, 재배치를 깨는 상대·절대 경로가 애초에 바이너리에 들어가지
# 않는다. 그래서 install_name_tool·codesign 사후 처리가 필요 없다 — 이동
# 전후 G1 출력이 완전히 동일하다(5·7절이 그 대비다).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

FFMPEG_VERSION=9.0.1

# 이 머신에 존재하지 않는 중립 prefix. pg/build.sh·python/build.sh와 같은
# 장치 — /opt/homebrew도 /usr/local도 아니므로 G1 금지 문자열에 걸리지 않는다.
BUILD_PREFIX=/opt/damwha-phase0/ffmpeg

DL="$EXP_ROOT/downloads"
SRC="$EXP_ROOT/stage/src"
BUILD_DIR="$SRC/ffmpeg-$FFMPEG_VERSION"
STAGE="$EXP_ROOT/stage/ffmpeg"
DESTDIR="$EXP_ROOT/stage/destdir-ffmpeg"
BUNDLE_PARENT="$EXP_ROOT/bundle"
BUNDLE="$BUNDLE_PARENT/ffmpeg"
CHECK="$EXP_LIB_DIR/check-macho.sh"
LOG="$EVIDENCE/t4-build-relocation.txt"

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "")      ;;
  *)       echo "usage: fetch.sh [--fresh]" >&2; exit 2 ;;
esac

for t in curl tar make cc otool shasum sysctl; do
  command -v "$t" >/dev/null 2>&1 || exp_die "$t 가 없다 (Command Line Tools 필요)"
done

exp_ensure_sandbox
mkdir -p "$DL" "$SRC" "$BUNDLE_PARENT"

if [ "$FRESH" = 1 ]; then
  echo "--fresh: stage/ffmpeg, stage/destdir-ffmpeg, stage/src/ffmpeg-$FFMPEG_VERSION, bundle/ffmpeg 를 지운다"
  rm -rf "$STAGE" "$DESTDIR" "$BUILD_DIR" "$BUNDLE"
fi

if [ -x "$BUNDLE/bin/ffmpeg" ] && [ -x "$BUNDLE/bin/ffprobe" ] && [ "$FRESH" = 0 ]; then
  echo "이미 구성돼 있다: $BUNDLE (다시 만들려면 --fresh)"
  "$BUNDLE/bin/ffmpeg" -version | head -1
  exit 0
fi

say() { echo; echo "== $*"; }

# 스펙 §6: 증거는 회차마다 새 파일이며 덮어쓰지 않는다.
if [ -f "$LOG" ]; then
  mv "$LOG" "${LOG%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
fi
{
  echo "# Task 4 — ffmpeg/ffprobe 번들 구성과 재배치 실측 (스펙 P0-C6, R-8)"
  echo "# 이 파일은 ffmpeg/fetch.sh가 생성한다. 손으로 고치지 않는다."
  echo "utc               : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "격리 대상         : 아니오 — 빌드는 산출물을 만드는 수단이다 (스펙 §4.0)"
  echo "ffmpeg            : $FFMPEG_VERSION (ffmpeg.org 배포 최신 안정판, 2026-09-09 확인)"
  echo "빌드 시점 prefix  : $BUILD_PREFIX  (이 머신에 존재하지 않는 중립 경로)"
  echo "스테이징          : $STAGE"
  echo "최종 번들         : $BUNDLE"
} > "$LOG"

# ---------------------------------------------------------------------------
# 1. 내려받기 + 체크섬
# ---------------------------------------------------------------------------
say "1. 소스 내려받기"
fetch_file() {
  local url="$1" out="$2"
  if [ -f "$DL/$out" ]; then
    echo "  이미 있음: $out"
  else
    echo "  받는다: $url"
    curl -fsSL -o "$DL/$out.part" "$url" || exp_die "내려받기 실패: $url"
    mv "$DL/$out.part" "$DL/$out"
  fi
}
fetch_file "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz"

SUMS="$EXP_ROOT/ffmpeg/checksums.txt"
[ -f "$SUMS" ] || exp_die "체크섬 파일이 없다: $SUMS"
( cd "$DL" && grep -v '^[[:space:]]*#' "$SUMS" | grep -v '^[[:space:]]*$' | shasum -a 256 -c - ) \
  || exp_die "내려받은 아카이브의 체크섬이 다르다 — ffmpeg/checksums.txt 참조"
{ echo; echo "## 1. 아카이브 체크섬 (ffmpeg/checksums.txt 대조 통과. 배포처 공개 체크섬/gpg 없음 — 근거는 checksums.txt 머리말)"; \
  ( cd "$DL" && shasum -a 256 "ffmpeg-$FFMPEG_VERSION.tar.xz" ); } >> "$LOG"

# ---------------------------------------------------------------------------
# 2. 풀기
# ---------------------------------------------------------------------------
say "2. 소스 풀기"
[ -d "$BUILD_DIR" ] || tar xf "$DL/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$SRC"

# ---------------------------------------------------------------------------
# 3. configure — LGPL 구성 (스펙 R-8)
# ---------------------------------------------------------------------------
say "3. ffmpeg $FFMPEG_VERSION configure — LGPL, 최소 구성"
# --disable-gpl --disable-nonfree --disable-version3
#   GPL 코드·논프리 코드·(L)GPLv3 재라이선싱을 전부 끈다. 외부 GPL 라이브러리
#   (x264/x265/xvid 등)는 --enable-libXXX로 명시해야만 들어오는데 그 플래그를
#   하나도 주지 않았다. 담화가 쓰는 두 용도 — probe(형식 파싱)와
#   normalize(임의 형식 디코드 → FLAC 인코드, pipeline/ffmpeg.py) — 는 전부
#   ffmpeg 내장(native) 코덱·디먹서로 되고, FLAC 인코더도 내장이다. 그래서
#   이 세 플래그를 꺼도 정상 동작한다(아래 4·9절 실측). configure가 스스로
#   보고하는 결과는 "License: LGPL version 2.1 or later"다(로그 참조).
# --disable-avdevice
#   카메라·마이크 디바이스 캡처. 담화는 2026-09-05 브라우저 캡처 전환 이후
#   오디오를 파일로만 받는다(U-4 조사, probe/deps-survey.md) — ffmpeg가
#   디바이스를 열 필요가 없다.
# --disable-network
#   http/rtmp 등 네트워크 프로토콜. pipeline/ffmpeg.py가 넘기는 입력은 항상
#   로컬 파일 경로다.
# --disable-doc --disable-htmlpages --disable-manpages --disable-podpages
# --disable-txtpages
#   texi2html·pod2man 같은 문서 빌드 도구 없이도 빌드되게 한다. 실행에
#   무관하다.
# --disable-ffplay
#   SDL 의존 재생 도구. pipeline/ffmpeg.py는 ffmpeg·ffprobe만 부른다.
# --enable-static --disable-shared
#   두 실행 파일을 완전 정적으로 링크한다. 그 결과 런타임 의존이 시스템
#   프레임워크/usr/lib뿐이라(4·9절) PostgreSQL·Python 번들과 달리
#   install_name_tool 사후 처리가 필요 없었다.
if [ ! -f "$BUILD_DIR/ffbuild/config.mak" ]; then
  ( cd "$BUILD_DIR" && ./configure \
      --prefix="$BUILD_PREFIX" \
      --disable-gpl --disable-nonfree --disable-version3 \
      --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
      --disable-avdevice --disable-network --disable-ffplay \
      --enable-static --disable-shared \
      --disable-debug \
      > "$SRC/ffmpeg-configure.out" 2>&1 ) \
    || { tail -n 60 "$SRC/ffmpeg-configure.out"; exp_die "configure 실패 — $SRC/ffmpeg-configure.out"; }
fi
LICENSE_LINE=$(grep -m1 '^License:' "$SRC/ffmpeg-configure.out")
echo "  $LICENSE_LINE"
{ echo; echo "## 3. configure 결과 (스펙 R-8)"; echo "$LICENSE_LINE"; \
  grep -A0 -m1 '^  prefix' "$SRC/ffmpeg-configure.out" 2>/dev/null; } >> "$LOG"

# ---------------------------------------------------------------------------
# 4. 빌드
# ---------------------------------------------------------------------------
say "4. 빌드 (make -j$(sysctl -n hw.ncpu))"
( cd "$BUILD_DIR" && make -j"$(sysctl -n hw.ncpu)" > "$SRC/ffmpeg-make.out" 2>&1 ) \
  || { tail -n 60 "$SRC/ffmpeg-make.out"; exp_die "make 실패 — $SRC/ffmpeg-make.out"; }
echo "  빌드 성공"
{ echo; echo "## 4. 빌드"; echo "make -j$(sysctl -n hw.ncpu) 성공"; } >> "$LOG"

# ---------------------------------------------------------------------------
# 5. DESTDIR 설치 → 실행에 필요한 것만 스테이징으로 뽑는다
# ---------------------------------------------------------------------------
say "5. 설치 — bin/ffmpeg, bin/ffprobe만 번들로 옮긴다"
rm -rf "$DESTDIR"
( cd "$BUILD_DIR" && make install DESTDIR="$DESTDIR" > "$SRC/ffmpeg-install.out" 2>&1 ) \
  || { tail -n 40 "$SRC/ffmpeg-install.out"; exp_die "install 실패 — $SRC/ffmpeg-install.out"; }
# include/ lib/*.a lib/pkgconfig/*.pc share/ffmpeg/(examples, ffpreset, xsd)는
# 빌드 전용 산출물이다. lib/pkgconfig/*.pc에는 빌드 트리 절대 경로
# ($BUILD_PREFIX)가 그대로 박혀 있고, 정적 라이브러리(.a)·헤더·예제 소스는
# 앱 실행에 쓰이지 않는다 — pg/build.sh가 lib/pgxs·include를 뺀 것과 같은
# 이유다. 완전 정적으로 링크된 bin/ffmpeg, bin/ffprobe 둘만 실행에 필요하다.
rm -rf "$STAGE"
mkdir -p "$STAGE/bin"
cp "$DESTDIR$BUILD_PREFIX/bin/ffmpeg"  "$STAGE/bin/ffmpeg"
cp "$DESTDIR$BUILD_PREFIX/bin/ffprobe" "$STAGE/bin/ffprobe"
{ echo; echo "## 5. 번들에 넣은 파일 (설치 산출물 중 실행에 필요한 것만 — include/lib/share 제외)"; \
  ls -la "$STAGE/bin"; } >> "$LOG"

# ---------------------------------------------------------------------------
# 6. 이동 전 G1 (스테이징 경로)
# ---------------------------------------------------------------------------
say "6. 이동 전 G1 (stage/ffmpeg)"
STAGE_OUT=$("$CHECK" "$STAGE" 2>&1); STAGE_RC=$?
echo "$STAGE_OUT"
{ echo; echo "## 6. 이동 전 G1 (stage/ffmpeg) — exit $STAGE_RC"; echo "$STAGE_OUT"; } >> "$LOG"

# ---------------------------------------------------------------------------
# 7. 재배치 — stage/ffmpeg → bundle/ffmpeg
# ---------------------------------------------------------------------------
say "7. 재배치 — stage/ffmpeg → bundle/ffmpeg"
rm -rf "$BUNDLE"
mv "$STAGE" "$BUNDLE"
echo "  옮김: $BUNDLE"

# ---------------------------------------------------------------------------
# 8. 이동 후 G1 (실제 검증 대상)
# ---------------------------------------------------------------------------
say "8. 이동 후 G1 (bundle/ffmpeg, 실제 검증 대상)"
BUNDLE_OUT=$("$CHECK" "$BUNDLE" 2>&1); BUNDLE_RC=$?
echo "$BUNDLE_OUT"
{ echo; echo "## 8. 이동 후 G1 (bundle/ffmpeg) — exit $BUNDLE_RC"; echo "$BUNDLE_OUT"; } >> "$LOG"
if [ "$BUNDLE_RC" -ne 0 ]; then
  exp_die "재배치 후 G1 위반이 있다 — 로그: $LOG"
fi
if [ "$STAGE_RC" -ne "$BUNDLE_RC" ]; then
  echo "  참고: 이동 전(exit $STAGE_RC)과 이동 후(exit $BUNDLE_RC)의 판정이 다르다 — 로그를 확인한다" >&2
fi

# ---------------------------------------------------------------------------
# 9. otool -L / -l 요약 — install_name_tool 사후 처리가 필요 없었음을 실측으로 남긴다
# ---------------------------------------------------------------------------
say "9. otool -L / -l 요약 (재배치 후, 사후 처리 없음)"
{
  echo
  echo "## 9. otool -L / LC_RPATH (재배치 후, install_name_tool 미사용)"
  for b in ffmpeg ffprobe; do
    echo "--- bin/$b : otool -L ---"
    otool -L "$BUNDLE/bin/$b"
    echo "--- bin/$b : LC_RPATH (없으면 출력 없음) ---"
    otool -l "$BUNDLE/bin/$b" | awk '/^ *cmd LC_RPATH/{r=1;next} r&&/^ *path /{print; r=0}'
  done
} | tee -a "$LOG"

# ---------------------------------------------------------------------------
# 10. 버전·라이선스·활성 인코더 (R-8) — README가 그대로 인용한다
# ---------------------------------------------------------------------------
say "10. ffmpeg -version (재배치 후 바이너리, R-8 기록용)"
VERSION_OUT=$("$BUNDLE/bin/ffmpeg" -version)
echo "$VERSION_OUT" | head -5
{ echo; echo "## 10. ffmpeg -version (bundle/ffmpeg/bin/ffmpeg, 재배치 후)"; echo "$VERSION_OUT"; } >> "$LOG"

echo
echo "완료: $BUNDLE"
echo "로그: $LOG"
