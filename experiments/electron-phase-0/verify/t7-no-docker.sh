#!/bin/bash
# 계획 Task 7 V9 — 드라이버가 컨테이너 런타임을 쓰지 않는가 (스펙 P0-C4, §3.1).
#
# `be/worker/scripts/smoke_process_meeting.py` 는 `PostgresContainer(...)` 로
# 컨테이너를 띄운다. Phase 0 이 제거하려는 바로 그 의존이고, 그 라이브러리는
# `dev` 의존성 그룹이라 `models` extra 만 담은 번들에 존재하지도 않는다. 그래서
# Task 7 은 자체 드라이버를 두고, 이 검사가 그 드라이버에 같은 의존이 다시
# 들어오지 않았는지를 본다.
#
# ## 왜 `grep -c` 를 직접 부르지 않는가
#
# 계획의 이전 V9 는 `grep -c '<이름>' <드라이버>` 였고 기대 칸이 `0` 이었다.
# 그런데 grep 은 매치가 0건이면 **`0` 을 출력하면서 exit 1** 을 낸다. 기대 칸의
# `0` 은 출력이지 종료 코드가 아니므로, verifier 가 종료 코드로 판정하면
# **통과해야 할 때 실패**하고 어긋날 때 통과한다. 정확히 뒤집힌다.
#
# 이 스크립트는 값만 읽고 grep 의 종료 코드는 흘린다
# (`t7-lib.sh::t7_count_literal` 이 `|| true` 로 처리한다). 판정은 이 스크립트의
# exit 0 / 1 하나로만 한다 — 계획 "Verify 명령 작성 규칙" 그대로다.
#
# ## 이 검사는 "코드에 없다"가 아니라 "파일 어디에도 없다"이다
#
# **중요 — 뒤에 이 파일들을 손대는 사람에게.** 아래 검사는 리터럴 문자열이
# 몇 줄에 나오는지를 셀 뿐이고 **코드와 주석·docstring 을 구분하지 않는다.**
# 대소문자도 무시한다(`-i`). 그래서 드라이버의 docstring 이 "왜 smoke 스크립트를
# 쓰지 않는가"를 설명하면서 그 라이브러리나 런타임의 이름을 **한 번만 적어도
# 이 검사가 깨진다.** 실제로 그렇게 깨진 적이 있다 — 첫 구현의 docstring 이
# 이름을 한 번 적어 수가 1 이었고, 이름을 빼고 뜻만 남기도록 고쳤다.
#
# 드라이버가 그 사정을 자기 docstring 에도 적어 두었다. 설명을 다시 쓸 일이
# 생기면 이름 대신 "컨테이너 런타임" / "그 컨테이너 라이브러리" 같은 표현을
# 쓴다. 이름을 꼭 적어야 한다면 검사 대상을 코드 줄로 좁히는 쪽을 먼저
# 계획에 반영하고, 이 스크립트를 조용히 느슨하게 만들지 않는다.
#
# 이 스크립트 자신은 검사 대상이 아니다 — 검사할 문자열을 담아야 하므로
# 자기 자신을 세면 언제나 위반이 된다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t7-lib.sh"

DRIVER="$EXP_ROOT/drivers/process_meeting_driver.py"

# 검사할 이름. 순서는 계획 V9 의 문구 순서다.
PAT_LIB='testcontainers'
PAT_RUNTIME='docker'

FAIL=0
OUT=$(t7_evidence_path "t7-no-docker.txt")

REPORT=$(
  echo "== 검사 대상"
  echo "  파일: $DRIVER"
  if [ -f "$DRIVER" ]; then
    echo "  줄 수: $(wc -l < "$DRIVER" | tr -d ' ')"
    echo "RC_FILE=0"
  else
    echo "  FAIL 드라이버가 없다"
    echo "RC_FILE=1"
  fi

  echo
  echo "== 리터럴 등장 (대소문자 무시, 매치된 **줄 수**)"
  echo "   코드와 주석·docstring 을 구분하지 않는다 — 이 파일 어디에도 없어야 한다."
  RC=0
  for pat in "$PAT_LIB" "$PAT_RUNTIME"; do
    if [ -f "$DRIVER" ]; then
      n=$(t7_count_literal "$DRIVER" "$pat")
    else
      n="?"
    fi
    if [ "$n" = "0" ]; then
      echo "  OK   0건  '$pat'"
    else
      echo "  FAIL ${n}건  '$pat'"
      grep -n -i -F -- "$pat" "$DRIVER" 2>/dev/null | head -5 | sed 's/^/       /'
      RC=1
    fi
  done
  echo "RC_PATTERNS=$RC"

  echo
  echo "== 드라이버가 실제로 붙는 곳 (컨테이너가 아니라 번들 PostgreSQL 이다)"
  echo "  스펙 §4.2 의 DATABASE_URL 은 127.0.0.1:$EXP_PG_PORT 이고,"
  echo "  드라이버는 DSN 에 ':$EXP_PG_PORT/' 가 없으면 시작조차 하지 않는다."
  if grep -q "55432" "$DRIVER" 2>/dev/null; then
    echo "  OK   드라이버에 실험 포트 $EXP_PG_PORT 가드가 있다"
    grep -n '55432' "$DRIVER" | head -3 | sed 's/^/       /'
    echo "RC_PORT=0"
  else
    echo "  FAIL 실험 포트 가드가 보이지 않는다"
    echo "RC_PORT=1"
  fi
)

printf '%s\n' "$REPORT" | grep -v '^RC_'

for k in RC_FILE RC_PATTERNS RC_PORT; do
  v=$(printf '%s\n' "$REPORT" | sed -n "s/^$k=//p" | tail -n 1)
  [ "$v" = "0" ] || FAIL=1
done

{
  echo "# Task 7 V9 — 드라이버가 컨테이너 런타임을 쓰지 않는가 (P0-C4)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# grep -c 의 종료 코드에 기대지 않는다 — 0건일 때 exit 1 이라 판정이 뒤집힌다."
  echo "# 이 검사는 코드와 주석·docstring 을 구분하지 않는다. 드라이버 docstring 에"
  echo "# 그 이름을 다시 적으면 깨진다 (스크립트 머리말 참고)."
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 드라이버에 컨테이너 런타임 참조가 남아 있다"; exit 1; }
echo "판정: 드라이버에 '$PAT_LIB'·'$PAT_RUNTIME' 참조가 0건이다"
exit 0
