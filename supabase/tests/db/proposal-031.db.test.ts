/**
 * Tests the PROPOSED 031 (supabase/proposals/031_admin_mfa_everywhere.sql,
 * not a migration): two-factor for ALL admin access. PGlite only; every test
 * is rolled back.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, applyMigration, errorOf, inCommittedTx, inRolledBackTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, tableHash, type Db, type TestUser } from './harness'
import { ADMIN, EDITOR, VIEWER, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

const PROPOSALS = join(__dirname, '..', '..', 'proposals')
const INLINE = ['commit_asset_import', 'commit_bulk_import', 'create_asset', 'create_bulk_item', 'onboarding_assign_device', 'perform_bulk_action', 'perform_lifecycle_action', 'perform_swap']
const LINE = 'select role into v_role from profiles where id = v_actor;'
const NEW_ADMIN: TestUser = { id: '00000000-0000-4000-8000-00000000d001', email: 'new-admin@example.invalid', anonymous: false }
let db: Db
let ids: LedgerIds
let defs030: Record<string, string> = {}

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
const norm = (s: string) => s.replace(/\r\n/g, '\n').trim()
const defsOf = async (names: string[]) => {
  const out: Record<string, string> = {}
  for (const name of names) out[name] = norm((await one<{ d: string }>(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).d)
  return out
}
const relations = async () => (await db.query<{ name: string; kind: string }>(`select c.relname as name, c.relkind as kind from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r', 'v') order by 1`)).rows
const everything = async () => {
  const h: Record<string, string> = {}
  for (const r of await relations()) if (r.kind === 'r') h[r.name] = await tableHash(db, r.name)
  return h
}
/** Rows the current session can see, per relation (an aggregate view's all-zero row counts as nothing). */
const visible = async () => {
  const seen: Record<string, number> = {}
  for (const r of await relations()) {
    await db.query('savepoint v')
    const c = await db.query<{ n: number }>(`select count(*)::int as n from ${r.name} r where exists (select 1 from json_each_text(row_to_json(r)) j where j.value is not null and j.value <> '0')`).then((x) => x.rows[0].n, () => -1)
    await db.query(c === -1 ? 'rollback to savepoint v' : 'release savepoint v')
    if (c > 0) seen[r.name] = c
  }
  return seen
}
const addFactor = (userId: string, status = 'verified') => db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', $2)`, [userId, status])

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  // Supabase Auth's factor table (only the columns 031 reads).
  await db.exec(`create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, factor_type text not null, status text not null)`)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    const l = await seedLedger(db, 'P31')
    await actAsDatabase(db)
    await addFactor(ADMIN.id)
    return l
  })
  defs030 = await defsOf([...INLINE, 'is_known_user', 'is_editor_or_admin', 'is_admin'])
  await inCommittedTx(db, () => db.exec(readFileSync(join(PROPOSALS, '031_admin_mfa_everywhere.sql'), 'utf8')))
}, 300_000)
afterAll(async () => {
  await db?.close()
})
const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('proposed 031: two-factor for all admin access', () => {
  it('each of the 8 functions differs from 030 by exactly the one role-read line', async () => {
    const now = await defsOf(INLINE)
    for (const f of INLINE) expect(now[f], f).toBe(defs030[f].replace(LINE, 'v_role := session_role(); -- 031: null for an admin without a two-factor session'))
    for (const f of INLINE) expect(now[f], f).not.toMatch(/\brole\b[^;]*\bfrom\s+profiles/i)
  })

  it('an admin WITHOUT a two-factor session sees only their own profile and changes nothing', tx(async () => {
    await actAsDatabase(db)
    const before = await everything()
    const fns = (await db.query<{ sig: string; args: string }>(
      `select p.oid::regprocedure::text as sig, coalesce((select string_agg('null::' || format_type(t, null), ', ' order by o) from unnest(p.proargtypes) with ordinality as a(t, o)), '') as args
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'public' and p.prorettype <> 'trigger'::regtype and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`)).rows
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect(await visible()).toEqual({ profiles: 1 })
    expect(await one(`select session_role() as r, is_known_user() as k, is_editor_or_admin() as e, is_admin() as a`)).toEqual({ r: null, k: false, e: false, a: false })
    for (const f of fns) await errorOf(db, `select ${f.sig.split('(')[0]}(${f.args})`)
    const writes = [
      `select create_asset('monitors', 'Dell', 'Monitor', 'P31-NEW')`,
      `select perform_lifecycle_action('monitors', '${ids.monitor}', 'mark_damaged')`,
      `select perform_bulk_action('${ids.bulkItem}', 'receive_stock', 5)`,
      `select create_bulk_item('P31 Item', 'Cable', null, 3)`,
      `select commit_asset_import('monitors', 'p.xlsx', '[{"serial":"P31-IMP","name":"A","category":"B","status":"","assigned_to":"","location":""}]'::jsonb)`,
      `select commit_bulk_import('p.xlsx', '[{"name":"P31 B","category":"C","quantity":1}]'::jsonb)`,
      `select commit_employee_import('p.xlsx', '[{"row":2,"action":"create","fields":{"first_name":"A","last_name":"B"},"status":"active"}]'::jsonb)`,
      `select create_employee('Someone')`,
      `select onboarding_assign_device('${ids.onboarding}', 'P31-INV-2')`,
      `select revoke_user_access('${VIEWER.id}')`,
      `update onboarding_checklists set identity_created = true`,
      `insert into onboarding_checklists (employee_name, created_by) values ('x', '${ADMIN.id}')`,
      `update profiles set role = 'editor' where id = '${VIEWER.id}'`,
      `update profiles set full_name = 'changed' where id = '${ADMIN.id}'`,
    ]
    const succeeded: string[] = []
    for (const sql of writes) {
      await db.query('savepoint w')
      const r = await db.query(sql).then((x) => x, () => null)
      await db.query(r ? 'release savepoint w' : 'rollback to savepoint w')
      if (r && (/^select/.test(sql) || r.rowCount > 0)) succeeded.push(sql)
    }
    expect(succeeded).toEqual([])
    await actAsDatabase(db)
    expect(await everything()).toEqual(before)
  }), 120_000)

  it('the same admin WITH two-factor has full admin and editor powers', tx(async () => {
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect(await n(`select count(*) as n from employees`)).toBeGreaterThan(0)
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'P31-AAL2')`)).toBeTruthy()
    expect((await db.query(`update profiles set role = 'editor' where id = $1`, [VIEWER.id])).rowCount).toBe(1)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await rpc(db, `restore_user_access($1)`, [EDITOR.id])
  }))

  it('editors and viewers are unaffected (no two-factor needed)', tx(async () => {
    await actAs(db, EDITOR, { aal: 'aal1' })
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'P31-ED')`)).toBeTruthy()
    expect(await rpc(db, `save_employee(null, '{"first_name":"Ed","last_name":"Itor"}'::jsonb)`)).toBeTruthy()
    expect((await db.query(`insert into onboarding_checklists (employee_name, created_by) values ('P31', $1)`, [EDITOR.id])).rowCount).toBe(1)
    await actAs(db, VIEWER, { aal: 'aal1' })
    expect(await n(`select count(*) as n from serialized_assets`)).toBeGreaterThan(0)
    expect(await errorOf(db, `select create_asset('monitors', 'Dell', 'Monitor', 'P31-V')`)).toMatch(/Not authorized/)
  }))

  it('a revoked account still has no access', tx(async () => {
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await actAs(db, EDITOR, { aal: 'aal2' })
    expect(await visible()).toEqual({})
  }))

  it('promotion to admin through the app needs a verified authenticator; a direct database connection can still do it', tx(async () => {
    await actAsDatabase(db)
    await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false)`, [NEW_ADMIN.id, NEW_ADMIN.email])
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [NEW_ADMIN.id])).toMatch(/two-factor/)
    await actAsDatabase(db)
    await addFactor(NEW_ADMIN.id, 'unverified')
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [NEW_ADMIN.id])).toMatch(/two-factor/)
    await actAsDatabase(db)
    await addFactor(NEW_ADMIN.id, 'verified')
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect((await db.query(`update profiles set role = 'admin' where id = $1`, [NEW_ADMIN.id])).rowCount).toBe(1)
    await actAsDatabase(db)
    await db.query(`update profiles set role = 'editor' where id = $1`, [NEW_ADMIN.id])
    await db.query(`delete from auth.mfa_factors where user_id = $1`, [NEW_ADMIN.id])
    expect((await db.query(`update profiles set role = 'admin' where id = $1`, [NEW_ADMIN.id])).rowCount).toBe(1) // bootstrap / recovery
  }))

  it('the rollback restores 030 exactly (definitions, and editor-level access for a password-only admin)', tx(async () => {
    await db.exec(readFileSync(join(PROPOSALS, '031_down.sql'), 'utf8'))
    expect(await defsOf(Object.keys(defs030))).toEqual(defs030)
    expect(await one(`select to_regprocedure('public.session_role()') is null as gone, (select count(*)::int from pg_policies where policyname = 'profiles_select_self') as p`)).toEqual({ gone: true, p: 0 })
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'P31-DOWN')`)).toBeTruthy()
    expect(await errorOf(db, `select revoke_user_access($1)`, [VIEWER.id])).toMatch(/two-factor/)
  }))
})
