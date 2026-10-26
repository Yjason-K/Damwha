#!/bin/bash
# desktop/scripts/build-system-audio.sh
#
# 시스템 오디오 헬퍼(native/system-audio/main.swift)를 컴파일해 desktop/build/system-audio/damwha-system-audio로
# 스테이징한다. extraResources(from: build)가 그대로 Resources/system-audio/로 싣는다. 캐시가 없다 — swiftc 한 번이라
# 몇 초다. 서명은 여기서 하지 않는다: package.mjs가 .app보다 먼저 hardened runtime으로 서명한다.
# 최소 macOS는 build-target.sh의 값을 그대로 쓴다 — check-bundle 22번이 minos를 그 상한과 비교한다.

set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=lib/build-target.sh
source "$DESKTOP/scripts/lib/build-target.sh"
STAGED="$DESKTOP/build/system-audio"

echo "== build damwha-system-audio (macOS $MACOSX_DEPLOYMENT_TARGET)"
rm -rf "$STAGED"
mkdir -p "$STAGED"
xcrun swiftc -O \
  -target "arm64-apple-macos$MACOSX_DEPLOYMENT_TARGET" \
  "$DESKTOP/native/system-audio/main.swift" \
  -o "$STAGED/damwha-system-audio"
chmod 755 "$STAGED/damwha-system-audio"
echo "== staged $STAGED"
