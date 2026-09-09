#!/bin/bash
# 계획 Task 2 V2b — **t2-start의 dyld 실측이 진짜인가.**
#
# 줄 수가 0이 아니라는 것만으로는 아무것도 증명되지 않는다. 런처 자신의 로드
# 목록만 남은 "위반 0건짜리 가짜 증거"도 줄 수는 넉넉하다(Task 1 D3). 그래서
# 계획 규칙 6b가 정한 순서로 본다 — **pid를 먼저 고정하고**, 그 pid가 번들
# 바이너리를 실제로 로드했는지를 확인한다.
#
# 이 검사는 V2(run.sh start) **직후**에 유효하다. 뒤 행(V6·V7·V8)이 서버를
# 다시 띄우면 pg.pid가 바뀌므로, 그 뒤에 다시 돌리려면 V2부터 다시 해야 한다.
# 그 상황을 아래에서 구분해 알려 준다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
DY="$EVIDENCE/t2-start-dyld.txt"
PGBIN_POSTGRES="$BUNDLE_PG/bin/postgres"

echo "== V2b — t2-start dyld 실측 판독 (계획 규칙 6 / 6b)"
echo "  증거 파일 : $DY"

[ -f "$DY" ] || { echo "  FAIL 증거 파일이 없다 — V2(run-isolated --label t2-start)를 먼저 돌린다"; exit 1; }

if head -n 1 "$DY" | grep -q '^MEASUREMENT_UNAVAILABLE$'; then
  echo "  FAIL 첫 줄이 MEASUREMENT_UNAVAILABLE이다 — 실측이 끊겼다."
  echo "       런처가 exec 직전에 export DYLD_PRINT_LIBRARIES=1 을 하지 않았거나"
  echo "       자식 stderr를 리다이렉트했다 (계획 규칙 1·2)."
  exit 1
fi
echo "  OK   MEASUREMENT_UNAVAILABLE 표시가 없다"

N=$(t2_dyld_lines "$DY")
if [ "$N" -ge 1 ]; then
  echo "  OK   ^dyld 줄 ${N}건 (헤더가 아니라 dyld 줄만 셌다)"
else
  echo "  FAIL ^dyld 줄이 0건이다"
  FAIL=1
fi

PIDFILE="$(exp_pid_file pg)"
[ -f "$PIDFILE" ] || { echo "  FAIL PID 파일이 없다: $PIDFILE"; exit 1; }
PID=$(cat "$PIDFILE")
echo "  pg.pid    : $PID"
echo "  증거의 pid: $(t2_dyld_pids "$DY")"

# 규칙 6b: pid를 먼저 고정하고 그 pid의 로드 목록을 본다.
EXACT=$(t2_dyld_pid_loads_exact "$DY" "$PID" "$PGBIN_POSTGRES")
UNDER=$(t2_dyld_pid_loads_under "$DY" "$PID" "$BUNDLE_PG/")
if [ "$EXACT" -ge 1 ]; then
  echo "  OK   pid $PID 의 로드 목록에 번들 postgres가 있다 ($PGBIN_POSTGRES)"
else
  echo "  FAIL pid $PID 이 번들 postgres를 로드한 dyld 줄이 없다."
  echo "       (a) 증거가 그 회차의 것이 아니거나 — V6·V7·V8이 서버를 다시 띄웠다면"
  echo "           V2부터 다시 돌려야 한다"
  echo "       (b) PID 파일에 postgres가 아니라 래퍼 bash의 PID가 들어갔거나"
  echo "       (c) 실측이 런처 자신의 것만 담은 가짜 증거다 (Task 1 D3의 형태)"
  FAIL=1
fi
echo "  참고 pid $PID 이 번들($BUNDLE_PG) 아래에서 로드한 이미지: ${UNDER}건"

# 번들 밖에서 들어온 라이브러리가 있는지 — 허용은 /usr/lib 와 /System/Library 뿐이다.
BAD=$(awk -v p="dyld[$PID]:" -v d="$BUNDLE_PG/" '
  $1 == p {
    img = $NF
    if (index(img, d) == 1) next
    if (index(img, "/usr/lib/") == 1) next
    if (index(img, "/System/Library/") == 1) next
    print img
  }' "$DY" | sort -u)
if [ -n "$BAD" ]; then
  echo "  FAIL 서버가 번들·/usr/lib·/System/Library 밖에서 라이브러리를 로드했다:"
  printf '%s\n' "$BAD" | sed 's/^/       /'
  FAIL=1
else
  echo "  OK   서버가 로드한 이미지가 전부 번들 / usr/lib / System/Library 안이다"
fi

echo
[ "$FAIL" -eq 0 ] && echo "판정: t2-start의 dyld 실측이 서버 프로세스의 것이다" \
                  || echo "판정: 실측이 성립하지 않는다"
exit $FAIL
