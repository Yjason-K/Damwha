#!/bin/bash
# 계획 Task 7 V3 — t7-meeting-id.txt 의 회의가 status='done' 인가 (스펙 P0-C4).
#
# "outcome" 을 회의 한 행으로 좁혀 보지 않는다. P0-C4 의 성공 판정은
# "`outcome: committed`, 회의 `status=done`, 화자별 발화가 텍스트와 함께 1건
# 이상" 이고, 앞 두 개가 이 스크립트, 마지막이 t7-utterances.sh 다.
#
# 여기서 같이 보는 것은 **normalize/probe 와 persist 가 실제로 돌았다는 DB
# 흔적**이다. 둘 다 utterance 행이 아니라 meeting/job 행에 남는다.
#   normalize → meeting.normalized_key 가 채워지고 그 파일이 실제로 있다
#   probe     → meeting.duration_ms 가 채워진다 (ffprobe 출력이 유일한 출처)
#   persist   → job.status='done', progress=100, error IS NULL
#
# 파이프라인 여덟 단계의 완료 로그도 대조한다. VAD 는 산출물이 DB 행이 아니라
# STT 입력 구간이라 DB 만으로는 "돌았다"를 보일 수 없다 — timed_stage 의 완료
# 줄이 그 단계의 직접 증거다.
#
# **스코프.** 같은 DB 에 Task 6 의 mtg_1(발화 12건)이 있다. 이 스크립트의 모든
# 질의는 t7-meeting-id.txt 의 id 하나로 좁힌다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t7-lib.sh"

FAIL=0
OUT=$(t7_evidence_path "t7-outcome.txt")

MID=$(t7_meeting_id) || { echo "FAIL: $T7_MEETING_ID_FILE 에서 회의 id 를 읽지 못했다"; exit 1; }
T6MID=$(t6_meeting_id || echo "")

REPORT=$(
  echo "== 회의 id (모든 질의를 이 id 로 스코프한다)"
  echo "  t7-meeting-id.txt : $MID"
  echo "  t6-meeting-id.txt : ${T6MID:-없음}"
  if [ -n "$T6MID" ] && [ "$MID" = "$T6MID" ]; then
    echo "  FAIL Task 6 의 회의와 같은 id 다 — 그 시드를 세고 있다"
    echo "RC_ID=1"
  else
    echo "  OK   Task 6 의 회의와 다른 id 다"
    echo "RC_ID=0"
  fi

  echo
  echo "== 의존 서비스"
  if t7_require_db; then echo "RC_DB=0"; else echo "  FAIL DB 에 붙지 못했다"; echo "RC_DB=1"; fi

  echo
  echo "== meeting 행 ($MID)"
  ROW=$(t7_tsv "SELECT status, coalesce(duration_ms::text,'-'), coalesce(normalized_key,'-'),
                       processing_version, coalesce(error::text,'null')
                  FROM meeting WHERE id = '$MID'")
  if [ -z "$ROW" ]; then
    echo "  FAIL 회의 $MID 가 DB 에 없다"
    echo "RC_MEETING=1"
  else
    STATUS=$(printf '%s' "$ROW" | cut -f1)
    DUR=$(printf '%s' "$ROW" | cut -f2)
    NKEY=$(printf '%s' "$ROW" | cut -f3)
    PV=$(printf '%s' "$ROW" | cut -f4)
    MERR=$(printf '%s' "$ROW" | cut -f5)
    echo "  status             : $STATUS"
    echo "  duration_ms        : $DUR"
    echo "  normalized_key     : $NKEY"
    echo "  processing_version : $PV"
    echo "  error              : $MERR"
    RC=0
    [ "$STATUS" = "done" ] || { echo "  FAIL status 가 done 이 아니다"; RC=1; }
    # probe — duration_ms 의 유일한 출처는 ffprobe 다 (pipeline/ffmpeg.py::probe)
    if ! t7_is_uint "$DUR"; then
      echo "  FAIL duration_ms 가 비었다 — ffprobe 가 돌지 않았다"
      RC=1
    elif [ "$DUR" -le 0 ]; then
      echo "  FAIL duration_ms 가 0 이다"
      RC=1
    fi
    # normalize — 키가 채워졌고 그 파일이 샌드박스 storage 에 실제로 있다
    if [ "$NKEY" = "-" ]; then
      echo "  FAIL normalized_key 가 비었다 — ffmpeg normalize 가 돌지 않았다"
      RC=1
    else
      NPATH="$ISO_STORAGE_ROOT/$NKEY"
      if [ -s "$NPATH" ]; then
        echo "  OK   정규화 산출물 있음: $NKEY ($(wc -c < "$NPATH" | tr -d ' ') bytes)"
      else
        echo "  FAIL 정규화 산출물이 없다: $NPATH"
        RC=1
      fi
    fi
    [ "$MERR" = "null" ] || { echo "  FAIL meeting.error 가 남아 있다"; RC=1; }
    echo "RC_MEETING=$RC"
  fi

  echo
  echo "== job 행 (이 회의의 process_meeting)"
  JROW=$(t7_tsv "SELECT id, type, status, coalesce(progress::text,'-'), coalesce(stage,'-'),
                        attempts, coalesce(error::text,'null')
                   FROM job WHERE meeting_id = '$MID' AND type = 'process_meeting'
                   ORDER BY created_at DESC LIMIT 1")
  if [ -z "$JROW" ]; then
    echo "  FAIL 이 회의의 process_meeting job 이 없다"
    echo "RC_JOB=1"
  else
    JID=$(printf '%s' "$JROW" | cut -f1)
    JSTATUS=$(printf '%s' "$JROW" | cut -f3)
    JPROG=$(printf '%s' "$JROW" | cut -f4)
    JSTAGE=$(printf '%s' "$JROW" | cut -f5)
    JATT=$(printf '%s' "$JROW" | cut -f6)
    JERR=$(printf '%s' "$JROW" | cut -f7)
    echo "  id       : $JID"
    echo "  status   : $JSTATUS   progress: $JPROG   stage: $JSTAGE   attempts: $JATT"
    echo "  error    : $JERR"
    RC=0
    [ "$JSTATUS" = "done" ] || { echo "  FAIL job.status 가 done 이 아니다"; RC=1; }
    [ "$JPROG" = "100" ] || { echo "  FAIL job.progress 가 100 이 아니다 — persist 가 끝나지 않았다"; RC=1; }
    [ "$JERR" = "null" ] || { echo "  FAIL job.error 가 남아 있다"; RC=1; }
    echo "RC_JOB=$RC"
  fi

  echo
  echo "== 후속 job (payload followups 를 껐다 — 큐가 비어 있어야 한다)"
  QN=$(t7_scalar "SELECT count(*) FROM job WHERE status = 'queued'")
  echo "  queued job: ${QN:-?}"
  if [ "${QN:-1}" = "0" ]; then
    echo "  OK   재실행이 멱등하다 (다음 회차의 db.claim 이 남의 job 을 집지 않는다)"
    echo "RC_QUEUE=0"
  else
    t7_tsv "SELECT id, type, status FROM job WHERE status = 'queued' ORDER BY created_at" \
      | sed 's/^/       /'
    echo "  FAIL queued job 이 남아 있다"
    echo "RC_QUEUE=1"
  fi

  echo
  echo "== 파이프라인 단계 완료 로그 (pipeline/timing.py::timed_stage)"
  echo "   DB 행이 없는 단계(특히 VAD)는 이 줄이 유일한 직접 증거다."
  SRC=0
  for st in normalize vad diarize embed identify stt align persist; do
    LINE=$(t7_stage_line "$MID" "$st" || true)
    if [ -n "$LINE" ]; then
      echo "  OK   $st"
      echo "       ${LINE#*INFO }"
    else
      echo "  FAIL $st 의 완료 줄이 $T7_STDERR_TXT 에 없다"
      SRC=1
    fi
  done
  echo "RC_STAGES=$SRC"
)

printf '%s\n' "$REPORT" | grep -v '^RC_'

for k in RC_ID RC_DB RC_MEETING RC_JOB RC_QUEUE RC_STAGES; do
  v=$(printf '%s\n' "$REPORT" | sed -n "s/^$k=//p" | tail -n 1)
  [ "$v" = "0" ] || FAIL=1
done

{
  echo "# Task 7 V3 — 회의가 done 인가 / normalize·probe·persist 가 돌았는가 (P0-C4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 스코프: $MID (t7-meeting-id.txt). Task 6 의 ${T6MID:-mtg_?} 은 세지 않는다."
  echo "# 격리: 이 스크립트는 **클라이언트**다 — 서버에 붙어 질의할 뿐이므로"
  echo "#       G2 를 지나지 않는다 (스펙 §4.0)."
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 않는다"; exit 1; }
echo "판정: $MID 가 status='done' 이고, normalize/probe/persist 의 DB 흔적과 여덟 단계 완료 로그가 있다"
exit 0
