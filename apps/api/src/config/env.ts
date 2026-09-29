import { config as loadEnv } from 'dotenv'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

/**
 * Finds the nearest match by walking up from the working directory.
 *
 * `pnpm dev` runs the API from apps/api, but the repo's .env lives at the root.
 * A single fixed path would break every workspace-local run; walking up means the
 * closest file wins, so apps/api/.env can still override the root one.
 */
function findUp(name: string, startDir: string): string | undefined {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const cwd = process.cwd()

// dotenv does not override variables already present in the environment, so a
// real env var always wins over the file.
loadEnv({ path: findUp('.env', cwd) })

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return trimmed
}

function optionalInt(name: string, value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const isProd = process.env.NODE_ENV === 'production'

/**
 * Where the built web app lives, if it has been built. In production this is
 * baked into the image at /app/public. In development it is usually served by
 * Vite instead, but these candidates let the API serve it if you prefer one
 * origin: apps/api/public (a copy), or apps/web/dist straight from the workspace.
 */
const webRootCandidates = [
  process.env.WEB_ROOT,
  resolve(cwd, 'public'),
  findUp('dist', resolve(cwd, 'apps/web')),
  '/app/public',
].filter((p): p is string => typeof p === 'string' && p.length > 0)

export const env = {
  isProd,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: optionalInt('PORT', process.env.PORT, 8080),
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),

  /**
   * DomCloud sits behind NGINX, which forwards the real client IP in X-Forwarded-For.
   * Without this, req.ip is the proxy and rate limiting is useless.
   */
  trustProxy: (process.env.TRUST_PROXY ?? '1') as 1 | 0 | number | string | boolean,
  /** Comma-separated list of allowed CORS origins. Empty/absent = same-origin only (recommended). */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Where the web build lives, if it has been built. */
  webRoot: webRootCandidates.find((p) => existsSync(p)),

  /**
   * Seeded once on first boot if no admin exists yet, so the env vars can be
   * removed afterwards. Registration itself stays open to everyone.
   */
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,

  /** Valkey/Redis for rate limiting. Absent means rate limiting is disabled. */
  redisUrl: process.env.REDIS_URL,

  logApi: process.env.LOG_API === '1',
  logQuery: process.env.LOG_QUERY === '1' || process.env.TYPEORM_LOGGING === 'true',
} as const
