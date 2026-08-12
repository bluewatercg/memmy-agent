FROM node:24-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm ci \
    && npm run memory:build \
    && npm ci --omit=dev --workspace @memmy/memory --include-workspace-root=false \
    && npm audit --omit=dev --workspace @memmy/memory --audit-level=high \
    && mkdir -p /runtime \
    && cp Memory/package.json /runtime/package.json \
    && cp -R Memory/dist /runtime/dist \
    && cp -RL node_modules /runtime/node_modules

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOME=/home/node

WORKDIR /app

COPY --from=builder --chown=node:node /runtime ./

RUN mkdir -p /data /home/node/.memmy/memory-service/model-cache \
    && chown -R node:node /data /home/node/.memmy

USER node

EXPOSE 18960

ENTRYPOINT ["node", "dist/src/server/index.js"]
