#!/bin/bash
# desktop/scripts/build-icon.sh
#
# build-resources/icon.svg → build-resources/icon.icns. 결과물을 커밋하므로 마크를 고쳤을 때만 돌린다.
# electron-builder는 buildResources의 icon.icns를 앱 아이콘과 DMG 볼륨 아이콘 둘 다에 쓴다.
#
# 이 맥에는 SVG 래스터라이저가 없다(fe/CLAUDE.md의 파비콘 재생성과 같은 사정). headless Chrome이
# 1024px로 그리고, --default-background-color=00000000이 모서리를 투명하게 남긴다 — 이것이 없으면
# 흰 바탕으로 칠해져 Dock에서 모서리가 하얗게 보인다. 나머지 크기는 sips가 줄이고 iconutil이 묶는다.
set -euo pipefail

cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="build-resources/icon.svg"
OUT="build-resources/icon.icns"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/icon.html" <<HTML
<!doctype html><html><body style="margin:0;background:transparent">
<img src="file://$PWD/$SRC" width="1024" height="1024" style="display:block">
</body></html>
HTML

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --default-background-color=00000000 --window-size=1024,1024 \
  --allow-file-access-from-files --screenshot="$work/1024.png" "file://$work/icon.html" >/dev/null 2>&1

set_dir="$work/icon.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$work/1024.png" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$work/1024.png" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$OUT"
echo "$OUT"
