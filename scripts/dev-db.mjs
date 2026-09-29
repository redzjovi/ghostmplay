#!/usr/bin/env node
// Local development database helper: the two things `docker compose` cannot do.
//
//   status   connect with the exact DATABASE_URL from .env, report schema state,
//            and — importantly — say precisely what is wrong if it cannot
//   reset    drop and recreate the database so migrations replay on next API boot
//
// It talks to the host-mapped port on purpose: authenticating over the container's
// unix socket would trust the container's own credentials and could not detect a
// mismatch with .env, which is the whole point of the check.
//
// Uses the `pg` driver already installed in apps/api rather than adding a
// dependency or requiring a psql binary on the host.

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Client } = createRequire(join(REPO_ROOT, 'apps/api/package.json'))('pg');

const MAINTENANCE_DB = 'postgres';
const CONNECT_TIMEOUT_MS = 5000;

// Tables worth reporting, in a sensible reading order. `to_regclass` lets a table
// that does not exist yet report as absent instead of throwing, so this list can
// name things across the sync_jobs -> sync_state rename without special casing.
const INTERESTING_TABLES = [
  'users',
  'accounts',
  'sessions',
  'marketplace_items',
  'marketplace_item_detail',
  'marketplace_token_transfers',
  'marketplace_favorites',
  'history_items',
  'sync_state',
  'sync_jobs',
];

/** Walk up from the repo root looking for the nearest .env, mirroring apps/api/src/config/env.ts. */
function findEnvFile() {
  let dir = REPO_ROOT;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readDatabaseUrl() {
  const envFile = findEnvFile();
  if (!envFile) {
    fail('No .env found above the repository root. Copy .env.example to .env and set DATABASE_URL.');
  }
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) {
    fail(`${envFile} has no DATABASE_URL. Copy .env.example to .env.`);
  }
  const value = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
  if (!value) fail(`DATABASE_URL in ${envFile} is empty.`);
  return value;
}

/** Never print a password, not even a redacted one that leaks its length. */
function describeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}:${u.port || 5432}/${u.pathname.replace(/^\//, '') || '(default)'}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exit(1);
}

/**
 * Translate a connection failure into the specific action that fixes it. The
 * generic "connection refused" tells you nothing; these tell you which of the
 * two sources of truth — the compose file's POSTGRES_* literals or DATABASE_URL
 * in .env — is the one that is wrong.
 */
function explainConnectionError(err, target) {
  const code = err.code;
  const hint = {
    ECONNREFUSED: () =>
      `Nothing is listening on that host/port. Run \`pnpm db:up\`, and check the port in DATABASE_URL matches the "ports:" mapping in docker-compose.dev.yml.`,
    ENOTFOUND: () => `Could not resolve that host. Use 127.0.0.1 in DATABASE_URL for local development.`,
    '28P01': () =>
      `Password rejected for ${target}.
       PostgreSQL applies POSTGRES_PASSWORD only when the data volume is FIRST initialised, so
       the password baked into the existing volume wins over the compose file. Either set
       DATABASE_URL in .env to match the compose file's POSTGRES_PASSWORD, or run
       \`pnpm db:nuke\` and \`pnpm db:up\` to re-initialise the volume with the new value.`,
    '28000': () => `Authentication rejected for ${target}. Check the user in DATABASE_URL against POSTGRES_USER in docker-compose.dev.yml.`,
    '3D000': () =>
      `The database in DATABASE_URL does not exist. Either use the POSTGRES_DB value from
       docker-compose.dev.yml, or run \`pnpm db:reset\` to create it.`,
    '42P04': () => `The database does not exist yet. Run \`pnpm db:reset\` to create it.`,
    '57P03': () => `The server is not accepting connections yet. It is probably still starting — retry in a moment.`,
    ETIMEDOUT: () => `Timed out after ${CONNECT_TIMEOUT_MS}ms. Check that the host/port in DATABASE_URL is reachable.`,
  }[code];

  fail(hint ? hint() : `${code || 'Error'}: ${err.message}`);
}

/**
 * `pg` gives `connectionString` precedence over individual options, so swapping
 * the database means building the config explicitly — otherwise you connect to
 * the very database you are trying to drop and PostgreSQL refuses (55006).
 */
async function connect(url, databaseOverride) {
  const target = describeTarget(url);
  const base = { connectionTimeoutMillis: CONNECT_TIMEOUT_MS };
  let client;
  if (databaseOverride) {
    const u = new URL(url);
    client = new Client({
      ...base,
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: databaseOverride,
    });
  } else {
    client = new Client({ ...base, connectionString: url });
  }
  try {
    await client.connect();
  } catch (err) {
    explainConnectionError(err, target);
  }
  return { client, target };
}

async function cmdStatus() {
  const url = readDatabaseUrl();
  const { client, target } = await connect(url);
  try {
    console.log(`  ✓ connected to ${target}`);

    const { rows: tableRows } = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`
    );
    const present = new Set(tableRows.map((r) => r.table_name));

    const counts = new Map();
    for (const table of INTERESTING_TABLES) {
      if (!present.has(table)) continue;
      const { rows } = await client.query(`select count(*)::int as n from "${table}"`);
      counts.set(table, rows[0].n);
    }

    if (present.has('migrations')) {
      const { rows } = await client.query('select count(*)::int as n from migrations');
      console.log(`    migrations applied: ${rows[0].n}`);
    } else {
      console.log('    migrations applied: 0  (schema not initialised — start the API)');
    }
    console.log(`    public tables:      ${present.size}`);

    if (counts.size === 0) {
      console.log('    no application tables yet — start the API to run migrations');
    } else {
      const pad = Math.max(...[...counts.keys()].map((t) => t.length));
      for (const [table, n] of counts) console.log(`    ${table.padEnd(pad)}  ${n}`);
    }

    // Both sync tables present at once means a migration is half-applied.
    if (present.has('sync_jobs') && present.has('sync_state')) {
      console.log('    ⚠ both sync_jobs and sync_state exist — a migration is half-applied');
    }
  } finally {
    await client.end();
  }
}

async function cmdReset() {
  const url = readDatabaseUrl();
  // Connect to the maintenance database so the target database can be dropped
  // even while the API holds connections to it.
  const { client } = await connect(url, MAINTENANCE_DB);
  const target = new URL(url);
  const database = target.pathname.replace(/^\//, '');
  if (!database) fail('DATABASE_URL does not name a database to reset.');

  try {
    const { rows: [existing] } = await client.query(
      'select 1 from pg_database where datname = $1',
      [database]
    );
    if (existing) {
      // WITH (FORCE) terminates remaining backends, so this succeeds even if
      // the dev API is still connected.
      await client.query(`drop database "${database}" with (force)`);
    }
    await client.query(`create database "${database}" template template0 owner "${target.username}"`);
    console.log(`  ✓ recreated database "${database}" (empty)`);
    console.log('    start the API to replay migrations');
  } finally {
    await client.end();
  }
}

const commands = { status: cmdStatus, reset: cmdReset };
const command = process.argv[2];
const handler = commands[command];
if (!handler) {
  console.error(`Usage: node scripts/dev-db.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
try {
  await handler();
} catch (err) {
  // A raw pg error dumps a stack trace that buries the one useful line. Surface
  // the SQLSTATE and its meaning instead.
  if (err?.code === '55006') {
    fail('The database is still open by another connection. Stop the dev API (`fuser -k 8080/tcp`) and retry.');
  }
  fail(`${err?.code || 'Error'}: ${err?.message || err}`);
}
