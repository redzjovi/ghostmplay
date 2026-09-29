import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Consume the shared DTOs straight from TypeScript source — no build step
      // between editing a type and seeing it reflected here.
      '@shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    // This directory is what gets copied into the API image at /app/public.
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Hashed filenames under assets/ get the immutable Cache-Control from
    // ServeStaticModule; index.html is revalidated every time.
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    // Local dev talks to the API on 8080. In production the SPA is served by the
    // API container itself, so this proxy is dev-only.
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
})
