/**
 * Inventory integrity (20260901000027) against a LIVE database that already
 * has the migration — the hosted staging project (npm run staging:test-db).
 * Every test creates its own "ZZ-INT" records inside transactions that are
 * always ROLLED BACK, so staging records are never changed and never used
 * as fixtures. Skipped on the disposable in-process database, where
 * integrity.db.test.ts covers the same ground and more.
 *
 * The concurrency test needs two real connections (PGlite has one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, errorOf, inRolledBackTx, isStaging, openDb, tableHash, type Db } from './harness'
import { ADMIN, EDITOR, backupTables, rpc, seedLedger, seedUsers } from './fixtures'

let db: Db
let db2: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const tag = `ZZ-INT-${Date.now().toString(36).toUpperCase()}`

beforeAll(async () => {
  if (!isStaging) return
  db = await openDb()
  db2 = await openDb()
})
afterAll(async () => {
  await db?.close()
  await db2?.close()
})

describe.skipIf(!isStaging)('inventory integrity on the live staging database (rolled back)', () => {
  it('the migration is present and the registry mirrors every device', async () => {
    const r = await one(`select to_regclass('public.serial_keys') is not null as t, to_regprocedure('public.normalize_serial(text)') is not null as f`)
    expect(r).toEqual({ t: true, f: true })
    const counts = await one<{ keys: number; devices: number }>(
      `select (select count(*) from serial_keys)::int as keys,
              ((select count(*) from serialized_assets) + (select count(*) from active_laptops_np)
               + (select count(*) from monitors) + (select count(*) from other_equipment))::int as devices`,
    )
    expect(counts.keys).toBe(counts.devices)
  })

  it('normalized duplicates are blocked on create and import, across tables; distinct serials are fine', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await seedLedger(db, tag)
      await actAs(db, EDITOR)
      const create = (collection: string, serial: string) =>
        errorOf(db, `select create_asset($1::asset_collection, 'Dell Latitude 5440', 'Laptop', $2)`, [collection, serial])
      expect(await create('serialized_assets', `${tag}-inv-1`.toLowerCase())).toMatch(/already exists/)
      expect(await create('active_laptops_np', `  ${tag}-INV-1 `)).toMatch(/already exists/)
      expect(await create('other_equipment', `${tag}-NP-1`)).toMatch(/already exists/)
      expect(await create('serialized_assets', '  ')).toMatch(/serial number is required/)
      expect(await create('serialized_assets', `${tag}-INV-1-B`)).toBeNull()
      const r = await rpc<Record<string, any>>(db, `commit_asset_import('serialized_assets', 'zz.xlsx', $1::jsonb)`, [
        JSON.stringify([
          { serial: `${tag}-np-1`, name: '', category: '', status: 'available', assigned_to: '', location: '' },
          { serial: `${tag}-MON-1`, name: 'X', category: 'Laptop', status: '', assigned_to: '', location: '' },
        ]),
      ])
      expect(r).toMatchObject({ created: 0, updated: 0, unchanged: 1, rejected: 1 })
      expect(r.issues[0]).toMatchObject({ kind: 'not_applied', field: 'status', current: 'provided', requested: 'available' })
    })
  })

  it('concurrency: a second transaction creating the same normalized serial waits for the first and cannot slip past it', async () => {
    const serial = `${tag}-RACE`
    const insert = (conn: Db, s: string) =>
      conn.query(`insert into monitors (name, category, serial) values ('ZZ Race Monitor', 'Monitor', $1) returning id`, [s])
    await db.exec('begin')
    await db2.exec('begin')
    try {
      await actAsDatabase(db)
      await actAsDatabase(db2)
      await insert(db, serial) // holds the key, uncommitted
      await db2.exec(`set local lock_timeout = '2s'`)
      // db2's pre-check can't see db's uncommitted row, so it reaches the
      // registry insert, where the unique index makes it wait for db.
      await expect(insert(db2, ` ${serial.toLowerCase()} `)).rejects.toThrow(/lock timeout|canceling statement/)
    } finally {
      await db2.exec('rollback')
      await db.exec('rollback')
    }
    expect((await one(`select count(*)::int as n from serial_keys where serial_key = $1`, [serial.toUpperCase()])).n).toBe(0)
  })

  it('restore with verified counts round-trips the live data exactly (rolled back)', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      const tables = await backupTables(db)
      const payload: Record<string, any> = {}
      for (const t of tables) payload[t] = (await one(`select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') as v from ${t} x`)).v
      payload._counts = Object.fromEntries(tables.map((t) => [t, payload[t].length]))
      const before: Record<string, string> = {}
      for (const t of tables) before[t] = await tableHash(db, t)
      await actAs(db, ADMIN)
      const result = await rpc<Record<string, any>>(db, `restore_backup($1::jsonb)`, [JSON.stringify(payload)])
      expect(result.counts).toEqual(payload._counts)
      await actAsDatabase(db)
      for (const t of tables) expect(await tableHash(db, t), t).toBe(before[t])
    })
  })
})
