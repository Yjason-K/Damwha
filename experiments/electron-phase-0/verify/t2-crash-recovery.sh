#!/bin/bash
# 계획 Task 2 V7 — SIGKILL 후 재기동해도 crash recovery로 스키마·데이터가 남는가
# (스펙 P0-C1의 "SIGKILL로 강제 종료한 뒤 재기동").
#
# 종료는 **PID 파일 대상**이다 (스펙 §4.4). run.sh kill이 pg.pid의 postmaster와
# 그 자식들만 SIGKILL한다 — 이름으로 죽이지 않는다. 자식까지 죽이는 이유는
# run.sh의 주석에 있다: postmaster만 죽이면 보조 프로세스가 공유 메모리를
# 붙들어 다음 기동이 거절되고, 그것은 crash가 아니라 반쯤 죽은 상태다.
#
# "재기동됐다"만으로는 crash recovery를 확인한 것이 아니다. 서버 로그에서
#   "database system was not properly shut down; automatic recovery in progress"
# 를 찾아 증거로 남긴다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
LABEL=t2-crash-restart
OUT="$EVIDENCE/t2-crash-recovery.txt"

echo "== 사전 상태"
t2_require_server t2-crash-pre || { echo "  FAIL 서버를 띄우지 못했다"; exit 1; }
FILES=$(t2_migration_file_count)
BEFORE=$(t2_migrations_applied)
OLD_PID=$(t2_server_pid)
if [ "$BEFORE" != "$FILES" ]; then
  echo "  FAIL 시작 시점부터 _migrations($BEFORE)가 파일 수($FILES)와 다르다 — V4를 먼저 돌린다"
  exit 1
fi
# crash 뒤에도 남아야 할 데이터를 하나 만든다. 커밋된 트랜잭션이 WAL 재생으로
# 살아 돌아오는지를 보려는 것이다 — 스키마만 보면 체크포인트 덕을 볼 수 있다.
MARK="t2-crash-$(date -u '+%Y%m%dT%H%M%SZ')"
bash "$PG_PSQL" -q -c "CREATE TABLE IF NOT EXISTS t2_crash_probe(mark text primary key, at timestamptz default now())" \
                -c "INSERT INTO t2_crash_probe(mark) VALUES ('$MARK')" \
  || { echo "  FAIL 표식 행을 넣지 못했다"; exit 1; }
echo "  pid $OLD_PID / _migrations $BEFORE / 표식 $MARK"

echo
echo "== SIGKILL (PID 파일 대상)"
bash "$PG_RUN" kill || { echo "  FAIL kill 실패"; exit 1; }
t2_server_alive && { echo "  FAIL 아직 살아 있다"; exit 1; }
echo "  OK   강제 종료됨"

echo
echo "== 재기동 (run-isolated.sh --label $LABEL)"
bash "$RUN_ISO" --label "$LABEL" -- "$PG_RUN" start || { echo "  FAIL 재기동 실패"; exit 1; }
NEW_PID=$(t2_server_pid)
echo "  OK   재기동됨 (pid $NEW_PID)"

echo
echo "== crash recovery 흔적"
LOG=$(t2_newest_server_log)
{
  echo "# Task 2 V7 — crash recovery 증거"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# SIGKILL 대상 pid: $OLD_PID (pg.pid) / 재기동 pid: $NEW_PID"
  echo "# 표식 행: $MARK"
  echo "# 로그: $LOG"
  echo
  grep -v '^dyld\[' "$LOG" 2>/dev/null | head -n 40
} | exp_scrub > "$OUT"
echo "  증거: $OUT"
grep -i 'not properly shut down\|automatic recovery\|redo\|ready to accept' "$LOG" | head -n 6 | sed 's/^/    /'

if grep -q 'was not properly shut down; automatic recovery in progress' "$LOG"; then
  echo "  OK   서버 로그에 crash recovery 기록이 있다"
else
  echo "  FAIL crash recovery 기록을 찾지 못했다 — 정말로 강제 종료된 것이 맞는지 확인해야 한다"
  FAIL=1
fi

echo
echo "== 재기동 후 상태"
AFTER=$(t2_migrations_applied)
[ "$AFTER" = "$FILES" ] && echo "  OK   _migrations가 $FILES 로 유지됐다" \
  || { echo "  FAIL _migrations가 $AFTER 다"; FAIL=1; }
MARKED=$(t2_scalar "SELECT count(*) FROM t2_crash_probe WHERE mark='$MARK'")
[ "$MARKED" = "1" ] && echo "  OK   crash 직전에 커밋한 행이 살아남았다 ($MARK)" \
  || { echo "  FAIL 커밋한 행이 사라졌다"; FAIL=1; }
EXT=$(t2_scalar "SELECT count(*) FROM pg_extension WHERE extname IN ('vector','pg_bigm')")
[ "$EXT" = "2" ] && echo "  OK   확장 2종이 그대로 있다" || { echo "  FAIL 확장이 없다 ($EXT)"; FAIL=1; }

echo
[ "$FAIL" -eq 0 ] && echo "판정: SIGKILL 후 재기동에서 crash recovery가 동작하고 데이터가 남는다" \
                  || echo "판정: 조건을 만족하지 못했다"
exit $FAIL
