# Task 8 verify 스크립트가 공유하는 헬퍼.
#
# t2-lib.sh / t3-lib.sh / t5-lib.sh / t7-lib.sh 와 같은 이유로 한 군데 모았다 —
# 세 스크립트가 같은 것(사본 경로, codesign 플래그 판독, RESULTS.md 읽기,
# 증거 회전)을 필요로 하는데 각자 복사해 두면 한 곳만 느슨해져도 나머지가
# 멀쩡해 보인다.
#
# 여기에는 판정이 없다. 판정은 각 t8-*.sh 가 자기 조건으로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
BUNDLE_ROOT="$EXP_ROOT/bundle"
SIGNED_ROOT="$EXP_ROOT/signed"
SIGNED_PY_DIR="$SIGNED_ROOT/python"
SIGNED_PY="$SIGNED_PY_DIR/bin/python3.12"
SIGN_DIR="$EXP_ROOT/signing"
RESULTS="$SIGN_DIR/RESULTS.md"
INVENTORY="$SIGN_DIR/unsigned-inventory.txt"

# 검사 도구다 — 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0).
CODESIGN=/usr/bin/codesign
SYSPY=/usr/bin/python3

t8_require_signed() {
  [ -x "$SIGNED_PY" ] || {
    echo "FAIL: 서명된 사본이 없다: $SIGNED_PY"
    echo "      experiments/electron-phase-0/signing/probe.sh sign 을 먼저 돌려라"
    return 1
  }
  return 0
}

t8_require_results() {
  [ -f "$RESULTS" ] || {
    echo "FAIL: RESULTS.md 가 없다: $RESULTS"
    return 1
  }
  return 0
}

# <파일> — codesign --display 의 CodeDirectory flags 값. 없으면 빈 문자열.
#   예: 0x10002(adhoc,runtime)
t8_cs_flags() {
  "$CODESIGN" --display --verbose=2 "$1" 2>&1 \
    | sed -n 's/.*flags=\([^ ]*\).*/\1/p' | head -n 1
}

# <파일> — hardened runtime 플래그가 켜졌는가.
t8_has_runtime() {
  case "$(t8_cs_flags "$1")" in
    *runtime*) return 0 ;;
    *)         return 1 ;;
  esac
}

# <파일> — 붙어 있는 com.apple.security.cs.* entitlement 이름을 한 줄씩.
t8_entitlement_keys() {
  "$CODESIGN" --display --entitlements - --xml "$1" 2>/dev/null \
    | tr '<>' '\n\n' \
    | grep '^com\.apple\.security\.cs\.' \
    | sort -u
}

# 증거를 덮어쓰지 않는다 (스펙 §6). 회전 파일명이 1초 단위라 같은 초에 두 번
# 돌리면 앞의 것이 덮인다 — 충돌하면 -2, -3 을 붙인다.
t8_evidence_path() {
  local name f base ts cand n
  name="$1"
  f="$EVIDENCE/$name"
  mkdir -p "$EVIDENCE"
  if [ -f "$f" ]; then
    base="${f%.txt}"
    ts=$(date -u '+%Y%m%dT%H%M%SZ')
    cand="$base.prev-$ts.txt"
    n=2
    while [ -e "$cand" ]; do
      cand="$base.prev-$ts-$n.txt"
      n=$((n + 1))
    done
    mv "$f" "$cand"
  fi
  echo "$f"
}

t8_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# <파일> <고정 문자열> — 몇 줄에 나오는가.
#
# **`grep -c` 의 종료 코드에 기대지 않는다.** grep 은 매치가 0건이면 `0` 을
# 출력하면서 exit 1 을 낸다 (t7-lib.sh 가 같은 함정을 적어 두었다).
t8_count_literal() {
  local n
  n=$(grep -c -F -- "$2" "$1" 2>/dev/null || true)
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  echo "$n"
}
