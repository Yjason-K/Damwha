#!/bin/bash
# 계획 Task 8 V5 — RESULTS.md 가 P0-C9 가 요구한 것을 **실제로** 담고 있는가.
#
# 스펙 P0-C9 성공 판정은 "서명 실패 파일 목록, 필요한 entitlement 목록,
# Gatekeeper 동작이 문서에 기록된다"이고, 계획 V5 는 여기에 공증 선결 조건과
# R-12 를 더한다. 이 스크립트는 그 다섯 가지가 문서에 있는지 본다.
#
# ## 문자열이 있는지만 보지 않는다
#
# `grep -q '서명 실패'` 같은 검사는 문서에 그 단어가 남아 있기만 하면 통과한다.
# 그래서 여기서는 값을 뽑아 다른 산출물과 맞춰 본다.
#
#   - 서명 실패 개수  <-> 증거 t8-sign.txt 의 집계
#   - 전수 조사 개수  <-> signing/unsigned-inventory.txt 의 집계
#   - Gatekeeper 절   <-> probe.sh 가 끼우는 기계 생성 블록이 자리표시자가 아닌가,
#                         그 절이 인용하는 증거 파일이 실제로 있는가
#
# 특히 전수 조사 개수는 **arm64 슬라이스에 서명이 없는 것**과 **arm64 는 서명돼
# 있고 다른 슬라이스만 서명이 없는 것**을 따로 본다. 이 둘을 뭉뚱그리면 Phase 4
# 가 해야 할 일의 크기가 달라진다 (RESULTS.md §1 이 정정한 바로 그 혼동이다).
#
# ## 스스로 음성 대조를 한다
#
# 검사가 무조건 통과하면 그 자체로 쓸모가 없다. 이 스크립트는 판정 로직을
# t8_scan() 하나에 모아 두고, 마지막에 **항목마다 그것을 지운 사본**을 만들어
# 같은 로직에 먹인다. 지운 항목이 FAIL 로 잡히지 않으면 이 스크립트가 실패한다.
# 사본은 $SANDBOX 아래에만 만들고 RESULTS.md 원본은 읽기만 한다.
#
# 이 스크립트는 문서 검사다. 번들을 실행하지 않으므로 격리 러너가 필요 없다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t8-lib.sh"

t8_require_results || exit 1

SIGN_EV="$EVIDENCE/t8-sign.txt"
WORK="$SANDBOX/t8-v5"

# <파일> <절 번호> — "## <번호>." 부터 다음 "## " 앞까지.
t8_section() {
  awk -v n="$2" '
    $0 ~ "^## " n "\\." { on = 1; print; next }
    on && /^## / { exit }
    on { print }
  ' "$1"
}

# <파일> <마커> — <!-- BEGIN:마커 --> 와 <!-- END:마커 --> 사이.
t8_block() {
  awk -v m="$2" '
    $0 == "<!-- BEGIN:" m " -->" { on = 1; next }
    $0 == "<!-- END:" m " -->"   { on = 0 }
    on { print }
  ' "$1"
}

# 정수만 남긴다. 비었거나 숫자가 아니면 빈 문자열.
t8_int() {
  case "$1" in
    ''|*[!0-9]*) echo "" ;;
    *)           echo "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# 판정 로직 — <RESULTS 파일> <inventory 파일>
#
# "<OK|FAIL>\t<검사 id>\t<설명>" 을 한 줄씩 낸다. 종료 코드는 쓰지 않는다.
# 호출하는 쪽이 FAIL 줄을 센다. 음성 대조가 같은 함수를 재사용하려고
# 이렇게 갈랐다 — 판정이 두 벌이면 한쪽만 느슨해져도 드러나지 않는다.
# ---------------------------------------------------------------------------
t8_scan() {
  local doc inv sec blk n m
  doc="$1"
  inv="$2"

  # --- 1. 서명 실패 목록 (스펙 P0-C9 성공 판정 1) ---------------------------
  sec=$(t8_section "$doc" 2)
  local fail_n
  fail_n=$(t8_int "$(printf '%s\n' "$sec" \
            | sed -n 's/.*\*\*서명 실패\*\*.*\*\*\([0-9][0-9]*\)개\*\*.*/\1/p' | head -n 1)")
  if [ -z "$fail_n" ]; then
    printf 'FAIL\tsign-fail-count\t§2 에 서명 실패 **N개** 집계가 없다\n'
  else
    printf 'OK\tsign-fail-count\t서명 실패 %s개로 집계돼 있다\n' "$fail_n"
  fi

  if printf '%s\n' "$sec" | grep -q '서명 실패 파일 목록'; then
    if [ "${fail_n:-1}" = "0" ]; then
      # 0건이어도 "0건"으로 적으라는 것이 계획 Task 8 Interfaces 다.
      if printf '%s\n' "$sec" | grep -q '0건'; then
        printf 'OK\tsign-fail-list\t실패 0건이 "0건"으로 명시돼 있다\n'
      else
        printf 'FAIL\tsign-fail-list\t실패가 0개인데 목록 자리에 "0건"이 없다\n'
      fi
    else
      n=$(printf '%s\n' "$sec" | grep -c '^- `' || true)
      n=$(t8_int "$n"); n="${n:-0}"
      if [ "$n" -ge "${fail_n:-1}" ]; then
        printf 'OK\tsign-fail-list\t실패 %s개가 목록 %s줄로 적혀 있다\n' "$fail_n" "$n"
      else
        printf 'FAIL\tsign-fail-list\t실패 %s개인데 목록이 %s줄뿐이다\n' "$fail_n" "$n"
      fi
    fi
  else
    printf 'FAIL\tsign-fail-list\t§2 에 "서명 실패 파일 목록"이 없다\n'
  fi

  # 문서의 집계가 실측 증거와 같은가. 증거가 없으면 그 자체가 실패다 —
  # 문서만 있고 측정이 없는 상태를 통과시키지 않는다.
  if [ -f "$SIGN_EV" ]; then
    m=$(t8_int "$(sed -n 's/^# 서명 실패 *: *\([0-9][0-9]*\)개.*/\1/p' "$SIGN_EV" | head -n 1)")
    if [ -z "$m" ]; then
      printf 'FAIL\tsign-fail-evidence\t증거 t8-sign.txt 에서 서명 실패 집계를 읽지 못했다\n'
    elif [ "$m" = "${fail_n:-}" ]; then
      printf 'OK\tsign-fail-evidence\t증거 t8-sign.txt 도 %s개라고 적고 있다\n' "$m"
    else
      printf 'FAIL\tsign-fail-evidence\t문서 %s개 vs 증거 %s개 — 문서가 실측과 다르다\n' "${fail_n:-없음}" "$m"
    fi
  else
    printf 'FAIL\tsign-fail-evidence\t증거가 없다: %s\n' "$SIGN_EV"
  fi

  # --- 2. entitlement 결론 (스펙 P0-C9 성공 판정 2) --------------------------
  sec=$(t8_section "$doc" 3)
  local claim ent_names
  claim=$(printf '%s\n' "$sec" | grep -F '결론: 필요한 entitlement 최소 집합' | head -n 1)
  ent_names=$(printf '%s' "$claim" | tr ' ,*' '\n\n\n' \
              | grep '^com\.apple\.security\.cs\.' | sort -u)
  if [ -z "$claim" ]; then
    printf 'FAIL\tent-conclusion\t§3 에 entitlement 최소 집합 결론이 없다\n'
  elif [ -n "$ent_names" ]; then
    printf 'OK\tent-conclusion\t결론이 entitlement 를 이름으로 든다: %s\n' \
      "$(printf '%s' "$ent_names" | tr '\n' ' ')"
  elif printf '%s' "$claim" | grep -q '필요 없\|없음'; then
    printf 'OK\tent-conclusion\t결론이 "필요 없음"이다 — 그것도 유효한 결론이다\n'
  else
    printf 'FAIL\tent-conclusion\t결론 줄에 entitlement 이름도 "필요 없음"도 없다\n'
  fi

  # 결론에는 근거가 붙어야 한다 (계획 Task 8 Review). 근거는 회차 표와
  # 실패 회차의 오류 원문이다.
  n=$(printf '%s\n' "$sec" | grep -c '^| escalate |' || true)
  m=$(printf '%s\n' "$sec" | grep -c '^| reduce |' || true)
  n=$(t8_int "$n"); n="${n:-0}"
  m=$(t8_int "$m"); m="${m:-0}"
  if [ "$n" -ge 1 ] && [ "$m" -ge 1 ]; then
    printf 'OK\tent-matrix\t회차 표에 escalate %s행 / reduce %s행이 있다\n' "$n" "$m"
  else
    printf 'FAIL\tent-matrix\t회차 표가 없다 (escalate %s행, reduce %s행) — 최소 집합의 근거가 빠졌다\n' "$n" "$m"
  fi

  n=$(printf '%s\n' "$sec" | grep -c '"ok": false' || true)
  n=$(t8_int "$n"); n="${n:-0}"
  if [ "$n" -ge 1 ]; then
    printf 'OK\tent-error-text\t실패 회차의 오류 원문이 %s줄 실려 있다\n' "$n"
  else
    printf 'FAIL\tent-error-text\t실패 회차의 오류 원문이 없다 — 결론의 근거가 문서에 없다\n'
  fi

  # --- 3. Gatekeeper 동작 (스펙 P0-C9 성공 판정 3) ---------------------------
  sec=$(t8_section "$doc" 6)
  blk=$(t8_block "$doc" gatekeeper)
  if [ -z "$(printf '%s' "$blk" | tr -d '[:space:]')" ]; then
    printf 'FAIL\tgk-block\t§6 의 기계 생성 블록이 비어 있다 — probe.sh quarantine 결과가 없다\n'
  elif printf '%s\n' "$blk" | grep -q '미실행'; then
    printf 'FAIL\tgk-block\t§6 블록이 자리표시자("미실행") 그대로다\n'
  else
    printf 'OK\tgk-block\t§6 에 실측 블록이 들어 있다\n'
  fi

  n=$(printf '%s\n' "$blk" | grep -c '^| `.*` | exit ' || true)
  n=$(t8_int "$n"); n="${n:-0}"
  if [ "$n" -ge 1 ]; then
    printf 'OK\tgk-exit\t대상 %s개의 종료 코드가 표로 적혀 있다\n' "$n"
  else
    printf 'FAIL\tgk-exit\t격리 속성을 붙였을 때의 종료 코드가 표에 없다\n'
  fi

  if printf '%s\n' "$sec" | grep -q 'com\.apple\.quarantine'; then
    printf 'OK\tgk-attr\t§6 이 com.apple.quarantine 부여를 적고 있다\n'
  else
    printf 'FAIL\tgk-attr\t§6 에 com.apple.quarantine 이 없다\n'
  fi

  # 허용/차단/프롬프트 중 무엇이었는지가 계획 V4 의 기대다.
  if printf '%s\n' "$sec" | grep -q '차단\|허용\|프롬프트'; then
    printf 'OK\tgk-verdict\t§6 이 허용/차단/프롬프트 중 무엇이었는지 말한다\n'
  else
    printf 'FAIL\tgk-verdict\t§6 이 Gatekeeper 판정(허용/차단/프롬프트)을 말하지 않는다\n'
  fi

  # 인용한 증거 파일이 실제로 있는가. 문서가 없는 파일을 가리키면 그 절은
  # 추적 불가능하다.
  local cited miss
  cited=$(printf '%s\n' "$blk" \
          | sed -n 's|.*docs/superpowers/reports/evidence/phase-0/\([a-zA-Z0-9._-]*\).*|\1|p' \
          | sort -u)
  if [ -z "$cited" ]; then
    printf 'FAIL\tgk-evidence\t§6 블록이 증거 파일을 인용하지 않는다\n'
  else
    miss=""
    for f in $cited; do
      [ -f "$EVIDENCE/$f" ] || miss="$miss $f"
    done
    if [ -z "$miss" ]; then
      printf 'OK\tgk-evidence\t인용한 증거가 있다:%s\n' " $(printf '%s' "$cited" | tr '\n' ' ')"
    else
      printf 'FAIL\tgk-evidence\t인용한 증거 파일이 없다:%s\n' "$miss"
    fi
  fi

  # --- 4. 공증 선결 조건 (스펙 P0-C9 확인 방법 4) ----------------------------
  sec=$(t8_section "$doc" 7)
  n=$(printf '%s\n' "$sec" | grep -c '^| [0-9]' || true)
  n=$(t8_int "$n"); n="${n:-0}"
  if [ "$n" -ge 5 ]; then
    printf 'OK\tnotarize-list\t공증 선결 조건이 %s개 항목으로 있다\n' "$n"
  else
    printf 'FAIL\tnotarize-list\t공증 선결 조건 목록이 없거나 너무 짧다 (%s개)\n' "$n"
  fi
  if printf '%s\n' "$sec" | grep -q '제출하지 않'; then
    printf 'OK\tnotarize-scope\t제출하지 않았다고 명시돼 있다\n'
  else
    printf 'FAIL\tnotarize-scope\t"제출하지 않았다"가 없다 — 범위가 문서에 고정되지 않았다\n'
  fi
  if printf '%s\n' "$sec" | grep -q 'Developer ID'; then
    printf 'OK\tnotarize-devid\t목록이 Developer ID 인증서를 선결 조건으로 든다\n'
  else
    printf 'FAIL\tnotarize-devid\t목록에 Developer ID 인증서가 없다\n'
  fi

  # --- 5. R-12 미재현 사각 (스펙 §7.2 R-12) ----------------------------------
  n=$(t8_count_literal "$doc" "R-12")
  if [ "$n" -ge 1 ]; then
    printf 'OK\tr12-present\tR-12 가 %s줄에 나온다\n' "$n"
  else
    printf 'FAIL\tr12-present\tR-12 가 문서에 없다\n'
  fi
  sec=$(t8_section "$doc" 8)
  if printf '%s\n' "$sec" | grep -q 'R-12' \
     && printf '%s\n' "$sec" | grep -q '재현되지 않\|재현할 수 없\|미재현'; then
    printf 'OK\tr12-blind\tR-12 가 미재현 사각으로 서술돼 있다\n'
  else
    printf 'FAIL\tr12-blind\tR-12 가 "재현되지 않는다"로 서술된 절이 없다\n'
  fi
  sec=$(t8_section "$doc" 9)
  if printf '%s\n' "$sec" | grep -q 'R-12\|§8'; then
    printf 'OK\tr12-handoff\tPhase 6 인계 목록이 R-12 를 가리킨다\n'
  else
    printf 'FAIL\tr12-handoff\tPhase 6 인계 목록에 R-12 항목이 없다\n'
  fi

  # --- 6. 전수 조사 집계이 산출물과 같은가 (R-5 / Phase 4 인계량) ------------
  sec=$(t8_section "$doc" 1)
  local d_total d_arm d_mixed i_total i_arm i_mixed
  d_total=$(t8_int "$(printf '%s\n' "$sec" | sed -n 's/^| Mach-O 정규 파일 전체 | \([0-9][0-9]*\)개 |$/\1/p' | head -n 1)")
  d_arm=$(t8_int "$(printf '%s\n' "$sec"   | sed -n 's/^| \*\*arm64 슬라이스에 서명이 없는 것\*\* | \*\*\([0-9][0-9]*\)개\*\* |$/\1/p' | head -n 1)")
  d_mixed=$(t8_int "$(printf '%s\n' "$sec" | sed -n 's/^| arm64는 서명 \/ 다른 슬라이스가 서명 없음 | \([0-9][0-9]*\)개 |$/\1/p' | head -n 1)")
  if [ -f "$inv" ]; then
    i_total=$(t8_int "$(sed -n 's/^# Mach-O 정규 파일 전체 *: *\([0-9][0-9]*\)개.*/\1/p' "$inv" | head -n 1)")
    i_arm=$(t8_int "$(sed -n 's/^# arm64 슬라이스에 서명이 없는 것 *: *\([0-9][0-9]*\)개.*/\1/p' "$inv" | head -n 1)")
    i_mixed=$(t8_int "$(sed -n 's/^# arm64 는 서명 \/ 다른 슬라이스가 서명 없음 *: *\([0-9][0-9]*\)개.*/\1/p' "$inv" | head -n 1)")
  else
    i_total=""; i_arm=""; i_mixed=""
  fi
  if [ -z "$d_total" ] || [ -z "$d_arm" ] || [ -z "$d_mixed" ]; then
    printf 'FAIL\tinv-doc\t§1 의 집계 표에서 전체/arm64-무서명/타슬라이스-무서명 을 읽지 못했다\n'
  else
    printf 'OK\tinv-doc\t§1 집계: 전체 %s / arm64 무서명 %s / 타슬라이스만 무서명 %s\n' \
      "$d_total" "$d_arm" "$d_mixed"
  fi
  if [ -z "$i_total" ] || [ -z "$i_arm" ] || [ -z "$i_mixed" ]; then
    printf 'FAIL\tinv-file\tunsigned-inventory.txt 에서 같은 집계를 읽지 못했다: %s\n' "$inv"
  elif [ "$d_total" = "$i_total" ] && [ "$d_arm" = "$i_arm" ] && [ "$d_mixed" = "$i_mixed" ]; then
    printf 'OK\tinv-file\t전수 목록과 집계가 일치한다 (%s / %s / %s)\n' "$i_total" "$i_arm" "$i_mixed"
  else
    printf 'FAIL\tinv-file\t문서(%s/%s/%s) 와 전수 목록(%s/%s/%s) 의 집계가 다르다\n' \
      "${d_total:-?}" "${d_arm:-?}" "${d_mixed:-?}" "$i_total" "$i_arm" "$i_mixed"
  fi

  # arm64 와 다른 슬라이스를 **한 문서 안에서 구분**하고 있는가. 이 구분이
  # 없으면 Phase 4 가 "서명 없는 .so 10개"를 arm64 기준으로 잘못 읽는다.
  if grep -q 'arm64' "$doc" && grep -q 'x86_64\|다른 슬라이스\|타슬라이스' "$doc"; then
    printf 'OK\tinv-arch-split\t문서가 arm64 슬라이스와 다른 슬라이스를 구분해 적는다\n'
  else
    printf 'FAIL\tinv-arch-split\t문서가 슬라이스를 구분하지 않는다 — 10개가 arm64 기준으로 읽힌다\n'
  fi
}

# ---------------------------------------------------------------------------
# 본 검사
# ---------------------------------------------------------------------------
OUT=$(t8_evidence_path "t8-results-complete.txt")
RESULT=$(t8_scan "$RESULTS" "$INVENTORY")

echo "== RESULTS.md 완비 검사"
echo "   문서: $RESULTS"
echo "   전수 목록: $INVENTORY"
echo
printf '%s\n' "$RESULT" | while IFS=$'\t' read -r st id msg; do
  printf '  %-4s %-20s %s\n' "$st" "$id" "$msg"
done

FAILED=$(printf '%s\n' "$RESULT" | grep -c '^FAIL' || true)
case "$FAILED" in ''|*[!0-9]*) FAILED=0 ;; esac
TOTAL=$(printf '%s\n' "$RESULT" | grep -c '^' || true)
case "$TOTAL" in ''|*[!0-9]*) TOTAL=0 ;; esac

# ---------------------------------------------------------------------------
# 음성 대조 — 항목을 하나씩 지운 사본이 정말 FAIL 로 잡히는가.
#
# 지우는 방법은 "그 항목이 문서에서 빠졌을 때"를 흉내 낸다. 사본은 sandbox
# 아래에만 만든다 (gitignore 대상). 원본은 읽기만 한다.
# ---------------------------------------------------------------------------
mkdir -p "$WORK"
NEG_FAIL=0
NEG_LOG=""

# <이름> <기대 FAIL id> <sed 프로그램|@drop-section:N|@inv>
neg_case() {
  local name want how doc inv got
  name="$1"; want="$2"; how="$3"
  doc="$WORK/neg-$name.md"
  inv="$INVENTORY"
  case "$how" in
    @drop-section:*)
      awk -v n="${how#@drop-section:}" '
        $0 ~ "^## " n "\\." { on = 1; next }
        on && /^## / { on = 0 }
        !on { print }
      ' "$RESULTS" > "$doc" ;;
    @inv)
      # 문서의 전수 집계만 한 자리 틀어 둔다. 전수 목록 파일은 그대로다.
      sed 's/^| Mach-O 정규 파일 전체 | \([0-9]*\)개 |$/| Mach-O 정규 파일 전체 | 999개 |/' \
        "$RESULTS" > "$doc" ;;
    *)
      sed "$how" "$RESULTS" > "$doc" ;;
  esac
  got=$(t8_scan "$doc" "$inv" | awk -F'\t' -v w="$want" '$1=="FAIL" && $2==w {n++} END {print n+0}')
  if [ "$got" -ge 1 ]; then
    NEG_LOG="$NEG_LOG
  OK   $name -> $want 가 FAIL 로 잡힌다"
  else
    NEG_LOG="$NEG_LOG
  FAIL $name -> $want 가 FAIL 로 잡히지 않는다 (검사가 무조건 통과한다)"
    NEG_FAIL=$((NEG_FAIL + 1))
  fi
  rm -f "$doc"
}

neg_case "no-sign-fail-list" "sign-fail-list"   '/서명 실패 파일 목록/d'
neg_case "wrong-sign-count"  "sign-fail-evidence" 's/\*\*서명 실패\*\* | \*\*0개\*\*/**서명 실패** | **7개**/'
neg_case "no-ent-conclusion" "ent-conclusion"   '/결론: 필요한 entitlement 최소 집합/d'
neg_case "no-ent-matrix"     "ent-matrix"       '/^| escalate |/d'
neg_case "gk-placeholder"    "gk-block"         's|^측정: .*t8-quarantine.txt`$|(probe.sh quarantine 미실행)|'
neg_case "no-notarize"       "notarize-list"    '@drop-section:7'
neg_case "no-r12"            "r12-present"      's/R-12/R-XX/g'
neg_case "inv-mismatch"      "inv-file"         '@inv'

echo
echo "== 음성 대조 — 항목을 지운 사본이 FAIL 로 잡히는가"
printf '%s\n' "$NEG_LOG" | sed '/^$/d'

{
  echo "# Task 8 V5 — RESULTS.md 완비 검사"
  echo "# utc: $(t8_utc)"
  echo "# 문서: $RESULTS"
  echo "# 전수 목록: $INVENTORY"
  echo "# 서명 증거: $SIGN_EV"
  echo "#"
  echo "# 검사 ${TOTAL}개 중 FAIL ${FAILED}개 / 음성 대조 실패 ${NEG_FAIL}개"
  echo
  echo "## 항목별"
  printf '%s\n' "$RESULT"
  echo
  echo "## 음성 대조 (항목을 지운 사본을 같은 로직에 먹인다)"
  printf '%s\n' "$NEG_LOG" | sed '/^$/d'
} > "$OUT"

echo
echo "증거: $OUT"
echo "검사 ${TOTAL}개 중 FAIL ${FAILED}개, 음성 대조 실패 ${NEG_FAIL}개"
[ "$FAILED" -eq 0 ] || exit 1
[ "$NEG_FAIL" -eq 0 ] || exit 1
echo "RESULTS.md 에 서명 실패 목록·entitlement 결론·Gatekeeper 동작·공증 선결 조건·R-12 가 모두 있다"
exit 0
