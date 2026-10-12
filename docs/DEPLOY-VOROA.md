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

This path is ungated and answers 503 when the database is unreachable. That is
deliberate: it means Voroa reports the service as failed rather than live when
the app cannot actually do its job, instead of reporting a green process that
502s on every request.

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

The API serves the SPA when a build is present beside it. To include it, the
build command needs to build the web app first and the web app needs its shared
types.

The cleanest way to keep this simple is to build the web app separately and have
Voroa serve it, OR to widen the build command. Because the web app is a pnpm
project and the API is a Go module in the same repository, the practical options
are:

- **Two services** (a web service for the Go API and a static site for the
  built SPA). Clean separation, but two deploys to keep in step, and the session
  cookie needs `SameSite=None; Secure` because the SPA is then cross-origin.
- **One service**, with a build command that builds both and copies the web
  output next to the binary. This is what the local `release` path used to
  produce, and it keeps the cookie first-party.

This document does not prescribe one. The code supports both; the choice is
operational. Whichever you pick, set the Google redirect URI and the session
cookie policy to match.

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