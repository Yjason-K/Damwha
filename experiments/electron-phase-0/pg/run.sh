#!/bin/bash
# 번들 PostgreSQL의 수명 관리 (스펙 P0-C1, §4.4).
#
#   run.sh initdb   $SANDBOX/pgdata 를 초기화한다 (이미 있으면 아무것도 하지 않는다)
#   run.sh start    포트 55432로 기동하고 준비될 때까지 기다린 뒤 exit 0
#   run.sh stop     pg_ctl stop -m fast
#   run.sh kill     PID 파일의 프로세스에만 SIGKILL (crash recovery 검증용)
#   run.sh status   상태 출력
#
# 이 스크립트는 **격리 대상**이다. run-isolated.sh를 통해 부른다:
#   bash lib/run-isolated.sh --label t2-start -- pg/run.sh start
#
# ## dyld 실측 규칙 (계획 "런처 스크립트의 dyld 실측 규칙")
#
# 규칙 1 — SIP는 /bin/bash를 exec할 때마다 환경에서 DYLD_*를 지운다. 그래서
#   래퍼가 넘겨 준 DYLD_PRINT_LIBRARIES는 이 스크립트에 도달하지 못한다.
#   번들 Mach-O를 띄우기 **직전에 다시 export** 해야 실측이 산다. 조건부로
#   할 방법이 없다 — 이 스크립트는 원래 값이 있었는지 알 수 없기 때문이다.
# 규칙 2·2b — 그 프로세스의 stderr를 리다이렉트하지 않는다. `pg_ctl start`는
#   -l 유무와 무관하게 쓰지 않는다. pg_ctl은 내부에서
#   /bin/sh -c "exec postgres ... 2>&1 &" 로 띄우므로 (1) SIP가 그 /bin/sh에서
#   DYLD_*를 지우고 (2) 서버 stderr가 stdout으로 합쳐져 fd 2만 캡처하는 래퍼에
#   들어오지 않는다. 실측 결과는 $EVIDENCE/t2-pgctl-trial-*.txt 에 있다.
#   **postgres를 직접 백그라운드로 띄운다.** pg_ctl stop / pg_isready는 측정
#   대상이 아니므로 쓴다.
# 규칙 3 — start는 백그라운드 기동 + 준비 대기 후 exit 0 한다. run-isolated.sh는
#   자식 종료까지 블로킹하고 증거도 그 뒤에 쓰므로 포그라운드로 두면 Verify
#   행이 영영 돌아오지 않는다. 준비가 끝난 시점이면 서버의 초기 로드 dyld 줄은
#   이미 전부 래퍼의 fd 2 캡처에 담겨 있다.
# 규칙 3b — 그 뒤의 서버 로그는 서버 자신이 파일에 쓰게 한다(logging_collector).
#   래퍼가 exit하면 $RUNTMP가 지워져 서버 stderr가 unlink된 파일로 사라지기
#   때문이다. 대신 백엔드가 확장을 dlopen할 때의 dyld 줄도 그 로그로 가므로,
#   verify/t2-extensions.sh가 그것을 별도 증거 파일로 옮긴다.
# 규칙 4 — PID 파일에는 **postgres 자신의 PID**를 쓴다. 래퍼 bash가 아니다.
#   bash가 & 로 띄운 자식은 fork+exec된 postgres 자신이므로 $! 가 그 PID다.
#   verify/t2-dyld-measured.sh가 이 PID로 dyld 줄을 검증한다.
#
# ## 데이터 안전 (스펙 §4.4)
#
# 데이터 디렉터리는 $SANDBOX/pgdata이고 포트는 55432다. 개발 인스턴스(5432,
# damwha_pgdata 볼륨, damwha-postgres 컨테이너)를 참조하지도 건드리지도 않는다.
# 종료는 언제나 PID 파일 대상이다 — pkill/killall은 이 파일 어디에도 없다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

BUNDLE="$EXP_ROOT/bundle/pg"
PGBIN="$BUNDLE/bin"
PGDATA="$SANDBOX/pgdata"
PIDNAME=pg
PGHOST=127.0.0.1
PGUSER=postgres
PGDB=damwha
READY_TIMEOUT=60   # 0.5초 간격

need_bundle() {
  [ -x "$PGBIN/postgres" ] || exp_die "번들이 없다: $PGBIN/postgres — pg/build.sh 를 먼저 돌린다"
}

initialized() { [ -f "$PGDATA/PG_VERSION" ]; }

# ---------------------------------------------------------------------------
cmd_initdb() {
  need_bundle
  exp_ensure_sandbox
  if initialized; then
    echo "이미 초기화돼 있다: $PGDATA (다시 initdb 하지 않는다 — 스펙 §4.4 멱등)"
    echo "  PG_VERSION: $(cat "$PGDATA/PG_VERSION")"
    return 0
  fi
  if exp_pid_alive "$PIDNAME"; then
    exp_die "서버가 살아 있다 (pid $(cat "$(exp_pid_file "$PIDNAME")")) — stop 을 먼저 부른다"
  fi
  mkdir -p "$PGDATA"
  chmod 700 "$PGDATA"
  echo "initdb: $PGDATA"
  # 규칙 1: 번들 Mach-O를 부르기 직전에 다시 export 한다.
  export DYLD_PRINT_LIBRARIES=1
  # --auth=trust: 실험 DB에는 비밀번호가 없다(스펙 §4.2의 DATABASE_URL이
  #   postgres@127.0.0.1). listen_addresses를 127.0.0.1로 묶고 Unix 소켓을 끄므로
  #   외부에서 붙을 수 없다. **Phase 3의 앱은 이 설정을 그대로 쓰면 안 된다** —
  #   여기서 검증하는 것은 인증이 아니라 번들 기동이다.
  # --locale=C: --without-icu로 빌드했으므로 libc 제공자를 쓴다. env -i 아래에서
  #   LANG이 없어 어차피 C가 되며, 회차마다 같은 결과를 얻으려고 못 박는다.
  "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER" -E UTF8 --locale=C \
      --auth=trust --auth-local=trust --auth-host=trust \
    || exp_die "initdb 실패"
  write_conf
  echo "initdb 완료"
}

# postgresql.conf에 실험용 설정을 한 번만 덧붙인다 (재실행해도 중복되지 않는다).
write_conf() {
  local conf="$PGDATA/postgresql.conf"
  local marker="# --- damwha phase 0 experiment (pg/run.sh) ---"
  if grep -qF "$marker" "$conf" 2>/dev/null; then
    return 0
  fi
  {
    echo ""
    echo "$marker"
    echo "listen_addresses = '127.0.0.1'"
    echo "port = $EXP_PG_PORT"
    # Unix 소켓을 끈다. $SANDBOX/run 은 절대 경로가 92자라 소켓 파일명을 붙이면
    # macOS의 sun_path 한계(104바이트)를 넘는다. 클라이언트는 전부 TCP
    # 127.0.0.1:55432로 붙으므로 소켓이 필요 없고, /tmp에 소켓을 만들지 않아
    # 샌드박스 밖에 파일을 남기지도 않는다.
    echo "unix_socket_directories = ''"
    # 규칙 3b: 기동 이후의 로그는 서버가 직접 파일에 쓴다. 확장자를 .txt로 두는
    # 것은 이 저장소의 증거 규약(.log는 루트 .gitignore에 걸린다)과 맞추기
    # 위해서다 — 이 로그에서 dyld 줄을 증거로 옮긴다.
    echo "logging_collector = on"
    echo "log_directory = 'log'"
    echo "log_filename = 'server-%Y%m%d-%H%M%S.txt'"
    echo "log_line_prefix = '%m [%p] '"
    echo "log_min_messages = info"
  } >> "$conf"
}

# ---------------------------------------------------------------------------
cmd_start() {
  need_bundle
  exp_ensure_sandbox
  initialized || exp_die "초기화되지 않았다: $PGDATA — run.sh initdb 를 먼저 부른다"
  write_conf
  if exp_pid_alive "$PIDNAME"; then
    echo "이미 떠 있다: pid $(cat "$(exp_pid_file "$PIDNAME")") — 새로 시작하지 않는다 (스펙 §4.4)"
    return 0
  fi
  # 남의 프로세스가 55432를 물고 있으면 기동하지 않는다.
  if pid=$(exp_port_pid "$EXP_PG_PORT"); then
    exp_die "포트 $EXP_PG_PORT 를 다른 프로세스가 쓰고 있다 (pid $pid)"
  fi

  # 규칙 1·2·2b: exec 직전에 다시 export하고, **stderr는 건드리지 않는다**.
  #
  # stdout만 파일로 돌린다. 서버는 stdout에 아무것도 쓰지 않지만(로그는 전부
  # stderr다) fd 자체는 물고 있는다. 이 스크립트를 파이프로 받는 호출
  # (`... | tail`, `$(...)`)에서 그 열린 fd 때문에 파이프가 EOF에 닿지 않아
  # 호출자가 영영 끝나지 않는다 — 규칙 3("start는 exit 0 하고 돌아온다")이
  # 래퍼 안에서는 지켜지는데 파이프를 태우는 순간 깨지는 형태다. stderr를
  # 돌리면 규칙 2 위반이자 dyld 실측이 통째로 사라지지만, stdout은 측정과
  # 무관하므로 여기를 돌린다.
  export DYLD_PRINT_LIBRARIES=1
  "$PGBIN/postgres" -D "$PGDATA" -p "$EXP_PG_PORT" > "$SANDBOX/run/pg-stdout.txt" &
  local pg_pid=$!
  # 규칙 4: 래퍼 bash가 아니라 postgres 자신의 PID다.
  exp_pid_write "$PIDNAME" "$pg_pid"
  echo "postgres 기동: pid $pg_pid  port $EXP_PG_PORT  data $PGDATA"

  local i=0
  while [ "$i" -lt "$READY_TIMEOUT" ]; do
    if ! kill -0 "$pg_pid" 2>/dev/null; then
      exp_pid_clear "$PIDNAME"
      exp_die "postgres가 준비되기 전에 죽었다 — 서버 로그: $PGDATA/log/"
    fi
    if "$PGBIN/pg_isready" -h "$PGHOST" -p "$EXP_PG_PORT" -q; then
      echo "준비됨 (pg_isready)"
      ensure_db
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  exp_die "준비 대기 시간 초과 — 서버 로그: $PGDATA/log/"
}

# 실험 DB(damwha)를 만든다. 스펙 §4.2의 DATABASE_URL이 이 이름을 가리키고,
# 마이그레이션과 Verify가 전부 여기 붙는다. 이미 있으면 아무것도 하지 않는다.
ensure_db() {
  local n
  n=$("$PGBIN/psql" -h "$PGHOST" -p "$EXP_PG_PORT" -U "$PGUSER" -d postgres -tAc \
        "SELECT count(*) FROM pg_database WHERE datname = '$PGDB'" 2>/dev/null)
  if [ "$n" = "1" ]; then
    echo "데이터베이스 $PGDB 있음"
  else
    "$PGBIN/createdb" -h "$PGHOST" -p "$EXP_PG_PORT" -U "$PGUSER" "$PGDB" \
      || exp_die "createdb $PGDB 실패"
    echo "데이터베이스 $PGDB 생성"
  fi
}

# ---------------------------------------------------------------------------
cmd_stop() {
  need_bundle
  if ! exp_pid_alive "$PIDNAME"; then
    echo "떠 있지 않다 (남은 PID 파일이 있으면 지운다)"
    exp_pid_clear "$PIDNAME"
    return 0
  fi
  local pid
  pid=$(cat "$(exp_pid_file "$PIDNAME")")
  # pg_ctl stop은 postmaster.pid를 읽어 신호를 보낼 뿐이고 측정 대상이 아니다.
  "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop || exp_die "pg_ctl stop 실패 (pid $pid)"
  exp_pid_clear "$PIDNAME"
  echo "정지 완료 (pid $pid)"
}

# ---------------------------------------------------------------------------
# crash recovery 검증용. **PID 파일의 프로세스와 그 자식들만** 죽인다.
#
# postmaster만 SIGKILL하면 checkpointer·walwriter 같은 보조 프로세스가 살아남아
# 공유 메모리를 계속 붙들고, 다음 기동이 "pre-existing shared memory block is
# still in use"로 거절된다. 그것은 crash가 아니라 반쯤 죽은 상태다. 그래서
# postmaster를 죽이기 **전에** 자식 목록을 PPID로 뽑아 두고 함께 SIGKILL한다.
# 이름으로 찾지 않는다 — 기준은 언제나 PID 파일의 PID다 (스펙 §4.4).
cmd_kill() {
  exp_pid_alive "$PIDNAME" || exp_die "떠 있지 않다 — kill 할 대상이 없다"
  local pid children c
  pid=$(cat "$(exp_pid_file "$PIDNAME")")
  children=$(ps -ax -o pid=,ppid= | awk -v p="$pid" '$2 == p { print $1 }')
  echo "SIGKILL: postmaster pid $pid"
  kill -9 "$pid" 2>/dev/null || true
  for c in $children; do
    echo "SIGKILL: 자식 pid $c (postmaster의 보조 프로세스)"
    kill -9 "$c" 2>/dev/null || true
  done
  local i=0
  while [ "$i" -lt 40 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
    i=$((i + 1))
  done
  kill -0 "$pid" 2>/dev/null && exp_die "SIGKILL 후에도 살아 있다: $pid"
  exp_pid_clear "$PIDNAME"
  echo "강제 종료 완료"
}

# ---------------------------------------------------------------------------
cmd_status() {
  echo "번들      : $BUNDLE"
  [ -x "$PGBIN/postgres" ] && "$PGBIN/postgres" --version | sed 's/^/  /'
  echo "데이터    : $PGDATA (초기화됨: $(initialized && echo yes || echo no))"
  echo "포트      : $EXP_PG_PORT"
  if exp_pid_alive "$PIDNAME"; then
    echo "상태      : 살아 있음 (pid $(cat "$(exp_pid_file "$PIDNAME")"))"
  else
    echo "상태      : 떠 있지 않음"
  fi
  if [ -x "$PGBIN/pg_isready" ]; then
    "$PGBIN/pg_isready" -h "$PGHOST" -p "$EXP_PG_PORT" | sed 's/^/  /'
  fi
}

case "${1:-}" in
  initdb) shift; cmd_initdb "$@" ;;
  start)  shift; cmd_start  "$@" ;;
  stop)   shift; cmd_stop   "$@" ;;
  kill)   shift; cmd_kill   "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) echo "usage: run.sh {initdb|start|stop|kill|status}" >&2; exit 2 ;;
esac
