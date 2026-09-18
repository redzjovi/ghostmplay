# ghostmplay — Windows desktop marketplace

**Stack:** `Electron 33 + electron-vite + Vue 3 (Pinia/Router) + NestJS 10 (TypeORM 0.3 + better-sqlite3)`

- **Direct hit ghostmplay API** (reverse-engineered from DevTools) -> normalize -> SQLite (`ghostmplay.db` in `app.getPath('userData')` prod, `./ghostmplay.db` dev).
- DB schema mirrors `note.txt` (5 entities): `marketplace_items`, `marketplace_item_detail`, `marketplace_item_attributes`, `marketplace_item_datas`, `marketplace_item_infos`.

## Develop on Linux (ship Windows later)

**Node:** use `Node 22` (see `.nvmrc:1`, `ABI 127`). `Node 24` (`ABI 130`) fails with `better-sqlite3@9.6.0` — now upgraded to `better-sqlite3@13.0.3` + `@electron/rebuild`. Electron 33 embeds `Node 20.18.3` but `modules 130` (ABI 130), so native must be rebuilt for Electron.

```bash
nvm use 22.23.2   # or `nvm use` reads .nvmrc
pnpm install     # postinstall runs `electron-rebuild -w better-sqlite3` automatically
# if you see `NODE_MODULE_VERSION 127 requires 130` or `Unable to connect to the database`:
pnpm rebuild     # or pnpm exec electron-rebuild -f -w better-sqlite3
pnpm dev          # electron-vite dev (Electron on Linux, HMR for main/preload/renderer + Nest AppContext)
pnpm build        # electron-vite build (no installer, verifies on Linux)
pnpm typecheck    # vue-tsc + tsc node
# Windows installer (needs wine locally OR CI):
pnpm build:win    # electron-builder --win --config electron-builder.yml (NSIS -> dist/*.exe)
```

`better-sqlite3` native is rebuilt via `electron-rebuild` (`package.json:10`); `asarUnpack` in `electron-builder.yml` keeps it outside asar.

## Configure ghostmplay API (paste later)

Set in main process env (`.env` or shell) before `pnpm dev`:

```bash
export GHOSTMPLAY_API_BASE="https://real.api.host"
export GHOSTMPLAY_API_HEADERS_JSON='{"Authorization":"Bearer ...","Cookie":"..."}'
```

Edit `src/main/modules/marketplace/api/ghost-marketplace.client.ts:18-35` paths/params to match real `GET /marketplace/items` and `GET /marketplace/items/:tokenId` seen in DevTools `Copy as cURL`. `SyncService` normalizer (`src/main/modules/marketplace/sync.service.ts:17`) will adapt once real JSON shape is known.

## Project layout

```
src/main/            Electron main + NestJS (AppModule, TypeORM)
  database/data-source.ts
  modules/marketplace/entities/*.entity.ts
  modules/marketplace/*.service.ts + api/ + sync.service.ts
src/preload/         contextBridge window.api
src/renderer/src/    Vue 3 SPA (router, stores, views, mock/data.ts)
src/shared/types.ts  MarketplaceItem types (single source)
electron.vite.config.ts / electron-builder.yml
```

## Next: paste real API

Paste one `Copy as cURL` for list + one for detail (method, URL, headers, query). Then `list()`/`detail()` paths and `SyncService` field mapping (`token_id` etc) can be finalized without changing Vue.
