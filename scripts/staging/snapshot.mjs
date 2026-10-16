// Saves, or compares against, a complete snapshot of the STAGING database:
// every row of every public table (a full data backup — read directly, so
// no 1,000-row API limit), per-table row counts and content fingerprints,
// inventory totals, and the schema fingerprint.
//
//   npm run staging:snapshot -- save pre-025      before a migration
//   npm run staging:snapshot -- compare pre-025   after it: proves which
//                                                 pre-existing data changed
//
// "compare" fingerprints each table using only the columns it had when the
// snapshot was taken, so columns a migration ADDS don't count as changes.
// Files go to .staging-state/snapshots/<label>/ (git-ignored). Read-only:
// never writes to the database. Refuses to run against production.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, connectStagingDb, fail, loadStagingEnv } from './lib.mjs'

const [mode, label] = process.argv.slice(2)
if (!['save', 'compare'].includes(mode) || !/^[\w.-]+$/.test(label ?? '')) {
  fail('Usage: npm run staging:snapshot -- save <label>   |   npm run staging:snapshot -- compare <label>')
}
const dir = join(ROOT, '.staging-state', 'snapshots', label)
const env = loadStagingEnv(['STAGING_DB_URL'])
const db = await connectStagingDb(env)
const ident = (s) => '"' + s.replaceAll('"', '""') + '"'

async function tableFingerprint(table, columns) {
  const cols = columns.map(ident).join(', ')
  const { rows } = await db.query(
    `select count(*)::int as n, md5(coalesce(string_agg(r::text, '|' order by r::text), '')) as h
     from (select row(${cols}) as r from public.${ident(table)}) x`,
  )
  return { count: rows[0].n, hash: rows[0].h }
}

async function inventoryTotals() {
  const { rows } = await db.query(`
    select
      (select count(*) from serialized_assets)::int as laptop_inventory,
      (select count(*) from active_laptops_np)::int as active_laptops_np,
      (select count(*) from monitors)::int as monitors,
      (select count(*) from other_equipment)::int as other_equipment,
      ((select count(*) from serialized_assets where nullif(btrim(assigned_to), '') is not null)
       + (select count(*) from active_laptops_np where nullif(btrim(assigned_to), '') is not null)
       + (select count(*) from monitors where nullif(btrim(assigned_to), '') is not null)
       + (select count(*) from other_equipment where nullif(btrim(assigned_to), '') is not null))::int as assigned_devices,
      (select coalesce(sum(available), 0) from bulk_items)::int as bulk_available,
      (select coalesce(sum(provided), 0) from bulk_items)::int as bulk_provided,
      (select coalesce(sum(retained), 0) from bulk_items)::int as bulk_retained,
      (select coalesce(sum(damaged), 0) from bulk_items)::int as bulk_damaged,
      (select coalesce(sum(decommissioned), 0) from bulk_items)::int as bulk_decommissioned,
      (select count(*) from auth.users)::int as auth_users`)
  return rows[0]
}

async function tablesWithColumns() {
  const { rows } = await db.query(`
    select c.table_name, array_agg(c.column_name::text order by c.ordinal_position) as columns
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
    group by c.table_name order by c.table_name`)
  return rows
}

let exitCode = 0
try {
  await db.query('begin read only')
  if (mode === 'save') {
    if (existsSync(dir)) throw new Error(`Snapshot "${label}" already exists — choose a new label.`)
    mkdirSync(dir, { recursive: true })
    const tables = await tablesWithColumns()
    const manifest = { label, taken_at: new Date().toISOString(), staging: env.stagingRef, tables: {}, totals: await inventoryTotals() }
    const data = {}
    for (const { table_name, columns } of tables) {
      manifest.tables[table_name] = { columns, ...(await tableFingerprint(table_name, columns)) }
      const { rows } = await db.query(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from public.${ident(table_name)} t`)
      data[table_name] = rows[0].rows
    }
    const fingerprintSql = readFileSync(join(ROOT, 'supabase', 'staging', 'schema-fingerprint.sql'), 'utf8')
      .replace(/^set session characteristics.*$/m, '')
    manifest.schema = (await db.query(fingerprintSql)).rows
    writeFileSync(join(dir, 'data.json'), JSON.stringify(data))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // Verify the backup file: every table present with every row.
    const reread = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'))
    const problems = Object.entries(manifest.tables).filter(([t, m]) => !Array.isArray(reread[t]) || reread[t].length !== m.count)
    if (problems.length) throw new Error(`Backup verification FAILED for: ${problems.map(([t]) => t).join(', ')}`)
    const rowsTotal = Object.values(manifest.tables).reduce((n, m) => n + m.count, 0)
    console.log(`\n✔ Snapshot "${label}" saved and verified: ${tables.length} tables, ${rowsTotal} rows, ${manifest.schema.length} schema objects.`)
    console.log('Inventory totals:', JSON.stringify(manifest.totals))
    console.log(`Files: .staging-state/snapshots/${label}/ (data.json = full backup, manifest.json = counts + fingerprints)`)
  } else {
    if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`No snapshot "${label}".`)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    const now = await tablesWithColumns()
    const nowCols = Object.fromEntries(now.map((t) => [t.table_name, t.columns]))
    const changed = []
    console.log(`Comparing with snapshot "${label}" (${manifest.taken_at}) — pre-existing columns only:`)
    for (const [table, m] of Object.entries(manifest.tables)) {
      if (!nowCols[table]) {
        changed.push(table)
        console.log(`  ✖ ${table}: table no longer exists`)
        continue
      }
      const missing = m.columns.filter((c) => !nowCols[table].includes(c))
      if (missing.length) {
        changed.push(table)
        console.log(`  ✖ ${table}: columns removed: ${missing.join(', ')}`)
        continue
      }
      const fp = await tableFingerprint(table, m.columns)
      const same = fp.count === m.count && fp.hash === m.hash
      if (!same) changed.push(table)
      const added = nowCols[table].filter((c) => !m.columns.includes(c))
      console.log(`  ${same ? '✔' : '✖'} ${table}: ${fp.count} rows${same ? ' — unchanged' : ` — CHANGED (was ${m.count})`}${added.length ? `   [new columns: ${added.join(', ')}]` : ''}`)
    }
    for (const t of now.filter((t) => !manifest.tables[t.table_name])) console.log(`  + ${t.table_name}: new table`)
    const totals = await inventoryTotals()
    const totalsSame = JSON.stringify(totals) === JSON.stringify(manifest.totals)
    console.log(`Inventory totals ${totalsSame ? 'unchanged' : 'CHANGED'}: ${JSON.stringify(totals)}`)
    if (changed.length || !totalsSame) {
      exitCode = 2
      console.log(`\n✖ Pre-existing data differs in: ${changed.join(', ') || '(totals)'}`)
    } else {
      console.log('\n✔ Every pre-existing row and column is unchanged.')
    }
  }
} catch (err) {
  console.error(`\n✖ ${err.message}\n`)
  exitCode = 1
} finally {
  await db.query('rollback').catch(() => {})
  await db.end()
}
process.exit(exitCode)
