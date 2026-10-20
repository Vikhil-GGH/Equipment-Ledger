// READ-ONLY preflight for applying migrations 022–030 to a database
// (production). It never writes: everything runs inside a READ ONLY
// transaction that is rolled back. It reports, per check, OK / INFO /
// STOP (STOP = a migration would fail or needs a decision first).
//
//   PREFLIGHT_DB_URL='postgresql://…' node scripts/production/preflight.mjs
//
// The connection string is read from the environment only — never from a
// file in this repository. Run it yourself; the staging scripts' guard
// deliberately refuses production, and so does every other tool here.
import pg from 'pg'

const url = process.env.PREFLIGHT_DB_URL
if (!url) {
  console.error('Set PREFLIGHT_DB_URL to the database connection string (read-only checks only).')
  process.exit(1)
}
const host = (() => { try { return new URL(url).hostname } catch { return '(unparsable URL)' } })()
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: false } })
await client.connect()
const rows = []
const report = (status, check, value, note = '') => rows.push({ status, check, value: String(value), note })
const q = async (sql, params = []) => (await client.query(sql, params)).rows
const one = async (sql, params = []) => (await q(sql, params))[0]
const exists = async (rel) => !!(await one(`select to_regclass($1) is not null as e`, [rel])).e
const fnExists = async (sig) => !!(await one(`select to_regprocedure($1) is not null as e`, [sig])).e

try {
  await client.query('begin read only')
  await client.query(`set local statement_timeout = '30s'`)
  console.log(`Connected to ${host} — read-only transaction.\n`)

  // ------------------------------------------------- what is applied
  let applied = []
  if (await exists('supabase_migrations.schema_migrations')) {
    applied = (await q(`select version from supabase_migrations.schema_migrations order by version`)).map((r) => r.version)
    report('INFO', 'Recorded migrations', applied.length ? `${applied[0]} … ${applied.at(-1)} (${applied.length})` : 'none')
  } else {
    report('INFO', 'Recorded migrations', 'no migration history table', 'Applied state is inferred from the objects below.')
  }
  const markers = [
    ['022', `select to_regprocedure('public.is_anonymous_session()') is not null as e`],
    ['023', `select not exists (select 1 from pg_policies where tablename = 'serialized_assets' and cmd = 'INSERT') as e`],
    ['024', `select exists (select 1 from information_schema.columns where table_name = 'offboarding_checklists' and column_name = 'laptop_outcome') as e`],
    ['025', `select exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'asset_status' and e.enumlabel = 'lost') as e`],
    ['026', `select to_regclass('public.equipment_issues') is not null as e`],
    ['027', `select to_regclass('public.serial_keys') is not null as e`],
    ['028', `select to_regclass('public.employee_history') is not null as e`],
    ['029', `select to_regclass('public.bulk_import_receipts') is not null as e`],
    ['030', `select to_regclass('public.profile_access_history') is not null as e`],
  ]
  const present = {}
  for (const [m, sql] of markers) present[m] = !!(await one(sql)).e
  report('INFO', 'Objects present for migrations 022–030', Object.entries(present).map(([m, p]) => `${m}:${p ? 'yes' : 'no'}`).join(' '))

  // --------------------------------------------------------- 017 / 021
  const ret = await one(`select pg_get_function_result(to_regprocedure('public.perform_lifecycle_action(asset_collection, uuid, asset_action, text, text)')) as r`)
  if (ret.r === 'asset_collection') report('OK', '021 (Inventory ↔ Active Laptops moves)', 'applied', 'No fix-up needed.')
  else if (ret.r === 'void') report('STOP', '021 (Inventory ↔ Active Laptops moves)', 'not applied (returns void)', 'Apply 021 with supabase/adaptations/021_before_drop_changed_functions.sql in the same transaction.')
  else report('STOP', '021 (Inventory ↔ Active Laptops moves)', ret.r ?? 'function missing', 'Unexpected — compare with supabase/staging/schema-fingerprint.sql before going on.')
  const hnu = await one(`select pg_get_functiondef(to_regprocedure('public.handle_new_user()')) as d`)
  report(/::user_role/.test(hnu.d ?? '') || present['022'] ? 'OK' : 'INFO', '017 handle_new_user cast', /::user_role/.test(hnu.d ?? '') ? 'has the ::user_role cast' : 'no explicit cast', present['022'] ? 'Superseded by 022.' : '022 replaces it; if new sign-ups fail before 022, see supabase/adaptations/017_after_role_cast.sql.')

  // ----------------------------------------------------- 022 anonymous
  const anon = await one(`select count(*)::int as n, count(*) filter (where p.role <> 'viewer')::int as privileged from auth.users u left join profiles p on p.id = u.id where u.is_anonymous`)
  report(anon.privileged && present['022'] ? 'STOP' : 'INFO', 'Anonymous accounts', `${anon.n} (${anon.privileged} with a role above viewer)`, present['022'] ? '022 should have pinned them to viewer.' : '022 pins them to viewer and closes anonymous access; also turn OFF anonymous sign-ins in Auth settings.')

  // --------------------------------------------- 027 serial uniqueness
  const devices = `select serial from serialized_assets union all select serial from active_laptops_np
    ${(await exists('public.monitors')) ? 'union all select serial from monitors' : ''} ${(await exists('public.other_equipment')) ? 'union all select serial from other_equipment' : ''}`
  const norm = `upper(regexp_replace(btrim(coalesce(serial, ''), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '[[:space:]' || chr(160) || ']+', ' ', 'g'))`
  const dup = await one(`select count(*)::int as groups, coalesce(sum(c), 0)::int as devices from (select k, count(*) as c from (select ${norm} as k from (${devices}) d) z group by k having count(*) > 1 and k <> '') x`)
  const blank = await one(`select count(*)::int as n from (${devices}) d where ${norm} = ''`)
  report('INFO', 'Duplicate serials (027 keeps and lists them)', `${dup.groups} groups / ${dup.devices} devices; ${blank.n} blank`, 'Not merged or deleted; reviewed under Access & Roles after 027.')

  // ---------------------------------------- 028 employee email uniqueness
  if (await exists('public.employees')) {
    const e = await one(`select count(*)::int as n from (select lower(btrim(email)) from employees where nullif(btrim(email), '') is not null group by 1 having count(*) > 1) x`)
    report(e.n && !present['028'] ? 'STOP' : 'OK', 'Employees sharing a work email (028 needs none)', e.n, e.n && !present['028'] ? 'Resolve before 028 — its unique index would fail.' : '')
  } else report('INFO', 'Employees sharing a work email', 'employees table not there yet (026 creates it)')

  // --------------------------------- 029 Bulk Stock name + category unique
  const b = await one(`select count(*)::int as n, coalesce(string_agg(names, ' | '), '') as list from (select string_agg(name || ' / ' || category, ', ') as names from bulk_items group by lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')), lower(regexp_replace(btrim(category), '\\s+', ' ', 'g')) having count(*) > 1) x`)
  report(b.n && !present['029'] ? 'STOP' : 'OK', 'Bulk Stock items sharing a name + category (029 needs none)', b.n, b.n ? `Decide which to keep before 029 (it never merges): ${b.list}` : '')

  // ----------------------------------------------- 030 access and MFA
  const admins = await one(`select count(*)::int as n from profiles where role = 'admin'`)
  let mfa = 'unknown (auth.mfa_factors not readable)'
  if (await exists('auth.mfa_factors')) {
    const m = await one(`select count(distinct f.user_id)::int as n from auth.mfa_factors f join profiles p on p.id = f.user_id where p.role = 'admin' and f.status = 'verified'`)
    mfa = `${m.n} of ${admins.n} admins have a verified authenticator`
  }
  report(admins.n ? 'INFO' : 'STOP', 'Admins and two-factor (030 requires it for admin powers)', mfa, 'After 030, admin powers need a two-factor session. Admins can still sign in and set it up (Security page).')
  report('INFO', 'Profiles that cannot be deleted after 030', (await one(`select count(*)::int as n from profiles`)).n, '030 replaces deletion with Remove access (history keeps every actor).')

  // --------------------------------------------------- size, for timing
  const sizes = []
  for (const t of ['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items', 'serialized_asset_history', 'onboarding_checklists', 'offboarding_checklists', 'import_events']) {
    if (await exists(`public.${t}`)) sizes.push(`${t}=${(await one(`select count(*)::int as n from ${t}`)).n}`)
  }
  report('INFO', 'Row counts', sizes.join(' '))
} finally {
  await client.query('rollback').catch(() => {})
  await client.end()
}

const width = Math.max(...rows.map((r) => r.check.length))
for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.check.padEnd(width)}  ${r.value}${r.note ? `\n${' '.repeat(width + 8)}${r.note}` : ''}`)
const stops = rows.filter((r) => r.status === 'STOP')
console.log(stops.length ? `\n✖ ${stops.length} item(s) to resolve before migrating.` : '\n✔ Nothing blocks migrating; read the INFO lines.')
process.exit(stops.length ? 2 : 0)
