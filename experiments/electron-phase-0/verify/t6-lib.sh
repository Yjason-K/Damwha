# Task 6 verify 스크립트가 공유하는 헬퍼.
#
# t2-lib.sh / t5-lib.sh와 같은 이유로 한 군데 모았다 — 세 스크립트가 같은 것
# (DB·embed 기동 보장, 시드 보장, 질의 벡터 생성, 쿼리 실행)을 필요로 하는데
# 각자 복사해 두면 한 곳만 느슨해져도 나머지가 멀쩡해 보인다.
#
# 여기에는 판정이 없다. 판정은 각 t6-*.sh가 자기 조건으로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
PG_RUN="$EXP_ROOT/pg/run.sh"
PG_PSQL="$EXP_ROOT/pg/psql.sh"
EMBED_SH="$EXP_ROOT/services/embed.sh"
BUNDLE_PY="$EXP_ROOT/bundle/python/bin/python3"
SEED_PY="$EXP_ROOT/drivers/seed_search.py"
QUERY_SQL="$EXP_ROOT/drivers/query_search.sql"

EMBED_BASE="http://127.0.0.1:$EXP_EMBED_PORT"

# 검사 도구다 — 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0).
CURL=/usr/bin/curl
SYSPY=/usr/bin/python3

TAB=$'\t'

# --- 제품의 파라미터 값 (be/.env, search.service.ts) -------------------------
# search.service.ts:94-96  limit=20 -> candK = max(SEARCH_CANDIDATE_K, limit*5)
# search.service.ts:120    ef_search = max(candK, 40)
# be/.env:20-21            SEARCH_RRF_K=60  SEARCH_CANDIDATE_K=100
# be/.env:15-16            SEARCH_EMBEDDING_MODEL / DIM
T6_QUERY="예산"
T6_MODEL="BAAI/bge-m3"
T6_DIM=1024
T6_LIMIT=20
T6_CAND_K=100
T6_RRF_K=60
T6_LIMIT_PLUS1=21
T6_EF_SEARCH=100

MEETING_ID_FILE="$EVIDENCE/t6-meeting-id.txt"
SEED_MAP_FILE="$EVIDENCE/t6-seed.txt"

# --- 증거 회전 (스펙 §6) -----------------------------------------------------
# `> "$OUT"` 으로 덮어쓰지 않는다. 같은 이름이 있으면 옆으로 돌린다.
t6_evidence_path() {
  local name f
  name="$1"
  f="$EVIDENCE/$name"
  mkdir -p "$EVIDENCE"
  if [ -f "$f" ]; then
    mv "$f" "${f%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  fi
  echo "$f"
}

# --- 서비스 수명 ------------------------------------------------------------
# 떠 있지 않으면 **격리 래퍼를 통해** 띄운다 (스펙 §4.2). 이미 떠 있으면 그대로
# 둔다 — 두 런처 모두 PID 파일로 멱등하지만 불필요한 증거 회전을 만들지 않는다.
t6_require_db() {
  if exp_pid_alive pg; then
    echo "  db: 살아 있음 (pid $(cat "$(exp_pid_file pg)"))"
    return 0
  fi
  echo "  db가 떠 있지 않다 — run-isolated.sh --label t6-pg-start 로 기동한다"
  bash "$RUN_ISO" --label t6-pg-start -- "$PG_RUN" start || return 1
  exp_pid_alive pg || return 1
  echo "  db: 기동됨 (pid $(cat "$(exp_pid_file pg)"))"
}

t6_require_embed() {
  if exp_pid_alive embed; then
    echo "  embed: 살아 있음 (pid $(cat "$(exp_pid_file embed)"))"
    return 0
  fi
  echo "  embed가 떠 있지 않다 — run-isolated.sh --label t6-embed-start 로 기동한다"
  bash "$RUN_ISO" --label t6-embed-start -- "$EMBED_SH" start || return 1
  exp_pid_alive embed || return 1
  echo "  embed: 기동됨 (pid $(cat "$(exp_pid_file embed)"))"
}

t6_require_services() {
  t6_require_db || return 1
  t6_require_embed || return 1
  return 0
}

# --- psql --------------------------------------------------------------------
# psql 변수 보간은 -c 에서 일어나지 않는다(단일 질의 모드). 변수를 쓰는 SQL은
# 전부 stdin(-f -)으로 넣는다.
# -A(정렬 없음)라 패딩이 없다. t2_scalar 처럼 `tr -d ' '` 를 붙이지 않는다 —
# likequery('50% 절감') 같은 **값 안의 공백**까지 지워져 증거가 사실과 달라진다.
t6_scalar() {
  bash "$PG_PSQL" -q -t -A -c "$1" 2>/dev/null | head -n 1
}

t6_tsv_stdin() {
  bash "$PG_PSQL" -q -t -A -F "$TAB" "$@" -f - 2>&1
}

# --- 시드 --------------------------------------------------------------------
t6_meeting_id() {
  [ -f "$MEETING_ID_FILE" ] || return 1
  local id
  id=$(head -n 1 "$MEETING_ID_FILE" | tr -d '[:space:]')
  [ -n "$id" ] || return 1
  echo "$id"
}

# $EVIDENCE/t6-seed.txt 의 `## rows` 이후 줄: order_index<TAB>group<TAB>id<TAB>text
t6_map_rows() {
  [ -f "$SEED_MAP_FILE" ] || return 1
  awk '/^## rows$/ { on = 1; next } on && !/^#/ && NF > 0' "$SEED_MAP_FILE"
}

t6_map_ids_of_group() {
  t6_map_rows | awk -F"$TAB" -v g="$1" '$2 == g { print $3 }'
}

t6_map_group_of() {
  t6_map_rows | awk -F"$TAB" -v i="$1" '$3 == i { print $2 }'
}

t6_map_count() { t6_map_rows | wc -l | tr -d ' '; }

# 시드가 이 DB 안에 실제로 있는가. 증거 파일이 아니라 **DB 를 기준으로** 본다 —
# 증거만 보면 지난 회차의 파일이 남아 있는 빈 DB도 통과한다.
t6_seed_present() {
  local mid n map
  mid=$(t6_meeting_id) || return 1
  map=$(t6_map_count) || return 1
  [ "$map" -gt 0 ] || return 1
  n=$(t6_scalar "SELECT count(*) FROM utterance u JOIN meeting m ON m.id = u.meeting_id
                 WHERE m.id = '$mid' AND m.status = 'done' AND u.status = 'ok'")
  [ "$n" = "$map" ]
}

# 시드가 없으면 계획 V1 과 같은 형태로 만든다.
t6_require_seed() {
  if t6_seed_present; then
    echo "  시드: 있음 (meeting $(t6_meeting_id), 발화 $(t6_map_count)건)"
    return 0
  fi
  echo "  시드가 없다 — run-isolated.sh --label t6-seed 로 만든다 (계획 V1과 같은 형태)"
  bash "$RUN_ISO" --label t6-seed -- "$BUNDLE_PY" "$SEED_PY" || return 1
  t6_seed_present || return 1
  echo "  시드: 생성됨 (meeting $(t6_meeting_id), 발화 $(t6_map_count)건)"
}

# --- 질의 벡터 ---------------------------------------------------------------
# **embed 서비스가 만든다.** 손으로 만든 난수·상수 벡터를 쓰지 않는다
# (계획 Task 6 Interfaces). 제품도 검색 시점에 질의를 임베딩한다
# (search.service.ts:107 `await this.embed.embed(q)`).
t6_qvec_file() {
  local text out
  text="$1"
  out="$SANDBOX/state/t6-qvec.txt"
  mkdir -p "$SANDBOX/state"
  "$CURL" -fsS --max-time 120 -H 'Content-Type: application/json' \
      -d "$("$SYSPY" -c 'import json,sys; print(json.dumps({"texts":[sys.argv[1]]}))' "$text")" \
      "$EMBED_BASE/embed" \
    | "$SYSPY" -c '
import json, sys
d = json.load(sys.stdin)
v = (d.get("vectors") or [None])[0]
model = d.get("model")
dim = d.get("dimension")
got = len(v) if v is not None else None
if model != "BAAI/bge-m3" or dim != 1024 or got != 1024:
    sys.exit("embed 응답이 model=BAAI/bge-m3 / dimension=1024 / 길이 1024 가 아니다: "
             "model=%r dim=%r len=%r" % (model, dim, got))
sys.stdout.write("[" + ",".join(repr(float(x)) for x in v) + "]")
' > "$out" || return 1
  [ -s "$out" ] || return 1
  echo "$out"
}

# --- 하이브리드 쿼리 실행 -----------------------------------------------------
# <질의 벡터 파일> <cand_k> — drivers/query_search.sql 을 제품과 같은 파라미터로
# 돌린다. 출력은 arm<TAB>rnk<TAB>score<TAB>utterance_id<TAB>meeting_id<TAB>text.
t6_run_query() {
  local qvec_file cand_k ef
  qvec_file="$1"
  cand_k="$2"
  ef="$cand_k"
  [ "$ef" -ge 40 ] || ef=40   # search.service.ts:120 Math.max(candK, 40)
  bash "$PG_PSQL" -q -t -A -F "$TAB" \
    -v q="$T6_QUERY" \
    -v cand_k="$cand_k" \
    -v qvec="$(cat "$qvec_file")" \
    -v model="$T6_MODEL" \
    -v dim="$T6_DIM" \
    -v rrf_k="$T6_RRF_K" \
    -v limit_plus1="$T6_LIMIT_PLUS1" \
    -v ef_search="$ef" \
    -v date_from=NULL -v date_to=NULL -v speaker_ids=NULL -v meeting_ids=NULL \
    -f "$QUERY_SQL" 2>&1
}

t6_arm_rows()  { awk -F"$TAB" -v a="$1" '$1 == a' ; }
t6_arm_ids()   { awk -F"$TAB" -v a="$1" '$1 == a { print $4 }' ; }
t6_arm_count() { awk -F"$TAB" -v a="$1" '$1 == a { n++ } END { print n + 0 }' ; }
