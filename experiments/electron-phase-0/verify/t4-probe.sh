#!/bin/bash
# 계획 Task 4 V2 — 번들 ffprobe가 pipeline/ffmpeg.py::probe()와 같은 명령으로
# duration을 담은 JSON을 반환하는가 (스펙 P0-C6).
#
# be/worker/damwha_worker/pipeline/ffmpeg.py::probe()가 실제로 실행하는 명령
# 그대로다 — 임의로 다시 구성하지 않는다:
#   ffprobe -v error -show_entries format=duration -of json <path>
#
# 입력은 Task 1이 be/storage/meetings/mtg_28/original.flac에서 복사한
# $SANDBOX/audio/sample.flac이다 (원본은 건드리지 않는다, 스펙 §4.4).
# 기대 duration은 probe/audio-source.txt에 Task 1이 이미 기록해 둔 값과
# 대조한다 — "JSON을 반환했다"만으로는 값이 맞는지 알 수 없다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t4-lib.sh"

t4_require_bundle || exit 1
t4_require_sample || exit 1

AUDIO_SRC_NOTE="$PROBE_DIR/audio-source.txt"
[ -f "$AUDIO_SRC_NOTE" ] || { echo "FAIL: $AUDIO_SRC_NOTE 가 없다 (Task 1 산출물)"; exit 1; }
EXPECT_DURATION=$(sed -n 's/^원본 duration  : \([0-9.]*\) s$/\1/p' "$AUDIO_SRC_NOTE" | head -n 1)
[ -n "$EXPECT_DURATION" ] || { echo "FAIL: audio-source.txt에서 원본 duration을 못 읽었다"; exit 1; }

OUT=$(t4_evidence_path "t4-probe.txt")

echo "== 격리 실행 (스펙 §4.2) — 번들 ffprobe가 env -i에 직접 exec된다"
echo "   명령: ffprobe -v error -show_entries format=duration -of json <sample.flac>"
RAW=$(t4_run_ffprobe t4-probe -v error -show_entries format=duration -of json "$SAMPLE_AUDIO")
RC=$?

{
  echo "# Task 4 V2 — 번들 ffprobe (재배치 후, P0-C6)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 실행: run-isolated.sh --label t4-probe -- $BUNDLE_FFPROBE -v error -show_entries format=duration -of json $SAMPLE_AUDIO"
  echo "# 이 명령은 be/worker/damwha_worker/pipeline/ffmpeg.py::probe()가 쓰는 것과 정확히 같다"
  echo "# exit: $RC"
  echo "# 기대 duration (probe/audio-source.txt, Task 1 기록): $EXPECT_DURATION"
  echo
  echo "$RAW"
} > "$OUT"

FAIL=0

if [ $RC -ne 0 ] || [ -z "$RAW" ]; then
  echo "  FAIL 격리 실행이 exit $RC 로 끝났다. 증거: $OUT"
  exit 1
fi

echo
echo "== JSON 판정 (system python3 — 검사 도구, 스펙 §4.0 예외)"
GOT_DURATION=$(printf '%s' "$RAW" | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d["format"]["duration"])
except Exception:
    print("")
' 2>/dev/null)

if [ -z "$GOT_DURATION" ]; then
  echo "  FAIL JSON에서 format.duration을 못 읽었다"
  echo "  원본 출력: $RAW"
  FAIL=1
else
  echo "  얻은 duration : $GOT_DURATION"
  echo "  기대 duration : $EXPECT_DURATION"
  # 부동소수점을 정수 마이크로초로 바꿔 비교한다 (bash에는 부동소수 비교가 없다).
  DIFF_US=$(/usr/bin/python3 -c "
got = float('$GOT_DURATION')
exp = float('$EXPECT_DURATION')
print(round(abs(got - exp) * 1_000_000))
" 2>/dev/null)
  if [ -n "$DIFF_US" ] && [ "$DIFF_US" -lt 1000 ]; then
    echo "  OK   원본 duration과 일치 (오차 ${DIFF_US}us < 1ms)"
  else
    echo "  FAIL duration이 원본과 다르다 (오차 ${DIFF_US:-?}us)"
    FAIL=1
  fi
fi

echo
echo "== dyld 실측이 진짜인가 (계획 규칙 6b)"
t4_assert_dyld_measured "$EVIDENCE/t4-probe-dyld.txt" || FAIL=1

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "번들 ffprobe가 pipeline/ffmpeg.py와 같은 명령으로 정확한 duration을 반환했다"
exit 0
