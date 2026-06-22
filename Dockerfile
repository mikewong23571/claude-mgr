# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY frontend ./frontend

RUN npm run build:frontend
RUN npx tsc -p tsconfig.json

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CLAUDE_MGR_DB=/app/data/claude-mgr.sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/public/admin ./public/admin

RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8787

CMD ["node", "dist/src/index.js"]
