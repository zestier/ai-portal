# syntax=docker/dockerfile:1.7
#
# Multi-arch image (linux/amd64 + linux/arm64).
#
# The SvelteKit build output is pure JS (arch-independent). The only native
# artifact is `better-sqlite3`'s `.node`. To avoid running `vite build` under
# QEMU when cross-compiling, the `build` stage runs natively on the host
# platform; the `deps` stage runs on the target platform and uses pnpm's install
# lifecycle to fetch the right prebuilt native artifacts from npm. The `runtime`
# stage combines them.

ARG NODE_VERSION=24

# ---- build (runs on host arch; produces arch-independent JS) ----
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# `scripts/` is copied before `pnpm install` because pnpm runs the root
# package's `prepare` lifecycle (which invokes scripts/install-git-hooks.mjs)
# during install. The script no-ops outside a git checkout, but it still has
# to exist on disk.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm-store-build,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# The set of files copied here is controlled by .dockerignore (allowlist).
COPY . .
RUN pnpm run build

# ---- deps (runs on target arch; fetches the correct prebuilt .node) ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm-store-deps,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# git: snapshots + fork features shell out to it.
# tini: clean signal handling as PID 1.
# ca-certificates, curl: TLS + healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    PROJECT_ROOT=/workspace

# Ordered least- to most-frequently-changing so a code edit doesn't bust the
# (large) node_modules layer. Docker invalidates every layer after the first
# changed COPY, so the volatile build output goes last.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src/lib/server/db/migrations ./src/lib/server/db/migrations
COPY --from=build /app/build ./build

# Persistent state (encrypted SQLite, per-user data).
VOLUME ["/data"]
# Project tree the agent reads and edits. Mount your repo here.
VOLUME ["/workspace"]

EXPOSE 3000
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "build"]

# Probe the DB-free liveness endpoint, not readiness (`/api/health`, which
# runs a sync DB query). Otherwise a transient DB hiccup -- or a long startup
# migration -- would mark the container unhealthy and restart it mid-migration.
# `--start-period` is generous so first-boot schema migrations have room to
# finish before failing probes start counting against `--retries`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/api/health/liveness || exit 1
