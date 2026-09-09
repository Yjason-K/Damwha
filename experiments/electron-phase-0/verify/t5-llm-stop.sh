#!/bin/bash
# 계획 Task 5 V9 — SIGTERM 뒤에 58000이 응답하지 않는가 (스펙 P0-C5b의
# "SIGTERM에 종료된다").
#
# 이 조건이 스펙에 있는 이유: 워커는 렌즈/요약 job이 끝나면
# damwha_worker/llm_server.py::_stop 이 `proc.terminate()`(SIGTERM)로 서버를
# 내린다. 4B-8bit가 메모리를 계속 쥐고 있으면 안 되기 때문이다. 여기서
# SIGTERM이 통하지 않으면 Phase 4에서 job마다 모델이 남는다.
#
# 그래서 llm.sh stop은 **SIGKILL로 올리지 않는다** — 올리면 SIGTERM이
# 통했는지가 증거에서 사라진다. 종료는 PID 파일 대상이고 이름 기반 kill은
# 없다 (스펙 §4.4).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

FAIL=0
OUT=$(t5_evidence_path "t5-llm-stop.txt")

echo "== 종료 전 상태"
if ! exp_pid_alive llm; then
  echo "  FAIL llm이 떠 있지 않다 — V6~V8을 먼저 돌린다 (내릴 대상이 없으면 판정이 성립하지 않는다)"
  exit 1
fi
PID=$(cat "$(exp_pid_file llm)")
echo "  pid $PID, $EXP_LLM_PORT LISTEN: $(exp_port_pid "$EXP_LLM_PORT" || echo 없음)"

echo
echo "== llm.sh stop (PID 파일 대상 SIGTERM)"
STOP_OUT=$(bash "$LLM_SH" stop 2>&1)
STOP_RC=$?
printf '%s\n' "$STOP_OUT" | sed 's/^/  /'

echo
echo "== 종료 후 확인"
ALIVE=no
kill -0 "$PID" 2>/dev/null && ALIVE=yes
MODELS=$("$CURL" -fsS --max-time 5 "$LLM_BASE/models" 2>&1)
MODELS_RC=$?
PORT_AFTER=$(exp_port_pid "$EXP_LLM_PORT" || echo "")

{
  echo "# Task 5 V9 — llm.sh stop = PID 파일 대상 SIGTERM (스펙 P0-C5b)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 격리 대상: 아니오 — stop은 번들 바이너리를 실행하지 않고 SIGTERM만"
  echo "#            보낸다 (스펙 §4.0)"
  echo "# 대상 pid: $PID"
  echo "# stop exit: $STOP_RC"
  echo "# SIGKILL로 올리지 않는다 — 그러면 SIGTERM이 통했는지가 사라진다."
  echo
  printf '%s\n' "$STOP_OUT"
  echo
  echo "종료 후 kill -0 $PID: $ALIVE"
  echo "종료 후 GET /v1/models curl exit: $MODELS_RC (응답: $MODELS)"
  echo "종료 후 $EXP_LLM_PORT LISTEN pid: ${PORT_AFTER:-없음}"
} | exp_scrub > "$OUT"

[ $STOP_RC -eq 0 ] && echo "  OK   stop이 exit 0" \
                   || { echo "  FAIL stop이 exit $STOP_RC"; FAIL=1; }

if [ "$ALIVE" = "no" ]; then
  echo "  OK   pid $PID 가 SIGTERM에 내려갔다 (SIGKILL을 쓰지 않았다)"
else
  echo "  FAIL pid $PID 가 아직 살아 있다"
  FAIL=1
fi

if [ $MODELS_RC -ne 0 ]; then
  echo "  OK   $EXP_LLM_PORT 가 더는 응답하지 않는다 (curl exit $MODELS_RC)"
else
  echo "  FAIL 종료 뒤에도 /v1/models가 응답한다: $MODELS"
  FAIL=1
fi

if [ -z "$PORT_AFTER" ]; then
  echo "  OK   $EXP_LLM_PORT 를 LISTEN 하는 프로세스가 없다"
else
  echo "  FAIL $EXP_LLM_PORT 를 아직 pid $PORT_AFTER 가 잡고 있다"
  FAIL=1
fi

if [ -f "$(exp_pid_file llm)" ]; then
  echo "  FAIL PID 파일이 남아 있다: $(exp_pid_file llm)"
  FAIL=1
else
  echo "  OK   PID 파일이 정리됐다"
fi

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: mlx_lm.server가 SIGTERM에 내려가고 $EXP_LLM_PORT 가 비었다"
exit 0
