#!/usr/bin/env bash
# Cut a team-trial release: two arm64 images to GHCR, the worker wheel, and a
# tarball of this folder, all under one version tag. Run from a Mac with
# `docker login ghcr.io` and `gh auth login` done.
#
#   deploy/release.sh 0.1.0
#
# Images, wheel and tarball share the tag so a teammate cannot pair an API from
# one release with a worker from another — the job payload contract between
# them is only checked at that boundary.
set -euo pipefail

VERSION="${1:?usage: deploy/release.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY=ghcr.io/yjason-k
cd "$ROOT"

PY_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' be/worker/pyproject.toml)"
if [[ "$PY_VERSION" != "$VERSION" ]]; then
  echo "be/worker/pyproject.toml says version $PY_VERSION, not $VERSION — bump it first" >&2
  exit 1
fi

echo "== images ($REGISTRY, linux/arm64)"
docker buildx build --platform linux/arm64 --push \
  -t "$REGISTRY/damwha-postgres:$VERSION" be/docker/postgres-bigm
docker buildx build --platform linux/arm64 --push \
  -t "$REGISTRY/damwha-api:$VERSION" -f deploy/api.Dockerfile .

echo "== wheel"
OUT="$(mktemp -d)"
uv build --directory be/worker --wheel --out-dir "$OUT"
WHEEL="$(ls "$OUT"/damwha_worker-*.whl)"

echo "== tarball"
TAR="$OUT/damwha-deploy-$VERSION.tar.gz"
mkdir "$OUT/damwha"
cp deploy/docker-compose.yml deploy/.env.example deploy/README.md deploy/HUGGINGFACE.md "$OUT/damwha/"
tar -czf "$TAR" -C "$OUT" damwha

echo "== release v$VERSION"
# --target: without it gh tags the default branch (main), not the commit the
# artifacts were built from.
gh release create "v$VERSION" "$WHEEL" "$TAR" --target "$(git rev-parse HEAD)" \
  --title "v$VERSION" --notes "Team trial. Setup: deploy/README.md inside the tarball."
echo "done: $(gh release view "v$VERSION" --json url -q .url)"
