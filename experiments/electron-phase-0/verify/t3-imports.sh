#!/bin/bash
# 계획 Task 3 V2 — 재배치한 번들 런타임에서 스택 전량이 import 되는가.
#
# 스펙 P0-C3의 성공 판정은 "**이동 후에** 모든 import가 성공"이다. 이동 전에
# 되는 것은 아무것도 증명하지 않으므로 이 스크립트는 $EXP/bundle/python 만
# 본다 — 스테이징 경로를 대상으로 돌 방법이 없다.
#
# 두 가지를 함께 본다.
#   1. 모듈 import 성공 여부 (P0-C3이 이름을 든 것 전량 + mlx + sounddevice)
#   2. **어디서 왔는가.** damwha_worker가 개발 venv에서 끌려온 것이 아니라
#      번들 안에 설치된 것인지 __file__로 확인한다 (계획 Task 3 Review).
#      PYTHONPATH는 env -i가 지우지만, 지워졌다는 것과 번들 안에 실제로
#      설치돼 있다는 것은 다른 사실이다.
#
# import 하나가 실패해도 나머지를 계속 시도한다. "무엇이 깨졌는가"가 이
# Task의 관찰 대상이라, 첫 실패에서 멈추면 재배치가 무엇을 깼는지 한 번에
# 볼 수 없다.

# 판정에 쓰는 JSON 파서는 **시스템 python(/usr/bin/python3, 3.9)** 이다.
# 검사 도구이지 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0).
# `python3` 로 부르면 개발자 PATH의 Homebrew python이 잡혀 회차마다 달라지므로
# 절대 경로로 고정한다. 판정을 번들 python으로 하지 않는 이유는 따로 있다 —
# 검증 대상이 자기 자신을 판정하면 그 판정도 함께 깨진다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t3-lib.sh"

t3_require_bundle || exit 1

OUT=$(t3_evidence_path "t3-imports.txt")

# P0-C3 본문이 이름을 든 13개 + damwha_worker. 여기에 P0-C8이 이름을 든 mlx와
# U-4 결론에 따라 번들에 넣은 sounddevice를 더한다.
read -r -d '' PYCODE <<'PYEOF'
import importlib, json, sys, traceback
mods = [
    "torch", "torchaudio", "mlx", "mlx_whisper", "mlx_lm",
    "pyannote.audio", "speechbrain", "silero_vad", "sentence_transformers",
    "faster_whisper", "soundfile", "sounddevice", "numpy",
    "fastapi", "uvicorn", "damwha_worker",
]
rows = []
for name in mods:
    try:
        m = importlib.import_module(name)
        rows.append({"name": name, "ok": True,
                     "file": getattr(m, "__file__", None)})
    except Exception:
        rows.append({"name": name, "ok": False,
                     "error": traceback.format_exc(limit=3).strip().splitlines()[-1]})
json.dump(rows, sys.stdout, ensure_ascii=False)
sys.stdout.write("\n")
PYEOF

echo "== 격리 실행 (스펙 §4.2) — 번들 python이 env -i에 직접 exec된다"
RAW=$(t3_run t3-imports -c "$PYCODE")
RC=$?

{
  echo "# Task 3 V2 — 번들 런타임 import (재배치 후)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 실행: run-isolated.sh --label t3-imports -- $BUNDLE_PY -c <모듈 import>"
  echo "# exit: $RC"
  echo
  echo "$RAW"
} > "$OUT"

if [ $RC -ne 0 ] || [ -z "$RAW" ]; then
  echo "  FAIL 격리 실행이 exit $RC 로 끝났다. 증거: $OUT"
  exit 1
fi

FAIL=0

echo
echo "== 모듈별 결과"
# 판정은 번들 python이 아니라 이 셸에서 한다 — 검증 대상이 자기 자신을
# 판정하면 그 판정도 함께 깨진다.
while IFS='|' read -r name ok file; do
  [ -n "$name" ] || continue
  if [ "$ok" = "True" ]; then
    case "$file" in
      "$BUNDLE_PY_DIR"/*|None)
        echo "  OK   $name  ${file#$BUNDLE_PY_DIR/}" ;;
      *)
        echo "  FAIL $name 이 번들 밖에서 왔다: $file"
        FAIL=1 ;;
    esac
  else
    echo "  FAIL $name import 실패: $file"
    FAIL=1
  fi
done <<EOT
$(printf '%s' "$RAW" | tail -n 1 | /usr/bin/python3 -c '
import json, sys
for r in json.load(sys.stdin):
    print("%s|%s|%s" % (r["name"], r["ok"], r.get("file") or r.get("error")))
')
EOT

echo
echo "== damwha_worker의 출처 (계획 Review: 설치인가 PYTHONPATH인가)"
WFILE=$(printf '%s' "$RAW" | tail -n 1 | /usr/bin/python3 -c '
import json, sys
for r in json.load(sys.stdin):
    if r["name"] == "damwha_worker":
        print(r.get("file") or "")
')
case "$WFILE" in
  "$BUNDLE_PY_DIR"/lib/python3.12/site-packages/damwha_worker/*)
    echo "  OK   번들 site-packages에 설치돼 있다: ${WFILE#$BUNDLE_PY_DIR/}" ;;
  *)
    echo "  FAIL damwha_worker가 번들 site-packages 밖이다: ${WFILE:-없음}"
    FAIL=1 ;;
esac

echo
echo "== dyld 실측이 진짜인가 (계획 규칙 6b)"
t3_assert_dyld_measured "$EVIDENCE/t3-imports-dyld.txt" || FAIL=1

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "모든 모듈이 번들 안에서 import 됐다"
exit 0
