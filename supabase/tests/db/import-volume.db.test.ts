/**
 * Excel imports at realistic volume, with synthetic data on a disposable database (every test rolled back):
 * thousands of rows, duplicates, existing records in either laptop table, repeat uploads, and speed.
 *
 * The time limits are generous guard rails (a slow machine must not fail them); the measured times are logged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actAs, applyMigration, inCommittedTx, inRolledBackTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, type Db,
} from './harness'
import { ADMIN, rpc, seedUsers } from './fixtures'

let db: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const timed = async <T,>(label: string, fn: () => Promise<T>, limitMs: number) => {
  const t0 = Date.now()
  const r = await fn()
  const ms = Date.now() - t0
  console.log(`[import-volume] ${label}: ${ms} ms`)
  expect(ms, `${label} took ${ms} ms`).toBeLessThan(limitMs)
  return r
}
const assetRows = (n: number, prefix = 'VOL', over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({ serial: `${prefix}-${i}`, name: `Dell ${i % 7}`, category: 'Laptop', status: '', assigned_to: '', location: 'Shelf', ...over }))
const importAssets = (collection: string, rows: unknown[], file = 'vol.xlsx') =>
  rpc<{ created: number; updated: number; unchanged: number; rejected: number; issues: unknown[] }>(db, `commit_asset_import($1::asset_collection, $2, $3::jsonb)`, [collection, file, JSON.stringify(rows)])

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await inCommittedTx(db, () => seedUsers(db))
}, 600_000)
afterAll(async () => {
  await db?.close()
})

describe.skipIf(isStaging)('Excel import at volume', () => {
  it('3,000 laptops import completely; a repeat of the same file changes nothing', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const rows = assetRows(3000)
      const first = await timed('import 3,000 laptops', () => importAssets('serialized_assets', rows), 60_000)
      expect(first).toMatchObject({ created: 3000, updated: 0, rejected: 0, issues: [] })
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets where serial like 'VOL-%'`)).n).toBe(3000)
      const again = await timed('repeat the same 3,000', () => importAssets('serialized_assets', rows), 60_000)
      expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3000, rejected: 0 })
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets where serial like 'VOL-%'`)).n).toBe(3000)
    })
  })

  it('serials that differ only by case or spaces are the same device; an Inventory import also sees laptops already in Active Laptops', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await importAssets('serialized_assets', assetRows(5))
      const r = await importAssets('serialized_assets', assetRows(5).map((x) => ({ ...x, serial: `  ${x.serial.toLowerCase()} ` })))
      expect(r).toMatchObject({ created: 0 })
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets where serial ilike 'vol-%'`)).n).toBe(5)
      // A laptop that lives in Active Laptops (assigned) is "existing" for an Inventory import: no second copy.
      const inv = (await one<{ id: string }>(`select id from serialized_assets where serial = 'VOL-1'`)).id
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'provide', 'Zz Volume Person')`, [inv])
      const again = await importAssets('serialized_assets', assetRows(5))
      expect(again).toMatchObject({ created: 0 })
      expect((await one<{ n: number }>(`select (select count(*) from serialized_assets where serial = 'VOL-1') + (select count(*) from active_laptops_np where serial = 'VOL-1') as n`)).n).toBe(1)
    })
  })

  it('an import never changes status or assignee of a device already there', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await importAssets('serialized_assets', assetRows(3))
      const id = (await one<{ id: string }>(`select id from serialized_assets where serial = 'VOL-0'`)).id
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'provide', 'Zz Keeps It')`, [id])
      await importAssets('serialized_assets', assetRows(3, 'VOL', { status: 'available', assigned_to: 'Somebody Else' }))
      expect(await one(`select status::text as status, assigned_to from active_laptops_np where id = $1`, [id])).toEqual({ status: 'provided', assigned_to: 'Zz Keeps It' })
    })
  })

  it('1,500 Bulk Stock items import; repeating the file is blocked (nothing is added twice)', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const rows = Array.from({ length: 1500 }, (_, i) => ({ name: `Bulk ${i}`, category: 'Cable', location: '', quantity: 3 }))
      const first = await timed('import 1,500 bulk items', () => rpc<any>(db, `commit_bulk_import('bulk.xlsx', $1::jsonb, false)`, [JSON.stringify(rows)]), 60_000)
      expect(first).toMatchObject({ created: 1500, updated: 0 })
      const repeat = await rpc<any>(db, `commit_bulk_import('bulk.xlsx', $1::jsonb, false)`, [JSON.stringify(rows)])
      expect(repeat).toMatchObject({ created: 0, updated: 0 })
      expect(repeat.duplicate_of).toBeTruthy()
      expect(Number((await one<{ n: number }>(`select sum(available)::int as n from bulk_items where name like 'Bulk %'`)).n)).toBe(4500)
      // Confirmed as a genuine second delivery: quantities are added.
      const second = await rpc<any>(db, `commit_bulk_import('bulk.xlsx', $1::jsonb, true)`, [JSON.stringify(rows)])
      expect(second).toMatchObject({ created: 0, updated: 1500 })
      expect(Number((await one<{ n: number }>(`select sum(available)::int as n from bulk_items where name like 'Bulk %'`)).n)).toBe(9000)
    })
  })

  it('every import is logged once in Import History, with the right counts', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await importAssets('serialized_assets', assetRows(40), 'log-test.xlsx')
      const log = await db.query<{ rows_created: number; target_collection: string }>(`select rows_created, target_collection from import_events where filename = 'log-test.xlsx'`)
      expect(log.rows).toEqual([{ rows_created: 40, target_collection: 'serialized_assets' }])
    })
  })
})
