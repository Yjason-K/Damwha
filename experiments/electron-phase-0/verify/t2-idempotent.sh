#!/bin/bash
# 계획 Task 2 V8 — run.sh initdb를 다시 불러도 데이터 디렉터리를 재초기화하지
# 않는가 (스펙 §4.4의 재실행 멱등).
#
# "명령이 exit 0이었다"는 증거가 아니다. 재초기화가 일어났는지 아닌지는
# **클러스터의 신원**으로 본다 — pg_controldata의 Database system identifier는
# initdb가 만들 때 정해지고 다시 initdb하면 반드시 바뀐다. 그래서 그 값과
# _migrations 행 수를 앞뒤로 대조한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
CTL="$BUNDLE_PG/bin/pg_controldata"

echo "== 사전 상태"
t2_require_server t2-idempotent-pre || { echo "  FAIL 서버를 띄우지 못했다"; exit 1; }
FILES=$(t2_migration_file_count)
BEFORE=$(t2_migrations_applied)
SYSID_BEFORE=$("$CTL" -D "$PGDATA" | sed -n 's/^Database system identifier: *//p')
PID_BEFORE=$(t2_server_pid)
echo "  _migrations $BEFORE / system identifier $SYSID_BEFORE / pid $PID_BEFORE"
if [ "$BEFORE" != "$FILES" ]; then
  echo "  FAIL 시작 시점부터 _migrations($BEFORE)가 파일 수($FILES)와 다르다 — V4를 먼저 돌린다"
  exit 1
fi

echo
echo "== run.sh initdb 재호출 (run-isolated.sh --label t2-initdb-again)"
OUT=$(bash "$RUN_ISO" --label t2-initdb-again -- "$PG_RUN" initdb 2>&1); RC=$?
printf '%s\n' "$OUT" | grep -v '^run-isolated:' | sed 's/^/  /'
[ "$RC" -eq 0 ] && echo "  OK   exit 0" || { echo "  FAIL exit $RC"; FAIL=1; }
if printf '%s\n' "$OUT" | grep -q '이미 초기화돼 있다'; then
  echo "  OK   이미 초기화됐다고 판단하고 아무것도 하지 않았다"
else
  echo "  FAIL 멱등 경로를 타지 않았다"
  FAIL=1
fi

echo
echo "== 사후 상태"
SYSID_AFTER=$("$CTL" -D "$PGDATA" | sed -n 's/^Database system identifier: *//p')
AFTER=$(t2_migrations_applied)
PID_AFTER=$(t2_server_pid)
echo "  _migrations $AFTER / system identifier $SYSID_AFTER / pid $PID_AFTER"
[ "$SYSID_AFTER" = "$SYSID_BEFORE" ] \
  && echo "  OK   클러스터가 재초기화되지 않았다 (system identifier 동일)" \
  || { echo "  FAIL system identifier가 바뀌었다 — 데이터 디렉터리가 다시 만들어졌다"; FAIL=1; }
[ "$AFTER" = "$FILES" ] && echo "  OK   _migrations가 $FILES 로 유지됐다" \
  || { echo "  FAIL _migrations가 $AFTER 다"; FAIL=1; }
[ "$PID_AFTER" = "$PID_BEFORE" ] && echo "  OK   서버 프로세스가 그대로다 (pid $PID_AFTER)" \
  || { echo "  FAIL 서버 pid가 바뀌었다"; FAIL=1; }
t2_server_alive && echo "  OK   서버가 계속 살아 있다" || { echo "  FAIL 서버가 죽었다"; FAIL=1; }

echo
[ "$FAIL" -eq 0 ] && echo "판정: initdb 재호출이 멱등하다" || echo "판정: 조건을 만족하지 못했다"
exit $FAIL
