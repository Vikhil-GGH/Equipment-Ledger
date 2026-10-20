// Saves, or compares against, a complete snapshot of the STAGING database:
// every row of every public table (a full data backup — read directly, so
// no 1,000-row API limit), per-table row counts and content fingerprints,
// inventory totals, and the schema fingerprint.
//
//   npm run staging:snapshot -- save pre-025      before a migration
//   npm run staging:snapshot -- compare pre-025   after it: proves which
//                                                 pre-existing data changed
//   … compare pre-025 --tag ZZ-SYN-1031 --authorized-mfa admin@example.com
//
// compare also checks every pre-existing row by primary key (columns it had
// at the snapshot), then classifies every NEW row — in old and new tables —
// as synthetic (carries a --tag, or a tag/account listed in
// .staging-state/synthetic-accounts-*.json, or references such a row; see
// classify.mjs) or UNEXPECTED. Auth is compared too: logins (non-secret
// fingerprint: email, password hash, ban, deletion, role, metadata) and MFA
// factor type/status per account — never secrets. A new factor on an
// existing account counts as authorized only with --authorized-mfa <email>.
//
// "compare" fingerprints each table using only the columns it had when the
// snapshot was taken, so columns a migration ADDS don't count as changes.
// Files go to .staging-state/snapshots/<label>/ (git-ignored). Read-only:
// never writes to the database. Refuses to run against production.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, connectStagingDb, fail, loadStagingEnv } from './lib.mjs'
import { classifyNewRows } from './classify.mjs'

const [mode, label, ...rest] = process.argv.slice(2)
if (!['save', 'compare'].includes(mode) || !/^[\w.-]+$/.test(label ?? '')) {
  fail('Usage: npm run staging:snapshot -- save <label>   |   npm run staging:snapshot -- compare <label> [--tag T]... [--authorized-mfa EMAIL]...')
}
const flag = (name) => rest.flatMap((a, i) => (a === name && rest[i + 1] ? [rest[i + 1]] : []))
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

// Non-secret Auth summary: a fingerprint per login, factor type/status per account.
async function authSummary() {
  const users = (await db.query(`select id::text, md5(row(email, encrypted_password, banned_until, deleted_at, role, raw_app_meta_data, is_anonymous)::text) as fp from auth.users order by id`)).rows
  const factors = (await db.query(`select user_id::text, factor_type::text, status::text from auth.mfa_factors order by user_id, created_at`)).rows
  return { users, factors }
}

async function primaryKeys() {
  const { rows } = await db.query(`
    select c.relname as table_name, a.attname as column_name
    from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
    where i.indisprimary and n.nspname = 'public'`)
  return Object.fromEntries(rows.map((r) => [r.table_name, r.column_name]))
}

function syntheticSources() {
  const tags = new Set(flag('--tag'))
  const ids = []
  const stateDir = join(ROOT, '.staging-state')
  for (const f of existsSync(stateDir) ? readdirSync(stateDir).filter((f) => /^synthetic-accounts-.*\.json$/.test(f)) : []) {
    const rec = JSON.parse(readFileSync(join(stateDir, f), 'utf8'))
    if (rec.tag) tags.add(rec.tag)
    for (const a of Object.values(rec.accounts ?? {})) ids.push(a.id)
  }
  return { tags: [...tags], ids }
}

let exitCode = 0
try {
  await db.query('begin read only')
  if (mode === 'save') {
    if (existsSync(dir)) throw new Error(`Snapshot "${label}" already exists — choose a new label.`)
    mkdirSync(dir, { recursive: true })
    const tables = await tablesWithColumns()
    const manifest = { label, taken_at: new Date().toISOString(), staging: env.stagingRef, tables: {}, totals: await inventoryTotals(), auth: await authSummary() }
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
      console.log(`  ${same ? '✔' : '·'} ${table}: ${fp.count} rows${same ? ' — unchanged' : ` — differs from snapshot (${m.count} rows then; row-level check below)`}${added.length ? `   [new columns: ${added.join(', ')}]` : ''}`)
    }
    for (const t of now.filter((t) => !manifest.tables[t.table_name])) console.log(`  + ${t.table_name}: new table`)
    const totals = await inventoryTotals()
    const totalsSame = JSON.stringify(totals) === JSON.stringify(manifest.totals)
    console.log(`Inventory totals ${totalsSame ? 'unchanged' : 'differ (rows below say why)'}: ${JSON.stringify(totals)}`)

    // ---- Row level: every pre-existing row by primary key; every new row classified.
    const data = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'))
    const pk = await primaryKeys()
    const newRows = {}
    const rowProblems = []
    for (const { table_name: table } of now) {
      const m = manifest.tables[table]
      const key = pk[table] ?? 'id'
      const cols = m ? m.columns : []
      const { rows } = await db.query(`select ${ident(key)}::text as k, to_jsonb(t) as j from public.${ident(table)} t`)
      const before = new Map((data[table] ?? []).map((r) => [String(r[key]), r]))
      const pick = (o) => JSON.stringify(cols.map((c) => o[c] ?? null))
      newRows[table] = []
      for (const r of rows) {
        const old = before.get(r.k)
        if (!old) newRows[table].push(r.j)
        else {
          before.delete(r.k)
          if (pick(old) !== pick(r.j)) rowProblems.push(`${table} ${r.k} changed`)
        }
      }
      for (const k of before.keys()) rowProblems.push(`${table} ${k} missing`)
    }

    // ---- Auth (non-secret fingerprints and factor status only).
    const auth = await authSummary()
    const snapAuth = manifest.auth
    const src = syntheticSources()
    const syn = new Set(src.ids)
    const existingIds = snapAuth ? snapAuth.users.map((u) => u.id) : auth.users.map((u) => u.id).filter((id) => !syn.has(id))
    const authProblems = []
    const authorized = []
    if (snapAuth) {
      const nowFp = new Map(auth.users.map((u) => [u.id, u.fp]))
      for (const u of snapAuth.users) {
        if (!nowFp.has(u.id)) authProblems.push(`login ${u.id} missing`)
        else if (nowFp.get(u.id) !== u.fp) authProblems.push(`login ${u.id} changed (email, password, ban, deletion, role or metadata)`)
      }
      for (const u of auth.users) if (!snapAuth.users.some((s) => s.id === u.id) && !syn.has(u.id)) authProblems.push(`new login ${u.id} is not a synthetic account`)
    } else if (existingIds.length !== manifest.totals.auth_users) {
      authProblems.push(`non-synthetic logins: ${existingIds.length}, snapshot had ${manifest.totals.auth_users}`)
    }
    const allowMfa = flag('--authorized-mfa').map((e) => e.toLowerCase())
    const emails = new Map((await db.query(`select id::text, lower(email) as email from auth.users`)).rows.map((r) => [r.id, r.email]))
    const snapFactors = (snapAuth?.factors ?? []).map((f) => `${f.user_id}|${f.factor_type}|${f.status}`)
    for (const f of auth.factors) {
      const i = snapFactors.indexOf(`${f.user_id}|${f.factor_type}|${f.status}`)
      if (i >= 0) {
        snapFactors.splice(i, 1)
        continue
      }
      if (syn.has(f.user_id)) continue
      const who = emails.get(f.user_id) ?? f.user_id
      if (allowMfa.includes(who)) authorized.push(`${who}: ${f.status} ${f.factor_type} factor (authorized MFA enrolment)`)
      else authProblems.push(`${who}: ${f.status} ${f.factor_type} factor added — not authorized (use --authorized-mfa)`)
    }
    for (const k of snapFactors) authProblems.push(`factor removed or changed: ${k.split('|').slice(1).join(' ')} for ${k.split('|')[0]}`)

    const classes = classifyNewRows({ newRows, pk, tags: src.tags, syntheticIds: src.ids, existingAccountIds: existingIds })
    console.log(`\nRow-level check by primary key (synthetic tags: ${src.tags.join(', ') || 'none'}; synthetic accounts: ${src.ids.length}):`)
    console.log(rowProblems.length ? `  ✖ ${rowProblems.length} pre-existing row(s) changed or missing: ${rowProblems.slice(0, 10).join('; ')}` : '  ✔ every pre-existing row is unchanged')
    let unexpected = 0
    const review = []
    console.log('\nAdded since the snapshot:')
    for (const [table, c] of Object.entries(classes)) {
      if (!c.added) continue
      console.log(`  ${c.unexpected.length ? '✖' : '✔'} ${table}: +${c.added} — ${c.synthetic} synthetic${c.unexpected.length ? `, ${c.unexpected.length} UNEXPECTED` : ''}`)
      unexpected += c.unexpected.length
      for (const r of c.unexpected.slice(0, 3)) console.log(`      unexpected: ${JSON.stringify(r).slice(0, 240)}`)
      for (const r of c.touchesExistingAccount) review.push(`${table}: ${JSON.stringify(r).slice(0, 240)}`)
    }
    if (!Object.values(classes).some((c) => c.added)) console.log('  nothing')
    console.log(`  Auth: ${auth.users.filter((u) => syn.has(u.id)).length} synthetic login(s), ${auth.factors.filter((f) => syn.has(f.user_id)).length} synthetic factor(s)`)
    console.log('\nChanges to existing accounts:')
    if (!snapAuth) console.log('  (snapshot predates Auth fingerprints: logins checked by count; factors listed as added)')
    for (const a of authorized) console.log(`  ✔ ${a}`)
    for (const p of authProblems) console.log(`  ✖ ${p}`)
    for (const r of review) console.log(`  ! review — synthetic row referencing an existing account: ${r}`)
    if (!authorized.length && !authProblems.length && !review.length) console.log('  none')
    const structural = changed.filter((t) => !nowCols[t] || manifest.tables[t].columns.some((c) => !nowCols[t].includes(c)))
    if (rowProblems.length || unexpected || authProblems.length || structural.length) {
      exitCode = 2
      console.log('\n✖ Differences need attention (see above).')
    } else {
      console.log(`\n✔ Every pre-existing row is unchanged and every addition is synthetic${authorized.length ? '; the only account changes are the authorized ones above' : ''}${review.length ? ' — review the flagged rows' : ''}.`)
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
