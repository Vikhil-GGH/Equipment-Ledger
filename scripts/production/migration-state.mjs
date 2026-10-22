// Works out, from the database itself, which of migrations 001–020 are really in place when the
// migration history table does not say (production's history stops at 014, but its schema
// includes parts of 015–020 applied by hand). READ-ONLY: every query here is a catalog lookup.
//
// For each migration the objects it creates (tables, views, enum values, functions, policies,
// triggers, columns) are parsed from its SQL and looked up:
//   applied  every object is there  -> only the history row is missing (record it, do not re-run)
//   absent   none is there          -> apply it (in order)
//   partial  some but not all       -> STOP: someone has to look; running it would fail or duplicate
// A few migrations only replace an existing function, so "the function exists" proves nothing; those
// have an explicit marker (OVERRIDES).

const strip = (sql) => sql.replace(/--[^\n]*/g, '')
const name = (s) => s.replaceAll('"', '').replace(/^public\./, '')

/** What a migration creates, parsed from its SQL. */
export function footprint(sqlText) {
  const sql = strip(sqlText)
  const out = { tables: new Set(), views: new Set(), enumValues: [], functions: new Set(), policies: new Set(), triggers: new Set(), columns: [] }
  for (const m of sql.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?[\w]+"?)/gi)) out.tables.add(name(m[1]))
  for (const m of sql.matchAll(/\bcreate\s+(?:or\s+replace\s+)?view\s+(?:public\.)?("?[\w]+"?)/gi)) out.views.add(name(m[1]))
  for (const m of sql.matchAll(/\balter\s+type\s+(?:public\.)?([\w]+)\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'/gi)) out.enumValues.push({ type: m[1], label: m[2] })
  for (const m of sql.matchAll(/\bcreate\s+function\s+(?:public\.)?([\w]+)\s*\(/gi)) out.functions.add(m[1]) // plain CREATE only: "or replace" proves nothing
  for (const m of sql.matchAll(/\bcreate\s+policy\s+("?[\w]+"?)\s+on\s+(?:public\.)?("?[\w]+"?)/gi)) out.policies.add(`${name(m[2])}.${name(m[1])}`)
  for (const m of sql.matchAll(/\bcreate\s+trigger\s+([\w]+)[\s\S]*?\bon\s+(?:public\.)?([\w]+)/gi)) out.triggers.add(`${m[2]}.${m[1]}`)
  for (const m of sql.matchAll(/\balter\s+table\s+(?:only\s+)?(?:public\.)?([\w]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\w]+)/gi)) out.columns.push({ table: m[1], column: m[2] })
  return out
}

/** Explicit markers for migrations whose footprint says nothing (they replace a function that already exists). */
const OVERRIDES = {
  // 017 makes new anonymous users editors; its marker is that handle_new_user mentions is_anonymous.
  '20260901000017': async (q) => {
    const r = (await q(`select pg_get_functiondef(p.oid) as d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'handle_new_user'`))[0]
    return r ? { present: /is_anonymous/i.test(r.d) ? ['handle_new_user treats anonymous users differently'] : [], missing: /is_anonymous/i.test(r.d) ? [] : ['handle_new_user does not mention is_anonymous'] } : { present: [], missing: ['function handle_new_user'] }
  },
}

/**
 * @param {(sql: string, params?: unknown[]) => Promise<object[]>} q
 * @param {{ version: string, name: string, sql: string }} migration   sql as from loadMigrations (comments stripped)
 */
export async function detectMigration(q, migration) {
  const present = []
  const missing = []
  const check = (ok, label) => (ok ? present : missing).push(label)
  const fp = footprint(migration.sql)
  for (const t of fp.tables) check(!!(await q(`select to_regclass($1) is not null as e`, ['public.' + t]))[0].e, `table ${t}`)
  for (const v of fp.views) check(!!(await q(`select to_regclass($1) is not null as e`, ['public.' + v]))[0].e, `view ${v}`)
  for (const e of fp.enumValues) {
    const r = await q(`select 1 from pg_enum en join pg_type t on t.oid = en.enumtypid where t.typname = $1 and en.enumlabel = $2`, [e.type, e.label])
    check(r.length > 0, `enum ${e.type}.'${e.label}'`)
  }
  for (const f of fp.functions) check((await q(`select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [f])).length > 0, `function ${f}`)
  for (const p of fp.policies) {
    const [table, policy] = p.split('.')
    check((await q(`select 1 from pg_policies where schemaname = 'public' and tablename = $1 and policyname = $2`, [table, policy])).length > 0, `policy ${p}`)
  }
  for (const t of fp.triggers) {
    const [table, trig] = t.split('.')
    check((await q(`select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relname = $1 and tg.tgname = $2 and not tg.tgisinternal`, [table, trig])).length > 0, `trigger ${t}`)
  }
  for (const c of fp.columns) check((await q(`select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2`, [c.table, c.column])).length > 0, `column ${c.table}.${c.column}`)
  const override = OVERRIDES[migration.version]
  if (override) {
    const o = await override(q)
    present.push(...o.present)
    missing.push(...o.missing)
  }
  const status = missing.length === 0 && present.length > 0 ? 'applied' : present.length === 0 ? 'absent' : 'partial'
  return { version: migration.version, name: migration.name, status, present, missing }
}

/**
 * What to do about the migrations up to `lastBase` that the history table does not list.
 * action: 'record' (in place, add the history row), 'apply' (run it), 'stop' (partial: a human decides).
 */
export async function reconcile(q, migrations, recordedVersions, lastBase = '20260901000020') {
  const recorded = new Set(recordedVersions)
  const plan = []
  for (const m of migrations.filter((x) => x.version <= lastBase)) {
    if (recorded.has(m.version)) {
      plan.push({ version: m.version, name: m.name, action: 'recorded', present: [], missing: [] })
      continue
    }
    const d = await detectMigration(q, m)
    plan.push({ version: m.version, name: m.name, action: d.status === 'applied' ? 'record' : d.status === 'absent' ? 'apply' : 'stop', present: d.present, missing: d.missing })
  }
  // Order sanity: a migration cannot be absent while a LATER one that depends on it is in place.
  const firstAbsent = plan.findIndex((p) => p.action === 'apply')
  const laterInPlace = plan.findIndex((p, i) => i > firstAbsent && firstAbsent >= 0 && (p.action === 'record' || p.action === 'recorded'))
  if (firstAbsent >= 0 && laterInPlace >= 0) plan[firstAbsent].note = `${plan[laterInPlace].version} is in place although this one is not: check by hand before applying anything`
  return plan
}

/**
 * Devices whose serial collides once case, spaces and look-alike whitespace are ignored (027's rule), across every
 * device table that exists. Facts only, no personal data: table, status, whether someone is assigned, last update,
 * history rows. `q` must be read-only.
 */
export async function duplicateSerialDetails(q) {
  const tables = []
  for (const [t, h] of [['serialized_assets', 'serialized_asset_history'], ['active_laptops_np', 'active_laptops_np_history'], ['monitors', 'monitors_history'], ['other_equipment', 'other_equipment_history']]) {
    if ((await q(`select to_regclass($1) is not null as e`, ['public.' + t]))[0].e) tables.push([t, h])
  }
  const norm = `upper(regexp_replace(btrim(coalesce(serial, ''), ' ' || chr(9) || chr(10) || chr(13) || chr(160)), '[[:space:]' || chr(160) || ']+', ' ', 'g'))`
  const union = tables.map(([t, h]) => `select '${t}' as tbl, d.id, d.serial, d.status::text as status, (nullif(btrim(d.assigned_to), '') is not null) as assigned, d.updated_at::date as updated,
      (select count(*) from ${h} x where x.asset_id = d.id)::int as history from ${t} d`).join(' union all ')
  return q(`with d as (${union}), k as (select *, ${norm} as key from d), dup as (select key from k where key <> '' group by key having count(*) > 1)
    select key, tbl, serial, status, assigned, updated, history from k where key in (select key from dup) order by key, tbl, updated`)
}
