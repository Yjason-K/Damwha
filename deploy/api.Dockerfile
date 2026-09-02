# API + SPA in one image. Build context is the REPO ROOT (pnpm workspace):
#   docker build -f deploy/api.Dockerfile -t ghcr.io/yjason-k/damwha-api:<ver> .
# The worker is NOT in here — it needs Apple Silicon (MLX) and runs on the host
# from a wheel. See deploy/README.md.
#
# Public-demo variant (deploy/demo/): --build-arg VITE_DEMO_MODE=true bakes the
# read-only SPA, --build-arg DEMO_SEED=true bakes demo/seed storage into
# ./storage so the image needs no volume. Both default off; the team-trial image
# is unchanged.
ARG VITE_DEMO_MODE=false
ARG DEMO_SEED=false

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts ./packages/contracts
COPY be/package.json ./be/
COPY fe/package.json ./fe/
# contracts builds through its `prepare` script during install
RUN pnpm install --frozen-lockfile
COPY be ./be
COPY fe ./fe
RUN pnpm --filter damwha-be build
# Same origin as the API: the SPA calls /api relative to itself.
ARG VITE_DEMO_MODE
RUN VITE_API_BASE_URL=/api VITE_DEMO_MODE=$VITE_DEMO_MODE pnpm --filter damwha-fe build

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
COPY be/package.json ./be/
COPY fe/package.json ./fe/
# --ignore-scripts: contracts' `prepare` needs tsc, which --prod does not install;
# its dist is copied from the build stage instead.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/be/dist ./be/dist
# main.ts serves dist/public as the SPA when it exists
COPY --from=build /repo/fe/dist ./be/dist/public
# Demo seed audio (empty unless DEMO_SEED=true); the team compose mounts a volume over it
COPY --from=seed /seed ./be/storage

# cwd = be/ so STORAGE_ROOT=./storage resolves like the dev setup
WORKDIR /repo/be
ENV NODE_ENV=production
EXPOSE 3000
# migrate.ts is its own entrypoint (require.main) — apply pending SQL, then serve
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
