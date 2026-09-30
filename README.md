# ghostmplay

Marketplace tracker for the GhostM / NUMI NFT market. Scrapes the public
`market-api.numine.io` endpoints, normalises listings and token transfers into
PostgreSQL, and serves a Vue 3 SPA plus a REST API from a single container on
[DOM Cloud](https://domcloud.co).

**Stack:** NestJS 10 · TypeORM · PostgreSQL 17 · Vue 3 · Vite · Pinia · shadcn-vue (Reka UI) · Tailwind 3

## Layout

```text
apps/api/     NestJS: controllers, TypeORM entities, scraper, auth, sync state
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

You need a PostgreSQL and a Valkey. Both are defined in
`docker-compose.dev.yml` and started with `pnpm db:up`, which blocks until each
one reports healthy. The API itself runs on the host.

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL
pnpm db:up                    # postgres 17 + valkey 8, waits until healthy
pnpm dev                      # API on :8080 with watch mode
pnpm dev:web                  # Vite on :5173, proxying /api to :8080
```

The API runs migrations on first boot, so the schema appears by itself, and
`ADMIN_USERNAME` / `ADMIN_PASSWORD` seed the first admin. The database starts
**empty** — sign in as that admin and use **Sync Full** to populate it, otherwise
the marketplace list will look broken when it is just untested.

```bash
pnpm db:status                # container health, then schema + row counts
pnpm db:reset                 # drop and recreate the database
pnpm db:down                  # stop and remove containers, KEEP the data
pnpm db:nuke                  # stop and remove containers AND the data
pnpm db:logs pg               # tail a service
```

Data lives in a named volume, so it survives `db:down` / `db:up` and only
`db:nuke` discards it. `db:reset` empties the database but keeps the volume.

`db:reset` recreates the database but does not restart the API, and migrations
run at boot rather than on connect — so restart `pnpm dev` afterwards.

The local images deliberately match production: `postgres:17-alpine` for
PostgreSQL 17.4, and `valkey/valkey:8-alpine` for Valkey 8.0. The API container
in production reaches DOM Cloud's shared services over the host bridge, so
`docker-compose.yml` is the production path and stays separate from this one.

#### Credentials are declared twice, on purpose

`docker-compose.dev.yml` hardcodes `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB`, and `.env` holds the same facts inside `DATABASE_URL`. Compose
could interpolate the former from the latter's surroundings, but not from a
single URL, so one of the two has to be the source. The literals won because
they are throwaway local values rather than secrets, and they keep the compose
file readable on its own.

The duplication is safe because `pnpm db:status` connects with the exact
`DATABASE_URL` the API will use, over the host-mapped port, and names the
offending part when they disagree — a rejected password, a missing database, or
a port with nothing listening. Note that `POSTGRES_PASSWORD` only takes effect
when the volume is *first* initialised, so changing it later needs `db:nuke`.

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

**Admin surfaces are separate from browsing, and the destructive one is separated
from the rest.** The Data page (`/admin/data`) holds the only sync controls, hidden
from non-admins and guarded by `meta.requiresAdmin`; both are UX, since
`AdminGuard` on `/api/admin/sync` is the actual boundary. Each kind also has a
**Clear all** button, which deletes that scraper's table outright. It is refused with
a 409 while that kind is being scraped, so a delete cannot race an in-flight run, and
it resets that kind's `sync_state` row — otherwise the page would keep reporting
"done, 516 synced" over an empty table. The two sections are not equivalent to clear:
the marketplace's incremental run breaks on the first item it already has, which an
empty table has none of, so it re-walks every page on the next cron tick and refills
itself in about a minute; history's incremental run only ever fetches the first page,
so a cleared ledger stays empty until a full backfill is started by hand. Clearing
history is the expensive one by orders of magnitude.

**Sync is locked and admin-only.** Scraping the upstream API is by far the most
expensive thing the app does. A cron runs only the incremental `latest` mode, once a
minute — it stops as soon as it meets an item already stored with the same
`created_at`, so on an idle upstream it is roughly one request that finds itself
already up to date, and its cost tracks what is new rather than the size of history.
Full backfills are admin-triggered and uncapped: both scrapers walk until the upstream
returns a short page, which it does rather than clamping the offset, so a backfill
covers everything the API holds. Nothing is held open over an HTTP request: a trigger
takes a lock, returns, and the UI polls. If a deploy kills a run mid-flight, it is
marked `interrupted` on the next boot rather than spinning forever.

**The lock TTL is a backstop, not a budget, and it renews.** `LockService` starts a
timer when a lock is granted and stops it in `release`, so a lease tracks the lock's
real lifetime instead of being a number a run has to fit inside. That is what makes an
uncapped backfill safe: with a fixed TTL a long enough run would lose its lock
mid-scrape, and a second trigger would start a concurrent scrape against the same
public API. Renewal is token-guarded — it extends the TTL only while the holder still
owns the key, and stops for good if the key is someone else's, so a run that overran
cannot resurrect itself over its successor.

**Every timestamp in the ledger is UTC, and the upstream's are not.** The transfer log
returns a bare `YYYY-MM-DD HH:mm:ss` with no offset, and it is KST — the same +09:00
that `item-detail` spells out in `mintTime`. Reading it as UTC stored every transfer 9
hours ahead, which put some in the future and skewed the sold-state join that compares
a transfer against its listing's `created_at`. The two fields that do carry a zone are
honoured rather than assumed. `1790812800000-FixTransferTimezone.ts` repairs rows
stored before the fix, gated on a future-dated transfer existing as proof, since a
completed transfer cannot be in the future.

**Deduplication is the lock, not a queue.** The lock key is `sync:<kind>`, so two
triggers of the same kind contend whether they arrive at this process or another, and
a cron tick that lands while the previous run is still going joins it instead of
starting a second scrape. State lives in one row per kind (`sync_state`), which
replaced an append-only `sync_jobs` table that grew every tick and had to be pruned;
per-kind rows are also what let each page show its own progress, rather than a
finished history run being reported as the marketplace's last sync.

**The cron runs the two kinds in sequence, marketplace first.** `enqueue()` is
fire-and-forget by design — it takes the lock, writes `running`, and returns — so
looping over the kinds used to start both at once regardless of order. The scheduler
now awaits `settled(kind)` between them. The order is a correctness requirement, not
tidiness: history derives sold state from the transfer ledger, and both of its paths
stop at the first transfer they already hold. If history ran while the marketplace
scraper had not yet inserted the item row a transfer refers to, the join would match
nothing, and because the transfer was then stored, no later run would ever look at it
again — the item would stay on sale permanently. Awaiting also covers the deduped
case: a tick that joined someone else's run waits for that run rather than racing
ahead of it.

## Item lifecycle

**Sold state is a timestamp, and the transfer ledger is the only thing that writes it.**
`marketplace_items.sold_at` is null while an item is on the market and set to the
sale's own `created_at` once it leaves. There is no `sold` boolean to disagree with
it. `sold_price` rides along from the same row.

**Sold is derived, never inferred.** Each history run ends with
`MarketplaceService.markItemsSold()`, a single `UPDATE` joining `marketplace_items`
against `marketplace_token_transfers`. The join is deliberately **table-wide** rather
than scoped to the transfers that run just fetched: `refreshLatest` breaks on the
first transfer it already holds, so a scope built from "the fresh ones" would never
revisit a transfer whose item row did not exist at the time. Re-deriving from the
whole ledger is a hash join on an indexed `token_id` that makes that whole class of
miss unrepresentable. `sold_at IS NULL` in the predicate makes it a no-op once a row
is marked, and pins `sold_at` to the first sale observed rather than letting a later
transfer overwrite it. `price > 0` excludes mints and zero-value hand-offs.

This replaced an inference that read "a detail fetch returned nothing, so it must be
sold". That fetch swallowed every error, so a 5xx, a 429 and a DNS blip were all
indistinguishable from a delisted token and were persisted as a sale — and it only
ran for items whose `created_at` had changed, so real sales were missed too. On the
dev database that column held 31 `true` values of which 3 were real sales; the
migration's backfill, which reads only the ledger, corrected the other 28.

**Browse shows live items only; item detail does not.** `list()` and both
`getDistinct*` filter on `sold_at IS NULL`, served by a partial index
(`created_at DESC WHERE sold_at IS NULL`) that the planner uses directly. In
TypeORM a later `.where()` resets the clause and discards prior `andWhere`s, so that
predicate has to be the first one built. `getByTokenId` is deliberately *not* filtered,
so a deep link to a sold item still resolves and renders as "sold out" rather than
404ing.

**A relisted item is the same token under a new `item_id`.** `token_id` is unique, so
a lookup by `id` alone misses the existing row and the insert trips the unique index —
an unhandled `23505` that fails the whole run. `upsertFromApi` matches on either key
and keeps the original row, clearing `sold_at` only when the match came from
`tokenId`. A plain re-scrape of a sold item deliberately leaves `sold_at` alone:
otherwise every marketplace run would resurrect it until history caught up. Because a
relist keeps its old sale in the ledger, the join requires `transfer.created_at >=
item.created_at` — without it the very next run would re-sell the new listing from the
previous one, and `sold_at` would end up earlier than `created_at`.

**Sync controls live on one admin-only page** (`/admin/data`, "Data" in the sidebar).
The marketplace and history pages keep only a passive "Syncing…" banner and their
last-sync text, so an admin who starts a run still sees the data moving after
navigating away. The page carries one button per kind per mode, and the mode is
derived from the kind rather than written out: `EnqueueSyncDto` accepts all three
values for either kind, but the orchestrator only treats `all` as a marketplace
backfill and `full` as a history one, so a cross-wired value is accepted, logs
nothing, and silently degrades to the incremental run. The sidebar link is hidden for
non-admins and the route guard redirects them, but both are UX only — the real
boundary is `AdminGuard` on `/api/admin/sync`.

**Known gap: delisted is not sold.** A seller cancelling a listing produces no
transfer, so such an item keeps a null `sold_at` and stays listed. Covering that
needs a `last_seen_at` column plus a full-inventory walk to spot listings that
vanished from the upstream list without a sale. Not implemented.

**Transient scraper failures are retried.** Outbound traffic from inside a
rootless container is the weak point: DNS goes through Docker's embedded resolver
and the network driver is documented as poor for egress, so a run can fail on
`EAI_AGAIN` seconds after the container starts. A run retries transient failures
(DNS, connection reset, 408/425/429/5xx) three times with backoff, and does not
retry anything that would fail identically on a second try. Re-running is safe
because both scrapers upsert by a stable key.

**Sessions live in PostgreSQL**, keyed by a random token whose SHA-256 hash is
stored, in an httpOnly `Secure` `SameSite=Strict` cookie. Passwords are argon2id.
Failed logins are verified against a dummy hash so a missing account and a wrong
password take the same time.

**Favorites are per-account.** Every lookup is scoped by `account_id`, so another
user's favorite id is indistinguishable from a missing one.

**Browsing is public; only favorites and admin sync need a session.** The
marketplace list, the history list and item detail read endpoints that take no
account, so a signed-out visitor gets the same data as a signed-in one and the
`/auth/me` call is only there to personalise the chrome. Guards are opt-in per
controller, and only `favorites.controller.ts` (`RequireAuthGuard`) and
`sync-admin.controller.ts` (`AdminGuard`) apply one — the marketplace and history
controllers deliberately do not, so adding one there is a product decision, not a
clean-up. The client guard in `router/index.ts` fails closed: a route is gated
unless it carries `meta.public`, so a new page has to opt in to being public.

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
