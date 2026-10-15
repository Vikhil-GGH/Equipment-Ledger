// Wipes all equipment data on STAGING and re-creates the standard
// synthetic data set, so every manual test round starts from the same
// known state. Accounts (and their roles) are kept.
//
//   npm run staging:reset             asks you to type the staging project ref
//   npm run staging:reset -- --large  same, plus 1,120 extra history rows
//
// Deletes, in one transaction: onboarding/offboarding checklists, the
// import log, every asset in all four collections, bulk stock, and (via
// their foreign keys) all history. Refuses to run against production
// (see lib.mjs) and asks for confirmation every time.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ROOT, connectStagingDb, fail, loadStagingEnv } from './lib.mjs'

const env = loadStagingEnv(['STAGING_DB_URL', 'STAGING_ADMIN_EMAIL'])

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question(
  `\nThis DELETES all equipment, checklists, imports and history on STAGING (${env.stagingRef}).\nType the staging project ref to continue: `,
)
rl.close()
if (answer.trim() !== env.stagingRef) fail('Not confirmed — nothing was changed.')

const db = await connectStagingDb(env)
let ok = false
try {
  await db.query('begin')
  // Order matters only for onboarding_checklists.assigned_asset_id, which
  // references active_laptops_np without cascade. History tables cascade
  // from their asset/item tables.
  // The employee register (20260901000026), when present, goes first: it
  // references bulk items and checklists. Employees are synthetic data too.
  const hasRegister = (await db.query(`select to_regclass('public.equipment_issues') is not null as yes`)).rows[0].yes
  for (const table of [
    ...(hasRegister ? ['equipment_issues'] : []),
    'onboarding_checklists',
    'offboarding_checklists',
    ...(hasRegister ? ['employees'] : []),
    'import_events',
    'serialized_assets',
    'active_laptops_np',
    'monitors',
    'other_equipment',
    'bulk_items',
  ]) {
    const { rowCount } = await db.query(`delete from ${table}`)
    console.log(`  cleared ${table} (${rowCount} rows)`)
  }
  await db.query('commit')
  ok = true
} catch (err) {
  await db.query('rollback').catch(() => {})
  console.error(`\n✖ Reset failed and was rolled back — staging is unchanged.\n  ${err.message}\n`)
} finally {
  await db.end()
}
if (!ok) process.exit(1)

console.log('\nRe-creating synthetic data…')
const seed = spawnSync(process.execPath, [join(ROOT, 'scripts', 'staging', 'seed-synthetic.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
process.exit(seed.status ?? 1)
