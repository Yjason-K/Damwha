#!/bin/bash
# 계획 Task 5 V5 — embed.sh stop 뒤에 58100이 응답하지 않는가.
#
# 종료는 **PID 파일 대상 SIGTERM**이다 (스펙 §4.4). embed.sh에는 이름 기반
# kill이 없고, stop은 SIGKILL로 올리지도 않는다 — 올리면 "SIGTERM에 내려갔다"가
# 증거에서 사라진다.
#
# `embed.sh stop`은 번들 바이너리를 실행하지 않고 신호만 보내므로 격리 래퍼를
# 지나지 않는다 (스펙 §4.0의 "번들 산출물과 그것을 실행하는 프로세스"에
# 해당하지 않는다). 증거에 그렇게 적는다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

FAIL=0
OUT=$(t5_evidence_path "t5-embed-stop.txt")

echo "== 종료 전 상태"
if ! exp_pid_alive embed; then
  echo "  FAIL embed가 떠 있지 않다 — V2~V4를 먼저 돌린다 (내릴 대상이 없으면 판정이 성립하지 않는다)"
  exit 1
fi
PID=$(cat "$(exp_pid_file embed)")
echo "  pid $PID, $EXP_EMBED_PORT LISTEN: $(exp_port_pid "$EXP_EMBED_PORT" || echo 없음)"

echo
echo "== embed.sh stop (PID 파일 대상 SIGTERM)"
STOP_OUT=$(bash "$EMBED_SH" stop 2>&1)
STOP_RC=$?
printf '%s\n' "$STOP_OUT" | sed 's/^/  /'

echo
echo "== 종료 후 확인"
ALIVE=no
kill -0 "$PID" 2>/dev/null && ALIVE=yes
HEALTH=$("$CURL" -fsS --max-time 5 "$EMBED_BASE/health" 2>&1)
HEALTH_RC=$?
PORT_AFTER=$(exp_port_pid "$EXP_EMBED_PORT" || echo "")

{
  echo "# Task 5 V5 — embed.sh stop (스펙 P0-C5 / §4.4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 격리 대상: 아니오 — stop은 번들 바이너리를 실행하지 않고 PID 파일의"
  echo "#            프로세스에 SIGTERM만 보낸다 (스펙 §4.0)"
  echo "# 대상 pid: $PID"
  echo "# stop exit: $STOP_RC"
  echo
  printf '%s\n' "$STOP_OUT"
  echo
  echo "종료 후 kill -0 $PID: $ALIVE"
  echo "종료 후 GET /health curl exit: $HEALTH_RC (응답: $HEALTH)"
  echo "종료 후 $EXP_EMBED_PORT LISTEN pid: ${PORT_AFTER:-없음}"
} | exp_scrub > "$OUT"

[ $STOP_RC -eq 0 ] && echo "  OK   stop이 exit 0" \
                   || { echo "  FAIL stop이 exit $STOP_RC"; FAIL=1; }

if [ "$ALIVE" = "no" ]; then
  echo "  OK   pid $PID 가 SIGTERM에 내려갔다"
else
  echo "  FAIL pid $PID 가 아직 살아 있다"
  FAIL=1
fi

if [ $HEALTH_RC -ne 0 ]; then
  echo "  OK   $EXP_EMBED_PORT/health 가 더는 응답하지 않는다 (curl exit $HEALTH_RC)"
else
  echo "  FAIL 종료 뒤에도 /health가 응답한다: $HEALTH"
  FAIL=1
fi

if [ -z "$PORT_AFTER" ]; then
  echo "  OK   $EXP_EMBED_PORT 를 LISTEN 하는 프로세스가 없다"
else
  echo "  FAIL $EXP_EMBED_PORT 를 아직 pid $PORT_AFTER 가 잡고 있다"
  FAIL=1
fi

if [ -f "$(exp_pid_file embed)" ]; then
  echo "  FAIL PID 파일이 남아 있다: $(exp_pid_file embed)"
  FAIL=1
else
  echo "  OK   PID 파일이 정리됐다"
fi

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: embed 서비스가 SIGTERM에 내려가고 $EXP_EMBED_PORT 가 비었다"
exit 0
