#!/bin/bash
# 계획 Task 5 V7 — 번들 mlx_lm.server의 GET /v1/models 응답에
# Qwen3.5-4B-8bit이 들어 있는가 (스펙 P0-C5b).
#
# `/v1/models`는 **HF 캐시를 훑어** 목록을 만든다
# (mlx_lm/server.py::handle_models_request → scan_cache_dir()). 그래서 이
# 검사는 두 가지를 동시에 본다: 서버가 응답한다는 것과, 모델이 **샌드박스
# HF 캐시**에 실제로 들어 있다는 것. 개발자 홈 캐시를 썼다면 격리 실행의
# HF_HOME이 샌드박스이므로 여기에 나타나지 않는다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

t5_require_bundle || exit 1

FAIL=0
OUT=$(t5_evidence_path "t5-llm-models.txt")

echo "== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)"
t5_require_llm || { echo "FAIL: llm 기동 실패"; exit 1; }

echo
echo "== GET $LLM_BASE/models"
BODY=$("$CURL" -fsS --max-time 30 "$LLM_BASE/models" 2>&1)
RC=$?

IDS=$(printf '%s' "$BODY" | "$SYSPY" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as exc:
    print("parse_error:", exc)
    raise SystemExit(0)
for m in d.get("data", []):
    print(m.get("id"))
' 2>&1)

PID=$(cat "$(exp_pid_file llm)" 2>/dev/null)
PORT_PID=$(exp_port_pid "$EXP_LLM_PORT" || echo "")

{
  echo "# Task 5 V7 — mlx_lm.server /v1/models (스펙 P0-C5b)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# endpoint: $LLM_BASE/models"
  echo "# curl exit: $RC"
  echo "# llm.pid: $PID"
  echo "# $EXP_LLM_PORT 를 LISTEN 하는 pid: ${PORT_PID:-없음}"
  echo "# HF 캐시(격리 주입값): $ISO_HF_HOME"
  echo
  echo "## 응답 원문"
  echo "$BODY"
  echo
  echo "## 모델 id 목록"
  echo "$IDS"
} | exp_scrub > "$OUT"

if [ $RC -ne 0 ]; then
  echo "  FAIL curl이 exit $RC 로 끝났다: $BODY"
  exit 1
fi

echo "  모델 id:"
printf '%s\n' "$IDS" | sed 's/^/    /'
echo

if printf '%s\n' "$IDS" | grep -qF "$LLM_MODEL"; then
  echo "  OK   $LLM_MODEL 이 목록에 있다"
else
  echo "  FAIL $LLM_MODEL 이 목록에 없다"
  FAIL=1
fi

echo
echo "== 포트 소유 확인 (개발 기본값 8000이 아니라 실험 포트 $EXP_LLM_PORT 인가)"
if [ -z "$PORT_PID" ]; then
  echo "  FAIL $EXP_LLM_PORT 를 LISTEN 하는 프로세스가 없다"
  FAIL=1
elif [ "$PORT_PID" = "$PID" ]; then
  echo "  OK   $EXP_LLM_PORT 를 우리 PID 파일의 서버(pid $PID)가 잡고 있다"
else
  echo "  FAIL $EXP_LLM_PORT 를 잡은 pid($PORT_PID)가 llm.pid($PID)와 다르다"
  FAIL=1
fi

echo
echo "== 모델이 샌드박스 HF 캐시에 있는가 (개발자 홈이 아니다, 스펙 §4.4)"
CACHE_DIR="$ISO_HF_HOME/hub/models--mlx-community--Qwen3.5-4B-8bit"
if [ -d "$CACHE_DIR" ]; then
  echo "  OK   $CACHE_DIR"
else
  echo "  FAIL 샌드박스 캐시에 모델 디렉터리가 없다: $CACHE_DIR"
  FAIL=1
fi

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: 번들 mlx_lm.server가 $EXP_LLM_PORT 에서 $LLM_MODEL 을 서빙 목록에 낸다"
exit 0
