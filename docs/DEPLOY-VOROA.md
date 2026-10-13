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
- **Root directory**: `apps/api`. This is the whole Go module. Voroa builds from
  this directory and finds `go.mod` there.

  Leave this set. If it is empty, Voroa will not find the module and the deploy
  fails with "did not find the file your language uses to declare its
  dependencies".
- **Build command**: `go build -trimpath -o bin/api ./cmd/api`
- **Start command**: `./bin/api`

You do not need a Dockerfile. Voroa detects Go from `go.mod` and installs the
toolchain itself.

**`sqlc` is not run on the platform.** The generated query code is committed at
`apps/api/db/sqlc`, so the build needs nothing but Go. If you change a query,
run `make generate` locally and commit the result.

## 4. Health check

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

`PORT` is assigned by the platform and read automatically; do not set it. The
process binds `0.0.0.0`, which is what the platform's router requires.

`WEB_ROOT` is only needed if you serve the SPA from a different origin than the
API. The recommended setup is a single origin, in which case it is unset and the
built `public/` beside the binary is found automatically — but only if you also
build the web app. See the next step.

## 6. Serving the web app from the same service (recommended)

The API serves the SPA when a build is present beside the binary. Without one it
runs API-only, which is a valid mode — but then step 4's health check is the
only thing standing between you and the 503 abort above.

**Use one service.** It keeps the session cookie first-party, so `SameSite=Strict`
still works and sign-in needs no CORS exceptions. Set the **Build Command** to:

```bash
pnpm install --frozen-lockfile && pnpm --filter @ghostmplay/web build \
  && rm -rf public && cp -r ../../apps/web/dist public \
  && go build -trimpath -o bin/api ./cmd/api
```

That installs the workspace (the SPA needs `packages/shared` types, which live
in this repository), builds the SPA, copies the output to `public/` — which is
the first path the API checks — and only then builds the binary. Keep the start
command as it is.

The paths are relative to the build root, `apps/api`, so the SPA output is two
levels up. Get that wrong and `cp` fails; that is fine, but note it is the
easiest thing to get wrong here, and a failing build is a much clearer signal
than the 503 below.

This needs Node and pnpm in the build image. If Voroa's Go build image has
neither, use the two-service option below rather than trying to install a
toolchain in a build step.

**Two services**, if the build image cannot build the SPA: deploy a separate
static site for `apps/web/dist`. Two deploys to keep in step, and because the
origins differ the session cookie needs `SameSite=None; Secure` plus a
corresponding `CORS_ORIGINS` entry. Set the Google redirect URI to match.

Whichever you pick, set the Google redirect URI and the cookie policy to match.

## 7. First deploy

Press Deploy. Watch the deploy log. The build is one `go build`. Then the
service starts and, unless `MIGRATIONS_RUN=false`, applies any pending
migration.

If the deploy fails:

| Symptom | Cause | Fix |
|---|---|---|
| "did not find go.mod" | Root directory is wrong | Set it to `apps/api`. |
| "build failed" at `go build` | A compile error, or the module was not committed | Read the build log; `make check` locally. |
| "failed to start", nothing listening | Wrong start command, or a crash on boot | The runtime log has the reason. Check `DATABASE_URL` first — a wrong one fails the boot ping. |
| Live but every request 502s | The database is unreachable | `curl /api/health`; it returns 503 with `database: down`. |
| `Deploy aborted - your service did not pass its health check`, but `/api/health` is 200 | The check points at `/` and no web build is deployed | Point the check at `/api/health`. See step 4. |
| `no web build found; serving the API only` | The build command did not produce `apps/api/public` | Add the SPA build to the build command, see step 6. The log lists every path searched. |
| Sync fails, log says `cause=upstream` with `upstream_status=400` | The upstream is refusing us, not our bug | Check `market-api.numine.io`; the log carries their error in `upstream_said`. Nothing to fix here. |
| Sync fails, log says `cause=internal` | Our bug | Read the `error` field. |
| `/admin/data` 403s | `GOOGLE_ADMIN_EMAILS` is empty | Add the verified address and sign in again. |

## 8. Adopting an existing database

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

## 9. Redeploying

Push to the deployment branch. Auto-deploy (on by default) builds and swaps.
A failed build or a crash keeps the previous version serving.

For a manual redeploy, use the Deploy button in the dashboard.

## 10. Things that are specific to this app

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