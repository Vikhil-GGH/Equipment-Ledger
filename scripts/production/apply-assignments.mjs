// PRODUCTION assignment applier. Dry run by default (does everything, then rolls back); writes only with --execute.
//   node scripts/production/apply-assignments.mjs --confirm-project <ref> --change-list <change-list.json> --expect 51 [--execute]
// Run it only after the whole migration chain (through 035) is applied and the owner has approved this step.
// Connection: PRODUCTION_DB_URL and PRODUCTION_DB_SSL_CA from the launcher (run-assignments.ps1); the certificate is verified.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { applyAssignments } from './assignment-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1) }
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const execute = process.argv.includes('--execute')
const confirm = arg('--confirm-project')
const listPath = arg('--change-list')
const expect = Number(arg('--expect'))
if (!/^[a-z0-9]{20}$/.test(confirm ?? '')) fail('Give --confirm-project <the 20-character production project reference>.')
if (!listPath || !existsSync(listPath)) fail('Give --change-list <path to change-list.json>.')
if (!Number.isInteger(expect) || expect < 1) fail('Give --expect <the number of changes you approved>.')
const url = process.env.PRODUCTION_DB_URL
if (!url) fail('PRODUCTION_DB_URL is not set (use the launcher script).')
const u = new URL(url)
const ref = decodeURIComponent(u.username).split('.')[1]
if (ref !== confirm) fail(`The connection is for project "${ref}", not "${confirm}". Refusing.`)
const caPath = process.env.PRODUCTION_DB_SSL_CA ? resolve(ROOT, process.env.PRODUCTION_DB_SSL_CA) : null
if (!caPath || !existsSync(caPath)) fail('PRODUCTION_DB_SSL_CA must point to the CA certificate; the server certificate is always verified.')

const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true, servername: u.hostname } })
await client.connect()
const db = { query: async (sql, p) => { const r = await client.query(sql, p); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }, exec: async (sql) => { await client.query(sql) } }
let code = 0
try {
  console.log(`Production ${ref} @ ${u.hostname}: certificate verified. ${execute ? 'EXECUTE: will commit.' : 'DRY RUN: will roll back.'}`)
  const r = await applyAssignments(db, JSON.parse(readFileSync(listPath, 'utf8')), { expectCount: expect, execute })
  console.log(`✔ ${r.applied} assignments ${r.committed ? 'COMMITTED' : 'checked and rolled back (dry run)'}; device counts unchanged ${JSON.stringify(r.totals)}; respelled: ${r.respelled.join(' | ') || 'none'}`)
} catch (err) {
  console.error(`\n✖ ${err.message}\n`)
  code = 2
} finally {
  await client.end()
}
process.exit(code)
