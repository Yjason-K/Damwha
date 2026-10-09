# 공유 서버 (spec selfhost-v2 §2.4). 빌드: docker build -f deploy/share/Dockerfile -t damwha-share:<ver> .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY share/package.json ./share/
RUN pnpm install --frozen-lockfile --filter damwha-share...
COPY share ./share
RUN pnpm --filter damwha-share run build
# 런타임 node_modules만 따로 — 워크스페이스 링크를 실제 디렉터리로 펼친다
RUN pnpm --filter damwha-share --prod --config.inject-workspace-packages=true deploy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/share/dist/server ./server
COPY --from=build /repo/share/dist/viewer ./viewer
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    VIEWER_DIR=/app/viewer
# 새 named volume은 이미지의 /data 소유권을 물려받는다 — 미리 node 소유로 만들어 두지 않으면 root 소유 볼륨에
# USER node가 /data/shares를 만들지 못해 서버가 뜨지 않는다.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
USER node
CMD ["node", "server/main.js"]
