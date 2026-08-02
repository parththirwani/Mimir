# Multi-stage image for @mimir/web: static export built once, served by nginx.
# Static export avoids a Node runtime entirely; nginx image is the k8s artifact.

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS prepare
COPY . .
RUN bunx turbo prune @mimir/web --docker

FROM base AS installer
COPY --from=prepare /app/out/json/ .
COPY --from=prepare /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile

FROM base AS builder
COPY --from=installer /app/ .
COPY --from=prepare /app/out/full/ .
COPY turbo.json ./
RUN cd apps/web && bun run build

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/out /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
