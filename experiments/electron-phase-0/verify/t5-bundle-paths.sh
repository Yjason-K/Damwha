#!/bin/bash
# 계획 Task 5 V10 — 번들 것이 떴는가, 그리고 개발자 자산을 쓰지 않았는가
# (스펙 P0-C5b, §4.1, §4.4).
#
# 세 가지를 본다.
#   1. t5-llm-binpath.txt의 실행 파일이 bundle/python 하위다. 개발 절차가
#      깔아 두는 ~/.local/bin/mlx_lm.server(uv tool)가 아니다 — 스펙 §2가
#      지목한 "어떤 매니페스트에도 없는 네 번째 런타임"이 바로 그것이다.
#   2. dyld 증거의 **^dyld 줄에 한정**해 개발자 홈 자산(HF 캐시 40 GB,
#      ~/.local)과 머신 전역 설치물(/opt/homebrew, Python.framework,
#      /usr/local)이 0건이다.
#   3. 모델이 샌드박스 HF 캐시에 실제로 들어 있다.
#
# 개발자 홈 경로는 **실행 시점의 $HOME에서 만든다.** 이 저장소 자체가 그
# 아래에 있으므로 $HOME 문자열 자체로 세면 번들 경로까지 걸린다 — 그래서
# $HOME/.cache/huggingface·$HOME/.local 처럼 자산 단위로 좁혀 센다.
# (verify 스크립트는 격리 밖에서 도는 검사 도구다, 스펙 §4.0.)

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

FAIL=0
OUT=$(t5_evidence_path "t5-bundle-paths.txt")

BINPATH_FILE="$EVIDENCE/t5-llm-binpath.txt"
DEV_HF="$HOME/.cache/huggingface"
DEV_LOCAL="$HOME/.local"
SANDBOX_HF="$ISO_HF_HOME"

REPORT=""
say() { echo "$1"; REPORT="$REPORT$1
"; }

say "== 1. llm.sh start가 실행한 바이너리 (스펙 P0-C5b)"
if [ ! -f "$BINPATH_FILE" ]; then
  say "  FAIL $BINPATH_FILE 이 없다 — V6(llm.sh start)을 먼저 돌린다"
  FAIL=1
  BINPATH=""
else
  BINPATH=$(sed -n 's/^binary  *: *//p' "$BINPATH_FILE" | head -n 1)
  SHEBANG=$(sed -n 's/^shebang  *: *//p' "$BINPATH_FILE" | head -n 1)
  CMDLINE=$(sed -n 's/^cmdline  *: *//p' "$BINPATH_FILE" | head -n 1)
  say "  기록된 binary : $BINPATH"
  say "  셔뱅          : $SHEBANG"
  say "  실제 cmdline  : $CMDLINE"
  case "$BINPATH" in
    "$BUNDLE_PY_DIR"/*) say "  OK   bundle/python 하위다" ;;
    *) say "  FAIL bundle/python 하위가 아니다"; FAIL=1 ;;
  esac
  case "$BINPATH" in
    "$DEV_LOCAL"/*) say "  FAIL 개발자 홈의 uv tool 설치본이다 (~/.local)"; FAIL=1 ;;
    *) say "  OK   개발자 홈의 ~/.local 설치본이 아니다" ;;
  esac
  # 셔뱅이 번들 python이어야 dyld 실측이 산다 (Task 3의 결정, 계획 규칙 6c).
  case "$SHEBANG" in
    "#!$BUNDLE_PY_DIR"/*) say "  OK   셔뱅이 번들 python이다 — /bin/sh 심이 아니라 dyld 실측이 산다" ;;
    *) say "  FAIL 셔뱅이 번들 python이 아니다: $SHEBANG"; FAIL=1 ;;
  esac
  # 실제로 뜬 프로세스의 argv에도 그 경로가 있어야 한다 — 기록만 남기고 다른
  # 것을 띄웠을 가능성을 막는다.
  case "$CMDLINE" in
    *"$BINPATH"*) say "  OK   기동한 프로세스의 argv에 그 경로가 있다" ;;
    *) say "  FAIL 기동한 프로세스의 argv에 그 경로가 없다"; FAIL=1 ;;
  esac
fi

say ""
say "== 2. dyld 증거의 ^dyld 줄에 개발 환경 경로가 있는가 (계획 규칙 6)"
scan_dyld() {
  local file label tok hits total
  file="$1"; label="$2"
  if [ ! -f "$file" ]; then
    say "  FAIL $label: 증거 파일이 없다 ($file)"
    FAIL=1
    return
  fi
  if head -n 1 "$file" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
    say "  FAIL $label: MEASUREMENT_UNAVAILABLE — 실측이 끊겼다"
    FAIL=1
    return
  fi
  total=$(t5_dyld_lines "$file")
  say "  $label: ^dyld 줄 ${total}건"
  for tok in "$DEV_HF" "$DEV_LOCAL/" "/opt/homebrew" "/Library/Frameworks/Python.framework" "/usr/local/lib" "/usr/local/bin"; do
    hits=$(grep '^dyld' "$file" | grep -c -F "$tok")
    if [ "${hits:-0}" -eq 0 ]; then
      say "    OK   $tok: 0건"
    else
      say "    FAIL $tok: ${hits}건"
      say "$(grep '^dyld' "$file" | grep -F "$tok" | head -n 5 | sed 's/^/         /')"
      FAIL=1
    fi
  done
}
scan_dyld "$EVIDENCE/t5-embed-dyld.txt" "t5-embed"
scan_dyld "$EVIDENCE/t5-llm-dyld.txt"   "t5-llm"

say ""
say "== 3. 모델이 샌드박스 HF 캐시에 있는가 (스펙 §4.4 — 개발자 캐시에 쓰지 않는다)"
say "  샌드박스 HF_HOME : $SANDBOX_HF"
for repo in "models--mlx-community--Qwen3.5-4B-8bit" "models--BAAI--bge-m3"; do
  d="$SANDBOX_HF/hub/$repo"
  if [ -d "$d" ]; then
    sz=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
    say "  OK   $repo — $sz"
  else
    say "  FAIL $repo 가 샌드박스 캐시에 없다: $d"
    FAIL=1
  fi
done

# 개발자 캐시를 실험이 건드리지 않았는지: 실험 시작 이후에 바뀐 파일이 없어야
# 한다는 강한 단정은 다른 도구가 캐시를 쓸 수 있어 성립하지 않는다. 여기서는
# **주입값이 샌드박스를 가리킨다**는 것과 위 dyld 0건으로 판정한다.
say "  참고: 격리 래퍼가 주입한 HF_HOME은 $ISO_HF_HOME 이다 (스펙 §4.2 표)"

{
  echo "# Task 5 V10 — 번들 실행과 개발 환경 비의존 (스펙 P0-C5b, §4.1, §4.4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 개발자 홈 자산 기준: \$HOME/.cache/huggingface, \$HOME/.local"
  echo "#   (\$HOME 문자열 자체로 세지 않는다 — 이 저장소가 그 아래에 있어"
  echo "#    번들 경로까지 걸린다)"
  echo
  printf '%s' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "판정: 번들 안의 mlx_lm.server가 떴고, dyld 실측에 개발 환경 경로가 0건이다"
exit 0
