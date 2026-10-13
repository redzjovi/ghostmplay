# Deploying to Voroa

This is the deploy path for the Go rewrite. It replaces the previous cPanel
runbook; the artifact is a Go binary built by the platform from source, so
almost none of what that document described still applies.

Voroa builds your repository, runs it in a container, and puts HTTPS in front of
it. You supply a repository, a branch, a build command, a start command, and
environment variables. Everything else is its job.

## 0. What you need

- A Voroa workspace with a plan that allows one web service and one database.
  The Free plan allows both.
- A Google OAuth 2.0 Web application client. The redirect URI is known in
  advance once you have the service name — see step 5.

Nothing else. There is no Node.js requirement for the API, no `pnpm install` in
the build, and no database extension to install.

## 1. Get the code onto a branch

The Go API lives in `apps/api`. Everything below assumes the deployment branch
has been pushed.

```
git push origin <branch>
```

Name the branch the same one Voroa has configured under **Settings → Source →
Branch**. Voroa builds that branch and ignores pushes to every other one, so a
correct deploy of a commit that was pushed to the wrong branch looks exactly
like no deploy at all.

If more than one local branch has your work — `master` and `go` both did at one
point — check which is ahead before deploying:

```
git log --oneline origin/<branch>..HEAD
```

Anything listed there is not on the platform yet.

## 2. Decide what to do about the database

You have two options, and the difference is whether you keep the data you have
already scraped.

### Option A — import the existing cPanel database (keeps your data)

Voroa can import an existing PostgreSQL database by connection string, with no
`pg_dump` in between. See the platform's import guide. Use the connection string
your cPanel database currently answers on.

This is the option to choose if you want to keep the marketplace items, the
transfer history and the accounts you have already collected.

### Option B — start fresh

Create a new Voroa PostgreSQL database and let the baseline migration build the
schema from nothing. The service then populates itself on the first sync.

Either way the end state is identical: `db/migrations/000001_baseline` creates
the same nine tables, indexes and constraints that the old TypeORM migrations
produced, which is checked by the test suite.

## 3. Create the web service

From the dashboard: **New → Web Service**.

- **Repository / branch**: the repository and the branch you just pushed.
- **Root directory**: `/` — the **repository root**, not `apps/api`.

  This is the setting that makes the build work. The image builds both the SPA
  and the Go binary, and the web build needs the workspace manifest, the lockfile
  and `packages/shared`, all of which sit outside `apps/api`. With the root
  directory set to `apps/api` the build context contains only the Go module and
  the first `COPY` fails.

  It also changes what Voroa detects. Pointed at `apps/api` it sees `go.mod`,
  concludes "this is a Go service", and provisions Go alone — no Node, no pnpm —
  which is why an earlier attempt failed with `pnpm: command not found`.
- **Runtime**: **Docker (Dockerfile)**.
- **Dockerfile path**: `/apps/api/Dockerfile`.

  The path is chosen at creation and cannot be changed afterwards, so it has to
  be right the first time. `/Dockerfile` will not find it.
- **Build command**: leave **empty**.
- **Start command**: leave **empty**.

  The image's `CMD` starts the binary, and Voroa ignores these fields for a
  Docker runtime.

### What the Dockerfile gives you

`apps/api/Dockerfile` pins both toolchains — `node:22` for the SPA and
`golang:1.26` for the API — which the build-command approach could not do. It
also removes the per-deploy `go: downloading go1.26.5` you see in a build log:
the version comes from the base image rather than being fetched because the
platform's Go is older than `go.mod` requires.

Node 22 is not incidental. `packageManager` pins `pnpm@11.6.0`, and pnpm 11
requires Node 22+; `@vueuse/core` declares `engines.node >=22`. On Node 20 the
install cannot succeed.

### Health checks under Docker

**The Health Check Path field has no effect here.** Voroa cannot assume anything
is present inside an image it did not build, so for a Docker runtime it waits
according to the image's own `HEALTHCHECK`:

| Dockerfile declares | Readiness decided by |
|---|---|
| a `HEALTHCHECK` | that check; a container reporting unhealthy fails the deploy |
| no `HEALTHCHECK` | something accepting a connection on the port |

Ours runs `/app/bin/api -healthcheck`, which issues a real request against
`/api/health` and exits non-zero when the database is unreachable — stricter
than a TCP connect, and it needs no `curl` in the image. Without it, a service
that started but cannot reach its database would look healthy.

### Switching an existing service

Runtime and Dockerfile path are fixed at creation, so moving an existing service
onto this image means **creating a new one**. It gets a new URL; re-enter the
environment variables, the domain and the redirect URI from step 5.

You can keep the old service running until the new one passes its health check,
then delete it.

## 4. Health check

**Under the Docker runtime this field is ignored.** Readiness comes from the
image's `HEALTHCHECK`, which the Dockerfile provides. See step 3.

The rest of this section applies only if you deploy without Docker, where
setting it correctly does matter.

Set the **Health Check Path** to `/api/health`.

**Do not set it to `/`.** That is the single most common way this deploy fails,
and it fails in a way that looks like the application is broken. With no web
build beside the binary, `/` answers **503** with a diagnostic page explaining
exactly that; the platform reads a non-200 on `/` as an unhealthy service and
aborts the deploy, even though the API is running perfectly. The log line
`Deploy aborted - your service did not pass its health check` is what this
produces.

`/health` is also registered and is equally valid. Both are ungated and answer
503 when the database is unreachable — deliberate, so Voroa reports the service
as failed rather than live when the app cannot actually do its job, instead of
reporting a green process that 502s on every request.

If you build the web app as well (step 6), `/` serves the SPA and can be used,
but point the check at `/api/health` anyway: it tests the API without depending
on the frontend being deployed.

**Check this field before anything else when a deploy aborts.** The cost of
getting it wrong is high and the fix is instant. A probe on `/` with no web
build does not fail fast — Voroa waits out the entire startup window before
giving up, so the deploy spends a couple of minutes doing nothing before
reporting the same error either way. In the log it looks like this:

```
migrations up to date
listening ... port=3000       ← healthy, 157ms later
...                           ← two minutes of serving requests, then:
Deploy aborted - your service did not pass its health check.
```

The service was never broken. It was answering 503 on the one path that is
meant to refuse, and the platform believed it.

### Reading the probe log

A health probe never reaches a route that used to log anything, so an abort left
no record of what was actually asked. It is now logged, which makes the cause
readable from the deploy log instead of inferred:

| Log line | What it means |
|---|---|
| `health checks answer on these paths api=/api/health root=/health siteRoot=503` | Printed at boot. Compare against the setting above. |
| `served the no-web-build page at the site root ... status=503` | The probe hit `/`. Point the health check at `/api/health`. |
| `no route matched and there is no web build to fall back to ... status=404` | The probe hit a path this service does not serve — a typo, or a trailing slash. |
| `health check reporting unhealthy: database unreachable` | The probe hit a health path and the database was genuinely down. |

**If an aborted deploy contains none of these**, the probe never reached the
process at all, which points at the port or at routing rather than the path.

`/health` and `/api/health` both answer 200 whenever the database is reachable,
so either is a valid setting.

## 5. Environment variables

Set these on the service, not in a file. Values are stored encrypted and are
never shown back.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | The connection string for your database. |
| `DATABASE_SSL` | if the URL has no `sslmode` | `true` for a managed database. |
| `GOOGLE_CLIENT_ID` | to sign in | |
| `GOOGLE_CLIENT_SECRET` | to sign in | |
| `GOOGLE_REDIRECT_URI` | to sign in | `<origin>/api/auth/google/callback` |
| `GOOGLE_ADMIN_EMAILS` | to have any admin | Verified address, comma-separated. |
| `MIGRATIONS_RUN` | no | Leave unset so migrations run on boot. |
| `CRON_ENABLED` | no | Leave unset so the scheduler syncs every minute. `false` makes the deployment API-only — nothing syncs on a timer, only on request from the admin panel. |

`PORT` is assigned by the platform and read automatically; do not set it. The
process binds `0.0.0.0`, which is what the platform's router requires.

`WEB_ROOT` is only needed if you serve the SPA from a different origin than the
API. The recommended setup is a single origin, in which case it is unset and the
built `public/` beside the binary is found automatically — but only if you also
build the web app. See the next step.

## 6. Serving the web app

The API serves the SPA from `public/` when it is present, and runs API-only when
it is not. Under the Docker runtime in step 3 this is already handled: the image
builds the SPA and copies it to `/app/public` beside the binary, so the home
page is the app and no `WEB_ROOT` is needed.

Nothing about this is automatic if you leave the Docker runtime. With a
build-command setup instead, the command would have to build both:

```bash
pnpm install --frozen-lockfile && pnpm --filter @ghostmplay/shared build \
  && pnpm --filter @ghostmplay/web build \
  && rm -rf public && cp -r ../../apps/web/dist public \
  && go build -trimpath -o bin/api ./cmd/api
```

`shared` must be built before `web`: `@ghostmplay/shared` resolves `main` and
`types` to `./dist`, and `apps/web` imports it, so building `web` against an
unbuilt `shared` produces a bundle with unresolved types rather than a build
error. The Dockerfile does the same, in the same order.

This alternative is recorded rather than recommended. It cannot pin the Node
version — Voroa provisions Node only for services it detects as Node projects —
and it leaves the `go1.26.5` download in place.

### Why one service rather than two

Serving the SPA from the API keeps the session cookie first-party, so
`SameSite=Strict` still applies and sign-in needs no CORS exceptions. A separate
static site means two deploys to keep in step, and because the origins differ the
cookie then needs `SameSite=None; Secure` plus a matching `CORS_ORIGINS` entry.

If you do split them, set the Google redirect URI and the cookie policy to
match.

### One caveat about the health check

Once the SPA is served, **any extensionless path returns 200** — `/marketplaces`
is a client-side route and correctly resolves to `index.html`. A probe aimed at a
mistyped path would pass without ever touching the API.

So keep probing `/api/health`. It is the only path that tests the database rather
than the existence of a file.

## 7. First deploy

Press Deploy. Watch the deploy log. The build is one `go build`. Then the
service starts and, unless `MIGRATIONS_RUN=false`, applies any pending
migration.

If the deploy fails:

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm: command not found` | Root directory is `apps/api`, so Voroa detected Go and provisioned no Node or pnpm | Set Root directory to `/` and use the Docker runtime, step 3. |
| `Your base image requires...` / `COPY failed: no such file` | Root directory is not the repository root, so the context lacks the workspace manifest | Same as above. |
| `failed to start`, nothing listening | `DATABASE_URL` wrong, or a crash on boot | The runtime log has the reason. A bad database fails the boot ping before anything listens. |
| `Deploy aborted...` and the container is `unhealthy` | The image's `HEALTHCHECK` failed — usually the database | `docker logs` on the equivalent local build shows why; the same `error` field appears at runtime. |
| Live but every request 502s | The database is unreachable | `curl /api/health`; it returns 503 with `database: down`. |
| `no web build found; serving the API only` | `/app/public` is missing from the image | The web stage did not run. Check the build log for the `pnpm` step. |
| Sync fails, log says `cause=upstream` with `upstream_status=400` | The upstream is refusing us, not our bug | Check `market-api.numine.io`; the log carries their error in `upstream_said`. Nothing to fix here. |
| Sync fails, log says `cause=internal` | Our bug | Read the `error` field. |
| `/admin/data` 403s | `GOOGLE_ADMIN_EMAILS` is empty | Add the verified address and sign in again. |

## 8. Why a deploy feels slow

Almost always it is not the build, and the log says so. Compare these two lines:

```
migrations up to date
listening ... port=3000          ← 384ms later
```

The service is up almost immediately. If the deploy *still* fails, it spent its
whole window waiting on a health probe that was never going to pass, and
`Deploy aborted` arrives minutes later — which reads like a slow build and is
actually a slow failure. Check the health check path first; it is the single
most common cause and costs nothing to verify.

Measured on this repository, for scale:

| Stage | Time |
|---|---|
| `go build` (cold, no cache) | 23s |
| `go build` (warm) | 2s |
| Module download | reused while `go.sum` is unchanged |
| Boot to listening | under 0.5s |

To keep it that way:

- **Keep the build command to one `go build`.** Running the test suite in the
  build step roughly doubles the minutes each deploy costs, and the suite is
  already run before anything is pushed.
- **Commit `go.sum`.** Voroa reuses installed dependencies while the lockfile is
  unchanged; a missing or frequently-edited lockfile reinstalls them every
  deploy. It is committed.
- **Add build filters** under Build & Deploy so that editing this file, or a
  README, does not trigger a full build of a Go service.
- **Leave the binary unstripped for now.** `-ldflags="-s -w"` would take it from
  22M to 16M, which saves well under a second against a 23s compile. Only worth
  it if the build stops being the bottleneck.

There is no build-cache setting exposed for the standard runtime. If the build
ever does become the bottleneck, the escape hatch is the Docker runtime with
`RUN --mount=type=cache,target=/root/.cache/go-build`, which turns a 23s cold
build into 2s — a larger change than it is worth for a service this size.

## 9. Adopting an existing database

If you imported the cPanel database (option A), that database already has the
schema and will also carry TypeORM's own bookkeeping. The baseline migration
must be marked as applied **without** running it, because the structure is
already there.

Run this once, as a one-off job against the imported database:

```
migrate -path db/migrations -database "$DATABASE_URL?sslmode=require" force 1
```

`force` records the version without executing anything. Afterwards the service's
own `MIGRATIONS_RUN` finds nothing pending and boots normally. This path is
verified by the test suite, which migrates two databases — one through the old
TypeORM chain, one through the baseline — and diffs them.

If you have `migrate` installed locally you can run it from `apps/api` with
`make migrate-force VERSION=1`.

## 10. Redeploying

Push to the deployment branch. Auto-deploy (on by default) builds and swaps.
A failed build or a crash keeps the previous version serving.

For a manual redeploy, use the Deploy button in the dashboard.

## 11. Things that are specific to this app

### One process

The sync orchestrator uses an in-memory lock per sync kind, and so does the
per-address rate limiter. Both assume one process. Voroa runs one container per
service, which satisfies that by default — **but scaling the service to two
instances breaks both silently.** If you ever scale out, the sync lock needs to
move into Postgres (the `sync_state.running_since` column is already the right
shape for it).

### Idle sleep

Free-tier services are stopped when idle and restarted on the next request. That
is invisible to the app except for the per-minute sync, which only runs while
the process is up. On a plan where the service sleeps, the incremental sync
effectively runs only when the site is being used. A paid instance, or a
scheduled task hitting `/api/.../sync` on a timer, keeps it running.

### The browser-facing check

Sign-in is Google-only. If `/api/auth/providers` returns `googleEnabled: false`,
the environment variables have not been set, and the boot log says so.