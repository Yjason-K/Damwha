# API + SPA in one image. Build context is the REPO ROOT (pnpm workspace):
#   docker build -f deploy/api.Dockerfile -t ghcr.io/yjason-k/damwha-api:<ver> .
# The worker is NOT in here — it needs Apple Silicon (MLX) and runs on the host
# from a wheel. Serves the public demo (deploy/demo/) — see deploy/demo/README.md.
#
# Demo build args: --build-arg VITE_DEMO_MODE=true bakes the
# read-only SPA, --build-arg DEMO_SEED=true bakes demo/seed storage into
# ./storage so the image needs no volume. Both default off.
ARG VITE_DEMO_MODE=false
ARG DEMO_SEED=false
ARG VITE_DEMO_TOUR_MEETING_ID=
ARG VITE_DEMO_TOUR_FILE_LABEL=
ARG VITE_DEMO_TOUR_SEARCH_QUERY=
ARG VITE_PUBLIC_URL=

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# every workspace package — contracts and share-format build through `prepare`; the fe build bundles share-view sources
COPY packages ./packages
COPY be/package.json ./be/
COPY fe/package.json ./fe/
# contracts and share-format build through their `prepare` script during install
RUN pnpm install --frozen-lockfile
COPY be ./be
COPY fe ./fe
RUN pnpm --filter damwha-be build
# Same origin as the API: the SPA calls /api relative to itself.
ARG VITE_DEMO_MODE
ARG VITE_DEMO_TOUR_MEETING_ID
ARG VITE_DEMO_TOUR_FILE_LABEL
ARG VITE_DEMO_TOUR_SEARCH_QUERY
ARG VITE_PUBLIC_URL
RUN VITE_API_BASE_URL=/api VITE_DEMO_MODE=$VITE_DEMO_MODE \
    VITE_DEMO_TOUR_MEETING_ID=$VITE_DEMO_TOUR_MEETING_ID \
    VITE_DEMO_TOUR_FILE_LABEL="$VITE_DEMO_TOUR_FILE_LABEL" \
    VITE_DEMO_TOUR_SEARCH_QUERY="$VITE_DEMO_TOUR_SEARCH_QUERY" \
    VITE_PUBLIC_URL="$VITE_PUBLIC_URL" \
    pnpm --filter damwha-fe build

# Demo seed storage (empty dir unless DEMO_SEED=true). Kept in its own stage so
# the demo/ tree never lands in the runtime image.
FROM node:22-alpine AS seed
ARG DEMO_SEED
WORKDIR /seed
COPY demo /demo
RUN if [ "$DEMO_SEED" = "true" ]; then node /demo/seed/bake-storage.mjs /demo /seed; fi

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/share-format/package.json ./packages/share-format/
COPY packages/share-view/package.json ./packages/share-view/
COPY be/package.json ./be/
COPY fe/package.json ./fe/
# --ignore-scripts: `prepare` of contracts and share-format needs tsc, which --prod does not install;
# both dists are copied from the build stage instead. share-view is bundled into the fe build and unused
# at runtime (fe/package.json depends on it, so its package.json must exist).
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/share-format/dist ./packages/share-format/dist
COPY --from=build /repo/be/dist ./be/dist
# main.ts serves dist/public as the SPA when it exists
COPY --from=build /repo/fe/dist ./be/dist/public
# Demo seed audio (empty unless DEMO_SEED=true) — the demo compose serves it straight from the image
COPY --from=seed /seed ./be/storage

# cwd = be/ so STORAGE_ROOT=./storage resolves like the dev setup
WORKDIR /repo/be
ENV NODE_ENV=production
# API 기본 HOST는 127.0.0.1이다(loopback). 컨테이너는 포트 매핑·터널로 바깥에서 닿아야 한다.
ENV HOST=0.0.0.0
EXPOSE 3000
# migrate.ts is its own entrypoint (require.main) — apply pending SQL, then serve
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
