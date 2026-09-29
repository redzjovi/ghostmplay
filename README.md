# ghostmplay

Marketplace tracker for the GhostM / NUMI NFT market. Scrapes the public
`market-api.numine.io` endpoints, normalises listings and token transfers into
PostgreSQL, and serves a Vue 3 SPA plus a REST API from a single container on
[DOM Cloud](https://domcloud.co).

**Stack:** NestJS 10 · TypeORM · PostgreSQL 17 · Vue 3 · Vite · Pinia · shadcn-vue (Reka UI) · Tailwind 3

## Layout

```text
apps/api/     NestJS: controllers, TypeORM entities, scraper, auth, sync jobs
apps/web/     Vue 3 SPA, served as static files by the API container
packages/     shared DTO types
```

`apps/web` keeps the original Electron renderer unchanged. The only thing that
changed is the transport: `src/api/http-client.ts` implements the same
`window.api` surface the preload script used to expose over IPC, backed by
`fetch`. Every store, view and UI component is untouched, so swapping the
frontend framework later means reimplementing that one file.

## Requirements

Node 22, pnpm 11, and a PostgreSQL 17 database.

## Local development

You need a PostgreSQL and a Valkey. `pnpm db:up` starts both in Docker,
reading host, port and credentials from the same `.env` the app uses, so the
two can never disagree.

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL
pnpm db:up                    # postgres 17 + valkey 8, waits until ready
pnpm dev                      # API on :8080 with watch mode
pnpm dev:web                  # Vite on :5173, proxying /api to :8080
```

The API runs migrations on first boot, so the schema appears by itself, and
`ADMIN_USERNAME` / `ADMIN_PASSWORD` seed the first admin. The database starts
**empty** — sign in as that admin and use **Sync Full** to populate it, otherwise
the marketplace list will look broken when it is just untested.

```bash
pnpm db:status                # ports, state, and whether migrations have run
pnpm db:reset                 # drop and recreate the database
pnpm db:down                  # stop and remove both
pnpm db:logs pg               # tail a service
```

`db:reset` recreates the database but does not restart the API, and migrations
run at boot rather than on connect — so restart `pnpm dev` afterwards.

The local images deliberately match production: `postgres:17-alpine` for
PostgreSQL 17.4, and `valkey/valkey:8-alpine` for Valkey 8.0. Override with
`DEV_PG_IMAGE` / `DEV_VALKEY_IMAGE` if needed.

### The database address differs per environment

Nothing is hardcoded; it is one variable with three values.

| Where the API runs | `DATABASE_URL` host |
|---|---|
| DOM Cloud container | `10.0.2.2:5432` — the container's route to the host, where the shared PostgreSQL listens |
| Local, API on the host | `127.0.0.1:5432` |
| Local, API in a container | `host.docker.internal:5432` — `127.0.0.1` inside a container is the container |

DOM Cloud writes the first one for you: `.drone.yml` generates `.env` during
deployment.

### Never point local at the production database

DOM Cloud's PostgreSQL is not reachable from a laptop — the documented "remote
client" host is an internal server name, and Valkey has no remote access at all.
More to the point, `app.module.ts` runs migrations on boot. A local `.env`
pointed at production would apply local migration files to live data, and
`migration:generate` would diff your dev branch against the production schema.

## Checks

```bash
pnpm typecheck    # tsc for the API, vue-tsc for the web app
pnpm test         # vitest, across both packages
pnpm build        # shared -> web -> api
```

To manage migrations by hand:

```bash
pnpm migration:run
pnpm migration:generate src/database/migrations/DescribeYourChange
```

## Architecture notes

**One container serves both the SPA and the API.** DOM Cloud's deployment bridge
rewrites only the `location /` proxy_pass to point at a single container port, so
splitting static files (served by NGINX) from `/api` (proxied to Docker) would
require hand-pinning an auto-assigned host port in the NGINX config — config that
lives outside the repo and breaks on a server move. NestJS serves the built SPA
via `@nestjs/serve-static` with `/api/(.*)` excluded, so controllers always win.

**PostgreSQL and Valkey are DOM Cloud's shared instances, not containers.** They
are reachable from inside a container at `10.0.2.2`, run on fast disk, and are
included in the daily backup. Running a database in a container would spend RAM
on a box that caps a process at 1-2GB.

**Sync is queued, locked and admin-only.** Scraping the upstream API is by far the
most expensive thing the app does, and the API has no natural end. A cron runs
only the incremental `latest` mode every 5 minutes — it stops as soon as it meets
an item already stored with the same `created_at`, so its cost tracks what is new
rather than the size of history. Full backfills are admin-triggered, run under a
Redis mutex with a page cap, and are reported through a `sync_jobs` row instead of
holding an HTTP request open. If a deploy kills a job mid-flight, it is marked
`interrupted` on the next boot rather than spinning forever.

**Transient scraper failures are retried.** Outbound traffic from inside a
rootless container is the weak point: DNS goes through Docker's embedded resolver
and the network driver is documented as poor for egress, so a job can fail on
`EAI_AGAIN` seconds after the container starts. A job retries transient failures
(DNS, connection reset, 408/425/429/5xx) three times with backoff, and does not
retry anything that would fail identically on a second try. Re-running is safe
because both scrapers upsert by a stable key.

**Sessions live in PostgreSQL**, keyed by a random token whose SHA-256 hash is
stored, in an httpOnly `Secure` `SameSite=Strict` cookie. Passwords are argon2id.
Failed logins are verified against a dummy hash so a missing account and a wrong
password take the same time.

**Favorites are per-account.** Every lookup is scoped by `account_id`, so another
user's favorite id is indistinguishable from a missing one.

## Deployment

There is no CI pipeline and no image registry. The container is built on the
DOM Cloud server itself, from the cloned source, by the `build` section in
`docker-compose.yml`.

That makes the Dockerfile's `test` stage load-bearing: `build` depends on it, so
a failing typecheck or test fails the image, and therefore the deploy. Run
`pnpm typecheck && pnpm test` locally first and you get the same gate in seconds
rather than minutes.

See [`.drone.yml`](.drone.yml) for the platform configuration and the plan
features it requires.

```bash
docker compose build                        # build the image
docker compose up -d                        # run it
docker compose logs -f api
docker compose down                         # stop
```

**Before the first deploy**, prime the build cache over SSH:

```bash
cd ~/public_html && docker compose build
```

DOM Cloud's deployment script has a hard 15-minute wall-clock limit
(`maxExecutionTime = 900000` in their bridge) that covers
`docker compose up --build`. That cap applies to the script, not to an
interactive shell, so the first — slowest — build should be primed where it is
untimed. After that only source layers rebuild. Without this, a cold build on a
shared 1–2 vCPU box risks exceeding the limit and taking the site down.

Measured build times on a local machine, for reference:

| | |
|---|---|
| Cold, empty cache | 1m21s |
| Source change (re-runs the test gate) | 52s |
| Nothing changed | ~1s |

Also before the first deploy:

1. Set `ADMIN_PASSWORD` in `.drone.yml` (it ships as `CHANGE_ME_BEFORE_FIRST_DEPLOY`).
2. Confirm the PostgreSQL login from the DOM Cloud Manage tab matches
   `$USERNAME` / `$PGPASSWD`.

After the first deploy, confirm the bridge assigned a port and wired NGINX:

```bash
cat ~/public_html/docker-compose.yml     # published port
docker ps
docker compose logs api
```

### Why the build runs on the host network

Rootless Docker on DOM Cloud uses the `pasta` network driver, which is documented
as fast for incoming connections but slow for outgoing ones. pnpm downloads
several hundred packages during the build, so `build.network: host` sidesteps it.
This affects build time only; the running container still uses the normal path.
