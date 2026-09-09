#!/bin/bash
# 계획 Task 1 V2 — 격리 실행의 환경 변수 집합이 스펙 §4.2 표와 정확히 일치하는가.
#
# 화이트리스트가 화이트리스트로 동작하는지를 실제 자식 프로세스의 environ으로
# 확인한다. run-isolated.sh가 /usr/bin/env를 **직접** exec 하므로 출력은 주입한
# 것 그대로다 — 중간에 셸을 끼우면 셸이 PWD·SHLVL·_를 얹어서 비교가 무의미해진다.
#
# 비교에서 빼는 이름 두 개와 그 이유:
#   HF_TOKEN              스펙 §4.2 표에 있지만 자격 증명이라 값을 기록하지 않는다.
#                         있고 없고만 be/worker/.env의 상태와 대조한다.
#   DYLD_PRINT_LIBRARIES  계측 도구다 (스펙 §4.2의 dyld 실측). 주입 화이트리스트가
#                         아니며, SIP가 플랫폼 바이너리에서 지워 버리기도 한다.
# 나머지 11개가 스펙 표와 정확히 일치해야 한다. 스펙 §4.2 표의 이름을 세면
# HF_TOKEN까지 12개다 — 표의 "행"은 10개지만 MODEL_CACHE_DIR·HF_HOME이 한
# 행에, EMBED_SERVICE_HOST·PORT가 또 한 행에 묶여 있다. 주입은 12개를 하고,
# 이름 집합 비교는 비밀값을 뺀 11개로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

FAIL=0
echo "t1-env-allowlist.sh — G2 주입 화이트리스트 검사 (스펙 §4.2)"

OUT=$(bash "$EXP_LIB_DIR/run-isolated.sh" --label t1-env -- /usr/bin/env) || {
  echo "FAIL: 격리 실행이 실패했다"; exit 1; }

# 값은 절대 출력하지 않는다 — HF_TOKEN이 섞여 있다.
NAMES=$(printf '%s\n' "$OUT" | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort)
CORE=$(printf '%s\n' "$NAMES" | grep -v -x 'HF_TOKEN' | grep -v -x 'DYLD_PRINT_LIBRARIES' || true)
EXPECTED=$(printf '%s\n' $ISO_VAR_NAMES | sort)

echo
echo "자식 프로세스의 변수 이름 (값은 출력하지 않는다):"
printf '%s\n' "$NAMES" | sed 's/^/  /'

echo
if [ "$CORE" = "$EXPECTED" ]; then
  echo "OK  주입 변수 11개(+ HF_TOKEN = 스펙 §4.2 표의 12개)가 정확히 일치한다"
else
  echo "FAIL 주입 변수가 스펙 §4.2 표와 다르다"
  echo "  기대:"; printf '%s\n' "$EXPECTED" | sed 's/^/    /'
  echo "  실제:"; printf '%s\n' "$CORE"     | sed 's/^/    /'
  FAIL=1
fi

# --- env -i가 지워야 하는 것들 ------------------------------------------------
for bad in VIRTUAL_ENV PYTHONPATH PYTHONHOME HUGGINGFACE_HUB_CACHE PYTHONSTARTUP; do
  if printf '%s\n' "$NAMES" | grep -q -x "$bad"; then
    echo "FAIL $bad 가 격리 안에 남아 있다"
    FAIL=1
  fi
done
if printf '%s\n' "$NAMES" | grep -q '^UV_'; then
  echo "FAIL UV_* 변수가 격리 안에 남아 있다"
  FAIL=1
fi
if printf '%s\n' "$NAMES" | grep '^DYLD_' | grep -q -v -x 'DYLD_PRINT_LIBRARIES'; then
  echo "FAIL DYLD_PRINT_LIBRARIES 말고 다른 DYLD_* 가 있다"
  FAIL=1
fi
[ "$FAIL" -eq 0 ] && echo "OK  VIRTUAL_ENV / PYTHONPATH / PYTHONHOME / UV_* / HUGGINGFACE_HUB_CACHE 가 모두 없다"

# --- HF_TOKEN: 존재 여부만 대조하고 값은 어디에도 남기지 않는다 --------------
if TOK=$(exp_read_hf_token); then
  WANT_TOKEN=1
else
  WANT_TOKEN=0
  TOK=""
fi
HAS_TOKEN=0
printf '%s\n' "$NAMES" | grep -q -x 'HF_TOKEN' && HAS_TOKEN=1
if [ "$WANT_TOKEN" -eq "$HAS_TOKEN" ]; then
  echo "OK  HF_TOKEN 주입 상태가 be/worker/.env와 일치한다 (set=$HAS_TOKEN)"
else
  echo "FAIL HF_TOKEN 주입 상태가 be/worker/.env와 다르다 (기대 set=$WANT_TOKEN, 실제 set=$HAS_TOKEN)"
  FAIL=1
fi

ENV_TXT="$EVIDENCE/t1-env-env.txt"
if [ ! -f "$ENV_TXT" ]; then
  echo "FAIL 주입 기록이 없다: $ENV_TXT"
  FAIL=1
else
  if grep -q -E '^HF_TOKEN=(set|unset)( |$)' "$ENV_TXT"; then
    echo "OK  증거에 HF_TOKEN이 set/unset으로만 적혀 있다"
  else
    echo "FAIL 증거의 HF_TOKEN 표기가 set/unset이 아니다"
    FAIL=1
  fi
  if [ -n "$TOK" ] && grep -q -F "$TOK" "$ENV_TXT"; then
    echo "FAIL 증거 파일에 HF_TOKEN 값이 들어 있다"
    FAIL=1
  fi
fi

# 증거 디렉터리 전체에도 토큰 값이 없어야 한다.
if [ -n "$TOK" ]; then
  if grep -rqlF "$TOK" "$EVIDENCE" 2>/dev/null; then
    echo "FAIL 증거 디렉터리에 HF_TOKEN 값이 들어 있는 파일이 있다"
    FAIL=1
  else
    echo "OK  증거 디렉터리 어디에도 HF_TOKEN 값이 없다"
  fi
fi

exit $FAIL
