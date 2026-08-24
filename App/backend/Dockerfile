FROM node:24-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci \
    && npm run build -w @memmy/backend

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOME=/home/node
WORKDIR /app
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/App/backend/package.json ./App/backend/package.json
COPY --from=builder --chown=node:node /app/App/backend/dist ./App/backend/dist
COPY --from=builder --chown=node:node /app/App/backend/local-api-contracts/package.json ./App/backend/local-api-contracts/package.json
COPY --from=builder --chown=node:node /app/App/backend/local-api-contracts/dist ./App/backend/local-api-contracts/dist
COPY --from=builder --chown=node:node /app/Memory/package.json ./Memory/package.json
COPY --from=builder --chown=node:node /app/Memory/dist ./Memory/dist

RUN mkdir -p /data /config \
    && chown -R node:node /data /config /app
USER node
EXPOSE 18100
ENTRYPOINT ["node", "App/backend/dist/src/web-server.js"]
