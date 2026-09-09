#!/bin/bash
# 계획 Task 4 V5 — ffmpeg/README.md에 빌드의 라이선스 구성이 기록됐는가
# (스펙 R-8, P0-C6 "함께 기록").
#
# 확인할 것은 세 가지다.
#   1. 실제로 configure가 보고한 License 줄("LGPL")이 README에 있다.
#   2. GPL/nonfree 판단 근거(--disable-gpl 등 플래그)가 README에 있다.
#   3. "LGPL 구성으로 충분한가"에 대한 **판단 문장**이 있다 — 라이선스
#      구성을 나열만 하고 판단이 없으면 R-8을 충족하지 않는다.
#
# 문자열 존재 여부만 보는 얕은 검사이지만, 무엇을 적어야 하는지가 정확히
# 스펙 문면(R-8)에서 나온 요구라 임의 기준이 아니다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t4-lib.sh"

README="$EXP_ROOT/ffmpeg/README.md"
FAIL=0

echo "== t4-license-recorded — ffmpeg/README.md 점검 (스펙 R-8)"
echo "  대상: $README"

if [ ! -f "$README" ]; then
  echo "  FAIL README가 없다"
  exit 1
fi

check_str() {
  local pat="$1" desc="$2"
  if grep -qF -- "$pat" "$README"; then
    echo "  OK   $desc"
  else
    echo "  FAIL 없음: $desc  (찾은 문자열: \"$pat\")"
    FAIL=1
  fi
}

check_str "LGPL" "LGPL 언급 — configure가 보고한 License 줄"
check_str "--disable-gpl" "GPL 비활성 플래그 기록"
check_str "--disable-nonfree" "nonfree 비활성 플래그 기록"

# "충분한가" 판단 문장 — 정확한 문자열이 아니라 판단을 나타내는 표현 중
# 하나라도 있으면 통과. 여러 후보를 두는 이유는 README 저자가 어떤 어투로
# 쓸지까지 강제하면 검사가 아니라 문장 강요가 되기 때문이다.
if grep -qE '(충분하다|충분하지 않|LGPL로 충분|LGPL 구성으로 충분)' "$README"; then
  echo "  OK   LGPL 구성이 담화의 용도(정규화·probe)에 충분한지 판단 문장이 있다"
else
  echo "  FAIL LGPL 구성 충분성에 대한 판단 문장이 없다 (R-8 요구)"
  FAIL=1
fi

# 활성 인코더/디코더에 대한 언급 — R-8은 "활성화된 인코더"도 요구한다.
if grep -qE '(인코더|encoder|디코더|decoder)' "$README"; then
  echo "  OK   활성 인코더/디코더에 대한 언급이 있다"
else
  echo "  FAIL 활성 인코더/디코더에 대한 언급이 없다 (R-8 요구)"
  FAIL=1
fi

echo
[ "$FAIL" -eq 0 ] && echo "판정: README에 라이선스 구성과 판단이 기록돼 있다" \
                  || echo "판정: 기록이 부족하다"
exit $FAIL
