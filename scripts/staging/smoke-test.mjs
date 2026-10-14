// End-to-end checks against the STAGING project's real Supabase Auth,
// REST API (PostgREST) and RLS — the same path the app uses, via
// supabase-js and the public anon key. No service-role key is used.
//
//   npm run staging:smoke -- pre    BEFORE applying 022/023: shows the
//                                   anonymous hole is real on staging and
//                                   keeps that anonymous session for later.
//   npm run staging:smoke -- post   AFTER applying 022/023: the kept
//                                   ("legacy") anonymous session and a new
//                                   one have no access; admin and editor
//                                   workflows all still work.
//
// Results print as a table and are saved to .staging-state/ (gitignored).
// Exit code 1 if any check FAILs. Refuses to run against production.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { ensureStateDir, fail, loadStagingEnv } from './lib.mjs'

const phase = process.argv[2]
if (phase !== 'pre' && phase !== 'post') fail('Usage: npm run staging:smoke -- pre   |   npm run staging:smoke -- post')

const env = loadStagingEnv(['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD'])
const stateDir = ensureStateDir()
const LEGACY_ANON_FILE = join(stateDir, 'legacy-anon-session.json')
const ZERO = '00000000-0000-0000-0000-000000000000'
const PROBE = 'anon-probe'

// Table -> a text column a write probe can target.
const TABLES = {
  serialized_assets: 'location',
  active_laptops_np: 'location',
  monitors: 'location',
  other_equipment: 'location',
  bulk_items: 'location',
  serialized_asset_history: 'detail',
  active_laptops_np_history: 'detail',
  monitors_history: 'detail',
  other_equipment_history: 'detail',
  bulk_item_history: 'detail',
  onboarding_checklists: 'employee_name',
  offboarding_checklists: 'employee_name',
  import_events: 'filename',
  profiles: 'full_name',
}
const STATS_VIEWS = ['serialized_assets_stats', 'active_laptops_np_stats', 'monitors_stats', 'other_equipment_stats']
const BACKUP_TABLES = Object.keys(TABLES).filter((t) => t !== 'profiles')

const results = []
function record(status, area, check, detail = '') {
  results.push({ status, area, check, detail: String(detail).slice(0, 160) })
}
const newClient = () =>
  createClient(env.VITE_STAGING_SUPABASE_URL, env.VITE_STAGING_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

async function signInAs(email, password) {
  const c = newClient()
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) return { error }
  return { c, user: data.user }
}

// ------------------------------------------------ anonymous denial checks
async function expectNoAccess(c, label) {
  for (const t of [...Object.keys(TABLES), ...STATS_VIEWS]) {
    const { count, error } = await c.from(t).select('*', { count: 'exact', head: true })
    record(error || count === 0 ? 'PASS' : 'FAIL', label, `read ${t} → 0 rows`, error ? error.message : `${count} rows`)
  }
  const bulk = await c.from('bulk_stock_stats').select('*')
  const allZero = !bulk.error && bulk.data.every((row) => Object.values(row).every((v) => Number(v) === 0))
  record(bulk.error || allZero ? 'PASS' : 'FAIL', label, 'read bulk_stock_stats → all zero', bulk.error?.message ?? JSON.stringify(bulk.data))

  const rpcs = [
    ['create_asset', { p_collection: 'serialized_assets', p_name: PROBE, p_category: PROBE, p_serial: `ANON-PROBE-${Date.now()}` }],
    ['perform_lifecycle_action', { p_collection: 'serialized_assets', p_asset_id: ZERO, p_action: 'mark_damaged' }],
    ['perform_swap', { p_collection: 'active_laptops_np', p_old_asset_id: ZERO, p_new_asset_id: ZERO, p_reason: PROBE }],
    ['onboarding_assign_device', { p_onboarding_id: ZERO, p_serial: PROBE }],
    ['create_bulk_item', { p_name: PROBE, p_category: PROBE }],
    ['perform_bulk_action', { p_item_id: ZERO, p_action: 'receive_stock', p_quantity: 1 }],
    ['commit_asset_import', { p_collection: 'serialized_assets', p_filename: PROBE, p_rows: [{ serial: `ANON-PROBE-${Date.now()}`, name: PROBE, category: PROBE }] }],
    ['commit_bulk_import', { p_filename: PROBE, p_rows: [{ name: PROBE, category: PROBE, quantity: 1 }] }],
    ['restore_backup', { p_payload: {} }],
  ]
  for (const [fn, args] of rpcs) {
    const { error } = await c.rpc(fn, args)
    const rejected = !!error && /not authorized|only an admin|viewers cannot/i.test(error.message)
    record(rejected ? 'PASS' : 'FAIL', label, `call ${fn} → rejected`, error?.message ?? 'call SUCCEEDED')
  }

  for (const [t, col] of Object.entries(TABLES)) {
    if (t === 'profiles') continue
    const row = t.endsWith('_history')
      ? { asset_id: ZERO, item_id: ZERO, action: PROBE, detail: PROBE, quantity: 1 }
      : t === 'import_events'
        ? { target_collection: PROBE, filename: PROBE }
        : t.endsWith('checklists')
          ? { employee_name: PROBE }
          : { name: PROBE, category: PROBE, serial: `ANON-PROBE-${t}`, [col]: PROBE }
    // History tables have either asset_id or item_id, not both.
    if (t === 'bulk_item_history') delete row.asset_id
    else if (t.endsWith('_history')) {
      delete row.item_id
      delete row.quantity
    }
    if (t === 'bulk_items') delete row.serial
    const ins = await c.from(t).insert(row)
    record(ins.error ? 'PASS' : 'FAIL', label, `insert into ${t} → denied`, ins.error?.message ?? 'insert SUCCEEDED')
  }
  for (const [t, col] of Object.entries(TABLES)) {
    const upd = await c.from(t).update({ [col]: PROBE }).neq('id', ZERO).select('id')
    record(upd.error || upd.data.length === 0 ? 'PASS' : 'FAIL', label, `update ${t} → 0 rows`, upd.error?.message ?? `${upd.data.length} rows`)
    const del = await c.from(t).delete().neq('id', ZERO).select('id')
    record(del.error || del.data.length === 0 ? 'PASS' : 'FAIL', label, `delete ${t} → 0 rows`, del.error?.message ?? `${del.data.length} rows`)
  }
}

// ------------------------------------------------------------- pre phase
async function prePhase() {
  const c = newClient()
  const { data, error } = await c.auth.signInAnonymously()
  if (error) {
    record('FAIL', 'setup', 'anonymous sign-in (must be ENABLED on staging for this phase)', error.message)
    return
  }
  record(data.user.is_anonymous ? 'PASS' : 'FAIL', 'pre-022', 'anonymous sign-in works (demo mode)', data.user.id)
  const prof = await c.from('profiles').select('role').eq('id', data.user.id).maybeSingle()
  record(prof.data?.role === 'editor' ? 'EXPECTED' : 'INFO', 'pre-022', 'anonymous user got the editor role (the vulnerability)', prof.data?.role ?? prof.error?.message ?? 'no profile')
  const read = await c.from('serialized_assets').select('*', { count: 'exact', head: true })
  record((read.count ?? 0) > 0 ? 'EXPECTED' : 'INFO', 'pre-022', 'anonymous session can read Laptop Inventory (the vulnerability)', `${read.count ?? 0} rows`)

  writeFileSync(
    LEGACY_ANON_FILE,
    JSON.stringify({ note: 'STAGING ONLY test session — do not commit or share', user_id: data.user.id, refresh_token: data.session.refresh_token }, null, 2),
  )
  record('PASS', 'pre-022', 'saved this anonymous session to reuse after 022', LEGACY_ANON_FILE)

  const admin = await signInAs(env.STAGING_ADMIN_EMAIL, env.STAGING_ADMIN_PASSWORD)
  record(admin.error ? 'FAIL' : 'PASS', 'pre-022', 'staging admin can sign in', admin.error?.message ?? env.STAGING_ADMIN_EMAIL)
}

// ------------------------------------------------------------ post phase
async function postPhase() {
  // A. The anonymous session created BEFORE 022, refreshed through real Auth.
  let legacyId = null
  if (!existsSync(LEGACY_ANON_FILE)) {
    record('FAIL', 'legacy anonymous', 'saved pre-022 session exists (run the "pre" phase before applying 022)', LEGACY_ANON_FILE)
  } else {
    const saved = JSON.parse(readFileSync(LEGACY_ANON_FILE, 'utf8'))
    legacyId = saved.user_id
    const c = newClient()
    const { data, error } = await c.auth.refreshSession({ refresh_token: saved.refresh_token })
    if (error) {
      record('WARN', 'legacy anonymous', 'refresh the pre-022 session', `${error.message} (session no longer usable — itself means no access)`)
    } else {
      writeFileSync(LEGACY_ANON_FILE, JSON.stringify({ ...saved, refresh_token: data.session.refresh_token }, null, 2))
      record('PASS', 'legacy anonymous', 'pre-022 session still authenticates (expected) …', data.user.id)
      await expectNoAccess(c, 'legacy anonymous')
    }
  }

  // B. A brand-new anonymous session, if staging still allows them.
  let newAnonId = null
  {
    const c = newClient()
    const { data, error } = await c.auth.signInAnonymously()
    if (error) {
      record('PASS', 'new anonymous', 'anonymous sign-ins are disabled on staging', error.message)
    } else {
      newAnonId = data.user.id
      record('INFO', 'new anonymous', 'anonymous sign-ins are still ENABLED on staging (disable before finishing)', data.user.id)
      await expectNoAccess(c, 'new anonymous')
    }
  }

  // C. Admin workflows.
  const a = await signInAs(env.STAGING_ADMIN_EMAIL, env.STAGING_ADMIN_PASSWORD)
  if (a.error) {
    record('FAIL', 'admin', 'staging admin can sign in', a.error.message)
    return
  }
  await adminWorkflows(a.c, a.user, legacyId, newAnonId)

  // D. Editor (optional account).
  if (env.STAGING_EDITOR_EMAIL && env.STAGING_EDITOR_PASSWORD) {
    const e = await signInAs(env.STAGING_EDITOR_EMAIL, env.STAGING_EDITOR_PASSWORD)
    if (e.error) record('FAIL', 'editor', 'staging editor can sign in', e.error.message)
    else await editorWorkflows(e.c)
  } else {
    record('INFO', 'editor', 'skipped (STAGING_EDITOR_EMAIL/PASSWORD not set)')
  }
}

async function step(area, check, fn) {
  try {
    const detail = await fn()
    record('PASS', area, check, detail ?? '')
  } catch (err) {
    record('FAIL', area, check, err.message)
  }
}
async function rpc(c, fn, args) {
  const { data, error } = await c.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}
function must(cond, message) {
  if (!cond) throw new Error(message)
}

async function adminWorkflows(c, user, legacyId, newAnonId) {
  const A = 'admin'
  const tag = `STG-${Date.now().toString(36).toUpperCase()}`
  const ids = {}
  const create = (collection, name, category, serial) =>
    rpc(c, 'create_asset', { p_collection: collection, p_name: name, p_category: category, p_serial: serial })
  const act = (collection, id, action, assignee) =>
    rpc(c, 'perform_lifecycle_action', { p_collection: collection, p_asset_id: id, p_action: action, p_assigned_to: assignee ?? null })

  await step(A, 'profile role is admin', async () => {
    const { data, error } = await c.from('profiles').select('role').eq('id', user.id).single()
    must(!error && data.role === 'admin', error?.message ?? `role is ${data.role}`)
  })
  await step(A, 'create assets in all four collections', async () => {
    ids.inv = await create('serialized_assets', 'Dell Latitude 5440', 'Laptop', `${tag}-INV-1`)
    ids.spare = await create('serialized_assets', 'Dell Latitude 5440', 'Laptop', `${tag}-INV-2`)
    ids.onb = await create('serialized_assets', 'HP EliteBook 840', 'Laptop', `${tag}-INV-3`)
    ids.np = await create('active_laptops_np', 'Lenovo ThinkPad T14', 'Laptop', `${tag}-NP-1`)
    ids.mon = await create('monitors', 'Dell 24 Monitor', 'Monitor', `${tag}-MON-1`)
    ids.oth = await create('other_equipment', 'USB-C Dock', 'Dock', `${tag}-OTH-1`)
    return tag
  })
  await step(A, 'Provide moves an Inventory laptop to Active Laptops (NP)', async () => {
    must((await act('serialized_assets', ids.inv, 'provide', 'Test Employee 90')) === 'active_laptops_np', 'did not move')
    const { data } = await c.from('active_laptops_np').select('status, moved_from_inventory').eq('id', ids.inv).single()
    must(data?.status === 'provided' && data.moved_from_inventory === true, JSON.stringify(data))
  })
  await step(A, 'Transfer, then Collect moves it back to Inventory with full history', async () => {
    must((await act('active_laptops_np', ids.inv, 'transfer', 'Test Employee 91')) === 'active_laptops_np', 'transfer moved it')
    must((await act('active_laptops_np', ids.inv, 'collect')) === 'serialized_assets', 'collect did not move it back')
    const { data } = await c.from('serialized_assets').select('status, assigned_to').eq('id', ids.inv).single()
    must(data?.status === 'available' && data.assigned_to === null, JSON.stringify(data))
    const hist = await c.from('serialized_asset_history').select('action').eq('asset_id', ids.inv)
    const actions = hist.data.map((h) => h.action).sort().join(',')
    must(actions === 'collect,created,provide,transfer', actions)
    return actions
  })
  await step(A, 'Mark damaged → Mark repaired', async () => {
    await act('serialized_assets', ids.inv, 'mark_damaged')
    await act('serialized_assets', ids.inv, 'mark_repaired')
  })
  await step(A, 'Monitors and Other Equipment stay in their own collections', async () => {
    must((await act('monitors', ids.mon, 'provide', 'Test Employee 90')) === 'monitors', 'monitor moved')
    must((await act('monitors', ids.mon, 'collect')) === 'monitors', 'monitor moved')
    must((await act('other_equipment', ids.oth, 'retain')) === 'other_equipment', 'other moved')
  })
  await step(A, 'Swap (replacement picked up from Inventory)', async () => {
    await act('active_laptops_np', ids.np, 'provide', 'Test Employee 92')
    await rpc(c, 'perform_swap', { p_collection: 'active_laptops_np', p_old_asset_id: ids.np, p_new_asset_id: ids.spare, p_reason: 'staging test: cracked screen' })
    const { data } = await c.from('active_laptops_np').select('id, status, assigned_to').in('id', [ids.np, ids.spare])
    const old = data.find((r) => r.id === ids.np)
    const neu = data.find((r) => r.id === ids.spare)
    must(old?.status === 'damaged' && old.assigned_to === null, `old: ${JSON.stringify(old)}`)
    must(neu?.status === 'provided' && neu.assigned_to === 'Test Employee 92', `new: ${JSON.stringify(neu)}`)
  })
  await step(A, 'Asset import and bulk import (and the import log)', async () => {
    const assets = await rpc(c, 'commit_asset_import', {
      p_collection: 'monitors',
      p_filename: `${tag}-monitors.xlsx`,
      p_rows: [1, 2].map((i) => ({ serial: `${tag}-IMP-${i}`, name: 'LG 27 Monitor', category: 'Monitor', status: '', assigned_to: '', location: '' })),
    })
    must(assets.created === 2, JSON.stringify(assets))
    const bulk = await rpc(c, 'commit_bulk_import', { p_filename: `${tag}-bulk.xlsx`, p_rows: [{ name: `${tag} Mouse`, category: 'Accessory', location: '', quantity: 5 }] })
    must(bulk.created === 1, JSON.stringify(bulk))
    const log = await c.from('import_events').select('id').like('filename', `${tag}-%`)
    must(log.data?.length === 2, `log rows: ${log.data?.length}`)
  })
  await step(A, 'Bulk stock: create and issue', async () => {
    ids.bulk = await rpc(c, 'create_bulk_item', { p_name: `${tag} Charger`, p_category: 'Power', p_initial_quantity: 10 })
    await rpc(c, 'perform_bulk_action', { p_item_id: ids.bulk, p_action: 'issue', p_quantity: 3 })
    const { data } = await c.from('bulk_items').select('available, provided').eq('id', ids.bulk).single()
    must(data?.available === 7 && data.provided === 3, JSON.stringify(data))
  })
  await step(A, 'Onboarding: create, tick a step, assign a device', async () => {
    const ins = await c.from('onboarding_checklists').insert({ employee_name: `Test Employee 93 ${tag}`, created_by: user.id }).select('id').single()
    must(!ins.error, ins.error?.message)
    ids.onboarding = ins.data.id
    const upd = await c.from('onboarding_checklists').update({ identity_created: true }).eq('id', ids.onboarding).select('id')
    must(upd.data?.length === 1, upd.error?.message ?? 'step not saved')
    await rpc(c, 'onboarding_assign_device', { p_onboarding_id: ids.onboarding, p_serial: `${tag}-INV-3` })
    const { data } = await c.from('onboarding_checklists').select('equipment_assigned, assigned_asset_id').eq('id', ids.onboarding).single()
    must(data?.equipment_assigned === true && data.assigned_asset_id === ids.onb, JSON.stringify(data))
  })
  {
    // Investigation of audit finding C2 — not fixed yet, recorded as KNOWN.
    const { error } = await c.rpc('perform_lifecycle_action', { p_collection: 'active_laptops_np', p_asset_id: ids.onb, p_action: 'collect' })
    if (error && /foreign key/i.test(error.message)) record('KNOWN', A, 'C2: collecting an onboarding-assigned Inventory laptop fails (not fixed yet)', error.message)
    else record('INFO', A, 'C2: collecting an onboarding-assigned Inventory laptop', error?.message ?? 'succeeded — C2 NOT reproduced on staging')
  }
  await step(A, 'Offboarding: create, tick a step, find the employee’s assets', async () => {
    const ins = await c.from('offboarding_checklists').insert({ employee_name: 'Test Employee 92', created_by: user.id }).select('id').single()
    must(!ins.error, ins.error?.message)
    const upd = await c.from('offboarding_checklists').update({ removed_access: true }).eq('id', ins.data.id).select('id')
    must(upd.data?.length === 1, upd.error?.message ?? 'step not saved')
    const { data } = await c.from('active_laptops_np').select('id').ilike('assigned_to', 'Test Employee 92')
    must(data?.some((r) => r.id === ids.spare), 'swapped-in laptop not found for the employee')
  })
  {
    // Backup export exactly as the Data page does it, plus truncation check (audit C5).
    const exported = { exported_at: new Date().toISOString(), tables: {} }
    for (const t of BACKUP_TABLES) {
      const [{ data, error }, { count }] = await Promise.all([
        c.from(t).select('*'),
        c.from(t).select('*', { count: 'exact', head: true }),
      ])
      if (error) {
        record('FAIL', A, `backup export: ${t}`, error.message)
        continue
      }
      exported.tables[t] = data
      if (data.length === count) record('PASS', A, `backup export: ${t} complete`, `${count} rows`)
      else record('KNOWN', A, `backup export: ${t} TRUNCATED (audit C5, not fixed yet)`, `${data.length} of ${count} rows`)
    }
    const file = join(stateDir, `staging-export-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify(exported))
    record('INFO', A, 'backup export saved (synthetic staging data)', file)
  }
  await step(A, 'Direct table writes are blocked even for admin (023)', async () => {
    const upd = await c.from('serialized_assets').update({ location: PROBE }).eq('id', ids.inv).select('id')
    must(!upd.error && upd.data.length === 0, upd.error?.message ?? `${upd.data.length} rows updated`)
    const del = await c.from('serialized_assets').delete().eq('id', ids.inv).select('id')
    must(!del.error && del.data.length === 0, del.error?.message ?? `${del.data.length} rows deleted`)
    const ins = await c.from('monitors').insert({ name: PROBE, category: PROBE, serial: `${tag}-RAW` })
    must(!!ins.error, 'raw insert succeeded')
  })
  await step(A, 'User list readable; role of an anonymous user cannot be raised', async () => {
    const { data, error } = await c.from('profiles').select('id, role')
    must(!error && data.length > 0, error?.message ?? 'no profiles')
    if (legacyId) {
      const up = await c.from('profiles').update({ role: 'editor' }).eq('id', legacyId).select('id')
      must(!!up.error && /anonymous users cannot be granted/i.test(up.error.message), up.error?.message ?? 'promotion SUCCEEDED')
    }
    if (newAnonId) must(!data.some((r) => r.id === newAnonId), 'new anonymous user has a profile row')
  })
  await step(A, 'No anonymous probe write landed anywhere', async () => {
    for (const [t, col] of Object.entries(TABLES)) {
      const { count } = await c.from(t).select('*', { count: 'exact', head: true }).eq(col, PROBE)
      must(count === 0, `${count} probe row(s) in ${t}`)
    }
  })
}

async function editorWorkflows(c) {
  const E = 'editor'
  const tag = `STG-E-${Date.now().toString(36).toUpperCase()}`
  await step(E, 'create an asset and run a lifecycle action', async () => {
    const id = await rpc(c, 'create_asset', { p_collection: 'monitors', p_name: 'Dell 24 Monitor', p_category: 'Monitor', p_serial: `${tag}-MON` })
    await rpc(c, 'perform_lifecycle_action', { p_collection: 'monitors', p_asset_id: id, p_action: 'retain' })
  })
  await step(E, 'direct table updates are blocked (023)', async () => {
    const upd = await c.from('monitors').update({ location: PROBE }).neq('id', ZERO).select('id')
    must(!upd.error && upd.data.length === 0, upd.error?.message ?? `${upd.data.length} rows updated`)
  })
}

// ------------------------------------------------------------------- run
if (phase === 'pre') await prePhase()
else await postPhase()

const width = (k) => Math.max(...results.map((r) => r[k].length), k.length)
const [ws, wa, wc] = [width('status'), width('area'), width('check')]
console.log(`\n${'STATUS'.padEnd(ws)}  ${'AREA'.padEnd(wa)}  ${'CHECK'.padEnd(wc)}  DETAIL`)
for (const r of results) console.log(`${r.status.padEnd(ws)}  ${r.area.padEnd(wa)}  ${r.check.padEnd(wc)}  ${r.detail}`)

const tally = results.reduce((t, r) => ({ ...t, [r.status]: (t[r.status] ?? 0) + 1 }), {})
console.log('\n' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   '))
const reportFile = join(stateDir, `smoke-${phase}-${Date.now()}.json`)
writeFileSync(reportFile, JSON.stringify({ phase, ran_at: new Date().toISOString(), staging: env.stagingRef, results }, null, 2))
console.log(`Report saved: ${reportFile}`)
process.exit(tally.FAIL ? 1 : 0)
