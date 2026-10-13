# Build context is the REPOSITORY ROOT, not apps/api.
#
# Voroa's Root Directory is "/" for this service and the Dockerfile path is
# "/apps/api/Dockerfile". That is not cosmetic: the web build needs the
# workspace manifest, the lockfile and packages/shared, all of which sit outside
# apps/api. With the context set to apps/api the first stage cannot COPY them and
# the build fails before it starts.
#
# Every stage below is separated by manifest and source on purpose. A change to a
# Go file must not reinstall 309 npm packages, and a change to a Vue file must not
# re-download the Go module graph.

# --- the web app -------------------------------------------------------------
FROM node:22-slim AS web

WORKDIR /src

# Node 22 is not incidental: pnpm 11 (pinned by packageManager in the root
# package.json) requires Node 22+, and @vueuse/core declares engines.node >=22.
# On Node 20 the install fails.
RUN corepack enable

# Manifests first, so this layer is cached until a dependency actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/shared packages/shared

# shared first: @ghostmplay/shared resolves main and types to ./dist, and apps/web
# imports it, so building web against an unbuilt shared produces a bundle with
# unresolved types rather than a build error. This mirrors the root "build:web"
# script, which orders them the same way.
RUN pnpm --filter @ghostmplay/shared build \
    && pnpm --filter @ghostmplay/web build

# --- the API -----------------------------------------------------------------
FROM golang:1.26 AS api

WORKDIR /src

# go.mod and go.sum alone, for the same caching reason as above.
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download

COPY apps/api ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# --- the runtime -------------------------------------------------------------
# No toolchain here. The binary is static (CGO_ENABLED=0) and the web build is
# plain files, so the runtime needs neither Go nor Node.
FROM debian:bookworm-slim AS runtime

# ca-certificates for TLS to the marketplace upstream (market-api.numine.io) and
# to Postgres when the database needs TLS. Without them those calls fail with a
# certificate error that looks like an upstream outage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=api /out/api /app/bin/api
# public/ sits beside bin/, which is the first path resolveWebRoot checks. No
# WEB_ROOT is needed in the deployed environment.
COPY --from=web /src/apps/web/dist /app/public

# Runs the binary's own -healthcheck, which issues a real GET against
# /api/health and exits non-zero if the database is unreachable. That is
# deliberately stronger than a TCP connect check, and it is why no curl or wget
# is installed here.
#
# Voroa ignores the service's Health check path for a Docker runtime, so this
# HEALTHCHECK is the only readiness signal a deploy gets.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/app/bin/api", "-healthcheck"]

# PORT is supplied by the platform and is always 3000. The binary reads it, so
# nothing is hardcoded. EXPOSE would be documentation only and would not publish
# a port.
EXPOSE 3000

CMD ["/app/bin/api"]