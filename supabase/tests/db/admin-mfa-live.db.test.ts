/**
 * 20260901000031 against the LIVE staging database once it has it
 * (npm run staging:test-db). Temporary users only, inside transactions that
 * are always ROLLED BACK; existing accounts are never changed. Skipped
 * locally (admin-mfa.db.test.ts covers it) and on staging before 031.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, errorOf, inRolledBackTx, isStaging, openDb, type Db } from './harness'
import { ADMIN, EDITOR, VIEWER, rpc, seedUsers } from './fixtures'

let db: Db
let has031 = false
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]

beforeAll(async () => {
  if (!isStaging) return
  db = await openDb()
  has031 = !!(await one<{ e: boolean }>(`select to_regprocedure('public.session_role()') is not null as e`)).e
})
afterAll(async () => {
  await db?.close()
})

describe.skipIf(!isStaging)('031 on the live staging database (rolled back)', () => {
  it('password-only admin: only their own profile; two-factor admin: full access; editor unchanged; no admin without an authenticator', async () => {
    if (!has031) return // not applied yet
    await inRolledBackTx(db, async () => {
      await seedUsers(db) // the temporary admin gets a verified factor row (rolled back)
      const realRows = (await one<{ n: number }>(`select count(*)::int as n from serialized_assets`)).n
      await actAs(db, ADMIN, { aal: 'aal1' })
      expect((await db.query(`select id from profiles`)).rows).toEqual([{ id: ADMIN.id }])
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets`)).n).toBe(0)
      expect(await errorOf(db, `select create_asset('monitors', 'ZZ', 'Monitor', 'ZZ-M31-LIVE')`)).toMatch(/Not authorized/)
      await actAs(db, ADMIN, { aal: 'aal2' })
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets`)).n).toBe(realRows)
      await actAs(db, EDITOR, { aal: 'aal1' })
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets`)).n).toBe(realRows)
      expect(await rpc(db, `my_role()`)).toBe('editor')
      // Editor and scanner writes are unchanged (rolled back with everything else).
      expect(await rpc(db, `create_asset('monitors', 'ZZ-M31 Editor', 'Monitor', 'ZZ-M31-LIVE-ED')`)).toBeTruthy()
      await actAsDatabase(db)
      await db.query(`insert into auth.users (id, email, is_anonymous) values ('00000000-0000-4000-8000-00000000d0aa', 'zz-m31-scanner@example.invalid', false)`)
      await db.query(`update profiles set role = 'scanner' where id = '00000000-0000-4000-8000-00000000d0aa'`)
      const SCANNER = { id: '00000000-0000-4000-8000-00000000d0aa', email: 'zz-m31-scanner@example.invalid', anonymous: false }
      await actAs(db, SCANNER, { aal: 'aal1' })
      const scanned = await rpc<string>(db, `create_asset('monitors', 'ZZ-M31 Scanner', 'Monitor', 'ZZ-M31-LIVE-SC')`)
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', 'ZZ Person')`, [scanned])
      expect(await errorOf(db, `select create_bulk_item('ZZ-M31 Item', 'Cable', null, 1)`)).toMatch(/Not authorized/)
      await actAs(db, VIEWER, { aal: 'aal1' })
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets`)).n).toBe(realRows)
      expect(await errorOf(db, `select create_asset('monitors', 'ZZ', 'Monitor', 'ZZ-M31-LIVE-V')`)).toMatch(/Not authorized/)
      await actAs(db, ADMIN, { aal: 'aal2' })
      expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [VIEWER.id])).toMatch(/two-factor/)
      await actAsDatabase(db)
      expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [VIEWER.id])).toMatch(/two-factor/)
    })
  })
})
