#!/bin/bash
# 계획 Task 2 V2c — 기동 경로에 `pg_ctl start`가 없고, 왜 없어야 하는지가
# 실측으로 뒷받침되는가 (계획 규칙 2b).
#
# 두 가지를 본다.
#   A. 정적 — pg/run.sh의 기동 경로가 postgres를 직접 띄운다. 주석을 걷어낸
#      본문에 `pg_ctl ... start`가 없다. (stop/isready는 측정 대상이 아니라
#      써도 된다.)
#   B. 실측 — pg/pgctl-trial.sh가 번들 pg_ctl로 실제로 한 번 띄워 본 결과가
#      증거에 있고, 그 결과가 "dyld 실측을 잃는다"를 실제로 보여 준다:
#        - pg_ctl 자신의 dyld 줄은 남는다 (런처는 측정된다)
#        - **시험 postmaster의 pid로는 dyld 줄이 한 줄도 없다** (측정 상실)
#        - 서버 로그가 pg_ctl의 stdout으로 나온다 (stderr가 stdout에 합쳐졌다)
#      계획을 쓸 때는 번들 pg_ctl이 없어 재지 못했던 부분이다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
RUN_SH="$EXP_ROOT/pg/run.sh"
TRIAL_TXT="$EVIDENCE/t2-pgctl-trial.txt"
TRIAL_DYLD="$EVIDENCE/t2-pgctl-trial-dyld.txt"

echo "== A. 정적 — pg/run.sh의 기동 경로"
[ -f "$RUN_SH" ] || { echo "  FAIL $RUN_SH 가 없다"; exit 1; }

# 주석을 걷어낸 본문만 본다. 주석에는 "pg_ctl start를 쓰지 않는다"는 설명이
# 들어 있어서, 걷어내지 않으면 그 설명이 위반으로 잡힌다.
CODE=$(sed 's/#.*$//' "$RUN_SH")
if printf '%s\n' "$CODE" | grep -q 'pg_ctl[^|]*start'; then
  echo "  FAIL 기동에 pg_ctl start를 쓰고 있다:"
  printf '%s\n' "$CODE" | grep -n 'pg_ctl[^|]*start' | sed 's/^/       /'
  FAIL=1
else
  echo "  OK   본문에 pg_ctl ... start 가 없다"
fi
if printf '%s\n' "$CODE" | grep -q '"\$PGBIN/postgres" -D .*&'; then
  echo "  OK   postgres를 직접 백그라운드로 띄운다"
else
  echo "  FAIL postgres를 직접 띄우는 줄을 찾지 못했다"
  FAIL=1
fi
if printf '%s\n' "$CODE" | grep -q 'export DYLD_PRINT_LIBRARIES=1'; then
  echo "  OK   번들 Mach-O를 부르기 전에 DYLD_PRINT_LIBRARIES를 다시 export한다 (규칙 1)"
else
  echo "  FAIL exec 직전 re-export가 없다 (규칙 1)"
  FAIL=1
fi
# 규칙 2: 서버의 stderr를 파일이나 /dev/null로 돌리면 실측이 통째로 사라진다.
if printf '%s\n' "$CODE" | grep -q '"\$PGBIN/postgres" -D [^&]*2>'; then
  echo "  FAIL postgres의 stderr를 리다이렉트하고 있다 (규칙 2)"
  FAIL=1
else
  echo "  OK   postgres의 stderr를 리다이렉트하지 않는다 (규칙 2)"
fi

echo
echo "== B. 실측 — 번들 pg_ctl start 시험 실행"
if [ ! -f "$TRIAL_TXT" ] || [ ! -f "$TRIAL_DYLD" ]; then
  echo "  FAIL 시험 증거가 없다. 서버가 떠 있지 않은 상태에서 아래를 한 번 돌린다:"
  echo "       bash experiments/electron-phase-0/lib/run-isolated.sh \\"
  echo "            --label t2-pgctl-trial -- experiments/electron-phase-0/pg/pgctl-trial.sh"
  exit 1
fi

TRIAL_PID=$(sed -n 's/^시험 postmaster PID *: *//p' "$TRIAL_TXT" | head -n 1 | tr -d ' ')
case "$TRIAL_PID" in
  ''|*[!0-9]*) echo "  FAIL 증거에서 시험 postmaster PID를 읽지 못했다"; exit 1 ;;
esac
echo "  시험 postmaster PID : $TRIAL_PID"
echo "  증거의 dyld pid     : $(t2_dyld_pids "$TRIAL_DYLD")"

N=$(t2_dyld_lines "$TRIAL_DYLD")
if [ "$N" -ge 1 ]; then
  echo "  OK   dyld 줄 ${N}건이 남았다 — 줄 수만 보면 통과처럼 보이는 형태다"
else
  echo "  FAIL dyld 줄이 0건이다 — 이 시험의 전제(런처 자신은 측정된다)가 깨졌다"
  FAIL=1
fi

PGCTL_LOADS=$(awk -v b="$BUNDLE_PG/bin/pg_ctl" '/^dyld\[/ && $NF == b { n++ } END { print n + 0 }' "$TRIAL_DYLD")
if [ "$PGCTL_LOADS" -ge 1 ]; then
  echo "  OK   번들 pg_ctl 자신은 ${PGCTL_LOADS}번 측정됐다 (런처는 측정된다)"
else
  echo "  FAIL 번들 pg_ctl의 로드 줄이 없다 — 시험이 성립하지 않는다"
  FAIL=1
fi

SERVER_LINES=$(t2_dyld_pid_loads_under "$TRIAL_DYLD" "$TRIAL_PID" "/")
if [ "$SERVER_LINES" -eq 0 ]; then
  echo "  OK   시험 postmaster(pid $TRIAL_PID)의 dyld 줄은 **0건**이다 —"
  echo "       pg_ctl이 /bin/sh -c \"exec postgres ... 2>&1 &\" 로 띄우는 바람에"
  echo "       SIP가 그 /bin/sh에서 DYLD_*를 지웠다. 규칙 2b가 실측으로 확인됐다."
else
  echo "  FAIL 시험 postmaster의 dyld 줄이 ${SERVER_LINES}건 있다 —"
  echo "       규칙 2b의 근거가 이 머신에서 성립하지 않는다. 계획을 다시 재야 한다."
  FAIL=1
fi

if grep -q 'database system is ready to accept connections' "$TRIAL_TXT"; then
  echo "  OK   서버 로그가 pg_ctl의 **stdout**에 섞여 나왔다 — stderr가 stdout으로 합쳐진다"
else
  echo "  FAIL stdout 캡처에 서버 기동 로그가 없다 — 시험이 성립하지 않는다"
  FAIL=1
fi

# 소유권 분리 (스펙 §4.4 PID 파일 규약)
if grep -q '시험 후 pg.pid : 없음' "$TRIAL_TXT" || \
   ! grep -q "시험 후 pg.pid : $TRIAL_PID" "$TRIAL_TXT"; then
  echo "  OK   시험 프로세스의 PID가 pg.pid에 들어가지 않았다"
else
  echo "  FAIL 시험 프로세스의 PID가 pg.pid에 들어갔다 — run.sh stop/kill이 남의 프로세스를 잡는다"
  FAIL=1
fi
if t2_server_alive && [ "$(t2_server_pid)" = "$TRIAL_PID" ]; then
  echo "  FAIL 지금 pg.pid가 시험 프로세스의 PID와 같다"
  FAIL=1
fi

echo
[ "$FAIL" -eq 0 ] && echo "판정: 기동 경로에 pg_ctl start가 없고, 그래야 하는 이유가 실측으로 남았다" \
                  || echo "판정: 조건을 만족하지 못했다"
exit $FAIL
