#!/bin/bash
# 번들 런타임의 bge-m3 임베딩 서비스 수명 관리 (스펙 P0-C5, §4.4).
#
#   embed.sh start   58100에 기동하고 /health가 응답할 때까지 기다린 뒤 exit 0
#   embed.sh stop    PID 파일 대상 **SIGTERM**
#   embed.sh kill    PID 파일 대상 SIGKILL (롤백 전용)
#   embed.sh status  상태 출력
#
# 이 스크립트는 **격리 대상**이다. run-isolated.sh를 통해 부른다:
#   bash lib/run-isolated.sh --label t5-embed -- services/embed.sh start
#
# ## 무엇을 띄우는가
#
# `bundle/python/bin/damwha-embed` — be/worker/pyproject.toml의
# `[project.scripts] damwha-embed = "damwha_worker.embed_service:main"`이다.
# 셔뱅이 번들 python이라 커널이 그것을 직접 exec한다 (python/README.md 결론 1).
#
# **이 콘솔 스크립트는 인자를 받지 않는다.** `main()`이 곧바로
# `uvicorn.run(app, host=settings.embed_service_host, port=settings.embed_service_port)`
# 이므로 `--help`조차 서버를 띄운다. 호스트·포트는 격리 래퍼가 주입하는
# EMBED_SERVICE_HOST/PORT(스펙 §4.2 표)로만 정해진다 — 이 스크립트가
# 명령줄로 바꿀 수 있는 것이 없고, 그래서 주입값이 58100인지 아래에서
# 확인만 한다.
#
# `damwha_worker.embed_service`는 **import 시점에** build_text_embedder를 불러
# SentenceTransformer("BAAI/bge-m3")를 만든다. 즉 첫 기동은 모델 다운로드
# (샌드박스 HF_HOME으로)와 로드를 포함하고, /health가 응답한다는 것은 모델이
# 이미 올라왔다는 뜻이다. 준비 대기 시간을 넉넉히 잡는 이유다.
#
# ## dyld 실측 규칙 (계획 "런처 스크립트의 dyld 실측 규칙")
#
# 규칙 1 — SIP는 /bin/bash를 exec할 때마다 DYLD_*를 지운다. 래퍼가 넘겨 준
#   DYLD_PRINT_LIBRARIES는 이 스크립트에 도달하지 못하므로 번들 Mach-O를
#   띄우기 **직전에 다시 export** 한다.
# 규칙 2 — 서버의 stderr를 파일로 돌리지 않는다. 돌리면 dyld 줄이 그 파일로
#   새고 증거에는 런처 자신의 로드 목록만 남는 **가짜 증거**가 된다
#   (Task 1 D3, Task 2가 pg_ctl start로 실물을 확인했다).
# 규칙 3 — start는 백그라운드 기동 + 준비 대기 후 exit 0 한다. run-isolated.sh는
#   자식 종료까지 블로킹하므로 포그라운드로 두면 Verify 행이 돌아오지 않는다.
# 규칙 3b — 그런데 uvicorn에는 "로그를 파일에 직접 쓰는" 옵션이 없고, 래퍼가
#   exit하면 $RUNTMP가 지워져 서버의 stderr 대상이 unlink된다. 두 규칙을 동시에
#   만족하는 형태는 계획이 적은 하나뿐이다:
#
#       "$BIN" 2> >(tee "$LOG" >&2) &
#
#   서버를 bash가 직접 exec하므로 dyld 줄이 tee를 거쳐 래퍼의 fd 2에 도달하고,
#   래퍼가 exit한 뒤에도 $LOG에 남는다. tee는 /usr/bin/tee(플랫폼 바이너리)라
#   SIP가 DYLD_*를 지워 자기 dyld 줄을 만들지 않는다 — 증거가 서버 것만으로
#   유지된다.
#   stdout은 파일로 돌린다. 측정과 무관하고(로그는 전부 stderr다), 그대로 두면
#   서버가 그 fd를 물고 있어서 `... | tail`이나 `$(...)`로 이 런처를 부른 호출이
#   영영 끝나지 않는다 (pg/run.sh가 같은 이유로 같은 처리를 한다).
# 규칙 4 — PID 파일에는 **서버 자신의 PID**를 쓴다. 위 형태에서 bash의 `$!`는
#   프로세스 치환(tee)이 아니라 백그라운드로 돌린 서버의 PID다 (bash 3.2에서
#   실측 확인). verify/t5-dyld-measured.sh가 이 PID로 dyld 줄을 검증한다.
#
# ## 데이터 안전 (스펙 §4.4)
#
# 포트는 58100이다 — 개발 기본값 8100이 아니다. 종료는 언제나 PID 파일 대상이고
# pkill/killall은 이 파일 어디에도 없다. 모델은 격리 래퍼가 주입한 HF_HOME
# (샌드박스) 아래로 받는다 — 개발자 ~/.cache/huggingface에 쓰지 않는다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

BUNDLE_PY_DIR="$EXP_ROOT/bundle/python"
BIN="$BUNDLE_PY_DIR/bin/damwha-embed"
PIDNAME=embed
HOST=127.0.0.1
PORT="$EXP_EMBED_PORT"
LOG="$SANDBOX/run/embed-stderr.txt"
OUTLOG="$SANDBOX/run/embed-stdout.txt"
STARTREC="$SANDBOX/run/embed-start.txt"
CURL=/usr/bin/curl
# 첫 기동은 bge-m3(약 2.3 GB) 다운로드와 로드를 포함한다. 1초 간격.
READY_TIMEOUT=1800
STOP_TIMEOUT=60

need_bundle() {
  [ -x "$BIN" ] \
    || exp_die "번들 콘솔 스크립트가 없다: $BIN — python/build.sh all 을 먼저 돌린다"
}

# 주입값이 실제로 실험 포트를 가리키는지 본다. 이 서비스는 명령줄로 포트를
# 바꿀 수 없으므로(위 주석), 여기가 어긋나면 개발 기본값 8100에 뜬다.
check_injected_port() {
  local got="${EMBED_SERVICE_PORT:-}"
  [ "$got" = "$PORT" ] \
    || exp_die "EMBED_SERVICE_PORT가 $PORT 가 아니라 '${got:-<unset>}' 다 — run-isolated.sh 를 통해 부른다"
  local host="${EMBED_SERVICE_HOST:-}"
  [ "$host" = "$HOST" ] \
    || exp_die "EMBED_SERVICE_HOST가 $HOST 가 아니라 '${host:-<unset>}' 다"
}

rotate() {
  [ -f "$1" ] || return 0
  mv "$1" "${1%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
}

health_ok() {
  "$CURL" -fsS --max-time 5 "http://$HOST:$PORT/health" 2>/dev/null
}

# ---------------------------------------------------------------------------
cmd_start() {
  need_bundle
  check_injected_port
  exp_ensure_sandbox
  if exp_pid_alive "$PIDNAME"; then
    echo "이미 떠 있다: pid $(cat "$(exp_pid_file "$PIDNAME")") — 새로 시작하지 않는다 (스펙 §4.4)"
    return 0
  fi
  if pid=$(exp_port_pid "$PORT"); then
    exp_die "포트 $PORT 를 다른 프로세스가 쓰고 있다 (pid $pid)"
  fi

  rotate "$LOG"
  rotate "$OUTLOG"

  # damwha_worker.config.Settings는 SettingsConfigDict(env_file=".env")라 **현재
  # 작업 디렉터리**의 .env를 읽는다. 저장소 어디에서 이 런처를 부르든 개발용
  # .env(be/.env, be/worker/.env)가 우연히 섞이지 않도록 샌드박스로 옮겨서
  # 띄운다. 이 실험이 쓰는 값은 전부 격리 래퍼가 주입한 환경 변수다.
  cd "$SANDBOX" || exp_die "샌드박스로 이동하지 못했다: $SANDBOX"

  echo "기동: $BIN"
  echo "  포트     : $HOST:$PORT"
  echo "  HF_HOME  : ${HF_HOME:-<unset>}"
  echo "  stderr   : $LOG (규칙 3b의 tee 사본)"
  echo "  stdout   : $OUTLOG"

  # 규칙 1·2·3b: exec 직전에 다시 export하고, stderr는 tee를 통해서만 지난다.
  export DYLD_PRINT_LIBRARIES=1
  "$BIN" > "$OUTLOG" 2> >(tee "$LOG" >&2) &
  # 규칙 4: 프로세스 치환이 아니라 서버 자신의 PID다.
  local srv_pid=$!
  exp_pid_write "$PIDNAME" "$srv_pid"

  local cmdline
  cmdline=$(ps -p "$srv_pid" -o command= 2>/dev/null)
  {
    echo "# embed 서비스 기동 기록 (계획 규칙 3b — 로그 위치를 \$SANDBOX/run/에 남긴다)"
    echo "utc      : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "pid      : $srv_pid"
    echo "binary   : $BIN"
    echo "cmdline  : $cmdline"
    echo "endpoint : http://$HOST:$PORT"
    echo "stderr   : $LOG"
    echo "stdout   : $OUTLOG"
    echo "hf_home  : ${HF_HOME:-<unset>}"
  } > "$STARTREC"

  echo "  pid      : $srv_pid"
  echo "  cmdline  : $cmdline"

  local i=0
  while [ "$i" -lt "$READY_TIMEOUT" ]; do
    if ! kill -0 "$srv_pid" 2>/dev/null; then
      exp_pid_clear "$PIDNAME"
      echo "--- 서버 로그 끝부분 ($LOG)" >&2
      tail -n 40 "$LOG" >&2 2>/dev/null || true
      exp_die "서버가 준비되기 전에 죽었다 (pid $srv_pid)"
    fi
    if body=$(health_ok); then
      echo "준비됨: GET /health -> $body"
      echo "ready    : yes ($(date -u '+%Y-%m-%dT%H:%M:%SZ'))" >> "$STARTREC"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "--- 서버 로그 끝부분 ($LOG)" >&2
  tail -n 40 "$LOG" >&2 2>/dev/null || true
  exp_die "준비 대기 ${READY_TIMEOUT}s 초과 — 로그: $LOG"
}

# ---------------------------------------------------------------------------
# 스펙 P0-C5b의 "SIGTERM에 종료된다"를 embed에도 같은 방식으로 적용한다.
# **SIGKILL로 올리지 않는다** — 올리면 SIGTERM이 통했는지가 증거에서 사라진다.
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

# 롤백 전용. 판정에 쓰지 않는다 (P0-C5b는 SIGTERM으로 판정한다).
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
  echo "엔드포인트    : http://$HOST:$PORT"
  if exp_pid_alive "$PIDNAME"; then
    local pid
    pid=$(cat "$(exp_pid_file "$PIDNAME")")
    echo "상태          : 살아 있음 (pid $pid)"
    echo "  cmdline     : $(ps -p "$pid" -o command= 2>/dev/null)"
  else
    echo "상태          : 떠 있지 않음"
  fi
  if body=$(health_ok); then
    echo "/health       : $body"
  else
    echo "/health       : 응답 없음"
  fi
  [ -f "$STARTREC" ] && { echo "기동 기록     : $STARTREC"; sed 's/^/  /' "$STARTREC"; }
  return 0
}

case "${1:-}" in
  start)  shift; cmd_start  "$@" ;;
  stop)   shift; cmd_stop   "$@" ;;
  kill)   shift; cmd_kill   "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) echo "usage: embed.sh {start|stop|kill|status}" >&2; exit 2 ;;
esac
