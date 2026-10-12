# Deploying to cPanel

Target: **shared hosting running cPanel with Node.js Selector** (CloudLinux +
LiteSpeed + Passenger), plus cPanel's own PostgreSQL.

There is no Docker here and no proxy to configure. Everything below follows from
that: the whole application is one Node process that Passenger spawns and that
serves both the API and the built SPA, and the only shared service is the database
on the same box.

For how the code is laid out and why, see the [README](../README.md). This
document is the procedure.

---

## 0. Before anything else — the two checks that can end the project

### 0.1 Node.js 22

cPanel → **Application Manager** → *Create Application*. The Node.js version
list is populated by what the host has installed, and on AlmaLinux that means the
`ea-nodejs22` package. Without it the list stops at 20 and the app cannot run —
it needs Node 22 (`engines` in `package.json`).

```bash
ls /opt/cpanel/       # ea-phpNN, ea-nodejsNN — which versions exist?
node -v
which corepack        # ships with Node 22; section 2.1 forks on this
```

### 0.2 PostgreSQL, and no extension required

cPanel → **PostgreSQL Database Wizard** → create a database and a user, and make
that user an owner of the database. That is the whole setup.

**No Postgres extension is required, and the user needs no privileges beyond
creating tables in its own database** — which is what cPanel grants by default.
There is no `CREATE EXTENSION` step and no superuser requirement.

An earlier version of this application depended on two:

| Extension | What needed it | Why it is gone |
|---|---|---|
| `pg_trgm` | GIN + `gin_trgm_ops` indexes so `LOWER(name) LIKE '%term%'` could be an index lookup | Measured against the real data, the planner never chose them: scanning a few hundred rows beats consulting an index, and a full history backfill brings the transfers table to roughly 13,000 rows, where a sequential scan is still single-digit milliseconds |
| `citext` | a case-insensitive `account_identities.email` column | Nothing compares that column in SQL. Identity is keyed on Google's `sub`, no unique constraint covers email, and the one case-insensitive comparison in the app — the `GOOGLE_ADMIN_EMAILS` allowlist — normalises with `toLowerCase()` in TypeScript before comparing |

That mattered far beyond tidiness. `CREATE EXTENSION` in the first migration meant
a hosting account without permission to install an extension could not run
migrations **at all**: an optimisation nobody was paying for was blocking every
deployment. See `apps/api/src/database/migrations/1790656354000-SearchIndexes.ts`
and `apps/api/src/database/migrations/1790854290511-GoogleIdentities.ts` for the
reasoning in place.

Revisit if the transfers table passes ~100k rows, at which point a trigram index
is worth asking the host to install `postgresql-contrib` again.

---

## 1. Get the code onto the server

```bash
mkdir -p ~/ghostmplay
```

cPanel → **Files → Git™ Version Control → Create a Repository**, pointing at
`/home/YOURUSER/ghostmplay`, with the repository

```
git@github.com:redzjovi/ghostmplay.git
```

and branch **`nestjs`**. For a **private** repository, add an SSH deploy key in
cPanel → **Security → SSH Keys** first. Cloning over SSH by hand in Terminal
works just as well if you would rather not use the panel.

---

## 2. Install pnpm and build the artifact

### 2.1 Install pnpm

Node 22 ships corepack, which installs exactly the version `package.json` pins
(`"packageManager": "pnpm@11.6.0"`) — so there is nothing to keep in sync with the
lockfile by hand.

```bash
mkdir -p ~/.local/bin
corepack enable --install-directory ~/.local/bin pnpm
export PATH="$HOME/.local/bin:$PATH"
pnpm --version          # 11.6.0
```

`corepack enable pnpm` on its own fails here: it writes the shim next to the
`corepack` binary, which lives under the root-owned `/opt/cpanel` install, and
there is nowhere to put it. `--install-directory ~/.local/bin` writes it somewhere
you own instead.

The first `pnpm` run downloads that version into `COREPACK_HOME` (default
`~/.cache/node/corepack`), so that path has to be writable — set
`export COREPACK_HOME=~/.corepack` if it is not.

If `which corepack` from section 0.1 came back empty, that Node build has no
corepack. Use npm instead:

```bash
npm config set prefix ~/.npm-global
npm install -g pnpm@11.6.0
export PATH="$HOME/.npm-global/bin:$PATH"
```

That writes to your own `~/.npmrc`, which is a different file from the
repository's `.npmrc` (the one holding `node-linker=hoisted`). Nothing in the
repository changes.

Not installing anything is fine too: `npx --yes pnpm@11.6.0 <command>` runs the
same version every time, without persisting it.

### 2.2 PATH, or why it does not matter

Each cPanel Terminal is a fresh login shell, so the `export` above disappears when
the session ends. Add it to `~/.bashrc`, then check that the profile actually
reads it:

```bash
grep -n bashrc ~/.bash_profile
```

It only ever affects your shell. **Passenger never runs pnpm** — `release/` is
plain files plus a `node_modules` — so if PATH will not stick, call the absolute
path (`~/.local/bin/pnpm release`) and the running site is unaffected either way.

### 2.3 Disk, before the first build

The first `pnpm install` writes about 164 MB of dev `node_modules`, plus the pnpm
content-addressable store, and then the 136 MB `release/`.

```bash
df -h ~ && du -sh ~/.local/share/pnpm 2>/dev/null
```

`df` reports the filesystem, not your per-account quota, so the disk-usage figure
in the cPanel panel is the number that actually matters. If space is tight,
`pnpm store prune` after a successful build, or move the store with
`pnpm config set store-dir <path>`.

### 2.4 Build

```bash
cd ~/ghostmplay
pnpm install --frozen-lockfile
pnpm release
```

Two things that pre-empt the usual questions. `--frozen-lockfile` makes pnpm
**fail** rather than rewrite the lockfile if `package.json` and `pnpm-lock.yaml`
disagree, which is what you want on a server. And postinstall scripts are already
permitted by the `allowBuilds` list in `pnpm-workspace.yaml`, so pnpm 11 will not
prompt — there are no native modules in the tree, so no compiler is needed here
either.

`pnpm release` leaves a self-contained directory:

```
release/
  app.js          Passenger's startup file — it looks for this exact name
  dist/           compiled API
  public/         built SPA, served by the API from WEB_ROOT
  node_modules/   production dependencies only, no toolchain, no native binaries
  tmp/            touch tmp/restart.txt to restart the running app
```

Nothing outside `release/` is needed at runtime, so the checkout can stay exactly
as Git left it.

---

## 3. Create the application

Application Manager → **Create Application**:

| Field | Value |
|---|---|
| Application root | `/home/YOURUSER/ghostmplay/release` |
| Application URL | your domain |
| Application startup file | `app.js` |
| Node.js version | `22.x` |
| Application mode | `Production` |

Passenger assigns the port itself and routes every request for the domain to that
one process, so there is nothing to proxy and no port to choose.

---

## 4. Environment variables

Use the Application Manager's **Environment Variables** table, not a file. Those
entries are written into the application's `.htaccess` as `PassengerEnvVar`, and
they take precedence over a `.env` file, because dotenv does not overwrite
variables that already exist.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgres://USER:PASS@127.0.0.1:5432/DB` |
| `GOOGLE_CLIENT_ID` | Cloud Console → OAuth client |
| `GOOGLE_CLIENT_SECRET` | Cloud Console → OAuth client |
| `GOOGLE_REDIRECT_URI` | see the next section |
| `GOOGLE_ADMIN_EMAILS` | your verified address — empty means nobody can reach `/admin/data`, ever |

Leave `PORT` alone: Passenger assigns it. Leave `WEB_ROOT` alone:
`release/public` is found relative to the application, whatever the working
directory turns out to be.

---

## 5. Google sign-in

Sign-in is Google-only — there is no password account and no register endpoint —
so these four variables are the difference between a working site and one nobody
can sign in to. `main.ts` warns at boot if any of the first three is missing.

### 5.1 The redirect URI

It must be a full URL, and it has to be set in **two** places that agree exactly:

```
https://YOURDOMAIN/api/auth/google/callback
```

That path is not a guess: it is `@Controller('api/auth')` plus
`@Get('google/callback')` in `apps/api/src/modules/auth/controllers/auth.controller.ts`,
with no global prefix in front of it. No trailing slash, and the scheme must be
the one your site actually serves on.

1. **Google Cloud Console** → your OAuth 2.0 client → **Authorized redirect
   URIs** → add that URL verbatim.
2. **cPanel** → Application Manager → Environment Variables →
   `GOOGLE_REDIRECT_URI` = the same string.

Then restart the application (`touch release/tmp/restart.txt`, or the **Restart**
button). The value is read once at boot, so editing it does nothing until the app
restarts.

In the Console, also add the origin under **Authorized JavaScript origins** —
`https://YOURDOMAIN`, no path.

The value appears twice in the code on purpose: `authorizeUrl()` sends it as
`redirect_uri` when bouncing to Google, and `authenticate()` sends the same value
again when exchanging the code. Google rejects the exchange if it differs from
the authorize request, so one value used twice is what has to match.

### 5.2 Admin

`GOOGLE_ADMIN_EMAILS` is the **only** thing that grants admin. It is compared
case-insensitively and re-evaluated on every sign-in, so adding an address grants
admin at that person's next sign-in and removing one revokes it at theirs. Left
empty, visitors can sign in but nobody can reach `/admin/data`.

### 5.3 Checking it without a browser

```bash
curl -s https://YOURDOMAIN/api/auth/providers
```

`{"googleEnabled":true}` proves all four variables are set — `enabled` is the
conjunction of the client id, secret, redirect URI and state secret, so a `false`
means one of them is empty without you having to guess which.

| What you see | Cause |
|---|---|
| `{"googleEnabled":false}` | one of the four Google variables is empty; `main.ts` names the missing one at boot |
| Google shows *Error 400: redirect_uri_mismatch* | the Console entry differs from `GOOGLE_REDIRECT_URI` by scheme, host (`www` vs apex), trailing slash, or path |
| The callback redirects to `/login?oauth=oauth_state` | not a redirect-URI problem — the signed state failed, i.e. `GOOGLE_OAUTH_STATE_SECRET` changed mid-flow |
| Signed in, but `/admin/data` 403s | `GOOGLE_ADMIN_EMAILS` is empty, or does not contain that exact verified address |
| *oauth_throttled* on the login page | more than 30 sign-in attempts from that IP in 10 minutes |

If you serve both `yourdomain.com` and `www.yourdomain.com`, only the URL in
`GOOGLE_REDIRECT_URI` will work — it holds one string. Register both in the
Console if you like, but pick one to send.

---

## 6. Pin the app to one process

The Application Manager writes its own `.htaccess` when you create the
application. Add these to it, below the cPanel lines:

```apache
PassengerMinInstances 1
PassengerMaxInstances 1
Options -Indexes
```

This is load-bearing, not tidiness. Equal min/max disables Passenger's dynamic
process scaling, and this app depends on being a single instance: the sync mutex
and the sign-in throttle are per-process singletons, so a second instance would
scrape the same public endpoint twice and hand each IP two rate-limit budgets.
`MinInstances 1` also keeps the process resident, so the every-minute sync cron
keeps running on a quiet site.

**Re-check these after changing the application in Application Manager — it
rewrites the file.**

---

## 7. Never press "Run NPM Install"

Application Manager offers a button that runs `npm install` in the application
root. Do not use it. It reads the API's `package.json`, whose
`@ghostmplay/shared: workspace:*` cannot resolve outside the monorepo, and it
would only add a broken `node_modules` on top of the one the artifact already
has. `pnpm release` installs everything; nothing else is needed.

---

## 8. Verify the deploy

```bash
curl -s https://YOURDOMAIN/api/health      # {"status":"ok","database":"up",...}
curl -sI https://YOURDOMAIN/               # Cache-Control: public, max-age=3600
passenger-status                            # one instance, not a pool
```

Then, in a browser:

- hard-refresh a deep link like `/admin/data` — it must return `index.html`, not a
  404, because the SPA uses history-mode routing;
- sign in with Google and confirm the `gm_session` cookie is set;
- confirm a `latest` sync row appears in `sync_state` within a minute.

---

## Redeploying

```bash
cd ~/ghostmplay
git pull
pnpm install --frozen-lockfile
pnpm release
touch release/tmp/restart.txt
```

The `touch` is what makes Passenger re-read the artifact; nothing else restarts
it.

---

## Things that bite on shared hosting

- **Migrations run on every boot** (`migrationsRun` in `app.module.ts`). That is
  what makes a first deploy a single step, but it also means an app that cannot
  migrate can never start. Set `MIGRATIONS_RUN=false` and run `pnpm migration:run`
  by hand if you would rather see a migration failure in the terminal than as a
  502.
- **The first request after an idle period is slow.** With
  `PassengerMinInstances 1` the process stays warm; without it, expect a cold
  start on the next request.
- **There is no restart policy.** Passenger restarts the app when it dies, but a
  keepalive cron job (`*/5 * * * * curl -fsS https://YOURDOMAIN/api/health`)
  protects against hosts that reap idle applications.
- **Outbound HTTPS to `market-api.numine.io` is required** for the scraper. If
  sync returns nothing, check that the host allows outbound traffic first.

---

## When a deploy goes wrong

| Symptom | Where to look |
|---|---|
| 502 on every request | the Application Manager's log for that application — the app is crashing at boot, almost always a wrong `DATABASE_URL` |
| `/api/health` returns `database: down` | `DATABASE_URL`: host, port, and whether cPanel prefixes the database and user names |
| A route 500s only after a schema change | migrations failed at boot. Boot the artifact yourself in Terminal and read the error, rather than only the log tail |
| `googleEnabled: false` | a missing Google variable — `main.ts` names it |
| Sync never runs | confirm `PassengerMinInstances 1` is still in the `.htaccess`, and that `/api/health` is reachable, so the resident process is alive |
| `502` after editing the app in Application Manager | it rewrote the `.htaccess` — re-add the three lines from step 6 |