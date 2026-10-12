import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// The API is Go. These specs cover what the Go rewrite did not change: the web
// app's URL codec, formatters and adapters, plus the shared type contract.
//
// The API's own tests run through `go test` -- see the `test` script in
// package.json, which runs both. A single test command for the whole repo means
// neither suite can be quietly skipped.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/web/src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['apps/web/src/lib/**/*', 'packages/shared/src/**/*'],
    },
  },
  resolve: {
    alias: {
      '@ghostmplay/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
})