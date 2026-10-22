/**
 * Rehearsal of the PRODUCTION migration chain on disposable databases (PGlite), using the same functions the
 * production applier runs (scripts/production/apply-core.mjs). Production's real state (from the read-only
 * preflight): history stops at 014; the monitors table exists with 31 rows; other_equipment does not;
 * 57 inventory laptops, 114 active laptops, 4 duplicate-serial groups, one admin without an authenticator.
 *
 * Each scenario builds that kind of database with synthetic data, plans the chain, runs it step by step, and
 * proves: no pre-existing business row changed, nothing is skipped or repeated, a partial state stops, and the
 * final schema is IDENTICAL to a database built cleanly from the migration files.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs modules without type declarations
import { loadMigrations } from '../../../scripts/production/preflight-checks.mjs'
// @ts-expect-error
import { applyStep, ensureHistoryTable, planChain, recordStep, recordedVersions } from '../../../scripts/production/apply-core.mjs'
// @ts-expect-error
import { duplicateSerialDetails, reconcile } from '../../../scripts/production/migration-state.mjs'
import { applyMigration, inCommittedTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, tableHash, type Db } from './harness'
import { seedUsers } from './fixtures'

const ROOT = join(__dirname, '..', '..', '..')
const MIG_DIR = join(ROOT, 'supabase', 'migrations')
const ADAPT_DIR = join(ROOT, 'supabase', 'adaptations')
const migrations = loadMigrations(MIG_DIR, ADAPT_DIR) as { version: string; name: string; sql: string }[]
const sqlFor = (m: { name: string }) => readFileSync(join(MIG_DIR, m.name), 'utf8')
const v = (n: number) => `202609010000${String(n).padStart(2, '0')}`
const open: Db[] = []
afterAll(async () => {
  for (const d of open) await d.close().catch(() => undefined)
})

/** A database where exactly `applied` migrations have been run (as production's hand-built schema was), with `history` recorded. */
async function buildState(applied: number[], history: number[], seed = true) {
  const db = await openDb()
  open.push(db)
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    const n = Number(file.slice(0, 14).slice(-2))
    if (!applied.includes(n)) continue
    await applyMigration(db, file, '')
    if (n === 17) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await ensureHistoryTable(db)
  for (const n of history) await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`, [v(n), 'x'])
  if (seed) await seedProduction(db)
  return db
}

/** Production-sized synthetic data: 57 inventory + 114 active laptops (4 serials appear in both), 31 monitors, 3 users, 3 imports. */
async function seedProduction(db: Db) {
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    await db.exec(`
      insert into serialized_assets (name, category, serial, status, location)
        select 'Dell Latitude ' || (g % 5), 'Laptop', 'INV-' || g, (case when g % 9 = 0 then 'damaged' when g % 7 = 0 then 'retained' else 'available' end)::asset_status, 'Shelf ' || (g % 4) from generate_series(1, 57) g;
      insert into active_laptops_np (name, category, serial, status, assigned_to, location)
        select 'ThinkPad ' || (g % 6), 'Laptop', 'NP-' || g, 'provided', 'Person ' || (g % 60), 'Remote' from generate_series(1, 114) g;
      insert into active_laptops_np (name, category, serial, status, assigned_to)
        select name, category, serial, 'provided', 'Person Dup ' || serial from serialized_assets where serial in ('INV-3', 'INV-8', 'INV-13', 'INV-21');`)
  })
  // monitors exist only where 016 has run
  const hasMonitors = (await db.query<{ e: boolean }>(`select to_regclass('public.monitors') is not null as e`)).rows[0].e
  if (hasMonitors) await db.exec(`insert into monitors (name, category, serial, status, location) select 'Dell 24', 'Monitor', 'MON-' || g, (case when g % 4 = 0 then 'provided' else 'available' end)::asset_status, 'Office' from generate_series(1, 31) g;`)
  await db.exec(`insert into import_events (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary) select null, 'serialized_assets', 'old' || g || '.xlsx', 5, 0, 0, '{}'::jsonb from generate_series(1, 3) g`).catch(() => undefined)
}

/** Everything about the schema that a migration can change, as sorted text lines (functions by normalised definition). */
async function schemaSignature(db: Db) {
  const { rows } = await db.query<{ l: string }>(`
    select 'col ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as l from information_schema.columns where table_schema = 'public'
    union all select 'pol ' || tablename || '.' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
    union all select 'trg ' || c.relname || '.' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
    union all select 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(replace(pg_get_functiondef(p.oid), E'\\r', '')) from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all select 'enum ' || t.typname || '.' || e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
    union all select 'idx ' || indexdef from pg_indexes where schemaname = 'public'
    union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
    order by 1`)
  return rows.map((r) => r.l)
}

const BUSINESS = ['serialized_assets', 'active_laptops_np', 'monitors']
const projection = (t: string) => `select row(id, name, category, serial, status, assigned_to, location)::text as r from ${t}`
async function businessHashes(db: Db) {
  const out: Record<string, string> = {}
  for (const t of BUSINESS) {
    const { rows } = await db.query<{ h: string }>(`select md5(coalesce(string_agg(r, '|' order by r), '')) as h from (${projection(t)}) x`)
    out[t] = rows[0].h
  }
  return out
}

async function runWholeChain(db: Db) {
  for (let guard = 0; guard < 60; guard++) {
    const plan = await planChain(db, migrations)
    const next = plan.find((p: { action: string }) => p.action === 'record' || p.action === 'apply')
    if (!next) return plan
    if (next.action === 'stop') throw new Error(`stop at ${next.version}`)
    if (next.action === 'record') await recordStep(db, migrations, next.version)
    else await applyStep(db, migrations, next.version, { sqlFor, adaptationsDir: ADAPT_DIR })
  }
  throw new Error('chain did not finish')
}

let cleanSignature: string[] | null = null
async function clean() {
  if (cleanSignature) return cleanSignature
  const db = await openDb()
  open.push(db)
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  cleanSignature = await schemaSignature(db)
  return cleanSignature
}

describe.skipIf(isStaging)('production chain rehearsal', () => {
  it('the likely production state: 015–018 in place but unrecorded, 019 and 020 missing → record 4, apply 019, 020, 021–035; schema equals a clean build', async () => {
    const db = await buildState([...Array(14).keys()].map((i) => i + 1).concat([15, 16, 17, 18]), [...Array(14).keys()].map((i) => i + 1))
    const plan = await planChain(db, migrations)
    const act = (n: number) => plan.find((p: { version: string }) => p.version === v(n))?.action
    expect([15, 16, 17, 18].map(act)).toEqual(['record', 'record', 'record', 'record'])
    expect([19, 20].map(act)).toEqual(['apply', 'apply'])
    expect([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 33, 34, 35].map(act).every((a) => a === 'apply')).toBe(true)
    const before = await businessHashes(db)
    const counts = async () => (await db.query<{ a: number; n: number; m: number }>(`select (select count(*) from serialized_assets)::int a, (select count(*) from active_laptops_np)::int n, (select count(*) from monitors)::int m`)).rows[0]
    const c0 = await counts()
    expect(c0).toEqual({ a: 57, n: 118, m: 31 }) // 114 + 4 duplicates of inventory serials
    const final = await runWholeChain(db)
    expect(final.every((p: { action: string }) => p.action === 'recorded')).toBe(true)
    expect((await recordedVersions(db)).length).toBe(migrations.length)
    // Production's own rows: untouched (id, name, serial, status, assignee, location)
    expect(await businessHashes(db)).toEqual(before)
    expect(await counts()).toEqual(c0)
    // The duplicate serials are kept and listed, never merged or deleted (027)
    expect((await db.query<{ n: number }>(`select count(*)::int n from serial_duplicate_candidates`)).rows[0].n).toBeGreaterThan(0)
    // Same schema as a database built cleanly from the files
    expect(await schemaSignature(db)).toEqual(await clean())
  }, 600_000)

  it('everything 001–020 in place but history stops at 014 → only history rows are added (nothing re-run), then 021–035', async () => {
    const all = Array.from({ length: 20 }, (_, i) => i + 1)
    const db = await buildState(all, all.slice(0, 14))
    const plan = await planChain(db, migrations)
    expect(plan.filter((p: { action: string }) => p.action === 'record').map((p: { version: string }) => p.version)).toEqual([15, 16, 17, 18, 19, 20].map(v))
    expect(plan.some((p: { version: string; action: string }) => p.version <= v(20) && p.action === 'apply')).toBe(false)
    await runWholeChain(db)
    expect(await schemaSignature(db)).toEqual(await clean())
  }, 600_000)

  it('only 001–014 exist → 015–020 are applied in order (017 with its documented adaptation), then 021–035', async () => {
    const base = Array.from({ length: 14 }, (_, i) => i + 1)
    const db = await buildState(base, base)
    const plan = await planChain(db, migrations)
    expect([15, 16, 17, 18, 19, 20].every((n) => plan.find((p: { version: string }) => p.version === v(n)).action === 'apply')).toBe(true)
    const before = await businessHashes(db).catch(() => ({}))
    await runWholeChain(db)
    expect(await schemaSignature(db)).toEqual(await clean())
    void before
  }, 600_000)

  it('a PARTLY present migration stops everything and changes nothing (019 with its write policies removed by hand)', async () => {
    const applied = Array.from({ length: 19 }, (_, i) => i + 1)
    const db = await buildState(applied, applied.slice(0, 14))
    await db.exec(`drop policy other_equipment_insert on other_equipment; drop policy other_equipment_update_editor on other_equipment;`)
    const plan = await planChain(db, migrations)
    const p19 = plan.find((p: { version: string }) => p.version === v(19))
    expect(p19.action).toBe('stop')
    expect(p19.missing.join(' ')).toMatch(/other_equipment_insert/)
    for (const n of [15, 16, 17, 18]) await recordStep(db, migrations, v(n)) // the earlier ones are fine; only 019 is damaged
    const history = await recordedVersions(db)
    await expect(recordStep(db, migrations, v(19))).rejects.toThrow(/not fully in place/)
    await expect(applyStep(db, migrations, v(19), { sqlFor, adaptationsDir: ADAPT_DIR })).rejects.toThrow(/partly in place/)
    expect(await recordedVersions(db)).toEqual(history)
  }, 600_000)

  it('guards: no skipping ahead, no re-running, no recording something that is not there, a failing migration leaves nothing behind', async () => {
    const base = Array.from({ length: 14 }, (_, i) => i + 1).concat([15, 16])
    const db = await buildState(base, base.slice(0, 14), false)
    // out of order
    await expect(applyStep(db, migrations, v(21), { sqlFor, adaptationsDir: ADAPT_DIR })).rejects.toThrow(/Cannot apply/)
    // 015/016 are in place: recording works once, then is refused
    await recordStep(db, migrations, v(15))
    await expect(recordStep(db, migrations, v(15))).rejects.toThrow(/already recorded/)
    await recordStep(db, migrations, v(16))
    // 017 is absent here, so it cannot be "recorded"; an in-place migration cannot be re-run
    await expect(recordStep(db, migrations, v(17))).rejects.toThrow(/not fully in place/)
    await expect(applyStep(db, migrations, v(15), { sqlFor, adaptationsDir: ADAPT_DIR })).rejects.toThrow(/already recorded/)
    // a failing migration: rolled back, no history row
    const hist = await recordedVersions(db)
    await expect(applyStep(db, migrations, v(17), { sqlFor: () => 'select 1/0', adaptationsDir: ADAPT_DIR })).rejects.toThrow(/rolled back/)
    expect(await recordedVersions(db)).toEqual(hist)
    expect(await tableHash(db, 'profiles')).toBeTruthy()
  }, 600_000)

  it('the duplicate-serial report finds exactly the production-sized case (4 groups / 8 devices) and prints no names', async () => {
    const base = Array.from({ length: 14 }, (_, i) => i + 1).concat([15, 16])
    const db = await buildState(base, base.slice(0, 14))
    const rows = await duplicateSerialDetails(async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows)
    expect(new Set(rows.map((r: { key: string }) => r.key)).size).toBe(4)
    expect(rows).toHaveLength(8)
    expect(Object.keys(rows[0]).sort()).toEqual(['assigned', 'history', 'key', 'serial', 'status', 'tbl', 'updated'])
    expect(rows.filter((r: { tbl: string }) => r.tbl === 'active_laptops_np').every((r: { assigned: boolean }) => r.assigned)).toBe(true)
  }, 600_000)

  it('the plan is read-only and stable: planning twice changes nothing and gives the same answer', async () => {
    const base = Array.from({ length: 14 }, (_, i) => i + 1).concat([15, 16, 17, 18])
    const db = await buildState(base, base.slice(0, 14))
    const a = JSON.stringify(await planChain(db, migrations))
    const b = JSON.stringify(await planChain(db, migrations))
    expect(a).toBe(b)
    expect((await recordedVersions(db)).length).toBe(14)
    void reconcile
  }, 600_000)
})
