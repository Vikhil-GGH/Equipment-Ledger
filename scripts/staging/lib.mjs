// Shared helpers for the staging scripts (see docs/STAGING_SETUP.md).
//
// Every script loads its settings from .env.staging.local (gitignored) and
// REFUSES TO RUN if anything in it points at the production project named
// in .env. There is deliberately no flag to override that check.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const STATE_DIR = join(ROOT, '.staging-state')
// STAGING_ENV_FILE exists only so the scripts themselves can be tested
// against a throwaway local database; the production guard below still
// applies to whatever file it names.
const STAGING_ENV = process.env.STAGING_ENV_FILE ?? join(ROOT, '.env.staging.local')
const PROD_ENV = join(ROOT, '.env')

function parseEnvFile(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function projectRef(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url ?? '')
  return m ? m[1] : null
}

export function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

/**
 * Loads and validates .env.staging.local. `need` lists the variables the
 * calling script requires beyond the URL and anon key.
 */
export function loadStagingEnv(need = []) {
  if (!existsSync(STAGING_ENV)) {
    fail('.env.staging.local not found. Follow step 4 of docs/STAGING_SETUP.md to create it.')
  }
  const env = parseEnvFile(STAGING_ENV)
  for (const key of ['VITE_STAGING_SUPABASE_URL', 'VITE_STAGING_SUPABASE_ANON_KEY', ...need]) {
    if (!env[key] || env[key].includes('your-') || env[key].includes('<')) {
      fail(`${key} is missing or still a placeholder in .env.staging.local.`)
    }
  }

  const stagingRef = projectRef(env.VITE_STAGING_SUPABASE_URL)
  if (!stagingRef) fail('VITE_STAGING_SUPABASE_URL in .env.staging.local must look like https://<ref>.supabase.co')

  // ---- production guard -------------------------------------------------
  const prodRef = existsSync(PROD_ENV) ? projectRef(parseEnvFile(PROD_ENV).VITE_SUPABASE_URL) : null
  if (!prodRef) {
    fail('Could not read the production project from .env, so staging cannot be told apart from production. Refusing to run.')
  }
  const everything = Object.values(env).join('\n')
  if (stagingRef === prodRef || everything.includes(prodRef)) {
    fail(`.env.staging.local refers to the PRODUCTION project (${prodRef}). Refusing to run.`)
  }
  if (env.STAGING_DB_URL && !env.STAGING_DB_URL.includes(stagingRef)) {
    fail(`STAGING_DB_URL does not contain the staging project ref (${stagingRef}). Refusing to run.`)
  }

  ensureStateDir() // results/exports go here (git-ignored)
  console.log(`Staging project: ${stagingRef}   (production ${prodRef} is blocked)`)
  return { ...env, stagingRef, prodRef }
}

/**
 * TLS options for the direct database connection. With the project's CA
 * certificate (Database Settings -> SSL Configuration -> Download
 * certificate) the server is fully verified; without it the connection is
 * still encrypted but the server certificate isn't checked.
 */
export function sslOptions(env) {
  // A database on this machine (e.g. `supabase start`) has no TLS.
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(env.STAGING_DB_URL)) return false
  if (env.STAGING_DB_SSL_CA) {
    const caPath = join(ROOT, env.STAGING_DB_SSL_CA)
    if (!existsSync(caPath)) fail(`STAGING_DB_SSL_CA file not found: ${caPath}`)
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
  }
  console.warn('! STAGING_DB_SSL_CA not set: connection is encrypted but the server certificate is not verified.')
  return { rejectUnauthorized: false }
}

export async function connectStagingDb(env) {
  const { default: pg } = await import('pg')
  const { Client } = pg
  // sslmode in the URL would override the ssl object below — strip it.
  const connectionString = env.STAGING_DB_URL.replace(/[?&]sslmode=[^&]*/, '')
  const client = new Client({ connectionString, ssl: sslOptions(env) })
  await client.connect()
  return client
}

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
  return STATE_DIR
}
