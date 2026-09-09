#!/bin/bash
# 개발 자산 무변화 확인 (스펙 §4.4).
#
#   snapshot-dev-assets.sh before   현재 상태를 기록한다
#   snapshot-dev-assets.sh after    다시 재서 before와 다르면 exit 1
#
# 재는 것은 두 가지다.
#   1. docker volume ls — damwha_pgdata / be_pgdata가 그대로 있는지.
#      실험은 볼륨을 만들지도 지우지도 않는다. docker compose down -v와
#      docker volume rm은 이 하네스 어디에도 없다.
#   2. be/storage 하위 전 파일의 (경로, 크기, mtime) 매니페스트 해시.
#      파일 수와 최신 mtime만으로는 "같은 크기로 덮어썼다"를 못 잡는다.
#
# .DS_Store는 제외한다. Finder가 디렉터리를 들여다보기만 해도 갱신돼서
# 실험과 무관한 실패를 만든다 — 실험이 오디오를 건드렸는지와 무관하다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/config.sh"

MODE="${1:-}"
case "$MODE" in
  before|after) ;;
  *) echo "usage: snapshot-dev-assets.sh {before|after}" >&2; exit 2 ;;
esac

exp_ensure_sandbox
STATE_DIR="$SANDBOX/state"
BEFORE="$STATE_DIR/dev-assets-before.txt"
AFTER="$STATE_DIR/dev-assets-after.txt"

snapshot() {
  echo "## docker volumes"
  if command -v docker >/dev/null 2>&1; then
    if docker volume ls --format '{{.Name}}' > "$STATE_DIR/.vols" 2>/dev/null; then
      sort "$STATE_DIR/.vols"
      rm -f "$STATE_DIR/.vols"
    else
      echo "docker: daemon-unreachable"
    fi
  else
    echo "docker: cli-absent"
  fi

  echo "## be/storage"
  local storage
  if storage=$(exp_source_storage_root); then
    local count bytes newest manifest
    count=$(find "$storage" -type f ! -name '.DS_Store' | wc -l | tr -d ' ')
    bytes=$(find "$storage" -type f ! -name '.DS_Store' -exec stat -f '%z' {} + \
            | awk '{s+=$1} END {print s+0}')
    newest=$(find "$storage" -type f ! -name '.DS_Store' -exec stat -f '%m' {} + \
             | sort -n | tail -n 1)
    manifest=$(find "$storage" -type f ! -name '.DS_Store' -exec stat -f '%N|%z|%m' {} + \
               | sort | shasum -a 256 | awk '{print $1}')
    echo "root: $storage"
    echo "files: $count"
    echo "bytes: $bytes"
    echo "newest_mtime: ${newest:-none}"
    echo "manifest_sha256: $manifest"
  else
    echo "root: not-found"
  fi
}

if [ "$MODE" = "before" ]; then
  snapshot > "$BEFORE"
  echo "before 기록: $BEFORE"
  cat "$BEFORE"
  exit 0
fi

[ -f "$BEFORE" ] || { echo "FAIL: before 스냅샷이 없다: $BEFORE — 먼저 before를 부른다" >&2; exit 1; }
snapshot > "$AFTER"
{
  echo "# snapshot-dev-assets.sh — 개발 자산 무변화 확인 (스펙 §4.4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "## before"
  cat "$BEFORE"
  echo "## after"
  cat "$AFTER"
} > "$EVIDENCE/dev-assets-latest.txt"

if diff -u "$BEFORE" "$AFTER" > "$STATE_DIR/dev-assets-diff.txt"; then
  echo "개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다"
  cat "$AFTER"
  exit 0
fi

echo "FAIL: 개발 자산이 바뀌었다" >&2
cat "$STATE_DIR/dev-assets-diff.txt" >&2
exit 1
