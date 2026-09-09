#!/bin/bash
# 계획 Task 3 V4 — 런타임 자기 보고 (P0-C8의 Python 절반).
#
# 스펙 §4.3은 계정 분리를 버리는 대신 이 검증을 채택했다. `PATH`가 막아 줬는지가
# 아니라 **런타임이 스스로 자기 위치를 어디로 알고 있는지**를 본다. 특히
# `/Library/Frameworks/Python.framework`는 이 머신에 실제로 설치돼 있고 dyld가
# `PATH` 없이 찾으므로, 계정을 바꿔도 사라지지 않는다 — 그 위험을 담당하는
# 기준이 P0-C8이다.
#
# `python/selfreport.py`가 덤프만 하고 판정은 여기서 한다. 덤프와 판정이 같은
# 코드면 빠뜨린 필드는 영원히 보이지 않는다.
#
# 판정: 덤프에 나오는 **모든 절대 경로**가 다음 중 하나여야 한다.
#   - 번들: $EXP/bundle/ 하위
#   - 샌드박스: $EXP/sandbox/ 하위 (격리 실행의 HOME·TMPDIR·STORAGE_ROOT,
#     그리고 이 스크립트가 복사해 둔 드라이버 — 아래 참조)
#   - 시스템: /usr/lib /System/Library /usr/bin /bin /usr/sbin /sbin /dev /private/var
# 그리고 금지 문자열(스펙 §4.1)이 0건이어야 한다.
#
# 경로처럼 생기지 않은 값(버전 문자열, JSON 키)은 대상이 아니다. 그래서
# "슬래시로 시작하는 토큰"만 뽑아 본다.

# 판정에 쓰는 JSON 파서는 **시스템 python(/usr/bin/python3, 3.9)** 이다.
# 검사 도구이지 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0).
# `python3` 로 부르면 개발자 PATH의 Homebrew python이 잡혀 회차마다 달라지므로
# 절대 경로로 고정한다. 판정을 번들 python으로 하지 않는 이유는 따로 있다 —
# 검증 대상이 자기 자신을 판정하면 그 판정도 함께 깨진다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t3-lib.sh"

t3_require_bundle || exit 1

SRC_SELFREPORT="$PY_DIR/selfreport.py"
[ -f "$SRC_SELFREPORT" ] || { echo "FAIL: $SRC_SELFREPORT 이 없다"; exit 1; }

# 스크립트를 **샌드박스로 복사해서** 부른다. Python은 실행한 스크립트의
# 디렉터리를 sys.path[0]에 넣으므로, $EXP/python 에서 그대로 부르면 자기 보고에
# 번들도 샌드박스도 아닌 경로가 한 건 섞인다. 판정을 느슨하게 해서 그 한 건을
# 봐 주는 대신, 드라이버를 격리 안(샌드박스)에 두어 애초에 생기지 않게 한다.
# Task 7의 파이프라인 드라이버도 같은 이유로 샌드박스에서 돌려야 한다.
exp_ensure_sandbox
mkdir -p "$SANDBOX/driver"
SELFREPORT="$SANDBOX/driver/selfreport.py"
cp "$SRC_SELFREPORT" "$SELFREPORT"

OUT=$(t3_evidence_path "t3-selfreport.txt")
JSON_OUT=$(t3_evidence_path "t3-selfreport-json.txt")

echo "== 격리 실행 — 번들 python이 자기 경로를 보고한다"
RAW=$(t3_run t3-selfreport "$SELFREPORT")
RC=$?

{
  echo "# Task 3 V4 / P0-C8 — 번들 Python 런타임 자기 보고 (재배치 후)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 실행: run-isolated.sh --label t3-selfreport -- $BUNDLE_PY $SELFREPORT"
  echo "# exit: $RC"
  echo
  printf '%s\n' "$RAW"
} > "$JSON_OUT"

if [ $RC -ne 0 ] || [ -z "$RAW" ]; then
  echo "  FAIL 격리 실행이 exit $RC 로 끝났다. 증거: $JSON_OUT"
  exit 1
fi

FAIL=0
SANDBOX_ABS=$(cd "$SANDBOX" && pwd -P)
BUNDLE_ABS=$(cd "$EXP_ROOT/bundle" && pwd -P)

# 덤프에서 절대 경로 토큰을 전부 뽑는다. JSON 문자열 안이라 따옴표로 잘린다.
# PATH 처럼 콜론으로 이어 붙인 값이 한 토큰으로 잡히므로 콜론에서 한 번 더
# 쪼갠다. 안 그러면 "/usr/bin:/bin:/usr/sbin:/sbin" 이 통째로 미분류가 된다.
PATHS=$(printf '%s\n' "$RAW" \
        | LC_ALL=C grep -a -o -E '"/[^"]*"' \
        | sed -e 's/^"//' -e 's/"$//' \
        | tr ':' '\n' \
        | grep '^/' \
        | sort -u)
PATH_N=$(printf '%s\n' "$PATHS" | grep -c '^/')

{
  echo "# Task 3 V4 판정 — 자기 보고 경로 분류"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 원본 덤프: $JSON_OUT"
  echo
  echo "## 뽑아낸 절대 경로 토큰: ${PATH_N}개"
} > "$OUT"

echo
echo "== 절대 경로 분류 (${PATH_N}개)"
BAD=0
while IFS= read -r p; do
  case "$p" in
    "") continue ;;
    "$BUNDLE_ABS"/*|"$SANDBOX_ABS"/*) continue ;;
    /usr/lib/*|/System/Library/*|/usr/bin|/usr/bin/*|/bin|/bin/*|/usr/sbin|/usr/sbin/*|/sbin|/sbin/*) continue ;;
    /usr/lib|/System/Library|/dev/*|/private/var/*) continue ;;
    *)
      echo "  FAIL 번들·샌드박스 밖 경로: $p"
      echo "번들·샌드박스 밖: $p" >> "$OUT"
      BAD=$((BAD + 1)) ;;
  esac
done <<EOT
$PATHS
EOT
if [ "$BAD" -eq 0 ]; then
  echo "  OK   전부 bundle/ · sandbox/ · 시스템 경로 하위다"
else
  FAIL=1
fi

echo
echo "== 금지 문자열 (스펙 §4.1) — 자기 보고 덤프 전체"
for s in "/Library/Frameworks/Python.framework" "/opt/homebrew" "/usr/local/bin" "/usr/local/lib" "/usr/local/Cellar" "/usr/local/opt" ".venv" "/Library/Developer/CommandLineTools"; do
  n=$(printf '%s\n' "$RAW" | LC_ALL=C grep -a -c -F "$s")
  if [ "$n" -eq 0 ]; then
    echo "  OK   0건  $s"
  else
    echo "  FAIL ${n}건 $s"
    printf '%s\n' "$RAW" | LC_ALL=C grep -a -n -F "$s" | head -5 | sed 's/^/       /'
    echo "금지 문자열 ${n}건: $s" >> "$OUT"
    FAIL=1
  fi
done

echo
echo "== 핵심 필드"
field() {
  printf '%s\n' "$RAW" | /usr/bin/python3 -c "
import json, sys
d = json.load(sys.stdin)
cur = d
for k in '$1'.split('.'):
    cur = cur[k]
print(cur)
" 2>/dev/null
}
for f in sys.executable sys.prefix sys.base_prefix; do
  v=$(field "$f")
  case "$v" in
    "$BUNDLE_ABS"/*) echo "  OK   $f = $v" ;;
    *) echo "  FAIL $f = ${v:-없음} (번들 밖)"; FAIL=1 ;;
  esac
  echo "$f = $v" >> "$OUT"
done

# 개발 venv를 끌어오지 않았음을 런타임 자신의 값으로 확인한다.
for f in env.VIRTUAL_ENV env.PYTHONPATH env.PYTHONHOME; do
  v=$(field "$f")
  if [ "$v" = "None" ] || [ -z "$v" ]; then
    echo "  OK   $f 없음"
  else
    echo "  FAIL $f = $v"
    FAIL=1
  fi
done

echo
echo "== 이 프로세스가 실제로 연 Mach-O 이미지 (런타임 자신의 보고)"
IMG_TOTAL=$(printf '%s\n' "$RAW" | /usr/bin/python3 -c "
import json,sys
print(len(json.load(sys.stdin)['loaded_images']))" 2>/dev/null)
IMG_OUT=$(printf '%s\n' "$RAW" | /usr/bin/python3 -c "
import json,sys
imgs = json.load(sys.stdin)['loaded_images']
bad = [i for i in imgs if not (i.startswith('$BUNDLE_ABS/') or i.startswith('$SANDBOX_ABS/')
       or i.startswith('/usr/lib/') or i.startswith('/System/Library/'))]
print(len(bad))
for b in bad[:20]:
    print('   ', b)" 2>/dev/null)
IMG_BAD=$(printf '%s\n' "$IMG_OUT" | head -n 1)
echo "  로드된 이미지: ${IMG_TOTAL:-?}개, 허용 밖: ${IMG_BAD:-?}개"
{ echo; echo "## 로드된 이미지 ${IMG_TOTAL:-?}개 중 허용 밖 ${IMG_BAD:-?}개"; printf '%s\n' "$IMG_OUT" | tail -n +2; } >> "$OUT"
if [ "${IMG_BAD:-1}" != "0" ]; then
  printf '%s\n' "$IMG_OUT" | tail -n +2 | head -20
  FAIL=1
fi

echo
echo "== dyld 실측이 진짜인가 (계획 규칙 6b)"
t3_assert_dyld_measured "$EVIDENCE/t3-selfreport-dyld.txt" || FAIL=1

echo
echo "증거: $OUT , $JSON_OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "런타임이 보고하는 경로가 전부 번들·샌드박스·시스템 안이다"
exit 0
