/**
 * 20260901000030 against a LIVE database that already has it — the hosted
 * staging project (npm run staging:test-db). Uses its own temporary users
 * inside transactions that are always ROLLED BACK; existing accounts are
 * never revoked, restored or otherwise touched. Skipped locally, where
 * access.db.test.ts covers the same ground and more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, errorOf, inRolledBackTx, isStaging, openDb, type Db } from './harness'
import { ADMIN, EDITOR, rpc, seedUsers } from './fixtures'

let db: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]

beforeAll(async () => {
  if (isStaging) db = await openDb()
})
afterAll(async () => {
  await db?.close()
})

describe.skipIf(!isStaging)('030 access controls on the live staging database (rolled back)', () => {
  it('the migration is present', async () => {
    expect(await one(`select to_regclass('public.profile_access_history') is not null as t, to_regprocedure('public.revoke_user_access(uuid, text)') is not null as f`)).toEqual({ t: true, f: true })
  })

  it('Import History cannot be written directly; revoke/restore work on a temporary user; a password-only admin has no admin powers', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await actAs(db, EDITOR)
      expect(await errorOf(db, `insert into import_events (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored) values ($1, 'monitors', 'zz-fake.xlsx', 1, 0, 0)`, [EDITOR.id])).toMatch(/permission denied|row-level security/)
      await actAs(db, ADMIN)
      await rpc(db, `revoke_user_access($1, 'ZZ live test')`, [EDITOR.id])
      expect(await one(`select role, access_revoked_at is not null as revoked, role_before_revoke from profiles where id = $1`, [EDITOR.id])).toEqual({ role: 'viewer', revoked: true, role_before_revoke: 'editor' })
      await actAs(db, EDITOR)
      expect((await one<{ n: number }>(`select count(*)::int as n from serialized_assets`)).n).toBe(0)
      // Nothing readable anywhere on the real staging data (an aggregate view's single all-zero row counts as nothing).
      const rels = (await db.query<{ name: string }>(`select c.relname as name from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r', 'v') order by 1`)).rows
      const leaks: string[] = []
      for (const r of rels) {
        await db.query('savepoint p')
        const res = await db.query<{ n: number }>(`select count(*)::int as n from ${r.name} r where exists (select 1 from json_each_text(row_to_json(r)) j where j.value is not null and j.value <> '0')`).then((x) => x.rows[0].n, () => -1)
        await db.query(res === -1 ? 'rollback to savepoint p' : 'release savepoint p')
        if (res > 0) leaks.push(`${r.name}=${res}`)
      }
      expect(leaks).toEqual([])
      expect((await db.query(`update profiles set full_name = 'ZZ changed' where id = $1`, [EDITOR.id])).rowCount).toBe(0)
      await actAs(db, ADMIN)
      await rpc(db, `restore_user_access($1)`, [EDITOR.id])
      expect((await one(`select role from profiles where id = $1`, [EDITOR.id])).role).toBe('editor')
      await actAs(db, ADMIN, { aal: 'aal1' })
      expect((await one<{ a: boolean }>(`select is_admin() as a`)).a).toBe(false)
      expect(await errorOf(db, `select revoke_user_access($1)`, [EDITOR.id])).toMatch(/two-factor/)
      await actAsDatabase(db)
    })
  })
})
