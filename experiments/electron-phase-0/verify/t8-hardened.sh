#!/bin/bash
# 계획 Task 8 V2 — hardened runtime 이 **실제로** 켜졌는가.
#
# 두 방향을 같이 본다. 한쪽만 보면 "켜졌다"가 무엇과 비교해 켜진 것인지가
# 증거에 남지 않는다.
#
#   양성 : 사본 signed/ 의 대표 Mach-O 에 codesign 이 runtime 플래그를 보고한다.
#   음성 : 같은 파일의 **원본** bundle/ 쪽에는 그 플래그가 없다.
#
# 음성 쪽이 두 가지를 동시에 고정한다. (1) runtime 플래그가 우리가 건 서명에서
# 온 것이지 처음부터 있던 것이 아니다. (2) 원본이 서명 작업에 오염되지 않았다
# (계획 V7 이 G1 로 다시 확인하지만, 서명 상태는 G1 의 검사 항목이 아니다).
#
# codesign 은 **검사 도구**이지 피검사 대상이 아니므로 격리 규칙의 예외다
# (스펙 §4.0). 이 스크립트는 격리 밖에서 돈다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t8-lib.sh"

t8_require_signed || exit 1

OUT=$(t8_evidence_path "t8-hardened.txt")

# 대표 Mach-O. 실행 파일·라이브러리·Python 확장을 한 개씩 섞는다 — 서명이
# 실행 파일에만 걸렸는지 전량에 걸렸는지가 여기서 갈린다.
REPRESENTATIVE="
python/bin/python3.12
python/lib/libpython3.12.dylib
python/lib/python3.12/site-packages/torch/lib/libtorch_cpu.dylib
python/lib/python3.12/site-packages/mlx/lib/libmlx.dylib
python/lib/python3.12/site-packages/charset_normalizer/cd.cpython-312-darwin.so
ffmpeg/bin/ffmpeg
ffmpeg/bin/ffprobe
pg/bin/postgres
pg/lib/postgresql/pg_bigm.dylib
"

FAIL=0
REPORT=$(
  echo "# Task 8 V2 — hardened runtime 이 실제로 켜졌는가"
  echo "# utc: $(t8_utc)"
  echo "# 사본: $SIGNED_ROOT"
  echo "# 원본: $BUNDLE_ROOT  (서명하지 않았다 — 음성 대조)"
  echo
  echo "## 대표 Mach-O 의 CodeDirectory flags"
  printf '%-72s %-28s %s\n' "경로(사본 기준)" "사본 flags" "원본 flags"
  for rel in $REPRESENTATIVE; do
    s="$SIGNED_ROOT/$rel"
    b="$BUNDLE_ROOT/$rel"
    if [ ! -f "$s" ]; then
      printf '%-72s %s\n' "$rel" "MISSING(사본)"
      continue
    fi
    sf=$(t8_cs_flags "$s")
    bf="-"
    [ -f "$b" ] && bf=$(t8_cs_flags "$b")
    printf '%-72s %-28s %s\n' "$rel" "${sf:-none}" "${bf:-none}"
  done
)
echo "$REPORT"

echo
echo "== 판정"
for rel in $REPRESENTATIVE; do
  s="$SIGNED_ROOT/$rel"
  b="$BUNDLE_ROOT/$rel"
  if [ ! -f "$s" ]; then
    echo "  FAIL 사본에 파일이 없다: $rel"
    FAIL=1
    continue
  fi
  if t8_has_runtime "$s"; then
    echo "  OK   사본에 runtime 플래그가 있다: $rel"
  else
    echo "  FAIL 사본에 runtime 플래그가 없다: $rel  (flags=$(t8_cs_flags "$s"))"
    FAIL=1
  fi
  if [ -f "$b" ]; then
    if t8_has_runtime "$b"; then
      echo "  FAIL 원본에 runtime 플래그가 있다 — 원본이 서명 작업에 오염됐다: $rel"
      FAIL=1
    fi
  fi
done

echo
echo "== 사본 전량에 runtime 플래그가 붙었는가"
# 전수는 probe.sh sign 이 이미 재서 증거로 남겼다. 여기서는 그 증거가 있고
# 0건이라고 적혀 있는지만 확인한다 — 526개를 다시 훑으면 이 Verify 행이
# 몇 분씩 걸린다.
SIGN_EV="$EVIDENCE/t8-sign.txt"
if [ -f "$SIGN_EV" ]; then
  NORT=$(sed -n 's/^# runtime 플래그 없음 *: *\([0-9]*\)개.*/\1/p' "$SIGN_EV" | head -n 1)
  VFAIL=$(sed -n 's/^# 서명 후 --verify 실패 *: *\([0-9]*\)개.*/\1/p' "$SIGN_EV" | head -n 1)
  echo "  증거: $SIGN_EV"
  echo "  runtime 플래그 없음: ${NORT:-?}개 / --verify 실패: ${VFAIL:-?}개"
  if [ "${NORT:-1}" != "0" ]; then
    echo "  FAIL 전수 서명 증거에 runtime 플래그 없는 파일이 남아 있다"
    FAIL=1
  else
    echo "  OK   전수 서명 증거가 0건이라고 적고 있다"
  fi
else
  echo "  FAIL 전수 서명 증거가 없다: $SIGN_EV — probe.sh sign 을 먼저 돌려라"
  FAIL=1
fi

{
  echo "$REPORT"
  echo
  echo "## 판정"
  echo "실패 항목 수: $FAIL (0 이면 통과)"
} > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "사본은 hardened runtime 으로 서명됐고 원본은 서명되지 않은 그대로다"
exit 0
