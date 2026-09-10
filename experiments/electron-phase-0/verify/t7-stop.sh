#!/bin/bash
# 계획 Task 7 Interfaces — "**Verify 끝에 PID 파일 대상으로 내린다.**"
#
# ## 왜 별도 스크립트인가
#
# 계획 Task 7 의 Verify 표(V1~V10)에는 이 행이 없다. Interfaces 절이 Task 7 에
# 기동·정지 책임을 주면서 "Task 6 의 Verify 표에 기동·정지 행이 둘 다 없어
# V1 이 두 런처를 스스로 부르고 아무도 내리지 않았다(verifier 가 손으로
# 내렸다)"를 그 근거로 들었는데, 정작 Task 7 의 표에도 정지 행이 없다.
#
# 기동은 드라이버가 V2 안에서 한다(그 자리가 있다). 정지는 둘 중 하나여야 하는데
# — 표에 행을 더하거나, 기존 행 하나가 겸하거나 — 후자는 "개발 경로가 0건인가"
# 같은 검사에 서비스 종료를 숨기는 형태라 리뷰에서 읽히지 않는다. 그래서
# **독립 스크립트로 두고 표에 행이 필요하다는 사실을 보고**한다. 계획 수정은
# 이 Task 가 하지 않는다.
#
# ## 무엇을 죽이는가
#
# `$SANDBOX/run/pg.pid` 가 가리키는 프로세스뿐이다. `pg/run.sh stop` 이
# `pg_ctl -m fast stop` 을 부르고 PID 파일을 지운다. **이름으로 죽이는 명령
# (pkill/killall)은 이 하네스 어디에도 없다** — 개발용 Docker Postgres 나
# 사용자의 다른 작업을 같이 죽이기 때문이다 (스펙 §4.4).
#
# 떠 있지 않으면 아무것도 하지 않고 exit 0 이다 (멱등, 스펙 §4.4).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t7-lib.sh"

OUT=$(t7_evidence_path "t7-stop.txt")

PIDFILE=$(exp_pid_file pg)
BEFORE_PID=""
[ -f "$PIDFILE" ] && BEFORE_PID=$(cat "$PIDFILE" 2>/dev/null)

REPORT=$(
  echo "== 정지 대상 (PID 파일 하나가 유일한 기준이다 — 스펙 §4.4)"
  echo "  PID 파일 : $PIDFILE"
  echo "  기록된 PID: ${BEFORE_PID:-없음}"
  if ! exp_pid_alive pg; then
    echo "  떠 있지 않다 — 아무것도 하지 않는다 (멱등)"
    exp_pid_clear pg
    echo "RC_STOP=0"
  else
    echo "  살아 있음 — pg/run.sh stop (pg_ctl -m fast stop)"
    if bash "$PG_RUN" stop 2>&1 | sed 's/^/    /'; then
      echo "RC_STOP=0"
    else
      echo "  FAIL pg/run.sh stop 이 실패했다"
      echo "RC_STOP=1"
    fi
  fi

  echo
  echo "== 정지 확인"
  if [ -n "$BEFORE_PID" ] && kill -0 "$BEFORE_PID" 2>/dev/null; then
    echo "  FAIL pid $BEFORE_PID 가 아직 살아 있다"
    echo "RC_DEAD=1"
  else
    echo "  OK   pid ${BEFORE_PID:-none} 가 살아 있지 않다"
    echo "RC_DEAD=0"
  fi
  if pid=$(exp_port_pid "$EXP_PG_PORT"); then
    echo "  FAIL 포트 $EXP_PG_PORT 를 아직 누가 물고 있다 (pid $pid)"
    echo "RC_PORT=1"
  else
    echo "  OK   포트 $EXP_PG_PORT 가 비었다"
    echo "RC_PORT=0"
  fi
  if [ -f "$PIDFILE" ]; then
    echo "  FAIL PID 파일이 남아 있다: $PIDFILE"
    echo "RC_PIDFILE=1"
  else
    echo "  OK   PID 파일이 지워졌다"
    echo "RC_PIDFILE=0"
  fi

  echo
  echo "== 개발 인스턴스는 건드리지 않았다"
  echo "  이 스크립트가 다룬 것은 위 PID 하나뿐이다. pkill/killall 은 쓰지 않는다."
  echo "  개발용 Postgres 는 5432 / damwha_pgdata 볼륨이며 이 경로 어디에도 없다."
)

printf '%s\n' "$REPORT" | grep -v '^RC_'

FAIL=0
for k in RC_STOP RC_DEAD RC_PORT RC_PIDFILE; do
  v=$(printf '%s\n' "$REPORT" | sed -n "s/^$k=//p" | tail -n 1)
  [ "$v" = "0" ] || FAIL=1
done

{
  echo "# Task 7 — 실험 PostgreSQL 정지 (계획 Task 7 Interfaces, 스펙 §4.4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 정지가 끝나지 않았다"; exit 1; }
echo "판정: PID 파일의 프로세스가 내려갔고 포트 $EXP_PG_PORT 가 비었다"
exit 0
