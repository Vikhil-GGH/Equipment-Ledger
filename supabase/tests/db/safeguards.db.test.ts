/**
 * Tests for 20260901000029_activation_and_bulk_import.sql on a fresh
 * disposable database (PGlite only): employment-activation safeguards,
 * idempotent Bulk Stock imports (H4), preservation, restore, rollback.
 * Every test runs in a transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actAs,
  actAsDatabase,
  applyMigration,
  applyRollback,
  errorOf,
  inCommittedTx,
  inRolledBackTx,
  isStaging,
  loadSupabaseStub,
  migrationFiles,
  openDb,
  readAdaptation,
  tableHash,
  type Db,
} from './harness'
import { ADMIN, EDITOR, VIEWER, backupTables, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'
import { HR_STATUS_MAPPING, classifyHrStatus } from '../../../src/features/employees/employeeStatusMapping'

const M029 = '20260901000029_activation_and_bulk_import.sql'
let db: Db
let ids: LedgerIds
const pre: Record<string, string> = {}
let defsBefore: { proname: string; def: string }[]
const TABLES = ['profiles', 'employees', 'employee_history', 'bulk_items', 'bulk_item_history', 'import_events', 'serialized_assets',
  'active_laptops_np', 'equipment_issues', 'onboarding_checklists', 'offboarding_checklists', 'serial_keys']

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
const definitions = async () =>
  (await db.query<{ proname: string; def: string }>(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1, 2`)).rows
const norm = (d: string) => d.replace(/\r\n/g, '\n')
const sameDefs = (a: { proname: string; def: string }[], b: { proname: string; def: string }[]) => {
  const key = (x: { proname: string; def: string }) => `${x.proname}\n${norm(x.def)}`
  return { missing: a.filter((x) => !b.some((y) => key(y) === key(x))).map((x) => x.proname), extra: b.filter((x) => !a.some((y) => key(y) === key(x))).map((x) => x.proname) }
}

const EMP_COLS = 'id, full_name, name_key, email, created_by, created_at, first_name, last_name, department, job_title, hr_status, manager, start_date, employment_status, reactivation_pending, status_changed_at, updated_at, email_key'
const employeesHash = async () => (await one<{ h: string }>(`select md5(coalesce(string_agg(row(${EMP_COLS})::text, '|' order by id), '')) as h from employees`)).h
const emp = (id: string) => one(`select employment_status, status_decision_required, reactivation_pending, hr_status from employees where id = $1`, [id])
const history = (id: string) => db.query(`select kind, from_status, to_status, source from employee_history where employee_id = $1 order by at`, [id]).then((r) => r.rows)
const importEmployees = (rows: unknown[]) => rpc<Record<string, any>>(db, `commit_employee_import('hr.xlsx', $1::jsonb)`, [JSON.stringify(rows)])
const person = (i: number, hr: string, over: Record<string, unknown> = {}) => ({
  row: i, action: 'create', fields: { first_name: `P${i}`, last_name: `Person${i}`, hr_status: hr, email: `p${i}@example.invalid` }, ...over,
})
async function onboardingFor(employeeId: string, name: string) {
  return (await one<{ id: string }>(`insert into onboarding_checklists (employee_name, employee_id, created_by) values ($1, $2, $3) returning id`, [name, employeeId, EDITOR.id])).id
}
const complete = (id: string) =>
  db.query(`update onboarding_checklists set identity_created = true, equipment_assigned = true, required_access_provided = true, onboarding_successful = true where id = $1`, [id])
const byEmail = async (email: string) => (await one<{ id: string }>(`select id from employees where email_key = $1`, [email])).id
const bulkImport = (rows: unknown[], filename = 'delivery.xlsx', confirm = false) =>
  rpc<Record<string, any>>(db, `commit_bulk_import($1, $2::jsonb, $3)`, [filename, JSON.stringify(rows), confirm])
const stock = (name: string) => one(`select available, provided, retained, damaged, decommissioned from bulk_items where name = $1`, [name])

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M029) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    const l = await seedLedger(db, 'SAFE')
    await actAs(db, ADMIN)
    await rpc(db, `perform_bulk_action($1, 'issue', 3)`, [l.bulkItem])
    // An employee from the old import rule (status set) and history, to preserve.
    await importEmployees([{ row: 1, action: 'create', fields: { first_name: 'Old', last_name: 'Import', hr_status: 'Active', email: 'old@example.invalid' }, status: 'active' }])
    await actAsDatabase(db)
    return l
  })
  for (const t of TABLES) pre[t] = await tableHash(db, t)
  pre.employees_cols = await employeesHash()
  defsBefore = await definitions()
  await applyMigration(db, M029)
}, 240_000)

afterAll(async () => {
  await db?.close()
})

const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('029 applied to existing data', () => {
  it('changes no existing row or value', async () => {
    for (const t of TABLES.filter((x) => x !== 'employees')) expect(await tableHash(db, t), t).toBe(pre[t])
    expect(await employeesHash()).toBe(pre.employees_cols)
    expect(await n(`select count(*) as n from employees where status_decision_required`)).toBe(0)
  })

  it('the database status mapping is exactly the app mapping (employeeStatusMapping.ts)', async () => {
    const samples = [...Object.keys(HR_STATUS_MAPPING), ...Object.keys(HR_STATUS_MAPPING).map((k) => `  ${k.toUpperCase()}  `),
      'Leave of Absence', 'On Leave', 'Full-time', 'Terminated - Voluntary', 'Activ', 'Former  employee', '', '   ']
    for (const s of samples) {
      const app = s.trim() ? classifyHrStatus(s) : 'blank'
      expect((await one<{ c: string }>(`select hr_status_class($1) as c`, [s])).c, JSON.stringify(s)).toBe(app)
    }
    expect((await one<{ c: string }>(`select hr_status_class(null) as c`)).c).toBe('blank')
  })
})

describe.skipIf(isStaging)('1: onboarding completion activates only when it is clear', () => {
  it('recognised Active status → activated', tx(async () => {
    await actAs(db, EDITOR)
    await importEmployees([person(1, 'Active')]) // no status sent: added as Not in directory, flagged
    const id = await byEmail('p1@example.invalid')
    expect(await emp(id)).toMatchObject({ employment_status: null, status_decision_required: true })
    await complete(await onboardingFor(id, 'P1 Person1'))
    expect(await emp(id)).toMatchObject({ employment_status: 'active', status_decision_required: false, hr_status: 'Active' })
  }))

  it('ambiguous status ("Leave of Absence") → not activated; flagged for a decision; equipment and checklist untouched', tx(async () => {
    await actAs(db, EDITOR)
    await importEmployees([person(2, 'Leave of Absence')])
    const id = await byEmail('p2@example.invalid')
    await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [id, ids.spareInventoryLaptop])
    const register = await tableHash(db, 'equipment_issues')
    const devices = await Promise.all(['serialized_assets', 'active_laptops_np'].map((t) => tableHash(db, t)))
    const onb = await onboardingFor(id, 'P2 Person2')
    await complete(onb)
    expect(await emp(id)).toMatchObject({ employment_status: null, status_decision_required: true, hr_status: 'Leave of Absence' })
    expect((await history(id)).map((h) => [h.kind, h.source])).toEqual([['created', 'import'], ['decision_required', 'onboarding_completed']])
    expect(await one(`select identity_created, equipment_assigned, required_access_provided, onboarding_successful from onboarding_checklists where id = $1`, [onb]))
      .toEqual({ identity_created: true, equipment_assigned: true, required_access_provided: true, onboarding_successful: true })
    expect(await tableHash(db, 'equipment_issues')).toBe(register)
    expect(await Promise.all(['serialized_assets', 'active_laptops_np'].map((t) => tableHash(db, t)))).toEqual(devices)
    // Unticking and re-ticking doesn't add another decision entry.
    await db.query(`update onboarding_checklists set onboarding_successful = false where id = $1`, [onb])
    await complete(onb)
    expect((await history(id)).filter((h) => h.kind === 'decision_required')).toHaveLength(1)
  }))

  it('recognised Inactive status → never activated by onboarding', tx(async () => {
    await actAs(db, EDITOR)
    await importEmployees([person(3, 'Terminated')])
    const id = await byEmail('p3@example.invalid')
    await complete(await onboardingFor(id, 'P3 Person3'))
    expect(await emp(id)).toMatchObject({ employment_status: null, status_decision_required: true })
    // ...and one already Inactive stays Inactive (rehire flag, as before).
    await importEmployees([person(4, 'Terminated', { status: 'inactive' })])
    const id4 = await byEmail('p4@example.invalid')
    await complete(await onboardingFor(id4, 'P4 Person4'))
    expect(await emp(id4)).toMatchObject({ employment_status: 'inactive', reactivation_pending: true })
  }))

  it('a genuine new hire (no imported status) is still activated by onboarding', tx(async () => {
    await actAs(db, EDITOR)
    const id = await rpc<string>(db, `create_employee('Brand New Hire')`)
    await complete(await onboardingFor(id, 'Brand New Hire'))
    expect(await emp(id)).toMatchObject({ employment_status: 'active', status_decision_required: false })
  }))

  it('a row imported with a blank status is not mistaken for a new hire', tx(async () => {
    await actAs(db, EDITOR)
    await importEmployees([person(5, '')])
    const id = await byEmail('p5@example.invalid')
    expect(await emp(id)).toMatchObject({ employment_status: null, status_decision_required: true, hr_status: null })
    await complete(await onboardingFor(id, 'P5 Person5'))
    expect(await emp(id)).toMatchObject({ employment_status: null, status_decision_required: true })
  }))

  it('an editor resolves the decision explicitly; the imported text is kept', tx(async () => {
    await actAs(db, EDITOR)
    await importEmployees([person(6, 'Leave of Absence')])
    const id = await byEmail('p6@example.invalid')
    await complete(await onboardingFor(id, 'P6 Person6'))
    expect(await rpc<boolean>(db, `set_employment_status($1, 'active', 'Confirmed with HR')`, [id])).toBe(true)
    expect(await emp(id)).toMatchObject({ employment_status: 'active', status_decision_required: false, hr_status: 'Leave of Absence' })
    expect((await history(id)).at(-1)).toMatchObject({ kind: 'status', from_status: null, to_status: 'active', source: 'manual' })
    await actAs(db, VIEWER)
    expect(await errorOf(db, `select set_employment_status($1, 'inactive')`, [id])).toMatch(/Not authorized/)
  }))

  it('an approved status in an import also settles the decision', tx(async () => {
    await actAs(db, EDITOR)
    await importEmployees([person(7, 'Leave of Absence')])
    const id = await byEmail('p7@example.invalid')
    await importEmployees([{ row: 1, action: 'update', employee_id: id, fields: {}, status: 'inactive' }])
    expect(await emp(id)).toMatchObject({ employment_status: 'inactive', status_decision_required: false })
  }))
})

describe.skipIf(isStaging)('3: Bulk Stock imports are deliveries — the same delivery is never counted twice', () => {
  const file = [
    { name: 'SAFE Wireless Mouse', category: 'Accessory', location: 'HQ', quantity: 10 },
    { name: 'Webcam', category: 'Accessory', location: 'HQ', quantity: 8 },
  ]

  it('first import adds the quantities; the same file again adds nothing and says when it was imported', tx(async () => {
    await actAs(db, EDITOR)
    const before = await stock('SAFE Wireless Mouse')
    expect(await bulkImport(file)).toMatchObject({ created: 1, updated: 1, unchanged: 0 })
    const after = await stock('SAFE Wireless Mouse')
    expect(after.available).toBe(before.available + 10)
    expect((await stock('Webcam')).available).toBe(8)
    const hist = await n(`select count(*) as n from bulk_item_history`)
    const again = await bulkImport(file)
    expect(again).toMatchObject({ created: 0, updated: 0, duplicate_of: { filename: 'delivery.xlsx' } })
    expect(await stock('SAFE Wireless Mouse')).toEqual(after)
    expect(await n(`select count(*) as n from bulk_item_history`)).toBe(hist)
    expect(await n(`select count(*) as n from bulk_items where name = 'Webcam'`)).toBe(1)
  }))

  it('a renamed copy with rows reordered, different capitalisation and spacing is still the same delivery', tx(async () => {
    await actAs(db, EDITOR)
    await bulkImport(file)
    const after = await stock('SAFE Wireless Mouse')
    const disguised = [{ name: '  WEBCAM ', category: 'accessory', location: '', quantity: '8' }, { name: 'safe wireless   mouse', category: 'ACCESSORY', location: 'Store', quantity: 10 }]
    expect(await bulkImport(disguised, 'Copy of delivery (2).xlsx')).toMatchObject({ created: 0, updated: 0, duplicate_of: expect.any(Object) })
    expect(await stock('SAFE Wireless Mouse')).toEqual(after)
    // A different delivery (different quantities) is added normally.
    expect(await bulkImport([{ ...file[0], quantity: 5 }], 'delivery-2.xlsx')).toMatchObject({ updated: 1 })
    expect((await stock('SAFE Wireless Mouse')).available).toBe(after.available + 5)
  }))

  it('a genuinely new delivery of identical content is added only when confirmed, and recorded as such', tx(async () => {
    await actAs(db, EDITOR)
    await bulkImport(file)
    const after = await stock('SAFE Wireless Mouse')
    const r = await bulkImport(file, 'delivery-again.xlsx', true)
    expect(r).toMatchObject({ created: 0, updated: 2, repeat_of: expect.any(String) })
    expect((await stock('SAFE Wireless Mouse')).available).toBe(after.available + 10)
    expect(await n(`select count(*) as n from bulk_item_history where detail = 'Received via import from delivery-again.xlsx (confirmed as a new delivery of an earlier file)'`)).toBe(2)
    expect(await n(`select count(*) as n from bulk_import_receipts where repeat_of is not null`)).toBe(1)
  }))

  it('quantity 0 or blank changes nothing and writes no history; an item listed twice is rejected; bad quantities rejected', tx(async () => {
    await actAs(db, EDITOR)
    const hist = await n(`select count(*) as n from bulk_item_history`)
    const before = await stock('SAFE Wireless Mouse')
    expect(await bulkImport([{ name: 'SAFE Wireless Mouse', category: 'Accessory', location: '', quantity: '' }, { name: 'Wireless Mouse ', category: 'accessory', location: '', quantity: 0 }].slice(0, 1))).toMatchObject({ updated: 0, unchanged: 1 })
    expect(await stock('SAFE Wireless Mouse')).toEqual(before)
    expect(await n(`select count(*) as n from bulk_item_history`)).toBe(hist)
    expect(await errorOf(db, `select commit_bulk_import('x.xlsx', $1::jsonb)`, [JSON.stringify([file[0], { ...file[0], name: ' safe wireless mouse', quantity: 3 }])])).toMatch(/lists the same item more than once: "SAFE Wireless Mouse"/)
    expect(await errorOf(db, `select commit_bulk_import('x.xlsx', $1::jsonb)`, [JSON.stringify([{ ...file[0], quantity: -4 }])])).toMatch(/whole numbers/)
    expect(await errorOf(db, `select commit_bulk_import('x.xlsx', $1::jsonb)`, [JSON.stringify([{ ...file[0], quantity: '2.5' }])])).toMatch(/whole numbers/)
    expect(await errorOf(db, `select commit_bulk_import('x.xlsx', '[]'::jsonb)`)).toMatch(/Nothing to import/)
    expect(await stock('SAFE Wireless Mouse')).toEqual(before)
  }))

  it('existing stock and every other bucket are preserved; only Available changes by the delivery', tx(async () => {
    await actAs(db, EDITOR)
    const before = await stock('SAFE Wireless Mouse')
    await bulkImport([{ ...file[0], quantity: 7 }], 'd3.xlsx')
    expect(await stock('SAFE Wireless Mouse')).toEqual({ ...before, available: before.available + 7 })
  }))

  it('concurrency: the same content is serialised by an advisory lock; two items with the same normalised name cannot exist', tx(async () => {
    await actAs(db, EDITOR)
    const fnDef = await one<{ d: string }>(`select pg_get_functiondef('commit_bulk_import(text, jsonb, boolean)'::regprocedure) as d`)
    expect(fnDef.d).toMatch(/pg_advisory_xact_lock\(hashtext\('commit_bulk_import'\), hashtext\(v_hash\)\)/)
    expect(await errorOf(db, `select create_bulk_item(' safe WIRELESS mouse', 'accessory')`)).toMatch(/A Bulk Stock item "safe WIRELESS mouse" in category "accessory" already exists — use Receive stock on it instead/)
    await actAsDatabase(db)
    expect(await errorOf(db, `insert into bulk_items (name, category) values (' safe wireless MOUSE', 'accessory ')`)).toMatch(/bulk_items_one_per_name_category/)
  }))

  it('viewers cannot import; receipts are read-only', tx(async () => {
    await actAs(db, VIEWER)
    expect(await errorOf(db, `select commit_bulk_import('x.xlsx', '[{"name":"A","category":"B","quantity":1}]'::jsonb)`)).toMatch(/Not authorized/)
    await actAs(db, ADMIN)
    expect(await errorOf(db, `insert into bulk_import_receipts (content_hash, filename) values ('x', 'y')`)).toMatch(/permission denied/)
  }))

  it('backup/restore keeps the receipts, so a restored database still recognises an earlier delivery', tx(async () => {
    await actAs(db, EDITOR)
    await bulkImport(file)
    await actAsDatabase(db)
    const p: Record<string, any> = {}
    for (const t of [...(await backupTables(db)), 'bulk_import_receipts']) p[t] = (await one<{ v: unknown[] }>(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') as v from ${t} x`)).v
    p._counts = Object.fromEntries(Object.entries(p).map(([t, r]) => [t, (r as unknown[]).length]))
    const receipts = await tableHash(db, 'bulk_import_receipts')
    const employees = await tableHash(db, 'employees')
    await actAs(db, ADMIN)
    await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(p)])
    await actAsDatabase(db)
    expect(await tableHash(db, 'bulk_import_receipts')).toBe(receipts)
    expect(await tableHash(db, 'employees')).toBe(employees)
    await actAs(db, EDITOR)
    expect(await bulkImport(file)).toMatchObject({ duplicate_of: expect.any(Object) })
  }))
})

describe.skipIf(isStaging)('029 rollback', () => {
  it('029_down restores the 028/014 functions exactly, keeps every pre-029 row, saves what 029 recorded; 029 re-applies', async () => {
    await inCommittedTx(db, async () => {
      await actAs(db, EDITOR)
      await bulkImport([{ name: 'Rollback Cable', category: 'Cable', location: '', quantity: 2 }], 'rb.xlsx')
      await importEmployees([person(9, 'Leave of Absence')])
      await actAsDatabase(db)
    })
    await applyRollback(db, '20260901000029_down.sql')
    expect(sameDefs(defsBefore, await definitions())).toEqual({ missing: [], extra: [] })
    expect(await n(`select count(*) as n from private.bulk_import_receipts_backup_029`)).toBe(1)
    expect(await n(`select count(*) as n from private.employee_decisions_backup_029`)).toBe(1)
    expect((await one(`select to_regclass('public.bulk_import_receipts') as t`)).t).toBeNull()
    for (const t of ['profiles', 'serialized_assets', 'active_laptops_np', 'equipment_issues', 'onboarding_checklists', 'offboarding_checklists', 'serial_keys']) {
      expect(await tableHash(db, t), t).toBe(pre[t])
    }
    await applyMigration(db, M029)
    expect((await one(`select to_regclass('public.bulk_import_receipts') as t`)).t).toBe('bulk_import_receipts')
  })
})
