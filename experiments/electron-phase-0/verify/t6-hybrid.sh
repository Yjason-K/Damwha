#!/bin/bash
# 계획 Task 6 V3 — kw 단독 1건 이상 **그리고** sem 단독 1건 이상 **그리고**
# fused 1건 이상 (스펙 P0-C2의 성공 판정: "두 경로 각각이 0건이 아닌 결과를
# 반환하고, RRF 결합 결과가 반환된다").
#
# 셋을 다 요구하는 이유는 계획 Review에 그대로 적혀 있다 — 한쪽이 0건인데
# fused만 보고 통과시키지 않는다. fused는 FULL OUTER JOIN이라 한 arm이 통째로
# 비어도 행을 낸다. 그래서 여기서는 arm별 건수를 각각 세고, 그 위에 네 가지를
# 더 본다.
#
#   B. fused의 utterance 집합 = kw ∪ sem            (FULL OUTER JOIN 이 맞는가)
#   C. sem 상위 3건이 전부 예산·재무 발화다          (<=> 순위가 의미를 담는가)
#   D. 그중 최소 1건은 "예산" 글자가 **없는** 발화다  (LIKE로는 못 찾는 행이다)
#   E. kw 결과는 전부 "예산"을 담는다                 (likequery 가 맞는가)
#   F. cand_k를 좁힌 재실행에서 kw에만 있는 행과 sem에만 있는 행이 **각각** 있다
#      (FULL OUTER JOIN 양방향. 기본 cand_k=100 에서는 sem 이 시드 전량을
#       가져가 kw ⊂ sem 이 되어 한쪽 방향만 확인된다)
#   G. fused 점수가 RRF 정의와 일치한다              (COALESCE(1/(k+rnk),0) 합)
#
# C·D의 근거 데이터는 $EVIDENCE/t6-seed.txt 의 group 열이다. 그 파일이 이번
# 회차의 것인지는 t6-lib.sh의 t6_seed_present() 가 DB와 대조해 확인한다.
#
# 이 스크립트는 클라이언트다 — 격리 대상이 아니다 (스펙 §4.0).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t6-lib.sh"

FAIL=0
OUT=$(t6_evidence_path "t6-hybrid.txt")
WORK="$SANDBOX/state"
mkdir -p "$WORK"
FULL="$WORK/t6-query-candk$T6_CAND_K.tsv"
NARROW="$WORK/t6-query-candk3.tsv"

echo "== 서비스 준비"
t6_require_services || { echo "  FAIL 서비스를 띄우지 못했다"; exit 1; }
t6_require_seed     || { echo "  FAIL 시드를 만들지 못했다"; exit 1; }
MID=$(t6_meeting_id)

echo
echo "== 질의 벡터 (embed 서비스가 만든다 — 손으로 만든 벡터가 아니다)"
QVEC=$(t6_qvec_file "$T6_QUERY") || { echo "  FAIL 질의 벡터를 얻지 못했다"; exit 1; }
echo "  질의 : '$T6_QUERY'"
echo "  벡터 : $QVEC ($(wc -c < "$QVEC" | tr -d ' ') 바이트, 앞 60자: $(cut -c1-60 "$QVEC"))"

echo
echo "== 하이브리드 쿼리 (drivers/query_search.sql, cand_k=$T6_CAND_K rrf_k=$T6_RRF_K limit+1=$T6_LIMIT_PLUS1)"
t6_run_query "$QVEC" "$T6_CAND_K" > "$FULL"
if grep -q '^ERROR' "$FULL" || grep -q '^psql:' "$FULL"; then
  echo "  FAIL 쿼리가 오류로 끝났다:"
  sed 's/^/       /' "$FULL"
  exit 1
fi

KW_N=$(t6_arm_count kw     < "$FULL")
SEM_N=$(t6_arm_count sem   < "$FULL")
FUSED_N=$(t6_arm_count fused < "$FULL")
echo "  kw    : $KW_N 건"
echo "  sem   : $SEM_N 건"
echo "  fused : $FUSED_N 건"

for pair in "kw:$KW_N" "sem:$SEM_N" "fused:$FUSED_N"; do
  arm=${pair%%:*}; n=${pair##*:}
  if [ "$n" -ge 1 ]; then
    echo "  OK   $arm 이 1건 이상이다 ($n)"
  else
    echo "  FAIL $arm 이 0건이다"
    FAIL=1
  fi
done

echo
echo "== E. kw 결과가 전부 '$T6_QUERY' 을 담는가 (likequery)"
KW_BAD=$(t6_arm_rows kw < "$FULL" | awk -F"$TAB" -v q="$T6_QUERY" 'index($6, q) == 0 { n++ } END { print n + 0 }')
KW_ALL=$(t6_scalar "SELECT count(*) FROM utterance
                    WHERE meeting_id = '$MID' AND status='ok' AND position('$T6_QUERY' in text) > 0")
if [ "$KW_BAD" = "0" ]; then
  echo "  OK   kw 결과 $KW_N 건이 모두 '$T6_QUERY' 을 담는다"
else
  echo "  FAIL '$T6_QUERY' 을 담지 않는 kw 행이 ${KW_BAD}건 있다"
  FAIL=1
fi
if [ "$KW_N" = "$KW_ALL" ]; then
  echo "  OK   시드 안에서 '$T6_QUERY' 을 담은 발화 $KW_ALL 건을 빠짐없이 찾았다"
else
  echo "  FAIL 담은 발화는 $KW_ALL 건인데 kw는 $KW_N 건이다"
  FAIL=1
fi

echo
echo "== C·D. sem 상위 3건 (의미 경로가 실제로 순위를 만드는가)"
SEM_TOP3=$(t6_arm_rows sem < "$FULL" | sort -t"$TAB" -k2,2n | head -n 3)
TOP3_OFF=0
TOP3_SEMONLY=0
# 판정 줄을 변수에 모은다 — stdout 과 증거 파일 **양쪽**에 같은 내용이 가게.
# 판정이 stdout 에만 남으면 증거 파일만 읽는 사람에게는 검사가 없는 것과 같다.
CD_REPORT="$(printf '%s\n' "$SEM_TOP3" | awk -F"$TAB" '{ printf "  %s위 %s  %s\n", $2, $4, $6 }')
"
cd_say() { CD_REPORT="$CD_REPORT$1
"; }
# 필드를 IFS=<TAB> 로 read 하지 않는다. 탭은 IFS **공백 문자**라 연속된 탭이
# 하나로 뭉개지고, score 가 빈 칸인 kw/sem 행에서 열이 통째로 밀린다.
for uid in $(printf '%s\n' "$SEM_TOP3" | awk -F"$TAB" 'NF >= 4 { print $4 }'); do
  g=$(t6_map_group_of "$uid")
  cd_say "     $uid -> group=${g:-<시드 목록에 없음>}"
  case "$g" in
    off|"") TOP3_OFF=$((TOP3_OFF + 1)) ;;
    sem)    TOP3_SEMONLY=$((TOP3_SEMONLY + 1)) ;;
  esac
done
if [ "$TOP3_OFF" -eq 0 ]; then
  cd_say "  OK   상위 3건에 주제가 다른(off) 발화가 없다"
else
  cd_say "  FAIL 상위 3건에 주제가 다른 발화가 ${TOP3_OFF}건 있다 — 거리 순위가 의미를 담지 않는다"
  FAIL=1
fi
if [ "$TOP3_SEMONLY" -ge 1 ]; then
  cd_say "  OK   상위 3건에 '$T6_QUERY' 글자가 없는 발화가 ${TOP3_SEMONLY}건 있다"
  cd_say "       — LIKE likequery() 로는 절대 찾을 수 없는 행을 <=> 가 찾았다"
else
  cd_say "  FAIL 상위 3건이 전부 '$T6_QUERY' 을 글자로 담은 발화다 — sem 이 kw 를 되풀이한 것과 구분되지 않는다"
  FAIL=1
fi
printf '%s' "$CD_REPORT"

echo
echo "== B·G. FULL OUTER JOIN 과 RRF"
CHECK=$("$SYSPY" - "$FULL" "$T6_RRF_K" <<'PY'
import sys

path, rrf_k = sys.argv[1], int(sys.argv[2])
kw, sem, fused = {}, {}, {}
for line in open(path, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    if len(f) < 6:
        continue
    arm, rnk, score, uid = f[0], f[1], f[2], f[3]
    if arm == "kw":
        kw[uid] = int(rnk)
    elif arm == "sem":
        sem[uid] = int(rnk)
    elif arm == "fused":
        fused[uid] = float(score)

fail = 0
union = set(kw) | set(sem)
if set(fused) == union:
    print("  OK   fused 집합 = kw ∪ sem (%d = %d ∪ %d)" % (len(fused), len(kw), len(sem)))
else:
    fail = 1
    print("  FAIL fused 집합이 kw ∪ sem 과 다르다")
    print("       fused만: %s" % sorted(set(fused) - union))
    print("       union만: %s" % sorted(union - set(fused)))

bad = []
for uid, got in fused.items():
    want = 0.0
    if uid in kw:
        want += 1.0 / (rrf_k + kw[uid])
    if uid in sem:
        want += 1.0 / (rrf_k + sem[uid])
    if abs(got - want) > 1e-9:
        bad.append((uid, got, want))
if bad:
    fail = 1
    print("  FAIL RRF 점수가 정의와 다른 행이 %d건 있다" % len(bad))
    for uid, got, want in bad[:5]:
        print("       %s got=%r want=%r" % (uid, got, want))
else:
    print("  OK   fused 점수 %d건이 전부 COALESCE(1/(%d+kw.rnk),0)+COALESCE(1/(%d+sem.rnk),0) 와 같다"
          % (len(fused), rrf_k, rrf_k))

both = len(set(kw) & set(sem))
print("  참고 두 arm 모두: %d건 / kw 에만: %d건 / sem 에만: %d건"
      % (both, len(set(kw) - set(sem)), len(set(sem) - set(kw))))
raise SystemExit(fail)
PY
)
RC=$?
printf '%s\n' "$CHECK"
[ "$RC" -eq 0 ] || FAIL=1

echo
echo "== F. cand_k=3 재실행 — FULL OUTER JOIN 의 양방향"
echo "  기본 cand_k=$T6_CAND_K 에서는 sem 이 시드 전량을 가져가 kw ⊂ sem 이 된다."
echo "  후보를 3으로 좁히면 kw 에만 있는 행과 sem 에만 있는 행이 함께 생긴다."
t6_run_query "$QVEC" 3 > "$NARROW"
NCHECK=$("$SYSPY" - "$NARROW" "$T6_RRF_K" <<'PY'
import sys

path, rrf_k = sys.argv[1], int(sys.argv[2])
kw, sem, fused = {}, {}, {}
for line in open(path, encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    if len(f) < 6:
        continue
    arm, rnk, score, uid = f[0], f[1], f[2], f[3]
    if arm == "kw":
        kw[uid] = int(rnk)
    elif arm == "sem":
        sem[uid] = int(rnk)
    elif arm == "fused":
        fused[uid] = float(score)

kw_only = sorted(set(kw) - set(sem))
sem_only = sorted(set(sem) - set(kw))
both = sorted(set(kw) & set(sem))
fail = 0
print("  kw=%d sem=%d fused=%d  (kw에만 %d / sem에만 %d / 둘 다 %d)"
      % (len(kw), len(sem), len(fused), len(kw_only), len(sem_only), len(both)))
for name, ids in (("kw 에만 있는 행", kw_only), ("sem 에만 있는 행", sem_only)):
    if ids:
        print("  OK   %s이 있다: %s" % (name, ids))
    else:
        fail = 1
        print("  FAIL %s이 없다 — FULL OUTER JOIN 의 한쪽 방향이 확인되지 않는다" % name)
if set(fused) == set(kw) | set(sem):
    print("  OK   fused 집합 = kw ∪ sem (%d)" % len(fused))
else:
    fail = 1
    print("  FAIL fused 집합이 kw ∪ sem 과 다르다")
for uid in kw_only:
    want = 1.0 / (rrf_k + kw[uid])
    if abs(fused.get(uid, -1) - want) > 1e-9:
        fail = 1
        print("  FAIL kw 에만 있는 %s 의 점수가 1/(%d+%d) 가 아니다: %r"
              % (uid, rrf_k, kw[uid], fused.get(uid)))
raise SystemExit(fail)
PY
)
RC=$?
printf '%s\n' "$NCHECK"
[ "$RC" -eq 0 ] || FAIL=1

{
  echo "# Task 6 V3 — 하이브리드 검색 (스펙 P0-C2)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 격리: 클라이언트라 격리 대상이 아니다 (스펙 §4.0). 접속 대상은"
  echo "#       127.0.0.1:$EXP_PG_PORT (번들 PostgreSQL) 와"
  echo "#       $EMBED_BASE (번들 bge-m3) 다."
  echo "# 쿼리: experiments/electron-phase-0/drivers/query_search.sql"
  echo "#       be/src/search/search.repository.ts::hybrid() 의 CTE 구조 그대로"
  echo "# meeting_id: $MID"
  echo "# 질의: '$T6_QUERY'   질의 벡터: embed 서비스 $EMBED_BASE/embed 산출"
  echo "# 파라미터: cand_k=$T6_CAND_K rrf_k=$T6_RRF_K dim=$T6_DIM model=$T6_MODEL limit+1=$T6_LIMIT_PLUS1 ef_search=$T6_EF_SEARCH"
  echo "#"
  echo "# arm 별 건수: kw=$KW_N  sem=$SEM_N  fused=$FUSED_N"
  echo "# ('$T6_QUERY' 을 담은 시드 발화: $KW_ALL 건)"
  echo
  echo "## 판정"
  echo "# C·D — sem 상위 3건이 의미를 담는가 (group 은 t6-seed.txt 의 열)"
  printf '%s' "$CD_REPORT"
  echo "# E — kw 결과가 전부 '$T6_QUERY' 을 담는가: 어긋난 행 $KW_BAD 건 / 담은 시드 $KW_ALL 건"
  echo "# B·G — FULL OUTER JOIN 과 RRF (cand_k=$T6_CAND_K)"
  printf '%s\n' "$CHECK"
  echo "# F — cand_k=3 재실행"
  printf '%s\n' "$NCHECK"
  echo
  echo "## 쿼리 결과 (cand_k=$T6_CAND_K)"
  echo "# arm<TAB>rnk<TAB>score<TAB>utterance_id<TAB>meeting_id<TAB>text"
  cat "$FULL"
  echo
  echo "## 쿼리 결과 (cand_k=3 — FULL OUTER JOIN 양방향 확인용)"
  cat "$NARROW"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 못했다"; exit 1; }
echo "판정: kw $KW_N 건 / sem $SEM_N 건 / fused $FUSED_N 건 — 두 경로가 각각 결과를 냈다"
exit 0
