#!/usr/bin/env node
// Builds the deployment artifact for cPanel's Application Manager (Passenger).
//
//   release/app.js        Passenger's startup file — it looks for exactly this name
//   release/dist/         compiled API (apps/api/dist)
//   release/public/       built SPA (apps/web/dist), served by the API via WEB_ROOT
//   release/node_modules/ production dependencies only, no toolchain
//   release/tmp/          touch tmp/restart.txt to restart the running app
//
// The artifact is self-contained: nothing outside it is needed at runtime, so the
// checkout on the box can be a plain `git clone` with no knowledge of pnpm.
//
// Checks run before the build, deliberately. The app boots migrations on every
// restart and there is no CI between a commit and production, so a broken typecheck
// or a failing test has to fail here, in the terminal, rather than as a 502 later.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = join(REPO_ROOT, 'release');

// `npm_execpath` points at the pnpm that is actually running this script, which
// keeps `pnpm release`, `npx pnpm release` and `corepack pnpm release` all working
// on a box where pnpm is not on PATH. A .cjs shim is run through the current node
// binary; a real binary is executed directly.
const PNPM_EXECPATH = process.env.npm_execpath;

function pnpm(args) {
  const useNode = PNPM_EXECPATH && /\.[cm]?js$/.test(PNPM_EXECPATH);
  const result = useNode
    ? spawnSync(process.execPath, [PNPM_EXECPATH, ...args], { cwd: REPO_ROOT, stdio: 'inherit' })
    : spawnSync(PNPM_EXECPATH ?? 'pnpm', args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function step(message) {
  console.log(`\n==> ${message}`);
}

// shared is built before the gate, not after it: the API's typecheck resolves
// `@ghostmplay/shared` through that package's emitted dist/index.d.ts, so on a
// fresh clone — which is exactly what the build box has — a gate that ran first
// would fail on seven unrelated "cannot find module" errors.
step('build shared');
pnpm(['--filter', '@ghostmplay/shared', 'build']);

step('gate: typecheck');
pnpm(['typecheck']);

step('gate: test');
pnpm(['test']);

step('build web');
pnpm(['--filter', '@ghostmplay/web', 'build']);

step('build api');
pnpm(['--filter', '@ghostmplay/api', 'build']);

step('assemble release/');
rmSync(RELEASE_DIR, { recursive: true, force: true });

// `pnpm deploy` resolves the workspace package `@ghostmplay/shared` into a real
// copy and installs production dependencies only, which is what makes the
// artifact independent of the monorepo. Requires injectWorkspacePackages in
// pnpm-workspace.yaml. The target must not exist yet, hence the rm above.
pnpm(['--filter', '@ghostmplay/api', '--prod', 'deploy', RELEASE_DIR]);

cpSync(join(REPO_ROOT, 'apps/api/dist'), join(RELEASE_DIR, 'dist'), { recursive: true });
cpSync(join(REPO_ROOT, 'apps/web/dist'), join(RELEASE_DIR, 'public'), { recursive: true });

// `pnpm deploy` copies the whole API package, and apps/api has no `files` field, so
// the TypeScript sources and build configs come along. Nothing at runtime reads
// them: migrations run from the compiled dist/, and the migration CLI needs the
// devDependencies that `--prod` deliberately left out.
for (const unused of ['src', 'nest-cli.json', 'tsconfig.json', 'tsconfig.build.json']) {
  rmSync(join(RELEASE_DIR, unused), { recursive: true, force: true });
}

writeFileSync(join(RELEASE_DIR, 'app.js'), "require('./dist/main.js')\n");

// Passenger watches this directory for restart.txt; nothing else goes in it.
mkdirSync(join(RELEASE_DIR, 'tmp'), { recursive: true });

console.log(`
release/ is ready.

Next, in cPanel:
  Application Manager -> create an application with
    Application root       <repo>/release
    Application startup    app.js
    Node.js version         22.x
    Application mode        Production

  Environment variables (Application Manager table, not a file):
    NODE_ENV=production
    DATABASE_URL=postgres://USER:PASS@127.0.0.1:5432/DB
    GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI / GOOGLE_ADMIN_EMAILS

  See docs/DEPLOY-CPANEL.md for the .htaccess settings Passenger needs and
  for how to restart after this or any later deploy.
`);