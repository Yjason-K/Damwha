#!/bin/bash
# 계획 Task 2 V9 — 개발 DB를 건드리지 않았는가 (스펙 §4.4).
#
# 기준선은 **Task 2 시작 시점에 한 번** 찍어 증거로 커밋한
# $EVIDENCE/t2-dev-baseline.txt다. 스크립트가 자기 기준선을 그때그때 새로
# 만들면 이미 망가진 뒤에 찍어도 통과하므로, 기준선이 없으면 실패한다.
#
# 보는 것은 셋이다.
#   1. damwha_pgdata / be_pgdata 볼륨이 그대로 있는가 (실험은 볼륨을 만들지도
#      지우지도 않는다 — docker volume rm / down -v 는 하네스 어디에도 없다)
#   2. 컨테이너 수가 시작 시점과 같은가
#   3. 실험 서버가 5432가 아니라 55432에만 붙어 있는가 (포트로 인스턴스가
#      구분된다는 스펙 §4.4의 전제를 실제로 확인한다)

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
BASE="$EVIDENCE/t2-dev-baseline.txt"

echo "== 기준선"
[ -f "$BASE" ] || { echo "  FAIL 기준선이 없다: $BASE (Task 2 시작 시점의 파일이어야 한다)"; exit 1; }
echo "  $BASE ($(sed -n 's/^utc: //p' "$BASE"))"

command -v docker >/dev/null 2>&1 || { echo "  FAIL docker CLI가 없다 — 대조할 수 없다"; exit 1; }
if ! docker volume ls --format '{{.Name}}' > /dev/null 2>&1; then
  echo "  FAIL docker 데몬에 접근할 수 없다 — 대조할 수 없다"
  exit 1
fi

echo
echo "== 1. 볼륨"
NOW_VOLS=$(docker volume ls --format '{{.Name}}' | sort)
for v in damwha_pgdata be_pgdata; do
  if printf '%s\n' "$NOW_VOLS" | grep -qx "$v"; then
    echo "  OK   $v 가 그대로 있다"
  else
    echo "  FAIL $v 가 사라졌다"
    FAIL=1
  fi
done
BASE_VOLS=$(awk '/^## docker volumes/{f=1;next} /^## /{f=0} f' "$BASE" | sort)
MISSING=$(comm -23 <(printf '%s\n' "$BASE_VOLS") <(printf '%s\n' "$NOW_VOLS"))
if [ -n "$MISSING" ]; then
  echo "  FAIL 시작 시점에 있던 볼륨이 사라졌다:"
  printf '%s\n' "$MISSING" | sed 's/^/       /'
  FAIL=1
else
  echo "  OK   시작 시점의 볼륨이 하나도 사라지지 않았다 ($(printf '%s\n' "$BASE_VOLS" | wc -l | tr -d ' ')개)"
fi

echo
echo "== 2. 컨테이너 수"
BASE_N=$(awk '/^## container count/{getline; print; exit}' "$BASE" | tr -d ' ')
NOW_N=$(docker ps -a --format '{{.Names}}' | wc -l | tr -d ' ')
echo "  시작 시점: $BASE_N / 지금: $NOW_N"
if [ "$BASE_N" = "$NOW_N" ]; then
  echo "  OK   같다"
else
  echo "  FAIL 컨테이너 수가 달라졌다 — 실험이 컨테이너를 만들거나 지웠는지 확인해야 한다"
  docker ps -a --format '{{.Names}}' | sort | sed 's/^/       /'
  FAIL=1
fi

echo
echo "== 3. 실험 서버의 포트"
if t2_server_alive; then
  PID=$(t2_server_pid)
  # -a 가 없으면 lsof는 -p 와 -i 를 OR로 묶어 시스템 전체의 리스너를 함께 낸다.
  PORTS=$(lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sed 's/.*://' | sort -u | tr '\n' ' ')
  echo "  실험 서버 pid $PID 가 LISTEN하는 포트: ${PORTS:-없음}"
  case " $PORTS " in
    *" $EXP_PG_PORT "*) echo "  OK   실험 포트 $EXP_PG_PORT 에 붙어 있다" ;;
    *) echo "  FAIL 실험 포트 $EXP_PG_PORT 에 붙어 있지 않다"; FAIL=1 ;;
  esac
  case " $PORTS " in
    *" 5432 "*) echo "  FAIL 실험 서버가 개발 포트 5432를 잡고 있다"; FAIL=1 ;;
    *) echo "  OK   개발 포트 5432를 잡고 있지 않다" ;;
  esac
else
  echo "  실험 서버가 떠 있지 않다 — 포트 확인은 건너뛴다 (볼륨·컨테이너 대조는 위에서 했다)"
fi
DEV=$(lsof -nP -iTCP:5432 -sTCP:LISTEN -t 2>/dev/null | head -n 1)
echo "  참고: 5432를 물고 있는 프로세스 pid = ${DEV:-없음} (개발 인스턴스. 실험은 여기 붙지 않는다)"

echo
echo "== 4. 실험이 쓴 경로"
echo "  데이터 디렉터리: $PGDATA"
case "$PGDATA" in
  "$SANDBOX"/*) echo "  OK   샌드박스 안이다" ;;
  *) echo "  FAIL 샌드박스 밖이다"; FAIL=1 ;;
esac

echo
[ "$FAIL" -eq 0 ] && echo "판정: 개발 DB의 볼륨·컨테이너가 Task 시작 시점과 같다" \
                  || echo "판정: 개발 자산이 달라졌다"
exit $FAIL
