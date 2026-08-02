# Multi-stage image for @mimir/api.
# Prunes the monorepo to only api's dependency subtree, so k8s can later reuse
# the same image with new manifests. No build step: bun runs the TS source directly.
#
# If the pruned bun.lock ever rejects `bun install --frozen-lockfile`
# (historical turbo+bun prune bug), fall back to the simpler:
#   FROM oven/bun:1 AS base; WORKDIR /app; COPY . .; RUN bun install --frozen-lockfile

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS prepare
COPY . .
RUN bunx turbo prune @mimir/api --docker

FROM base AS installer
COPY --from=prepare /app/out/json/ .
COPY --from=prepare /app/out/bun.lock ./bun.lock
COPY --from=prepare /app/out/full/ .
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV OTEL_SERVICE_NAME=mimir-api
COPY --from=installer /app/ .
USER bun
EXPOSE 4000
CMD ["bun", "run", "apps/api/src/server.ts"]
