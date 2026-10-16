/**
 * Offboarding laptop outcome (20260901000024) against the LIVE staging
 * database (npm run staging:test-db). Each test creates its OWN uniquely
 * named record inside a transaction that is always ROLLED BACK — existing
 * (possibly hand-edited) offboarding records are never used or changed.
 * Skipped on the disposable in-process database (offboarding.db.test.ts
 * covers the migration itself there).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, errorOf, inRolledBackTx, isStaging, openDb, tableHash, type Db } from './harness'
import { ADMIN, VIEWER, seedUsers } from './fixtures'

let db: Db
const one = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows[0]
const unique = () => `ZZ-OFFB ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

beforeAll(async () => {
  if (isStaging) db = await openDb()
})
afterAll(async () => {
  await db?.close()
})

describe.skipIf(!isStaging)('offboarding laptop outcome on the live staging database (own records, rolled back)', () => {
  it('a legacy-style record with two outcomes ticked is flagged for review, nothing chosen', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await actAs(db, ADMIN)
      const r = await one(
        `insert into offboarding_checklists (employee_name, created_by, removed_access, laptop_received, laptop_retained)
         values ($1, $2, true, true, true) returning laptop_outcome, outcome_needs_review`,
        [unique(), ADMIN.id],
      )
      expect(r).toEqual({ laptop_outcome: null, outcome_needs_review: true })
    })
  })

  it('choosing outcomes keeps exactly one, syncs the legacy flags, clears the review flag, and touches no equipment', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await actAs(db, ADMIN)
      const { id } = await one(
        `insert into offboarding_checklists (employee_name, created_by, removed_access, laptop_received, laptop_retained)
         values ($1, $2, true, true, true) returning id`,
        [unique(), ADMIN.id],
      )
      await actAsDatabase(db)
      const equipment = [await tableHash(db, 'serialized_assets'), await tableHash(db, 'active_laptops_np'), await tableHash(db, 'equipment_issues')]
      await actAs(db, ADMIN)

      const set = (v: string | null) =>
        one(`update offboarding_checklists set laptop_outcome = $2 where id = $1 returning laptop_outcome, outcome_needs_review, laptop_received, laptop_retained, laptop_decommissioned`, [id, v])
      expect(await set('retained')).toEqual({ laptop_outcome: 'retained', outcome_needs_review: false, laptop_received: false, laptop_retained: true, laptop_decommissioned: false })
      expect(await set('not_applicable')).toEqual({ laptop_outcome: 'not_applicable', outcome_needs_review: false, laptop_received: false, laptop_retained: false, laptop_decommissioned: false })
      expect(await set(null)).toEqual({ laptop_outcome: null, outcome_needs_review: false, laptop_received: false, laptop_retained: false, laptop_decommissioned: false })

      await actAsDatabase(db)
      expect([await tableHash(db, 'serialized_assets'), await tableHash(db, 'active_laptops_np'), await tableHash(db, 'equipment_issues')]).toEqual(equipment)
    })
  })

  it('viewers cannot change an outcome; invalid outcomes are rejected', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await actAs(db, ADMIN)
      const { id } = await one(`insert into offboarding_checklists (employee_name, created_by) values ($1, $2) returning id`, [unique(), ADMIN.id])
      expect(await errorOf(db, `update offboarding_checklists set laptop_outcome = 'lost' where id = $1`, [id])).toMatch(/invalid input value/)
      await actAs(db, VIEWER)
      expect((await db.query(`update offboarding_checklists set laptop_outcome = 'received' where id = $1`, [id])).rowCount).toBe(0)
    })
  })
})
