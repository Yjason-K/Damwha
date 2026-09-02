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
cd "$ROOT"

for f in demo/seed/damwha-demo.dump demo/seed/manifest.json; do
  [ -f "$f" ] || { echo "missing $f — run demo/seed/build.sh first" >&2; exit 1; }
done

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
  -f deploy/api.Dockerfile .

echo "done: $REGISTRY/damwha-demo-{postgres,api}:$TAG (+latest), push=$PUSH"
