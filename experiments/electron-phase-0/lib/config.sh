# Phase 0 실험 하네스의 고정값. 모든 lib/ verify/ 스크립트가 source 한다.
#
# 계획 "고정값" 표와 스펙 §4.2 / §7.1 U-6이 이 파일의 유일한 출처다. 개별
# 스크립트가 포트나 경로를 자기 자리에서 다시 적지 않는다 — 한 군데서 어긋나면
# 어느 인스턴스에 붙었는지가 증거에서 사라진다.
#
# 이 파일에는 스펙 §4.1의 금지 문자열이 하나도 들어 있으면 안 된다.
# lib/ 전체가 check-macho.sh의 양성 대조군(계획 Task 1 V6)이기 때문이다.

set -u

EXP_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
EXP_ROOT=$(cd "$EXP_LIB_DIR/.." && pwd -P)
REPO_ROOT=$(cd "$EXP_ROOT/../.." && pwd -P)

SANDBOX="$EXP_ROOT/sandbox"
EVIDENCE="$REPO_ROOT/docs/superpowers/reports/evidence/phase-0"
PROBE_DIR="$EXP_ROOT/probe"

# --- 스펙 §7.1 U-6: 개발 기본값(5432 / 8000 / 8100)과 분리된 실험 포트 ---
EXP_PG_PORT=55432
EXP_LLM_PORT=58000
EXP_EMBED_PORT=58100

# --- 스펙 §4.2 주입 화이트리스트의 값 ---
ISO_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
ISO_HOME="$SANDBOX/home"
ISO_TMPDIR="$SANDBOX/tmp"
ISO_STORAGE_ROOT="$SANDBOX/storage"
ISO_MODEL_CACHE_DIR="$SANDBOX/home/.cache/damwha-models"
ISO_HF_HOME="$SANDBOX/home/.cache/huggingface"
ISO_DATABASE_URL="postgresql://postgres@127.0.0.1:$EXP_PG_PORT/damwha"
ISO_EMBED_SERVICE_HOST="127.0.0.1"
ISO_EMBED_SERVICE_PORT="$EXP_EMBED_PORT"
ISO_LENS_LLM_BASE_URL="http://127.0.0.1:$EXP_LLM_PORT/v1"
# Task 3이 만들 번들 런타임 안의 절대 경로. Task 1 시점에는 아직 없다 —
# 값이 번들 안을 가리킨다는 것이 검사 대상이지 파일 존재가 아니다.
ISO_LENS_LLM_SERVER_BIN="$EXP_ROOT/bundle/python/bin/mlx_lm.server"

# 스펙 §4.2 표의 변수 이름은 HF_TOKEN까지 **12개**다 (MODEL_CACHE_DIR·HF_HOME이
# 한 행에, EMBED_SERVICE_HOST·PORT가 또 한 행에 묶여 있어 행 수와 이름 수가
# 다르다). 그중 **값을 기록해도 되는 11개**가 이 목록이다. HF_TOKEN은 자격
# 증명이라 여기 없고, 주입은 하되 증거에는 set/unset만 남는다.
ISO_VAR_NAMES="PATH HOME TMPDIR DATABASE_URL STORAGE_ROOT MODEL_CACHE_DIR HF_HOME EMBED_SERVICE_HOST EMBED_SERVICE_PORT LENS_LLM_BASE_URL LENS_LLM_SERVER_BIN"

# HF_TOKEN의 출처. 값은 어떤 경로로도 stdout·증거 파일에 나가지 않는다.
WORKER_ENV_FILE="$REPO_ROOT/be/worker/.env"

exp_die() {
  echo "FAIL: $*" >&2
  exit 1
}

exp_note() { echo "  - $*"; }

# 실험이 만드는 모든 디렉터리. 멱등하다 (스펙 §4.4 재실행 규칙).
exp_ensure_sandbox() {
  mkdir -p "$SANDBOX/home" "$SANDBOX/tmp" "$SANDBOX/storage" \
           "$SANDBOX/run" "$SANDBOX/audio" "$SANDBOX/state" \
           "$ISO_MODEL_CACHE_DIR" "$ISO_HF_HOME"
  mkdir -p "$EVIDENCE"
}

# be/storage 원본의 위치. worktree에는 be/storage가 없다 (루트 .gitignore가
# /be/storage/를 무시하므로 git worktree add가 만들어 주지 않는다). 그래서
# 주 worktree의 것을 찾아 **읽기만** 한다. 개발자 홈 경로를 이 파일에 적지
# 않으려고 git이 알려 주는 경로를 쓴다.
exp_source_storage_root() {
  if [ -n "${DAMWHA_SOURCE_STORAGE:-}" ]; then
    [ -d "$DAMWHA_SOURCE_STORAGE" ] || return 1
    echo "$DAMWHA_SOURCE_STORAGE"
    return 0
  fi
  if [ -d "$REPO_ROOT/be/storage" ]; then
    echo "$REPO_ROOT/be/storage"
    return 0
  fi
  local main
  main=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null \
         | awk '/^worktree /{print $2; exit}')
  if [ -n "$main" ] && [ -d "$main/be/storage" ]; then
    echo "$main/be/storage"
    return 0
  fi
  return 1
}

# HF_TOKEN 값을 읽는다. 호출자는 이 값을 절대 echo 하지 않는다.
exp_read_hf_token() {
  [ -f "$WORKER_ENV_FILE" ] || return 1
  local v
  v=$(sed -n 's/^HF_TOKEN=//p' "$WORKER_ENV_FILE" | head -n 1 \
      | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' -e 's/[[:space:]]*$//')
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

# 증거로 나가는 모든 텍스트는 이 필터를 통과한다. 토큰이 설정돼 있으면 그
# 값을 <HF_TOKEN>으로 바꾼다 — 워커 로그가 실수로 찍어도 커밋에 남지 않게.
exp_scrub() {
  local tok
  if tok=$(exp_read_hf_token); then
    local esc
    esc=$(printf '%s' "$tok" | sed 's/[&/\]/\\&/g')
    sed "s/$esc/<HF_TOKEN>/g"
  else
    cat
  fi
}

# 포트 하나의 LISTEN 여부. 점유 중이면 PID를 출력하고 0을 반환한다.
exp_port_pid() {
  local port="$1" out
  out=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1)
  [ -n "$out" ] || return 1
  echo "$out"
}

# --- PID 파일 규약 (스펙 §4.4 중단·재실행 규칙) -------------------------------
# 실험이 띄운 프로세스는 $SANDBOX/run/<name>.pid에만 기록한다. 이름으로
# 죽이는 명령(pkill/killall)은 이 하네스 어디에도 없다 — 개발용 Docker
# Postgres나 사용자의 다른 작업을 같이 죽이기 때문이다.
exp_pid_file() { echo "$SANDBOX/run/$1.pid"; }

exp_pid_alive() {
  local f
  f=$(exp_pid_file "$1")
  [ -f "$f" ] || return 1
  local pid
  pid=$(cat "$f" 2>/dev/null)
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

exp_pid_write() {
  mkdir -p "$SANDBOX/run"
  echo "$2" > "$(exp_pid_file "$1")"
}

exp_pid_clear() { rm -f "$(exp_pid_file "$1")"; }

# 살아 있는 프로세스가 있으면 새로 시작하지 않는다.
exp_pid_guard() {
  if exp_pid_alive "$1"; then
    echo "already running: $1 (pid $(cat "$(exp_pid_file "$1")")) — 새로 시작하지 않는다"
    return 1
  fi
  return 0
}
