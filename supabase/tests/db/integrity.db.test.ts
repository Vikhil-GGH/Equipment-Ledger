/**
 * Tests for 20260901000027_inventory_integrity.sql on a fresh disposable
 * database (PGlite only): serial uniqueness (M1), non-destructive imports
 * (C4), verified restore (C5), preservation and rollback.
 *
 * The "before" state is built at 026 through the app's own functions, plus
 * the duplicates 027 must keep and report (inserted the way an old import
 * could have: exact-serial matching per table only).
 *
 * Every test runs in a transaction that is rolled back, so each one starts
 * from the same migrated state.
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
import { ADMIN, ASSET_TABLES, EDITOR, VIEWER, backupTables, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

const M027 = '20260901000027_inventory_integrity.sql'
let db: Db
let ids: LedgerIds
const dup: Record<string, string> = {}
const before: { hashes: Record<string, string>; defs?: unknown } = { hashes: {} }
const PRE_EXISTING = ['profiles', 'employees', 'equipment_issues', 'serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment',
  'bulk_items', 'serialized_asset_history', 'active_laptops_np_history', 'monitors_history', 'other_equipment_history',
  'bulk_item_history', 'onboarding_checklists', 'offboarding_checklists', 'import_events']
const HISTORY = ['serialized_asset_history', 'active_laptops_np_history', 'monitors_history', 'other_equipment_history']

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
const createAsset = (collection: string, serial: string, name = 'Dell Latitude 5440', category = 'Laptop') =>
  rpc<string>(db, `create_asset($1::asset_collection, $2, $3, $4)`, [collection, name, category, serial])
const createError = (collection: string, serial: string) =>
  errorOf(db, `select create_asset($1::asset_collection, 'Dell Latitude 5440', 'Laptop', $2)`, [collection, serial])

interface ImportRow { serial: string; name?: string; category?: string; status?: string; assigned_to?: string; location?: string }
const row = (r: ImportRow) => ({ name: '', category: '', status: '', assigned_to: '', location: '', ...r })
const doImport = (collection: string, rows: ImportRow[], filename = 'inventory.xlsx') =>
  rpc<Record<string, any>>(db, `commit_asset_import($1::asset_collection, $2, $3::jsonb)`, [collection, filename, JSON.stringify(rows.map(row))])

async function device(id: string) {
  return one(
    `select 'serialized_assets' as tbl, name, category, location, serial, status::text, assigned_to from serialized_assets where id = $1
     union all select 'active_laptops_np', name, category, location, serial, status::text, assigned_to from active_laptops_np where id = $1
     union all select 'monitors', name, category, location, serial, status::text, assigned_to from monitors where id = $1
     union all select 'other_equipment', name, category, location, serial, status::text, assigned_to from other_equipment where id = $1`,
    [id],
  )
}
const historyCount = () => n(`select ${HISTORY.map((t) => `(select count(*) from ${t})`).join(' + ')} as n`)
const lifecycleHistoryCount = () =>
  n(`select ${HISTORY.map((t) => `(select count(*) from ${t} where action not in ('created', 'imported'))`).join(' + ')} as n`)
const deviceCount = () => n(`select ${ASSET_TABLES.map((t) => `(select count(*) from ${t})`).join(' + ')} as n`)
async function hashes(tables: string[]) {
  const h: Record<string, string> = {}
  for (const t of tables) h[t] = await tableHash(db, t)
  return h
}

/** What the app's export puts in a file, built here from the database. */
async function backupPayload(withCounts = true): Promise<Record<string, any>> {
  const payload: Record<string, any> = {}
  for (const t of await backupTables(db)) {
    payload[t] = (await one<{ v: unknown[] }>(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') as v from ${t} x`)).v
  }
  if (withCounts) payload._counts = Object.fromEntries(Object.entries(payload).map(([t, rows]) => [t, rows.length]))
  return payload
}
const restore = (payload: unknown) => rpc<Record<string, any>>(db, `restore_backup($1::jsonb)`, [JSON.stringify(payload)])

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M027) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }

  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    const l = await seedLedger(db, 'INT') // INT-NP-1 provided to Test Employee A
    await actAs(db, ADMIN)
    // Existing duplicates under the new rule — possible today because the
    // only check is an exact, per-table unique(serial).
    dup.inv = await createAsset('serialized_assets', 'DUP-1')
    dup.np = await createAsset('active_laptops_np', ' dup-1 ')
    dup.mon = await createAsset('monitors', 'X  Y', 'Dell 24 Monitor', 'Monitor')
    dup.oth = await createAsset('other_equipment', 'x y', 'USB-C Dock', 'Dock')
    dup.blank = await createAsset('other_equipment', '  ', 'Cable', 'Cable')
    await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'provide', 'Test Employee C')`, [dup.inv]) // moves to NP
    await actAsDatabase(db)
    return l
  })
  for (const t of PRE_EXISTING) before.hashes[t] = await tableHash(db, t)
  before.defs = (await db.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1, 2`)).rows

  await applyMigration(db, M027)
}, 240_000)

afterAll(async () => {
  await db?.close()
})

const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

// ===================================================================
describe.skipIf(isStaging)('027 applied to existing data', () => {
  it('changes no existing row (devices, history, register, employees, checklists, imports, profiles)', async () => {
    for (const t of PRE_EXISTING) expect(await tableHash(db, t), t).toBe(before.hashes[t])
  })

  it('reports the existing duplicates and the blank serial for review, without merging or deleting anything', async () => {
    const { rows } = await db.query<{ serial_key: string; asset_id: string; reason: string }>(
      `select serial_key, asset_id, reason from serial_duplicate_candidates order by serial_key, asset_id`,
    )
    const byKey = (k: string) => rows.filter((r) => r.serial_key === k).map((r) => r.asset_id).sort()
    expect(byKey('DUP-1')).toEqual([dup.inv, dup.np].sort())
    expect(byKey('X Y')).toEqual([dup.mon, dup.oth].sort())
    expect(byKey('')).toEqual([dup.blank])
    expect(rows).toHaveLength(5)
    // All five devices still exist, unchanged, and are flagged in the registry.
    for (const id of Object.values(dup)) {
      expect(await device(id), id).toBeTruthy()
      expect((await one(`select grandfathered from serial_keys where asset_id = $1`, [id])).grandfathered, id).toBe(true)
    }
  })

  it('every device has exactly one registry row; non-duplicates are not grandfathered', async () => {
    expect(await n(`select count(*) as n from serial_keys`)).toBe(await deviceCount())
    expect(await n(`select count(*) as n from serial_keys where grandfathered`)).toBe(5)
  })
})

// ===================================================================
describe.skipIf(isStaging)('M1: one device per serial', () => {
  it('normalize_serial: trim, collapse internal whitespace, case-insensitive', async () => {
    const cases: [string, string][] = [
      ['ABC123', 'ABC123'],
      ['abc123', 'ABC123'],
      ['  ABC123 ', 'ABC123'],
      ['\tabc123\n', 'ABC123'],
      [' ABC123 ', 'ABC123'],
      ['ABC 123', 'ABC 123'],
      ['ABC   123', 'ABC 123'],
      ['ABC\t 123', 'ABC 123'],
      ['   ', ''],
    ]
    for (const [input, key] of cases) {
      expect((await one<{ k: string }>(`select normalize_serial($1) as k`, [input])).k, JSON.stringify(input)).toBe(key)
    }
  })

  it('ABC123 vs abc123, and vs " ABC123 " — manual entry is blocked with a clear error; the display value is kept as typed', tx(async () => {
    await actAs(db, EDITOR)
    const id = await createAsset('serialized_assets', 'ABC123')
    expect(await createError('serialized_assets', 'abc123')).toMatch(/Serial number "abc123" already exists/)
    expect(await createError('serialized_assets', ' ABC123 ')).toMatch(/already exists/)
    const id2 = await createAsset('monitors', ' MON-77 ', 'Dell 24 Monitor', 'Monitor')
    expect((await device(id2)).serial).toBe(' MON-77 ')
    expect(await createError('monitors', 'mon-77')).toMatch(/already exists/)
    expect((await device(id)).serial).toBe('ABC123')
  }))

  it('internal whitespace: runs collapse to one space ("ABC  123" = "ABC 123"), but a space is significant ("ABC123" ≠ "ABC 123")', tx(async () => {
    await actAs(db, EDITOR)
    await createAsset('serialized_assets', 'ABC 123')
    expect(await createError('serialized_assets', 'ABC  123')).toMatch(/already exists/)
    expect(await createError('serialized_assets', 'abc\t123')).toMatch(/already exists/)
    expect(await createAsset('serialized_assets', 'ABC123')).toBeTruthy()
  }))

  it('the two laptop tables share one serial space, as do all serialized tables', tx(async () => {
    await actAs(db, EDITOR)
    await createAsset('serialized_assets', 'LAP-500')
    expect(await createError('active_laptops_np', 'lap-500')).toMatch(/already exists \(as LAP-500 in serialized assets\)/)
    await createAsset('active_laptops_np', 'NP-500')
    expect(await createError('serialized_assets', 'NP-500 ')).toMatch(/already exists/)
    expect(await createError('other_equipment', 'np-500')).toMatch(/already exists/)
  }))

  it('a blank serial is rejected for a new device', tx(async () => {
    await actAs(db, EDITOR)
    expect(await createError('other_equipment', '   ')).toMatch(/A serial number is required/)
    expect(await createError('serialized_assets', '')).toMatch(/A serial number is required/)
  }))

  it('a serial already shared by grandfathered duplicates cannot be taken by a new device', tx(async () => {
    await actAs(db, EDITOR)
    expect(await createError('serialized_assets', 'dup-1')).toMatch(/already exists/)
    expect(await createError('monitors', 'X Y')).toMatch(/already exists/)
  }))

  it('changing a serial to one another device has is blocked; changing to a free one works', tx(async () => {
    await actAsDatabase(db)
    expect(await errorOf(db, `update monitors set serial = 'int-oth-1' where id = $1`, [ids.monitor])).toMatch(/already exists/)
    await db.query(`update monitors set serial = 'INT-MON-NEW' where id = $1`, [ids.monitor])
    expect((await one(`select serial_key from serial_keys where asset_id = $1`, [ids.monitor])).serial_key).toBe('INT-MON-NEW')
    // The old serial is free again.
    await actAs(db, EDITOR)
    expect(await createAsset('monitors', 'INT-MON-1', 'Dell 24 Monitor', 'Monitor')).toBeTruthy()
  }))

  it('a laptop keeps its serial while it moves Inventory → Active Laptops → Inventory (provide / collect)', tx(async () => {
    await actAs(db, ADMIN)
    await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'provide', 'Test Employee D')`, [ids.spareInventoryLaptop])
    expect(await one(`select collection::text, serial_key from serial_keys where asset_id = $1`, [ids.spareInventoryLaptop]))
      .toEqual({ collection: 'active_laptops_np', serial_key: 'INT-INV-2' })
    await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.spareInventoryLaptop])
    expect((await one(`select collection::text from serial_keys where asset_id = $1`, [ids.spareInventoryLaptop])).collection).toBe('serialized_assets')
    expect(await n(`select count(*) as n from serial_keys where serial_key = 'INT-INV-2'`)).toBe(1)
    // Grandfathered duplicates keep working too (DUP-1 was provided into NP before 027).
    await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [dup.inv])
    expect((await device(dup.inv)).tbl).toBe('serialized_assets')
    expect((await one(`select grandfathered from serial_keys where asset_id = $1`, [dup.inv])).grandfathered).toBe(true)
  }))

  it('deleting a device frees its serial', tx(async () => {
    await actAsDatabase(db)
    await db.query(`delete from other_equipment where id = $1`, [ids.other])
    expect(await n(`select count(*) as n from serial_keys where asset_id = $1`, [ids.other])).toBe(0)
    await actAs(db, EDITOR)
    expect(await createAsset('other_equipment', 'int-oth-1', 'USB-C Dock', 'Dock')).toBeTruthy()
  }))

  it('concurrency: the registry index itself refuses a second device with the same key (what a racing transaction hits)', tx(async () => {
    await actAsDatabase(db)
    // A second transaction that passed the pre-check would still have to
    // insert this row; the partial unique index blocks it (and, between two
    // live transactions, makes the second one wait for the first to commit).
    expect(await errorOf(db, `insert into serial_keys (asset_id, collection, serial_key) values (gen_random_uuid(), 'monitors', 'INT-INV-1')`))
      .toMatch(/serial_keys_one_device_per_serial/)
    const def = await one<{ d: string }>(`select pg_get_indexdef('serial_keys_one_device_per_serial'::regclass) as d`)
    expect(def.d).toMatch(/UNIQUE INDEX .* \(serial_key\) WHERE \(\(NOT grandfathered\) AND \(serial_key <> ''::text\)\)/)
  }))

  it('API users can read the registry but not change it or call its helpers', tx(async () => {
    await actAs(db, ADMIN)
    expect(await errorOf(db, `insert into serial_keys (asset_id, collection, serial_key) values (gen_random_uuid(), 'monitors', 'Z')`)).toMatch(/permission denied|row-level security/)
    expect(await errorOf(db, `delete from serial_keys`)).toMatch(/permission denied/)
    expect(await errorOf(db, `update serial_keys set grandfathered = true`)).toMatch(/permission denied/)
    expect(await n(`select count(*) as n from serial_keys`)).toBeGreaterThan(0)
    expect(await errorOf(db, `select rebuild_serial_keys()`)).toMatch(/permission denied/)
    await actAs(db, VIEWER)
    expect(await n(`select count(*) as n from serial_duplicate_candidates`)).toBe(5)
  }))
})

// ===================================================================
describe.skipIf(isStaging)('C4: imports never change status or assignment', () => {
  it('1+2: an assigned laptop imported with blank status and blank employee is left exactly as it is', tx(async () => {
    const was = await device(ids.npLaptop)
    const h = await historyCount()
    await actAs(db, EDITOR)
    const r = await doImport('serialized_assets', [{ serial: 'INT-NP-1', name: 'Lenovo ThinkPad T14', category: 'Laptop' }])
    expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 1, rejected: 0, issues: [] })
    expect(await device(ids.npLaptop)).toEqual(was)
    expect(was).toMatchObject({ tbl: 'active_laptops_np', status: 'provided', assigned_to: 'Test Employee A' })
    expect(await historyCount()).toBe(h)
  }))

  it('3: a conflicting status or assignee is reported, not applied', tx(async () => {
    await actAs(db, EDITOR)
    const r = await doImport('active_laptops_np', [
      { serial: 'int-np-1', status: 'available', assigned_to: 'Someone Else' },
      { serial: 'INT-MON-1', status: 'decommissioned' },
    ])
    expect(r.unchanged).toBe(1)
    expect(r.rejected).toBe(1) // the monitor isn't a laptop
    expect(r.issues).toEqual([
      expect.objectContaining({ row: 1, kind: 'not_applied', field: 'status', current: 'provided', requested: 'available', asset_id: ids.npLaptop }),
      expect.objectContaining({ row: 1, kind: 'not_applied', field: 'assigned_to', current: 'Test Employee A', requested: 'Someone Else' }),
      expect.objectContaining({ row: 2, kind: 'rejected', collection: 'monitors', asset_id: ids.monitor }),
    ])
    expect(await device(ids.npLaptop)).toMatchObject({ status: 'provided', assigned_to: 'Test Employee A' })
    expect(await device(ids.monitor)).toMatchObject({ status: 'available' })
    // Logged with the full report.
    const ev = await one(`select rows_created, rows_updated, rows_errored, summary from import_events order by imported_at desc limit 1`)
    expect(ev).toMatchObject({ rows_created: 0, rows_updated: 0, rows_errored: 1 })
    expect(ev.summary).toMatchObject({ total: 2, unchanged: 1 })
    expect(ev.summary.issues).toHaveLength(3)
  }))

  it('the same status and the same assignee (typed differently) are not conflicts', tx(async () => {
    await actAs(db, EDITOR)
    const r = await doImport('active_laptops_np', [{ serial: 'INT-NP-1', status: 'Provided', assigned_to: ' test  employee a ' }])
    expect(r).toMatchObject({ unchanged: 1, issues: [] })
  }))

  it('4: importing the same file repeatedly creates nothing twice and writes no further history', tx(async () => {
    await actAs(db, EDITOR)
    const file: ImportRow[] = [
      { serial: 'NEW-100', name: 'HP EliteBook', category: 'Laptop', location: 'HQ' },
      { serial: 'INT-INV-2', name: 'Dell Latitude 5440', category: 'Laptop', location: 'Store room' },
    ]
    const first = await doImport('serialized_assets', file)
    expect(first).toMatchObject({ created: 1, updated: 1, unchanged: 0 })
    const h = await historyCount()
    const devices = await deviceCount()
    for (let i = 0; i < 3; i++) {
      expect(await doImport('serialized_assets', file)).toMatchObject({ created: 0, updated: 0, unchanged: 2, rejected: 0 })
      // A differently-cased copy of the same file too.
      expect(await doImport('serialized_assets', file.map((r) => ({ ...r, serial: ` ${r.serial.toLowerCase()} ` })))).toMatchObject({ unchanged: 2 })
    }
    expect(await historyCount()).toBe(h)
    expect(await deviceCount()).toBe(devices)
    expect(await n(`select count(*) as n from serial_keys where serial_key = 'NEW-100'`)).toBe(1)
  }))

  it('5: new equipment is created, available and unassigned; a new device can\'t be imported as assigned/provided/retained/lost', tx(async () => {
    await actAs(db, EDITOR)
    const r = await doImport('monitors', [
      { serial: 'MON-NEW-1', name: 'LG 27', category: 'Monitor' },
      { serial: 'MON-NEW-2', name: 'LG 27', category: 'Monitor', status: 'damaged' },
      { serial: 'MON-NEW-3', name: 'LG 27', category: 'Monitor', assigned_to: 'Test Employee Z' },
      { serial: 'MON-NEW-4', name: 'LG 27', category: 'Monitor', status: 'provided' },
      { serial: 'MON-NEW-5', name: 'LG 27', category: 'Monitor', status: 'lost' },
      { serial: 'MON-NEW-6', name: 'LG 27', category: 'Monitor', status: 'retained' },
      { serial: 'MON-NEW-7', category: 'Monitor' },
      { serial: '  ', name: 'LG 27', category: 'Monitor' },
      { serial: 'MON-NEW-8', name: 'LG 27', category: 'Monitor', status: 'borrowed' },
    ])
    expect(r).toMatchObject({ created: 2, rejected: 7 })
    expect(r.issues.map((i: any) => i.row)).toEqual([3, 4, 5, 6, 7, 8, 9])
    const { rows } = await db.query(`select serial, status::text, assigned_to from monitors where serial like 'MON-NEW-%' order by serial`)
    expect(rows).toEqual([
      { serial: 'MON-NEW-1', status: 'available', assigned_to: null },
      { serial: 'MON-NEW-2', status: 'damaged', assigned_to: null },
    ])
    expect(await n(`select count(*) as n from equipment_issues where serial like 'MON-NEW-%'`)).toBe(0)
  }))

  it('a file listing the same new serial twice creates one device', tx(async () => {
    await actAs(db, EDITOR)
    const r = await doImport('other_equipment', [
      { serial: 'HS-9', name: 'Jabra Evolve', category: 'Headset' },
      { serial: 'hs-9 ', name: 'Jabra Evolve', category: 'Headset' },
    ])
    expect(r).toMatchObject({ created: 1, unchanged: 1 })
  }))

  it('6: harmless metadata changes apply; blank cells never clear a value', tx(async () => {
    await actAsDatabase(db)
    await db.query(`update monitors set location = 'Desk 4' where id = $1`, [ids.monitor])
    await actAs(db, EDITOR)
    const r = await doImport('monitors', [{ serial: 'int-mon-1', name: 'Dell 24 Monitor P2425', category: '', location: '' }], 'monitors-v2.xlsx')
    expect(r).toMatchObject({ updated: 1, issues: [] })
    expect(await device(ids.monitor)).toMatchObject({ name: 'Dell 24 Monitor P2425', category: 'Monitor', location: 'Desk 4', status: 'available', serial: 'INT-MON-1' })
    const h = await one(`select action, detail from monitors_history where asset_id = $1 order by date desc limit 1`, [ids.monitor])
    expect(h).toEqual({ action: 'imported', detail: 'Updated via import from monitors-v2.xlsx: name "Dell 24 Monitor" → "Dell 24 Monitor P2425"' })
  }))

  it('a metadata change on an assigned laptop in Active Laptops, imported into Laptop Inventory, updates it in place — no duplicate, no move', tx(async () => {
    await actAs(db, EDITOR)
    const devices = await deviceCount()
    expect(await doImport('serialized_assets', [{ serial: 'INT-NP-1', location: 'Remote' }])).toMatchObject({ updated: 1 })
    expect(await device(ids.npLaptop)).toMatchObject({ tbl: 'active_laptops_np', location: 'Remote', status: 'provided', assigned_to: 'Test Employee A' })
    expect(await deviceCount()).toBe(devices)
  }))

  it('a serial that is already duplicated is reported, not guessed', tx(async () => {
    await actAs(db, EDITOR)
    const r = await doImport('serialized_assets', [{ serial: 'DUP-1', location: 'HQ' }])
    expect(r).toMatchObject({ updated: 0, rejected: 1 })
    expect(r.issues[0].reason).toMatch(/More than one device already has this serial/)
  }))

  it('a serial belonging to another kind of device is rejected (no cross-table duplicate)', tx(async () => {
    await actAs(db, EDITOR)
    const devices = await deviceCount()
    const r = await doImport('other_equipment', [{ serial: 'int-inv-2', name: 'Thing', category: 'Thing' }])
    expect(r).toMatchObject({ created: 0, rejected: 1 })
    expect(await deviceCount()).toBe(devices)
  }))

  it('7+8: across a mixed import the register stays in sync and no lifecycle history is written', tx(async () => {
    const register = await tableHash(db, 'equipment_issues')
    const lifecycle = await lifecycleHistoryCount()
    const npHistory = await tableHash(db, 'active_laptops_np_history')
    await actAs(db, EDITOR)
    await doImport('active_laptops_np', [
      { serial: 'INT-NP-1', status: 'available', assigned_to: '' },
      { serial: 'NEW-NP-9', name: 'Lenovo ThinkPad T14', category: 'Laptop' },
    ])
    await doImport('serialized_assets', [{ serial: 'INT-INV-1', assigned_to: 'New Person', location: 'HQ' }])
    await actAsDatabase(db)
    expect(await tableHash(db, 'equipment_issues')).toBe(register)
    expect((await db.query(`select * from equipment_register_mismatches`)).rows).toEqual([])
    expect(await lifecycleHistoryCount()).toBe(lifecycle)
    // INT-NP-1 (conflicting status, blank employee) got no history at all.
    expect(await n(`select count(*) as n from active_laptops_np_history where asset_id <> all (select id from active_laptops_np where serial = 'NEW-NP-9')`))
      .toBe(await n(`select count(*) as n from active_laptops_np_history`) - 1)
    await db.query(`delete from active_laptops_np where serial = 'NEW-NP-9'`)
    expect(await tableHash(db, 'active_laptops_np_history')).toBe(npHistory)
  }))

  it('9: if an import fails part-way, nothing at all is changed (one transaction)', tx(async () => {
    await actAsDatabase(db)
    // Simulate an unexpected failure on the third row.
    await db.exec(`create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'disk full'; end $$`)
    await db.exec(`create trigger boom before insert on monitors for each row when (new.serial = 'BOOM') execute function pg_temp.boom()`)
    const snapshot = await hashes(PRE_EXISTING)
    await actAs(db, EDITOR)
    const err = await errorOf(db, `select commit_asset_import('monitors', 'f.xlsx', $1::jsonb)`, [JSON.stringify([
      row({ serial: 'INT-MON-1', location: 'Changed' }),
      row({ serial: 'MON-OK', name: 'LG 27', category: 'Monitor' }),
      row({ serial: 'BOOM', name: 'LG 27', category: 'Monitor' }),
    ])])
    expect(err).toMatch(/disk full/)
    await actAsDatabase(db)
    expect(await hashes(PRE_EXISTING)).toEqual(snapshot)
    expect(await n(`select count(*) as n from serial_keys where serial_key = 'MON-OK'`)).toBe(0)
  }))

  it('viewers still cannot import', tx(async () => {
    await actAs(db, VIEWER)
    expect(await errorOf(db, `select commit_asset_import('monitors', 'f.xlsx', '[]'::jsonb)`)).toMatch(/Not authorized to import/)
    // The smoke test's write probe must fail even for an admin, writing nothing.
    const events = await n(`select count(*) as n from import_events`)
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select commit_asset_import('serialized_assets', 'anon-probe', '"anon-probe"'::jsonb)`)).toMatch(/scalar/)
    expect(await n(`select count(*) as n from import_events`)).toBe(events)
  }))
})

// ===================================================================
describe.skipIf(isStaging)('C5: restore verifies what it restores', () => {
  /** Thousands of rows across many tables, as the database (fast). */
  async function seedLarge() {
    await actAsDatabase(db)
    await db.exec(`
      insert into serialized_assets (name, category, serial, status, assigned_to)
      select 'Bulk Laptop', 'Laptop', 'BIG-' || lpad(g::text, 5, '0'),
             case when g <= 1100 then 'provided' else 'available' end::asset_status,
             case when g <= 1100 then 'Big Employee ' || g end
      from generate_series(1, 1500) g;
      insert into serialized_asset_history (asset_id, action, detail)
      select a.id, 'note', 'entry ' || g from (select id from serialized_assets where serial like 'BIG-%' order by serial limit 700) a, generate_series(1, 5) g;
      insert into monitors (name, category, serial) select 'Bulk Monitor', 'Monitor', 'BIGM-' || g from generate_series(1, 1200) g;
      insert into import_events (target_collection, filename, rows_created, rows_updated, rows_errored, summary)
      select 'monitors', 'f' || g || '.xlsx', 1, 0, 0, '{}'::jsonb from generate_series(1, 1050) g;
      insert into onboarding_checklists (employee_name, charger_required, headset_required)
      select 'Big Onboard ' || g, (array['yes','no','not_applicable',null])[1 + g % 4]::requirement_answer,
             (array[null,'yes','no','not_applicable'])[1 + g % 4]::requirement_answer
      from generate_series(1, 1020) g;
      insert into offboarding_checklists (employee_name) select 'Big Offboard ' || g from generate_series(1, 1010) g;
      insert into bulk_item_history (item_id, action, detail, quantity)
      select $id$${ids.bulkItem}$id$::uuid, 'note', 'n' || g, 1 from generate_series(1, 1200) g;
    `)
  }

  it('1–5, 8: >1,000 rows in many tables, thousands of history rows, employees, register, charger/headset answers — restored exactly, with counts verified', tx(async () => {
    await seedLarge()
    const tables = await backupTables(db)
    const counts: Record<string, number> = {}
    for (const t of tables) counts[t] = await n(`select count(*) as n from ${t}`)
    expect(counts.serialized_assets).toBeGreaterThan(1000)
    expect(counts.serialized_asset_history).toBeGreaterThan(3500)
    expect(counts.employees).toBeGreaterThan(1000)
    expect(counts.equipment_issues).toBeGreaterThan(1000)
    expect(counts.import_events).toBeGreaterThan(1000)
    expect(counts.onboarding_checklists).toBeGreaterThan(1000)
    expect(counts.offboarding_checklists).toBeGreaterThan(1000)
    const snapshot = await hashes(tables)
    const keys = await tableHash(db, 'serial_keys')

    const payload = await backupPayload()
    await actAs(db, ADMIN)
    const result = await restore(payload)
    expect(result.counts).toEqual(counts)
    expect(result.duplicate_serials).toBe(5)
    expect(result.register_mismatches).toBe(0)
    await actAsDatabase(db)
    expect(await hashes(tables)).toEqual(snapshot) // ids, links, timestamps, quantities, history, answers
    expect(await tableHash(db, 'serial_keys')).toBe(keys)
    expect(await n(`select count(*) as n from (select asset_id from equipment_issues where status = 'open' group by 1 having count(*) > 1) x`)).toBe(0)
    expect(await n(`select count(*) as n from onboarding_checklists where charger_required = 'not_applicable'`)).toBe(255)
  }), 120_000)

  it('7+9: a file missing rows (e.g. an export cut short) is refused and nothing is changed', tx(async () => {
    const payload = await backupPayload()
    payload.serialized_asset_history = payload.serialized_asset_history.slice(0, -1)
    const snapshot = await hashes(PRE_EXISTING)
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select restore_backup($1::jsonb)`, [JSON.stringify(payload)]))
      .toMatch(/Backup file is incomplete: serialized_asset_history has \d+ rows but the export recorded \d+/)
    const missingTable = await backupPayload()
    delete missingTable.monitors
    expect(await errorOf(db, `select restore_backup($1::jsonb)`, [JSON.stringify(missingTable)])).toMatch(/monitors has 0 rows/)
    expect(await errorOf(db, `select restore_backup($1::jsonb)`, [JSON.stringify({ ...payload, _counts: { ...payload._counts, profiles: 1 } })]))
      .toMatch(/unknown table "profiles"/)
    await actAsDatabase(db)
    expect(await hashes(PRE_EXISTING)).toEqual(snapshot)
  }))

  it('a row the database drops on the way in fails the whole restore (post-restore count check)', tx(async () => {
    const payload = await backupPayload()
    // Two history rows with the same id: the file count matches, but only
    // one can be stored.
    payload.monitors_history.push({ ...payload.monitors_history[0] })
    payload._counts.monitors_history += 1
    const snapshot = await hashes(PRE_EXISTING)
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select restore_backup($1::jsonb)`, [JSON.stringify(payload)])).not.toBeNull()
    await actAsDatabase(db)
    expect(await hashes(PRE_EXISTING)).toEqual(snapshot)
  }))

  it('6: a legacy backup (before 026/027: no counts, no employees or register) still restores, and the register is rebuilt', tx(async () => {
    const payload = await backupPayload(false)
    delete payload.employees
    delete payload.equipment_issues
    for (const r of payload.onboarding_checklists) {
      delete r.employee_id; delete r.requested_laptop; delete r.charger_required; delete r.headset_required
    }
    const devices = await hashes([...ASSET_TABLES])
    await actAs(db, ADMIN)
    const result = await restore(payload)
    expect(result.register_mismatches).toBe(0)
    await actAsDatabase(db)
    expect(await hashes([...ASSET_TABLES])).toEqual(devices)
    expect(await n(`select count(*) as n from equipment_issues where status = 'open'`)).toBe(
      await n(`select ${ASSET_TABLES.map((t) => `(select count(*) from ${t} where nullif(btrim(assigned_to), '') is not null)`).join(' + ')} as n`),
    )
    expect(await n(`select count(*) as n from onboarding_checklists where charger_required is not null or headset_required is not null`)).toBe(0)
    expect(await n(`select count(*) as n from serial_keys where grandfathered`)).toBe(5)
  }))

  it('restoring a backup taken after a serial changed rebuilds the registry from the restored devices', tx(async () => {
    const payload = await backupPayload()
    await actAsDatabase(db)
    await db.query(`update monitors set serial = 'CHANGED' where id = $1`, [ids.monitor])
    await actAs(db, ADMIN)
    await restore(payload)
    await actAsDatabase(db)
    expect((await one(`select serial_key from serial_keys where asset_id = $1`, [ids.monitor])).serial_key).toBe('INT-MON-1')
    expect(await n(`select count(*) as n from serial_keys where serial_key = 'CHANGED'`)).toBe(0)
  }))

  it('only an admin can restore; the inner loader is not callable', tx(async () => {
    await actAs(db, EDITOR)
    expect(await errorOf(db, `select restore_backup('{}'::jsonb)`)).toMatch(/Only an admin/)
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select restore_backup_load('{}'::jsonb)`)).toMatch(/permission denied/)
  }))
})

// ===================================================================
describe.skipIf(isStaging)('027 rollback', () => {
  it('027_down restores 026 exactly (functions), keeps every row, and 027 re-applies', async () => {
    await applyRollback(db, '20260901000027_down.sql')
    const defs = (await db.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1, 2`)).rows
    expect(defs).toEqual(before.defs)
    expect((await one(`select to_regclass('public.serial_keys') as t`)).t).toBeNull()
    for (const t of PRE_EXISTING) expect(await tableHash(db, t), t).toBe(before.hashes[t])
    await applyMigration(db, M027)
    expect(await n(`select count(*) as n from serial_duplicate_candidates`)).toBe(5)
    for (const t of PRE_EXISTING) expect(await tableHash(db, t), t).toBe(before.hashes[t])
  })

  it('the full chain 027_down → 026_down → 025_down still runs, leaving the pre-025 devices intact', async () => {
    const devices = await hashes([...ASSET_TABLES])
    await applyRollback(db, '20260901000027_down.sql')
    await applyRollback(db, '20260901000026_down.sql')
    await applyRollback(db, '20260901000025_down.sql')
    expect(await hashes([...ASSET_TABLES])).toEqual(devices)
  })
})
