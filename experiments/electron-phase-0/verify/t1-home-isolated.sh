#!/bin/bash
# 계획 Task 1 V4 — HOME 격리가 실제로 걸렸는가.
#
# 이 검사가 왜 P0-C10·P0-C13의 전제인지는 스펙 §4.2에 있다. 개발자 홈의
# ~/.cache/huggingface에는 담화가 쓰는 모델이 이미 전부 캐시돼 있어서(40 GB),
# HOME이 새지 않았는지는 "모델을 새로 받았다"와 "초기 준비 비용"을 통째로
# 좌우한다.
#
# 격리는 파일시스템 네임스페이스가 아니라 환경 변수로 한다. 그래서 확인할
# 것은 "개발자 홈이 물리적으로 접근 불가한가"가 아니라 **격리 안의 어떤 값도
# 개발자 홈을 가리키지 않는가**다. 심볼릭 링크로 샌드박스가 개발자 캐시로
# 이어져 있지 않은지까지 inode로 확인한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

FAIL=0
echo "t1-home-isolated.sh — HOME 격리 검사 (스펙 §4.2)"

DEV_HOME="$HOME"

PROBE='
echo "HOME $HOME"
echo "HOME_REAL $(cd "$HOME" 2>/dev/null && pwd -P)"
echo "TMPDIR $TMPDIR"
echo "HF_HOME $HF_HOME"
echo "MODEL_CACHE_DIR $MODEL_CACHE_DIR"
echo "STORAGE_ROOT $STORAGE_ROOT"
if [ -d "$HOME/.cache/huggingface" ]; then
  echo "HFCACHE_ID $(stat -f "%d:%i" "$HOME/.cache/huggingface")"
else
  echo "HFCACHE_ID absent"
fi
if [ -d "$HOME/.cache/huggingface/hub" ]; then
  echo "HFHUB_ENTRIES $(ls -1 "$HOME/.cache/huggingface/hub" | wc -l | tr -d " ")"
else
  echo "HFHUB_ENTRIES 0"
fi
if [ -d "$HOME/.local" ]; then echo "DOTLOCAL present"; else echo "DOTLOCAL absent"; fi
'

OUT=$(bash "$EXP_LIB_DIR/run-isolated.sh" --label t1-home -- /bin/sh -c "$PROBE") || {
  echo "FAIL: 격리 실행이 실패했다"; exit 1; }

echo
printf '%s\n' "$OUT" | sed 's/^/  /'
echo

field() { printf '%s\n' "$OUT" | grep "^$1 " | sed "s/^$1 //"; }

ISO_HOME_SEEN=$(field HOME)
ISO_HOME_REAL=$(field HOME_REAL)

if [ "$ISO_HOME_SEEN" = "$ISO_HOME" ]; then
  echo "OK  HOME이 샌드박스다: $ISO_HOME_SEEN"
else
  echo "FAIL HOME이 샌드박스가 아니다: $ISO_HOME_SEEN"
  FAIL=1
fi
case "$ISO_HOME_SEEN" in
  */experiments/electron-phase-0/sandbox/home)
    echo "OK  HOME 경로가 계획의 \$SANDBOX/home 규약과 같다" ;;
  *)
    echo "FAIL HOME 경로가 \$SANDBOX/home 규약과 다르다"
    FAIL=1 ;;
esac
if [ "$ISO_HOME_REAL" = "$ISO_HOME" ]; then
  echo "OK  HOME의 실경로가 샌드박스 안이다 (심볼릭 링크 탈출 없음)"
else
  echo "FAIL HOME의 실경로가 샌드박스 밖이다: $ISO_HOME_REAL"
  FAIL=1
fi
if [ "$ISO_HOME_SEEN" = "$DEV_HOME" ]; then
  echo "FAIL HOME이 개발자 홈 그대로다"
  FAIL=1
fi

# 나머지 샌드박스 변수도 전부 $SANDBOX 하위여야 한다.
for k in TMPDIR HF_HOME MODEL_CACHE_DIR STORAGE_ROOT; do
  v=$(field "$k")
  case "$v" in
    "$SANDBOX"/*) echo "OK  $k 가 샌드박스 하위다" ;;
    *) echo "FAIL $k 가 샌드박스 밖이다: $v"; FAIL=1 ;;
  esac
done

# 개발자 홈을 가리키는 값이 하나도 없어야 한다 (샌드박스 자신은 $EXP_ROOT
# 하위라 개발자 홈 접두사를 갖는다 — 그 경우는 제외한다).
while IFS= read -r line; do
  k=$(printf '%s\n' "$line" | awk '{print $1}')
  v=$(printf '%s\n' "$line" | sed "s/^$k //")
  case "$v" in
    "$EXP_ROOT"/*|"$EXP_ROOT") continue ;;
    "$DEV_HOME"/*)
      echo "FAIL $k 가 개발자 홈을 가리킨다: $v"
      FAIL=1 ;;
  esac
done <<EOT
$(printf '%s\n' "$OUT" | grep -E '^(HOME|HOME_REAL|TMPDIR|HF_HOME|MODEL_CACHE_DIR|STORAGE_ROOT) ')
EOT

# 샌드박스 HF 캐시가 개발자 캐시와 같은 디렉터리가 아니어야 한다.
SB_ID=$(field HFCACHE_ID)
if [ -d "$DEV_HOME/.cache/huggingface" ]; then
  DEV_ID=$(stat -f '%d:%i' "$DEV_HOME/.cache/huggingface")
  echo "정보 개발자 HF 캐시 id: $DEV_ID / 격리 HF 캐시 id: $SB_ID"
  if [ "$SB_ID" = "$DEV_ID" ]; then
    echo "FAIL 격리 안의 HF 캐시가 개발자 캐시와 같은 디렉터리다 (심볼릭 링크 등)"
    FAIL=1
  else
    echo "OK  격리 안의 HF 캐시가 개발자 캐시와 다른 디렉터리다"
  fi
else
  echo "정보 개발자 홈에 HF 캐시가 없다 — 비교 생략"
fi

HUB=$(field HFHUB_ENTRIES)
echo "정보 격리 HOME의 HF hub 항목 수: $HUB (개발자 캐시 40 GB가 보였다면 이 값이 클 것이다)"
if [ "$(field DOTLOCAL)" = "absent" ]; then
  echo "OK  격리 HOME에 .local이 없다 (uv tool 설치본이 배제됐다)"
else
  echo "정보 격리 HOME에 .local이 있다 — 실험이 만든 것인지 확인이 필요하다"
fi

exit $FAIL
