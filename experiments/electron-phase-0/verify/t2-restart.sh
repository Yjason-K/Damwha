#!/bin/bash
# 계획 Task 2 V6 — 정상 종료(pg_ctl stop -m fast) 후 재기동해도 스키마가 남는가.
#
# 재기동은 **격리 래퍼를 통해** 한다 (스펙 §4.2: 모든 실행 검증이 그 통로를
# 지난다). 새로 뜬 서버의 dyld 실측도 그 자리에서 함께 판정한다 — 재기동
# 경로가 조용히 규칙을 어기면(런처가 re-export를 빠뜨리는 등) 여기서 잡힌다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
LABEL=t2-restart

echo "== 사전 상태"
t2_require_server t2-restart-pre || { echo "  FAIL 서버를 띄우지 못했다"; exit 1; }
BEFORE=$(t2_migrations_applied)
FILES=$(t2_migration_file_count)
OLD_PID=$(t2_server_pid)
SYSID_BEFORE=$("$BUNDLE_PG/bin/pg_controldata" -D "$PGDATA" | sed -n 's/^Database system identifier: *//p')
echo "  pid $OLD_PID / _migrations $BEFORE / 파일 $FILES"
echo "  system identifier: $SYSID_BEFORE"
if [ "$BEFORE" != "$FILES" ]; then
  echo "  FAIL 시작 시점부터 _migrations($BEFORE)가 파일 수($FILES)와 다르다 — V4를 먼저 돌린다"
  exit 1
fi

echo
echo "== 정상 종료 (pg_ctl stop -m fast)"
bash "$PG_RUN" stop || { echo "  FAIL stop 실패"; exit 1; }
if t2_server_alive; then echo "  FAIL 아직 살아 있다"; exit 1; fi
echo "  OK   정지됨"

echo
echo "== 재기동 (run-isolated.sh --label $LABEL)"
bash "$RUN_ISO" --label "$LABEL" -- "$PG_RUN" start || { echo "  FAIL 재기동 실패"; exit 1; }
NEW_PID=$(t2_server_pid)
t2_server_alive || { echo "  FAIL 재기동 후 살아 있지 않다"; exit 1; }
echo "  OK   재기동됨 (pid $NEW_PID)"
[ "$NEW_PID" != "$OLD_PID" ] && echo "  OK   새 프로세스다 (이전 pid $OLD_PID)" \
  || { echo "  FAIL pid가 그대로다 — 정말 재기동됐는지 의심스럽다"; FAIL=1; }

echo
echo "== 재기동 후 상태"
AFTER=$(t2_migrations_applied)
SYSID_AFTER=$("$BUNDLE_PG/bin/pg_controldata" -D "$PGDATA" | sed -n 's/^Database system identifier: *//p')
echo "  _migrations $AFTER / system identifier $SYSID_AFTER"
[ "$AFTER" = "$FILES" ] && echo "  OK   _migrations가 $FILES 로 유지됐다" \
  || { echo "  FAIL _migrations가 $AFTER 다 (기대 $FILES)"; FAIL=1; }
[ "$SYSID_AFTER" = "$SYSID_BEFORE" ] && echo "  OK   같은 클러스터다 (system identifier 동일)" \
  || { echo "  FAIL system identifier가 바뀌었다 — 다른 클러스터를 보고 있다"; FAIL=1; }
VEC=$(t2_scalar "SELECT count(*) FROM pg_extension WHERE extname IN ('vector','pg_bigm')")
[ "$VEC" = "2" ] && echo "  OK   확장 2종이 그대로 있다" \
  || { echo "  FAIL 확장이 남아 있지 않다 ($VEC)"; FAIL=1; }

echo
echo "== 재기동한 서버의 dyld 실측 (규칙 6b)"
DY="$EVIDENCE/$LABEL-dyld.txt"
if head -n 1 "$DY" 2>/dev/null | grep -q '^MEASUREMENT_UNAVAILABLE$'; then
  echo "  FAIL 재기동 회차가 MEASUREMENT_UNAVAILABLE이다"
  FAIL=1
elif [ "$(t2_dyld_pid_loads_exact "$DY" "$NEW_PID" "$BUNDLE_PG/bin/postgres")" -ge 1 ]; then
  echo "  OK   pid $NEW_PID 이 번들 postgres를 로드한 줄이 있다"
else
  echo "  FAIL pid $NEW_PID 의 번들 postgres 로드 줄이 없다 ($DY)"
  FAIL=1
fi

echo
[ "$FAIL" -eq 0 ] && echo "판정: 정상 종료 후 재기동해도 스키마가 유지된다" \
                  || echo "판정: 조건을 만족하지 못했다"
exit $FAIL
