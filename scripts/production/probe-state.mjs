// READ-ONLY probe of the production database state, to settle what the preflight could not:
//   1. which of migrations 015–020 are really in place (history says 001–014 only), per migration:
//      applied / absent / PARTIAL, with the exact objects found and missing;
//   2. the duplicate-serial groups, so each can be decided (serial, table, status, whether it has an
//      assignee, last update, history rows). No assignee NAMES and no other personal data are printed.
// Same safety as the preflight: one READ ONLY transaction, verified TLS, rolled back, nothing written.
//
//   PREFLIGHT_DB_URL='postgresql://…' PREFLIGHT_DB_SSL_CA=certs/supabase-ca-2021.crt node scripts/production/probe-state.mjs
// (use scripts/production/run-preflight.ps1 -Task probe, which asks for the password without storing it)
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadMigrations } from './preflight-checks.mjs'
import { duplicateSerialDetails, reconcile } from './migration-state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const url = process.env.PREFLIGHT_DB_URL
if (!url) { console.error('Set PREFLIGHT_DB_URL (the launcher script does this for you).'); process.exit(1) }
const host = (() => { try { return new URL(url).hostname } catch { return '(unparsable URL)' } })()
const local = /^(localhost|127\.0\.0\.1)$/.test(host)
let ssl = false
if (!local) {
  const ca = process.env.PREFLIGHT_DB_SSL_CA
  if (!ca || !existsSync(resolve(ROOT, ca))) { console.error('PREFLIGHT_DB_SSL_CA must point to the CA certificate; refusing to connect without verifying the server.'); process.exit(1) }
  ssl = { ca: readFileSync(resolve(ROOT, ca), 'utf8'), rejectUnauthorized: true, servername: host }
}
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl })
await client.connect()
const q = async (sql, params = []) => (await client.query(sql, params)).rows
try {
  await client.query('begin read only')
  await client.query(`set local statement_timeout = '30s'`)
  console.log(`Connected to ${host} — read-only transaction${local ? '' : ', server certificate verified'}.\n`)

  // ---- 1. migrations 001–020
  const migrations = loadMigrations(join(ROOT, 'supabase', 'migrations'), join(ROOT, 'supabase', 'adaptations'))
  const hasHistory = (await q(`select to_regclass('supabase_migrations.schema_migrations') is not null as e`))[0].e
  const recorded = hasHistory ? (await q(`select version from supabase_migrations.schema_migrations order by version`)).map((r) => r.version) : []
  const plan = await reconcile(q, migrations, recorded)
  console.log('MIGRATIONS 001–020 (what is really in place):')
  for (const p of plan) {
    const label = { recorded: 'recorded in history', record: 'IN PLACE, history row missing  -> record only', apply: 'ABSENT                         -> apply', stop: 'PARTIAL                        -> STOP, look by hand' }[p.action]
    if (p.action === 'recorded') continue
    console.log(`  ${p.version}  ${p.name.replace(/^\d+_/, '').replace('.sql', '').padEnd(42)} ${label}`)
    if (p.present.length || p.missing.length) console.log(`           present: ${p.present.join('; ') || '—'}\n           missing: ${p.missing.join('; ') || '—'}`)
    if (p.note) console.log(`           NOTE: ${p.note}`)
  }
  console.log(`  (recorded in history: ${plan.filter((p) => p.action === 'recorded').length} of ${plan.length})\n`)

  // ---- 2. duplicate serials
  const rows = await duplicateSerialDetails(q)
  const groups = [...new Set(rows.map((r) => r.key))]
  console.log(`DUPLICATE SERIALS: ${groups.length} groups / ${rows.length} devices (027 keeps all of them and lists them; nothing is merged or deleted).`)
  groups.forEach((g, i) => {
    console.log(`  group ${i + 1}: serial "${g}"`)
    for (const r of rows.filter((x) => x.key === g)) console.log(`     ${r.tbl.padEnd(18)} status=${String(r.status).padEnd(10)} assigned=${r.assigned ? 'yes' : 'no '} last-updated=${new Date(r.updated).toISOString().slice(0, 10)} history-rows=${r.history}${r.serial !== g ? `  (stored as "${r.serial}")` : ''}`)
  })
} finally {
  await client.query('rollback').catch(() => {})
  await client.end()
}
console.log('\nDone. Nothing was written to the database.')
