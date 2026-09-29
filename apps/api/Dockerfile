# Multi-stage build for the ghostmplay API container.
#
# This container also serves the built SvelteKit/Vite SPA, because DOM Cloud's
# deployment bridge rewrites only the `location /` proxy_pass to point at a
# single container port. Splitting static files (served by NGINX) from /api
# (proxied to Docker) would fight that.
#
# Stages: base -> deps -> test -> build -> prod-deps -> runtime. `build` sits
# below `test` on purpose, so the test suite gates the image.
#
# Deliberately no `# syntax=` directive: it makes every cold build pull the
# dockerfile frontend image from a registry, which is an extra network
# dependency on a box with slow egress. Nothing here needs it — no
# `RUN --mount`, no heredocs.

# ---------------------------------------------------------------- base
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate
WORKDIR /app

# ----------------------------------------------------------------- deps
FROM base AS deps
# Only the manifests first, so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# ----------------------------------------------------------------- test
# Gate. The image is built on DOM Cloud, so there is no CI pipeline standing
# between a commit and production — this stage is that gate instead. `build`
# depends on it, so a failing typecheck or test fails the deploy.
#
# Shares the `deps` layer with `build`, so both reuse the same install layer and
# Docker only re-runs the gate when source actually changes.
FROM deps AS test
COPY . .
# shared's .d.ts must exist before the API and web typechecks resolve it.
RUN pnpm --filter @ghostmplay/shared build
RUN pnpm typecheck && pnpm test

# ---------------------------------------------------------------- build
FROM test AS build
# shared is already built by the test stage.
RUN pnpm --filter @ghostmplay/web build \
 && pnpm --filter @ghostmplay/api build

# ------------------------------------------------------------ prod deps
# `pnpm deploy` produces a self-contained node_modules for the API only, so the
# runtime image carries no build toolchain and no web-app dependencies.
# Requires injectWorkspacePackages: true in pnpm-workspace.yaml.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ghostmplay/api --prod deploy /out

# -------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_ROOT=/app/public \
    # The shared box has a 2GB address-space limit. Capping the heap well below
    # that leaves headroom for V8 overhead, the Postgres driver and the network
    # stack, and turns a leak into a fast OOM-restart instead of a swap storm.
    NODE_OPTIONS=--max-old-space-size=640

WORKDIR /app
RUN apk add --no-cache tini

COPY --from=prod-deps --chown=node:node /out/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /out/package.json     ./package.json
COPY --from=build      --chown=node:node /app/apps/api/dist    ./dist
COPY --from=build      --chown=node:node /app/apps/web/dist    ./public

USER node
EXPOSE 8080

# tini reaps zombies and forwards SIGTERM, so `docker compose down` (which DOM
# Cloud runs on every deploy) shuts the process down cleanly instead of
# killing it mid-request.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

HEALTHCHECK --interval=45s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
