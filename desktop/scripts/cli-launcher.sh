#!/bin/sh
# Damwha CLI 런처 — 앱 번들의 Contents/Resources/cli/damwha 로 실리고,
# ~/.local/bin/damwha 가 이것을 가리키는 심볼릭 링크다 (spec §2.6).
#
# 번들의 Electron 바이너리를 ELECTRON_RUN_AS_NODE=1 로 돌려 별도 Node 없이 damwha.cjs 를 실행한다.
# 이 모드에서는 Electron이 앱을 띄우지 않고 순수 Node처럼 동작한다(Dock 아이콘·두 번째 인스턴스 없음).
# 번들 밖(dev: desktop/build/cli)에서는 PATH의 node로 떨어진다.

# 링크를 끝까지 따라가 실제 위치를 찾는다. macOS의 readlink에는 -f가 없어 루프로 푼다.
# 상대 대상은 링크가 놓인 디렉터리 기준이다.
SELF="$0"
while [ -L "$SELF" ]; do
  TARGET="$(readlink "$SELF")"
  case "$TARGET" in
    /*) SELF="$TARGET" ;;
    *) SELF="$(dirname "$SELF")/$TARGET" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd -P)"

APP="$DIR/../../MacOS/Damwha"
if [ -x "$APP" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$APP" "$DIR/damwha.cjs" "$@"
fi
exec node "$DIR/damwha.cjs" "$@"
