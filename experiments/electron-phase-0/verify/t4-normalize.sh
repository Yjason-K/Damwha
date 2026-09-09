#!/bin/bash
# 계획 Task 4 V3 — 번들 ffmpeg가 pipeline/ffmpeg.py::normalize()와 같은 명령으로
# 16 kHz mono FLAC을 만드는가 (스펙 P0-C6).
#
# be/worker/damwha_worker/pipeline/ffmpeg.py::normalize()가 실제로 실행하는
# 명령 그대로다 — 임의로 다시 구성하지 않는다:
#   ffmpeg -y -i <src> -ac 1 -ar 16000 -sample_fmt s16 -c:a flac \
#     -compression_level 5 -f flac <dst>
#
# 입력은 Task 1이 복사한 $SANDBOX/audio/sample.flac이고, 산출물은
# $SANDBOX/run/에 쓴다 — be/storage 원본은 건드리지 않는다 (스펙 §4.4).
#
# 산출물의 sample_rate·channels 확인은 **별도의 격리 실행**(ffprobe)으로
# 한다 — G2는 모든 실행 검증이 지나는 통로다(스펙 §4.2). 판정에 쓰는 건
# ffmpeg 자신의 로그가 아니라 ffprobe가 산출물을 다시 읽어 보고하는 값이다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t4-lib.sh"

t4_require_bundle || exit 1
t4_require_sample || exit 1

exp_ensure_sandbox
mkdir -p "$SANDBOX/run"
DST="$SANDBOX/run/t4-normalized.flac"
rm -f "$DST"

OUT=$(t4_evidence_path "t4-normalize.txt")

echo "== 격리 실행 1/2 (스펙 §4.2) — 번들 ffmpeg가 env -i에 직접 exec된다"
echo "   명령: ffmpeg -y -i <sample.flac> -ac 1 -ar 16000 -sample_fmt s16 -c:a flac -compression_level 5 -f flac <출력>"
RAW=$(t4_run_ffmpeg t4-normalize -y -i "$SAMPLE_AUDIO" \
        -ac 1 -ar 16000 -sample_fmt s16 -c:a flac -compression_level 5 -f flac "$DST")
RC=$?

FAIL=0

{
  echo "# Task 4 V3 — 번들 ffmpeg normalize (재배치 후, P0-C6)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 실행: run-isolated.sh --label t4-normalize -- $BUNDLE_FFMPEG -y -i $SAMPLE_AUDIO -ac 1 -ar 16000 -sample_fmt s16 -c:a flac -compression_level 5 -f flac $DST"
  echo "# 이 명령은 be/worker/damwha_worker/pipeline/ffmpeg.py::normalize()가 쓰는 것과 정확히 같다"
  echo "# exit: $RC"
  echo
  echo "$RAW"
} > "$OUT"

if [ $RC -ne 0 ]; then
  echo "  FAIL ffmpeg가 exit $RC 로 끝났다. 증거: $OUT"
  exit 1
fi

if [ ! -s "$DST" ]; then
  echo "  FAIL 산출물이 생성되지 않았거나 비어 있다: $DST"
  exit 1
fi
echo "  OK   산출물 생성: $DST ($(wc -c < "$DST" | tr -d ' ') bytes)"

echo
echo "== 격리 실행 2/2 — 산출물을 ffprobe로 다시 읽어 sample_rate/channels 확인"
PROBE_RAW=$(t4_run_ffprobe t4-normalize-check -v error \
              -show_entries stream=sample_rate,channels -of json "$DST")
PROBE_RC=$?

{
  echo
  echo "## ffprobe 로 재확인 (별도 격리 실행, label: t4-normalize-check)"
  echo "exit: $PROBE_RC"
  echo "$PROBE_RAW"
} >> "$OUT"

if [ $PROBE_RC -ne 0 ] || [ -z "$PROBE_RAW" ]; then
  echo "  FAIL 산출물 확인용 ffprobe가 exit $PROBE_RC 로 끝났다"
  exit 1
fi

echo
echo "== JSON 판정 (system python3 — 검사 도구, 스펙 §4.0 예외)"
GOT=$(printf '%s' "$PROBE_RAW" | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    s = d["streams"][0]
    print("%s|%s" % (s.get("sample_rate"), s.get("channels")))
except Exception:
    print("|")
' 2>/dev/null)
GOT_RATE="${GOT%%|*}"
GOT_CH="${GOT##*|}"

if [ "$GOT_RATE" = "16000" ]; then
  echo "  OK   sample_rate = 16000"
else
  echo "  FAIL sample_rate = ${GOT_RATE:-없음} (기대: 16000)"
  FAIL=1
fi
if [ "$GOT_CH" = "1" ]; then
  echo "  OK   channels = 1"
else
  echo "  FAIL channels = ${GOT_CH:-없음} (기대: 1)"
  FAIL=1
fi

echo
echo "== dyld 실측이 진짜인가 (계획 규칙 6b) — normalize를 수행한 ffmpeg 프로세스"
t4_assert_dyld_measured "$EVIDENCE/t4-normalize-dyld.txt" || FAIL=1

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "번들 ffmpeg가 pipeline/ffmpeg.py와 같은 명령으로 16 kHz mono 산출물을 만들었다"
exit 0
