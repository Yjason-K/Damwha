#!/bin/bash
# 사전 점검 (스펙 §4.4 "디스크 여유", §7.1 U-6 "실험용 포트").
#
#   preflight.sh <필요GiB>
#
# 실험 산출물이 들어갈 파일시스템의 여유가 인자보다 작으면 **시작하지 않고**
# exit 1이다. 조용히 디스크를 채우면 개발 환경까지 같이 죽는다 (R-14).
#
# 포트는 보고만 하고 판정하지 않는다. 55432/58000/58100은 뒤 Task에서 실험
# 자신이 점유하므로(Task 7은 DB가 떠 있는 상태에서 이 스크립트를 부른다)
# 점유를 실패로 만들면 정상 흐름이 막힌다. 대신 **누가** 물고 있는지를
# 구분해 출력한다 — 실험 자신의 PID 파일과 대조한다.
#
# 검사 도구(otool/file/lsof/shasum)가 없으면 뒤 Task의 G1·증거 수집이
# 성립하지 않으므로 여기서 실패시킨다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/config.sh"

[ $# -eq 1 ] || { echo "usage: preflight.sh <필요GiB>" >&2; exit 2; }
NEED_GIB="$1"
case "$NEED_GIB" in
  ''|*[!0-9]*) echo "usage: preflight.sh <필요GiB>  (정수)" >&2; exit 2 ;;
esac

exp_ensure_sandbox

echo "preflight.sh — 사전 점검"
echo

FAIL=0

# --- 디스크 여유 -------------------------------------------------------------
DF_LINE=$(df -g "$EXP_ROOT" | tail -n 1)
MOUNT=$(echo "$DF_LINE" | awk '{print $NF}')
AVAIL=$(echo "$DF_LINE" | awk '{print $4}')
echo "디스크"
echo "  대상 경로 : $EXP_ROOT"
echo "  마운트    : $MOUNT"
echo "  여유      : ${AVAIL} GiB"
echo "  필요      : ${NEED_GIB} GiB"
if [ "$AVAIL" -lt "$NEED_GIB" ]; then
  echo "  판정      : 부족 — 이 Task를 시작하지 않는다 (스펙 §4.4, R-14)"
  FAIL=1
else
  echo "  판정      : 충분"
fi
echo

# --- 포트 --------------------------------------------------------------------
echo "포트 (개발 기본값 5432 / 8000 / 8100과 분리된 실험 포트, 스펙 §7.1 U-6)"
own_pid() {
  local target="$1" f name pid
  for f in "$SANDBOX"/run/*.pid; do
    [ -e "$f" ] || continue
    name=$(basename "$f" .pid)
    pid=$(cat "$f" 2>/dev/null)
    if [ "$pid" = "$target" ]; then echo "$name"; return 0; fi
  done
  return 1
}
for entry in "55432 실험 DB" "58000 mlx_lm.server" "58100 embed"; do
  port=$(echo "$entry" | awk '{print $1}')
  what=$(echo "$entry" | cut -d' ' -f2-)
  if pid=$(exp_port_pid "$port"); then
    if owner=$(own_pid "$pid"); then
      echo "  $port ($what): busy(experiment) pid=$pid name=$owner"
    else
      echo "  $port ($what): busy(foreign) pid=$pid"
    fi
  else
    echo "  $port ($what): free"
  fi
done
echo

# --- 검사 도구 ---------------------------------------------------------------
echo "검사 도구 (스펙 §4.0 — 피검사 대상이 아니라 측정 수단이다)"
for t in otool file lsof shasum df; do
  if command -v "$t" >/dev/null 2>&1; then
    echo "  $t: $(command -v "$t")"
  else
    echo "  $t: 없음 — G1·증거 수집이 성립하지 않는다"
    FAIL=1
  fi
done
echo

# --- 원본 오디오 저장소 ------------------------------------------------------
if storage=$(exp_source_storage_root); then
  echo "be/storage(읽기 전용 원본): $storage"
else
  echo "be/storage(읽기 전용 원본): 찾지 못함 — DAMWHA_SOURCE_STORAGE로 지정한다"
  FAIL=1
fi

exit $FAIL
