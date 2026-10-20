#!/bin/bash
# desktop/scripts/build-cli.sh
#
# CLI(cli/dist/damwha.cjs)를 빌드해 desktop/build/cli/{damwha, damwha.cjs}로 스테이징한다.
# electron-builder의 extraResources(from: build)가 그대로 Resources/cli/로 싣고, dev 앱은
# 이 자리를 DAMWHA_CLI_LAUNCHER로 쓴다 (spec 2026-10-20 §2.6). 캐시가 없다 — esbuild 한 번이라 빠르다.

set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$DESKTOP/.." && pwd -P)"
STAGED="$DESKTOP/build/cli"

echo "== build damwha-cli"
(cd "$REPO" && pnpm --filter damwha-cli run build)

[ -f "$REPO/cli/dist/damwha.cjs" ] || { echo "build-cli: cli/dist/damwha.cjs 가 없다" >&2; exit 1; }

rm -rf "$STAGED"
mkdir -p "$STAGED"
cp "$REPO/cli/dist/damwha.cjs" "$STAGED/damwha.cjs"
cp "$DESKTOP/scripts/cli-launcher.sh" "$STAGED/damwha"
chmod 755 "$STAGED/damwha"
chmod 644 "$STAGED/damwha.cjs"
echo "== staged $STAGED"
