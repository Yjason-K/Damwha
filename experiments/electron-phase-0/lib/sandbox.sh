#!/bin/bash
# 샌드박스 수명 관리 (스펙 §4.4).
#
#   sandbox.sh init                     디렉터리 생성 (멱등)
#   sandbox.sh --fresh                  $SANDBOX **하위만** 비운다
#   sandbox.sh copy-audio <meeting_id>  검증용 오디오를 복사한다
#   sandbox.sh status                   PID 파일과 디렉터리 상태
#   sandbox.sh guard <name>             그 이름의 프로세스가 살아 있으면 exit 1
#
# 이 파일에는 pkill / killall / docker volume rm / docker compose down -v가
# 없다. 이름으로 죽이면 개발용 Docker Postgres나 사용자의 다른 작업을 같이
# 죽인다 (스펙 §4.4).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/config.sh"

# --fresh가 $SANDBOX 밖을 지우지 못하게 하는 검증. 하나라도 어긋나면 아무것도
# 지우지 않고 죽는다. rm -rf "$SANDBOX" 자체를 쓰지 않고 하위 항목만 지운다.
assert_sandbox_path() {
  local p="$SANDBOX"
  [ -n "$p" ]                        || exp_die "SANDBOX가 비어 있다"
  [ "$p" != "/" ]                    || exp_die "SANDBOX가 루트다: $p"
  [ "$p" != "$HOME" ]                || exp_die "SANDBOX가 홈이다: $p"
  [ "$p" != "$REPO_ROOT" ]           || exp_die "SANDBOX가 저장소 루트다: $p"
  [ "$p" != "$EXP_ROOT" ]            || exp_die "SANDBOX가 실험 루트다: $p"
  case "$p" in
    "$EXP_ROOT"/*) ;;
    *) exp_die "SANDBOX가 실험 루트 하위가 아니다: $p" ;;
  esac
  [ "$(basename "$p")" = "sandbox" ] || exp_die "SANDBOX의 이름이 sandbox가 아니다: $p"
  # 심볼릭 링크를 따라가면 밖을 지울 수 있다.
  [ ! -L "$p" ]                      || exp_die "SANDBOX가 심볼릭 링크다: $p"
  if [ -d "$p" ]; then
    local real
    real=$(cd "$p" && pwd -P)
    [ "$real" = "$p" ] || exp_die "SANDBOX의 실경로가 다르다: $p -> $real"
  fi
}

cmd_init() {
  exp_ensure_sandbox
  echo "sandbox 준비됨: $SANDBOX"
  echo "  home    : $ISO_HOME"
  echo "  tmp     : $ISO_TMPDIR"
  echo "  storage : $ISO_STORAGE_ROOT"
  echo "  run     : $SANDBOX/run"
  echo "  audio   : $SANDBOX/audio"
  echo "  evidence: $EVIDENCE"
}

cmd_fresh() {
  assert_sandbox_path
  if [ ! -d "$SANDBOX" ]; then
    cmd_init
    return 0
  fi
  # 살아 있는 실험 프로세스가 있으면 데이터 디렉터리를 지우지 않는다.
  local alive=""
  local f name
  for f in "$SANDBOX"/run/*.pid; do
    [ -e "$f" ] || continue
    name=$(basename "$f" .pid)
    if exp_pid_alive "$name"; then
      alive="$alive $name"
    fi
  done
  if [ -n "$alive" ]; then
    exp_die "아직 살아 있는 실험 프로세스가 있다:$alive — 각 서비스의 stop을 먼저 부른다"
  fi
  echo "지운다: $SANDBOX 하위 전체 (디렉터리 자신은 남긴다)"
  find "$SANDBOX" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cmd_init
}

cmd_guard() {
  [ $# -eq 1 ] || exp_die "usage: sandbox.sh guard <name>"
  exp_pid_guard "$1" || exit 1
  echo "not running: $1"
}

cmd_status() {
  echo "SANDBOX : $SANDBOX"
  [ -d "$SANDBOX" ] && echo "존재함" || echo "없음"
  local f name
  for f in "$SANDBOX"/run/*.pid; do
    [ -e "$f" ] || continue
    name=$(basename "$f" .pid)
    if exp_pid_alive "$name"; then
      echo "  pid $name: $(cat "$f") (살아 있음)"
    else
      echo "  pid $name: $(cat "$f") (죽었음 — 남은 PID 파일)"
    fi
  done
  if [ -f "$SANDBOX/audio/sample.flac" ]; then
    echo "  audio: sample.flac $(stat -f '%z' "$SANDBOX/audio/sample.flac") bytes"
  fi
}

# be/storage의 원본을 **복사**만 한다. 원본 경로에 쓰지 않는다 (스펙 §4.4).
# 복사 전후로 원본의 크기·mtime·체크섬을 재서 무변화를 증거로 남긴다.
cmd_copy_audio() {
  [ $# -eq 1 ] || exp_die "usage: sandbox.sh copy-audio <meeting_id>"
  local mid="$1"
  local storage
  storage=$(exp_source_storage_root) \
    || exp_die "be/storage를 찾지 못했다 (DAMWHA_SOURCE_STORAGE로 지정할 수 있다)"

  local src="$storage/meetings/$mid/original.flac"
  [ -f "$src" ] || exp_die "원본이 없다: $src"
  [ -r "$src" ] || exp_die "원본을 읽을 수 없다: $src"

  exp_ensure_sandbox
  local dst="$SANDBOX/audio/sample.flac"

  local before_size before_mtime before_sum
  before_size=$(stat -f '%z' "$src")
  before_mtime=$(stat -f '%m' "$src")
  before_sum=$(shasum -a 256 "$src" | awk '{print $1}')

  if [ -f "$dst" ] && [ "$(shasum -a 256 "$dst" | awk '{print $1}')" = "$before_sum" ]; then
    echo "이미 같은 내용이 복사돼 있다 — 다시 복사하지 않는다 (멱등)"
  else
    cp "$src" "$dst"
  fi

  local dst_sum
  dst_sum=$(shasum -a 256 "$dst" | awk '{print $1}')
  [ "$dst_sum" = "$before_sum" ] || exp_die "복사본의 체크섬이 원본과 다르다"

  local after_size after_mtime after_sum
  after_size=$(stat -f '%z' "$src")
  after_mtime=$(stat -f '%m' "$src")
  after_sum=$(shasum -a 256 "$src" | awk '{print $1}')
  [ "$after_size" = "$before_size" ]   || exp_die "원본 크기가 바뀌었다"
  [ "$after_mtime" = "$before_mtime" ] || exp_die "원본 mtime이 바뀌었다"
  [ "$after_sum" = "$before_sum" ]     || exp_die "원본 체크섬이 바뀌었다"

  local dur="unknown"
  if command -v ffprobe >/dev/null 2>&1; then
    dur=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$src" 2>/dev/null)
    [ -n "$dur" ] || dur="unknown"
  fi

  mkdir -p "$PROBE_DIR"
  local out="$PROBE_DIR/audio-source.txt"
  {
    echo "U-1 — 검증용 오디오의 출처 (스펙 §3.3, §4.4 / 계획 Task 1)"
    echo "이 파일은 sandbox.sh copy-audio가 생성한다. 손으로 고치지 않는다 —"
    echo "선택 근거는 probe/audio-source.note.md에 쓰고 이 스크립트가 뒤에 붙인다."
    echo
    echo "생성 시각(UTC) : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "선택한 회의    : $mid"
    echo "원본 경로      : $src"
    echo "원본 크기      : $before_size bytes"
    echo "원본 mtime     : $before_mtime ($(date -r "$before_mtime" '+%Y-%m-%d %H:%M:%S %z'))"
    echo "원본 sha256    : $before_sum"
    echo "원본 duration  : $dur s"
    echo "복사본         : $dst"
    echo "복사본 sha256  : $dst_sum"
    echo "원본 무변화    : 복사 전후의 크기·mtime·sha256이 모두 같다 (이 스크립트가 확인)"
    echo
    echo "## 같은 storage의 후보 전량 (원본 무변경 조사)"
    echo "meeting_id  original.flac  size_bytes  duration_s"
    local d id f sz du
    for d in "$storage"/meetings/*/; do
      [ -d "$d" ] || continue
      id=$(basename "$d")
      f="$d/original.flac"
      if [ -f "$f" ]; then
        sz=$(stat -f '%z' "$f")
        du="unknown"
        if command -v ffprobe >/dev/null 2>&1; then
          du=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$f" 2>/dev/null)
          [ -n "$du" ] || du="unknown"
        fi
        echo "$id  있음  $sz  $du"
      else
        echo "$id  없음  -  -"
      fi
    done
    if [ -f "$PROBE_DIR/audio-source.note.md" ]; then
      echo
      echo "## 선택 근거 (probe/audio-source.note.md에서 그대로 옮김)"
      cat "$PROBE_DIR/audio-source.note.md"
    fi
  } > "$out"

  echo "복사 완료: $src -> $dst"
  echo "기록: $out"
}

case "${1:-}" in
  init)        shift; cmd_init "$@" ;;
  --fresh|fresh) shift; cmd_fresh "$@" ;;
  copy-audio)  shift; cmd_copy_audio "$@" ;;
  status)      shift; cmd_status "$@" ;;
  guard)       shift; cmd_guard "$@" ;;
  *)
    echo "usage: sandbox.sh {init|--fresh|copy-audio <meeting_id>|status|guard <name>}" >&2
    exit 2 ;;
esac
