#!/bin/bash
# 계획 Task 3 V3 — 번들 런타임에서 MPS(Metal)가 실제로 잡히는가.
#
# **제품 코드의 함수를 그대로 부른다.** `damwha_worker.models.device.mps_available()`
# 은 워커가 GPU 프리셋을 열어 줄지 판단하는 바로 그 술어이고(그 파일의
# 독스트링이 "capabilities 보고와 torch_device가 같은 판정을 쓰게 하는 술어"라고
# 적었다), 여기서 따로 `torch.backends.mps.is_available()`을 다시 구현해 재면
# **번들에서 워커가 실제로 GPU를 쓸 수 있는가**가 아니라 torch가 뭐라 하는지만
# 보게 된다. 계획 Task 3 Review의 "V3이 실제 함수를 부른다"가 그 뜻이다.
#
# 대조를 위해 torch 쪽 원시 값도 함께 찍지만 판정은 mps_available()로 한다.
#
# 스펙 §3.2: 제품 코드를 실행하고 읽는 것은 허용된다. 고치지 않는다.

# 판정에 쓰는 JSON 파서는 **시스템 python(/usr/bin/python3, 3.9)** 이다.
# 검사 도구이지 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0).
# `python3` 로 부르면 개발자 PATH의 Homebrew python이 잡혀 회차마다 달라지므로
# 절대 경로로 고정한다. 판정을 번들 python으로 하지 않는 이유는 따로 있다 —
# 검증 대상이 자기 자신을 판정하면 그 판정도 함께 깨진다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t3-lib.sh"

t3_require_bundle || exit 1

OUT=$(t3_evidence_path "t3-mps.txt")

read -r -d '' PYCODE <<'PYEOF'
import json, sys
out = {}
try:
    from damwha_worker.models.device import mps_available
    out["mps_available"] = bool(mps_available())
    out["source"] = mps_available.__module__
except Exception as exc:
    out["error"] = "%s: %s" % (type(exc).__name__, exc)
try:
    import torch
    out["torch_version"] = torch.__version__
    out["torch_backends_mps_is_available"] = bool(torch.backends.mps.is_available())
    out["torch_backends_mps_is_built"] = bool(torch.backends.mps.is_built())
    out["torch_file"] = torch.__file__
except Exception as exc:
    out["torch_error"] = "%s: %s" % (type(exc).__name__, exc)
json.dump(out, sys.stdout, ensure_ascii=False)
sys.stdout.write("\n")
PYEOF

echo "== 격리 실행 — damwha_worker.models.device.mps_available()"
RAW=$(t3_run t3-mps -c "$PYCODE")
RC=$?

{
  echo "# Task 3 V3 — 번들 런타임의 MPS 가용성 (재배치 후)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 부른 함수: damwha_worker.models.device.mps_available()  (제품 코드 그대로)"
  echo "# exit: $RC"
  echo
  echo "$RAW"
} > "$OUT"

if [ $RC -ne 0 ] || [ -z "$RAW" ]; then
  echo "  FAIL 격리 실행이 exit $RC 로 끝났다. 증거: $OUT"
  exit 1
fi

FAIL=0
LINE=$(printf '%s' "$RAW" | tail -n 1)
echo "  $LINE"

get() { printf '%s' "$LINE" | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))"; }

MPS=$(get mps_available)
SRC=$(get source)
TFILE=$(get torch_file)

echo
if [ "$MPS" = "True" ]; then
  echo "  OK   mps_available() = True  (모듈: ${SRC:-?})"
else
  echo "  FAIL mps_available() 가 True가 아니다: '${MPS:-없음}'  err=$(get error)"
  FAIL=1
fi

case "$TFILE" in
  "$BUNDLE_PY_DIR"/*) echo "  OK   torch가 번들 안이다: ${TFILE#$BUNDLE_PY_DIR/}" ;;
  *) echo "  FAIL torch가 번들 밖이다: ${TFILE:-없음}"; FAIL=1 ;;
esac

echo
echo "== dyld 실측이 진짜인가 (계획 규칙 6b)"
t3_assert_dyld_measured "$EVIDENCE/t3-mps-dyld.txt" || FAIL=1

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "번들 런타임에서 MPS가 잡힌다"
exit 0
