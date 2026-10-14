// Rebuilds the database schema on the STAGING project from
// supabase/migrations/, one migration per transaction (as the Supabase CLI
// does), with the two documented workarounds from supabase/adaptations/:
//   - after 017: add the missing ::user_role cast (017 can't create users)
//   - before 021: drop the two functions whose return type 021 changes
// Each applied migration is recorded in supabase_migrations.schema_migrations,
// so re-running only applies what's new.
//
//   npm run staging:migrate -- --until 20260901000021   (stop after 021)
//   npm run staging:migrate                             (apply everything)
//   npm run staging:migrate -- --dry-run                (show the plan only)
//
// Refuses to run against production (see lib.mjs).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, connectStagingDb, fail, loadStagingEnv } from './lib.mjs'

const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const ADAPTATIONS = join(ROOT, 'supabase', 'adaptations')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const untilIdx = args.indexOf('--until')
const until = untilIdx >= 0 ? args[untilIdx + 1] : null
if (untilIdx >= 0 && !/^\d{14}$/.test(until ?? '')) fail('--until needs a 14-digit migration version, e.g. 20260901000021')

const BEFORE = { '20260901000021': '021_before_drop_changed_functions.sql' }
const AFTER = { '20260901000017': '017_after_role_cast.sql' }

const env = loadStagingEnv(['STAGING_DB_URL'])
const db = await connectStagingDb(env)
let exitCode = 0

try {
  await db.query(`create schema if not exists supabase_migrations`)
  await db.query(
    `create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`,
  )
  const applied = new Set(
    (await db.query(`select version from supabase_migrations.schema_migrations`)).rows.map((r) => r.version),
  )
  const hasSchema = (await db.query(`select to_regclass('public.profiles') is not null as present`)).rows[0].present
  if (hasSchema && applied.size === 0) {
    throw new Error('This database already has app tables but no migration history — it is not a fresh staging project. Stopping.')
  }

  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  const plan = files
    .map((file) => ({ file, version: file.split('_')[0], name: file.replace(/^\d+_/, '').replace(/\.sql$/, '') }))
    .filter((m) => !applied.has(m.version) && (!until || m.version <= until))

  if (plan.length === 0) {
    console.log('Nothing to apply — staging is already up to date' + (until ? ` (up to ${until}).` : '.'))
  }

  console.log(`${applied.size} migration(s) already applied. To apply now:`)
  for (const m of plan) {
    const notes = [BEFORE[m.version] && `before: ${BEFORE[m.version]}`, AFTER[m.version] && `after: ${AFTER[m.version]}`]
      .filter(Boolean)
      .join(', ')
    console.log(`  ${m.file}${notes ? `   [${notes}]` : ''}`)
  }
  for (const m of dryRun ? [] : plan) {
    const sql = readFileSync(join(MIGRATIONS, m.file), 'utf8')
    await db.query('begin')
    try {
      if (BEFORE[m.version]) await db.query(readFileSync(join(ADAPTATIONS, BEFORE[m.version]), 'utf8'))
      await db.query(sql)
      if (AFTER[m.version]) await db.query(readFileSync(join(ADAPTATIONS, AFTER[m.version]), 'utf8'))
      await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`, [
        m.version,
        m.name,
      ])
      await db.query('commit')
      console.log(`✔ ${m.file}`)
    } catch (err) {
      await db.query('rollback')
      throw new Error(`${m.file} failed and was rolled back — nothing from it was applied.\n  ${err.message}`)
    }
  }
  if (!dryRun && plan.length) console.log(`\nDone. Applied ${plan.length} migration(s).`)
} catch (err) {
  console.error(`\n✖ ${err.message}\n`)
  exitCode = 1
} finally {
  await db.end()
}
process.exit(exitCode)
