import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/api/src/**/*.spec.ts', 'apps/web/src/**/*.spec.ts'],
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
