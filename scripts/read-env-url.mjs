// Emits the components of a connection URL from .env as tab-separated
// URL_* lines, so the shell script can read them without any quoting games.
//
//   KEY=DATABASE_URL node scripts/read-env-url.mjs
//   URL_HOST<TAB>127.0.0.1
//   ...
import { readFileSync } from 'node:fs'

const key = process.env.KEY
if (!key) {
  console.error('KEY must be set')
  process.exit(1)
}

// Minimal dotenv: KEY=VALUE, # comments, optional surrounding quotes.
const env = Object.create(null)
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!m || m[1] in env) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  env[m[1]] = v
}

const raw = env[key]
if (!raw) {
  console.error(`missing ${key} in .env`)
  process.exit(1)
}

let url
try {
  url = new URL(raw)
} catch {
  console.error(`${key} in .env is not a valid URL: ${raw}`)
  process.exit(1)
}

const fields = {
  URL_HOST: url.hostname,
  // redis:// URLs omit the port; PostgreSQL's default is the more useful guess
  // for the missing case, and REDIS_URL callers always spell theirs out.
  URL_PORT: url.port || '5432',
  URL_USER: decodeURIComponent(url.username),
  URL_PASS: decodeURIComponent(url.password),
  URL_DB: decodeURIComponent(url.pathname.replace(/^\//, '')),
}

for (const [k, v] of Object.entries(fields)) {
  // A tab or newline in a credential would corrupt the framing; refuse rather
  // than silently mangle it.
  if (/[\t\n]/.test(v)) {
    console.error(`${k} contains a tab or newline, which this reader cannot represent`)
    process.exit(1)
  }
  console.log(`${k}\t${v}`)
}
