import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/api/src/**/*.spec.ts', 'apps/web/src/**/*.spec.ts'],
    // config/env.ts throws at import time when DATABASE_URL is unset, and
    // auth.controller.spec.ts imports a controller. No test opens a connection,
    // so a syntactically valid dummy is enough to keep the suite hermetic — it
    // also means the suite passes on a build box that has no .env, which is
    // exactly the case for the cPanel deploy gate in scripts/release.mjs.
    env: {
      DATABASE_URL: 'postgres://ghostmplay:ghostmplay@127.0.0.1:5432/ghostmplay_test',
    },
    coverage: {
      provider: 'v8',
      include: ['apps/api/src/modules/marketplace/**/*', 'packages/shared/src/**/*'],
    },
  },
  resolve: {
    alias: {
      '@ghostmplay/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
})
