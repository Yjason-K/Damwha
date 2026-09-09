#!/bin/bash
# 계획 Task 5 V11 — **t5-embed / t5-llm의 dyld 실측이 진짜 서버 프로세스의
# 것인가.**
#
# 줄 수가 0이 아니라는 것만으로는 아무것도 증명되지 않는다. 런처 자신의 로드
# 목록만 남은 "위반 0건짜리 가짜 증거"도 줄 수는 넉넉하다 — Task 1의 D3이
# 그 형태를 일부러 만들어 두었고, Task 2가 `pg_ctl start`에서 실물을 봤다
# (dyld 162줄 전부 pg_ctl 것, 시험 postmaster 0줄).
#
# 그래서 계획 규칙 6b가 정한 순서로 본다 — **pid를 먼저 고정하고**, 그 pid가
# 번들 이미지를 실제로 로드했는지 확인한다. 순서를 뒤집어 "경로로 pid를 찾는"
# 방식은 틀린다: llm.sh는 기동 전에 같은 번들 python으로 모델을 받으므로 첫
# 매치가 서버 pid가 아니다.
#
# 일치는 **접두사**로 본다 (규칙 6c). damwha-embed와 mlx_lm.server는 셔뱅
# 스크립트라 dyld의 메인 이미지가 셔뱅의 인터프리터
# (bundle/python/bin/python3.12)다. 스크립트 경로 정확 일치는 언제나 0건이 되고,
# 그러면 이 검사는 늘 실패하는 무의미한 검사가 된다.
#
# 이 검사는 V2·V6(기동) 회차의 증거를 읽는다. 서비스를 다시 띄우면 pid가
# 바뀌므로 그때는 기동부터 다시 해야 한다. V5·V9(stop) 뒤에도 판정이
# 성립하도록 측정 대상 pid는 PID 파일 → 런처가 같은 순간에 남긴 기동 기록
# 순으로 찾는다 (t5-lib.sh::t5_measured_pid).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t5-lib.sh"

FAIL=0
OUT=$(t5_evidence_path "t5-dyld-measured.txt")

REPORT=$(
  t5_assert_dyld_measured "$EVIDENCE/t5-embed-dyld.txt" embed t5-embed
  echo "embed_rc=$?"
  echo
  t5_assert_dyld_measured "$EVIDENCE/t5-llm-dyld.txt" llm t5-llm
  echo "llm_rc=$?"
)

printf '%s\n' "$REPORT" | grep -v '^embed_rc=\|^llm_rc='

EMBED_RC=$(printf '%s\n' "$REPORT" | sed -n 's/^embed_rc=//p')
LLM_RC=$(printf '%s\n' "$REPORT" | sed -n 's/^llm_rc=//p')
[ "$EMBED_RC" = "0" ] || FAIL=1
[ "$LLM_RC" = "0" ] || FAIL=1

{
  echo "# Task 5 V11 — dyld 실측이 서버 프로세스의 것인가 (계획 규칙 6 / 6b / 6c)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 판정 방식: pid를 먼저 고정하고 그 pid의 로드 목록에서 bundle/python/"
  echo "#            접두사를 센다. 파일 전체 grep은 헤더의 '# argv:' 줄에 항상"
  echo "#            매치되므로 쓰지 않는다."
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 실측이 성립하지 않는다 (embed_rc=$EMBED_RC llm_rc=$LLM_RC)"; exit 1; }
echo "판정: 두 서비스의 dyld 실측이 각자의 서버 프로세스 것이고, 번들 이미지를 로드했다"
exit 0
