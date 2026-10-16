/**
 * Employee equipment register (20260901000026) against a LIVE database
 * that already has the migration — the hosted staging project
 * (npm run staging:test-db). Every test seeds its own "ZZ-REG" data inside
 * a transaction that is always ROLLED BACK, so staging records are never
 * changed. Skipped on the disposable in-process database, where
 * register.db.test.ts covers the same ground and more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, errorOf, inRolledBackTx, isStaging, openDb, tableHash, type Db } from './harness'
import { ADMIN, ANON_NEW, VIEWER, addAnonymousUser, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

let db: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const bulk = (id: string) => one(`select available, provided, damaged, decommissioned from bulk_items where id = $1`, [id])
async function device(id: string) {
  return one(
    `select 'serialized_assets' as tbl, status, assigned_to from serialized_assets where id = $1
     union all select 'active_laptops_np', status, assigned_to from active_laptops_np where id = $1
     union all select 'other_equipment', status, assigned_to from other_equipment where id = $1`,
    [id],
  )
}

async function setup(): Promise<LedgerIds> {
  await seedUsers(db)
  const ids = await seedLedger(db, 'ZZ-REG')
  await actAs(db, ADMIN)
  return ids
}

beforeAll(async () => {
  if (isStaging) db = await openDb()
})
afterAll(async () => {
  await db?.close()
})

describe.skipIf(!isStaging)('employee equipment register on the live staging database (rolled back)', () => {
  it('the migration is present', async () => {
    const r = await one(`select to_regclass('public.equipment_issues') is not null as yes, to_regprocedure('public.return_equipment(uuid, equipment_issue_status, integer, text, uuid)') is not null as fn`)
    expect(r).toEqual({ yes: true, fn: true })
  })

  it('two laptops for one employee: returning one keeps the other assigned', async () => {
    await inRolledBackTx(db, async () => {
      const ids = await setup()
      const emp = await rpc<string>(db, `create_employee('ZZ Reg Employee Two Laptops')`)
      const second = await rpc<string>(db, `create_asset('serialized_assets', 'Dell Latitude 5440', 'Laptop', 'ZZ-REG-INV-9')`)
      const a = await rpc<string>(db, `issue_equipment($1, 'serialized_assets', $2, null, 1, $3)`, [emp, ids.inventoryLaptop, ids.onboarding])
      const b = await rpc<string>(db, `issue_equipment($1, 'serialized_assets', $2)`, [emp, second])
      expect(await device(ids.inventoryLaptop)).toMatchObject({ tbl: 'active_laptops_np', status: 'provided', assigned_to: 'ZZ Reg Employee Two Laptops' })
      expect(await device(second)).toMatchObject({ tbl: 'active_laptops_np', status: 'provided' })

      await rpc(db, `return_equipment($1, 'returned', null, null, $2)`, [a, ids.offboarding])
      expect(await device(ids.inventoryLaptop)).toMatchObject({ tbl: 'serialized_assets', status: 'available', assigned_to: null })
      expect(await device(second)).toMatchObject({ tbl: 'active_laptops_np', status: 'provided', assigned_to: 'ZZ Reg Employee Two Laptops' })
      const rows = (await db.query(`select id, status, offboarding_id from equipment_issues where employee_id = $1`, [emp])).rows
      expect(rows.find((r) => r.id === a)).toMatchObject({ status: 'returned', offboarding_id: ids.offboarding })
      expect(rows.find((r) => r.id === b)).toMatchObject({ status: 'open' })
    })
  })

  it('chargers and headsets: issue and every return disposition keep stock and register together', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      const emp = await rpc<string>(db, `create_employee('ZZ Reg Employee Accessories')`)
      const charger = await rpc<string>(db, `create_bulk_item('ZZ-REG USB-C Charger', 'Power', null, 5)`)
      const headsetBulk = await rpc<string>(db, `create_bulk_item('ZZ-REG Headset', 'Accessory', null, 5)`)
      const headsetDevice = await rpc<string>(db, `create_asset('other_equipment', 'Headset', 'Headset', 'ZZ-REG-HS-1')`)

      const c1 = await rpc<string>(db, `issue_equipment($1, null, null, $2, 1)`, [emp, charger])
      const c2 = await rpc<string>(db, `issue_equipment($1, null, null, $2, 1)`, [emp, charger])
      const hb = await rpc<string>(db, `issue_equipment($1, null, null, $2, 1)`, [emp, headsetBulk])
      const hd = await rpc<string>(db, `issue_equipment($1, 'other_equipment', $2)`, [emp, headsetDevice])
      expect(await bulk(charger)).toMatchObject({ available: 3, provided: 2 })
      expect(await bulk(headsetBulk)).toMatchObject({ available: 4, provided: 1 })

      await rpc(db, `return_equipment($1, 'returned')`, [c1])
      await rpc(db, `return_equipment($1, 'retained_authorized', null, 'ZZ-REG approved: works from home')`, [c2])
      await rpc(db, `return_equipment($1, 'lost', null, 'ZZ-REG left on a train')`, [hb])
      await rpc(db, `return_equipment($1, 'returned_damaged', null, 'ZZ-REG broken band')`, [hd])

      expect(await bulk(charger)).toMatchObject({ available: 4, provided: 0, decommissioned: 1 })
      expect(await bulk(headsetBulk)).toMatchObject({ available: 4, provided: 0, decommissioned: 1 })
      expect(await device(headsetDevice)).toMatchObject({ status: 'damaged', assigned_to: null })

      const byId = Object.fromEntries((await db.query(`select * from equipment_issues where employee_id = $1`, [emp])).rows.map((r) => [r.id, r]))
      expect(byId[c1]).toMatchObject({ status: 'returned', quantity: 1, description: 'ZZ-REG USB-C Charger' })
      // Authorized retention is recorded as such — not as lost — with approver, reason and date.
      expect(byId[c2]).toMatchObject({ status: 'retained_authorized', approved_by: ADMIN.id, close_note: 'ZZ-REG approved: works from home', employee_id: emp })
      expect(byId[c2].closed_at).toBeTruthy()
      expect(byId[hb]).toMatchObject({ status: 'lost', close_note: 'ZZ-REG left on a train', approved_by: null })
      expect(byId[hd]).toMatchObject({ status: 'returned_damaged', item_kind: 'serialized' })
    })
  })

  it('Charger and Headset Required start blank and accept only Yes / No / N/A — answering changes no inventory or register row', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      const labels = (await db.query(`select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'requirement_answer' order by enumsortorder`)).rows.map((r) => r.enumlabel)
      expect(labels).toEqual(['yes', 'no', 'not_applicable'])
      const onb = (await one(`insert into onboarding_checklists (employee_name, created_by) values ('ZZ Reg New Hire', $1) returning id, charger_required, headset_required`, [ADMIN.id]))
      expect(onb).toMatchObject({ charger_required: null, headset_required: null })

      await actAsDatabase(db)
      const before = [await tableHash(db, 'equipment_issues'), await tableHash(db, 'bulk_items'), await tableHash(db, 'other_equipment')]
      await actAs(db, ADMIN)
      for (const v of ['yes', 'no', 'not_applicable']) {
        await db.query(`update onboarding_checklists set charger_required = $2, headset_required = $2 where id = $1`, [onb.id, v])
      }
      expect(await errorOf(db, `update onboarding_checklists set charger_required = 'maybe' where id = $1`, [onb.id])).toMatch(/invalid input value/)
      await actAsDatabase(db)
      expect([await tableHash(db, 'equipment_issues'), await tableHash(db, 'bulk_items'), await tableHash(db, 'other_equipment')]).toEqual(before)
    })
  })

  it('actions on a device page keep the register in sync (provide, transfer, collect), and C2 is fixed', async () => {
    await inRolledBackTx(db, async () => {
      const ids = await setup()
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', 'ZZ Reg Person A')`, [ids.monitor])
      expect((await one(`select assignee_name from equipment_issues where asset_id = $1 and status = 'open'`, [ids.monitor])).assignee_name).toBe('ZZ Reg Person A')
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'transfer', 'ZZ Reg Person B')`, [ids.monitor])
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'collect')`, [ids.monitor])
      const statuses = (await db.query(`select status from equipment_issues where asset_id = $1 order by issued_at, status`, [ids.monitor])).rows.map((r) => r.status).sort()
      expect(statuses).toEqual(['returned', 'transferred'])

      await rpc(db, `onboarding_assign_device($1, 'ZZ-REG-INV-1')`, [ids.onboarding])
      expect(await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.inventoryLaptop])).toBe('serialized_assets')

      const mismatches = (await db.query(`select * from equipment_register_mismatches where serial like 'ZZ-REG-%'`)).rows
      expect(mismatches).toEqual([])
    })
  })

  it('permissions: viewers cannot issue or return; anonymous sessions see nothing', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      const emp = await rpc<string>(db, `create_employee('ZZ Reg Perm')`)
      await addAnonymousUser(db, ANON_NEW) // switches to the database role
      await actAs(db, VIEWER)
      expect(await errorOf(db, `select issue_equipment($1, null, null, null)`, [emp])).toMatch(/not authorized/i)
      expect(await errorOf(db, `select return_equipment(gen_random_uuid(), 'returned')`)).toMatch(/not authorized/i)
      await actAs(db, ANON_NEW)
      for (const t of ['employees', 'equipment_issues']) expect((await one<{ n: number }>(`select count(*)::int as n from ${t}`)).n, t).toBe(0)
    })
  })
})
