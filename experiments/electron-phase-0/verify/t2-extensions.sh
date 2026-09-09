#!/bin/bash
# 계획 Task 2 V3 — 번들에서 pgvector와 pg_bigm이 실제로 살아 있는가.
#
# pg_extension에 행이 있는 것만으로는 부족하다. .control 파일만 있어도
# CREATE EXTENSION은 실패하지 않는 함수가 있고(순수 SQL 확장), 우리가 확인해야
# 하는 것은 **번들 안의 .dylib가 로드되어 동작하는가**다. 그래서 셋을 본다.
#
#   1. pg_extension의 행과 버전 (pg_bigm은 1.2 — Dockerfile과 같은 계열)
#   2. 두 확장의 함수·연산자를 실제로 실행한다 (vector의 <=> 와 pg_bigm의
#      bigm_similarity / likequery). 실행되면 백엔드가 .dylib를 dlopen한다.
#   3. 그 dlopen이 남긴 dyld 줄을 서버 로그에서 꺼내 증거로 옮기고, 경로가
#      **번들 안**인지 본다 (계획 규칙 3b: 백엔드의 stderr는 logging_collector를
#      거쳐 서버 로그로 가므로 t2-start-dyld.txt에는 남지 않는다).
#
# 3번의 pid는 postmaster의 pid로 찍힌다 — dyld가 프로세스 시작 시점에 만든
# 접두사를 fork된 백엔드가 그대로 물려받기 때문이다. 그래서 pg.pid와 대조할 수
# 있다 (계획 규칙 4·6b).

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
OUT="$EVIDENCE/t2-extension-load-dyld.txt"

echo "== 서버 준비"
t2_require_server t2-extensions-start || { echo "  FAIL 서버를 띄우지 못했다"; exit 1; }
PID=$(t2_server_pid)

echo
echo "== 1. CREATE EXTENSION (멱등)"
bash "$PG_PSQL" -q -c "CREATE EXTENSION IF NOT EXISTS vector" \
                -c "CREATE EXTENSION IF NOT EXISTS pg_bigm" \
  || { echo "  FAIL CREATE EXTENSION 실패"; exit 1; }
bash "$PG_PSQL" -c "SELECT extname, extversion FROM pg_extension ORDER BY 1" | sed 's/^/  /'

VECV=$(t2_scalar "SELECT extversion FROM pg_extension WHERE extname='vector'")
BIGMV=$(t2_scalar "SELECT extversion FROM pg_extension WHERE extname='pg_bigm'")
[ -n "$VECV" ]  && echo "  OK   vector $VECV"  || { echo "  FAIL vector가 없다"; FAIL=1; }
if [ "$BIGMV" = "1.2" ]; then
  echo "  OK   pg_bigm $BIGMV (be/docker/postgres-bigm/Dockerfile의 1.2-20240606과 같은 계열)"
else
  echo "  FAIL pg_bigm 버전이 1.2가 아니다: '${BIGMV:-없음}'"
  FAIL=1
fi

echo
echo "== 2. 확장 코드 실행 (.dylib가 실제로 로드되는 경로)"
# 새 psql = 새 백엔드다. 여기서 dlopen이 일어난다.
DIST=$(t2_scalar "SELECT round(('[1,0,0]'::vector <=> '[0,1,0]'::vector)::numeric, 3)")
if [ "$DIST" = "1.000" ]; then
  echo "  OK   pgvector: '[1,0,0]' <=> '[0,1,0]' = $DIST (코사인 거리 연산자 동작)"
else
  echo "  FAIL pgvector 연산자가 기대값을 내지 않았다: '${DIST:-없음}'"
  FAIL=1
fi
SIM=$(t2_scalar "SELECT round(bigm_similarity('담화 회의록','담화 회의')::numeric, 3)")
LQ=$(t2_scalar "SELECT likequery('회의')")
if [ -n "$SIM" ] && [ -n "$LQ" ]; then
  echo "  OK   pg_bigm: bigm_similarity=$SIM  likequery('회의')=$LQ"
else
  echo "  FAIL pg_bigm 함수가 동작하지 않는다"
  FAIL=1
fi
# be/src/search/search.repository.ts가 쓰는 두 인덱스 접근 경로가 실재하는지.
GIN=$(t2_scalar "SELECT count(*) FROM pg_opclass WHERE opcname='gin_bigm_ops'")
HNSW=$(t2_scalar "SELECT count(*) FROM pg_am WHERE amname='hnsw'")
[ "$GIN" = "1" ]  && echo "  OK   gin_bigm_ops 연산자 클래스가 있다" || { echo "  FAIL gin_bigm_ops가 없다"; FAIL=1; }
[ "$HNSW" = "1" ] && echo "  OK   hnsw 접근 방법이 있다"           || { echo "  FAIL hnsw가 없다"; FAIL=1; }

echo
echo "== 3. 확장 로드의 dyld 실측 (규칙 3b — 서버 로그에서 꺼낸다)"
LOGS=$(t2_server_logs)
if [ -z "$LOGS" ]; then
  echo "  FAIL 서버 로그가 없다: $PGDATA/log/"
  exit 1
fi
{
  echo "# Task 2 — 확장 dlopen의 dyld 실측"
  echo "# 백엔드의 stderr는 logging_collector를 거쳐 서버 로그로 가므로"
  echo "# t2-start-dyld.txt에는 남지 않는다 (계획 규칙 3b). 여기로 옮긴다."
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')   pg.pid: $PID"
  echo "# 원본: $PGDATA/log/*.txt"
  echo "# dyld[<pid>]의 pid는 postmaster의 것으로 찍힌다 — fork된 백엔드가"
  echo "# 프로세스 시작 시점에 만들어진 접두사를 그대로 물려받기 때문이다."
  grep -h '^dyld\[' $LOGS 2>/dev/null | sort -u
} | exp_scrub > "$OUT"
echo "  증거: $OUT"
grep '^dyld\[' "$OUT" | sed 's/^/    /'

for lib in vector.dylib pg_bigm.dylib; do
  if awk -v b="$BUNDLE_PG/lib/postgresql/$lib" '/^dyld\[/ && $NF == b { n++ } END { exit !(n>0) }' "$OUT"; then
    echo "  OK   $lib 를 번들 경로에서 로드했다"
  else
    echo "  FAIL $lib 의 로드 줄이 번들 경로로 남아 있지 않다"
    FAIL=1
  fi
done
# 번들 밖에서 확장을 끌어온 흔적이 없어야 한다.
if grep '^dyld\[' "$OUT" | grep -q -v -F "$BUNDLE_PG/"; then
  echo "  FAIL 번들 밖 경로의 로드 줄이 있다:"
  grep '^dyld\[' "$OUT" | grep -v -F "$BUNDLE_PG/" | sed 's/^/       /'
  FAIL=1
else
  echo "  OK   확장 로드 경로가 전부 번들 안이다"
fi

echo
[ "$FAIL" -eq 0 ] && echo "판정: 번들의 pgvector·pg_bigm이 로드되고 동작한다" \
                  || echo "판정: 조건을 만족하지 못했다"
exit $FAIL
