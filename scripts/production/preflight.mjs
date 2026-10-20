// READ-ONLY preflight for applying migrations 021–030 to a database
// (production). It never writes: everything runs inside a READ ONLY
// transaction that is rolled back. It reports, per check, OK / INFO /
// STOP (STOP = a migration would fail or needs a decision first).
// The checks themselves are in preflight-checks.mjs.
//
//   PREFLIGHT_DB_URL='postgresql://…' PREFLIGHT_DB_SSL_CA=certs/supabase-prod-ca.crt \
//     node scripts/production/preflight.mjs
//
// The connection string is read from the environment only — never from a
// file in this repository. Run it yourself; the staging scripts' guard
// deliberately refuses production, and so does every other tool here.
//
// TLS: the server certificate is VERIFIED against PREFLIGHT_DB_SSL_CA (the
// project's CA certificate from the Supabase dashboard; see
// docs/DATABASE_SSL.md). Without it the preflight refuses to connect, unless
// PREFLIGHT_ALLOW_UNVERIFIED_TLS=1 is set (encrypted, but not verified).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadMigrations, runChecks } from './preflight-checks.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const url = process.env.PREFLIGHT_DB_URL
if (!url) {
  console.error('Set PREFLIGHT_DB_URL to the database connection string (read-only checks only).')
  process.exit(1)
}
const host = (() => { try { return new URL(url).hostname } catch { return '(unparsable URL)' } })()
const local = /^(localhost|127\.0\.0\.1)$/.test(host)
let ssl = false
let tlsNote = 'local database (no TLS)'
if (!local) {
  const ca = process.env.PREFLIGHT_DB_SSL_CA
  if (ca) {
    const caPath = resolve(ROOT, ca)
    if (!existsSync(caPath)) {
      console.error(`PREFLIGHT_DB_SSL_CA file not found: ${caPath}`)
      process.exit(1)
    }
    ssl = { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true, servername: host }
    tlsNote = 'encrypted, server certificate verified'
  } else if (process.env.PREFLIGHT_ALLOW_UNVERIFIED_TLS === '1') {
    ssl = { rejectUnauthorized: false }
    tlsNote = 'encrypted, server certificate NOT verified (PREFLIGHT_ALLOW_UNVERIFIED_TLS=1)'
  } else {
    console.error('Set PREFLIGHT_DB_SSL_CA to the project CA certificate (docs/DATABASE_SSL.md), or PREFLIGHT_ALLOW_UNVERIFIED_TLS=1 to connect without verifying the server.')
    process.exit(1)
  }
}
// sslmode in the URL would override the ssl object — strip it.
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl })
await client.connect()
let rows
try {
  await client.query('begin read only')
  await client.query(`set local statement_timeout = '30s'`)
  console.log(`Connected to ${host} — ${tlsNote} — read-only transaction.\n`)
  rows = await runChecks(async (sql, params = []) => (await client.query(sql, params)).rows, loadMigrations(join(ROOT, 'supabase', 'migrations'), join(ROOT, 'supabase', 'adaptations')))
  rows.unshift({ status: ssl && ssl.rejectUnauthorized ? 'OK' : local ? 'INFO' : 'INFO', check: 'Connection security', value: tlsNote, note: '' })
} finally {
  await client.query('rollback').catch(() => {})
  await client.end()
}

const width = Math.max(...rows.map((r) => r.check.length))
for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.check.padEnd(width)}  ${r.value}${r.note ? `\n${' '.repeat(width + 8)}${r.note}` : ''}`)
const stops = rows.filter((r) => r.status === 'STOP')
console.log(stops.length ? `\n✖ ${stops.length} item(s) to resolve before migrating.` : '\n✔ Nothing blocks migrating; read the INFO lines.')
process.exit(stops.length ? 2 : 0)
