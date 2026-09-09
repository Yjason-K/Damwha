#!/bin/bash
# 계획 Task 6 V2 — 시드가 실제로 들어갔는가 (스펙 P0-C2 확인 방법의 앞쪽).
#
# 확인하는 것은 넷이다.
#   1. $EVIDENCE/t6-meeting-id.txt 의 회의가 DB에 있고 status='done' 이다
#      (검색 쿼리의 filterSql 이 그것을 요구한다).
#   2. 그 회의의 status='ok' 발화 수 = model='BAAI/bge-m3' dimension=1024 인
#      임베딩 수이고 0보다 크다.
#   3. 저장된 벡터의 **실제 차원**이 1024다. dimension 컬럼은 메타값일 뿐이라
#      vector_dims() 로 다시 잰다.
#   4. 벡터가 서로 다르다. 난수·상수 벡터를 넣고 "sem 이 결과를 냈다"고 적는
#      길을 막는 검사다 (계획 Task 6 Review).
#
# 이 스크립트는 클라이언트이므로 격리 대상이 아니다 (스펙 §4.0). 다만 psql 은
# 번들 바이너리라, 도는 것 자체가 재배치 후 libpq 로드가 살아 있다는 확인이다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t6-lib.sh"

FAIL=0
OUT=$(t6_evidence_path "t6-seed-check.txt")

echo "== 서비스 준비"
t6_require_services || { echo "  FAIL 서비스를 띄우지 못했다"; exit 1; }
t6_require_seed     || { echo "  FAIL 시드를 만들지 못했다"; exit 1; }

MID=$(t6_meeting_id) || { echo "FAIL: $MEETING_ID_FILE 를 읽지 못했다"; exit 1; }
MAPN=$(t6_map_count)

echo
echo "== 1. 회의 (meeting_id: $MID)"
M_STATUS=$(t6_scalar "SELECT status FROM meeting WHERE id = '$MID'")
M_PV=$(t6_scalar "SELECT processing_version FROM meeting WHERE id = '$MID'")
M_TITLE=$(bash "$PG_PSQL" -q -t -A -c "SELECT title FROM meeting WHERE id = '$MID'" 2>/dev/null)
if [ "$M_STATUS" = "done" ]; then
  echo "  OK   status=done (filterSql 의 m.status='done' 조건을 만족한다)"
else
  echo "  FAIL status가 done이 아니라 '${M_STATUS:-없음}' 이다"
  FAIL=1
fi

echo
echo "== 2. 발화와 임베딩"
N_UTT=$(t6_scalar "SELECT count(*) FROM utterance
                   WHERE meeting_id = '$MID' AND status = 'ok' AND text IS NOT NULL")
N_EMB=$(t6_scalar "SELECT count(*) FROM utterance_embedding e
                   JOIN utterance u ON u.id = e.utterance_id
                   WHERE u.meeting_id = '$MID'
                     AND e.model = '$T6_MODEL' AND e.dimension = $T6_DIM")
N_PV=$(t6_scalar "SELECT count(*) FROM utterance u JOIN meeting m ON m.id = u.meeting_id
                  WHERE u.meeting_id = '$MID' AND u.processing_version = m.processing_version")
echo "  status='ok' 발화                 : $N_UTT"
echo "  model/dimension 일치 임베딩      : $N_EMB"
echo "  processing_version 일치 발화     : $N_PV"
echo "  t6-seed.txt 의 시드 목록         : $MAPN"

if [ "${N_UTT:-0}" -gt 0 ] 2>/dev/null; then
  echo "  OK   발화가 0건이 아니다"
else
  echo "  FAIL 발화가 0건이다"
  FAIL=1
fi
if [ "$N_EMB" = "$N_UTT" ]; then
  echo "  OK   임베딩 수가 발화 수와 같다 ($N_EMB)"
else
  echo "  FAIL 임베딩 수($N_EMB)가 발화 수($N_UTT)와 다르다"
  FAIL=1
fi
if [ "$N_PV" = "$N_UTT" ]; then
  echo "  OK   발화의 processing_version이 회의의 것($M_PV)과 같다 — filterSql 조건"
else
  echo "  FAIL processing_version이 어긋난 발화가 있다 ($N_PV / $N_UTT)"
  FAIL=1
fi
if [ "$MAPN" = "$N_UTT" ]; then
  echo "  OK   증거의 시드 목록과 DB의 발화 수가 같다"
else
  echo "  FAIL 증거의 시드 목록($MAPN)과 DB($N_UTT)가 다르다 — 증거가 이 회차의 것이 아니다"
  FAIL=1
fi

echo
echo "== 3. 저장된 벡터의 실제 차원 (dimension 컬럼이 아니라 vector_dims)"
BADDIM=$(t6_scalar "SELECT count(*) FROM utterance_embedding e
                    JOIN utterance u ON u.id = e.utterance_id
                    WHERE u.meeting_id = '$MID' AND vector_dims(e.embedding) <> $T6_DIM")
if [ "$BADDIM" = "0" ]; then
  echo "  OK   전 행의 vector_dims(embedding) = $T6_DIM"
else
  echo "  FAIL 차원이 $T6_DIM 이 아닌 행이 ${BADDIM}건 있다"
  FAIL=1
fi

echo
echo "== 4. 벡터가 서로 다른가 (난수·상수 벡터 차단)"
N_DISTINCT=$(t6_scalar "SELECT count(DISTINCT e.embedding::text) FROM utterance_embedding e
                        JOIN utterance u ON u.id = e.utterance_id
                        WHERE u.meeting_id = '$MID'")
N_NORM1=$(t6_scalar "SELECT count(*) FROM utterance_embedding e
                     JOIN utterance u ON u.id = e.utterance_id
                     WHERE u.meeting_id = '$MID'
                       AND abs(1 - (e.embedding <#> e.embedding) * -1) < 0.01")
if [ "$N_DISTINCT" = "$N_EMB" ]; then
  echo "  OK   서로 다른 벡터가 $N_DISTINCT 개 — 같은 값을 복제해 넣은 것이 아니다"
else
  echo "  FAIL 서로 다른 벡터가 $N_DISTINCT 개뿐이다 (임베딩 $N_EMB 건)"
  FAIL=1
fi
if [ "$N_NORM1" = "$N_EMB" ]; then
  echo "  OK   전 행의 L2 노름이 1이다 — bge-m3(정규화 출력)의 벡터 형태다"
else
  echo "  FAIL 노름이 1이 아닌 행이 있다 ($N_NORM1 / $N_EMB) — 임의 값일 수 있다"
  FAIL=1
fi

{
  echo "# Task 6 V2 — 시드 확인 (스펙 P0-C2)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 격리: 클라이언트라 격리 대상이 아니다 (스펙 §4.0). 접속 대상은 실험 DB"
  echo "#       127.0.0.1:$EXP_PG_PORT 이고 개발 5432가 아니다."
  echo "# meeting_id : $MID"
  echo "# title      : $M_TITLE"
  echo "# status     : $M_STATUS   processing_version: $M_PV"
  echo "# 발화(ok)   : $N_UTT"
  echo "# 임베딩     : $N_EMB  (model=$T6_MODEL dimension=$T6_DIM)"
  echo "# vector_dims != $T6_DIM 인 행: $BADDIM"
  echo "# 서로 다른 벡터: $N_DISTINCT"
  echo "# L2 노름 = 1 인 행: $N_NORM1"
  echo
  echo "## 시드 발화와 임베딩 (order_index / group / id / 벡터 앞 3개)"
  echo "SELECT ... FROM utterance u JOIN utterance_embedding e ..."
  bash "$PG_PSQL" -q -t -A -F "$TAB" -c "
    SELECT u.order_index, u.id, e.model, e.dimension,
           substring(e.embedding::text from 1 for 40) || '...', u.text
    FROM utterance u JOIN utterance_embedding e ON e.utterance_id = u.id
    WHERE u.meeting_id = '$MID' ORDER BY u.order_index" 2>&1
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 못했다"; exit 1; }
echo "판정: 시드 ${N_UTT}건과 같은 수의 bge-m3 1024차원 임베딩이 실험 DB에 있다"
exit 0
