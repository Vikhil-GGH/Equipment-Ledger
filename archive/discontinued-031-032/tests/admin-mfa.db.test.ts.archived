/**
 * 20260901000031_admin_mfa_everywhere.sql on a disposable database (PGlite):
 * two-factor (aal2) for ALL administrator access. Builds the database at 030,
 * records the 030 definitions and behaviour, applies 031 from the migrations
 * folder, then tests. Every test runs in a transaction that is rolled back.
 * (Supabase Auth behaviour — enrolling, factor rules, sign-in — is checked
 * on staging with synthetic accounts; here the JWT "aal" claim and
 * auth.mfa_factors stand in for it.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, applyMigration, errorOf, inCommittedTx, inRolledBackTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, tableHash, type Db, type TestUser } from './harness'
import { ADMIN, EDITOR, VIEWER, addVerifiedFactor, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

const M031 = '20260901000031_admin_mfa_everywhere.sql'
const INLINE = ['commit_asset_import', 'commit_bulk_import', 'create_asset', 'create_bulk_item', 'onboarding_assign_device', 'perform_bulk_action', 'perform_lifecycle_action', 'perform_swap']
const LINE = 'select role into v_role from profiles where id = v_actor;'
const SCANNER: TestUser = { id: '00000000-0000-4000-8000-00000000d002', email: 'scanner@example.invalid', anonymous: false }
const OLD_ADMIN: TestUser = { id: '00000000-0000-4000-8000-00000000d003', email: 'admin-before-031@example.invalid', anonymous: false } // admin with NO factor, made before 031
const NEW_USER: TestUser = { id: '00000000-0000-4000-8000-00000000d001', email: 'new-admin@example.invalid', anonymous: false }
let db: Db
let ids: LedgerIds
let defs030: Record<string, string> = {}
let aal1AdminCouldWriteAt030 = false

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
const addUser = async (u: TestUser, role: string) => {
  await actAsDatabase(db)
  await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false) on conflict do nothing`, [u.id, u.email])
  await db.query(`update profiles set role = $2 where id = $1`, [u.id, role])
}

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M031) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    await addUser(SCANNER, 'scanner')
    await addUser(OLD_ADMIN, 'admin') // possible at 030: no authenticator needed
    const l = await seedLedger(db, 'M31')
    await actAsDatabase(db)
    await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [ADMIN.id])
    return l
  })
  defs030 = await defsOf([...INLINE, 'is_known_user', 'is_editor_or_admin', 'is_admin'])
  // The "existing session": a password-only admin's claims, used before and after 031.
  await inRolledBackTx(db, async () => {
    await actAs(db, ADMIN, { aal: 'aal1' })
    aal1AdminCouldWriteAt030 = !!(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-AT-030')`))
  })
  await applyMigration(db, M031)
}, 300_000)
afterAll(async () => {
  await db?.close()
})
const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('031: the effective-role policy is enforced everywhere', () => {
  it('each of the 8 functions differs from 030 by exactly the one role-read line, and none reads the raw role any more', async () => {
    const now = await defsOf(INLINE)
    for (const f of INLINE) expect(now[f], f).toBe(defs030[f].replace(LINE, 'select session_role() into v_role; -- 031: null for an admin without a two-factor session'))
    const readers = (await db.query<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'public' and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute')
        and pg_get_functiondef(p.oid) ~* 'role[^;]*from\\s+(public\\.)?profiles' order by 1`)).rows.map((r) => r.proname)
    // session_role (the decision point), my_role (reports; grants nothing), revoke_user_access (counts other admins).
    expect(readers).toEqual(['my_role', 'revoke_user_access', 'session_role'])
  })
})

describe.skipIf(isStaging)('031: an admin without a two-factor session', () => {
  it('a session that worked before 031 (password-only admin) loses business-data access on its next request', tx(async () => {
    expect(aal1AdminCouldWriteAt030).toBe(true)
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect(await errorOf(db, `select create_asset('monitors', 'Dell', 'Monitor', 'M31-AFTER')`)).toMatch(/Not authorized/)
    expect(await n(`select count(*) as n from employees`)).toBe(0)
  }))

  it('gets only what completing or recovering two-factor needs: their own profile, and functions that grant nothing', tx(async () => {
    for (const admin of [ADMIN, OLD_ADMIN]) { // with a factor (must verify) and without one (must enrol)
      await actAs(db, admin, { aal: 'aal1' })
      expect(await visible(), admin.email!).toEqual({ profiles: 1 })
      expect((await one(`select id from profiles`)).id).toBe(admin.id)
      expect(await one(`select my_role() as stored, current_aal() as aal, session_role() as effective, is_known_user() as k, is_editor_or_admin() as e, is_admin() as a`))
        .toEqual({ stored: 'admin', aal: 'aal1', effective: null, k: false, e: false, a: false })
      expect((await db.query(`update profiles set full_name = 'x' where id = $1`, [admin.id])).rowCount).toBe(0)
    }
  }))

  it('changes nothing anywhere: every callable function (empty arguments) and realistic writes are refused', tx(async () => {
    await actAsDatabase(db)
    const before = await everything()
    const fns = (await db.query<{ sig: string; args: string }>(
      `select p.oid::regprocedure::text as sig, coalesce((select string_agg('null::' || format_type(t, null), ', ' order by o) from unnest(p.proargtypes) with ordinality as a(t, o)), '') as args
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'public' and p.prorettype <> 'trigger'::regtype and p.prokind = 'f' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`)).rows
    await actAs(db, ADMIN, { aal: 'aal1' })
    for (const f of fns) await errorOf(db, `select ${f.sig.split('(')[0]}(${f.args})`)
    const writes = [
      `select create_asset('monitors', 'Dell', 'Monitor', 'M31-NEW')`,
      `select perform_lifecycle_action('monitors', '${ids.monitor}', 'mark_damaged')`,
      `select perform_swap('active_laptops_np', '${ids.npLaptop}', '${ids.spareInventoryLaptop}', 'test')`,
      `select perform_bulk_action('${ids.bulkItem}', 'receive_stock', 5)`,
      `select create_bulk_item('M31 Item', 'Cable', null, 3)`,
      `select commit_asset_import('monitors', 'm.xlsx', '[{"serial":"M31-IMP","name":"A","category":"B","status":"","assigned_to":"","location":""}]'::jsonb)`,
      `select commit_bulk_import('m.xlsx', '[{"name":"M31 B","category":"C","quantity":1}]'::jsonb)`,
      `select commit_employee_import('m.xlsx', '[{"row":2,"action":"create","fields":{"first_name":"A","last_name":"B"},"status":"active"}]'::jsonb)`,
      `select save_employee(null, '{"first_name":"A","last_name":"B"}'::jsonb)`,
      `select create_employee('Someone')`,
      `select onboarding_assign_device('${ids.onboarding}', 'M31-INV-2')`,
      `select revoke_user_access('${VIEWER.id}')`,
      `select restore_backup('{}'::jsonb)`,
      `update onboarding_checklists set identity_created = true`,
      `update offboarding_checklists set removed_access = true`,
      `insert into onboarding_checklists (employee_name, created_by) values ('x', '${ADMIN.id}')`,
      `update profiles set role = 'editor' where id = '${VIEWER.id}'`,
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

  it('with two-factor (aal2) the same admin has full access and admin powers', tx(async () => {
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect(await n(`select count(*) as n from employees`)).toBeGreaterThan(0)
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-AAL2')`)).toBeTruthy()
    expect((await db.query(`update profiles set role = 'editor' where id = $1`, [VIEWER.id])).rowCount).toBe(1)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await rpc(db, `restore_user_access($1)`, [EDITOR.id])
  }))
})

describe.skipIf(isStaging)('031: every rewritten function still works for the roles allowed to use it', () => {
  // Regression: perform_bulk_action reads FOUND after an EXECUTE, which relied on the
  // replaced line setting it. Each of the 8 functions must SUCCEED, not just refuse.
  for (const [who, aal] of [[EDITOR, 'aal1'], [ADMIN, 'aal2']] as const) {
    it(`${who.email} (${aal}): all 8 functions complete their normal work`, tx(async () => {
      await actAs(db, who, { aal })
      const mon = await rpc<string>(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-OK-${aal}')`)
      await rpc(db, `perform_lifecycle_action('monitors', $1, 'mark_damaged')`, [mon])
      await rpc(db, `perform_bulk_action($1, 'issue', 2)`, [ids.bulkItem])
      await rpc(db, `perform_bulk_action($1, 'return', 1)`, [ids.bulkItem])
      await rpc(db, `perform_bulk_action($1, 'mark_damaged', 1, 'available')`, [ids.bulkItem])
      await rpc(db, `perform_bulk_action($1, 'repair', 1)`, [ids.bulkItem])
      await rpc(db, `perform_bulk_action($1, 'receive_stock', 3)`, [ids.bulkItem])
      expect(await one(`select available, provided, damaged from bulk_items where id = $1`, [ids.bulkItem])).toEqual({ available: 22, provided: 1, damaged: 0 })
      expect(await rpc(db, `create_bulk_item($1, 'Cable', null, 3)`, [`M31 OK ${aal}`])).toBeTruthy()
      expect(await rpc(db, `commit_asset_import('monitors', 'ok.xlsx', $1::jsonb)`, [JSON.stringify([{ serial: `M31-IMP-${aal}`, name: 'A', category: 'Monitor', status: '', assigned_to: '', location: '' }])])).toBeTruthy()
      expect(await rpc(db, `commit_bulk_import('ok.xlsx', $1::jsonb)`, [JSON.stringify([{ name: `M31 Bulk ${aal}`, category: 'Cable', quantity: 2 }])])).toBeTruthy()
      await rpc(db, `perform_swap('active_laptops_np', $1, $2, 'broken hinge')`, [ids.npLaptop, ids.spareInventoryLaptop])
      await rpc(db, `onboarding_assign_device($1, $2, 'Dell Latitude 5440', 'Laptop')`, [ids.onboarding, `M31-ONB-${aal}`])
    }))
  }
})

describe.skipIf(isStaging)('031: editor, scanner and viewer permissions are unchanged', () => {
  it('editor (password only) keeps every editor operation', tx(async () => {
    await actAs(db, EDITOR, { aal: 'aal1' })
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-ED')`)).toBeTruthy()
    expect(await rpc(db, `save_employee(null, '{"first_name":"Ed","last_name":"Itor"}'::jsonb)`)).toBeTruthy()
    expect(await rpc(db, `create_bulk_item('M31 Ed Item', 'Cable', null, 3)`)).toBeTruthy()
    expect((await db.query(`insert into onboarding_checklists (employee_name, created_by) values ('M31', $1)`, [EDITOR.id])).rowCount).toBe(1)
    expect(await errorOf(db, `select revoke_user_access($1)`, [VIEWER.id])).toMatch(/Only an admin/)
  }))

  it('scanner keeps add-device and provide/collect, and nothing else', tx(async () => {
    await actAs(db, SCANNER, { aal: 'aal1' })
    const id = await rpc<string>(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-SC')`)
    expect(id).toBeTruthy()
    await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', 'Someone')`, [id])
    expect(await errorOf(db, `select perform_lifecycle_action('monitors', $1, 'mark_damaged')`, [id])).toMatch(/./)
    expect(await errorOf(db, `select create_bulk_item('M31 Sc', 'Cable', null, 3)`)).toMatch(/Not authorized/)
  }))

  it('viewer reads and cannot write; a revoked account still has nothing', tx(async () => {
    await actAs(db, VIEWER, { aal: 'aal1' })
    expect(await n(`select count(*) as n from serialized_assets`)).toBeGreaterThan(0)
    expect(await errorOf(db, `select create_asset('monitors', 'Dell', 'Monitor', 'M31-V')`)).toMatch(/Not authorized/)
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await actAs(db, EDITOR, { aal: 'aal2' })
    expect(await visible()).toEqual({})
  }))
})

describe.skipIf(isStaging)('031: nobody becomes an admin without a verified authenticator — no bypass', () => {
  it('through the app (admin with two-factor) or a direct database connection, by update or insert', tx(async () => {
    await actAsDatabase(db)
    await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false)`, [NEW_USER.id, NEW_USER.email])
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [NEW_USER.id])).toMatch(/two-factor/)
    await actAsDatabase(db)
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [NEW_USER.id])).toMatch(/two-factor/)
    expect(await errorOf(db, `insert into profiles (id, email, role) values ($1, 'x@example.invalid', 'admin')`, ['00000000-0000-4000-8000-00000000d0ff'])).toMatch(/two-factor/)
    await db.query(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'unverified')`, [NEW_USER.id])
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [NEW_USER.id])).toMatch(/two-factor/)
  }))

  it('the bootstrap procedure: sign up (viewer) → enrol and verify on the Security page → promote → sign in again with the code', tx(async () => {
    await actAsDatabase(db)
    await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false)`, [NEW_USER.id, NEW_USER.email])
    expect((await one(`select role from profiles where id = $1`, [NEW_USER.id])).role).toBe('viewer') // handle_new_user
    await addVerifiedFactor(db, NEW_USER.id) // Supabase Auth, after they verify the first code
    // The owner's promotion statement (docs/ADMIN_MFA_PROCEDURES.md), as a direct database connection:
    const r = await db.query(`update profiles set role = 'admin' where id = $1 and exists (select 1 from auth.mfa_factors f where f.user_id = profiles.id and f.status = 'verified') returning role`, [NEW_USER.id])
    expect(r.rows).toEqual([{ role: 'admin' }])
    await actAs(db, NEW_USER, { aal: 'aal1' })
    expect(await visible()).toEqual({ profiles: 1 }) // the session from before the promotion must verify first
    await actAs(db, NEW_USER, { aal: 'aal2' })
    expect(await n(`select count(*) as n from employees`)).toBeGreaterThan(0)
  }))

  it('existing admins are not changed by 031 (an admin made before 031 without a factor stays an admin, but needs two-factor)', tx(async () => {
    await actAsDatabase(db)
    expect((await one(`select role from profiles where id = $1`, [OLD_ADMIN.id])).role).toBe('admin')
    await addVerifiedFactor(db, OLD_ADMIN.id) // they enrol
    await actAs(db, OLD_ADMIN, { aal: 'aal2' })
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-OLD')`)).toBeTruthy()
  }))
})

describe.skipIf(isStaging)('031: recovery when an admin loses their authenticator', () => {
  it('a second admin demotes them; the factor is removed (Supabase dashboard); they re-enrol; only then can they be an admin again', tx(async () => {
    await actAsDatabase(db)
    await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false)`, [NEW_USER.id, NEW_USER.email])
    await addVerifiedFactor(db, NEW_USER.id)
    await db.query(`update profiles set role = 'admin' where id = $1`, [NEW_USER.id]) // second admin
    // 1. The second admin (two-factor) demotes the locked-out admin first, so no admin is ever without an authenticator.
    await actAs(db, NEW_USER, { aal: 'aal2' })
    expect((await db.query(`update profiles set role = 'editor' where id = $1`, [ADMIN.id])).rowCount).toBe(1)
    // 2. Their factor is removed (dashboard / Auth Admin API).
    await actAsDatabase(db)
    await db.query(`delete from auth.mfa_factors where user_id = $1`, [ADMIN.id])
    // 3. Promoting them back is refused until they have re-enrolled.
    await actAs(db, NEW_USER, { aal: 'aal2' })
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [ADMIN.id])).toMatch(/two-factor/)
    await actAsDatabase(db)
    await addVerifiedFactor(db, ADMIN.id)
    await actAs(db, NEW_USER, { aal: 'aal2' })
    expect((await db.query(`update profiles set role = 'admin' where id = $1`, [ADMIN.id])).rowCount).toBe(1)
  }))

  it('if the factor of an admin is removed without demoting them, they keep the role but have no business-data access until they re-enrol', tx(async () => {
    await actAsDatabase(db)
    await db.query(`delete from auth.mfa_factors where user_id = $1`, [ADMIN.id])
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect(await visible()).toEqual({ profiles: 1 })
  }))
})

describe.skipIf(isStaging)('031: rollback', () => {
  it('restores the 030 definitions exactly, and 030 behaviour (password-only admin = editor-level)', tx(async () => {
    await db.exec(readFileSync(join(__dirname, '..', '..', 'rollback', '20260901000031_down.sql'), 'utf8')) // inside this rolled-back transaction
    expect(await defsOf(Object.keys(defs030))).toEqual(defs030)
    expect(await one(`select to_regprocedure('public.session_role()') is null as fn, (select count(*)::int from pg_policies where policyname = 'profiles_select_self') as pol,
      (select count(*)::int from pg_trigger where tgname = 'profiles_require_mfa_for_new_admin') as trg`)).toEqual({ fn: true, pol: 0, trg: 0 })
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'M31-DOWN')`)).toBeTruthy()
    expect(await errorOf(db, `select revoke_user_access($1)`, [VIEWER.id])).toMatch(/two-factor/)
  }))
})
