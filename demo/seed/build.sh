#!/usr/bin/env bash
# 로컬(호스트 Mac)에서 처리가 끝난 DB를 공개 데모 시드로 굽는다 — 설계 §6.5.
#   demo/seed/build.sh            # DATABASE_URL 기본값: be/.env의 로컬 Postgres
# 산출물: damwha-demo.dump(pg_dump -Fc), manifest.json, storage/meetings/<id>/normalized.flac
# 원본 m4a는 demo/audio/에 있으므로 여기 다시 넣지 않는다(restore.sh가 manifest로 매핑).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/damwha}"
STORAGE_ROOT="${STORAGE_ROOT:-$ROOT/be/storage}"


# pg 클라이언트: 호스트에 있으면 그걸, 없으면 로컬 컴포즈 컨테이너 안의 것을 쓴다.
# 배포 서버에서는 PG_EXEC="docker exec -i <container>" 로 지정할 수 있다.
if [ -n "${PG_EXEC:-}" ]; then pg() { $PG_EXEC "$@"; }
elif command -v pg_dump >/dev/null 2>&1; then pg() { "$@"; }
else pg() { docker exec -i damwha-postgres "$@"; }
fi

echo "→ manifest"
pg psql "$DATABASE_URL" -Atc "
  select json_agg(json_build_object(
    'id', id, 'title', title, 'original_filename', original_filename,
    'audio_key', audio_key, 'normalized_key', normalized_key) order by id)
  from meeting" > "$HERE/manifest.json"
python3 -c "import json,sys; json.dump(json.load(open(sys.argv[1])), open(sys.argv[1],'w'), ensure_ascii=False, indent=2)" "$HERE/manifest.json"

echo "→ pg_dump"
pg pg_dump "$DATABASE_URL" -Fc --no-owner --no-acl > "$HERE/damwha-demo.dump"

echo "→ normalized audio"
rm -rf "$HERE/storage"
python3 - "$HERE/manifest.json" <<'PY' | while IFS=$'\t' read -r id key; do
import json, sys
for m in json.load(open(sys.argv[1])):
    print(f"{m['id']}\t{m['normalized_key']}")
PY
  mkdir -p "$HERE/storage/$(dirname "$key")"
  cp "$STORAGE_ROOT/$key" "$HERE/storage/$key"
  # 원본 m4a가 demo/audio/에 있는지 확인 — 없으면 restore가 실패한다
  "$HERE/find-original.py" "$HERE/manifest.json" "$id" "$ROOT/demo/audio" >/dev/null
done

echo "done:"; du -sh "$HERE/damwha-demo.dump" "$HERE/storage"
