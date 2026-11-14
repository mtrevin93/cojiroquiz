# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12.18.0
WORKDIR /app

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/ingest/package.json packages/ingest/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @cojiro/web build
# Production-only node_modules for the web app and its workspace deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @cojiro/web deploy --prod /out

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    DATABASE_PATH=/data/cojiro.db \
    MIGRATIONS_DIR=/app/migrations \
    STORAGE_DRIVER=s3
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/web/dist ./dist
COPY --from=build /app/packages/db/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "./dist/server/entry.mjs"]
