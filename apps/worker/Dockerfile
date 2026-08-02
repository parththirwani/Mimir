# Multi-stage image for @mimir/worker. No HTTP listener — BullMQ workers only.
# Same pattern as apps/api/Dockerfile.
#
# If the pruned bun.lock ever rejects `bun install --frozen-lockfile`
# (historical turbo+bun prune bug), fall back to the simpler:
#   FROM oven/bun:1 AS base; WORKDIR /app; COPY . .; RUN bun install --frozen-lockfile

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS prepare
COPY . .
RUN bunx turbo prune @mimir/worker --docker

FROM base AS installer
COPY --from=prepare /app/out/json/ .
COPY --from=prepare /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=installer /app/ .
COPY --from=prepare /app/out/full/ .
USER bun
CMD ["bun", "run", "apps/worker/src/index.ts"]
