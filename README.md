# Mimir

Conversational agent app — Next.js (static export) frontend, Express + socket.io backend,
separate BullMQ worker, Postgres (Prisma), Redis, Turborepo monorepo, Render deployment.


## Workspace layout

| Path                    | Package              | Role                                             |
| ----------------------- | -------------------- | ------------------------------------------------ |
| `apps/web`              | `@mimir/web`         | Next.js static export (chat UI, Phase 1.5)       |
| `apps/api`              | `@mimir/api`         | Express + socket.io API (Phase 0.3, Phase 2)      |
| `apps/worker`           | `@mimir/worker`      | BullMQ worker process (Phase 0.4, Phase 3)        |
| `apps/desktop`          | `@mimir/desktop`     | Tauri shell stub (Phase 9)                        |
| `packages/backend-core`   | `@mimir/backend-core`  | Prisma client, OpenRouter wrapper, config loader  |
| `packages/ui`           | `@mimir/ui`          | Shared chat components                            |
| `packages/shared-types` | `@mimir/shared-types`| Shared domain types                               |
| `packages/typescript-config` | `@mimir/typescript-config` | Shared tsconfig bases              |
| `packages/eslint-config`| `@mimir/eslint-config`| Shared ESLint flat configs                        |

Internal packages export TypeScript source directly (`exports` → `./src/index.ts`) and are
consumed via workspace symlinks — no per-package build step. `apps/web` transpiles them via
`transpilePackages` in `next.config.js`.

## Commands

```sh
bun install
bun run dev            # all apps/packages in dev mode
bun run build          # build everything (web static export included)
bun run typecheck      # tsc --noEmit across all workspaces
bun run lint
bun run verify         # assert api + worker share one @mimir/backend-core (no duplication)
```

## Docker

Each deployable app has its own Dockerfile (no Render buildpacks), built from the repo root:

```sh
docker build -f apps/api/Dockerfile .     # -> @mimir/api image
docker build -f apps/worker/Dockerfile .  # -> @mimir/worker image
docker build -f apps/web/Dockerfile .     # -> nginx static image
```

`apps/desktop` deliberately has no Dockerfile — it's a native artifact (Tauri shell, Phase 9),
excluded from the k8s "same images, new manifests" guarantee.
