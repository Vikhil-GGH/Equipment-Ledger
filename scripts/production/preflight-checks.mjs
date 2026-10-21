// The read-only checks behind scripts/production/preflight.mjs, as a module so
// they can be tested against a disposable database (supabase/tests/db/
// preflight.db.test.ts). `q(sql, params)` must run inside a READ ONLY
// transaction; nothing here writes.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLAN_FIRST = '20260901000021'
const PLAN_LAST = '20260901000033'

/** Migration files with comments stripped (so commented-out SQL never counts). */
export function loadMigrations(migrationsDir, adaptationsDir) {
  const strip = (sql) => sql.replace(/--[^\n]*/g, '')
  const files = readdirSync(migrationsDir).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort()
  const adaptations = adaptationsDir ? readdirSync(adaptationsDir).filter((f) => f.endsWith('.sql')) : []
  return files.map((f) => {
    const version = f.slice(0, 14)
    // An adaptation named NNN_… runs in the same transaction as migration NNN.
    const extra = adaptations.filter((a) => version.endsWith(a.slice(0, 3))).map((a) => strip(readFileSync(join(adaptationsDir, a), 'utf8')))
    return { version, name: f, sql: [...extra, strip(readFileSync(join(migrationsDir, f), 'utf8'))].join('\n') }
  })
}

/** Objects a migration drops by name (no IF EXISTS), and objects it creates. */
export function dropsAndCreates(sql) {
  const drops = []
  const creates = { policies: new Set(), functions: new Set(), tables: new Set() }
  for (const m of sql.matchAll(/\bdrop\s+policy\s+(?!if\s+exists)("?[\w]+"?)\s+on\s+(?:public\.)?("?[\w]+"?)/gi)) drops.push({ kind: 'policy', name: m[1].replaceAll('"', ''), table: m[2].replaceAll('"', '') })
  for (const m of sql.matchAll(/\balter\s+table\s+(?:only\s+)?(?:public\.)?([\w]+)\s+drop\s+constraint\s+(?!if\s+exists)([\w]+)/gi)) drops.push({ kind: 'constraint', name: m[2], table: m[1] })
  for (const m of sql.matchAll(/\bdrop\s+function\s+(?!if\s+exists)(?:public\.)?([\w]+)\s*\(([^)]*)\)/gi)) drops.push({ kind: 'function', name: m[1], args: m[2].trim() })
  for (const m of sql.matchAll(/\bdrop\s+trigger\s+(?!if\s+exists)([\w]+)\s+on\s+(?:public\.)?([\w]+)/gi)) drops.push({ kind: 'trigger', name: m[1], table: m[2] })
  for (const m of sql.matchAll(/\bcreate\s+policy\s+("?[\w]+"?)\s+on\s+(?:public\.)?("?[\w]+"?)/gi)) creates.policies.add(`${m[2].replaceAll('"', '')}.${m[1].replaceAll('"', '')}`)
  for (const m of sql.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([\w]+)\s*\(/gi)) creates.functions.add(m[1])
  for (const m of sql.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([\w]+)/gi)) creates.tables.add(m[1])
  return { drops, creates }
}

/**
 * @param {(sql: string, params?: unknown[]) => Promise<object[]>} q
 * @param {{ version: string, name: string, sql: string }[]} migrations
 * @returns {Promise<{ status: 'OK'|'INFO'|'STOP', check: string, value: string, note: string }[]>}
 */
export async function runChecks(q, migrations) {
  const rows = []
  const report = (status, check, value, note = '') => rows.push({ status, check, value: String(value), note })
  const one = async (sql, params = []) => (await q(sql, params))[0]
  const exists = async (rel) => !!(await one(`select to_regclass($1) is not null as e`, [rel])).e

  // ------------------------------------------------------------- platform
  const ver = await one(`select current_setting('server_version_num')::int as n, current_setting('server_version') as v`)
  report(ver.n >= 150000 ? 'OK' : 'STOP', 'PostgreSQL version', ver.v, ver.n >= 150000 ? '' : 'Staging validated on PostgreSQL 15+; compare before going on.')
  const authCols = await one(`select
      exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous') as anon_col,
      to_regprocedure('auth.uid()') is not null as uid, to_regprocedure('auth.jwt()') is not null as jwt`)
  report(authCols.anon_col && authCols.uid && authCols.jwt ? 'OK' : 'STOP', 'Supabase Auth objects the migrations use', `auth.users.is_anonymous:${authCols.anon_col} auth.uid():${authCols.uid} auth.jwt():${authCols.jwt}`, authCols.anon_col && authCols.uid && authCols.jwt ? '' : '022/030 need these.')

  // --------------------------------------------------------- what is applied
  let applied = null
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
    ['033', `select to_regprocedure('public.canonical_assignee(text)') is not null as e`],
  ]
  const present = {}
  for (const [m, sql] of markers) present[m] = !!(await one(sql)).e
  report('INFO', 'Objects present for migrations 022–033', Object.entries(present).map(([m, p]) => `${m}:${p ? 'yes' : 'no'}`).join(' '))
  const ret = await one(`select pg_get_function_result(to_regprocedure('public.perform_lifecycle_action(asset_collection, uuid, asset_action, text, text)')) as r`)
  present['021'] = ret.r === 'asset_collection'
  if (ret.r === 'asset_collection') report('OK', '021 (Inventory ↔ Active Laptops moves)', 'applied', 'No fix-up needed.')
  else if (ret.r === 'void') report('STOP', '021 (Inventory ↔ Active Laptops moves)', 'not applied (returns void)', 'Apply 021 with supabase/adaptations/021_before_drop_changed_functions.sql in the same transaction.')
  else report('STOP', '021 (Inventory ↔ Active Laptops moves)', ret.r ?? 'function missing', 'Unexpected — compare with supabase/staging/schema-fingerprint.sql before going on.')
  const before021 = migrations.filter((m) => m.version < PLAN_FIRST)
  if (applied) {
    const missing = before021.filter((m) => !applied.includes(m.version)).map((m) => m.version.slice(-3))
    report(missing.length ? 'STOP' : 'OK', 'Migrations before 021 recorded', missing.length ? `missing: ${missing.join(', ')}` : `all ${before021.length}`, missing.length ? 'The plan assumes 001–020 are applied. Find out how this database was built first.' : '')
  }
  const pending = migrations.filter((m) => m.version >= PLAN_FIRST && m.version <= PLAN_LAST)
    .filter((m) => (applied ? !applied.includes(m.version) : !present[m.version.slice(-3)]))
  report('INFO', 'Pending in the plan', pending.length ? pending.map((m) => m.version.slice(-3)).join(', ') : 'none')

  // ---------------------------- every name a pending migration drops must exist
  const createdInPlan = { policies: new Set(), functions: new Set(), tables: new Set() }
  const missingTargets = []
  for (const m of pending) {
    const { drops, creates } = dropsAndCreates(m.sql)
    for (const d of drops) {
      const byPlan = (d.table && createdInPlan.tables.has(d.table)) || (d.kind === 'policy' && createdInPlan.policies.has(`${d.table}.${d.name}`)) || (d.kind === 'function' && createdInPlan.functions.has(d.name))
      if (byPlan) continue
      let ok
      if (d.kind === 'policy') ok = (await one(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1 and policyname = $2`, [d.table, d.name])).n === 1
      else if (d.kind === 'constraint') ok = (await one(`select count(*)::int as n from pg_constraint where conname = $2 and conrelid = to_regclass('public.' || $1)`, [d.table, d.name])).n === 1
      else if (d.kind === 'trigger') ok = (await one(`select count(*)::int as n from pg_trigger where tgname = $2 and tgrelid = to_regclass('public.' || $1)`, [d.table, d.name])).n === 1
      else ok = !!(await one(`select to_regprocedure($1) is not null as e`, [`public.${d.name}(${d.args})`])).e
      if (!ok) missingTargets.push(`${m.version.slice(-3)}: ${d.kind} ${d.table ? `${d.table}.` : ''}${d.name}${d.kind === 'function' ? `(${d.args})` : ''}`)
    }
    for (const k of Object.keys(creates)) for (const v of creates[k]) createdInPlan[k].add(v)
  }
  report(missingTargets.length ? 'STOP' : 'OK', 'Objects the pending migrations drop by name', missingTargets.length ? `${missingTargets.length} missing: ${missingTargets.join('; ')}` : pending.length ? 'all present' : 'nothing pending',
    missingTargets.length ? 'This database differs from the migrations (renamed or hand-edited). The migration would fail; find out why first.' : '')

  // ------------------------------- drift: things no migration created
  const all = migrations.map((m) => dropsAndCreates(m.sql).creates)
  const knownPolicies = new Set(all.flatMap((c) => [...c.policies]))
  const knownFunctions = new Set(all.flatMap((c) => [...c.functions]))
  const knownTables = new Set(all.flatMap((c) => [...c.tables]))
  const extraPolicies = (await q(`select tablename || '.' || policyname as k, cmd, permissive from pg_policies where schemaname = 'public' order by 1`)).filter((p) => !knownPolicies.has(p.k))
  report(extraPolicies.length ? 'STOP' : 'OK', 'Policies not created by any migration', extraPolicies.length ? extraPolicies.map((p) => `${p.k} (${p.cmd}, ${p.permissive})`).join('; ') : 'none',
    extraPolicies.length ? 'A hand-made PERMISSIVE policy can re-open what 022/023/030 close. Decide: drop it, or keep it knowingly.' : '')
  const extraFns = (await q(`select p.proname as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.prosecdef
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) order by 1`)).filter((f) => !knownFunctions.has(f.n))
  report(extraFns.length ? 'STOP' : 'OK', 'API-callable SECURITY DEFINER functions not created by any migration', extraFns.length ? extraFns.map((f) => f.n).join(', ') : 'none', extraFns.length ? 'Runs with owner rights from the API. Review each before migrating.' : '')
  const tables = await q(`select c.relname as n, c.relrowsecurity as rls, has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') as api
      from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' order by 1`)
  const noRls = tables.filter((t) => !t.rls && t.api)
  report(noRls.length ? 'STOP' : 'OK', 'API-readable tables without row-level security', noRls.length ? noRls.map((t) => t.n).join(', ') : 'none', noRls.length ? 'Anyone with the public API key could read these.' : '')
  const extraTables = tables.filter((t) => !knownTables.has(t.n))
  if (extraTables.length) report('INFO', 'Tables not created by any migration', extraTables.map((t) => t.n).join(', '), 'Not touched by the plan; review why they exist.')

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
  let withMfa = null
  if (await exists('auth.mfa_factors')) {
    withMfa = (await one(`select count(distinct f.user_id)::int as n from auth.mfa_factors f join profiles p on p.id = f.user_id where p.role = 'admin' and f.status = 'verified'`)).n
    mfa = `${withMfa} of ${admins.n} admins have a verified authenticator`
  }
  report(!admins.n ? 'STOP' : 'INFO', 'Admins and two-factor (030 requires it for admin powers)', admins.n ? mfa : 'no admin account',
    !admins.n ? 'Nobody could manage roles after 030.' : withMfa === admins.n ? 'Every admin can use admin powers after 030.' : 'An admin without a verified authenticator keeps editor-level access but cannot use admin powers until they enrol (Security page). Until then their password alone could enrol a factor — enrol promptly.')
  report('INFO', 'Profiles that cannot be deleted after 030', (await one(`select count(*)::int as n from profiles`)).n, '030 replaces deletion with Remove access (history keeps every actor).')

  // --------------------------------------------------- size, for timing
  const sizes = []
  for (const t of ['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items', 'serialized_asset_history', 'onboarding_checklists', 'offboarding_checklists', 'import_events']) {
    if (await exists(`public.${t}`)) sizes.push(`${t}=${(await one(`select count(*)::int as n from ${t}`)).n}`)
  }
  report('INFO', 'Row counts', sizes.join(' '))
  return rows
}
