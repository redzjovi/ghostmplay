import { config as loadEnv } from 'dotenv'
import { createHash } from 'crypto'
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

/**
 * dotenv does not override variables already present in the environment, so a
 * real env var always wins over the file. On cPanel the Application Manager's
 * Environment Variables table is such a variable, which is why a `.env` file is
 * optional there. The module-relative fallback covers hosts that run the app from
 * a working directory that is not the application root.
 */
loadEnv({ path: findUp('.env', cwd) ?? join(__dirname, '..', '..', '.env') })

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
 * Where the built web app lives, if it has been built. In production this is the
 * `public/` directory of the release artifact. In development it is usually served by
 * Vite instead, but these candidates let the API serve it if you prefer one origin:
 * apps/api/public (a copy), or apps/web/dist straight from the workspace.
 *
 * The module-relative candidate is the one that matters in production: cPanel's
 * Passenger controls the working directory, so resolving against `cwd` alone is a
 * guess. Relative to the compiled file it is `apps/api/public` in the workspace and
 * `release/public` in the artifact — correct in both, with nothing to configure.
 */
const webRootCandidates = [
  process.env.WEB_ROOT,
  resolve(cwd, 'public'),
  join(__dirname, '..', '..', 'public'),
  findUp('dist', resolve(cwd, 'apps/web')),
].filter((p): p is string => typeof p === 'string' && p.length > 0)

/**
 * Google sign-in. All three are optional and read without `required()` on purpose:
 * an absent value must not stop the API from booting, otherwise upgrading would
 * break every deployment that has not configured Google yet. When any of them is
 * missing the feature is simply off and the button is hidden.
 *
 * GOOGLE_REDIRECT_URI is explicit rather than derived from a public base URL
 * because it has to match the Cloud Console entry byte for byte, and a wrong host
 * only fails at Google's end, after the user has already been redirected away.
 */
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim()
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI?.trim()

/**
 * Who is allowed to be an admin, as verified Google addresses. Comma-separated,
 * compared case-insensitively because that is how addresses behave.
 *
 * This is the *only* thing that grants admin — there is no password account left —
 * so an empty list means the deployment can never have one. main.ts warns about that
 * rather than failing: an operator may deliberately run this read-only for a while,
 * but they need to be told, not left wondering why /admin/data 403s.
 *
 * Safe to derive authority from an address because the ID token is only accepted
 * when `email_verified` is true, Google guarantees a single account holds any given
 * address, and this value is chosen by whoever has the environment anyway.
 */
const googleAdminEmails = (process.env.GOOGLE_ADMIN_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

/**
 * HMAC key for the signed OAuth `state`. Falls back to a key derived from the
 * client secret so there is no third mandatory secret to provision; the explicit
 * variable exists for rotating the state key without rotating the OAuth client.
 */
const googleStateSecret = process.env.GOOGLE_OAUTH_STATE_SECRET?.trim()
  || (googleClientSecret
    ? createHash('sha256').update(`gm-oauth-state\0${googleClientSecret}`).digest('hex')
    : undefined)

export const env = {
  isProd,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: optionalInt('PORT', process.env.PORT, 8080),
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),

  /**
   * cPanel puts LiteSpeed in front of the app, which forwards the real client IP in
   * X-Forwarded-For. Without this, req.ip is the proxy and rate limiting is useless.
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
   * Google is the only way in: the password form, the register endpoint and the
   * ADMIN_USERNAME / ADMIN_PASSWORD bootstrap are all gone.
   */
  google: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    redirectUri: googleRedirectUri,
    stateSecret: googleStateSecret,
    /** Verified addresses allowed to hold role='admin'. Empty = nobody. */
    adminEmails: googleAdminEmails,
    /** All three are needed before the endpoints will do anything. */
    enabled: Boolean(googleClientId && googleClientSecret && googleRedirectUri && googleStateSecret),
  },

  logApi: process.env.LOG_API === '1',
  logQuery: process.env.LOG_QUERY === '1' || process.env.TYPEORM_LOGGING === 'true',
} as const
