# ghostmplay

Marketplace tracker for the GhostM / NUMI NFT market. Scrapes the public
`market-api.numine.io` endpoints, normalises listings and token transfers into
PostgreSQL, and serves a Vue 3 SPA plus a REST API from a single Go process.

**Stack:** Go 1.26 · Fiber · sqlc · PostgreSQL 17 · Vue 3 · Vite · Pinia · shadcn-vue (Reka UI) · Tailwind 3

## Layout

```text
apps/api/     Go API: handlers, services, sqlc queries, scraper, auth, sync state
apps/web/     Vue 3 SPA, served as static files by the API process
packages/     shared DTO types
docs/         deployment runbooks
```

The API is a hand-wired Go module — no container, no reflection, no code
generation at runtime. Every dependency is a constructor call in `cmd/api/main.go`,
so "what does this service actually get" is a screen-reading rather than a
runtime trace. SQL lives in `apps/api/db/queries/*.sql` and is compiled to Go by
sqlc; the generated code is committed so the deploy target needs nothing but a Go
toolchain.

`apps/web` is unchanged from the Electron original. The only thing that changed
when it moved to HTTP is the transport: `src/api/http-client.ts` implements the
same `window.api` surface the preload script exposed over IPC, backed by `fetch`.
The Go rewrite kept every response shape byte-compatible, so that file did not
change either.

## Requirements

Go 1.26+, Node 22, pnpm 11, and a PostgreSQL 17 database. No Postgres extension
is required.

## Local development

You need a PostgreSQL. It is defined in `docker-compose.dev.yml` and started with
`pnpm db:up`, which blocks until it reports healthy. **The API runs on the host,
not in a container** — only PostgreSQL is containerised — so `.env` points at the
host-published `127.0.0.1:5432`. Nothing else: the sync lock and the sign-in
throttle are per-process.

```bash
pnpm install
cp .env.example .env          # then set DATABASE_URL
pnpm db:up                    # postgres 17, waits until healthy
pnpm dev                      # API on :8080, with live reload
pnpm dev:web                  # Vite on :5173, proxying /api to :8080
```

`pnpm dev` reloads on save via [air](https://github.com/air-verse/air). It is not
installed for you, because it is a development tool rather than a project
dependency:

```bash
go install github.com/air-verse/air@latest
```

Without it `pnpm dev` still starts the server, it just does not reload, and it
says so. What to watch is configured in `apps/api/.air.toml` rather than buried
in the Makefile, so a change to it shows up in a diff. Edits to `.go` and to
`db/queries/*.sql` both reload; edits to `_test.go` and to the generated
`db/sqlc` do not, because rebuilding in response to a code generator's own output
is a loop waiting to happen.

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
`db:nuke` discards it. `db:reset` recreates the database but does not restart the
API, and migrations run at boot rather than on connect — so restart `pnpm dev`
afterwards.

#### Credentials are declared twice, on purpose

`docker-compose.dev.yml` hardcodes `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB`, and `.env` holds the same facts inside `DATABASE_URL`. Compose could
interpolate the former from the latter's surroundings, but not from a single URL, so
one of the two has to be the source. The literals won because they are throwaway local
values rather than secrets, and they keep the compose file readable on its own.

The duplication is safe because `pnpm db:status` connects with the exact
`DATABASE_URL` the API will use, over the host-mapped port, and names the offending
part when they disagree. Note that `POSTGRES_PASSWORD` only takes effect when the
volume is *first* initialised, so changing it later needs `db:nuke`.

### The database address differs per environment

Nothing is hardcoded; it is one variable with different values.

| Where the API runs | `DATABASE_URL` host |
|---|---|
| Local, API on the host | `127.0.0.1:5432` |
| Local, API in a container | `host.docker.internal:5432` — `127.0.0.1` inside a container is the container |
| Deployed (managed Postgres) | the connection string the platform gives you |

An external managed database works too: set `DATABASE_SSL=true`, since only a
database reached over the internet needs TLS.

### Never point local at the production database

The deployed database *is* reachable from a laptop. The guard against accidents is
not the network, it is the migration runner: migrations run on boot. A local `.env`
pointed at production would apply local migration files to live data. Check
`DATABASE_URL` before every `pnpm dev`.

## Checks

```bash
pnpm typecheck    # tsc for the web app
pnpm lint         # eslint for the web app, gofmt+vet+golangci-lint for the API
pnpm test         # go test for the API, vitest for the web app
pnpm check        # all of the above plus the production build
```

To manage the schema by hand:

```bash
make -C apps/api migrate-up                    # apply pending migrations
make -C apps/api migrate-force VERSION=1       # adopt an already-migrated database
make -C apps/api generate                      # regenerate db/sqlc after a query change
make -C apps/api baseline                      # regenerate the baseline migration
```

## Architecture notes

**One process serves both the SPA and the API.** Voroa routes every request for the
service to one container and assigns its port, so there is no fixed port to proxy
to. The Go process serves the built SPA with `/api/*` excluded, so handlers always
win, and the SPA calls `/api` same-origin, so there is no CORS and no cross-site
cookie to get wrong.

**PostgreSQL is managed, not ours.** The platform provides it and backs it up.

**One process is a correctness requirement, not a scaling choice.** Two in-process
singletons depend on it. The sync mutex stops a second scraper hitting the same
public endpoint, and the sign-in throttle is a per-IP budget that a second process
would hand out twice. Voroa runs one container per service, which satisfies this by
default — but **scaling the service to two instances breaks both silently**. The
scheduler awaits each kind in turn, which is what keeps the marketplace run and the
history reconciliation from overlapping.

**Admin surfaces are separate from browsing, and the destructive one is separated
from the rest.** The Data page (`/admin/data`) holds the only sync controls. Each
kind also has a **Clear all** button, which deletes that scraper's table outright. It
is refused with a 409 while that kind is being scraped, so a delete cannot race an
in-flight run, and it resets that kind's `sync_state` row. The two kinds are not
equivalent to clear: the marketplace's incremental run breaks on the first item it
already has, so an empty table has none and it re-walks every page and refills itself
in about a minute; history's incremental run only ever fetches the first page, so a
cleared ledger stays empty until a full backfill is started by hand. Clearing history
is the expensive one by orders of magnitude.

**Sync is locked and admin-only.** Scraping the upstream API is by far the most
expensive thing the app does. A cron runs only the incremental `latest` mode, once a
minute — it stops as soon as it meets an item already stored with the same
`created_at`, so on an idle upstream it is roughly one request that finds itself
already up to date. Full backfills are admin-triggered and uncapped: both scrapers
walk until the upstream returns a short page, which it does rather than clamping the
offset. Nothing is held open over an HTTP request: a trigger takes a lock, returns
202, and the UI polls. If a deploy kills a run mid-flight it is marked `interrupted`
on the next boot rather than spinning forever.

**`CRON_ENABLED` gates the scheduler, and with it every button's reason to exist.**
The flag defaults on and only the exact string `false` turns it off — a typo leaves the
scheduler running, which is the safer of the two failures. Off means this process is
API-only: no timers at all, not merely a slower one, so the daily pending re-check stops
too. That is what the flag is *for* on Voroa, where syncing belongs to a separate
service.

With the scheduler off, an admin browsing a list page has no background job refreshing
what they are looking at, so both the marketplace and history lists offer a **Sync Latest**
button in the header. It is gated on admin *and* on the scheduler being off, and it is
admin-gated almost for free: `cronEnabled` rides on the existing admin-only
`/api/admin/sync/status` response, which the list views already fetch, so a non-admin
never receives the flag. The button carries a `loaded` guard because `cronEnabled` is
`undefined` before the first response arrives, and reading that as "off" would flash the
control at every visitor on page load.

**The daily pending re-check is measured from a watermark, not from the clock.**
`sync_state.last_pending_at` records when a `pending` run last finished, and only a
pending run may write it — `last_finished_at` cannot answer the question, because the
incremental cron rewrites it every minute and takes the run's mode with it. The scheduler
then checks that column on a 15-minute ticker and starts a re-check when the watermark is
24 hours old or absent.

Both obvious alternatives are wrong, and the reason is the same in each: `@every 24h` is
measured from when the *process* started, so it resets on every deploy and never fires at
all on a container redeployed more often than daily, while a wall-clock `0 0 * * *` would
fire at midnight whether or not the last run had finished. Neither is "24 hours since the
last pending run". This is also why it is a ticker rather than a `cron.Schedule`: `Next`
takes no context and returns no error, which is the wrong shape for a query. A watermark
in the future means the clock moved backwards, and reads as due rather than as "not yet" —
the watermark is stamped from the same process clock, so it cannot be a standing
disagreement between two machines.

The check is coarse on purpose: the work is measured in hours when it is due at all, so 15
minutes of granularity costs 96 single-row lookups a day, almost all of which do nothing.
A run that cannot start — because one is already in flight, or because the enqueue failed
— leaves the watermark where it was, so it stays due and the next tick picks it up. That
is what stops one busy minute from costing a whole day, and it is also why the watermark
is stamped on failure: a permanently failing job that reset the clock on success would
never run at all, and one that reset it every few minutes would hammer an upstream where
every request costs real capacity.

**History's third mode reads its worklist from the database, not the market.**
`pending` re-checks every transfer not yet recorded claimed, and it finds them with
`WHERE NOT claimed` rather than by walking the ledger. The upstream has no
"unclaimed" filter — `market/token-transfers` takes only `limit` and `offset` — so the
only way to identify pending transfers by reading it would be to fetch every page and
discard the ~98% that are already settled; the table already knows. For each one, the only
question worth asking the market is whether the token is still listed, which
`nft/item-detail` answers as 200-with-an-owner or 400. So the cost is one `item-detail`
call per *unclaimed* transfer rather than per transfer — and because claimed is
overwhelmingly the normal state, that is roughly a fiftieth of a full backfill.

The worklist is read with a **keyset** cursor, and that is load-bearing rather than a
preference: the run sets `claimed = true` as it goes, so the unclaimed set shrinks
underneath it. `OFFSET 500 LIMIT 500` would step over the rows that fell into the band
it had already read and silently never check them.

What this mode deliberately cannot do is correct the transfer's own fields. `item-detail`
returns no `seller_id`, `buyer_id`, `item_name`, `tx_hash`, `currency` or transfer time,
so a change to any of those is only picked up by `full`, which is the one path that
re-reads `market/token-transfers`. It also cannot revisit a claimed row: those are
considered settled, since their detail answers 400 forever and can teach nothing. The
`claimed` value it writes is always safe, because it only ever writes over rows that are
currently false — every write is either a real transition or a no-op. Sold state is
reconciled at the end regardless, because `MarkItemsSold` reads the whole ledger rather
than what the walk touched.

**The lock has no TTL, by design.** `LockService` is an in-process mutex with a
compare-and-delete release, so a holder can only ever free its own lock. The keys
never expire because the lock is released in a `defer`, and a lock cannot outlive
the process that took it. (This corrects an earlier claim that the lock had a
renewing TTL; it never did.) Crash recovery is durable, not in-memory:
`sync_state.running_since` is non-null exactly while a run holds the lock, and boot
marks any row found in that state `interrupted`.

**Every timestamp in the ledger is UTC, and the upstream's are not.** The transfer
log returns a bare `YYYY-MM-DD HH:mm:ss` with no offset, and it is KST — the same
+09:00 that `item-detail` spells out in `mintTime`. Reading it as UTC would store
every transfer 9 hours ahead, which puts some in the future and skews the sold-state
join that compares a transfer against its listing's `created_at`. The two fields that
do carry a zone are honoured rather than assumed. `ParseTransferTime` defaults
`+09:00` only when the payload omits a designator.

**Deduplication is the lock, not a queue.** The lock key is `sync:<kind>`, so two
triggers of the same kind contend whether they arrive at this process or another, and
a cron tick that lands while the previous run is still going joins it instead of
starting a second scrape. State lives in one row per kind (`sync_state`), which
replaced an append-only `sync_jobs` table that grew every tick and had to be pruned.

**The scheduler runs the two kinds in sequence, marketplace first.** `Enqueue` is
fire-and-forget — it takes the lock, writes `running`, and returns — so the scheduler
awaits each kind's `Wait` before starting the next. The order is a correctness
requirement: history derives sold state from the transfer ledger, and if history ran
while the marketplace scraper had not yet inserted the item row a transfer refers to,
the join would match nothing and, because the transfer was then stored, no later run
would ever look at it again — the item would stay on sale permanently.

## Item lifecycle

**Sold state is a timestamp, and the transfer ledger is the only thing that writes it.**
`marketplace_items.sold_at` is null while an item is on the market and set to the
sale's own `created_at` once it leaves. There is no `sold` boolean to disagree with
it. `sold_price` rides along from the same row.

**Sold is derived, never inferred.** Each history run ends with
`MarkItemsSold`, a single `UPDATE` joining `marketplace_items` against
`marketplace_token_transfers`. The join is deliberately **table-wide** rather than
scoped to the transfers that run just fetched: `RefreshLatest` breaks on the first
transfer it already holds, so a scope built from "the fresh ones" would never revisit
a transfer whose item row did not exist at the time. Re-deriving from the whole
ledger is a hash join on an indexed `token_id` that makes that whole class of miss
unrepresentable. `sold_at IS NULL` in the predicate makes it a no-op once a row is
marked, and pins `sold_at` to the first sale observed. `price > 0` excludes mints and
zero-value hand-offs.

This replaced an inference that read "a detail fetch returned nothing, so it must be
sold". That fetch swallowed every error, so a 5xx, a 429 and a DNS blip were all
indistinguishable from a delisted token and were persisted as a sale — and it only ran
for items whose `created_at` had changed, so real sales were missed too. The
reconciliation reads only the ledger and cannot make that mistake.

**Browse shows live items only; item detail does not.** The list and both
`GetDistinct*` filters are served by a partial index
(`created_at DESC WHERE sold_at IS NULL`) that the planner uses directly, which is
why the default sort is a dedicated query rather than a `CASE` in `ORDER BY` — a
`CASE` would make the index unusable. `GetByTokenID` is deliberately *not* filtered,
so a deep link to a sold item still resolves and renders as "sold out" rather than
404ing.

**A relisted item is the same token under a new `item_id`.** `token_id` is unique, so
a lookup by `id` alone misses the existing row and the insert trips the unique index.
`UpsertFromApi` matches on either key and keeps the original row, clearing `sold_at`
only when the match came from `token_id` (the relist case). A plain re-scrape of a
sold item deliberately leaves `sold_at` alone: otherwise every marketplace run would
resurrect it until history caught up. Because a relist keeps its old sale in the
ledger, the join requires `transfer.created_at >= item.created_at` — without it the
very next run would re-sell the new listing from the previous one, and `sold_at` would
end up earlier than `created_at`.

**Known gap: delisted is not sold.** A seller cancelling a listing produces no
transfer, so such an item keeps a null `sold_at` and stays listed. Covering that needs
a `last_seen_at` column plus a full-inventory walk to spot listings that vanished from
the upstream list without a sale. Not implemented.

**Transient scraper failures are retried.** A run retries DNS failures, connection
resets and 408/425/429/5xx three times with backoff, and does not retry anything
that would fail identically on a second try. Once an HTTP status has been received
the verdict is made on the status alone; a cancelled context is never retried.
Re-running is safe because both scrapers upsert by a stable key.

**Sessions live in PostgreSQL**, keyed by a random token whose SHA-256 hash is
stored, in an httpOnly `Secure` `SameSite=Strict` cookie. The hash is hex and matches
what the previous implementation wrote, so every browser signed in before the rewrite
stays signed in. There is no password to hash and no account to create: a session only
ever comes from a verified Google ID token.

**Favorites are per-account.** Every lookup is scoped by `account_id`, so another
user's favorite id is indistinguishable from a missing one — a 404, never a 403. The
update path distinguishes "field absent" from "field is null" so a rename leaves the
saved filters intact and an explicit null clears one field without touching the rest.

**Browsing is public; only favorites and admin sync need a session.** The guards are
opt-in per route group: only `/api/favorites` (`Guards.Required`) and
`/api/admin/sync` (`Guards.Admin`) apply one. The client guard in `router/index.ts`
fails closed: a route is gated unless it carries `meta.public`.

## Deployment

The target is **Voroa** (getvoroa.com) — a GitHub-native PaaS that builds this
repository into a container in India and terminates HTTPS in front of it.

Deploys go through `apps/api/Dockerfile`: a `node:22` stage builds the SPA, a
`golang:1.26` stage builds the API, and a slim runtime carries both. Voroa's
automatic build cannot do this — pointed at `apps/api` it sees `go.mod`, concludes
"Go service", and provisions Go alone, with no Node and no pnpm.

**[docs/DEPLOY-VOROA.md](docs/DEPLOY-VOROA.md) is the runbook**, and it is the only
place the dashboard settings are written down: the service settings, environment
variables, database creation or import, Google sign-in, and how to read the
deploy log. Settings are deliberately not duplicated here, because two copies of
a configuration that has to be right on the first try will eventually disagree.
