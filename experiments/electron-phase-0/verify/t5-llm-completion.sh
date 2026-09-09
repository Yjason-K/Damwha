#!/bin/bash
# 계획 Task 5 V8 — 번들 mlx_lm.server가 POST /v1/chat/completions에
# choices 1건을 돌려주는가 (스펙 P0-C5b).
#
# 여기서 처음으로 **모델이 실제로 메모리에 올라간다.** mlx_lm.server의
# ModelProvider는 첫 완성 요청까지 로드를 미루므로(/v1/models는 캐시 스캔만
# 한다), 이 요청이 성공했다는 것은 번들 안의 mlx가 Metal 백엔드로 4B-8bit
# 가중치를 올려 실제로 토큰을 생성했다는 뜻이다.
#
# 요청 형태는 damwha_worker/lens_client.py·summary_client.py가 보내는 것과
# 같은 골격이다 — model / messages / max_tokens / temperature. 정확도는
# 판정 대상이 아니다 (스펙 P0-C4 비고와 같은 이유). 짧은 프롬프트로 한 번만
# 부른다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

t5_require_bundle || exit 1

FAIL=0
OUT=$(t5_evidence_path "t5-llm-completion.txt")

echo "== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)"
t5_require_llm || { echo "FAIL: llm 기동 실패"; exit 1; }

REQ=$(cat <<JSON
{"model":"$LLM_MODEL","messages":[{"role":"user","content":"Reply with exactly one word: ok"}],"max_tokens":16,"temperature":0.0}
JSON
)

echo
echo "== POST $LLM_BASE/chat/completions"
echo "  요청: $REQ"
echo "  (첫 요청이 모델 로드를 포함한다 — 수십 초 걸릴 수 있다)"
STARTED=$(date +%s)
BODY=$("$CURL" -fsS --max-time 900 -H 'Content-Type: application/json' \
        -d "$REQ" "$LLM_BASE/chat/completions" 2>&1)
RC=$?
ELAPSED=$(( $(date +%s) - STARTED ))

SUMMARY=$(printf '%s' "$BODY" | "$SYSPY" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as exc:
    print("parse_error:", exc)
    raise SystemExit(0)
ch = d.get("choices") or []
print("id:", d.get("id"))
print("model:", d.get("model"))
print("choices_count:", len(ch))
for i, c in enumerate(ch):
    msg = c.get("message") or {}
    print(f"choices[{i}].role:", msg.get("role"))
    print(f"choices[{i}].finish_reason:", c.get("finish_reason"))
    print(f"choices[{i}].content:", repr(msg.get("content")))
u = d.get("usage") or {}
print("usage:", json.dumps(u, sort_keys=True))
' 2>&1)

{
  echo "# Task 5 V8 — mlx_lm.server /v1/chat/completions (스펙 P0-C5b)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# endpoint: $LLM_BASE/chat/completions"
  echo "# 요청: $REQ"
  echo "# curl exit: $RC   경과: ${ELAPSED}s (모델 로드 포함)"
  echo "# 이 요청이 모델을 실제로 메모리에 올린다 — /v1/models는 캐시 스캔뿐이다."
  echo
  echo "## 판정에 쓴 요약"
  echo "$SUMMARY"
  echo
  echo "## 응답 원문"
  echo "$BODY"
} | exp_scrub > "$OUT"

if [ $RC -ne 0 ]; then
  echo "  FAIL curl이 exit $RC 로 끝났다: $BODY"
  exit 1
fi

echo
printf '%s\n' "$SUMMARY" | sed 's/^/  /'
echo

N=$(printf '%s\n' "$SUMMARY" | sed -n 's/^choices_count: //p')
CONTENT=$(printf '%s\n' "$SUMMARY" | sed -n 's/^choices\[0\].content: //p')

if [ "$N" = "1" ]; then
  echo "  OK   choices 1건"
else
  echo "  FAIL choices가 1건이 아니다 (${N:-없음})"
  FAIL=1
fi

case "$CONTENT" in
  ""|"None"|"''"|'""')
    echo "  FAIL 생성된 내용이 비었다 — 서버가 응답만 하고 토큰을 만들지 못했다"
    FAIL=1
    ;;
  *)
    echo "  OK   생성된 내용이 있다: $CONTENT"
    ;;
esac

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: 번들 mlx_lm.server가 $LLM_MODEL 로 완성 응답 1건을 만들었다 (${ELAPSED}s)"
exit 0
