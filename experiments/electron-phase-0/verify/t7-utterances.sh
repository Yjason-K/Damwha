#!/bin/bash
# 계획 Task 7 V4 — **그 회의의** status='ok' 발화가 1건 이상이고 text 가 비어
# 있지 않으며, diar_label 의 서로 다른 값이 1개 이상인가 (스펙 P0-C4).
#
# 여기서 확인되는 단계는 셋이다.
#   STT        → text 가 비어 있지 않은 status='ok' 행 (mlx-whisper 의 단어가
#                align 을 거쳐 들어온 것이 이 행이다)
#   diarization→ diar_label 의 서로 다른 값. **`speaker_cluster_id` 같은 컬럼은
#                없다** (001_init.sql:72). 그 컬럼이 실제로 없다는 것까지
#                information_schema 로 확인한다.
#   ECAPA      → meeting_cluster.centroid(vector(192)) 와 그 클러스터에서 나온
#                auto_cluster voiceprint. 임베딩이 돌지 않으면 centroid 가
#                NULL 이고 voiceprint 도 안 생긴다 (db/meetings.py:104).
#
# **스코프.** 같은 DB 에 Task 6 의 mtg_1(발화 12건, diar_label 2종)이 있다.
# 스코프 없이 세면 그것까지 세고, 그러면 이 검사는 Task 7 이 아무것도 만들지
# 않아도 통과한다. 그래서 mtg_1 의 발화 수도 같이 출력해 두 회의가 갈려 있음을
# 보인다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t7-lib.sh"

FAIL=0
OUT=$(t7_evidence_path "t7-utterances.txt")

MID=$(t7_meeting_id) || { echo "FAIL: $T7_MEETING_ID_FILE 에서 회의 id 를 읽지 못했다"; exit 1; }
T6MID=$(t6_meeting_id || echo "")

PV="$T7_PROCESSING_VERSION"

REPORT=$(
  echo "== 스코프"
  echo "  대상 회의        : $MID  (processing_version=$PV)"
  echo "  Task 6 의 회의   : ${T6MID:-없음} — 세지 않는다"
  if t7_require_db; then echo "RC_DB=0"; else echo "  FAIL DB 에 붙지 못했다"; echo "RC_DB=1"; fi

  echo
  echo "== utterance 의 컬럼 (화자 분리 결과는 diar_label 이다)"
  HAS_DIAR=$(t7_scalar "SELECT count(*) FROM information_schema.columns
                         WHERE table_name='utterance' AND column_name='diar_label'")
  HAS_SCID=$(t7_scalar "SELECT count(*) FROM information_schema.columns
                         WHERE table_name='utterance' AND column_name='speaker_cluster_id'")
  echo "  diar_label         컬럼 수: ${HAS_DIAR:-?}  (1 이어야 한다)"
  echo "  speaker_cluster_id 컬럼 수: ${HAS_SCID:-?}  (0 이어야 한다 — 존재하지 않는 컬럼이다)"
  RC=0
  [ "${HAS_DIAR:-0}" = "1" ] || { echo "  FAIL diar_label 컬럼이 없다"; RC=1; }
  [ "${HAS_SCID:-1}" = "0" ] || { echo "  FAIL speaker_cluster_id 컬럼이 생겼다 — 이 검사의 전제가 바뀌었다"; RC=1; }
  echo "RC_COLUMNS=$RC"

  echo
  echo "== 회의별 발화 수 (스코프가 갈려 있는가)"
  t7_tsv "SELECT meeting_id, count(*) FROM utterance GROUP BY meeting_id ORDER BY meeting_id" \
    | sed 's/^/  /'

  echo
  echo "== $MID 의 발화"
  N_ALL=$(t7_scalar "SELECT count(*) FROM utterance
                      WHERE meeting_id='$MID' AND processing_version=$PV")
  N_OK=$(t7_scalar "SELECT count(*) FROM utterance
                     WHERE meeting_id='$MID' AND processing_version=$PV AND status='ok'")
  N_OK_TEXT=$(t7_scalar "SELECT count(*) FROM utterance
                          WHERE meeting_id='$MID' AND processing_version=$PV
                            AND status='ok' AND text IS NOT NULL AND btrim(text) <> ''")
  echo "  전체                              : ${N_ALL:-?}"
  echo "  status='ok'                       : ${N_OK:-?}"
  echo "  status='ok' 이고 text 가 비지 않음 : ${N_OK_TEXT:-?}"
  echo "  status 분포:"
  t7_tsv "SELECT status, count(*) FROM utterance
           WHERE meeting_id='$MID' AND processing_version=$PV
           GROUP BY status ORDER BY status" | sed 's/^/    /'
  RC=0
  if ! t7_is_uint "${N_OK_TEXT:-}"; then
    echo "  FAIL 발화 수를 세지 못했다"
    RC=1
  elif [ "$N_OK_TEXT" -ge 1 ]; then
    echo "  OK   text 가 있는 status='ok' 발화가 ${N_OK_TEXT}건 (1건 이상)"
  else
    echo "  FAIL text 가 있는 status='ok' 발화가 0건이다 — STT 결과가 없다"
    RC=1
  fi
  echo "RC_UTTERANCES=$RC"

  echo
  echo "== $MID 의 diar_label (화자 분리가 실제로 돌았는가)"
  echo "  모델: $T7_DIAR_MODEL"
  N_LABEL=$(t7_scalar "SELECT count(DISTINCT diar_label) FROM utterance
                        WHERE meeting_id='$MID' AND processing_version=$PV")
  echo "  서로 다른 diar_label: ${N_LABEL:-?}"
  echo "  라벨별 발화 수:"
  t7_tsv "SELECT diar_label, count(*), count(*) FILTER (WHERE status='ok')
            FROM utterance WHERE meeting_id='$MID' AND processing_version=$PV
            GROUP BY diar_label ORDER BY diar_label" | sed 's/^/    /'
  RC=0
  if ! t7_is_uint "${N_LABEL:-}"; then
    echo "  FAIL diar_label 수를 세지 못했다"
    RC=1
  elif [ "$N_LABEL" -ge 1 ]; then
    echo "  OK   서로 다른 diar_label 이 ${N_LABEL}개 (1개 이상)"
  else
    echo "  FAIL diar_label 이 하나도 없다"
    RC=1
  fi
  echo "RC_LABELS=$RC"

  echo
  echo "== ECAPA 임베딩의 DB 흔적 ($T7_EMBED_MODEL, ${T7_EMBED_DIM}차원)"
  N_CLU=$(t7_scalar "SELECT count(*) FROM meeting_cluster WHERE meeting_id='$MID'")
  N_CENT=$(t7_scalar "SELECT count(*) FROM meeting_cluster
                       WHERE meeting_id='$MID' AND centroid IS NOT NULL")
  N_VP=$(t7_scalar "SELECT count(*) FROM voiceprint v
                     JOIN meeting_cluster c ON c.id = v.source_cluster_id
                     WHERE c.meeting_id='$MID' AND v.source='auto_cluster'
                       AND v.model='$T7_EMBED_MODEL' AND v.dimension=$T7_EMBED_DIM")
  echo "  meeting_cluster 행          : ${N_CLU:-?}"
  echo "  그중 centroid 가 NULL 이 아닌 것: ${N_CENT:-?}"
  echo "  auto_cluster voiceprint      : ${N_VP:-?}"
  RC=0
  if ! t7_is_uint "${N_CENT:-}"; then
    echo "  FAIL centroid 수를 세지 못했다"
    RC=1
  elif [ "$N_CENT" -lt 1 ]; then
    echo "  FAIL centroid 가 하나도 없다 — ECAPA 임베딩이 돌지 않았다"
    RC=1
  fi
  if ! t7_is_uint "${N_VP:-}"; then
    echo "  FAIL voiceprint 수를 세지 못했다"
    RC=1
  elif [ "$N_VP" -lt 1 ]; then
    echo "  FAIL auto_cluster voiceprint 가 없다"
    RC=1
  fi
  [ "$RC" = "0" ] && echo "  OK   centroid ${N_CENT}건 / voiceprint ${N_VP}건 — 임베딩이 돌았다"
  echo "RC_ECAPA=$RC"

  echo
  echo "== 텍스트 표본 (앞 3건의 길이만 — 회의 내용은 PII 라 싣지 않는다)"
  t7_tsv "SELECT order_index, diar_label, length(text)
            FROM utterance WHERE meeting_id='$MID' AND processing_version=$PV
              AND status='ok' AND btrim(coalesce(text,'')) <> ''
            ORDER BY order_index LIMIT 3" | sed 's/^/  order_index=/'
)

printf '%s\n' "$REPORT" | grep -v '^RC_'

for k in RC_DB RC_COLUMNS RC_UTTERANCES RC_LABELS RC_ECAPA; do
  v=$(printf '%s\n' "$REPORT" | sed -n "s/^$k=//p" | tail -n 1)
  [ "$v" = "0" ] || FAIL=1
done

{
  echo "# Task 7 V4 — 그 회의의 발화와 diar_label (P0-C4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 스코프: $MID (t7-meeting-id.txt). Task 6 의 ${T6MID:-mtg_?} 은 세지 않는다."
  echo "# 정확도는 판정 대상이 아니다 — 파이프라인이 실행되는가만 본다 (스펙 P0-C4 비고)."
  echo "# 격리: 이 스크립트는 **클라이언트**다 (스펙 §4.0)."
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 않는다"; exit 1; }
echo "판정: $MID 에 text 가 있는 status='ok' 발화가 1건 이상이고 diar_label 이 1개 이상이다"
exit 0
