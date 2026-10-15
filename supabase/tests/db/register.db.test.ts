/**
 * Tests for 20260901000025_add_lost_status.sql and
 * 20260901000026_employee_equipment_register.sql on a fresh disposable
 * database (PGlite only): data preservation, backfill, issue/return,
 * sync with existing lifecycle actions, security, backup/restore, rollback.
 *
 * The "before" state is built through the app's own functions with the
 * real pre-025 schema, including the awkward cases: one person's name
 * typed two ways, a possible duplicate pair, an onboarding-assigned
 * laptop (audit C2), and Bulk Stock issued with no recorded recipient.
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
  tryQuery,
  type Db,
} from './harness'
import { ADMIN, ANON_NEW, EDITOR, LEDGER_TABLES, VIEWER, addAnonymousUser, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

const M025 = '20260901000025_add_lost_status.sql'
const M026 = '20260901000026_employee_equipment_register.sql'
let db: Db
let ids: LedgerIds
const extra: Record<string, string> = {}
const before: { hashes: Record<string, string>; defs?: unknown; assigned?: number } = { hashes: {} }

// Pre-026 columns of the two checklist tables (026 adds columns to them).
const ORIGINAL_COLUMNS: Record<string, string> = {
  onboarding_checklists:
    'id, employee_name, identity_created, equipment_assigned, required_access_provided, onboarding_successful, assigned_asset_id, created_by, created_at, updated_at',
  offboarding_checklists:
    'id, employee_name, removed_access, laptop_received, laptop_retained, laptop_decommissioned, laptop_outcome, outcome_needs_review, created_by, created_at, updated_at',
}
const PRE_EXISTING = ['profiles', ...LEDGER_TABLES]

async function preExistingHash(table: string) {
  const cols = ORIGINAL_COLUMNS[table]
  if (!cols) return tableHash(db, table)
  const { rows } = await db.query<{ h: string }>(
    `select md5(coalesce(string_agg(row(${cols})::text, '|' order by id), '')) as h from ${table}`,
  )
  return rows[0].h
}

async function definitionsSnapshot() {
  const q = async (sql: string) => (await db.query(sql)).rows
  return {
    policies: await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2`),
    functions: await q(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`),
    triggers: await q(`select event_object_table, trigger_name, event_manipulation, action_statement from information_schema.triggers where trigger_schema = 'public' order by 1, 2, 3`),
    tables: await q(`select table_name, string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' group by 1 order by 1`),
  }
}

async function assignedDeviceCount() {
  const { rows } = await db.query<{ n: number }>(
    `select (select count(*) from serialized_assets where nullif(btrim(assigned_to), '') is not null)
          + (select count(*) from active_laptops_np where nullif(btrim(assigned_to), '') is not null)
          + (select count(*) from monitors where nullif(btrim(assigned_to), '') is not null)
          + (select count(*) from other_equipment where nullif(btrim(assigned_to), '') is not null) as n`,
  )
  return Number(rows[0].n)
}

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0]
const issueFor = (assetId: string) =>
  one<Record<string, any>>(`select * from equipment_issues where asset_id = $1 order by created_at desc, closed_at desc nulls first limit 1`, [assetId])
const openIssueFor = (assetId: string) =>
  one<Record<string, any>>(`select * from equipment_issues where asset_id = $1 and status = 'open'`, [assetId])
async function deviceRow(id: string) {
  return one<Record<string, any>>(
    `select 'serialized_assets' as tbl, status, assigned_to from serialized_assets where id = $1
     union all select 'active_laptops_np', status, assigned_to from active_laptops_np where id = $1
     union all select 'monitors', status, assigned_to from monitors where id = $1
     union all select 'other_equipment', status, assigned_to from other_equipment where id = $1`,
    [id],
  )
}
const bulk = (id: string) => one<Record<string, number>>(`select available, provided, retained, damaged, decommissioned from bulk_items where id = $1`, [id])
const createAsset = (collection: string, serial: string, name = 'Dell Latitude 5440', category = 'Laptop') =>
  rpc<string>(db, `create_asset($1::asset_collection, $2, $3, $4)`, [collection, name, category, serial])
const newEmployee = (name: string) => rpc<string>(db, `create_employee($1)`, [name])

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M025) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }

  // ------------------------------------------------ the legacy state
  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    await addAnonymousUser(db, ANON_NEW)
    const l = await seedLedger(db, 'LEG') // NP laptop provided to "Test Employee A"; onboarding B; offboarding A
    await actAs(db, ADMIN)
    // The same person typed differently: must become ONE employee.
    await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', '  test   employee A ')`, [l.monitor])
    // A possible duplicate pair: must NOT be merged, must be flagged.
    await rpc(db, `perform_lifecycle_action('other_equipment', $1, 'provide', 'John Smith')`, [l.other])
    extra.jonDock = await createAsset('other_equipment', 'LEG-OTH-2', 'USB-C Dock', 'Dock')
    await rpc(db, `perform_lifecycle_action('other_equipment', $1, 'provide', 'Jon Smith')`, [extra.jonDock])
    // Audit C2: an Inventory laptop assigned through onboarding.
    await rpc(db, `onboarding_assign_device($1, 'LEG-INV-1')`, [l.onboarding])
    // Bulk Stock issued with no recorded recipient.
    await rpc(db, `perform_bulk_action($1, 'issue', 5)`, [l.bulkItem])
    extra.headsetBulk = await rpc<string>(db, `create_bulk_item('Headset', 'Accessory', null, 10)`)
    extra.chargerBulk = await rpc<string>(db, `create_bulk_item('USB-C Charger', 'Power', null, 10)`)
    extra.headsetSerial = await createAsset('other_equipment', 'LEG-HS-1', 'Headset', 'Headset')
    await db.query(`insert into offboarding_checklists (employee_name, created_by) values ('John Smith', $1)`, [ADMIN.id])
    await actAsDatabase(db)
    return l
  })

  await actAsDatabase(db)
  for (const t of PRE_EXISTING) before.hashes[t] = await preExistingHash(t)
  before.defs = await definitionsSnapshot()
  before.assigned = await assignedDeviceCount()

  await applyMigration(db, M025)
  await applyMigration(db, M026)
}, 240_000)

afterAll(async () => {
  await db?.close()
})

// ===================================================================
describe.skipIf(isStaging)('preservation', () => {
  it('every pre-existing row and column is unchanged (devices, history, bulk quantities, checklists incl. timestamps, profiles)', async () => {
    for (const t of PRE_EXISTING) expect(await preExistingHash(t), t).toBe(before.hashes[t])
  })
})

describe.skipIf(isStaging)('backfill', () => {
  it('one employee per exact normalized name — the same person typed two ways is one employee', async () => {
    const { rows } = await db.query<{ full_name: string; name_key: string }>(`select full_name, name_key from employees order by name_key`)
    expect(rows.map((r) => r.name_key)).toEqual(['john smith', 'jon smith', 'test employee a', 'test employee b'])
    // The most used spelling is kept as the display name.
    expect(rows.find((r) => r.name_key === 'test employee a')!.full_name).toBe('Test Employee A')
  })

  it('possible duplicates are flagged, never merged', async () => {
    const { rows } = await db.query(`select full_name, other_full_name, reason from employee_possible_duplicates`)
    expect(rows).toEqual([
      expect.objectContaining({ reason: 'Same last name and first initial' }),
    ])
    expect([rows[0].full_name, rows[0].other_full_name].sort()).toEqual(['John Smith', 'Jon Smith'])
    expect((await one<{ n: number }>(`select count(*)::int as n from employees where name_key in ('john smith', 'jon smith')`)).n).toBe(2)
  })

  it('checklists are linked to their employee by name', async () => {
    const onb = await one(`select o.employee_id, e.full_name from onboarding_checklists o join employees e on e.id = o.employee_id where o.id = $1`, [ids.onboarding])
    expect(onb.full_name).toBe('Test Employee B')
    const { rows } = await db.query(`select employee_id from offboarding_checklists`)
    expect(rows.every((r) => r.employee_id)).toBe(true)
  })

  it('exactly one open register row per device assigned today, dated from its history', async () => {
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from equipment_issues where status = 'open'`)
    expect(rows[0].n).toBe(before.assigned)
    const np = await openIssueFor(ids.npLaptop)
    expect(np).toMatchObject({ source: 'backfill', item_kind: 'serialized', asset_collection: 'active_laptops_np', assignee_name: 'Test Employee A' })
    const lastProvide = await one<{ d: string }>(`select max(date) as d from active_laptops_np_history where asset_id = $1 and action = 'provide'`, [ids.npLaptop])
    expect(new Date(np.issued_at).getTime()).toBe(new Date(lastProvide.d).getTime())
    // Typed differently, same employee:
    expect((await openIssueFor(ids.monitor)).employee_id).toBe(np.employee_id)
    // The onboarding-assigned laptop is linked to its onboarding:
    expect((await openIssueFor(ids.inventoryLaptop)).onboarding_id).toBe(ids.onboarding)
  })

  it('Bulk Stock gets no register rows — no recipient is invented', async () => {
    expect((await one<{ n: number }>(`select count(*)::int as n from equipment_issues where item_kind = 'bulk'`)).n).toBe(0)
    expect((await bulk(ids.bulkItem)).provided).toBe(5)
  })

  it('the register and the devices agree', async () => {
    expect((await db.query(`select * from equipment_register_mismatches`)).rows).toEqual([])
  })

  it('charger and headset requirements start blank on every onboarding record', async () => {
    const { rows } = await db.query(`select charger_required, headset_required from onboarding_checklists`)
    expect(rows.every((r) => r.charger_required === null && r.headset_required === null)).toBe(true)
  })
})

// ===================================================================
describe.skipIf(isStaging)('issuing (as the admin)', () => {
  it('issues an Inventory laptop: normal Provide (moves to Active Laptops), register row linked to the onboarding, step ticked', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      const onb = (await one<{ id: string }>(`insert into onboarding_checklists (employee_name, employee_id, created_by) values ('Test Employee C', $1, $2) returning id`, [emp, ADMIN.id])).id
      const issue = await rpc<string>(db, `issue_equipment($1, 'serialized_assets', $2, null, 1, $3)`, [emp, ids.spareInventoryLaptop, onb])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ tbl: 'active_laptops_np', status: 'provided', assigned_to: 'Test Employee C' })
      expect(await one(`select * from equipment_issues where id = $1`, [issue])).toMatchObject({
        employee_id: emp, status: 'open', source: 'issue', onboarding_id: onb, asset_id: ids.spareInventoryLaptop,
      })
      expect((await one(`select equipment_assigned from onboarding_checklists where id = $1`, [onb])).equipment_assigned).toBe(true)
    })
  })

  it('supports several laptops for one employee, each tracked separately', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      const second = await createAsset('serialized_assets', 'NEW-INV-9')
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [emp, ids.spareInventoryLaptop])
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [emp, second])
      const { rows } = await db.query(`select asset_id from equipment_issues where employee_id = $1 and status = 'open'`, [emp])
      expect(rows.map((r) => r.asset_id).sort()).toEqual([ids.spareInventoryLaptop, second].sort())
    })
  })

  it('refuses to issue a device that is already assigned', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      expect(await errorOf(db, `select issue_equipment($1, 'active_laptops_np', $2)`, [emp, ids.npLaptop])).toMatch(/not allowed from status provided/)
    })
  })

  it('issues a charger from Bulk Stock: Available -1, Provided +1, register row with quantity', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      const issue = await rpc<string>(db, `issue_equipment($1, null, null, $2, 1)`, [emp, extra.chargerBulk])
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 9, provided: 1 })
      expect(await one(`select item_kind, quantity, description, status from equipment_issues where id = $1`, [issue])).toEqual({
        item_kind: 'bulk', quantity: 1, description: 'USB-C Charger', status: 'open',
      })
    })
  })

  it('refuses more stock than is available, and records nothing', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      expect(await errorOf(db, `select issue_equipment($1, null, null, $2, 11)`, [emp, extra.chargerBulk])).toMatch(/Insufficient quantity/)
      expect((await one<{ n: number }>(`select count(*)::int as n from equipment_issues where bulk_item_id = $1`, [extra.chargerBulk])).n).toBe(0)
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 10, provided: 0 })
    })
  })

  it('issues a headset either way: serialized (Other Equipment) or from Bulk Stock', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      await rpc(db, `issue_equipment($1, 'other_equipment', $2)`, [emp, extra.headsetSerial])
      await rpc(db, `issue_equipment($1, null, null, $2, 1)`, [emp, extra.headsetBulk])
      const { rows } = await db.query(`select item_kind, description from equipment_issues where employee_id = $1 order by item_kind`, [emp])
      expect(rows).toEqual([
        { item_kind: 'bulk', description: 'Headset' },
        { item_kind: 'serialized', description: 'Headset' },
      ])
    })
  })

  it('answering Yes / No / N/A issues and returns nothing', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const snapshot = async () => {
        await actAsDatabase(db)
        const h = [await tableHash(db, 'equipment_issues'), await tableHash(db, 'bulk_items'), await tableHash(db, 'serialized_assets'), await tableHash(db, 'active_laptops_np'), await tableHash(db, 'other_equipment')]
        await actAs(db, ADMIN)
        return h
      }
      const pre = await snapshot()
      for (const v of ['yes', 'no', 'not_applicable', null]) {
        await db.query(`update onboarding_checklists set charger_required = $2, headset_required = $2 where id = $1`, [ids.onboarding, v])
      }
      expect(await snapshot()).toEqual(pre)
      expect(await errorOf(db, `update onboarding_checklists set headset_required = 'maybe' where id = $1`, [ids.onboarding])).toMatch(/invalid input value/)
    })
  })

  it('changing the answer to No after issuing leaves the issued headset issued', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee C')
      await db.query(`update onboarding_checklists set headset_required = 'yes' where id = $1`, [ids.onboarding])
      const issue = await rpc<string>(db, `issue_equipment($1, null, null, $2, 1, $3)`, [emp, extra.headsetBulk, ids.onboarding])
      await db.query(`update onboarding_checklists set headset_required = 'no' where id = $1`, [ids.onboarding])
      expect((await one(`select status from equipment_issues where id = $1`, [issue])).status).toBe('open')
      expect((await bulk(extra.headsetBulk)).provided).toBe(1)
    })
  })
})

// ===================================================================
describe.skipIf(isStaging)('returning (as the admin)', () => {
  async function issued(assetCollection: string, assetId: string) {
    const emp = await newEmployee('Test Employee R')
    return rpc<string>(db, `issue_equipment($1, $2::asset_collection, $3)`, [emp, assetCollection, assetId])
  }

  it('Returned: Collect — Available, unassigned, back in Inventory', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      await rpc(db, `return_equipment($1, 'returned', null, null, $2)`, [issue, ids.offboarding])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ tbl: 'serialized_assets', status: 'available', assigned_to: null })
      expect(await one(`select status, offboarding_id, closed_by from equipment_issues where id = $1`, [issue])).toEqual({
        status: 'returned', offboarding_id: ids.offboarding, closed_by: ADMIN.id,
      })
    })
  })

  it('Returned damaged: unassigned and Damaged', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      await rpc(db, `return_equipment($1, 'returned_damaged', null, 'cracked screen')`, [issue])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ tbl: 'serialized_assets', status: 'damaged', assigned_to: null })
      expect((await one(`select status from equipment_issues where id = $1`, [issue])).status).toBe('returned_damaged')
    })
  })

  it('Decommissioned: unassigned and Decommissioned', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      await rpc(db, `return_equipment($1, 'decommissioned')`, [issue])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ status: 'decommissioned', assigned_to: null })
    })
  })

  it('Retained (authorized): requires a reason; device stays Provided to them; approval recorded on register and device history', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      expect(await errorOf(db, `select return_equipment($1, 'retained_authorized')`, [issue])).toMatch(/reason is required/)
      await rpc(db, `return_equipment($1, 'retained_authorized', null, 'Contractor keeps laptop per HR')`, [issue])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ status: 'provided', assigned_to: 'Test Employee R' })
      expect(await one(`select status, approved_by, close_note from equipment_issues where id = $1`, [issue])).toEqual({
        status: 'retained_authorized', approved_by: ADMIN.id, close_note: 'Contractor keeps laptop per HR',
      })
      const h = await one(`select detail, actor_user_id from active_laptops_np_history where asset_id = $1 and action = 'retention_approved'`, [ids.spareInventoryLaptop])
      expect(h).toEqual({ detail: 'Retention by Test Employee R approved: Contractor keeps laptop per HR', actor_user_id: ADMIN.id })
      // Not pending any more, not open:
      expect(await openIssueFor(ids.spareInventoryLaptop)).toBeUndefined()
    })
  })

  it('Lost: requires a reason; device becomes Lost, unassigned, history kept, and no further lifecycle action is possible', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      expect(await errorOf(db, `select return_equipment($1, 'lost')`, [issue])).toMatch(/reason is required/)
      await rpc(db, `return_equipment($1, 'lost', null, 'Stolen from car, police report 123')`, [issue])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ status: 'lost', assigned_to: null })
      expect((await one(`select status, close_note from equipment_issues where id = $1`, [issue]))).toEqual({
        status: 'lost', close_note: 'Stolen from car, police report 123',
      })
      const actions = (await db.query(`select action from active_laptops_np_history where asset_id = $1 order by date, action`, [ids.spareInventoryLaptop])).rows.map((r) => r.action)
      expect(actions).toEqual(expect.arrayContaining(['created', 'provide', 'mark_lost']))
      for (const a of ['provide', 'collect', 'mark_repaired', 'retain']) {
        expect(await errorOf(db, `select perform_lifecycle_action('active_laptops_np', $1, $2::asset_action, 'X')`, [ids.spareInventoryLaptop, a])).toMatch(/not allowed from status lost/)
      }
    })
  })

  it('a device marked damaged while still assigned (H6) is unassigned on return and recorded as Returned damaged', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'mark_damaged')`, [ids.spareInventoryLaptop])
      expect((await one(`select status from equipment_issues where id = $1`, [issue])).status).toBe('open')
      await rpc(db, `return_equipment($1, 'returned')`, [issue])
      expect(await deviceRow(ids.spareInventoryLaptop)).toMatchObject({ status: 'damaged', assigned_to: null })
      expect((await one(`select status from equipment_issues where id = $1`, [issue])).status).toBe('returned_damaged')
    })
  })

  it('an item can only be processed once', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const issue = await issued('serialized_assets', ids.spareInventoryLaptop)
      await rpc(db, `return_equipment($1, 'returned')`, [issue])
      expect(await errorOf(db, `select return_equipment($1, 'returned')`, [issue])).toMatch(/already been processed/)
    })
  })

  it('Bulk: returned, damaged, retained (written off) and lost each move exactly the right quantities from Provided', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee R')
      const take = () => rpc<string>(db, `issue_equipment($1, null, null, $2, 1)`, [emp, extra.chargerBulk])
      const [a, b, c, d] = [await take(), await take(), await take(), await take()]
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 6, provided: 4, damaged: 0, decommissioned: 0 })
      await rpc(db, `return_equipment($1, 'returned')`, [a])
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 7, provided: 3 })
      await rpc(db, `return_equipment($1, 'returned_damaged')`, [b])
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 7, provided: 2, damaged: 1 })
      await rpc(db, `return_equipment($1, 'retained_authorized', null, 'Kept for home office (approved)')`, [c])
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 7, provided: 1, decommissioned: 1 })
      await rpc(db, `return_equipment($1, 'lost', null, 'Left on a plane')`, [d])
      expect(await bulk(extra.chargerBulk)).toMatchObject({ available: 7, provided: 0, damaged: 1, decommissioned: 2 })
      const statuses = (await db.query(`select status from equipment_issues where employee_id = $1 order by status`, [emp])).rows.map((r) => r.status)
      // Retained is recorded as authorized retention, NOT as lost:
      expect(statuses.sort()).toEqual(['lost', 'retained_authorized', 'returned', 'returned_damaged'])
      // Same transaction, same timestamp: compare as a set.
      const hist = (await db.query(`select detail from bulk_item_history where item_id = $1 and action = 'decommission'`, [extra.chargerBulk])).rows.map((r) => r.detail).sort()
      expect(hist).toEqual([
        'Written off — lost by Test Employee R: Left on a plane',
        'Written off — retained by Test Employee R (authorized): Kept for home office (approved)',
      ])
    })
  })

  it('Bulk: a partial return splits the row — the rest stays pending', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee R')
      const issue = await rpc<string>(db, `issue_equipment($1, null, null, $2, 2)`, [emp, extra.headsetBulk])
      expect(await errorOf(db, `select return_equipment($1, 'returned', 3)`, [issue])).toMatch(/between 1 and 2/)
      await rpc(db, `return_equipment($1, 'returned', 1)`, [issue])
      const { rows } = await db.query(`select status, quantity from equipment_issues where employee_id = $1 order by status`, [emp])
      expect(rows).toEqual([{ status: 'open', quantity: 1 }, { status: 'returned', quantity: 1 }])
      expect(await bulk(extra.headsetBulk)).toMatchObject({ available: 9, provided: 1 })
    })
  })
})

// ===================================================================
describe.skipIf(isStaging)('sync with existing lifecycle actions (device pages, not the register functions)', () => {
  it('Collect on a backfilled laptop closes its row as Returned', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const row = await openIssueFor(ids.npLaptop)
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.npLaptop])
      expect((await one(`select status, closed_by from equipment_issues where id = $1`, [row.id]))).toEqual({ status: 'returned', closed_by: ADMIN.id })
    })
  })

  it('Transfer closes the old row as Transferred and opens one for the new person (new employee created)', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const old = await openIssueFor(ids.monitor)
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'transfer', 'Test Employee Z')`, [ids.monitor])
      expect((await one(`select status from equipment_issues where id = $1`, [old.id])).status).toBe('transferred')
      const now = await openIssueFor(ids.monitor)
      expect(now.assignee_name).toBe('Test Employee Z')
      expect((await one(`select full_name from employees where id = $1`, [now.employee_id])).full_name).toBe('Test Employee Z')
    })
  })

  it('Swap closes the old device as Returned damaged and opens the replacement for the same person', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const old = await openIssueFor(ids.npLaptop)
      await rpc(db, `perform_swap('active_laptops_np', $1, $2, 'broken hinge')`, [ids.npLaptop, ids.spareInventoryLaptop])
      expect((await one(`select status from equipment_issues where id = $1`, [old.id])).status).toBe('returned_damaged')
      expect((await openIssueFor(ids.spareInventoryLaptop)).employee_id).toBe(old.employee_id)
    })
  })

  it('Decommission closes the row as Decommissioned', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const row = await openIssueFor(ids.npLaptop)
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'decommission')`, [ids.npLaptop])
      expect((await one(`select status from equipment_issues where id = $1`, [row.id])).status).toBe('decommissioned')
    })
  })

  it('an import that blanks the assignee (audit C4) closes the row as Unassigned, not Returned', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const row = await openIssueFor(ids.npLaptop)
      await rpc(db, `commit_asset_import('active_laptops_np', 'f.xlsx', $1::jsonb)`, [
        JSON.stringify([{ serial: 'LEG-NP-1', name: 'Lenovo ThinkPad T14', category: 'Laptop', status: '', assigned_to: '', location: '' }]),
      ])
      expect((await one(`select status from equipment_issues where id = $1`, [row.id])).status).toBe('unassigned')
    })
  })

  it('C2 fixed: the onboarding-assigned laptop can be collected, and its row closes', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const row = await openIssueFor(ids.inventoryLaptop)
      expect(await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.inventoryLaptop])).toBe('serialized_assets')
      expect((await one(`select status from equipment_issues where id = $1`, [row.id])).status).toBe('returned')
    })
  })

  it('a name matching two employees is recorded but flagged ambiguous — never guessed; an explicit choice is honoured', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const first = await newEmployee('Sam Lee')
      await newEmployee('Sam Lee')
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'provide', 'Sam Lee')`, [ids.spareInventoryLaptop])
      expect(await openIssueFor(ids.spareInventoryLaptop)).toMatchObject({ employee_id: null, employee_ambiguous: true })
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.spareInventoryLaptop])
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [first, ids.spareInventoryLaptop])
      expect(await openIssueFor(ids.spareInventoryLaptop)).toMatchObject({ employee_id: first, employee_ambiguous: false })
    })
  })

  it('after a mix of every action, the register still matches the devices', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const emp = await newEmployee('Test Employee M')
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [emp, ids.spareInventoryLaptop])
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'transfer', 'Test Employee N')`, [ids.spareInventoryLaptop])
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'collect')`, [ids.monitor])
      await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'mark_damaged')`, [ids.npLaptop])
      expect((await db.query(`select * from equipment_register_mismatches`)).rows).toEqual([])
    })
  })
})

// ===================================================================
describe.skipIf(isStaging)('security and permissions', () => {
  const CALLS: [string, unknown[]][] = [
    [`create_employee('X')`, []],
    [`issue_equipment($1, 'serialized_assets', $2)`, ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000']],
    [`return_equipment($1, 'returned')`, ['00000000-0000-0000-0000-000000000000']],
  ]

  it('anonymous sessions read nothing and can call nothing', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ANON_NEW)
      for (const t of ['employees', 'equipment_issues', 'employee_possible_duplicates', 'equipment_register_mismatches']) {
        expect((await one<{ n: number }>(`select count(*)::int as n from ${t}`)).n, t).toBe(0)
      }
      for (const [call, params] of CALLS) expect(await errorOf(db, `select ${call}`, params), call).toMatch(/not authorized/i)
    })
  })

  it('viewers can read the register but not issue, return or add employees', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, VIEWER)
      expect((await one<{ n: number }>(`select count(*)::int as n from equipment_issues`)).n).toBeGreaterThan(0)
      for (const [call, params] of CALLS) expect(await errorOf(db, `select ${call}`, params), call).toMatch(/not authorized/i)
    })
  })

  it('editors can issue and return', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, EDITOR)
      const emp = await newEmployee('Test Employee E')
      const issue = await rpc<string>(db, `issue_equipment($1, null, null, $2, 1)`, [emp, extra.chargerBulk])
      await rpc(db, `return_equipment($1, 'returned')`, [issue])
    })
  })

  it('nobody — not even the admin — can write the register or employees directly', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      expect(await errorOf(db, `insert into employees (full_name) values ('X')`)).toMatch(/row-level security/)
      expect(
        await errorOf(db, `insert into equipment_issues (assignee_name, item_kind, bulk_item_id, description) values ('X', 'bulk', $1, 'x')`, [extra.chargerBulk]),
      ).toMatch(/row-level security/)
      for (const t of ['employees', 'equipment_issues']) {
        const upd = await tryQuery(db, `update ${t} set id = id where true`)
        expect('error' in upd ? 0 : upd.rowCount, t).toBe(0)
        const del = await tryQuery(db, `delete from ${t} where true`)
        expect('error' in del ? 0 : del.rowCount, t).toBe(0)
      }
    })
  })

  it('internal helpers are not callable through the API', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      for (const call of ['rebuild_equipment_register_from_assignments()', `resolve_employee('X', true)`, `equipment_setting('x')`]) {
        expect(await errorOf(db, `select ${call}`), call).toMatch(/permission denied/)
      }
    })
  })
})

// ===================================================================
describe.skipIf(isStaging)('backup and restore', () => {
  const ALL = [...LEDGER_TABLES, 'employees', 'equipment_issues']
  async function exportPayload(tables: readonly string[]) {
    const payload: Record<string, unknown> = {}
    for (const t of tables) {
      payload[t] = (await one<{ rows: unknown }>(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from ${t} t`)).rows
    }
    return payload
  }

  it('a new backup restores every table exactly — register, employees, answers and all', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      // Make the register interesting first.
      const emp = await newEmployee('Test Employee B2')
      await db.query(`update onboarding_checklists set charger_required = 'yes', headset_required = 'not_applicable', requested_laptop = '14in, 16GB' where id = $1`, [ids.onboarding])
      const c = await rpc<string>(db, `issue_equipment($1, null, null, $2, 2)`, [emp, extra.chargerBulk])
      await rpc(db, `return_equipment($1, 'retained_authorized', 1, 'approved')`, [c])
      await actAsDatabase(db)
      const hashes: Record<string, string> = {}
      for (const t of ALL) hashes[t] = await tableHash(db, t)
      await actAs(db, ADMIN)
      await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(await exportPayload(ALL))])
      await actAsDatabase(db)
      for (const t of ALL) expect(await tableHash(db, t), t).toBe(hashes[t])
    })
  })

  it('a backup from before 026 restores and the register is rebuilt from assignments', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const payload = await exportPayload(LEDGER_TABLES)
      // Strip what a pre-026 export wouldn't have.
      for (const r of payload.onboarding_checklists as Record<string, unknown>[]) {
        for (const k of ['employee_id', 'requested_laptop', 'charger_required', 'headset_required']) delete r[k]
      }
      for (const r of payload.offboarding_checklists as Record<string, unknown>[]) delete r.employee_id
      await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(payload)])
      await actAsDatabase(db)
      expect((await one<{ n: number }>(`select count(*)::int as n from equipment_issues where status = 'open'`)).n).toBe(await assignedDeviceCount())
      expect((await db.query(`select * from equipment_register_mismatches`)).rows).toEqual([])
      expect((await one<{ n: number }>(`select count(*)::int as n from onboarding_checklists where employee_id is null`)).n).toBe(0)
      expect((await bulk(ids.bulkItem)).provided).toBe(5)
    })
  })
})

// ===================================================================
describe.skipIf(isStaging)('rollback', () => {
  it('026 then 025 roll back to the exact pre-025 definitions and data, keeping copies of what 026 recorded', async () => {
    const employees = (await one<{ n: number }>(`select count(*)::int as n from employees`)).n
    await applyRollback(db, '20260901000026_down.sql')
    await applyRollback(db, '20260901000025_down.sql')
    const after = await definitionsSnapshot()
    expect(after.policies).toEqual((before.defs as typeof after).policies)
    expect(after.functions).toEqual((before.defs as typeof after).functions)
    expect(after.triggers).toEqual((before.defs as typeof after).triggers)
    expect(after.tables).toEqual((before.defs as typeof after).tables)
    for (const t of PRE_EXISTING) expect(await preExistingHash(t), t).toBe(before.hashes[t])
    expect((await one<{ n: number }>(`select count(*)::int as n from private.employees_backup_026`)).n).toBe(employees)
  })

  it('025 and 026 re-apply cleanly afterwards', async () => {
    await applyMigration(db, M025)
    await applyMigration(db, M026)
    expect((await one<{ n: number }>(`select count(*)::int as n from equipment_issues where status = 'open'`)).n).toBe(before.assigned)
    for (const t of PRE_EXISTING) expect(await preExistingHash(t), t).toBe(before.hashes[t])
  })
})
