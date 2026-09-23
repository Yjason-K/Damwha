#!/bin/bash
# desktop/scripts/probe-numba.sh
#
# numba의 LLVM MCJIT이 hardened runtime에서 사는지, 죽는다면 import·정의·호출 중 어디서
# 죽는지 가른다 (Electron Phase 4 스펙 §6.8). 쓰기+실행 매핑 거부는 **메시지 없이 SIGKILL**이고
# 크래시 리포트도 안 남는다 (Phase 0 R-4) — 부모가 자식의 종료 신호를 읽는 것이 유일한 관측이다.
#
#   bash desktop/scripts/probe-numba.sh <python트리> <entitlements.plist>

set -uo pipefail   # -e 없음: 자식이 죽는 것이 관측 대상이다

PY_TREE="${1:?usage: probe-numba.sh <python-tree> <entitlements.plist>}"
ENTS="${2:?usage: probe-numba.sh <python-tree> <entitlements.plist>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PY="$PY_TREE/bin/python3.12"
[ -x "$PY" ] || { echo "python이 없다: $PY" >&2; exit 2; }

echo "== hardened runtime + entitlements로 서명한다: $ENTS"
# 하나라도 빠지면 dlv가 그것을 거부해 numba와 무관한 이유로 죽고, 그 죽음이 JIT 판정으로
# 오독된다. **파이프 뒤 while이 아니라 프로세스 치환이다** — `find | while … exit`의 exit는
# 파이프 서브셸만 끝내고 스크립트는 계속 진행한다.
signed=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  codesign --force --sign - --options runtime --entitlements "$ENTS" "$f" 2>/dev/null \
    || { echo "서명 실패: $f" >&2; exit 3; }
  signed=$((signed + 1))
done < <(find "$PY_TREE" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
echo "== Mach-O ${signed}개를 서명했다"
[ "$signed" -gt 0 ] || { echo "Mach-O를 하나도 못 찾았다 — 트리가 틀렸다" >&2; exit 3; }

run_probe() {
  local name="$1" out rc
  out=$("$PY" "$HERE/numba-probe/$name.py" 2>&1); rc=$?
  # 128+9 = 137이 SIGKILL이다.
  if [ "$rc" -eq 137 ]; then echo "$name: SIGKILL (rc=137)"; return 9
  elif [ "$rc" -ne 0 ]; then echo "$name: 실패 rc=$rc"; echo "$out" | tail -5; return 1
  fi
  echo "$name: OK — $(echo "$out" | tail -1)"; return 0
}

VERDICT="survives"
for probe in import_only define_only call_it; do
  run_probe "$probe" || { VERDICT="$probe"; break; }
done
echo
echo "== 판정: $VERDICT"
