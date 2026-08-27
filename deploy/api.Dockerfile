# API + SPA in one image. Build context is the REPO ROOT (pnpm workspace):
#   docker build -f deploy/api.Dockerfile -t ghcr.io/yjason-k/damwha-api:<ver> .
# The worker is NOT in here — it needs Apple Silicon (MLX) and runs on the host
# from a wheel. See deploy/README.md.

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
RUN VITE_API_BASE_URL=/api pnpm --filter damwha-fe build

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

# cwd = be/ so STORAGE_ROOT=./storage resolves like the dev setup
WORKDIR /repo/be
ENV NODE_ENV=production
EXPOSE 3000
# migrate.ts is its own entrypoint (require.main) — apply pending SQL, then serve
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/main.js"]
