#!/bin/bash
# 계획 Task 8 V3 — 서명되고 hardened runtime 이 켜진 런타임에서 스택이 도는가.
#
# Task 3 의 V2(import 전량)와 V3(mps_available)을 **서명된 사본에서** 다시
# 돌린다. 대상만 bundle/ → signed/ 로 바뀌고 묻는 것은 같다.
#
# ## 판정 규칙 (계획 V3 기대)
#
#   전부 성공                     -> exit 0
#   실패가 있는데 그 오류와 필요한 entitlement 가 RESULTS.md 에 있다 -> exit 0
#   실패가 있는데 기록이 없다     -> exit 1
#
# 세 번째 갈래가 이 스크립트가 무조건 exit 0 이 아닌 이유다. P0-C9 는
# "성공/실패"가 아니라 "제약이 특정되었는가"로 판정하므로(스펙 P0-C9 비고),
# 깨진 것을 통과로 만들지 않으면서 **기록되지 않은 것**만 막는다.
#
# ## 실제로 붙어 있는 entitlement 와 문서의 결론이 같은가
#
# RESULTS.md 의 "최소 집합" 결론은 probe.sh 가 실측으로 적은 값이다. 그런데
# 사본에 지금 붙어 있는 entitlement 가 그것과 다르면, 아래 실행 결과는 문서가
# 말하는 조건에서 잰 것이 아니다. 그래서 실행 전에 둘을 대조한다.
#
# 판정에 쓰는 JSON 파서는 **시스템 python(/usr/bin/python3)** 이다. 검사 도구이지
# 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0). 검증 대상이 자기
# 자신을 판정하면 그 판정도 함께 깨진다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t8-lib.sh"

t8_require_signed  || exit 1
t8_require_results || exit 1

OUT=$(t8_evidence_path "t8-signed-runtime.txt")
FAIL=0

# --- 문서의 결론과 실제 서명 상태 대조 ---------------------------------------
echo "== 사본에 붙어 있는 entitlement 와 RESULTS.md 의 결론"
HAVE=$(t8_entitlement_keys "$SIGNED_PY")
CLAIM_LINE=$(grep -F '결론: 필요한 entitlement 최소 집합' "$RESULTS" | head -n 1)
CLAIM=$(printf '%s' "$CLAIM_LINE" | tr ' ,*' '\n\n\n' \
        | grep '^com\.apple\.security\.cs\.' | sort -u)

echo "  사본에 붙은 것 : ${HAVE:-(없음)}" | tr '\n' ' '; echo
echo "  RESULTS.md 결론: ${CLAIM:-(없음)}" | tr '\n' ' '; echo
if [ -z "$CLAIM_LINE" ]; then
  echo "  FAIL RESULTS.md 에 entitlement 최소 집합 결론이 없다"
  FAIL=1
elif [ "$HAVE" = "$CLAIM" ]; then
  echo "  OK   둘이 같다 — 아래 실행은 문서가 말하는 조건에서 잰 것이다"
else
  echo "  FAIL 둘이 다르다 — 실행 조건이 문서와 어긋난다"
  FAIL=1
fi

# --- 서명된 런타임에서 실행 ---------------------------------------------------
# P0-C3 본문이 이름을 든 13개 + damwha_worker + mlx + sounddevice. Task 3 V2 와
# 같은 목록이다. 여기에 mps_available() 를 더한다 (Task 3 V3).
read -r -d '' PYCODE <<'PYEOF'
import importlib, json, sys, traceback

mods = [
    "torch", "torchaudio", "mlx", "mlx_whisper", "mlx_lm",
    "pyannote.audio", "speechbrain", "silero_vad", "sentence_transformers",
    "faster_whisper", "soundfile", "sounddevice", "numpy",
    "fastapi", "uvicorn", "damwha_worker",
]
out = {"modules": [], "prefix": sys.prefix, "executable": sys.executable}
for name in mods:
    try:
        m = importlib.import_module(name)
        out["modules"].append({"name": name, "ok": True,
                               "file": getattr(m, "__file__", None)})
    except BaseException:
        out["modules"].append({
            "name": name, "ok": False,
            "error": traceback.format_exc(limit=3).strip().splitlines()[-1]})
try:
    from damwha_worker.models.device import mps_available
    out["mps_available"] = bool(mps_available())
except BaseException as exc:
    out["mps_error"] = "%s: %s" % (type(exc).__name__, exc)
json.dump(out, sys.stdout, ensure_ascii=False)
sys.stdout.write("\n")
PYEOF

echo
echo "== 격리 실행 (스펙 §4.2) — 서명된 사본의 python 을 env -i 가 직접 exec 한다"
RAW=$(bash "$RUN_ISO" --label t8-signed-runtime -- "$SIGNED_PY" -c "$PYCODE")
RC=$?
LINE=$(printf '%s\n' "$RAW" | grep -a '^{' | tail -n 1)

if [ -z "$LINE" ]; then
  echo "  FAIL 서명된 런타임이 stdout 없이 exit $RC 로 끝났다 (신호로 죽었으면 128+N)"
  echo "       dyld/stderr 증거: $EVIDENCE/t8-signed-runtime-dyld.txt, -stderr.txt"
  {
    echo "# Task 8 V3 — 서명된 런타임에서의 import / MPS"
    echo "# utc: $(t8_utc)   exit: $RC"
    echo "# stdout 이 비었다 — 프로세스가 통째로 죽었다"
  } > "$OUT"
  exit 1
fi

PARSED=$(printf '%s' "$LINE" | "$SYSPY" -c '
import json, sys
d = json.load(sys.stdin)
print("PREFIX\t%s" % d.get("prefix"))
print("EXEC\t%s" % d.get("executable"))
print("MPS\t%s" % d.get("mps_available", d.get("mps_error")))
for r in d["modules"]:
    print("MOD\t%s\t%s\t%s" % (r["name"], r["ok"], r.get("file") or r.get("error")))
')

echo
echo "== 사본이 자기 자신을 쓰는가"
PREFIX=$(printf '%s\n' "$PARSED" | awk -F'\t' '$1=="PREFIX"{print $2}')
case "$PREFIX" in
  "$SIGNED_PY_DIR") echo "  OK   sys.prefix = $PREFIX" ;;
  *) echo "  FAIL sys.prefix 가 사본 밖이다: ${PREFIX:-없음}"; FAIL=1 ;;
esac

echo
echo "== 모듈별 결과"
BROKEN=""
while IFS=$'\t' read -r tag name ok detail; do
  [ "$tag" = "MOD" ] || continue
  if [ "$ok" = "True" ]; then
    case "$detail" in
      "$SIGNED_ROOT"/*|None)
        echo "  OK   $name  ${detail#$SIGNED_ROOT/}" ;;
      *)
        echo "  FAIL $name 이 사본 밖에서 왔다: $detail"
        BROKEN="$BROKEN $name" ;;
    esac
  else
    echo "  FAIL $name import 실패: $detail"
    BROKEN="$BROKEN $name"
  fi
done <<EOT
$PARSED
EOT

MPS=$(printf '%s\n' "$PARSED" | awk -F'\t' '$1=="MPS"{print $2}')
echo
if [ "$MPS" = "True" ]; then
  echo "  OK   mps_available() = True  (제품 코드 damwha_worker.models.device 그대로)"
else
  echo "  FAIL mps_available() 가 True 가 아니다: ${MPS:-없음}"
  BROKEN="$BROKEN mps_available"
fi

echo
echo "== dyld 실측 상태 (참고 — 판정에 쓰지 않는다)"
DY="$EVIDENCE/t8-signed-runtime-dyld.txt"
if [ -f "$DY" ] && head -n 1 "$DY" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
  echo "  MEASUREMENT_UNAVAILABLE — hardened runtime 이 DYLD_* 를 지운다."
  echo "  이 Task 의 관찰 대상이며 RESULTS.md 에 사실로 적혀 있다. G2 의 dyld"
  echo "  증거는 서명 전 번들에서만 얻을 수 있다는 뜻이라, 여기서 통과 조건으로"
  echo "  삼지 않는다 (Task 3 의 t3_assert_dyld_measured 와 다른 점이다)."
else
  echo "  dyld 줄: $(grep -c '^dyld' "$DY" 2>/dev/null || echo 0)건"
fi

# --- 깨진 것이 있으면 기록됐는지 본다 ----------------------------------------
DOC_OK=1
if [ -n "$BROKEN" ]; then
  echo
  echo "== 깨진 항목이 RESULTS.md 에 기록됐는가 (계획 V3 두 번째 갈래)"
  for name in $BROKEN; do
    if [ "$(t8_count_literal "$RESULTS" "$name")" -gt 0 ]; then
      echo "  OK   '$name' 이 RESULTS.md 에 있다"
    else
      echo "  FAIL '$name' 이 RESULTS.md 에 없다 — 깨진 것이 기록되지 않았다"
      DOC_OK=0
    fi
  done
  if [ -z "$CLAIM_LINE" ]; then
    echo "  FAIL entitlement 결론이 RESULTS.md 에 없다"
    DOC_OK=0
  else
    echo "  OK   entitlement 결론이 있다: $CLAIM_LINE"
  fi
  [ "$DOC_OK" -eq 1 ] || FAIL=1
fi

{
  echo "# Task 8 V3 — 서명된 런타임(ad-hoc + hardened runtime)에서의 import / MPS"
  echo "# utc: $(t8_utc)"
  echo "# 대상: $SIGNED_PY"
  echo "# 실행: lib/run-isolated.sh --label t8-signed-runtime"
  echo "# exit: $RC"
  echo "# 사본에 붙은 entitlement: $(printf '%s' "$HAVE" | tr '\n' ' ')"
  echo "# RESULTS.md 결론      : $(printf '%s' "$CLAIM" | tr '\n' ' ')"
  echo "# 깨진 항목            : ${BROKEN:-없음}"
  echo
  printf '%s\n' "$PARSED"
  echo
  echo "# 원본 JSON"
  printf '%s\n' "$LINE"
} > "$OUT"

echo
echo "증거: $OUT"
if [ -n "$BROKEN" ] && [ "$DOC_OK" -eq 1 ] && [ "$FAIL" -eq 0 ]; then
  echo "깨진 항목이 있으나 오류와 필요한 entitlement 가 RESULTS.md 에 기록돼 있다"
  exit 0
fi
[ "$FAIL" -eq 0 ] || exit 1
echo "서명되고 hardened runtime 이 켜진 사본에서 스택 전량이 import 되고 MPS 가 잡힌다"
exit 0
