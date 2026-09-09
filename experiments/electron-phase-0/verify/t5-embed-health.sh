#!/bin/bash
# 계획 Task 5 V3 — 번들 런타임의 embed 서비스가 58100에서 /health에
# {"status":"ok"}를 내는가 (스펙 P0-C5).
#
# 포트가 58100인 것이 판정의 일부다. 개발 기본값 8100에 뜬 서버를 보고
# 통과시키면 아무것도 검증되지 않는다 — 그래서 응답만이 아니라 **그 포트를
# 잡고 있는 프로세스가 우리 PID 파일의 서버인지**까지 확인한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

t5_require_bundle || exit 1

FAIL=0
OUT=$(t5_evidence_path "t5-embed-health.txt")

echo "== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)"
t5_require_embed || { echo "FAIL: embed 기동 실패"; exit 1; }

echo
echo "== GET $EMBED_BASE/health"
BODY=$("$CURL" -fsS --max-time 10 "$EMBED_BASE/health" 2>&1)
RC=$?
echo "  응답: $BODY"

PID=$(cat "$(exp_pid_file embed)" 2>/dev/null)
PORT_PID=$(exp_port_pid "$EXP_EMBED_PORT" || echo "")

{
  echo "# Task 5 V3 — embed /health (스펙 P0-C5)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# endpoint: $EMBED_BASE/health"
  echo "# curl exit: $RC"
  echo "# embed.pid: $PID"
  echo "# $EXP_EMBED_PORT 를 LISTEN 하는 pid: ${PORT_PID:-없음}"
  echo
  echo "$BODY"
} | exp_scrub > "$OUT"

if [ $RC -ne 0 ]; then
  echo "  FAIL curl이 exit $RC 로 끝났다"
  FAIL=1
fi

case "$BODY" in
  *'"status"'*'"ok"'*) echo "  OK   {\"status\":\"ok\"} 형태다" ;;
  *) echo "  FAIL 응답이 {\"status\":\"ok\"}가 아니다"; FAIL=1 ;;
esac

echo
echo "== 포트 소유 확인 (개발 기본값 8100이 아니라 실험 포트 $EXP_EMBED_PORT 인가)"
if [ -z "$PORT_PID" ]; then
  echo "  FAIL $EXP_EMBED_PORT 를 LISTEN 하는 프로세스가 없다"
  FAIL=1
elif [ "$PORT_PID" = "$PID" ]; then
  echo "  OK   $EXP_EMBED_PORT 를 우리 PID 파일의 서버(pid $PID)가 잡고 있다"
else
  echo "  FAIL $EXP_EMBED_PORT 를 잡은 pid($PORT_PID)가 embed.pid($PID)와 다르다"
  FAIL=1
fi

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: 번들 embed 서비스가 $EXP_EMBED_PORT 에서 /health에 응답한다"
exit 0
