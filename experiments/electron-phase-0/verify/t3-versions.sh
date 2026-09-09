#!/bin/bash
# 계획 Task 3 V5 — 설치된 버전이 be/worker/pyproject.toml의 models extra 고정
# 버전과 **전부** 일치하는가.
#
# 기대값을 이 스크립트에 다시 적지 않는다. pyproject.toml의 `[project.optional-
# dependencies] models` 블록을 그 자리에서 읽어 대조한다 — 여기에 목록을
# 베껴 두면 pyproject.toml이 올라갈 때 둘이 갈라지고, 그러면 "일치한다"는
# 판정이 아무것도 보증하지 않게 된다. 그 파일의 주석이 `==` 고정을 둔 이유로
# 정확히 그 사고(torchaudio 2.9의 디코더 위임)를 든다.
#
# 기본 의존성(httpx·pydantic·pydantic-settings·psycopg)도 같은 방식으로 본다.
# damwha_worker는 그것들 없이 뜨지 않는다.
#
# mlx-lm은 pyproject.toml에 **없다.** 스펙 §2가 지목한 "어떤 매니페스트에도
# 선언되지 않은 네 번째 런타임"이라, 대조 기준이 저장소에 없다. 그래서 설치
# 여부와 실제 버전을 기록만 하고, 번들 안에 있는지(= uv tool 분리가 아닌지)를
# 본다.
#
# 버전은 **번들 런타임 자신의 importlib.metadata**로 읽는다. dist-info를 셸이
# 훑으면 "설치돼 있다"가 아니라 "디렉터리 이름이 그렇다"를 보는 것이 된다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t3-lib.sh"

t3_require_bundle || exit 1
[ -f "$WORKER_PYPROJECT" ] || { echo "FAIL: $WORKER_PYPROJECT 이 없다"; exit 1; }

OUT=$(t3_evidence_path "t3-versions.txt")

# --- 기대값: pyproject.toml에서 뽑는다 --------------------------------------
# models extra와 기본 dependencies의 `name==version` 줄만 취한다. 환경 마커
# (`; sys_platform == 'darwin' ...`)는 잘라 낸다 — mlx-whisper가 그 형태다.
EXPECTED=$(awk '
  /^dependencies = \[/            { in_base = 1; next }
  /^models = \[/                  { in_models = 1; next }
  (in_base || in_models) && /^\]/ { in_base = 0; in_models = 0; next }
  (in_base || in_models) {
    line = $0
    sub(/^[[:space:]]*"/, "", line)
    sub(/".*$/, "", line)
    sub(/[[:space:]]*;.*$/, "", line)        # 환경 마커 제거
    sub(/\[[^]]*\]/, "", line)               # extras 제거: psycopg[binary] -> psycopg
    if (line ~ /==/) print line
  }
' "$WORKER_PYPROJECT")

EXPECTED_N=$(printf '%s\n' "$EXPECTED" | grep -c '==')
if [ "$EXPECTED_N" -lt 15 ]; then
  echo "FAIL: pyproject.toml에서 고정 버전을 ${EXPECTED_N}개밖에 못 읽었다 — 파서가 깨졌다"
  exit 1
fi

# --- 실측값: 번들 런타임의 importlib.metadata -------------------------------
NAMES=$(printf '%s\n' "$EXPECTED" | sed 's/==.*//' | tr '\n' ' ')

read -r -d '' PYCODE <<'PYEOF'
import importlib.metadata as md
import sys
names = sys.argv[1].split()
names.append("mlx-lm")
names.append("mlx")
names.append("damwha-worker")
for n in names:
    if not n:
        continue
    try:
        print("%s\t%s" % (n, md.version(n)))
    except Exception as exc:
        print("%s\tMISSING(%s)" % (n, type(exc).__name__))
PYEOF

echo "== 격리 실행 — 번들 런타임의 importlib.metadata"
RAW=$(t3_run t3-versions -c "$PYCODE" "$NAMES")
RC=$?

{
  echo "# Task 3 V5 — models extra 고정 버전 대조 (재배치 후)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 기대값 출처: be/worker/pyproject.toml (dependencies + optional-dependencies.models)"
  echo "# exit: $RC"
  echo
  echo "## 기대값"
  printf '%s\n' "$EXPECTED" | sed 's/^/  /'
  echo
  echo "## 실측값 (번들 런타임의 importlib.metadata)"
  printf '%s\n' "$RAW" | sed 's/^/  /'
} > "$OUT"

if [ $RC -ne 0 ]; then
  echo "  FAIL 격리 실행이 exit $RC 로 끝났다. 증거: $OUT"
  exit 1
fi

FAIL=0
echo
echo "== 대조 (${EXPECTED_N}개 고정 버전)"
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  name=${spec%%==*}
  want=${spec#*==}
  got=$(printf '%s\n' "$RAW" | awk -F'\t' -v n="$name" '$1 == n { print $2; exit }')
  if [ -z "$got" ]; then
    echo "  FAIL $name — 실측값이 없다 (설치되지 않았거나 이름이 다르다)"
    FAIL=1
  elif [ "$got" = "$want" ]; then
    echo "  OK   $name $got"
  else
    echo "  FAIL $name — 기대 $want, 실측 $got"
    FAIL=1
  fi
done <<EOT
$EXPECTED
EOT

echo
echo "== mlx-lm (pyproject.toml에 없는 네 번째 런타임, 스펙 §2)"
MLXLM=$(printf '%s\n' "$RAW" | awk -F'\t' '$1 == "mlx-lm" { print $2; exit }')
MLX=$(printf '%s\n' "$RAW" | awk -F'\t' '$1 == "mlx" { print $2; exit }')
case "$MLXLM" in
  ""|MISSING*) echo "  FAIL mlx-lm이 이 런타임에 없다: '${MLXLM:-없음}'"; FAIL=1 ;;
  *)           echo "  OK   mlx-lm $MLXLM (mlx $MLX) — 같은 런타임 안에 있다" ;;
esac

echo
echo "== damwha-worker"
DW=$(printf '%s\n' "$RAW" | awk -F'\t' '$1 == "damwha-worker" { print $2; exit }')
case "$DW" in
  ""|MISSING*) echo "  FAIL damwha-worker가 설치돼 있지 않다: '${DW:-없음}'"; FAIL=1 ;;
  *)           echo "  OK   damwha-worker $DW" ;;
esac

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || exit 1
echo "고정 버전이 전부 일치한다"
exit 0
