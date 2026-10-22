// PRODUCTION migration applier. Nothing here runs unless the owner starts it, and it WRITES only with --execute.
//
//   (read-only plan, the default)   node scripts/production/apply-migration.mjs --confirm-project <ref>
//   record a migration already in place:  … --record 20260901000015 --execute
//   apply the next migration:             … --apply  20260901000019 --execute
//
// It exists because the Supabase CLI cannot run the documented 021 adaptation in the same transaction, and
// production's history table does not match its schema (015–020 are partly in place). The steps are the exact
// functions rehearsed on disposable databases (supabase/tests/db/production-chain.db.test.ts):
// strictly in order, one migration per transaction (adaptation included), history row written with it,
// a migration that is partly in place stops everything, an in-place one is recorded, never re-run.
//
// Connection: PRODUCTION_DB_URL (from the launcher, never a file) and PRODUCTION_DB_SSL_CA; the server certificate
// is verified. The project reference in the URL must equal --confirm-project.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadMigrations } from './preflight-checks.mjs'
import { applyStep, ensureHistoryTable, planChain, recordStep, rollbackStep } from './apply-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const ADAPTATIONS = join(ROOT, 'supabase', 'adaptations')
const ROLLBACKS = join(ROOT, 'supabase', 'rollback')
const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1) }
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const has = (name) => process.argv.includes(name)

const confirm = arg('--confirm-project')
const record = arg('--record')
const apply = arg('--apply')
const rollback = arg('--rollback')
const execute = has('--execute')
if (!/^[a-z0-9]{20}$/.test(confirm ?? '')) fail('Give --confirm-project <the 20-character production project reference>.')
if ([record, apply, rollback].filter(Boolean).length > 1) fail('One step at a time: use --record OR --apply OR --rollback.')
if (execute && !record && !apply && !rollback) fail('--execute needs --record, --apply or --rollback <version>.')
const url = process.env.PRODUCTION_DB_URL
if (!url) fail('PRODUCTION_DB_URL is not set (use the launcher script).')
const u = new URL(url)
const ref = decodeURIComponent(u.username).split('.')[1]
if (ref !== confirm) fail(`The connection is for project "${ref}", not "${confirm}". Refusing.`)
const caPath = process.env.PRODUCTION_DB_SSL_CA ? resolve(ROOT, process.env.PRODUCTION_DB_SSL_CA) : null
if (!caPath || !existsSync(caPath)) fail('PRODUCTION_DB_SSL_CA must point to the CA certificate; the server certificate is always verified.')

const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true, servername: u.hostname } })
await client.connect()
const db = { query: async (sql, params) => { const r = await client.query(sql, params); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }, exec: async (sql) => { await client.query(sql) } }
const migrations = loadMigrations(MIGRATIONS, ADAPTATIONS)
const sqlFor = (m) => readFileSync(join(MIGRATIONS, m.name), 'utf8')
const show = (plan) => {
  for (const p of plan) if (p.action !== 'recorded') console.log(`  ${p.version}  ${p.action.toUpperCase().padEnd(6)} ${p.name.replace(/^\d+_/, '').replace('.sql', '')}${p.missing.length ? '   missing: ' + p.missing.join('; ') : ''}${p.note ? '   NOTE: ' + p.note : ''}`)
  console.log(`  (${plan.filter((p) => p.action === 'recorded').length} already recorded)`)
}

let code = 0
try {
  console.log(`Production ${ref} @ ${u.hostname} — server certificate verified.${execute ? '' : ' READ-ONLY plan (no --execute).'}\n`)
  if (!execute) await client.query('begin read only')
  else await ensureHistoryTable(db)
  const plan = await planChain(db, migrations)
  console.log('Plan:')
  show(plan)
  const stops = plan.filter((p) => p.action === 'stop')
  if (stops.length) throw new Error(`STOP: ${stops.map((s) => s.version).join(', ')} is partly in place. Nothing will be run until it is understood.`)
  if (execute && rollback) {
    console.log(`
Executing: ROLLBACK ${rollback} …`)
    await rollbackStep(db, rollback, { rollbackDir: ROLLBACKS })
    console.log(`✔ ${rollback} rolled back and its history row removed.

Plan now:`)
    show(await planChain(db, migrations))
  } else if (execute) {
    const version = record ?? apply
    const step = plan.find((p) => p.version === version)
    if (!step) throw new Error(`Unknown migration ${version}`)
    if (record && step.action !== 'record') throw new Error(`${version} is "${step.action}", not "record": nothing to record.`)
    if (apply && step.action !== 'apply') throw new Error(`${version} is "${step.action}", not "apply".`)
    const next = plan.find((p) => p.action === 'record' || p.action === 'apply')
    if (next.version !== version) throw new Error(`Not the next step: ${next.version} (${next.action}) must be done first.`)
    console.log(`\nExecuting: ${record ? 'RECORD' : 'APPLY'} ${version} …`)
    if (record) await recordStep(db, migrations, version)
    else await applyStep(db, migrations, version, { sqlFor, adaptationsDir: ADAPTATIONS })
    console.log(`✔ ${version} done.\n\nPlan now:`)
    show(await planChain(db, migrations))
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`)
  code = 2
} finally {
  await client.query('rollback').catch(() => {})
  await client.end()
}
process.exit(code)
