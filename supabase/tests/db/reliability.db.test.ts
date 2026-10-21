/**
 * 20260901000033_reliability_fixes.sql on disposable databases (PGlite only;
 * not yet applied to hosted staging). Every test runs in a transaction that
 * is rolled back, except the baseline set-up and the compatibility check,
 * which uses its own throwaway database.
 *
 *   1. Bulk Stock: an unknown item gives "Bulk item not found" for every action
 *   2. Authorized retention no longer shows as a register mismatch (and real
 *      discrepancies still do)
 *   3. Assignee names are trimmed and use the employee's recorded name
 *   4. Ambiguous names are refused, not silently left unlinked
 *   5. Only Available devices can be issued
 *   6. One in-progress offboarding per employee; history is untouched
 *   + 033 changes no existing row, and its rollback restores 030 exactly
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
import { ADMIN, backupTables, rpc, seedLedger, seedUsers } from './fixtures'

const M033 = '20260901000033_reliability_fixes.sql'
let db: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
const mismatches = () => all(`select serial, assigned_to, register_assignee from equipment_register_mismatches order by serial`)
const quiet = async (fn: () => Promise<void>) => {
  // Direct-connection edits that bypass the register sync, to fabricate genuine discrepancies.
  await actAsDatabase(db)
  await db.query(`select set_config('equipment.sync_disabled', 'on', true)`)
  await fn()
  await db.query(`select set_config('equipment.sync_disabled', '', true)`)
  await actAs(db, ADMIN)
}

async function applyUpTo(target: Db, until: string | null) {
  await loadSupabaseStub(target)
  for (const file of migrationFiles()) {
    if (until && file >= until) break
    await applyMigration(target, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(target, () => target.exec(readAdaptation('017_after_role_cast.sql')))
  }
}

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await applyUpTo(db, null)
  await inCommittedTx(db, async () => {
    await seedUsers(db)
  })
}, 600_000)
afterAll(async () => {
  await db?.close()
})

/** A person, an available inventory laptop and a monitor, as the admin. */
async function scene(tag: string) {
  await actAs(db, ADMIN)
  const emp = await rpc<string>(db, `create_employee($1)`, [`Zz ${tag} Person`])
  const laptop = await rpc<string>(db, `create_asset('serialized_assets', 'Dell Latitude', 'Laptop', $1)`, [`${tag}-LAP-1`])
  const monitor = await rpc<string>(db, `create_asset('monitors', 'Dell 24', 'Monitor', $1)`, [`${tag}-MON-1`])
  return { emp, laptop, monitor }
}
const device = (id: string) =>
  one(
    `select 'serialized_assets' as tbl, status::text as status, assigned_to from serialized_assets where id = $1
     union all select 'active_laptops_np', status::text, assigned_to from active_laptops_np where id = $1
     union all select 'monitors', status::text, assigned_to from monitors where id = $1
     union all select 'other_equipment', status::text, assigned_to from other_equipment where id = $1`,
    [id],
  )

describe.skipIf(isStaging)('1. Bulk Stock: unknown items', () => {
  it('every action on an unknown item says "Bulk item not found" and changes nothing', async () => {
    await inRolledBackTx(db, async () => {
      await scene('B1')
      const ghost = '00000000-0000-4000-8000-0000000000ee'
      const before = await tableHash(db, 'bulk_items')
      const hist = await tableHash(db, 'bulk_item_history')
      for (const sql of [
        `select perform_bulk_action($1, 'receive_stock', 1)`,
        `select perform_bulk_action($1, 'issue', 1)`,
        `select perform_bulk_action($1, 'return', 1)`,
        `select perform_bulk_action($1, 'retain', 1)`,
        `select perform_bulk_action($1, 'repair', 1)`,
        `select perform_bulk_action($1, 'mark_damaged', 1, 'available')`,
        `select perform_bulk_action($1, 'decommission', 1, 'available')`,
      ]) {
        expect(await errorOf(db, sql, [ghost]), sql).toMatch(/Bulk item not found/)
      }
      await actAsDatabase(db)
      expect(await tableHash(db, 'bulk_items')).toBe(before)
      expect(await tableHash(db, 'bulk_item_history')).toBe(hist)
    })
  })

  it('a real item still works for every action (see bulk-stock.db.test.ts for the full set)', async () => {
    await inRolledBackTx(db, async () => {
      await scene('B2')
      const id = await rpc<string>(db, `create_bulk_item('ZZ B2 Cable', 'Cable', null, 10)`)
      await rpc(db, `perform_bulk_action($1, 'issue', 4)`, [id])
      await rpc(db, `perform_bulk_action($1, 'mark_damaged', 1, 'provided')`, [id])
      expect(await one(`select available, provided, damaged from bulk_items where id = $1`, [id])).toEqual({ available: 6, provided: 3, damaged: 1 })
    })
  })
})

describe.skipIf(isStaging)('2. Authorized retention vs the register', () => {
  async function retainedLaptop(tag: string) {
    const s = await scene(tag)
    const issue = await rpc<string>(db, `issue_equipment($1, 'serialized_assets', $2)`, [s.emp, s.laptop])
    await rpc(db, `return_equipment($1, 'retained_authorized', null, 'Approved to keep (test)')`, [issue])
    return { ...s, issue }
  }

  it('the device stays assigned, history records the approval, and it is NOT a mismatch', async () => {
    await inRolledBackTx(db, async () => {
      const s = await retainedLaptop('R1')
      expect(await device(s.laptop)).toMatchObject({ tbl: 'active_laptops_np', status: 'provided', assigned_to: 'Zz R1 Person' })
      expect(await one(`select status::text, approved_by, close_note from equipment_issues where id = $1`, [s.issue])).toMatchObject({
        status: 'retained_authorized', approved_by: ADMIN.id, close_note: 'Approved to keep (test)',
      })
      expect((await all(`select action from active_laptops_np_history where asset_id = $1`, [s.laptop])).map((h) => h.action)).toContain('retention_approved')
      expect(await mismatches()).toEqual([])
    })
  })

  it('genuine discrepancies are still reported', async () => {
    await inRolledBackTx(db, async () => {
      const s = await retainedLaptop('R2')
      // (a) retained for A, but the device now says B (edited around the register)
      await quiet(() => db.query(`update active_laptops_np set assigned_to = 'Somebody Else' where id = $1`, [s.laptop]).then(() => undefined))
      expect((await mismatches()).map((m) => m.serial)).toEqual(['R2-LAP-1'])
      // (b) assigned with no register row at all
      await quiet(() => db.query(`update monitors set assigned_to = 'Nobody Recorded' where id = $1`, [s.monitor]).then(() => undefined))
      expect((await mismatches()).map((m) => m.serial)).toEqual(['R2-LAP-1', 'R2-MON-1'])
    })
  })

  it('a device assigned with an open row for someone else is still reported (unchanged rule)', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('R3')
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', 'Zz R3 Person')`, [s.monitor])
      expect(await mismatches()).toEqual([])
      await quiet(() => db.query(`update monitors set assigned_to = 'Another Name' where id = $1`, [s.monitor]).then(() => undefined))
      expect(await mismatches()).toEqual([{ serial: 'R3-MON-1', assigned_to: 'Another Name', register_assignee: 'Zz R3 Person' }])
    })
  })

  it('collecting a retained device ends the retention cleanly: no mismatch, history kept, a new issue opens a new row', async () => {
    await inRolledBackTx(db, async () => {
      const s = await retainedLaptop('R4')
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [s.laptop])
      expect(await device(s.laptop)).toMatchObject({ tbl: 'serialized_assets', status: 'available', assigned_to: null })
      expect(await mismatches()).toEqual([])
      expect((await one(`select status::text from equipment_issues where id = $1`, [s.issue])).status).toBe('retained_authorized') // history kept
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [s.emp, s.laptop])
      expect(await mismatches()).toEqual([])
      expect((await all(`select status::text from equipment_issues where asset_id = $1 order by issued_at, status`, [s.laptop])).map((r) => r.status).sort()).toEqual(['open', 'retained_authorized'])
    })
  })

  it('transferring a retained device to someone else opens a row for them and keeps the retention in history', async () => {
    await inRolledBackTx(db, async () => {
      const s = await retainedLaptop('R5')
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'transfer', 'Zz Other Holder')`, [s.laptop])
      expect(await mismatches()).toEqual([])
      expect((await one(`select assignee_name from equipment_issues where asset_id = $1 and status = 'open'`, [s.laptop])).assignee_name).toBe('Zz Other Holder')
    })
  })
})

describe.skipIf(isStaging)('3 + 4. Assignee names and ambiguous names', () => {
  it('trims, collapses spaces and uses the recorded employee name; the register is linked by id', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('N1')
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', '   zz   n1   PERSON  ')`, [s.monitor])
      expect(await device(s.monitor)).toMatchObject({ status: 'provided', assigned_to: 'Zz N1 Person' })
      expect(await one(`select employee_id, assignee_name, employee_ambiguous from equipment_issues where asset_id = $1 and status = 'open'`, [s.monitor])).toEqual({
        employee_id: s.emp, assignee_name: 'Zz N1 Person', employee_ambiguous: false,
      })
      expect((await one(`select count(*)::int as n from employees where name_key = 'zz n1 person'`)).n).toBe(1) // no second employee
    })
  })

  it('an unknown name is tidied and creates one tidy employee', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('N2')
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', '  Brand   New  Person ')`, [s.monitor])
      expect((await device(s.monitor)).assigned_to).toBe('Brand New Person')
      expect(await one(`select full_name from employees where name_key = 'brand new person'`)).toEqual({ full_name: 'Brand New Person' })
    })
  })

  it('moving to the same person typed differently keeps the same register row open (no spurious transfer)', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('N3')
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', 'Zz N3 Person')`, [s.monitor])
      const open = await one(`select id from equipment_issues where asset_id = $1 and status = 'open'`, [s.monitor])
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'transfer', '  ZZ  n3  person ')`, [s.monitor])
      expect((await all(`select id, status::text from equipment_issues where asset_id = $1`, [s.monitor]))).toEqual([{ id: open.id, status: 'open' }])
    })
  })

  it('only values that are inserted or changed are tidied: existing rows and status edits are not rewritten', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('N4')
      await quiet(async () => {
        await db.query(`update monitors set status = 'provided', assigned_to = '  Old   Style  Name ' where id = $1`, [s.monitor])
      })
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'mark_damaged')`, [s.monitor])
      expect((await device(s.monitor)).assigned_to).toBe('  Old   Style  Name ')
    })
  })

  it('a name shared by two employees is refused with a clear message and nothing is recorded', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('A1')
      const a = await rpc<string>(db, `create_employee('Zz Same Name')`)
      await rpc<string>(db, `create_employee('zz  same name')`)
      const before = await tableHash(db, 'equipment_issues')
      const msg = await errorOf(db, `select perform_lifecycle_action('monitors', $1, 'provide', 'Zz Same Name')`, [s.monitor])
      expect(msg).toMatch(/More than one employee is named "Zz Same Name"/)
      expect(msg).toMatch(/Onboarding/)
      expect(await device(s.monitor)).toMatchObject({ status: 'available', assigned_to: null })
      await actAsDatabase(db)
      expect(await tableHash(db, 'equipment_issues')).toBe(before)
      await actAs(db, ADMIN)
      // Choosing the person (as Onboarding does) works, and links the register to that employee.
      const issue = await rpc<string>(db, `issue_equipment($1, 'monitors', $2)`, [a, s.monitor])
      expect(await one(`select employee_id, employee_ambiguous from equipment_issues where id = $1`, [issue])).toEqual({ employee_id: a, employee_ambiguous: false })
    })
  })

  it('an unlinked old register row (recorded before this fix) is left exactly as it is', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('A2')
      await quiet(async () => {
        await db.query(
          `insert into equipment_issues (employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection, asset_id, description, serial, source)
           values (null, 'Zz Legacy', true, 'serialized', 'monitors', $1, 'Dell 24', 'A2-MON-1', 'lifecycle')`, [s.monitor])
        await db.query(`update monitors set status = 'provided', assigned_to = 'Zz Legacy' where id = $1`, [s.monitor])
      })
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'mark_damaged')`, [s.monitor])
      expect(await one(`select employee_id, employee_ambiguous, status::text from equipment_issues where asset_id = $1`, [s.monitor])).toEqual({ employee_id: null, employee_ambiguous: true, status: 'open' })
    })
  })
})

describe.skipIf(isStaging)('5. Only Available devices are issued', () => {
  it('Retained, Decommissioned, Damaged and Provided devices are refused; Available works', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('I1')
      const mk = (serial: string) => rpc<string>(db, `create_asset('serialized_assets', 'Dell', 'Laptop', $1)`, [serial])
      const retained = await mk('I1-RET')
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'retain')`, [retained])
      const damaged = await mk('I1-DMG')
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'mark_damaged')`, [damaged])
      const decommissioned = await mk('I1-DEC')
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'retain')`, [decommissioned]) // retained first…
      await actAsDatabase(db)
      await db.query(`update serialized_assets set status = 'decommissioned' where id = $1`, [decommissioned]) // …then written off by an operator
      await actAs(db, ADMIN)
      for (const [id, what] of [[retained, 'retained'], [damaged, 'damaged'], [decommissioned, 'decommissioned']] as const) {
        expect(await errorOf(db, `select issue_equipment($1, 'serialized_assets', $2)`, [s.emp, id]), what).toMatch(/Only an Available device can be issued/)
        expect((await device(id)).assigned_to, what).toBeNull()
      }
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [s.emp, s.laptop])
      expect(await errorOf(db, `select issue_equipment($1, 'active_laptops_np', $2)`, [s.emp, s.laptop])).toMatch(/Only an Available device can be issued/) // already provided
      expect(await errorOf(db, `select issue_equipment($1, 'monitors', $2)`, [s.emp, '00000000-0000-4000-8000-0000000000ee'])).toMatch(/Device not found/)
    })
  })
})

describe.skipIf(isStaging)('6. One in-progress offboarding per employee', () => {
  const start = (name: string, employee: string | null) =>
    db.query(`insert into offboarding_checklists (employee_name, employee_id, created_by) values ($1, $2, $3) returning id`, [name, employee, ADMIN.id])
  const startErr = (name: string, employee: string | null) =>
    errorOf(db, `insert into offboarding_checklists (employee_name, employee_id, created_by) values ($1, $2, $3)`, [name, employee, ADMIN.id])
  const complete = (id: string) => db.query(`update offboarding_checklists set removed_access = true, laptop_outcome = 'received' where id = $1`, [id])

  it('a second in-progress offboarding for the same employee is refused', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('O1')
      await start('Zz O1 Person', s.emp)
      expect(await startErr('Zz O1 Person', s.emp)).toMatch(/already in progress/)
      expect(await startErr('  ZZ o1   person ', null)).toMatch(/already in progress/) // same name, not yet linked
      expect((await one(`select count(*)::int as n from offboarding_checklists where employee_id = $1`, [s.emp])).n).toBe(1)
    })
  })

  it('a different employee is unaffected', async () => {
    await inRolledBackTx(db, async () => {
      const a = await scene('O2')
      const other = await rpc<string>(db, `create_employee('Zz O2 Other')`)
      await start('Zz O2 Person', a.emp)
      await start('Zz O2 Other', other)
      expect((await one(`select count(*)::int as n from offboarding_checklists where employee_name like 'Zz O2%'`)).n).toBe(2)
    })
  })

  it('a completed offboarding is history: it never blocks a later one, and is not changed', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('O3')
      const first = (await start('Zz O3 Person', s.emp)).rows[0].id as string
      await complete(first)
      const before = await one(`select * from offboarding_checklists where id = $1`, [first])
      await start('Zz O3 Person', s.emp) // rehired and leaving again: allowed
      expect(await one(`select * from offboarding_checklists where id = $1`, [first])).toEqual(before)
      expect((await one(`select count(*)::int as n from offboarding_checklists where employee_id = $1`, [s.emp])).n).toBe(2)
      expect(await startErr('Zz O3 Person', s.emp)).toMatch(/already in progress/) // the new one is in progress
    })
  })

  it('linking a record to an employee that already has one in progress is refused; editing a record is not', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('O4')
      await start('Zz O4 Person', s.emp)
      const loose = (await start('Someone Else Entirely', null)).rows[0].id as string
      expect(await errorOf(db, `update offboarding_checklists set employee_id = $2 where id = $1`, [loose, s.emp])).toMatch(/already in progress/)
      await db.query(`update offboarding_checklists set removed_access = true where id = $1`, [loose]) // plain edits still work
      expect((await one(`select removed_access from offboarding_checklists where id = $1`, [loose])).removed_access).toBe(true)
    })
  })

  it('duplicates that already exist are kept and can still be edited; only new ones are prevented', async () => {
    await inRolledBackTx(db, async () => {
      const s = await scene('O5')
      await quiet(async () => {
        await db.query(`insert into offboarding_checklists (employee_name, employee_id, created_by) values ('Zz O5 Person', $1, $2), ('Zz O5 Person', $1, $2)`, [s.emp, ADMIN.id])
      })
      expect((await one(`select count(*)::int as n from offboarding_checklists where employee_id = $1`, [s.emp])).n).toBe(2)
      const ids = (await all(`select id from offboarding_checklists where employee_id = $1`, [s.emp])).map((r) => r.id as string)
      await db.query(`update offboarding_checklists set removed_access = true where id = $1`, [ids[0]]) // editing a legacy duplicate works
      await complete(ids[0])
      await complete(ids[1])
      expect(await startErr('Zz O5 Person', s.emp)).toBeNull() // both are now complete -> a new one may start
    })
  })
})

describe.skipIf(isStaging)('Compatibility and rollback of 033', () => {
  let old: Db
  const tables = async (d: Db) => {
    const names = [...(await backupTables(d)), 'profiles']
    const out: Record<string, string> = {}
    for (const t of names) out[t] = await tableHash(d, t)
    return out
  }
  const defs = async (d: Db) =>
    (await d.query<{ proname: string; def: string }>(
      `select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1, 2`,
    )).rows.map((r) => `${r.proname}\n${r.def.replace(/\r\n/g, '\n')}`)
  const views = async (d: Db) => (await d.query(`select pg_get_viewdef('equipment_register_mismatches'::regclass, true) as v`)).rows[0].v as string

  beforeAll(async () => {
    old = await openDb()
    await applyUpTo(old, M033) // a database exactly at 030
    await inCommittedTx(old, async () => {
      await seedUsers(old)
      const l = await seedLedger(old, 'CMP')
      await actAs(old, ADMIN)
      const emp = await rpc<string>(old, `create_employee('Zz Cmp Person')`)
      await rpc(old, `issue_equipment($1, 'serialized_assets', $2)`, [emp, l.inventoryLaptop])
      await rpc(old, `perform_lifecycle_action('monitors', $1, 'provide', '  messy   NAME ')`, [l.monitor]) // a pre-fix style name
      await old.query(`insert into offboarding_checklists (employee_name, employee_id, created_by) values ('Zz Cmp Person', $1, $2), ('Zz Cmp Person', $1, $2)`, [emp, ADMIN.id]) // a legacy duplicate
      await actAsDatabase(old)
    })
  }, 600_000)
  afterAll(async () => {
    await old?.close()
  })

  it('applying 033 to a populated 030 database changes no existing row', async () => {
    const before = await tables(old)
    await applyMigration(old, M033)
    expect(await tables(old)).toEqual(before)
  })

  it('the rollback restores the 030 functions and view exactly and removes what 033 added', async () => {
    const fresh = await openDb()
    try {
      await applyUpTo(fresh, M033)
      const defs030 = await defs(fresh)
      const view030 = await views(fresh)
      await applyMigration(fresh, M033)
      expect(await defs(fresh)).not.toEqual(defs030)
      await applyRollback(fresh, '20260901000033_down.sql')
      expect(await defs(fresh)).toEqual(defs030)
      expect(await views(fresh)).toBe(view030)
      expect((await fresh.query(`select count(*)::int as n from pg_trigger where tgname in ('offboarding_one_in_progress','monitors_normalize_assignee')`)).rows[0].n).toBe(0)
    } finally {
      await fresh.close()
    }
  })
})
