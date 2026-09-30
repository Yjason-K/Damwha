#!/bin/bash
# desktop/scripts/build-models.sh
#
# 앱에 싣는 화자 분리 모델을 스테이징한다 (스펙 2026-09-30 §4.1). 결과는
# desktop/build/models/pyannote-speaker-diarization-community-1/. electron-builder의
# extraResources(from: build)가 그대로 Resources/models/로 싣고, dev 앱은 이 자리를 직접 쓴다.
#
# 이 모델은 HF에서 게이트(자동 승인)다 — **빌드하는 머신만** 토큰이 필요하다. 개발자의 HF 캐시·
# `hf auth login`·HF_TOKEN을 그대로 쓴다. 라이선스는 CC-BY-4.0이라 재배포할 수 있고, 출처는
# 같은 폴더의 NOTICE.txt와 README의 License 절이 적는다.
#
# 모델 파일은 pickle을 허용하는 체크포인트다(pyannote가 weights_only=False로 읽는다) — 그래서 커밋된
# sha256과 맞지 않으면 스테이징하지 않는다 (§4.5 신뢰 경계).
#
#   bash desktop/scripts/build-models.sh           캐시가 있으면 스테이징만
#   bash desktop/scripts/build-models.sh --fresh   이 키의 캐시를 버리고 다시 받는다

set -euo pipefail

REPO_ID=pyannote/speaker-diarization-community-1
REVISION=3533c8cf8e369892e6b79ff1bf80f7b0286a54ee
# 폴더 이름의 원천은 여기와 src/process/runtime-paths.ts의 DIARIZATION_BUNDLE_NAME 둘이다 —
# tests/process/runtime-paths.test.ts가 둘을 맞춰 본다.
NAME=pyannote-speaker-diarization-community-1

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$DESKTOP/.." && pwd -P)"
SCRIPT="$DESKTOP/scripts/build-models.sh"
SUMS="$DESKTOP/scripts/models-checksums.txt"
CACHE="$DESKTOP/.cache/models"
STAGED="$DESKTOP/build/models/$NAME"

die() { echo "build-models: $*" >&2; exit 1; }
say() { echo "== $*"; }

[ $# -le 1 ] || die "usage: build-models.sh [--fresh]"
FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "") ;;
  *) die "usage: build-models.sh [--fresh]" ;;
esac

command -v uv >/dev/null 2>&1 || die "uv가 없다 — worker venv로 모델을 받는다"

KEY=$( { echo "$REPO_ID $REVISION $NAME"; shasum -a 256 "$SUMS" "$SCRIPT" | awk '{print $1}'; } \
       | shasum -a 256 | cut -c1-16)
OUT="$CACHE/$NAME-$KEY"
DONE="$OUT.complete"

verify() { (cd "$1" && /usr/bin/grep -v '^#' "$SUMS" | shasum -a 256 -c - >/dev/null 2>&1); }

# 체크섬 파일의 다섯 상대경로 — 받기(allow_patterns)와 옮기기(복사 루프) 둘 다 이 목록 하나를 쓴다.
REL_PATHS=()
while IFS= read -r rel; do REL_PATHS+=("$rel"); done < <(/usr/bin/grep -v '^#' "$SUMS" | awk '{print $2}')

if [ "$FRESH" = 1 ]; then rm -rf "$OUT" "$DONE"; fi
# 캐시 적중도 믿지 않는다 — 대조가 깨졌으면 버리고 다시 받는다(§4.5).
if [ -f "$DONE" ] && ! verify "$OUT"; then
  say "캐시의 체크섬이 맞지 않는다 — 버리고 다시 받는다"
  rm -rf "$OUT" "$DONE"
fi

if [ ! -f "$DONE" ]; then
  say "받기 $REPO_ID@$REVISION"
  # snapshot_download에 allow_patterns 없이 전체 레포를 물으면 .gitattributes 같은 딴 파일의
  # HEAD 요청까지 걸려, 캐시에 이 다섯 파일이 이미 있고 토큰이 없는 머신에서도 게이트 401로
  # 죽는다 — 받는 다섯 파일만 물어 그 요청 자체를 없앤다.
  PY_PATTERNS="["
  for rel in "${REL_PATHS[@]}"; do PY_PATTERNS+="\"$rel\", "; done
  PY_PATTERNS="${PY_PATTERNS%, }]"
  ERRFILE=$(mktemp)
  SNAP=$(uv run --directory "$REPO/be/worker" --extra models python -c "
import sys
from huggingface_hub import snapshot_download
print(snapshot_download('$REPO_ID', revision='$REVISION', allow_patterns=$PY_PATTERNS))
" 2>"$ERRFILE" | tail -1) || true
  if [ -z "${SNAP:-}" ] || [ ! -d "$SNAP" ]; then
    echo "---- uv/python stderr (마지막 20줄) ----" >&2
    tail -20 "$ERRFILE" >&2
    rm -f "$ERRFILE"
    die "받지 못했다. 게이트 모델이라 빌드 머신에 HF 토큰이 필요하다:
  1) https://huggingface.co/$REPO_ID 에서 사용 조건에 동의하고
  2) 'uv run --directory be/worker --extra models hf auth login' 또는 HF_TOKEN을 설정한 뒤 다시 실행한다"
  fi
  rm -f "$ERRFILE"
  rm -rf "$OUT"; mkdir -p "$OUT"
  # HF 캐시 snapshot은 blobs로 가는 심링크다 — 역참조해 실제 파일로 옮긴다.
  for rel in "${REL_PATHS[@]}"; do
    mkdir -p "$OUT/$(dirname "$rel")"
    cp -L "$SNAP/$rel" "$OUT/$rel"
  done
  say "체크섬 대조"
  (cd "$OUT" && /usr/bin/grep -v '^#' "$SUMS" | shasum -a 256 -c -) || { rm -rf "$OUT"; die "체크섬이 맞지 않는다 — 스테이징하지 않는다"; }
  touch "$DONE"
fi

say "스테이징 → $STAGED"
rm -rf "$STAGED"; mkdir -p "$(dirname "$STAGED")"
cp -R "$OUT" "$STAGED"
verify "$STAGED" || die "스테이징 사본의 체크섬이 맞지 않는다"
cat > "$STAGED/NOTICE.txt" <<EOF
pyannote/speaker-diarization-community-1
https://huggingface.co/$REPO_ID (revision $REVISION)

Copyright (c) pyannote contributors. Licensed under the Creative Commons Attribution 4.0
International License (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

Damwha redistributes these files unmodified.
EOF
say "완료"
