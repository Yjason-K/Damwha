#!/usr/bin/env bash
# Build and push the public-demo images (linux/arm64 — the home server).
#   deploy/demo/release.sh            # tag = today (YYYYMMDD) + latest
#   deploy/demo/release.sh 20260902   # explicit tag
#   PUSH=0 deploy/demo/release.sh     # build + load locally only (for compose smoke test)
# Separate image names from the team-trial release (damwha-api / damwha-postgres),
# so nothing here touches those tags.
set -euo pipefail
TAG="${1:-$(date +%Y%m%d)}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY=ghcr.io/yjason-k
PLATFORM=linux/arm64
PUSH="${PUSH:-1}"
# 링크 미리보기(og:image)의 절대 URL. 예: DEMO_PUBLIC_URL=https://demo.example.com
DEMO_PUBLIC_URL="${DEMO_PUBLIC_URL:-https://damwha-demo.0kimjae.dev}"
cd "$ROOT"

for f in demo/seed/damwha-demo.dump demo/seed/manifest.json demo/seed/tour.json; do
  [ -f "$f" ] || { echo "missing $f — run demo/seed/build.sh first" >&2; exit 1; }
done

TOUR_ID=$(python3 -c "import json;print(json.load(open('demo/seed/tour.json'))['meeting_id'])")
TOUR_LABEL=$(python3 -c "import json;print(json.load(open('demo/seed/tour.json'))['file_label'])")
TOUR_QUERY=$(python3 -c "import json;print(json.load(open('demo/seed/tour.json'))['search_query'])")
# 시드 덤프에 그 회의가 실제로 있는지 — 없으면 투어의 업로드 결과가 404다.
# 이미지를 하나라도 밀기 전에 본다: 여기서 걸리면 레지스트리에 깨진 태그가 남지 않는다.
python3 -c "import json,sys; ids=[m['id'] for m in json.load(open('demo/seed/manifest.json'))]; sys.exit(0 if sys.argv[1] in ids else 'tour.json meeting_id not in manifest.json')" "$TOUR_ID"

if [ "$PUSH" = "1" ]; then
  gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
  OUT=(--push -t "$REGISTRY/damwha-demo-postgres:$TAG" -t "$REGISTRY/damwha-demo-postgres:latest")
  OUT_API=(--push -t "$REGISTRY/damwha-demo-api:$TAG" -t "$REGISTRY/damwha-demo-api:latest")
else
  OUT=(--load -t "$REGISTRY/damwha-demo-postgres:$TAG" -t "$REGISTRY/damwha-demo-postgres:latest")
  OUT_API=(--load -t "$REGISTRY/damwha-demo-api:$TAG" -t "$REGISTRY/damwha-demo-api:latest")
fi

echo "== base postgres-bigm ($PLATFORM, local only)"
docker buildx build --platform "$PLATFORM" --load -t damwha/postgres-bigm:pg16 be/docker/postgres-bigm

echo "== demo postgres"
docker buildx build --platform "$PLATFORM" "${OUT[@]}" -f deploy/demo/postgres.Dockerfile .

echo "== demo api"
docker buildx build --platform "$PLATFORM" "${OUT_API[@]}" \
  --build-arg VITE_DEMO_MODE=true --build-arg DEMO_SEED=true \
  --build-arg "VITE_DEMO_TOUR_MEETING_ID=$TOUR_ID" \
  --build-arg "VITE_DEMO_TOUR_FILE_LABEL=$TOUR_LABEL" \
  --build-arg "VITE_DEMO_TOUR_SEARCH_QUERY=$TOUR_QUERY" \
  --build-arg "VITE_PUBLIC_URL=${DEMO_PUBLIC_URL%/}" \
  -f deploy/api.Dockerfile .

echo "done: $REGISTRY/damwha-demo-{postgres,api}:$TAG (+latest), push=$PUSH"
