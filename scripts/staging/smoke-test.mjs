// End-to-end checks against the STAGING project's real Supabase Auth,
// REST API (PostgREST) and RLS — the same path the app uses, via
// supabase-js and the public anon key. No service-role key is used.
//
//   npm run staging:smoke -- post   READ-ONLY. The kept ("legacy") anonymous
//                                   session and a new one get no data and
//                                   every write function rejects them; the
//                                   admin can sign in and read everything.
//   npm run staging:smoke -- pre    Only for a database BEFORE 022/023, and
//                                   it is a mutation: it creates an
//                                   anonymous auth user (to show the old
//                                   hole and keep that session for "post").
//
// Staging policy: real-API checks never change data, even if a check
// fails — every write-path probe below uses arguments that cannot succeed
// (a non-existent id, a missing required value), and there is no restore
// probe. Mutation tests (lifecycle, swap, imports, issue/return, raw
// writes, restore) run in supabase/tests/db/*.db.test.ts on the same
// staging database, inside transactions that are always rolled back.
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

// Tables checked (the values were write-probe columns in earlier, mutating versions).
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
// Added by 20260901000026 (employee equipment register).
const REGISTER_TABLES = ['employees', 'equipment_issues']

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
  for (const t of [...Object.keys(TABLES), ...STATS_VIEWS, ...REGISTER_TABLES]) {
    const { count, error } = await c.from(t).select('*', { count: 'exact', head: true })
    record(error || count === 0 ? 'PASS' : 'FAIL', label, `read ${t} → 0 rows`, error ? error.message : `${count} rows`)
  }
  const bulk = await c.from('bulk_stock_stats').select('*')
  const allZero = !bulk.error && bulk.data.every((row) => Object.values(row).every((v) => Number(v) === 0))
  record(bulk.error || allZero ? 'PASS' : 'FAIL', label, 'read bulk_stock_stats → all zero', bulk.error?.message ?? JSON.stringify(bulk.data))

  // Every argument set below would fail even for an admin (no such id, or a
  // required value missing), so a broken permission check still can't write.
  const rpcs = [
    ['create_asset', { p_collection: 'serialized_assets', p_name: null, p_category: null, p_serial: null }],
    ['perform_lifecycle_action', { p_collection: 'serialized_assets', p_asset_id: ZERO, p_action: 'mark_damaged' }],
    ['perform_swap', { p_collection: 'active_laptops_np', p_old_asset_id: ZERO, p_new_asset_id: ZERO, p_reason: PROBE }],
    ['onboarding_assign_device', { p_onboarding_id: ZERO, p_serial: PROBE }],
    ['create_bulk_item', { p_name: null, p_category: null }],
    ['perform_bulk_action', { p_item_id: ZERO, p_action: 'receive_stock', p_quantity: 1 }],
    // p_rows is not a list: fails before any row is read (since 027 a row
    // with a missing serial is reported and logged, not an error).
    ['commit_asset_import', { p_collection: 'serialized_assets', p_filename: PROBE, p_rows: PROBE }],
    ['commit_bulk_import', { p_filename: PROBE, p_rows: [{ name: null, category: null, quantity: 1 }] }],
    ['create_employee', { p_full_name: '' }],
    ['issue_equipment', { p_employee_id: ZERO, p_collection: 'serialized_assets', p_asset_id: ZERO }],
    ['return_equipment', { p_issue_id: ZERO, p_outcome: 'returned' }],
  ]
  for (const [fn, args] of rpcs) {
    const { error } = await c.rpc(fn, args)
    const rejected = !!error && /not authorized|only an admin|viewers cannot/i.test(error.message)
    record(rejected ? 'PASS' : 'FAIL', label, `call ${fn} → rejected for lack of permission`, error?.message ?? 'call SUCCEEDED')
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
  if (!existsSync(LEGACY_ANON_FILE)) {
    record('FAIL', 'legacy anonymous', 'saved pre-022 session exists (run the "pre" phase before applying 022)', LEGACY_ANON_FILE)
  } else {
    const saved = JSON.parse(readFileSync(LEGACY_ANON_FILE, 'utf8'))
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
  {
    const c = newClient()
    const { data, error } = await c.auth.signInAnonymously()
    if (error) {
      record('PASS', 'new anonymous', 'anonymous sign-ins are disabled on staging', error.message)
    } else {
      record('INFO', 'new anonymous', 'anonymous sign-ins are still ENABLED on staging (disable before finishing)', data.user.id)
      await expectNoAccess(c, 'new anonymous')
    }
  }

  // C. Admin — read-only (these checks never change data or automate two-factor).
  const a = await signInAs(env.STAGING_ADMIN_EMAIL, env.STAGING_ADMIN_PASSWORD)
  if (a.error) {
    record('FAIL', 'admin', 'staging admin can sign in', a.error.message)
    return
  }
  await readOnly(a.c, a.user, 'admin (read-only)', 'admin')
}

async function readOnly(c, user, A, expectedRole) {
  const prof = await c.from('profiles').select('role').eq('id', user.id).single()
  record(prof.data?.role === expectedRole ? 'PASS' : 'FAIL', A, `profile role is ${expectedRole}`, prof.error?.message ?? prof.data?.role)
  for (const t of [...BACKUP_TABLES, ...REGISTER_TABLES]) {
    // A full export, as the Data page does — plus a check nothing is cut off (audit C5).
    const [{ data, error }, { count }] = await Promise.all([c.from(t).select('*'), c.from(t).select('*', { count: 'exact', head: true })])
    if (error) record('FAIL', A, `read ${t}`, error.message)
    else if (data.length === count) record('PASS', A, `read ${t} completely`, `${count} rows`)
    else record('KNOWN', A, `read ${t} TRUNCATED (audit C5, not fixed yet)`, `${data.length} of ${count} rows`)
  }
  const mm = await c.from('equipment_register_mismatches').select('*')
  record(!mm.error && mm.data.length === 0 ? 'PASS' : 'FAIL', A, 'equipment register matches every device', mm.error?.message ?? `${mm.data.length} mismatches`)
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
