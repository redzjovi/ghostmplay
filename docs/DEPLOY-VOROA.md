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

**There is nothing to set.** Under the Docker runtime Voroa ignores the Health
Check Path entirely, because it cannot assume anything is present inside an image
it did not build. Readiness comes from the `HEALTHCHECK` in the Dockerfile, which
runs `/app/bin/api -healthcheck`.

That check requests `/api/health` and exits non-zero when the database is
unreachable, so a service that started but cannot do its job is reported as
failed rather than live. See step 3.

The probe log lines the API emits at boot -- `health checks answer on these paths`
and, when there is no web build, one line per probe -- are still worth reading
when a deploy aborts.

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

Press Deploy. Watch the deploy log. The build is the image from step 3: a Node
stage that installs the workspace and builds the SPA, a Go stage that compiles
the binary, and a runtime stage carrying both. Then the service starts and,
unless `MIGRATIONS_RUN=false`, applies any pending migration.

A clean build takes a few minutes the first time, most of it pulling the
`node:22` and `golang:1.26` images. The SPA stage alone is around 50s, and the
resulting image is about 100MB. Afterwards the manifest layers are cached, so a
change to one `.go` or one `.vue` file rebuilds only what that change touched.

**A failed health check costs more than it looks.** Voroa counts the whole
startup window towards your build minutes and holds a build slot while it waits,
so a probe that never passes is billed twice -- once waiting, once when you
redeploy. This service boots in about 150ms, so the default window is generous;
raising it makes failures slower, not faster.

If the deploy fails:

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm: command not found` | Root directory is `apps/api`, so Voroa detected Go and provisioned no Node or pnpm | Set Root directory to `/` and use the Docker runtime, step 3. |
| `Your base image requires...` / `COPY failed: no such file` | Root directory is not the repository root, so the context lacks the workspace manifest | Same as above. |
| `failed to start`, nothing listening | `DATABASE_URL` wrong, or a crash on boot | The runtime log has the reason. A bad database fails the boot ping before anything listens. |
| `Deploy aborted...` and the container is `unhealthy` | The image's `HEALTHCHECK` failed — usually the database | `docker logs` on the equivalent local build shows why; the same `error` field appears at runtime. |
| `no web build found; serving the API only` | `/app/public` is missing from the image | The web stage did not run. Check the build log for the `pnpm` step. |
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