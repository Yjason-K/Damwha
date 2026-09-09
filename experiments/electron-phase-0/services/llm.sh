#!/bin/bash
# 번들 `mlx_lm.server` 수명 관리 (스펙 P0-C5b, §4.4).
#
#   llm.sh start        58000에 기동하고 /v1/models가 모델을 낼 때까지 기다린 뒤 exit 0
#   llm.sh fetch-model  모델만 샌드박스 HF 캐시에 받는다 (멱등, 이어받기)
#   llm.sh stop         PID 파일 대상 **SIGTERM**
#   llm.sh kill         PID 파일 대상 SIGKILL (롤백 전용)
#   llm.sh status       상태 출력
#
# 이 스크립트는 **격리 대상**이다. run-isolated.sh를 통해 부른다:
#   bash lib/run-isolated.sh --label t5-llm -- services/llm.sh start
#
# ## 왜 이 Task가 있는가 (스펙 §2)
#
# `mlx_lm.server`는 **어떤 매니페스트에도 선언돼 있지 않다.** be/worker/pyproject.toml의
# 기본 의존성에도 models extra에도 없고, 현재 절차는 워커 venv **밖**에
# `uv tool install mlx-lm`으로 깔아 `~/.local/bin/mlx_lm.server`를 PATH에서 찾는
# 것이다(be/worker/SMOKE.md, damwha_worker/llm_server.py::managed_llm_server가
# `shutil.which(settings.lens_llm_server_bin)`). 즉 요약·렌즈는 네 번째 런타임에
# 의존하며, 그것이 번들 안에서 뜨는지를 여기서 처음 확인한다.
#
# 그래서 이 런처는 실행한 바이너리의 절대 경로를 증거로 남긴다
# ($EVIDENCE/t5-llm-binpath.txt) — "번들 것이 떴다"를 뒤에서 검증할 수 있게.
#
# ## 무엇을 띄우는가
#
# `bundle/python/bin/mlx_lm.server` — 셔뱅이 번들 python이라 커널이 그것을 직접
# exec한다. Task 3이 이 형태를 일부러 유지했다: `#!/bin/sh` 심으로 바꾸면
# 재배치에는 강해지지만 SIP가 /bin/sh에서 DYLD_*를 지워 dyld 실측이 끊긴다
# (python/README.md "뒤 Task가 알아야 하는 것" 1). dyld의 메인 이미지는
# `bundle/python/bin/python3.12`가 되므로 판정은 계획 규칙 6c대로
# `bundle/python/` **접두사**로 한다.
#
# 인자는 damwha_worker/llm_server.py가 실제로 넘기는 것과 같은 형태로 준다 —
# `--model` / `--chat-template-args {"enable_thinking": false}` / `--host` / `--port`.
#
# ## 모델을 기동 전에 받는 이유
#
# `/v1/models`는 HF 캐시를 훑어 목록을 만들고(`scan_cache_dir()`), 모델 로드는
# 첫 chat/completions까지 미뤄진다. 캐시가 비어 있으면 서버가 멀쩡히 떠도
# `/v1/models`에 모델이 없다. 계획 규칙 3의 준비 대기를 런처 안에서 끝내려면
# 기동 전에 캐시를 채워야 한다 — services/fetch_model.py가 그 일을 하고,
# **샌드박스 HF_HOME**으로만 받는다 (개발자 ~/.cache/huggingface 40 GB에 쓰지
# 않는다, 스펙 §4.4).
#
# ## dyld 실측 규칙 (계획 "런처 스크립트의 dyld 실측 규칙")
#
# 규칙 1 — 번들 Mach-O를 띄우기 직전에 `export DYLD_PRINT_LIBRARIES=1`. SIP가
#   /bin/bash exec 때마다 지우므로 래퍼의 값은 여기 도달하지 않는다.
# 규칙 2 — 서버의 stderr를 파일로 돌리지 않는다.
# 규칙 3 — start는 백그라운드 기동 + 준비 대기 후 exit 0.
# 규칙 3b — `mlx_lm.server`에도 "로그를 파일에 직접 쓰는" 옵션이 없다. 두 규칙을
#   동시에 만족하는 형태는 계획이 적은 하나뿐이다:
#
#       "$BIN" ... 2> >(tee "$LOG" >&2) &
#
#   서버를 bash가 직접 exec하므로 dyld 줄이 tee를 거쳐 래퍼의 fd 2에 도달하고,
#   래퍼가 exit해 $RUNTMP가 지워진 뒤에도 $LOG에 남는다. tee는 플랫폼
#   바이너리라 자기 dyld 줄을 만들지 않는다. stdout만 파일로 돌린다 (측정과
#   무관하고, 그대로 두면 파이프로 이 런처를 부른 호출이 끝나지 않는다).
# 규칙 4 — PID 파일에는 서버 자신의 PID를 쓴다. 위 형태의 `$!`가 그것이다.
#
# ## 데이터 안전 (스펙 §4.4)
#
# 포트는 58000이다 — 개발 기본값 8000이 아니다. 종료는 언제나 PID 파일 대상이고
# pkill/killall은 이 파일 어디에도 없다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

SERVICES_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
BUNDLE_PY_DIR="$EXP_ROOT/bundle/python"
BIN="$BUNDLE_PY_DIR/bin/mlx_lm.server"
PY="$BUNDLE_PY_DIR/bin/python3.12"
FETCH_PY="$SERVICES_DIR/fetch_model.py"
PIDNAME=llm
HOST=127.0.0.1
PORT="$EXP_LLM_PORT"
# damwha_worker/config.py의 lens_llm_model / summary_llm_model 기본값이자
# 스펙 P0-C5b가 지정한 모델이다. 환경 변수로 바꿀 수 있게 두지 않는다 —
# 스펙 §4.2의 주입 화이트리스트에 없는 변수를 읽는 통로가 되기 때문이다.
MODEL="mlx-community/Qwen3.5-4B-8bit"
LOG="$SANDBOX/run/llm-stderr.txt"
OUTLOG="$SANDBOX/run/llm-stdout.txt"
STARTREC="$SANDBOX/run/llm-start.txt"
CURL=/usr/bin/curl
READY_TIMEOUT=600   # 1초 간격. 모델은 이미 받아 둔 상태에서 재는 시간이다.
STOP_TIMEOUT=60

need_bundle() {
  [ -x "$BIN" ] \
    || exp_die "번들 콘솔 스크립트가 없다: $BIN — python/build.sh all 을 먼저 돌린다"
  [ -x "$PY" ] || exp_die "번들 python이 없다: $PY"
  [ -f "$FETCH_PY" ] || exp_die "다운로드 드라이버가 없다: $FETCH_PY"
}

check_injected_env() {
  local want="http://$HOST:$PORT/v1"
  local got="${LENS_LLM_BASE_URL:-}"
  [ "$got" = "$want" ] \
    || exp_die "LENS_LLM_BASE_URL이 $want 가 아니라 '${got:-<unset>}' 다 — run-isolated.sh 를 통해 부른다"
  local binenv="${LENS_LLM_SERVER_BIN:-}"
  [ "$binenv" = "$BIN" ] \
    || exp_die "LENS_LLM_SERVER_BIN이 $BIN 가 아니라 '${binenv:-<unset>}' 다"
  [ -n "${HF_HOME:-}" ] || exp_die "HF_HOME이 없다 — 모델을 어디에 받을지 정해지지 않는다"
  case "$HF_HOME" in
    "$SANDBOX"/*) ;;
    *) exp_die "HF_HOME이 샌드박스 밖이다: $HF_HOME (스펙 §4.4)" ;;
  esac
}

rotate() {
  [ -f "$1" ] || return 0
  mv "$1" "${1%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
}

models_body() {
  "$CURL" -fsS --max-time 10 "http://$HOST:$PORT/v1/models" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 모델을 샌드박스 HF 캐시로 받는다. 이미 있으면 huggingface_hub가 건너뛴다
# (스펙 §4.4 "재실행 시 샌드박스 캐시를 지우지 않고 이어받는다").
cmd_fetch_model() {
  need_bundle
  check_injected_env
  exp_ensure_sandbox
  echo "모델 준비: $MODEL"
  echo "  HF_HOME: $HF_HOME"
  # 규칙 1: 번들 python도 번들 Mach-O다. 실측을 살린 채 부른다.
  export DYLD_PRINT_LIBRARIES=1
  local out rc
  out=$("$PY" "$FETCH_PY" "$MODEL")
  rc=$?
  [ $rc -eq 0 ] || exp_die "모델 다운로드 실패 (exit $rc)"
  printf '%s\n' "$out" | sed 's/^/  /'

  mkdir -p "$EVIDENCE"
  local ev="$EVIDENCE/t5-llm-model-fetch.txt"
  [ -f "$ev" ] && mv "$ev" "${ev%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  {
    echo "# Task 5 — mlx_lm 모델을 샌드박스 HF 캐시로 받은 기록 (스펙 P0-C5b, §4.4)"
    echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# 실행: $PY $FETCH_PY $MODEL   (격리 대상 — run-isolated.sh 안에서 돈다)"
    echo "# 다운로드 경로는 mlx_lm.utils._download 이며 서버가 쓰는 것과 같다."
    echo "# elapsed_seconds는 이미 받아 둔 파일이 있으면 그만큼 짧아진다 —"
    echo "# 빈 캐시에서 처음부터 받은 회차인지는 회차 기록을 함께 본다."
    echo
    printf '%s\n' "$out"
  } | exp_scrub > "$ev"
  echo "기록: $ev"
}

# ---------------------------------------------------------------------------
cmd_start() {
  need_bundle
  check_injected_env
  exp_ensure_sandbox
  if exp_pid_alive "$PIDNAME"; then
    echo "이미 떠 있다: pid $(cat "$(exp_pid_file "$PIDNAME")") — 새로 시작하지 않는다 (스펙 §4.4)"
    return 0
  fi
  if pid=$(exp_port_pid "$PORT"); then
    exp_die "포트 $PORT 를 다른 프로세스가 쓰고 있다 (pid $pid)"
  fi

  # /v1/models가 캐시를 훑는 구조라 기동 전에 받아 둬야 준비 판정이 성립한다.
  cmd_fetch_model

  rotate "$LOG"
  rotate "$OUTLOG"

  # embed.sh와 같은 이유로 샌드박스에서 띄운다 — 저장소 어느 디렉터리에서
  # 불러도 개발용 .env가 섞이지 않게. mlx_lm.server 자신은 cwd를 쓰지 않는다.
  cd "$SANDBOX" || exp_die "샌드박스로 이동하지 못했다: $SANDBOX"

  echo "기동: $BIN"
  echo "  모델   : $MODEL"
  echo "  포트   : $HOST:$PORT"
  echo "  stderr : $LOG (규칙 3b의 tee 사본)"
  echo "  stdout : $OUTLOG"

  # 규칙 1·2·3b.
  export DYLD_PRINT_LIBRARIES=1
  "$BIN" --model "$MODEL" \
         --chat-template-args '{"enable_thinking": false}' \
         --host "$HOST" --port "$PORT" \
    > "$OUTLOG" 2> >(tee "$LOG" >&2) &
  # 규칙 4.
  local srv_pid=$!
  exp_pid_write "$PIDNAME" "$srv_pid"

  local cmdline shebang
  cmdline=$(ps -p "$srv_pid" -o command= 2>/dev/null)
  shebang=$(head -n 1 "$BIN")

  {
    echo "# llm 서비스 기동 기록 (계획 규칙 3b — 로그 위치를 \$SANDBOX/run/에 남긴다)"
    echo "utc      : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "pid      : $srv_pid"
    echo "binary   : $BIN"
    echo "shebang  : $shebang"
    echo "cmdline  : $cmdline"
    echo "model    : $MODEL"
    echo "endpoint : http://$HOST:$PORT/v1"
    echo "stderr   : $LOG"
    echo "stdout   : $OUTLOG"
    echo "hf_home  : $HF_HOME"
  } > "$STARTREC"

  # 계획 Task 5 인터페이스: 실행한 바이너리의 절대 경로를 증거에 남긴다.
  write_binpath "$srv_pid" "$cmdline" "$shebang"

  echo "  pid    : $srv_pid"
  echo "  cmdline: $cmdline"

  local i=0
  while [ "$i" -lt "$READY_TIMEOUT" ]; do
    if ! kill -0 "$srv_pid" 2>/dev/null; then
      exp_pid_clear "$PIDNAME"
      echo "--- 서버 로그 끝부분 ($LOG)" >&2
      tail -n 40 "$LOG" >&2 2>/dev/null || true
      exp_die "서버가 준비되기 전에 죽었다 (pid $srv_pid)"
    fi
    body=$(models_body) || body=""
    case "$body" in
      *"$MODEL"*)
        echo "준비됨: GET /v1/models 가 $MODEL 을 낸다"
        echo "ready    : yes ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))" >> "$STARTREC"
        return 0
        ;;
    esac
    sleep 1
    i=$((i + 1))
  done
  echo "--- 서버 로그 끝부분 ($LOG)" >&2
  tail -n 40 "$LOG" >&2 2>/dev/null || true
  exp_die "준비 대기 ${READY_TIMEOUT}s 초과 — 로그: $LOG"
}

# $EVIDENCE/t5-llm-binpath.txt — 계획 V10이 읽는다. 덮어쓰지 않고 회전한다
# (스펙 §6).
write_binpath() {
  local pid="$1" cmdline="$2" shebang="$3"
  mkdir -p "$EVIDENCE"
  local f="$EVIDENCE/t5-llm-binpath.txt"
  [ -f "$f" ] && mv "$f" "${f%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  {
    echo "# Task 5 — llm.sh start 가 실제로 실행한 바이너리 (스펙 P0-C5b)"
    echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "#"
    echo "# 스펙 §2가 지목한 대로 mlx_lm.server 는 어떤 매니페스트에도 없고, 개발"
    echo "# 절차는 uv tool 로 개발자 홈에 까는 것이다. 그래서 '번들 안의 실행"
    echo "# 파일이 떴는가'가 이 기준의 본론이고 아래 경로가 그 답이다."
    echo
    echo "binary   : $BIN"
    echo "shebang  : $shebang"
    echo "pid      : $pid"
    echo "cmdline  : $cmdline"
    echo "bundle   : $BUNDLE_PY_DIR"
    echo "model    : $MODEL"
    echo "hf_home  : $HF_HOME"
    echo "endpoint : http://$HOST:$PORT/v1"
  } | exp_scrub > "$f"
  echo "기록: $f"
}

# ---------------------------------------------------------------------------
# 스펙 P0-C5b: "SIGTERM에 종료된다". **SIGKILL로 올리지 않는다** — 올리면
# SIGTERM이 통했는지가 증거에서 사라진다.
cmd_stop() {
  if ! exp_pid_alive "$PIDNAME"; then
    echo "떠 있지 않다 (남은 PID 파일이 있으면 지운다)"
    exp_pid_clear "$PIDNAME"
    return 0
  fi
  local pid
  pid=$(cat "$(exp_pid_file "$PIDNAME")")
  echo "SIGTERM: pid $pid"
  kill -TERM "$pid" 2>/dev/null || exp_die "SIGTERM 전송 실패 (pid $pid)"
  local i=0
  while [ "$i" -lt "$STOP_TIMEOUT" ]; do
    kill -0 "$pid" 2>/dev/null || {
      exp_pid_clear "$PIDNAME"
      echo "종료 확인 (SIGTERM ${i}s 안에 내려갔다)"
      return 0
    }
    sleep 1
    i=$((i + 1))
  done
  exp_die "SIGTERM 후 ${STOP_TIMEOUT}s가 지나도 살아 있다 (pid $pid) — kill 로 정리한다"
}

cmd_kill() {
  exp_pid_alive "$PIDNAME" || exp_die "떠 있지 않다 — kill 할 대상이 없다"
  local pid
  pid=$(cat "$(exp_pid_file "$PIDNAME")")
  echo "SIGKILL: pid $pid"
  kill -9 "$pid" 2>/dev/null || true
  local i=0
  while [ "$i" -lt 40 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
    i=$((i + 1))
  done
  kill -0 "$pid" 2>/dev/null && exp_die "SIGKILL 후에도 살아 있다: $pid"
  exp_pid_clear "$PIDNAME"
  echo "강제 종료 완료"
}

# ---------------------------------------------------------------------------
cmd_status() {
  echo "번들 스크립트 : $BIN"
  [ -f "$BIN" ] && echo "  셔뱅        : $(head -n 1 "$BIN")"
  echo "모델          : $MODEL"
  echo "엔드포인트    : http://$HOST:$PORT/v1"
  if exp_pid_alive "$PIDNAME"; then
    local pid
    pid=$(cat "$(exp_pid_file "$PIDNAME")")
    echo "상태          : 살아 있음 (pid $pid)"
    echo "  cmdline     : $(ps -p "$pid" -o command= 2>/dev/null)"
  else
    echo "상태          : 떠 있지 않음"
  fi
  if body=$(models_body); then
    echo "/v1/models    : $body"
  else
    echo "/v1/models    : 응답 없음"
  fi
  [ -f "$STARTREC" ] && { echo "기동 기록     : $STARTREC"; sed 's/^/  /' "$STARTREC"; }
  return 0
}

case "${1:-}" in
  start)       shift; cmd_start       "$@" ;;
  fetch-model) shift; cmd_fetch_model "$@" ;;
  stop)        shift; cmd_stop        "$@" ;;
  kill)        shift; cmd_kill        "$@" ;;
  status)      shift; cmd_status      "$@" ;;
  *) echo "usage: llm.sh {start|fetch-model|stop|kill|status}" >&2; exit 2 ;;
esac
