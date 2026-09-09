#!/bin/bash
# 계획 Task 5 V4 — POST /embed가 model=BAAI/bge-m3, dimension=1024, 요청한
# 문자열 수만큼의 벡터를 내는가 (스펙 P0-C5).
#
# 스펙의 성공 판정은 "요청 문자열 수만큼의 벡터"이므로 두 개를 보낸다 —
# 하나만 보내면 "항상 1개를 낸다"와 구분되지 않는다.
#
# dimension은 be/worker/.env의 SEARCH_EMBEDDING_DIM과도 대조한다. 이 값이
# 갈리면 Task 6의 utterance_embedding(vector(1024))과 하이브리드 검색이
# 그대로 깨진다 — embed 서비스가 응답에 실어 보내는 값이 계약이다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

t5_require_bundle || exit 1

FAIL=0
OUT=$(t5_evidence_path "t5-embed-vector.txt")

WORKER_ENV="$REPO_ROOT/be/worker/.env"
ENV_DIM=$(sed -n 's/^SEARCH_EMBEDDING_DIM=//p' "$WORKER_ENV" 2>/dev/null | head -n 1 | tr -d ' ')
ENV_MODEL=$(sed -n 's/^SEARCH_EMBEDDING_MODEL=//p' "$WORKER_ENV" 2>/dev/null | head -n 1 | tr -d ' ')

echo "== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)"
t5_require_embed || { echo "FAIL: embed 기동 실패"; exit 1; }

REQ='{"texts":["담화는 회의 녹음을 요약한다","두 번째 문장은 벡터 개수를 확인하려고 넣는다"]}'
echo
echo "== POST $EMBED_BASE/embed"
echo "  요청: $REQ"
BODY=$("$CURL" -fsS --max-time 120 -H 'Content-Type: application/json' \
        -d "$REQ" "$EMBED_BASE/embed" 2>&1)
RC=$?

# 벡터 전량(1024*2 실수)을 증거에 넣지 않는다 — 판정에 필요한 것은 모델·차원·
# 개수·길이와 값이 상수가 아니라는 것뿐이다.
SUMMARY=$(printf '%s' "$BODY" | "$SYSPY" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as exc:
    print("parse_error:", exc)
    raise SystemExit(0)
vs = d.get("vectors") or []
print("model:", d.get("model"))
print("dimension:", d.get("dimension"))
print("vector_count:", len(vs))
for i, v in enumerate(vs):
    head = ", ".join(f"{x:.6f}" for x in v[:4])
    print(f"vector[{i}] len: {len(v)}  head: [{head}, ...]")
if len(vs) == 2:
    same = vs[0] == vs[1]
    print("two_vectors_identical:", same)
' 2>&1)

{
  echo "# Task 5 V4 — embed /embed (스펙 P0-C5)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# endpoint: $EMBED_BASE/embed"
  echo "# 요청: $REQ"
  echo "# curl exit: $RC"
  echo "# be/worker/.env: SEARCH_EMBEDDING_MODEL=$ENV_MODEL SEARCH_EMBEDDING_DIM=$ENV_DIM"
  echo "#"
  echo "# 벡터 전량(1024차원 x 2)은 넣지 않는다 — 판정에 쓰는 요약이다."
  echo
  echo "$SUMMARY"
} | exp_scrub > "$OUT"

if [ $RC -ne 0 ]; then
  echo "  FAIL curl이 exit $RC 로 끝났다: $BODY"
  exit 1
fi

echo
printf '%s\n' "$SUMMARY" | sed 's/^/  /'
echo

GOT_MODEL=$(printf '%s\n' "$SUMMARY" | sed -n 's/^model: //p')
GOT_DIM=$(printf '%s\n' "$SUMMARY" | sed -n 's/^dimension: //p')
GOT_N=$(printf '%s\n' "$SUMMARY" | sed -n 's/^vector_count: //p')
LEN0=$(printf '%s\n' "$SUMMARY" | sed -n 's/^vector\[0\] len: \([0-9]*\) .*/\1/p')
LEN1=$(printf '%s\n' "$SUMMARY" | sed -n 's/^vector\[1\] len: \([0-9]*\) .*/\1/p')
IDENTICAL=$(printf '%s\n' "$SUMMARY" | sed -n 's/^two_vectors_identical: //p')

if [ "$GOT_MODEL" = "$EMBED_MODEL" ]; then
  echo "  OK   model = $GOT_MODEL"
else
  echo "  FAIL model이 $EMBED_MODEL 가 아니라 '${GOT_MODEL:-없음}' 이다"
  FAIL=1
fi

if [ "$GOT_DIM" = "1024" ]; then
  echo "  OK   dimension = 1024"
else
  echo "  FAIL dimension이 1024가 아니라 '${GOT_DIM:-없음}' 이다"
  FAIL=1
fi

if [ -n "$ENV_DIM" ] && [ "$GOT_DIM" = "$ENV_DIM" ]; then
  echo "  OK   be/worker/.env의 SEARCH_EMBEDDING_DIM($ENV_DIM)과 같다"
else
  echo "  FAIL be/worker/.env의 SEARCH_EMBEDDING_DIM('${ENV_DIM:-없음}')과 다르다"
  FAIL=1
fi

if [ "$GOT_N" = "2" ] && [ "$LEN0" = "1024" ] && [ "$LEN1" = "1024" ]; then
  echo "  OK   요청 2개에 벡터 2개, 각각 길이 1024"
else
  echo "  FAIL 벡터 개수/길이가 어긋난다 (count=${GOT_N:-?} len0=${LEN0:-?} len1=${LEN1:-?})"
  FAIL=1
fi

if [ "$IDENTICAL" = "False" ]; then
  echo "  OK   두 벡터가 서로 다르다 — 상수 벡터를 돌려주는 것이 아니다"
else
  echo "  FAIL 두 벡터가 같다(${IDENTICAL:-?}) — 실제 임베딩이 아닐 수 있다"
  FAIL=1
fi

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: 번들 bge-m3가 1024차원 벡터를 요청 수만큼 돌려준다"
exit 0
