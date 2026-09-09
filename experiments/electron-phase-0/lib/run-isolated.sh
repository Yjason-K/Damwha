#!/bin/bash
# G2 — 격리 실행 래퍼 (스펙 §4.2).
#
#   run-isolated.sh [--label <name>] -- <command...>
#
# 스펙 §4.2가 정한 대로 /usr/bin/env -i로 환경을 완전히 비우고, 표에 있는
# 변수 **만** 다시 주입한다. 표에 없는 변수를 주입하면 격리 위반이므로 주입
# 목록은 config.sh의 ISO_VAR_NAMES 화이트리스트 하나로 고정돼 있고, 이
# 스크립트는 그 목록을 순회하는 것 말고 변수를 추가할 방법이 없다.
#
# 남기는 증거 (스펙 §6에 따라 .txt만 쓴다 — .log는 루트 .gitignore:37에 걸려
# 조용히 커밋에서 빠진다):
#   $EVIDENCE/<label>-env.txt    주입한 변수 이름과 값. HF_TOKEN은 set/unset만.
#   $EVIDENCE/<label>-dyld.txt   DYLD_PRINT_LIBRARIES=1로 실측한 로드 경로 전량.
#   $EVIDENCE/<label>-stderr.txt 명령의 stderr 중 dyld 줄이 아닌 것 (있을 때만).
#
# **실행은 한 번뿐이다.** 계획 Task 1의 인터페이스 설명은 "DYLD_PRINT_LIBRARIES=1로
# 한 번 더 실행"이라고 적었지만 그대로 하지 않는다. 이 래퍼는 Task 7의 전체
# 음성 파이프라인과 Task 9의 모델 다운로드도 통과하는데, 그 둘을 두 번 돌리면
# GPU 시간과 다운로드가 그대로 두 배가 되고 스펙 §4.4의 디스크 여유 규칙(R-14)과
# 정면으로 부딪친다. 서비스 기동(Task 2·5)은 두 번째 실행이 PID 가드에 막혀
# 빈 dyld 증거를 남기게 된다. 스펙 §4.2 본문은 "DYLD_PRINT_LIBRARIES=1을 켜고
# 실행해"라고만 요구하므로, 한 번의 실행에 계측을 켜는 쪽이 스펙에 더 가깝고
# 부작용이 없다. DYLD_PRINT_LIBRARIES는 계측 도구이지 주입 화이트리스트가
# 아니며, 증거 파일에도 그렇게 표시한다.
#
# SIP는 플랫폼 바이너리에 대해 DYLD_*를 무시한다. 그 경우 dyld 줄이 0건이 되고
# 증거 파일 첫 줄에 MEASUREMENT_UNAVAILABLE을 적는다 (스펙 §4.2, P0-C7).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/config.sh"

# 이 래퍼가 자기 도구(grep/sed/wc)로 다루는 것은 자식의 stderr, 즉 임의의
# 바이트다. 기본 로케일에서는 "Illegal byte sequence"로 줄이 통째로 버려져
# dyld 실측이 조용히 비게 된다. 자식은 env -i를 지나므로 이 설정을 물려받지
# 않는다 — 격리에는 영향이 없다.
export LC_ALL=C

LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:-}"; shift 2 ;;
    --)      shift; break ;;
    *)       echo "usage: run-isolated.sh [--label <name>] -- <command...>" >&2; exit 2 ;;
  esac
done
[ $# -ge 1 ] || { echo "usage: run-isolated.sh [--label <name>] -- <command...>" >&2; exit 2; }
[ -n "$LABEL" ] || LABEL="unlabeled-$(date -u '+%Y%m%dT%H%M%SZ')"
case "$LABEL" in
  */*|"") echo "FAIL: --label에 / 를 넣지 않는다: $LABEL" >&2; exit 2 ;;
esac

exp_ensure_sandbox

STAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
ENV_TXT="$EVIDENCE/$LABEL-env.txt"
DYLD_TXT="$EVIDENCE/$LABEL-dyld.txt"
ERR_TXT="$EVIDENCE/$LABEL-stderr.txt"

# 스펙 §6: 증거 파일은 회차마다 새 파일이며 덮어쓰지 않는다. 그런데 뒤 Task의
# verify 스크립트는 <label>-dyld.txt라는 고정 이름을 읽는다. 둘 다 지키려고
# 최신 회차를 고정 이름에 두고, 내용이 다른 이전 회차는 옆으로 보관한다.
archive_prev() {
  local f="$1"
  [ -f "$f" ] || return 0
  local base prev
  base="${f%.txt}"
  prev="$base.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  mv "$f" "$prev"
  echo "$prev"
}

RUNTMP=$(mktemp -d "${TMPDIR:-/tmp}/runiso.XXXXXX") || exit 2
RAW_ERR="$RUNTMP/stderr.raw"
trap 'rm -rf "$RUNTMP"' EXIT

HF_STATE="unset"
HF_TOKEN_VALUE=""
if HF_TOKEN_VALUE=$(exp_read_hf_token); then
  HF_STATE="set"
else
  HF_TOKEN_VALUE=""
fi

# --- 주입 변수 기록 (값은 이 자리에서만 조립한다) ---------------------------
{
  echo "# run-isolated.sh — G2 격리 실행 기록 (스펙 §4.2)"
  echo "label      : $LABEL"
  echo "utc        : $STAMP"
  echo "cwd        : $(pwd -P)"
  echo "격리 대상  : 예 — 이 래퍼를 통과한 명령은 전부 격리 대상이다 (스펙 §4.0)"
  echo "command    :"
  for a in "$@"; do echo "  argv: $a"; done
  echo
  echo "## 주입한 변수 (스펙 §4.2 표의 이름 12개 중, 값을 기록하는 11개)"
  echo "PATH=$ISO_PATH"
  echo "HOME=$ISO_HOME"
  echo "TMPDIR=$ISO_TMPDIR"
  echo "DATABASE_URL=$ISO_DATABASE_URL"
  echo "STORAGE_ROOT=$ISO_STORAGE_ROOT"
  echo "MODEL_CACHE_DIR=$ISO_MODEL_CACHE_DIR"
  echo "HF_HOME=$ISO_HF_HOME"
  echo "EMBED_SERVICE_HOST=$ISO_EMBED_SERVICE_HOST"
  echo "EMBED_SERVICE_PORT=$ISO_EMBED_SERVICE_PORT"
  echo "LENS_LLM_BASE_URL=$ISO_LENS_LLM_BASE_URL"
  echo "LENS_LLM_SERVER_BIN=$ISO_LENS_LLM_SERVER_BIN"
  echo
  echo "## 비밀값"
  echo "HF_TOKEN=$HF_STATE   # 값은 기록하지 않는다 (스펙 §4.2). 출처: be/worker/.env"
  echo
  echo "## 계측 도구 변수 (주입 화이트리스트가 아니다)"
  echo "DYLD_PRINT_LIBRARIES=1   # G2 dyld 실측 (스펙 §4.2)"
} > "$RUNTMP/env.txt"

echo "run-isolated: label=$LABEL  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f $RAW_ERR)" >&2

set +e
if [ "$HF_STATE" = "set" ]; then
  /usr/bin/env -i \
    PATH="$ISO_PATH" \
    HOME="$ISO_HOME" \
    TMPDIR="$ISO_TMPDIR" \
    DATABASE_URL="$ISO_DATABASE_URL" \
    STORAGE_ROOT="$ISO_STORAGE_ROOT" \
    MODEL_CACHE_DIR="$ISO_MODEL_CACHE_DIR" \
    HF_HOME="$ISO_HF_HOME" \
    EMBED_SERVICE_HOST="$ISO_EMBED_SERVICE_HOST" \
    EMBED_SERVICE_PORT="$ISO_EMBED_SERVICE_PORT" \
    LENS_LLM_BASE_URL="$ISO_LENS_LLM_BASE_URL" \
    LENS_LLM_SERVER_BIN="$ISO_LENS_LLM_SERVER_BIN" \
    HF_TOKEN="$HF_TOKEN_VALUE" \
    DYLD_PRINT_LIBRARIES=1 \
    "$@" 2> "$RAW_ERR"
  RC=$?
else
  /usr/bin/env -i \
    PATH="$ISO_PATH" \
    HOME="$ISO_HOME" \
    TMPDIR="$ISO_TMPDIR" \
    DATABASE_URL="$ISO_DATABASE_URL" \
    STORAGE_ROOT="$ISO_STORAGE_ROOT" \
    MODEL_CACHE_DIR="$ISO_MODEL_CACHE_DIR" \
    HF_HOME="$ISO_HF_HOME" \
    EMBED_SERVICE_HOST="$ISO_EMBED_SERVICE_HOST" \
    EMBED_SERVICE_PORT="$ISO_EMBED_SERVICE_PORT" \
    LENS_LLM_BASE_URL="$ISO_LENS_LLM_BASE_URL" \
    LENS_LLM_SERVER_BIN="$ISO_LENS_LLM_SERVER_BIN" \
    DYLD_PRINT_LIBRARIES=1 \
    "$@" 2> "$RAW_ERR"
  RC=$?
fi
set -e

# --- dyld 실측 분리 -----------------------------------------------------------
DYLD_LINES="$RUNTMP/dyld.txt"
OTHER_LINES="$RUNTMP/other.txt"
grep -a -E '^dyld(\[[0-9]+\])?:' "$RAW_ERR" > "$DYLD_LINES" 2>/dev/null || true
grep -a -v -E '^dyld(\[[0-9]+\])?:' "$RAW_ERR" > "$OTHER_LINES" 2>/dev/null || true
DYLD_N=$(wc -l < "$DYLD_LINES" | tr -d ' ')

{
  if [ "$DYLD_N" -eq 0 ]; then
    echo "MEASUREMENT_UNAVAILABLE"
    echo "# DYLD_PRINT_LIBRARIES=1을 켰는데 dyld 줄이 0건이다. SIP가 플랫폼"
    echo "# 바이너리에 대해 DYLD_*를 무시했을 때 이렇게 된다 (스펙 §4.2 주의)."
    echo "# 통과로 기록하지 않고 측정 불가로 남긴다. 대체 확인은 G1 정적 검사와"
    echo "# P0-C8 런타임 자기 보고가 맡는다."
  fi
  echo "# run-isolated.sh dyld 실측"
  echo "# label: $LABEL   utc: $STAMP   exit: $RC   dyld 줄 수: $DYLD_N"
  echo "# argv: $*"
  cat "$DYLD_LINES"
} | exp_scrub > "$RUNTMP/dyld-final.txt"

archive_prev "$ENV_TXT"  > /dev/null
archive_prev "$DYLD_TXT" > /dev/null
{ cat "$RUNTMP/env.txt"; echo; echo "exit: $RC"; echo "dyld 줄 수: $DYLD_N"; } | exp_scrub > "$ENV_TXT"
cp "$RUNTMP/dyld-final.txt" "$DYLD_TXT"

if [ -s "$OTHER_LINES" ]; then
  archive_prev "$ERR_TXT" > /dev/null
  { echo "# $LABEL 의 stderr (dyld 줄 제외). utc: $STAMP  exit: $RC"; cat "$OTHER_LINES"; } \
    | exp_scrub > "$ERR_TXT"
  exp_scrub < "$OTHER_LINES" >&2
fi

exit $RC
