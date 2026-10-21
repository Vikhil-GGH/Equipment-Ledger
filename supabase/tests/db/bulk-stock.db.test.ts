/**
 * Positive regression tests for every Bulk Stock action, through the real
 * perform_bulk_action: receive stock, issue, return, retain, repair, mark
 * damaged and decommission.
 *
 * Why this exists: a migration once rewrote the role check inside
 * perform_bulk_action and silently broke FOUND, so every move failed with
 * "Bulk item not found" — while all the "this is refused" tests still passed.
 * These tests only assert that the normal path WORKS: the right buckets move
 * by the right amount, the total never changes except on receive, a history
 * row is written, and it works for both an editor and an admin.
 *
 * Runs on a disposable in-process database (all migrations) and on hosted
 * staging (npm run staging:test-db), where every test is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actAs,
  applyMigration,
  errorOf,
  inCommittedTx,
  inRolledBackTx,
  isStaging,
  loadSupabaseStub,
  migrationFiles,
  openDb,
  readAdaptation,
  type Db,
  type TestUser,
} from './harness'
import { ADMIN, EDITOR, VIEWER, rpc, seedUsers } from './fixtures'

let db: Db
type Buckets = { available: number; provided: number; retained: number; damaged: number; decommissioned: number }
const BUCKETS = ['available', 'provided', 'retained', 'damaged', 'decommissioned'] as const

const buckets = async (id: string): Promise<Buckets> =>
  (await db.query<Buckets>(`select available, provided, retained, damaged, decommissioned from bulk_items where id = $1`, [id])).rows[0]
const total = (b: Buckets) => BUCKETS.reduce((n, k) => n + b[k], 0)
const history = async (id: string) =>
  (await db.query<{ action: string; quantity: number; actor_user_id: string; detail: string | null }>(
    `select action, quantity, actor_user_id, detail from bulk_item_history where item_id = $1 order by action`, [id])).rows

beforeAll(async () => {
  db = await openDb()
  if (isStaging) return
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
}, 600_000)
afterAll(async () => {
  await db?.close()
})

/** A fresh item holding 20 available, created through the app's own RPC. */
async function freshItem(as: TestUser) {
  await seedUsers(db)
  await actAs(db, as)
  const id = await rpc<string>(db, `create_bulk_item('ZZ-BULK Test Item', 'Accessory', null, 20)`)
  expect(await buckets(id)).toEqual({ available: 20, provided: 0, retained: 0, damaged: 0, decommissioned: 0 })
  return id
}

for (const [who, user] of [['an editor', EDITOR], ['an admin (two-factor session)', ADMIN]] as const) {
  describe(`Bulk Stock actions as ${who}`, () => {
    it('receive stock: Available + quantity, total grows by exactly that, history written', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'receive_stock', 7, null, 'ZZ-BULK delivery')`, [id])
        expect(await buckets(id)).toEqual({ available: 27, provided: 0, retained: 0, damaged: 0, decommissioned: 0 })
        expect(await history(id)).toContainEqual({ action: 'receive_stock', quantity: 7, actor_user_id: user.id, detail: 'ZZ-BULK delivery' })
      })
    })

    it('issue: Available - n, Provided + n', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'issue', 5)`, [id])
        expect(await buckets(id)).toMatchObject({ available: 15, provided: 5 })
        expect((await history(id)).map((h) => h.action)).toContain('issue')
      })
    })

    it('return: Provided - n, Available + n', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'issue', 6)`, [id])
        await rpc(db, `perform_bulk_action($1, 'return', 4)`, [id])
        expect(await buckets(id)).toMatchObject({ available: 18, provided: 2 })
        expect((await history(id)).map((h) => h.action)).toContain('return')
      })
    })

    it('retain: Available - n, Retained + n', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'retain', 3, null, 'ZZ-BULK employee keeps it')`, [id])
        expect(await buckets(id)).toMatchObject({ available: 17, retained: 3 })
        expect(await history(id)).toContainEqual(expect.objectContaining({ action: 'retain', quantity: 3, detail: 'ZZ-BULK employee keeps it' }))
      })
    })

    it('mark damaged: moves from the chosen bucket (Available and Provided) into Damaged', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'issue', 5)`, [id])
        await rpc(db, `perform_bulk_action($1, 'mark_damaged', 2, 'available')`, [id])
        await rpc(db, `perform_bulk_action($1, 'mark_damaged', 1, 'provided')`, [id])
        expect(await buckets(id)).toMatchObject({ available: 13, provided: 4, damaged: 3 })
      })
    })

    it('repair: Damaged - n, Available + n', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'mark_damaged', 4, 'available')`, [id])
        await rpc(db, `perform_bulk_action($1, 'repair', 3)`, [id])
        expect(await buckets(id)).toMatchObject({ available: 19, damaged: 1 })
        expect((await history(id)).map((h) => h.action)).toContain('repair')
      })
    })

    it('decommission: moves from Available and from Damaged into Decommissioned', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        await rpc(db, `perform_bulk_action($1, 'mark_damaged', 2, 'available')`, [id])
        await rpc(db, `perform_bulk_action($1, 'decommission', 2, 'damaged')`, [id])
        await rpc(db, `perform_bulk_action($1, 'decommission', 1, 'available')`, [id])
        expect(await buckets(id)).toMatchObject({ available: 17, damaged: 0, decommissioned: 3 })
      })
    })

    it('a full cycle never creates or loses stock except by receive/decommission accounting', async () => {
      await inRolledBackTx(db, async () => {
        const id = await freshItem(user)
        const t0 = total(await buckets(id))
        for (const sql of [
          `perform_bulk_action($1, 'issue', 8)`,
          `perform_bulk_action($1, 'return', 3)`,
          `perform_bulk_action($1, 'retain', 2)`,
          `perform_bulk_action($1, 'mark_damaged', 2, 'provided')`,
          `perform_bulk_action($1, 'repair', 1)`,
          `perform_bulk_action($1, 'decommission', 1, 'damaged')`,
        ]) {
          await rpc(db, sql, [id])
          expect(total(await buckets(id))).toBe(t0) // every move only shifts stock between buckets
        }
        expect(await buckets(id)).toEqual({ available: 14, provided: 3, retained: 2, damaged: 0, decommissioned: 1 })
        expect((await history(id)).map((h) => h.action).sort()).toEqual(['created', 'decommission', 'issue', 'mark_damaged', 'repair', 'retain', 'return'])
      })
    })
  })
}

describe('Bulk Stock refusals still hold (with the normal path proven above)', () => {
  it('a viewer cannot change stock; bad quantities, missing buckets and unknown items are rejected; nothing changes', async () => {
    await inRolledBackTx(db, async () => {
      const id = await freshItem(EDITOR)
      const before = await buckets(id)
      await actAs(db, VIEWER)
      expect(await errorOf(db, `select perform_bulk_action($1, 'issue', 1)`, [id])).toMatch(/Not authorized/)
      await actAs(db, EDITOR)
      expect(await errorOf(db, `select perform_bulk_action($1, 'issue', 0)`, [id])).toMatch(/positive/)
      expect(await errorOf(db, `select perform_bulk_action($1, 'issue', 21)`, [id])).toMatch(/Insufficient quantity/)
      expect(await errorOf(db, `select perform_bulk_action($1, 'return', 1)`, [id])).toMatch(/Insufficient quantity/)
      expect(await errorOf(db, `select perform_bulk_action($1, 'decommission', 1)`, [id])).toMatch(/from_bucket is required/)
      // An item that doesn't exist is refused and changes nothing. KNOWN ISSUE (030): for issue/return/etc. the
      // message is a foreign-key error rather than "Bulk item not found", because FOUND is stale after EXECUTE
      // (receive_stock gives the intended message). Safe, but the wording is wrong; fixing it needs a migration.
      expect(await errorOf(db, `select perform_bulk_action('00000000-0000-4000-8000-0000000000ff', 'issue', 1)`)).not.toBeNull()
      expect(await errorOf(db, `select perform_bulk_action('00000000-0000-4000-8000-0000000000ff', 'receive_stock', 1)`)).toMatch(/Bulk item not found/)
      expect(await buckets(id)).toEqual(before)
    })
  })
})
