#!/bin/bash
# 계획 Task 2 V5 — 55432의 _migrations 행 수가 마이그레이션 파일 수와 같은가.
#
# 확인하는 것은 두 가지다.
#   1. 번들 PostgreSQL이 be/src/database/migrations의 24개를 전량 받아냈다.
#   2. 그것이 **개발 DB가 아니라 실험 DB(55432)** 에 적용됐다. V4의
#      DATABASE_URL 주입이 be/.env의 5432 값을 이겼는지가 여기서 드러난다
#      (dotenv는 이미 설정된 process.env를 덮어쓰지 않는다).
#
# 2번을 위해 이 스크립트는 번들 psql로 **55432에** 직접 붙어서 센다. 개발
# 인스턴스에는 접속하지 않는다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t2-lib.sh"

FAIL=0
echo "== 서버 준비"
t2_require_server t2-migrations-start || { echo "  FAIL 서버를 띄우지 못했다"; exit 1; }

FILES=$(t2_migration_file_count)
echo
echo "== 파일과 행 수"
echo "  마이그레이션 파일 : $FILES 개 ($MIGRATIONS_DIR)"

EXISTS=$(t2_scalar "SELECT count(*) FROM pg_class WHERE relname='_migrations' AND relkind='r'")
if [ "$EXISTS" != "1" ]; then
  echo "  FAIL 55432의 damwha DB에 _migrations 테이블이 없다."
  echo "       V4를 먼저 돌린다: DATABASE_URL=postgresql://postgres@127.0.0.1:55432/damwha pnpm be:migrate"
  exit 1
fi
APPLIED=$(t2_migrations_applied)
echo "  _migrations 행    : $APPLIED 개 (127.0.0.1:$EXP_PG_PORT/damwha)"

if [ "$FILES" = "$APPLIED" ]; then
  echo "  OK   파일 수와 행 수가 같다"
else
  echo "  FAIL 파일 수와 행 수가 다르다"
  FAIL=1
fi
if [ "$FILES" = "24" ]; then
  echo "  OK   계획의 고정값 24와 같다"
else
  echo "  주의 마이그레이션 파일 수가 계획의 고정값(24)과 다르다: $FILES"
  echo "       파일이 늘었다면 계획의 고정값을 갱신해야 한다 — 여기서는 실패로 보지 않고"
  echo "       파일 수와 행 수의 일치만 판정한다."
fi

echo
echo "== 적용 대상이 실험 인스턴스인지"
PORT=$(t2_scalar "SHOW port")
DATADIR=$(t2_scalar "SHOW data_directory")
DBNAME=$(t2_scalar "SELECT current_database()")
echo "  port           : $PORT"
echo "  data_directory : $DATADIR"
echo "  database       : $DBNAME"
[ "$PORT" = "$EXP_PG_PORT" ] && echo "  OK   실험 포트다 (개발 5432가 아니다)" \
  || { echo "  FAIL 포트가 $EXP_PG_PORT 가 아니다"; FAIL=1; }
case "$DATADIR" in
  "$SANDBOX"/*) echo "  OK   데이터 디렉터리가 샌드박스 안이다" ;;
  *) echo "  FAIL 데이터 디렉터리가 샌드박스 밖이다: $DATADIR"; FAIL=1 ;;
esac

echo
echo "== 마이그레이션이 만든 스키마의 표본"
bash "$PG_PSQL" -c "SELECT name FROM _migrations ORDER BY name LIMIT 3" | sed 's/^/  /'
bash "$PG_PSQL" -c "SELECT count(*) AS tables FROM pg_tables WHERE schemaname='public'" | sed 's/^/  /'

echo
[ "$FAIL" -eq 0 ] && echo "판정: 실험 DB에 마이그레이션 전량이 적용돼 있다" \
                  || echo "판정: 조건을 만족하지 못했다"
exit $FAIL
