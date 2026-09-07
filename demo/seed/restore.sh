#!/usr/bin/env bash
# 공개 데모 DB와 스토리지를 시드로 채운다 — 설계 §6.5.
#   DATABASE_URL=postgres://... STORAGE_ROOT=/var/lib/damwha/storage demo/seed/restore.sh
# 대상 DB는 damwha/postgres-bigm 이미지(pgvector + pg_bigm)로 만든 빈 DB여야 한다.
# 마이그레이션은 돌리지 않는다 — 덤프에 스키마와 _migrations가 들어 있다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${DATABASE_URL:?set DATABASE_URL}"
: "${STORAGE_ROOT:?set STORAGE_ROOT}"

# pg 클라이언트: 호스트에 있으면 그걸, 없으면 로컬 컴포즈 컨테이너 안의 것을 쓴다.
# 배포 서버에서는 PG_EXEC="docker exec -i <container>" 로 지정할 수 있다.
if [ -n "${PG_EXEC:-}" ]; then pg() { $PG_EXEC "$@"; }
elif command -v pg_restore >/dev/null 2>&1; then pg() { "$@"; }
else pg() { docker exec -i damwha-postgres "$@"; }
fi

echo "→ pg_restore"
pg pg_restore --clean --if-exists --no-owner --no-acl --dbname "$DATABASE_URL" < "$HERE/damwha-demo.dump"

echo "→ storage"
python3 - "$HERE/manifest.json" <<'PY' | while IFS=$'\t' read -r id audio_key normalized_key; do
import json, sys
for m in json.load(open(sys.argv[1])):
    print(f"{m['id']}\t{m['audio_key']}\t{m['normalized_key']}")
PY
  mkdir -p "$STORAGE_ROOT/$(dirname "$audio_key")"
  cp "$HERE/storage/$normalized_key" "$STORAGE_ROOT/$normalized_key"
  cp "$("$HERE/find-original.py" "$HERE/manifest.json" "$id" "$ROOT/demo/audio")" "$STORAGE_ROOT/$audio_key"
done

echo "done: $(pg psql "$DATABASE_URL" -Atc 'select count(*) from meeting') meetings"
