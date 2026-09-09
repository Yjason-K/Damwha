#!/bin/bash
# 계획 Task 6 V4 — `bigm_similarity` 와 `likequery` 가 동작하고 `<=>` 거리
# 연산이 동작한다 (스펙 P0-C2의 성공 판정 뒷문장).
#
# "정의돼 있다"로는 부족하다. 이름만 있고 값이 엉뚱해도 SELECT 는 성공하기
# 때문이다. 그래서 값이 **정의대로인지**를 본다.
#
#   1. likequery  — '예산' -> '%예산%'. LIKE 특수문자(%)가 들어오면 이스케이프한다.
#                   그 패턴으로 고른 집합이 position() 으로 고른 집합과 같다.
#   2. bigm_similarity — 같은 문자열끼리 1.0, 겹치지 않는 문자열은 그보다 작고
#                   0 이상 1 이하. 값이 상수가 아니다.
#   3. <=>        — 직교 벡터끼리 1, 같은 벡터끼리 0 (코사인 거리).
#                   시드된 실제 임베딩에서 거리가 전부 다르고, 주제가 같은
#                   발화가 다른 발화보다 가깝다.
#   4. 세 이름이 각각 **번들 확장**(pg_bigm / vector) 소속이다. pg_depend 로 본다 —
#      마이그레이션이 만든 SQL 함수나 우연한 동명 함수가 아니라는 확인이다.
#
# 이 스크립트는 클라이언트다 — 격리 대상이 아니다 (스펙 §4.0). 확장 .dylib 가
# 번들 경로에서 로드된다는 것은 Task 2 V3(t2-extension-load-dyld.txt)이 이미 쟀다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t6-lib.sh"

FAIL=0
OUT=$(t6_evidence_path "t6-operators.txt")

echo "== 서비스 준비"
t6_require_services || { echo "  FAIL 서비스를 띄우지 못했다"; exit 1; }
t6_require_seed     || { echo "  FAIL 시드를 만들지 못했다"; exit 1; }
MID=$(t6_meeting_id)

echo
echo "== 1. likequery (pg_bigm)"
LQ=$(t6_scalar "SELECT likequery('$T6_QUERY')")
LQ_PCT=$(t6_scalar "SELECT likequery('50% 절감')")
LQ_HITS=$(t6_scalar "SELECT count(*) FROM utterance
                     WHERE meeting_id='$MID' AND text LIKE likequery('$T6_QUERY')")
POS_HITS=$(t6_scalar "SELECT count(*) FROM utterance
                      WHERE meeting_id='$MID' AND position('$T6_QUERY' in text) > 0")
echo "  likequery('$T6_QUERY')  = $LQ"
echo "  likequery('50% 절감')   = $LQ_PCT"
echo "  LIKE likequery 로 고른 행: $LQ_HITS   position() 으로 고른 행: $POS_HITS"
if [ "$LQ" = "%$T6_QUERY%" ]; then
  echo "  OK   질의를 %...% 패턴으로 감쌌다"
else
  echo "  FAIL '%$T6_QUERY%' 가 아니라 '$LQ' 다"
  FAIL=1
fi
case "$LQ_PCT" in
  *'\%'*) echo "  OK   LIKE 특수문자 %를 이스케이프했다 ($LQ_PCT)" ;;
  *) echo "  FAIL %를 이스케이프하지 않았다: $LQ_PCT"; FAIL=1 ;;
esac
if [ "$LQ_HITS" = "$POS_HITS" ] && [ "${LQ_HITS:-0}" -gt 0 ] 2>/dev/null; then
  echo "  OK   패턴이 고른 집합이 position() 이 고른 집합과 같다 ($LQ_HITS 건)"
else
  echo "  FAIL 두 방법이 고른 행 수가 다르거나 0이다 ($LQ_HITS / $POS_HITS)"
  FAIL=1
fi

echo
echo "== 2. bigm_similarity (pg_bigm)"
SIM_SAME=$(t6_scalar "SELECT round(bigm_similarity('예산 집행','예산 집행')::numeric, 6)")
SIM_NEAR=$(t6_scalar "SELECT round(bigm_similarity('예산 집행','예산 승인')::numeric, 6)")
SIM_FAR=$(t6_scalar "SELECT round(bigm_similarity('예산 집행','국밥 점심')::numeric, 6)")
SIM_RANGE=$(t6_scalar "SELECT count(*) FROM utterance
                       WHERE meeting_id='$MID'
                         AND (bigm_similarity(text, '$T6_QUERY') < 0
                              OR bigm_similarity(text, '$T6_QUERY') > 1)")
SIM_DISTINCT=$(t6_scalar "SELECT count(DISTINCT bigm_similarity(text, '$T6_QUERY'))
                          FROM utterance WHERE meeting_id='$MID'")
echo "  같은 문자열   : $SIM_SAME"
echo "  비슷한 문자열 : $SIM_NEAR"
echo "  다른 문자열   : $SIM_FAR"
echo "  [0,1] 밖의 값 : $SIM_RANGE 건   서로 다른 값: $SIM_DISTINCT 가지"
if [ "$SIM_SAME" = "1.000000" ]; then
  echo "  OK   같은 문자열의 유사도가 1이다"
else
  echo "  FAIL 같은 문자열인데 $SIM_SAME 다"
  FAIL=1
fi
if awk -v a="$SIM_NEAR" -v b="$SIM_FAR" 'BEGIN { exit !(a > b) }'; then
  echo "  OK   비슷한 쪽($SIM_NEAR)이 다른 쪽($SIM_FAR)보다 크다"
else
  echo "  FAIL 유사도가 내용을 반영하지 않는다 ($SIM_NEAR vs $SIM_FAR)"
  FAIL=1
fi
if [ "$SIM_RANGE" = "0" ] && [ "${SIM_DISTINCT:-0}" -gt 1 ] 2>/dev/null; then
  echo "  OK   시드 전 행의 값이 [0,1] 안이고 상수가 아니다"
else
  echo "  FAIL 범위를 벗어난 값이 있거나 값이 한 가지뿐이다 ($SIM_RANGE / $SIM_DISTINCT)"
  FAIL=1
fi

echo
echo "== 3. <=> 코사인 거리 (pgvector)"
D_ORTH=$(t6_scalar "SELECT round(('[1,0,0]'::vector <=> '[0,1,0]'::vector)::numeric, 6)")
D_SAME=$(t6_scalar "SELECT round(('[1,2,3]'::vector <=> '[1,2,3]'::vector)::numeric, 6)")
D_OPP=$(t6_scalar "SELECT round(('[1,0,0]'::vector <=> '[-1,0,0]'::vector)::numeric, 6)")
D_SELF=$(t6_scalar "SELECT count(*) FROM utterance_embedding e
                    JOIN utterance u ON u.id = e.utterance_id
                    WHERE u.meeting_id='$MID' AND (e.embedding <=> e.embedding) > 1e-6")
QVEC=$(t6_qvec_file "$T6_QUERY") || { echo "  FAIL 질의 벡터를 얻지 못했다"; exit 1; }
DIST_TSV="$SANDBOX/state/t6-distances.tsv"
printf '%s\n' "
SELECT u.order_index, u.id,
       round((e.embedding <=> :'qvec'::vector)::numeric, 6) AS dist,
       round(bigm_similarity(u.text, :'q')::numeric, 6) AS bigm,
       (u.text LIKE likequery(:'q')) AS kwhit,
       u.text
FROM utterance_embedding e JOIN utterance u ON u.id = e.utterance_id
WHERE u.meeting_id = '$MID'
ORDER BY e.embedding <=> :'qvec'::vector;" \
  | t6_tsv_stdin -v q="$T6_QUERY" -v qvec="$(cat "$QVEC")" > "$DIST_TSV"

N_ROWS=$(wc -l < "$DIST_TSV" | tr -d ' ')
N_DIST=$(awk -F"$TAB" '{ print $3 }' "$DIST_TSV" | sort -u | wc -l | tr -d ' ')
echo "  '[1,0,0]' <=> '[0,1,0]' = $D_ORTH   (직교 -> 1)"
echo "  '[1,2,3]' <=> '[1,2,3]' = $D_SAME   (같음 -> 0)"
echo "  '[1,0,0]' <=> '[-1,0,0]' = $D_OPP   (반대 -> 2)"
echo "  시드 임베딩 자기 거리가 0이 아닌 행: $D_SELF"
echo "  시드 $N_ROWS 건의 서로 다른 거리 값: $N_DIST 가지"
[ "$D_ORTH" = "1.000000" ] && echo "  OK   직교 거리 1" || { echo "  FAIL 직교 거리가 1이 아니다: $D_ORTH"; FAIL=1; }
[ "$D_SAME" = "0.000000" ] && echo "  OK   동일 벡터 거리 0" || { echo "  FAIL 동일 벡터 거리가 0이 아니다: $D_SAME"; FAIL=1; }
[ "$D_OPP"  = "2.000000" ] && echo "  OK   반대 벡터 거리 2" || { echo "  FAIL 반대 벡터 거리가 2가 아니다: $D_OPP"; FAIL=1; }
[ "$D_SELF" = "0" ] && echo "  OK   저장된 벡터의 자기 거리가 전부 0" || { echo "  FAIL 자기 거리가 0이 아닌 행이 있다: $D_SELF"; FAIL=1; }
if [ "$N_DIST" = "$N_ROWS" ] && [ "${N_ROWS:-0}" -gt 1 ] 2>/dev/null; then
  echo "  OK   거리 값이 전부 다르다 — 상수 벡터가 아니다"
else
  echo "  FAIL 같은 거리 값이 겹친다 ($N_DIST 가지 / $N_ROWS 행)"
  FAIL=1
fi

# 주제가 같은 발화가 다른 발화보다 가까운가. group 은 t6-seed.txt 가 준다.
NEAR_TOPIC=$(awk -F"$TAB" 'NR == 1 { print $2 }' "$DIST_TSV")
NEAR_GROUP=$(t6_map_group_of "$NEAR_TOPIC")
FAR_TOPIC=$(tail -n 1 "$DIST_TSV" | cut -f2)
FAR_GROUP=$(t6_map_group_of "$FAR_TOPIC")
echo "  가장 가까운 발화: $NEAR_TOPIC (group=$NEAR_GROUP)"
echo "  가장 먼 발화    : $FAR_TOPIC (group=$FAR_GROUP)"
if [ "$NEAR_GROUP" != "off" ] && [ "$FAR_GROUP" = "off" ]; then
  echo "  OK   '$T6_QUERY' 에 가장 가까운 것이 주제가 같은 발화, 가장 먼 것이 주제가 다른 발화다"
else
  echo "  FAIL 거리 순서가 주제를 반영하지 않는다 (가까움=$NEAR_GROUP 멂=$FAR_GROUP)"
  FAIL=1
fi

echo
echo "== 4. 세 이름이 번들 확장 소속인가 (pg_depend)"
OWNER_TSV=$(printf '%s\n' "
SELECT p.proname, e.extname, p.probin
FROM pg_proc p
JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
JOIN pg_extension e ON e.oid = d.refobjid
WHERE p.proname IN ('likequery','bigm_similarity','cosine_distance')
ORDER BY 1;" | t6_tsv_stdin)
printf '%s\n' "$OWNER_TSV" | sed 's/^/  /'
for want in "likequery${TAB}pg_bigm" "bigm_similarity${TAB}pg_bigm" "cosine_distance${TAB}vector"; do
  if printf '%s\n' "$OWNER_TSV" | grep -qF "$want"; then
    echo "  OK   ${want%%$TAB*} 가 ${want##*$TAB} 확장 소속이다"
  else
    echo "  FAIL ${want%%$TAB*} 가 ${want##*$TAB} 확장 소속이 아니다"
    FAIL=1
  fi
done
# <=> 가 정말 pgvector 의 코사인 거리 함수를 부르는가 (이름만 같은 다른
# 연산자가 아니다). oprcode::text 는 동명 오버로드(vector/halfvec/sparsevec)가
# 있어 스키마까지 붙은 'public.cosine_distance' 로 나온다 — 스키마를 떼고 본다.
OP_FN=$(t6_scalar "SELECT o.oprcode::text FROM pg_operator o
                   WHERE o.oprname = '<=>'
                     AND o.oprleft = 'vector'::regtype AND o.oprright = 'vector'::regtype")
if [ "${OP_FN##*.}" = "cosine_distance" ]; then
  echo "  OK   vector <=> vector 의 구현 함수가 cosine_distance 다 ($OP_FN)"
else
  echo "  FAIL <=> 의 구현 함수가 '$OP_FN' 다"
  FAIL=1
fi

PKGLIB=$("$EXP_ROOT/bundle/pg/bin/pg_config" --pkglibdir 2>/dev/null)
{
  echo "# Task 6 V4 — pg_bigm / pgvector 연산 확인 (스펙 P0-C2)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 격리: 클라이언트라 격리 대상이 아니다 (스펙 §4.0). 확장 .dylib 의 로드"
  echo "#       경로가 번들 안이라는 실측은 Task 2 V3 의 t2-extension-load-dyld.txt 다."
  echo "# 번들 pkglibdir: ${PKGLIB:-<pg_config 실패>}"
  echo "# meeting_id: $MID   질의: '$T6_QUERY'"
  echo
  echo "## likequery"
  echo "likequery('$T6_QUERY')      = $LQ"
  echo "likequery('50% 절감')       = $LQ_PCT"
  echo "LIKE likequery 로 고른 행   = $LQ_HITS"
  echo "position() 으로 고른 행     = $POS_HITS"
  echo
  echo "## bigm_similarity"
  echo "('예산 집행','예산 집행')   = $SIM_SAME"
  echo "('예산 집행','예산 승인')   = $SIM_NEAR"
  echo "('예산 집행','국밥 점심')   = $SIM_FAR"
  echo "[0,1] 밖의 값               = $SIM_RANGE 건"
  echo "서로 다른 값                = $SIM_DISTINCT 가지"
  echo
  echo "## <=>"
  echo "'[1,0,0]' <=> '[0,1,0]'     = $D_ORTH"
  echo "'[1,2,3]' <=> '[1,2,3]'     = $D_SAME"
  echo "'[1,0,0]' <=> '[-1,0,0]'    = $D_OPP"
  echo "자기 거리 != 0 인 행         = $D_SELF"
  echo "서로 다른 거리 값            = $N_DIST 가지 / $N_ROWS 행"
  echo
  echo "## 시드 임베딩과 질의 '$T6_QUERY' 의 거리 (가까운 순)"
  echo "# order_index<TAB>utterance_id<TAB>dist<TAB>bigm_similarity<TAB>LIKE likequery<TAB>text"
  cat "$DIST_TSV"
  echo
  echo "## 함수 소속 (pg_depend)"
  echo "# proname<TAB>extname<TAB>probin"
  printf '%s\n' "$OWNER_TSV"
  echo "vector <=> vector 의 oprcode = $OP_FN"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 못했다"; exit 1; }
echo "판정: likequery·bigm_similarity·<=> 가 정의대로 동작한다"
exit 0
