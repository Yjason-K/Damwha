#!/bin/bash
# desktop/scripts/publish.sh
#
# 공증·스테이플까지 끝난 DMG를 GitHub Release `v<version>`으로 낸다 (Phase 6a 스펙 §7.1).
# 빌드(`pnpm run package:release`)와 따로 둔다 — 되돌리기 어려운 공개 동작을 빌드에 숨기지 않는다
# (Task 11 브리프).
#
#   bash desktop/scripts/publish.sh --notes-file <릴리스 노트 파일>
#
# gh를 부르기 전에 넷을 본다. 하나라도 어긋나면 아무것도 내지 않고 멈춘다.
#   1. 작업 트리가 깨끗하다(추적 안 된 파일 포함).
#   2. 태그 `v<version>`이 HEAD를 가리킨다 — `package.mjs --release`가 빌드 때 본 조건과 같다.
#   3. 그 태그가 원격(origin)에도 같은 커밋으로 있다. 없으면 `--verify-tag`가 발행을 거절한다
#      (Ruling R22 — HEAD가 원격에 없으면 `--target`도 해석되지 않는다). 태그 푸시는 이 스크립트가
#      하지 않는다. 그것도 공개 동작이라 사람이 먼저 한다.
#   4. `out/Damwha-<version>-arm64.dmg`와 그 `.sha256`이 있고 해시가 맞는다.
#
# **정책(2026-09-23~): Damwha는 데스크톱 앱으로만 배포한다.** 셀프호스팅 웹 배포의 `v0.1.1`~`v0.2.3`은 과거 기록으로만 남고, 2026-09-23부터 데스크톱이 `v<version>` 태그를 쓴다(lib/release-tag.mjs). 그래서 이제
# 데스크톱 릴리스를 저장소의 "Latest"로 낸다(`--latest`). 발행 뒤에는 태그 없는 `gh release view`
# (= 저장소 Latest)가 방금 낸 태그와 같은지 다시 본다 — 다르면 되돌리는 명령을 출력하고 실패한다.
# **자동으로 고치지 않는다** — Latest를 바꾸는 것도 공개 상태를 바꾸는 일이라 사람이 보고 한다.
#
# 문구 안의 변수는 `${…}`로 감싼다. macOS의 /bin/bash 3.2는 `$TAG가`에서 한글의 첫 바이트까지
# 변수 이름으로 읽어 `unbound variable`로 죽는다(2026-09-21 드라이런에서 실제로 났다).

set -euo pipefail

REPO=Yjason-K/Damwha
DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$DESKTOP/out"

die() {
  printf 'publish: %s\n' "$@" >&2
  exit 1
}

NOTES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes-file)
      [ $# -ge 2 ] || die "--notes-file 뒤에 파일이 없다"
      NOTES="$2"
      shift 2
      ;;
    *) die "모르는 인자: ${1}" "사용: bash desktop/scripts/publish.sh --notes-file <파일>" ;;
  esac
done
[ -n "$NOTES" ] || die "--notes-file이 필요하다 — 최소 macOS(15.0)와 설치 안내를 적은 파일(스펙 §7.1)"
[ -s "$NOTES" ] || die "릴리스 노트가 없거나 비었다: ${NOTES}"
command -v gh >/dev/null || die "gh가 없다"

VERSION="$(node -p 'require(process.argv[1]).version' "$DESKTOP/package.json")"
TAG="v$VERSION"
DMG="Damwha-$VERSION-arm64.dmg"
ROOT="$(git -C "$DESKTOP" rev-parse --show-toplevel)"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
echo "== ${TAG}, HEAD ${HEAD_SHA}"

# 1. 작업 트리
dirty="$(git -C "$ROOT" status --porcelain)"
[ -z "$dirty" ] || die "작업 트리가 깨끗하지 않다:" "${dirty}"

# 2. 로컬 태그 → HEAD
tag_sha="$(git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG^{commit}")" ||
  die "로컬 태그 ${TAG}가 없다"
[ "$tag_sha" = "$HEAD_SHA" ] || die "태그 ${TAG}(${tag_sha})가 HEAD(${HEAD_SHA})를 가리키지 않는다"

# 3. 원격 태그 → HEAD. 주석 태그면 `^{}` 줄이 커밋이고, 가벼운 태그면 줄이 하나뿐이다. `^{}`
#    패턴을 따로 줘야 그 줄이 온다 — 이름 하나만 주면 주석 태그는 태그 객체 sha만 돌아온다.
remote="$(git -C "$ROOT" ls-remote --tags origin "refs/tags/$TAG" "refs/tags/$TAG^{}")" ||
  die "원격(origin)을 조회하지 못했다"
remote_sha="$(printf '%s\n' "$remote" | awk -v peeled="refs/tags/$TAG^{}" '$2 == peeled { print $1 }')"
[ -n "$remote_sha" ] || remote_sha="$(printf '%s\n' "$remote" | awk 'NF { print $1; exit }')"
[ -n "$remote_sha" ] || die "태그 ${TAG}가 원격(origin)에 없다 — 먼저 git push origin ${TAG} (Ruling R22)"
[ "$remote_sha" = "$HEAD_SHA" ] || die "원격 태그 ${TAG}(${remote_sha})가 HEAD(${HEAD_SHA})와 다르다"

# 4. DMG와 해시
[ -f "$OUT/$DMG" ] || die "DMG가 없다: ${OUT}/${DMG} — pnpm run package:release가 먼저다"
[ -f "$OUT/$DMG.sha256" ] || die "해시 파일이 없다: ${OUT}/${DMG}.sha256"
listed="$(awk '{ print $2; exit }' "$OUT/$DMG.sha256")"
[ "$listed" = "$DMG" ] || die "해시 파일이 다른 파일을 가리킨다: ${listed}"
(cd "$OUT" && shasum -a 256 -c "$DMG.sha256") ||
  die "sha256이 맞지 않는다 — 해시를 쓴 뒤 DMG가 바뀌었다"

# 5. 발행
echo "== gh release create ${TAG} --latest"
gh release create "$TAG" "$OUT/$DMG" "$OUT/$DMG.sha256" \
  --repo "$REPO" \
  --verify-tag \
  --latest \
  --title "Damwha $VERSION (macOS)" \
  --notes-file "$NOTES"

# 6. 사후 단언 — 태그 없는 조회가 곧 저장소 Latest다. 방금 낸 태그와 같아야 한다.
latest="$(gh release view -R "$REPO" --json tagName -q .tagName)" ||
  die "발행은 됐지만 저장소 Latest를 확인하지 못했다." \
    "손으로 확인할 것: gh release view -R ${REPO} --json tagName -q .tagName 이 ${TAG} 여야 한다."
if [ "$latest" = "$TAG" ]; then
  echo "Latest = ${latest}"
  echo "발행: https://github.com/${REPO}/releases/tag/${TAG}"
else
  {
    echo
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "publish: 저장소 Latest가 '${latest}'다 — 방금 낸 ${TAG}가 아니다."
    echo "자동으로 고치지 않았다. 지금 손으로 고친다:"
    echo "  gh release edit ${TAG} --repo ${REPO} --latest"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  } >&2
  exit 1
fi
