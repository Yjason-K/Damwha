#!/bin/bash
# 계획 Task 1 V3 — 격리 안에서 개발 도구가 실제로 안 보이는가.
#
# PATH가 막는 것은 "이름으로 찾는 실행 파일"뿐이다 (스펙 §4.2). 그래서 여기서
# 확인하는 것도 딱 그것이다 — Homebrew의 ffmpeg 9.0.1, uv, nvm의 node가
# 이름으로 잡히지 않는다는 것. 절대 경로로 박힌 dylib 참조와 dyld의 기본
# 프레임워크 검색은 G1 정적 검사와 dyld 실측이 따로 담당한다.
#
# python3은 없어지지 않는다. /usr/bin/python3은 OS가 주는 것이라 최소 PATH에도
# 남는다. 확인할 것은 그것이 **개발자의 Python이 아니라는 것**이다 —
# /usr/local/bin이 링크하는 /Library/Frameworks/Python.framework(3.9·3.11)도,
# 워커의 개발 가상환경도 아니어야 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

FAIL=0
echo "t1-no-dev-tools.sh — 격리 안의 도구 가시성 (스펙 §4.2)"

PROBE='
for t in ffmpeg ffprobe uv node npm pnpm psql pg_ctl initdb mlx_lm.server; do
  p=$(command -v "$t" 2>/dev/null) || p="(not found)"
  echo "TOOL $t $p"
done
p=$(command -v python3 2>/dev/null) || p="(not found)"
echo "TOOL python3 $p"
if [ "$p" != "(not found)" ]; then
  echo "PYPREFIX $(python3 -c "import sys; print(sys.prefix)" 2>/dev/null)"
  echo "PYEXE $(python3 -c "import sys; print(sys.executable)" 2>/dev/null)"
fi
'

OUT=$(bash "$EXP_LIB_DIR/run-isolated.sh" --label t1-nodev -- /bin/sh -c "$PROBE") || {
  echo "FAIL: 격리 실행이 실패했다"; exit 1; }

echo
printf '%s\n' "$OUT" | sed 's/^/  /'
echo

# --- 보이면 안 되는 것 --------------------------------------------------------
for t in ffmpeg ffprobe uv node npm pnpm; do
  line=$(printf '%s\n' "$OUT" | grep "^TOOL $t " || true)
  path=$(printf '%s\n' "$line" | sed 's/^TOOL [^ ]* //')
  if [ "$path" = "(not found)" ]; then
    echo "OK  $t: 격리 안에서 찾을 수 없다"
  else
    echo "FAIL $t 가 격리 안에서 보인다: $path"
    FAIL=1
  fi
done

# mlx_lm.server는 현재 개발자 홈의 uv tool에만 있다 (스펙 §2). 격리에서 보이면
# Task 5의 "번들 안 실행 파일이 떴다"가 무의미해진다.
line=$(printf '%s\n' "$OUT" | grep '^TOOL mlx_lm.server ' || true)
path=$(printf '%s\n' "$line" | sed 's/^TOOL [^ ]* //')
if [ "$path" = "(not found)" ]; then
  echo "OK  mlx_lm.server: 격리 안에서 찾을 수 없다 (uv tool 설치본이 배제됐다)"
else
  echo "FAIL mlx_lm.server 가 격리 안에서 보인다: $path"
  FAIL=1
fi

# --- python3는 남지만 개발자 것이 아니어야 한다 -------------------------------
PYEXE=$(printf '%s\n' "$OUT" | grep '^TOOL python3 ' | sed 's/^TOOL [^ ]* //')
if [ "$PYEXE" = "/usr/bin/python3" ]; then
  echo "OK  python3: /usr/bin/python3 (OS 제공)"
else
  echo "FAIL python3가 /usr/bin/python3가 아니다: $PYEXE"
  FAIL=1
fi

PYPREFIX=$(printf '%s\n' "$OUT" | grep '^PYPREFIX ' | sed 's/^PYPREFIX //')
if [ -z "$PYPREFIX" ]; then
  echo "FAIL sys.prefix를 얻지 못했다"
  FAIL=1
else
  echo "정보 sys.prefix = $PYPREFIX"
  case "$PYPREFIX" in
    */Library/Frameworks/Python.framework*)
      echo "FAIL sys.prefix가 머신 전역 Python.framework다"
      FAIL=1 ;;
    */.venv*)
      echo "FAIL sys.prefix가 개발 가상환경이다"
      FAIL=1 ;;
    *)
      echo "OK  sys.prefix가 머신 전역 Python.framework도 개발 가상환경도 아니다"
      echo "정보 이 python3은 Command Line Tools가 주는 OS 기본 인터프리터다."
      echo "     번들 구성요소가 아니라 격리를 재는 **측정 수단**이므로 G1 금지"
      echo "     문자열 규칙의 대상이 아니다 (스펙 §4.0 검사 도구 행)." ;;
  esac
fi

exit $FAIL
