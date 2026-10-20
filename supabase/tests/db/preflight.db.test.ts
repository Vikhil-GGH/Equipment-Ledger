/**
 * The production preflight checks (scripts/production/preflight-checks.mjs)
 * against disposable databases (PGlite): one at the state production is
 * expected to be in (001–020 applied), one fully migrated. Proves the checks
 * pass on a clean database and catch drift: a hand-made policy, a renamed
 * policy the plan drops, an API-callable definer function, a table without RLS.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs module without type declarations
import { dropsAndCreates, loadMigrations, runChecks } from '../../../scripts/production/preflight-checks.mjs'
import { applyMigration, inCommittedTx, inRolledBackTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, type Db } from './harness'
import { seedLedger, seedUsers } from './fixtures'

type Row = { status: string; check: string; value: string; note: string }
const ROOT = join(__dirname, '..', '..', '..')
const migrations = loadMigrations(join(ROOT, 'supabase', 'migrations'), join(ROOT, 'supabase', 'adaptations'))
let at020: Db
let at031: Db

async function build(until: string) {
  const db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= until) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    await seedLedger(db, 'PRE')
  })
  return db
}
const checks = async (db: Db): Promise<Row[]> => {
  await db.exec('begin read only')
  try {
    return await runChecks(async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows, migrations)
  } finally {
    await db.exec('rollback')
  }
}
const get = (rows: Row[], check: string) => rows.find((r) => r.check.startsWith(check))!
const stops = (rows: Row[]) => rows.filter((r) => r.status === 'STOP').map((r) => r.check)

beforeAll(async () => {
  if (isStaging) return
  at020 = await build('20260901000021')
  at031 = await build('20260901000032')
}, 600_000)
afterAll(async () => {
  await at020?.close()
  await at031?.close()
})

describe('parsing the migrations', () => {
  it('finds every name the plan drops (29 drops in 021–031, including the 021 adaptation)', () => {
    const plan = migrations.filter((m: { version: string }) => m.version >= '20260901000021' && m.version <= '20260901000031')
    const drops = plan.flatMap((m: { sql: string }) => dropsAndCreates(m.sql).drops)
    expect(drops).toHaveLength(29)
    expect(drops).toContainEqual({ kind: 'function', name: 'commit_bulk_import', args: 'text, jsonb' })
    expect(drops).toContainEqual({ kind: 'constraint', name: 'onboarding_checklists_assigned_asset_id_fkey', table: 'onboarding_checklists' })
  })
})

describe.skipIf(isStaging)('preflight against a database at 020 (production before the plan)', () => {
  it('only the expected 021 fix-up is a STOP; every dropped name is present; no drift', async () => {
    const rows = await checks(at020)
    expect(stops(rows)).toEqual(['021 (Inventory ↔ Active Laptops moves)'])
    expect(get(rows, 'Pending in the plan').value).toBe('021, 022, 023, 024, 025, 026, 027, 028, 029, 030, 031')
    expect(get(rows, 'Objects the pending migrations drop by name')).toMatchObject({ status: 'OK', value: 'all present' })
    expect(get(rows, 'Policies not created by any migration').status).toBe('OK')
    expect(get(rows, 'API-callable SECURITY DEFINER functions').status).toBe('OK')
    expect(get(rows, 'API-readable tables without row-level security').status).toBe('OK')
  })

  it('a hand-made policy is a STOP (it could re-open what 023 closes)', () =>
    inRolledBackTx(at020, async () => {
      await at020.exec(`create policy allow_all_inserts on monitors for insert with check (true)`)
      const row = get(await checks(at020), 'Policies not created by any migration')
      expect(row.status).toBe('STOP')
      expect(row.value).toContain('monitors.allow_all_inserts (INSERT, PERMISSIVE)')
    }))

  it('a renamed policy that 023 drops is a STOP (023 would fail)', () =>
    inRolledBackTx(at020, async () => {
      await at020.exec(`alter policy monitors_insert on monitors rename to monitors_insert_v2`)
      const rows = await checks(at020)
      expect(get(rows, 'Objects the pending migrations drop by name')).toMatchObject({ status: 'STOP' })
      expect(get(rows, 'Objects the pending migrations drop by name').value).toContain('023: policy monitors.monitors_insert')
    }))

  it('an API-callable definer function and a table without RLS are STOPs', () =>
    inRolledBackTx(at020, async () => {
      await at020.exec(`create function public.quick_fix() returns int language sql security definer as 'select 1'; grant execute on function public.quick_fix() to authenticated;
        create table public.scratch_notes (id int); grant select on public.scratch_notes to authenticated;`)
      const rows = await checks(at020)
      expect(get(rows, 'API-callable SECURITY DEFINER functions')).toMatchObject({ status: 'STOP', value: 'quick_fix' })
      expect(get(rows, 'API-readable tables without row-level security')).toMatchObject({ status: 'STOP', value: 'scratch_notes' })
      expect(get(rows, 'Tables not created by any migration').value).toBe('scratch_notes')
    }))
})

describe.skipIf(isStaging)('preflight against a fully migrated database (031)', () => {
  it('nothing pending, nothing blocks', async () => {
    const rows = await checks(at031)
    expect(stops(rows)).toEqual([])
    expect(get(rows, 'Pending in the plan').value).toBe('none')
    expect(get(rows, 'Objects present for migrations 022–031').value).not.toContain(':no')
  })
})
