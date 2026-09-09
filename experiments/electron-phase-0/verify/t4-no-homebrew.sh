#!/bin/bash
# 계획 Task 4 V4 — t4-probe·t4-normalize의 dyld 증거에 Homebrew ffmpeg가
# 실행된 흔적이 있는가 (스펙 P0-C6, §4.1).
#
# 이 머신의 /opt/homebrew/bin/ffmpeg·ffprobe도 **우연히** 9.0.1이다
# (build.sh와 같은 상류 버전). 그래서 "ffmpeg -version의 버전 문자열"로는
# 번들이 실행됐는지 Homebrew가 실행됐는지 구분할 수 없다 — clang 빌드
# 번호는 다르지만(2100.3.33.1 대 2100.1.1.101) 그건 신뢰할 신호가 아니다.
# 실측 가능한 것은 **dyld가 실제로 어떤 경로의 이미지를 열었는가**뿐이다
# (G2, 스펙 §4.2). t4-probe.sh·t4-normalize.sh가 남긴 dyld 증거에
# /opt/homebrew가 0건인지 그리고 대신 bundle/ffmpeg 아래 이미지가 실제로
# 로드됐는지 t4-lib.sh의 판독 규칙(계획 규칙 6b)으로 확인한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t4-lib.sh"

FAIL=0

check_file() {
  local file="$1" label="$2"
  echo "== $label"
  echo "  증거 파일: $file"
  if [ ! -f "$file" ]; then
    echo "  FAIL 증거 파일이 없다 — 먼저 t4-probe.sh / t4-normalize.sh 를 돌린다"
    FAIL=1
    return
  fi
  if head -n 1 "$file" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
    echo "  FAIL MEASUREMENT_UNAVAILABLE이다 — 실측이 끊겼다"
    FAIL=1
    return
  fi
  local hb
  hb=$(grep -c '^dyld' "$file" | tr -d ' ')
  local hb_hits
  hb_hits=$(grep '^dyld' "$file" | grep -c -F '/opt/homebrew' || true)
  if [ "${hb_hits:-0}" -eq 0 ]; then
    echo "  OK   dyld 줄 ${hb}건 중 /opt/homebrew 0건 — Homebrew ffmpeg 9.0.1이 실행되지 않았다"
  else
    echo "  FAIL dyld 줄에 /opt/homebrew 가 ${hb_hits}건 있다:"
    grep '^dyld' "$file" | grep -F '/opt/homebrew' | sed 's/^/       /'
    FAIL=1
  fi
  t4_assert_dyld_measured "$file" || FAIL=1
}

check_file "$EVIDENCE/t4-probe-dyld.txt"           "t4-probe (ffprobe)"
echo
check_file "$EVIDENCE/t4-normalize-dyld.txt"       "t4-normalize (ffmpeg)"
echo
check_file "$EVIDENCE/t4-normalize-check-dyld.txt" "t4-normalize-check (산출물 재확인 ffprobe)"

echo
[ "$FAIL" -eq 0 ] && echo "판정: 번들 ffmpeg/ffprobe만 실행됐다 — Homebrew 9.0.1 흔적 없음" \
                  || echo "판정: 실패 — 위 목록 참조"
exit $FAIL
