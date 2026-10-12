# ghostmplay

Marketplace tracker for the GhostM / NUMI NFT market. Scrapes the public
`market-api.numine.io` endpoints, normalises listings and token transfers into
PostgreSQL, and serves a Vue 3 SPA plus a REST API from a single Node process on
cPanel.

**Stack:** NestJS 10 · TypeORM · PostgreSQL 17 · Vue 3 · Vite · Pinia · shadcn-vue (Reka UI) · Tailwind 3

## Layout

```text
apps/api/     NestJS: controllers, TypeORM entities, scraper, auth, sync state
apps/web/     Vue 3 SPA, served as static files by the API process
packages/     shared DTO types
docs/         cPanel deployment runbook
```

`apps/web` keeps the original Electron renderer unchanged. The only thing that
changed is the transport: `src/api/http-client.ts` implements the same
`window.api` surface the preload script used to expose over IPC, backed by
`fetch`. Every store, view and UI component is untouched, so swapping the
frontend framework later means reimplementing that one file.

## Requirements

Node 22, pnpm 11, and a PostgreSQL 17 database. No Postgres extension is required.

## Local development

You need a PostgreSQL. It is defined in `docker-compose.dev.yml` and started
with `pnpm db:up`, which blocks until it reports healthy. The API itself runs on
the host. Nothing else: the sync lock and the sign-in throttle are per-process.

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL
pnpm db:up                    # postgres 17, waits until healthy
pnpm dev                      # API on :8080 with watch mode
pnpm dev:web                  # Vite on :5173, proxying /api to :8080
```

The API runs migrations on first boot, so the schema appears by itself. Sign-in is
Google-only — there is no password account — so set `GOOGLE_ADMIN_EMAILS` to your own
verified address or the first login will produce a plain user and `/admin/data` will
403. The database starts **empty** — sign in and use **Sync Full** to populate it,
otherwise the marketplace list will look broken when it is just untested.

```bash
pnpm db:status                # container health, then schema + row counts
pnpm db:reset                 # drop and recreate the database
pnpm db:down                  # stop and remove the container, KEEP the data
pnpm db:nuke                  # stop and remove the container AND the data
pnpm db:logs pg               # tail PostgreSQL
```

Data lives in a named volume, so it survives `db:down` / `db:up` and only
`db:nuke` discards it. `db:reset` empties the database but keeps the volume.

`db:reset` recreates the database but does not restart the API, and migrations
run at boot rather than on connect — so restart `pnpm dev` afterwards.

`docker-compose.dev.yml` is local-only. Production is a Node process on cPanel
and shares nothing with it except the database engine; see
[Deployment](#deployment), or the full runbook in
[docs/DEPLOY-CPANEL.md](docs/DEPLOY-CPANEL.md).

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

Nothing is hardcoded; it is one variable with two values.

| Where the API runs | `DATABASE_URL` host |
|---|---|
| cPanel | `127.0.0.1:5432` — PostgreSQL runs on the same box |
| Local, API on the host | `127.0.0.1:5432` |
| Local, API in a container | `host.docker.internal:5432` — `127.0.0.1` inside a container is the container |

An external managed database (Neon, Supabase, …) works too: set `DATABASE_SSL=true`,
since only a database reached over the internet needs TLS.

### Never point local at the production database

cPanel's PostgreSQL *is* reachable from a laptop — it listens on `127.0.0.1` of a
box you have a shell on, and many hosts expose it on a public port as well. The
guard against accidents is not the network, it is `app.module.ts`: migrations run
on boot. A local `.env` pointed at production would apply local migration files
to live data, and `migration:generate` would diff your dev branch against the
production schema. Check `DATABASE_URL` before every `pnpm dev`.

## Checks

```bash
pnpm typecheck    # tsc for the API, vue-tsc for the web app
pnpm test         # vitest, across both packages
pnpm build        # shared -> web -> api
pnpm release      # the checks above, then release/ for cPanel
```

To manage migrations by hand:

```bash
pnpm migration:run
pnpm migration:generate src/database/migrations/DescribeYourChange
```

## Architecture notes

**One process serves both the SPA and the API.** Passenger routes every request
for the domain to the single Node process it spawns, and it assigns that
process's port itself, so there is no fixed port to proxy to and no reverse proxy
to configure. NestJS serves the built SPA via `@nestjs/serve-static` with
`/api/(.*)` excluded, so controllers always win, and the SPA calls `/api`
same-origin, so there is no CORS and no cross-site cookie to get wrong.

**PostgreSQL is cPanel's, not ours.** It runs on the same box, and so does its
backup. That is the only shared service the app has.

**One process is a correctness requirement, not a scaling choice.** Two in-process
singletons depend on it. The sync mutex stops a second scraper hitting the same
public endpoint, and the throttle is a per-IP budget that a second process would
hand out twice. So the deployment is pinned to a single Passenger instance with
`PassengerMinInstances` / `PassengerMaxInstances` — which is why those two lines
in `.htaccess` are load-bearing, why `passenger-status` should show one instance,
and why [docs/DEPLOY-CPANEL.md](docs/DEPLOY-CPANEL.md) is not optional reading.

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

**Transient scraper failures are retried.** Outbound DNS from a freshly spawned
process on shared hosting can fail with `EAI_AGAIN` seconds after the app starts,
so a run retries transient failures (DNS, connection reset, 408/425/429/5xx) three
times with backoff, and does not retry anything that would fail identically on a
second try. Re-running is safe because both scrapers upsert by a stable key.

**Sessions live in PostgreSQL**, keyed by a random token whose SHA-256 hash is
stored, in an httpOnly `Secure` `SameSite=Strict` cookie. There is no password to
hash and no account to create: a session only ever comes from a verified Google
ID token.

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

The target is **cPanel with Node.js Selector** (CloudLinux + LiteSpeed +
Passenger). There is no Docker on shared hosting, so the artifact is not an image
but a directory of files: `pnpm release` assembles `release/` from the checkout
and Passenger runs one Node process from it.

```
release/
  app.js          Passenger's startup file — it looks for this exact name
  dist/           compiled API
  public/         built SPA, served by the API from WEB_ROOT
  node_modules/   production dependencies only, no toolchain, no native binaries
  tmp/            touch tmp/restart.txt to restart the running app
```

`pnpm release` runs `typecheck` and `test` before it builds, on purpose. There is
no CI between a commit and production, so that gate is the only thing standing
between a broken build and a 502 — it fails in the terminal, with the real error,
instead of in a browser. The build then runs `shared → web → api`, and `pnpm
deploy` produces a `node_modules` that has the workspace package injected as real
files, which is what makes the artifact independent of the monorepo.

**[docs/DEPLOY-CPANEL.md](docs/DEPLOY-CPANEL.md) is the runbook**: database and
Node.js prerequisites, the build, the Application Manager settings, the
environment variables, Google sign-in, the one-process pin, redeploying, and what
to check when a deploy goes wrong.
