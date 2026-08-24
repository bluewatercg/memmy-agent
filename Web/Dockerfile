FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY . .
ENV MEMMY_LEGAL_CN_BASE_URL=https://memmy.cn \
    MEMMY_LEGAL_INTL_BASE_URL=https://memmy.bot
RUN npm ci
RUN npm run build -w @memmy/frontend-desktop
RUN npm run build -w @memmy/memory
RUN mkdir -p /tmp/memory-viewer/memory && node --input-type=module -e "import { writeFileSync } from 'node:fs'; import { memoryPanelHtml } from './Memory/dist/src/viewer/static.js'; writeFileSync('/tmp/memory-viewer/memory/index.html', memoryPanelHtml());"

FROM nginx:1.27-alpine AS runtime
COPY Web/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/App/frontend/desktop/dist /usr/share/nginx/html
COPY --from=builder /tmp/memory-viewer/memory /usr/share/nginx/html/memory
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
