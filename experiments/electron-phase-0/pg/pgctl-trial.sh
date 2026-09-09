#!/bin/bash
# 계획 규칙 2b의 **실측** — `pg_ctl start`를 쓰면 dyld 실측을 정말로 잃는가.
#
# 계획을 쓴 시점에는 번들 pg_ctl이 없어 재지 못했고, "Task 2 착수 시 이 동작을
# 번들 pg_ctl로 한 번 확인하고 결과를 증거에 남긴다"가 숙제로 남았다. 이
# 스크립트가 그 한 번이다.
#
#   bash lib/run-isolated.sh --label t2-pgctl-trial -- pg/pgctl-trial.sh
#
# 재는 방식은 pg/run.sh의 start와 **한 가지만** 다르다. 규칙 1(exec 직전 재
# export)은 똑같이 지키고, 서버를 띄우는 방법만 `pg_ctl start`로 바꾼다. 그래야
# 차이의 원인이 pg_ctl 하나로 좁혀진다. -l 도 쓰지 않는다 — -l 없이도 결과가
# 같다는 것이 규칙 2b의 주장이기 때문이다.
#
# ## 소유권 분리 (계획 Task 2 인터페이스)
#
# 여기서 뜨는 postgres는 $SANDBOX/run/pg.pid 밖의 프로세스다. 그래서
#   - 데이터 디렉터리를 따로 쓴다 ($SANDBOX/pgdata-pgctl-trial)
#   - pg.pid에 쓰지 않는다 (쓰면 run.sh stop/kill이 남의 프로세스를 잡는다)
#   - 이 스크립트가 자기가 띄운 것을 자기가 pg_ctl stop으로 내린다
#   - 본 서버가 떠 있으면 아예 시작하지 않는다
#
# logging_collector는 **끈다**. 켜면 서버 stderr가 로그 파일로 가서 "dyld 줄이
# 없는 이유"가 둘로 늘어난다. 이 실측이 좁히려는 원인은 pg_ctl 하나뿐이다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

BUNDLE="$EXP_ROOT/bundle/pg"
PGBIN="$BUNDLE/bin"
TRIALDATA="$SANDBOX/pgdata-pgctl-trial"
OUT="$EVIDENCE/t2-pgctl-trial.txt"
STDOUT_CAP="$SANDBOX/run/pgctl-trial-stdout.txt"

[ -x "$PGBIN/pg_ctl" ] || exp_die "번들이 없다: $PGBIN/pg_ctl"
exp_ensure_sandbox

if exp_pid_alive pg; then
  exp_die "본 서버가 떠 있다 (pid $(cat "$(exp_pid_file pg)")) — 이 시험은 서버가 없을 때만 한다"
fi
if pid=$(exp_port_pid "$EXP_PG_PORT"); then
  exp_die "포트 $EXP_PG_PORT 가 이미 쓰이고 있다 (pid $pid)"
fi

PG_PID_FILE_BEFORE="없음"
[ -f "$(exp_pid_file pg)" ] && PG_PID_FILE_BEFORE=$(cat "$(exp_pid_file pg)")

rm -rf "$TRIALDATA"
mkdir -p "$TRIALDATA"
chmod 700 "$TRIALDATA"
"$PGBIN/initdb" -D "$TRIALDATA" -U postgres -E UTF8 --locale=C --auth=trust \
  > "$SANDBOX/run/pgctl-trial-initdb.txt" 2>&1 \
  || { tail -n 20 "$SANDBOX/run/pgctl-trial-initdb.txt"; exp_die "시험용 initdb 실패"; }
{
  echo "listen_addresses = '127.0.0.1'"
  echo "port = $EXP_PG_PORT"
  echo "unix_socket_directories = ''"
  echo "logging_collector = off"
} >> "$TRIALDATA/postgresql.conf"

# 규칙 1은 지킨다 — 그래도 결과가 같은지를 보는 것이 이 시험의 요지다.
export DYLD_PRINT_LIBRARIES=1
echo "pg_ctl start (-l 없이) 를 시험한다: $TRIALDATA"
# **stdout만** 파일로 돌린다. stderr는 건드리지 않는다(규칙 2) — 그래야
# pg_ctl 자신의 dyld 줄이 래퍼의 fd 2 캡처로 가고, 그 옆에서 postmaster의
# 줄이 하나도 없다는 사실이 의미를 갖는다. stdout을 잡는 이유는 반대다:
# pg_ctl이 /bin/sh -c "... 2>&1 &" 로 띄우는 바람에 **서버의 stderr가 여기로
# 합쳐져 나오는지**를 봐야 하기 때문이다.
: > "$STDOUT_CAP"
"$PGBIN/pg_ctl" -D "$TRIALDATA" start > "$STDOUT_CAP"
PGCTL_RC=$?

TRIAL_PID=""
[ -f "$TRIALDATA/postmaster.pid" ] && TRIAL_PID=$(head -n 1 "$TRIALDATA/postmaster.pid")

sleep 2
# 여기서도 stderr는 잡지 않는다 (dyld 줄은 래퍼로 가야 한다).
STOP_OUT=$("$PGBIN/pg_ctl" -D "$TRIALDATA" -m fast stop)
STOP_RC=$?

PG_PID_FILE_AFTER="없음"
[ -f "$(exp_pid_file pg)" ] && PG_PID_FILE_AFTER=$(cat "$(exp_pid_file pg)")

{
  echo "# Task 2 V2c — 번들 pg_ctl start 시험 실행 (계획 규칙 2b의 실측)"
  echo "# 이 파일은 pg/pgctl-trial.sh가 생성한다. dyld 실측 자체는 옆 파일에 있다:"
  echo "#   $EVIDENCE/t2-pgctl-trial-dyld.txt (run-isolated.sh가 fd 2에서 캡처)"
  echo "utc                    : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "격리 대상              : 예 (run-isolated.sh를 지난다)"
  echo "데이터 디렉터리        : $TRIALDATA  (본 서버의 $SANDBOX/pgdata 가 아니다)"
  echo "규칙 1(재 export)      : 지켰다 — 차이의 원인을 pg_ctl 하나로 좁히기 위해"
  echo "-l 옵션                : 쓰지 않았다"
  echo "logging_collector      : off"
  echo "pg_ctl start exit      : $PGCTL_RC"
  echo "시험 postmaster PID    : ${TRIAL_PID:-없음}"
  echo "pg_ctl stop exit       : $STOP_RC"
  echo
  echo "## PID 파일 소유권 (스펙 §4.4)"
  echo "이 시험이 띄운 프로세스는 $SANDBOX/run/pg.pid 에 **쓰이지 않는다**."
  echo "시험 전 pg.pid : $PG_PID_FILE_BEFORE"
  echo "시험 후 pg.pid : $PG_PID_FILE_AFTER"
  echo
  echo "## pg_ctl의 stdout **만** (stderr는 리다이렉트하지 않았다 — 규칙 2)"
  echo "# pg_ctl은 내부에서 /bin/sh -c \"exec postgres ... 2>&1 &\" 로 띄우므로"
  echo "# 서버의 stderr가 stdout으로 합쳐진다. fd 2만 캡처하는 래퍼에는 들어오지 않는다."
  sed 's/^/  /' "$STDOUT_CAP"
  echo
  echo "## pg_ctl stop 출력"
  printf '%s\n' "$STOP_OUT" | sed 's/^/  /'
} | exp_scrub > "$OUT"

cat "$OUT"
rm -rf "$TRIALDATA"
echo "시험용 데이터 디렉터리를 지웠다: $TRIALDATA"
[ "$PGCTL_RC" -eq 0 ] || exp_die "pg_ctl start 자체가 실패했다 — 시험이 성립하지 않는다"
[ "$STOP_RC" -eq 0 ]  || exp_die "pg_ctl stop 실패 — 시험 프로세스가 남았을 수 있다"
exit 0
