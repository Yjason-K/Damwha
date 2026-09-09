#!/bin/bash
# 번들 psql을 실험 DB(127.0.0.1:55432/damwha)에 붙이는 얇은 래퍼.
#
#   psql.sh -c "select 1"
#   PGDATABASE_OVERRIDE=postgres psql.sh -c "..."   다른 DB에 붙을 때
#
# **격리 대상이 아니다** (스펙 §4.0): 서버에 접속하는 클라이언트는 G2를 지나지
# 않는다. 다만 psql 자체는 **번들 바이너리**이므로, 이것이 도는 것 자체가
# 재배치 후 libpq 로드가 살아 있다는 확인이기도 하다.
#
# 접속 대상이 개발 인스턴스(5432)가 아니라 실험 인스턴스(55432)라는 것은
# 포트로 구분된다 — 포트는 lib/config.sh의 EXP_PG_PORT 하나에서만 온다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

PSQL="$EXP_ROOT/bundle/pg/bin/psql"
[ -x "$PSQL" ] || exp_die "번들 psql이 없다: $PSQL — pg/build.sh 를 먼저 돌린다"

exec "$PSQL" \
  -h 127.0.0.1 -p "$EXP_PG_PORT" -U postgres \
  -d "${PGDATABASE_OVERRIDE:-damwha}" \
  -v ON_ERROR_STOP=1 \
  "$@"
