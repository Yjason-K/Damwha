#!/bin/bash
# 계획 Task 1 V7 — 증거가 실제로 커밋되는 경로에 있는가.
#
# 루트 .gitignore:37의 `*.log`는 경로에 상관없이 걸린다. 증거를 .log로 저장하면
# 커밋에서 **조용히** 빠지고, 그 사실은 리뷰 시점에야 드러난다 (스펙 §6).
# 그래서 여기서는 두 방향을 다 확인한다.
#   - .log는 정말로 무시되는가 (스펙 §6의 근거가 지금도 참인가)
#   - .md / .txt는 정말로 무시되지 않는가
#   - 지금 $EVIDENCE에 .log가 하나도 없는가
#
# git check-ignore는 존재하지 않는 경로에도 규칙을 적용하므로, 확인용 파일을
# 만들었다 지우는 부작용 없이 판정할 수 있다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

FAIL=0
echo "t1-evidence-tracked.sh — 증거 경로와 gitignore (스펙 §6)"
echo "  EVIDENCE: $EVIDENCE"

[ -d "$EVIDENCE" ] || { echo "FAIL 증거 디렉터리가 없다"; exit 1; }

ignored() { git -C "$REPO_ROOT" check-ignore -q "$1"; }

if ignored "$EVIDENCE/__probe__.log"; then
  echo "  OK   .log는 무시된다 — 스펙 §6의 근거가 지금도 참이다"
else
  echo "  FAIL .log가 무시되지 않는다 — 스펙 §6의 전제가 바뀌었다. 스펙을 고쳐야 한다"
  FAIL=1
fi
for ext in txt md; do
  if ignored "$EVIDENCE/__probe__.$ext"; then
    echo "  FAIL .$ext 가 무시된다 — 증거가 커밋되지 않는다"
    FAIL=1
  else
    echo "  OK   .$ext 는 무시되지 않는다"
  fi
done

LOGS=$(find "$EVIDENCE" -type f -name '*.log' | wc -l | tr -d ' ')
if [ "$LOGS" -eq 0 ]; then
  echo "  OK   $EVIDENCE 에 .log 파일이 없다"
else
  echo "  FAIL .log 파일이 ${LOGS}개 있다 — 커밋에서 빠진다"
  find "$EVIDENCE" -type f -name '*.log' | sed 's/^/    /'
  FAIL=1
fi

FILES=$(find "$EVIDENCE" -type f \( -name '*.md' -o -name '*.txt' \) | sort)
N=$(printf '%s\n' "$FILES" | grep -c . || true)
if [ "${N:-0}" -eq 0 ]; then
  echo "  FAIL 증거 파일이 하나도 없다 — 격리 실행이 증거를 남기지 않았다"
  FAIL=1
else
  echo "  OK   증거 파일 ${N}개"
  printf '%s\n' "$FILES" | sed "s|^$REPO_ROOT/|    |"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ignored "$f"; then
      echo "  FAIL 무시되는 증거 파일: $f"
      FAIL=1
    fi
  done <<EOT
$FILES
EOT
fi

# $EXP의 국소 .gitignore가 실제로 먹는가. 루트 .gitignore를 고치지 않았다는
# 것과 짝이 되는 확인이다 (스펙 §6).
echo
echo "  experiments/electron-phase-0/.gitignore 동작 확인"
for d in sandbox stage bundle pgdata run downloads signed; do
  if ignored "$EXP_ROOT/$d/probe.txt"; then
    echo "  OK   $d/ 는 무시된다"
  else
    echo "  FAIL $d/ 가 무시되지 않는다 — 수 GB 산출물이 커밋 대상이 된다"
    FAIL=1
  fi
done
for keep in lib/config.sh verify/t1-evidence-tracked.sh probe/deps-survey.md; do
  if ignored "$EXP_ROOT/$keep"; then
    echo "  FAIL $keep 가 무시된다 — 실험 코드가 커밋되지 않는다"
    FAIL=1
  else
    echo "  OK   $keep 는 커밋 대상이다"
  fi
done

exit $FAIL
