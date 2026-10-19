/**
 * Tests for 20260901000028_employee_directory.sql on a fresh disposable
 * database (PGlite only): preservation, import, onboarding/offboarding
 * synchronisation, rehire, history, backup/restore, security, rollback.
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
import { ADMIN, ANON_NEW, EDITOR, VIEWER, addAnonymousUser, backupTables, rpc, seedLedger, seedUsers } from './fixtures'

const M028 = '20260901000028_employee_directory.sql'
let db: Db
const pre: Record<string, string> = {}
const fx: Record<string, string> = {}
let defsBefore: unknown
const TABLES = ['profiles', 'serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items', 'serialized_asset_history',
  'active_laptops_np_history', 'monitors_history', 'other_equipment_history', 'bulk_item_history', 'onboarding_checklists',
  'offboarding_checklists', 'import_events', 'equipment_issues', 'serial_keys']
const EMPLOYEE_COLS = 'id, full_name, name_key, email, created_by, created_at'

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
const employeesHash = async () =>
  (await one<{ h: string }>(`select md5(coalesce(string_agg(row(${EMPLOYEE_COLS})::text, '|' order by id), '')) as h from employees`)).h
const emp = (id: string) => one(`select * from employees where id = $1`, [id])
const history = (id: string) => db.query(`select kind, from_status, to_status, source, changes, note from employee_history where employee_id = $1 order by at, kind`, [id]).then((r) => r.rows)
const importRows = (rows: unknown[], filename = 'employees.xlsx') =>
  rpc<Record<string, any>>(db, `commit_employee_import($1, $2::jsonb)`, [filename, JSON.stringify(rows)])
const person = (i: number, over: Record<string, unknown> = {}) => ({
  first_name: `First${i}`, last_name: `Last${i}`, department: 'Engineering', job_title: 'Engineer', hr_status: 'Active',
  manager: 'Pat Manager', start_date: '2025-01-15', email: `first${i}.last${i}@example.invalid`, ...over,
})
const definitions = async () => (await db.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1, 2`)).rows
const devicesAndRegister = () => Promise.all(['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'equipment_issues', 'bulk_items'].map((t) => tableHash(db, t)))

async function completeOnboarding(id: string) {
  await db.query(`update onboarding_checklists set identity_created = true, equipment_assigned = true, required_access_provided = true, onboarding_successful = true where id = $1`, [id])
}
async function completeOffboarding(id: string) {
  await db.query(`update offboarding_checklists set removed_access = true, laptop_outcome = 'received' where id = $1`, [id])
}
async function newChecklist(table: 'onboarding_checklists' | 'offboarding_checklists', employeeId: string, name: string) {
  return (await one<{ id: string }>(`insert into ${table} (employee_name, employee_id, created_by) values ($1, $2, $3) returning id`, [name, employeeId, EDITOR.id])).id
}

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M028) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    await addAnonymousUser(db, ANON_NEW)
    const l = await seedLedger(db, 'DIR')
    await actAs(db, ADMIN)
    // An employee with a laptop still issued, and an onboarding in progress.
    fx.dana = await rpc<string>(db, `create_employee('Dana Field')`)
    await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [fx.dana, l.spareInventoryLaptop])
    fx.danaOnboarding = await newChecklist('onboarding_checklists', fx.dana, 'Dana Field')
    await actAsDatabase(db)
    return l
  })
  for (const t of TABLES) pre[t] = await tableHash(db, t)
  pre.employees = await employeesHash()
  defsBefore = await definitions()
  await applyMigration(db, M028)
}, 240_000)

afterAll(async () => {
  await db?.close()
})

const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

// ===================================================================
describe.skipIf(isStaging)('028 applied to existing data', () => {
  it('changes no existing row or value; existing employees are not put in the directory', async () => {
    for (const t of TABLES) expect(await tableHash(db, t), t).toBe(pre[t])
    expect(await employeesHash()).toBe(pre.employees)
    expect(await n(`select count(*) as n from employees where employment_status is not null or reactivation_pending`)).toBe(0)
    expect(await n(`select count(*) as n from employee_history`)).toBe(0)
  })
})

describe.skipIf(isStaging)('Excel import', () => {
  it('1: a valid list creates Active employees with every field, logged as imported', tx(async () => {
    await actAs(db, EDITOR)
    const r = await importRows([1, 2, 3].map((i) => ({ row: i, action: 'create', fields: person(i) })))
    expect(r).toMatchObject({ created: 3, updated: 0, unchanged: 0, conflicts: [] })
    const e = await one(`select * from employees where email_key = 'first1.last1@example.invalid'`)
    expect(e).toMatchObject({ full_name: 'First1 Last1', first_name: 'First1', last_name: 'Last1', department: 'Engineering', job_title: 'Engineer', hr_status: 'Active', manager: 'Pat Manager', employment_status: 'active' })
    expect(new Date(e.start_date).toISOString().slice(0, 10)).toBe('2025-01-15')
    expect(await history(e.id)).toEqual([expect.objectContaining({ kind: 'created', to_status: 'active', source: 'import' })])
    expect(await one(`select target_collection, rows_created, filename from import_events order by imported_at desc limit 1`)).toEqual({ target_collection: 'employees', rows_created: 3, filename: 'employees.xlsx' })
  }))

  it('2: thousands of employees in one import', tx(async () => {
    await actAs(db, EDITOR)
    const r = await importRows(Array.from({ length: 2500 }, (_, i) => ({ row: i + 1, action: 'create', fields: person(i) })))
    expect(r.created).toBe(2500)
    expect(await n(`select count(*) as n from employees where employment_status = 'active'`)).toBe(2500)
  }), 120_000)

  it('3: re-uploading the same file never creates anyone twice (email is the key, case and spaces ignored)', tx(async () => {
    await actAs(db, EDITOR)
    await importRows([1, 2].map((i) => ({ row: i, action: 'create', fields: person(i) })))
    const before = await n(`select count(*) as n from employees`)
    // A stale preview sending "create" again, with the email typed differently:
    const again = await importRows([1, 2].map((i) => ({ row: i, action: 'create', fields: person(i, { email: ` FIRST${i}.Last${i}@Example.INVALID ` }) })))
    expect(again).toMatchObject({ created: 0 })
    expect(again.conflicts).toHaveLength(2)
    expect(again.conflicts[0].reason).toMatch(/already exists — not created again/)
    // The reviewed path: matched rows as updates with nothing different.
    const ann = await one<{ id: string }>(`select id from employees where email_key = 'first1.last1@example.invalid'`)
    expect(await importRows([{ row: 1, action: 'update', employee_id: ann.id, fields: person(1) }])).toMatchObject({ updated: 0, unchanged: 1 })
    expect(await n(`select count(*) as n from employees`)).toBe(before)
    expect(await n(`select count(*) as n from employee_history where employee_id = $1`, [ann.id])).toBe(1)
  }))

  it('4: updating details applies only non-blank, different values and records old → new', tx(async () => {
    await actAs(db, EDITOR)
    await importRows([{ row: 1, action: 'create', fields: person(1) }])
    const id = (await one<{ id: string }>(`select id from employees where email_key = 'first1.last1@example.invalid'`)).id
    const r = await importRows([{ row: 1, action: 'update', employee_id: id, fields: { ...person(1), department: 'Finance', manager: '', job_title: '   ', start_date: '' } }], 'v2.xlsx')
    expect(r).toMatchObject({ updated: 1, unchanged: 0 })
    expect(await emp(id)).toMatchObject({ department: 'Finance', manager: 'Pat Manager', job_title: 'Engineer', employment_status: 'active' })
    const h = (await history(id)).find((x) => x.kind === 'details')!
    expect(h).toMatchObject({ source: 'import', changes: { department: ['Engineering', 'Finance'] } })
  }))

  it('5: missing names and invalid emails are reported; nothing is created for them', tx(async () => {
    await actAs(db, EDITOR)
    const r = await importRows([
      { row: 1, action: 'create', fields: person(1, { email: 'not-an-email' }) },
      { row: 2, action: 'create', fields: person(2, { last_name: '' }) },
      { row: 3, action: 'create', fields: person(3, { email: '' }) }, // no email is allowed
    ])
    expect(r.created).toBe(1)
    expect(r.conflicts.map((c: any) => [c.row, c.reason])).toEqual([[1, 'Invalid work email "not-an-email"'], [2, 'First and last name are required']])
    expect(await one(`select email, email_key from employees where first_name = 'First3'`)).toEqual({ email: null, email_key: null })
  }))

  it('6: a different person with the same name is created only when asked, and flagged as a possible duplicate', tx(async () => {
    await actAs(db, EDITOR)
    await importRows([{ row: 1, action: 'create', fields: person(1, { first_name: 'Dana', last_name: 'Field', email: 'dana.f2@example.invalid' }) }])
    expect(await n(`select count(*) as n from employees where name_key = 'dana field'`)).toBe(2)
    expect(await n(`select count(*) as n from employee_possible_duplicates where full_name = 'Dana Field' and other_full_name = 'Dana Field'`)).toBe(1)
  }))

  it('a work email already used by another employee cannot be set on someone else', tx(async () => {
    await actAs(db, EDITOR)
    await importRows([1, 2].map((i) => ({ row: i, action: 'create', fields: person(i) })))
    const second = (await one<{ id: string }>(`select id from employees where email_key = 'first2.last2@example.invalid'`)).id
    const r = await importRows([{ row: 1, action: 'update', employee_id: second, fields: { email: 'First1.Last1@example.invalid' } }])
    expect(r.conflicts[0].reason).toMatch(/belongs to a different employee/)
    expect(await errorOf(db, `select save_employee($1, '{"email": "first1.last1@example.invalid"}'::jsonb)`, [second])).toMatch(/already has the work email/)
  }))

  it('status changes from a file only when approved per row; employees missing from a file are untouched', tx(async () => {
    await actAs(db, EDITOR)
    await importRows([1, 2].map((i) => ({ row: i, action: 'create', fields: person(i) })))
    const [a, b] = (await db.query<{ id: string }>(`select id from employees where email_key like 'first%' order by email_key`)).rows.map((r) => r.id)
    // Row says "Terminated" but the change wasn't approved: details only.
    await importRows([{ row: 1, action: 'update', employee_id: a, fields: { hr_status: 'Terminated' } }])
    expect(await emp(a)).toMatchObject({ hr_status: 'Terminated', employment_status: 'active' })
    // Approved:
    expect(await importRows([{ row: 1, action: 'update', employee_id: a, fields: {}, status: 'inactive' }])).toMatchObject({ status_changes: 1 })
    expect((await emp(a)).employment_status).toBe('inactive')
    expect((await emp(b)).employment_status).toBe('active') // not in the second file, not touched
  }))

  it('imports never touch equipment, assignments or lifecycle history', tx(async () => {
    const devices = await devicesAndRegister()
    const hist = await Promise.all(['serialized_asset_history', 'active_laptops_np_history'].map((t) => tableHash(db, t)))
    await actAs(db, EDITOR)
    await importRows([{ row: 1, action: 'update', employee_id: fx.dana, fields: { first_name: 'Dana', last_name: 'Field', department: 'Ops', email: 'dana@example.invalid' } }])
    await actAsDatabase(db)
    expect(await devicesAndRegister()).toEqual(devices)
    expect(await Promise.all(['serialized_asset_history', 'active_laptops_np_history'].map((t) => tableHash(db, t)))).toEqual(hist)
    expect((await emp(fx.dana)).full_name).toBe('Dana Field') // the register's name is kept
  }))
})

describe.skipIf(isStaging)('onboarding and offboarding synchronisation', () => {
  it('7: starting onboarding changes nothing; completing it makes the employee Active', tx(async () => {
    await actAs(db, EDITOR)
    expect((await emp(fx.dana)).employment_status).toBeNull()
    await db.query(`update onboarding_checklists set identity_created = true, equipment_assigned = true where id = $1`, [fx.danaOnboarding])
    expect((await emp(fx.dana)).employment_status).toBeNull()
    await completeOnboarding(fx.danaOnboarding)
    expect(await emp(fx.dana)).toMatchObject({ employment_status: 'active', reactivation_pending: false })
    expect(await history(fx.dana)).toEqual([expect.objectContaining({ kind: 'status', from_status: null, to_status: 'active', source: 'onboarding_completed' })])
    // Unticking and re-ticking doesn't create another record or entry.
    await db.query(`update onboarding_checklists set onboarding_successful = false where id = $1`, [fx.danaOnboarding])
    await completeOnboarding(fx.danaOnboarding)
    expect(await history(fx.dana)).toHaveLength(1)
    expect(await n(`select count(*) as n from employees where name_key = 'dana field'`)).toBe(1)
  }))

  it('an already-complete onboarding linked to its employee later also activates', tx(async () => {
    await actAs(db, EDITOR)
    const id = (await one<{ id: string }>(`insert into onboarding_checklists (employee_name, created_by, identity_created, equipment_assigned, required_access_provided, onboarding_successful) values ('Lee Late', $1, true, true, true, true) returning id`, [EDITOR.id])).id
    const lee = await rpc<string>(db, `create_employee('Lee Late')`)
    await db.query(`update onboarding_checklists set employee_id = $1 where id = $2`, [lee, id])
    expect((await emp(lee)).employment_status).toBe('active')
  }))

  it('8+9: completing offboarding makes the employee Inactive — the laptop still issued stays pending return', tx(async () => {
    await actAs(db, EDITOR)
    await completeOnboarding(fx.danaOnboarding)
    const register = await tableHash(db, 'equipment_issues')
    const devices = await devicesAndRegister()
    const off = await newChecklist('offboarding_checklists', fx.dana, 'Dana Field')
    expect((await emp(fx.dana)).employment_status).toBe('active') // starting offboarding changes nothing
    await db.query(`update offboarding_checklists set removed_access = true where id = $1`, [off])
    expect((await emp(fx.dana)).employment_status).toBe('active')
    await completeOffboarding(off)
    expect((await emp(fx.dana)).employment_status).toBe('inactive')
    // Employment and equipment are independent:
    expect(await tableHash(db, 'equipment_issues')).toBe(register)
    expect(await devicesAndRegister()).toEqual(devices)
    expect(await n(`select count(*) as n from equipment_issues where employee_id = $1 and status = 'open'`, [fx.dana])).toBe(1)
    expect((await history(fx.dana)).at(-1)).toMatchObject({ kind: 'status', from_status: 'active', to_status: 'inactive', source: 'offboarding_completed' })
    // The employee record itself is kept.
    expect(await emp(fx.dana)).toBeTruthy()
  }))

  it('an employee who was never in the directory becomes Inactive on offboarding (and so never appears as active)', tx(async () => {
    await actAs(db, EDITOR)
    const off = await newChecklist('offboarding_checklists', fx.dana, 'Dana Field')
    await completeOffboarding(off)
    expect((await emp(fx.dana)).employment_status).toBe('inactive')
  }))

  it('10: a rehire — completing a new onboarding flags the employee; only an explicit Reactivate makes them Active again', tx(async () => {
    await actAs(db, EDITOR)
    await completeOnboarding(fx.danaOnboarding)
    const off = await newChecklist('offboarding_checklists', fx.dana, 'Dana Field')
    await completeOffboarding(off)
    const again = await newChecklist('onboarding_checklists', fx.dana, 'Dana Field')
    await completeOnboarding(again)
    expect(await emp(fx.dana)).toMatchObject({ employment_status: 'inactive', reactivation_pending: true })
    expect(await rpc<boolean>(db, `set_employment_status($1, 'active', 'Rehired 2026-11')`, [fx.dana])).toBe(true)
    expect(await emp(fx.dana)).toMatchObject({ employment_status: 'active', reactivation_pending: false })
    // 11: the full history is kept, oldest first.
    expect((await history(fx.dana)).map((h) => [h.kind, h.from_status, h.to_status, h.source])).toEqual([
      ['status', null, 'active', 'onboarding_completed'],
      ['status', 'active', 'inactive', 'offboarding_completed'],
      ['reactivation_pending', 'inactive', 'inactive', 'onboarding_completed'],
      ['status', 'inactive', 'active', 'manual'],
    ])
    // Same identity throughout — and the earlier equipment record is still there.
    expect(await n(`select count(*) as n from employees where name_key = 'dana field'`)).toBe(1)
    expect(await n(`select count(*) as n from equipment_issues where employee_id = $1`, [fx.dana])).toBe(1)
  }))
})

describe.skipIf(isStaging)('manual add and edit', () => {
  it('add: names required, starts Active; edit: an emptied field clears it; every change is logged', tx(async () => {
    await actAs(db, EDITOR)
    expect(await errorOf(db, `select save_employee(null, '{"first_name": "Solo"}'::jsonb)`)).toMatch(/First and last name are required/)
    const id = await rpc<string>(db, `save_employee(null, $1::jsonb)`, [JSON.stringify({ first_name: 'Ana', last_name: 'Ruiz', department: 'HR', email: 'Ana.Ruiz@Example.invalid' })])
    expect(await emp(id)).toMatchObject({ full_name: 'Ana Ruiz', employment_status: 'active', email: 'Ana.Ruiz@Example.invalid', email_key: 'ana.ruiz@example.invalid' })
    await rpc(db, `save_employee($1, $2::jsonb)`, [id, JSON.stringify({ first_name: 'Ana', last_name: 'Ruiz', department: '', manager: 'Kim', email: 'Ana.Ruiz@Example.invalid' })])
    expect(await emp(id)).toMatchObject({ department: null, manager: 'Kim' })
    expect((await history(id)).map((h) => h.kind)).toEqual(['created', 'details'])
    expect(await errorOf(db, `select save_employee($1, '{"start_date": "not a date"}'::jsonb)`, [id])).not.toBeNull()
    expect(await errorOf(db, `select save_employee($1, '{"email": "bad"}'::jsonb)`, [id])).toMatch(/Invalid work email/)
  }))
})

describe.skipIf(isStaging)('14: backup and restore', () => {
  async function payload() {
    const p: Record<string, any> = {}
    for (const t of await backupTables(db)) p[t] = (await one<{ v: unknown[] }>(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') as v from ${t} x`)).v
    p.employee_history = (await one<{ v: unknown[] }>(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') as v from employee_history x`)).v
    p._counts = Object.fromEntries(Object.entries(p).map(([t, r]) => [t, (r as unknown[]).length]))
    return p
  }

  it('directory fields, statuses and history round-trip exactly; nothing is re-triggered', tx(async () => {
    await actAs(db, EDITOR)
    await importRows([1, 2].map((i) => ({ row: i, action: 'create', fields: person(i) })))
    await completeOnboarding(fx.danaOnboarding)
    const off = await newChecklist('offboarding_checklists', fx.dana, 'Dana Field')
    await completeOffboarding(off)
    await actAsDatabase(db)
    const before = { employees: await tableHash(db, 'employees'), history: await tableHash(db, 'employee_history') }
    const p = await payload()
    await actAs(db, ADMIN)
    const r = await rpc<Record<string, any>>(db, `restore_backup($1::jsonb)`, [JSON.stringify(p)])
    expect(r.counts.employee_history).toBe(p.employee_history.length)
    await actAsDatabase(db)
    expect(await tableHash(db, 'employees')).toBe(before.employees)
    expect(await tableHash(db, 'employee_history')).toBe(before.history)
  }))

  it('a backup from before 028 restores: directory fields empty, no history', tx(async () => {
    const p = await payload()
    delete p.employee_history
    delete p._counts.employee_history
    for (const e of p.employees) for (const k of ['first_name', 'last_name', 'department', 'job_title', 'hr_status', 'manager', 'start_date', 'employment_status', 'reactivation_pending', 'status_changed_at', 'updated_at', 'email_key']) delete e[k]
    await actAs(db, ADMIN)
    await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(p)])
    await actAsDatabase(db)
    expect(await employeesHash()).toBe(pre.employees)
    expect(await n(`select count(*) as n from employee_history`)).toBe(0)
  }))
})

describe.skipIf(isStaging)('15: security', () => {
  it('viewers read the directory but cannot add, edit, import or change status', tx(async () => {
    await actAs(db, VIEWER)
    expect(await n(`select count(*) as n from employees`)).toBeGreaterThan(0)
    expect(await errorOf(db, `select save_employee(null, '{"first_name":"A","last_name":"B"}'::jsonb)`)).toMatch(/Not authorized/)
    expect(await errorOf(db, `select set_employment_status($1, 'active')`, [fx.dana])).toMatch(/Not authorized/)
    expect(await errorOf(db, `select commit_employee_import('x', '[]'::jsonb)`)).toMatch(/Not authorized/)
  }))

  it('no one writes the tables directly — not even an admin; internals are not callable', tx(async () => {
    await actAs(db, ADMIN)
    expect(await errorOf(db, `update employees set employment_status = 'active'`)).toMatch(/permission denied/)
    expect(await errorOf(db, `insert into employee_history (employee_id, kind, source) values ($1, 'status', 'x')`, [fx.dana])).toMatch(/permission denied/)
    expect(await errorOf(db, `select change_employment_status($1, 'active', 'x')`, [fx.dana])).toMatch(/permission denied/)
    expect(await errorOf(db, `select apply_employee_fields($1, '{}'::jsonb, true)`, [fx.dana])).toMatch(/permission denied/)
  }))

  it('anonymous sessions see no employees and no history, and cannot call anything', tx(async () => {
    await actAs(db, ANON_NEW)
    expect(await n(`select count(*) as n from employees`)).toBe(0)
    expect(await n(`select count(*) as n from employee_history`)).toBe(0)
    expect(await errorOf(db, `select save_employee(null, '{"first_name":"A","last_name":"B"}'::jsonb)`)).toMatch(/Not authorized|permission denied/)
  }))
})

describe.skipIf(isStaging)('028 rollback', () => {
  it('028_down restores 027 exactly, keeps every pre-028 row, saves what 028 recorded, and 028 re-applies', async () => {
    await inCommittedTx(db, async () => {
      await actAs(db, EDITOR)
      await importRows([{ row: 1, action: 'create', fields: person(1) }])
      await actAsDatabase(db)
    })
    const imported = await n(`select count(*) as n from employees where email_key = 'first1.last1@example.invalid'`)
    expect(imported).toBe(1)
    await applyRollback(db, '20260901000028_down.sql')
    const after = await definitions()
    // Same function text; only the line endings of the source file may differ.
    const norm = (d: string) => d.replace(/\r\n/g, '\n')
    const diff = (a: any[], b: any[]) => a.filter((x) => !b.some((y) => y.proname === x.proname && norm(y.def) === norm(x.def))).map((x) => x.proname)
    expect({ missingOrChanged: diff(defsBefore as any[], after), extra: diff(after, defsBefore as any[]) }).toEqual({ missingOrChanged: [], extra: [] })
    expect(await n(`select count(*) as n from private.employee_directory_backup_028 where first_name = 'First1'`)).toBe(1)
    expect(await n(`select count(*) as n from private.employee_history_backup_028`)).toBe(1)
    expect((await one(`select to_regclass('public.employee_history') as t`)).t).toBeNull()
    await applyMigration(db, M028)
    expect(await n(`select count(*) as n from employees where employment_status is not null`)).toBe(0)
  })
})
