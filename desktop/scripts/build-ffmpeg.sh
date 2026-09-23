#!/bin/bash
# desktop/scripts/build-ffmpeg.sh
#
# 내장 ffmpeg/ffprobe 정적 바이너리를 만든다 — ffmpeg 9.0.1, LGPL v2.1 이상, 완전 정적 링크.
# 결과는 desktop/build/ffmpeg/bin/{ffmpeg,ffprobe}. electron-builder의 extraResources(from: build)가
# 그대로 Resources/ffmpeg/로 싣고, dev 앱은 이 자리를 직접 쓴다.
#
# Electron Phase 0의 experiments/electron-phase-0/ffmpeg/fetch.sh(태그
# archive/electron-phase-0-packaging-validation)를 옮겼다. 검증 하네스만 걷어냈고 빌드 조작 —
# 버전, configure 플래그, 라이선스 검사 방식 — 은 하나도 바꾸지 않았다. 옮긴 것이 원본과 다르면
# 원본이 맞다.
#
# ffmpeg는 --enable-static --disable-shared로 완전 정적 링크돼 런타임 의존이 /usr/lib·
# /System/Library뿐이다 — LC_RPATH 자체가 없어(Phase 0 실측) postgres·python 번들과 달리
# install_name_tool 재배치·재서명이 필요 없다. 세 번들 중 유일하게 그렇다.
#
#   bash desktop/scripts/build-ffmpeg.sh           캐시가 있으면 스테이징만
#   bash desktop/scripts/build-ffmpeg.sh --fresh   이 키의 캐시를 버리고 다시 빌드

set -euo pipefail

FFMPEG_VERSION=9.0.1
# 이 머신에 없는 중립 prefix (build-postgres.sh의 BUILD_PREFIX와 같은 장치) — /opt/homebrew도
# /usr/local도 아니라야 "재배치가 되는가"가 빌드 시점에 드러난다. ffmpeg는 완전 정적이라 실제로는
# 아무것도 이 경로를 참조하지 않지만, configure --prefix에 최종 경로를 넣으면 그 사실 자체를 한
# 번도 확인하지 않은 채 통과한다.
BUILD_PREFIX=/opt/damwha-embedded-ffmpeg

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$DESKTOP/scripts/build-ffmpeg.sh"
SUMS="$DESKTOP/scripts/ffmpeg-checksums.txt"
CACHE="$DESKTOP/.cache/ffmpeg"
DL="$CACHE/downloads"
STAGED="$DESKTOP/build/ffmpeg"

die() { echo "build-ffmpeg: $*" >&2; exit 1; }
say() { echo "== $*"; }

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "") ;;
  *) die "usage: build-ffmpeg.sh [--fresh]" ;;
esac

for t in curl tar make cc otool shasum ditto sysctl; do
  command -v "$t" >/dev/null 2>&1 || die "$t 가 없다 — Xcode Command Line Tools가 필요하다"
done

TARGET_LIB="$DESKTOP/scripts/lib/build-target.sh"
# shellcheck source=lib/build-target.sh
. "$TARGET_LIB"

# 캐시 키 = 버전·prefix·체크섬 파일·이 스크립트 자신·최소 배포 타깃 파일. 조작을 고치고 옛 산출물을
# 쓰는 것이 가장 조용한 실패라, 스크립트를 한 글자라도 고치면 다시 빌드한다.
KEY=$( { echo "$FFMPEG_VERSION $BUILD_PREFIX $MACOSX_DEPLOYMENT_TARGET"; \
         shasum -a 256 "$SUMS" "$SCRIPT" "$TARGET_LIB" | awk '{print $1}'; } | shasum -a 256 | cut -c1-16)
WORK="$CACHE/work-$KEY"
OUT="$CACHE/ffmpeg-$KEY"
DONE="$CACHE/ffmpeg-$KEY.complete"

if [ "$FRESH" = 1 ]; then
  rm -rf "$WORK" "$OUT" "$OUT.tmp" "$DONE"
fi

fetch() {
  local url="$1" out="$2"
  [ -f "$DL/$out" ] && return 0
  curl -fsSL -o "$DL/$out.part" "$url" || die "내려받기 실패: $url"
  mv "$DL/$out.part" "$DL/$out"
}

verify_tree() {
  local root="$1" f dep bad=0
  for b in ffmpeg ffprobe; do
    [ -x "$root/bin/$b" ] || die "bin/$b 가 없다"
  done
  for f in "$root/bin/ffmpeg" "$root/bin/ffprobe"; do
    while IFS= read -r dep; do
      case "$dep" in
        /usr/lib/*|/System/Library/*) ;;
        *) echo "  허용되지 않는 의존: $f -> $dep" >&2; bad=1 ;;
      esac
    done < <(otool -L "$f" 2>/dev/null | sed -n 's/^[[:space:]]\{1,\}\(.*\) (compatibility.*$/\1/p')
  done
  [ "$bad" = 0 ] || die "정적 링크 검사 실패 — 시스템 밖 동적 의존이 있다"
  env -i "$root/bin/ffmpeg" -version >/dev/null || die "env -i ffmpeg -version 실패"
  env -i "$root/bin/ffprobe" -version >/dev/null || die "env -i ffprobe -version 실패"
}

build() {
  local started=$SECONDS src configure_out license_line
  mkdir -p "$DL" "$WORK/src"

  say "1. 소스 내려받기 + 체크섬"
  fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz"
  ( cd "$DL" && grep -v '^[[:space:]]*#' "$SUMS" | grep -v '^[[:space:]]*$' | shasum -a 256 -c - ) || die "체크섬이 다르다"

  say "2. 풀기"
  tar xf "$DL/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK/src"
  src="$WORK/src/ffmpeg-$FFMPEG_VERSION"

  say "3. configure — LGPL, 최소 구성 (Phase 0 R-8 그대로)"
  configure_out="$WORK/configure.out"
  # 아래 플래그는 Electron Phase 0의 ffmpeg/fetch.sh(태그
  # archive/electron-phase-0-packaging-validation, :131-152)를 한 글자도 바꾸지 않고 옮긴 것이다.
  #
  # --disable-gpl --disable-nonfree --disable-version3
  #   GPL 코드·논프리 코드·(L)GPLv3 재라이선싱을 전부 끈다. 외부 GPL 라이브러리(x264/x265/xvid 등)는
  #   --enable-libXXX로 명시해야만 들어오는데 그 플래그를 하나도 주지 않았다. 담화가 쓰는 두 용도 —
  #   probe(형식 파싱)와 normalize(임의 형식 디코드 → FLAC 인코드, pipeline/ffmpeg.py) — 는 전부
  #   ffmpeg 내장(native) 코덱·디먹서로 되고, FLAC 인코더도 내장이라 이 세 플래그를 꺼도 정상
  #   동작한다. configure가 스스로 보고하는 결과는 "License: LGPL version 2.1 or later"다.
  # --disable-avdevice
  #   카메라·마이크 디바이스 캡처. 담화는 브라우저 캡처 전환 이후 오디오를 파일로만 받는다.
  # --disable-network
  #   http/rtmp 등 네트워크 프로토콜. pipeline/ffmpeg.py가 넘기는 입력은 항상 로컬 파일 경로다.
  # --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages
  #   texi2html·pod2man 같은 문서 빌드 도구 없이도 빌드되게 한다. 실행에 무관하다.
  # --disable-ffplay
  #   SDL 의존 재생 도구. pipeline/ffmpeg.py는 ffmpeg·ffprobe만 부른다.
  # --enable-static --disable-shared
  #   두 실행 파일을 완전 정적으로 링크한다. 그 결과 런타임 의존이 시스템 프레임워크/usr/lib뿐이라
  #   postgres·python 번들과 달리 install_name_tool 사후 처리가 필요 없다.
  ( cd "$src" && ./configure \
      --prefix="$BUILD_PREFIX" \
      --disable-gpl --disable-nonfree --disable-version3 \
      --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
      --disable-avdevice --disable-network --disable-ffplay \
      --enable-static --disable-shared \
      --disable-debug \
      > "$configure_out" 2>&1 ) \
    || { tail -n 60 "$configure_out"; die "configure 실패 — $configure_out"; }

  # 라이선스 검사는 configure의 stdout을 본다. ffmpeg의 configure는 이 줄을
  # `echo "License: $license"`로만 내고 log()·echolog()를 거치지 않아 ffbuild/config.log에는
  # 들어가지 않는다 — config.log를 grep하면 항상 실패한다(실측).
  license_line=$(grep -m1 '^License:' "$configure_out") || die "configure 출력에 License 줄이 없다 — $configure_out"
  echo "  $license_line"
  case "$license_line" in
    "License: LGPL"*) ;;
    *) die "예상과 다른 라이선스 — '$license_line' (LGPL이어야 한다)" ;;
  esac
  # 이중 확인: config.mak에도 GPL·NONFREE가 활성화돼 있지 않은지 본다. 비활성 키는
  # `!CONFIG_GPL=yes` 형태라 앵커 없이 찾으면 비활성 줄을 잡는다 — 반드시
  # `^CONFIG_(GPL|NONFREE)=yes`로 앵커링한다.
  if grep -E '^CONFIG_(GPL|NONFREE)=yes' "$src/ffbuild/config.mak" >/dev/null 2>&1; then
    die "config.mak에 CONFIG_GPL 또는 CONFIG_NONFREE가 활성화돼 있다"
  fi

  say "4. 빌드 (make -j$(sysctl -n hw.ncpu))"
  ( cd "$src" && make -j"$(sysctl -n hw.ncpu)" > "$WORK/make.out" 2>&1 ) \
    || { tail -n 60 "$WORK/make.out"; die "make 실패 — $WORK/make.out"; }

  say "5. 설치 — bin/ffmpeg, bin/ffprobe만 번들로 옮긴다"
  local destdir="$WORK/destdir"
  rm -rf "$destdir"
  ( cd "$src" && make install DESTDIR="$destdir" > "$WORK/install.out" 2>&1 ) \
    || { tail -n 40 "$WORK/install.out"; die "install 실패 — $WORK/install.out"; }
  # include/ lib/*.a lib/pkgconfig/*.pc share/ffmpeg/*는 빌드 전용 산출물이다. lib/pkgconfig/*.pc에는
  # 빌드 트리 절대 경로($BUILD_PREFIX)가 그대로 박혀 있고, 정적 라이브러리(.a)·헤더·예제 소스는 앱
  # 실행에 쓰이지 않는다 — build-postgres.sh가 lib/pgxs·include를 뺀 것과 같은 이유다. 완전
  # 정적으로 링크된 bin/ffmpeg, bin/ffprobe 둘만 실행에 필요하다.
  rm -rf "$OUT.tmp"
  mkdir -p "$OUT.tmp/bin"
  cp "$destdir$BUILD_PREFIX/bin/ffmpeg"  "$OUT.tmp/bin/ffmpeg"
  cp "$destdir$BUILD_PREFIX/bin/ffprobe" "$OUT.tmp/bin/ffprobe"
  mv "$OUT.tmp" "$OUT"
  say "빌드 $((SECONDS - started))초"
}

stage() {
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

if [ -f "$DONE" ] && [ -x "$OUT/bin/ffmpeg" ]; then
  say "캐시 적중: $OUT"
else
  rm -rf "$WORK" "$OUT" "$OUT.tmp" "$DONE"
  build
  verify_tree "$OUT"
  touch "$DONE"
fi
stage
