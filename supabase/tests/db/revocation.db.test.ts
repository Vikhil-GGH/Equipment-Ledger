/**
 * Security tests for 20260901000030: GENUINE access revocation and
 * database-level MFA for admin powers (PGlite, disposable). Exhaustive on
 * purpose: a revoked account is probed against every table and view and
 * every function it can call, and nothing anywhere may change.
 * Every test runs in a transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actAs,
  actAsDatabase,
  applyMigration,
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
  type TestUser,
} from './harness'
import { ADMIN, EDITOR, VIEWER, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

let db: Db
let ids: LedgerIds
const fx: Record<string, string> = {}
// A revoked editor (with history), revoked before the tests run.
const REVOKED: TestUser = { id: '00000000-0000-4000-8000-00000000b001', email: 'revoked-editor@example.invalid', anonymous: false }
const SECOND_ADMIN: TestUser = { id: '00000000-0000-4000-8000-00000000b002', email: 'second-admin@example.invalid', anonymous: false }

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
async function allRelations() {
  return (await db.query<{ name: string; kind: string }>(
    `select c.relname as name, c.relkind as kind from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r', 'v') order by 1`,
  )).rows
}
async function everything() {
  const h: Record<string, string> = {}
  for (const r of await allRelations()) if (r.kind === 'r') h[r.name] = await tableHash(db, r.name)
  return h
}
const addUser = async (u: TestUser, role: string) => {
  await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false) on conflict do nothing`, [u.id, u.email])
  await db.query(`update profiles set role = $2 where id = $1`, [u.id, role])
}

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    await addUser(REVOKED, 'editor')
    const l = await seedLedger(db, 'REV')
    // The soon-revoked editor authors real records: device, employee, register row, checklist.
    await actAs(db, REVOKED)
    fx.device = await rpc<string>(db, `create_asset('monitors', 'Dell 24', 'Monitor', 'REV-MON-BY-EDITOR')`)
    fx.employee = await rpc<string>(db, `save_employee(null, '{"first_name":"Rae","last_name":"Vok","department":"Ops","email":"rae@example.invalid"}'::jsonb)`)
    fx.issue = await rpc<string>(db, `issue_equipment($1, 'monitors', $2)`, [fx.employee, fx.device])
    fx.onboarding = (await one<{ id: string }>(`insert into onboarding_checklists (employee_name, employee_id, created_by) values ('Rae Vok', $1, $2) returning id`, [fx.employee, REVOKED.id])).id
    fx.offboarding = (await one<{ id: string }>(`insert into offboarding_checklists (employee_name, employee_id, created_by) values ('Rae Vok', $1, $2) returning id`, [fx.employee, REVOKED.id])).id
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1, 'Test: revoked')`, [REVOKED.id])
    await actAsDatabase(db)
    return l
  })
}, 300_000)

afterAll(async () => {
  await db?.close()
})

const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('1. a revoked account has genuinely no access', () => {
  it('reads nothing from ANY table or view — including Active Employees, inventory, the register and checklists', tx(async () => {
    await actAs(db, REVOKED)
    const leaks: string[] = []
    for (const r of await allRelations()) {
      const res = await db.query(`savepoint p`).then(() => db.query<{ n: number }>(`select count(*)::int as n from ${r.name} r where exists (select 1 from json_each_text(row_to_json(r)) j where j.value is not null and j.value <> '0')`)).then(
        (x) => x.rows[0].n,
        () => -1,
      )
      await db.query(res === -1 ? `rollback to savepoint p` : `release savepoint p`)
      if (res > 0) leaks.push(`${r.name}=${res}`)
    }
    expect(leaks).toEqual([])
    // Spot-check the named areas explicitly.
    for (const t of ['employees', 'employee_history', 'serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items',
      'equipment_issues', 'onboarding_checklists', 'offboarding_checklists', 'import_events', 'profiles', 'serial_duplicate_candidates', 'monitors_stats']) {
      expect(await n(`select count(*) as n from ${t}`), t).toBe(0)
    }
  }))

  it('an ordinary viewer still reads (so it is the revoked state, not the viewer role, that blocks)', tx(async () => {
    await actAs(db, VIEWER)
    expect(await n(`select count(*) as n from employees`)).toBeGreaterThan(0)
    expect(await n(`select count(*) as n from serialized_assets`)).toBeGreaterThan(0)
  }))

  it('changes nothing: every callable function (with empty and with realistic arguments) and every direct write is refused', tx(async () => {
    await actAsDatabase(db)
    const before = await everything()
    const fns = (await db.query<{ sig: string; args: string }>(
      `select p.oid::regprocedure::text as sig, coalesce((select string_agg('null::' || format_type(t, null), ', ' order by o) from unnest(p.proargtypes) with ordinality as a(t, o)), '') as args
       from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'public' and p.prorettype <> 'trigger'::regtype and p.prokind = 'f'
         and has_function_privilege('authenticated', p.oid, 'execute') order by 1`,
    )).rows
    await actAs(db, REVOKED)
    for (const f of fns) await errorOf(db, `select ${f.sig.split('(')[0]}(${f.args})`)
    const realistic = [
      `select create_asset('monitors', 'Dell', 'Monitor', 'REV-NEW')`,
      `select perform_lifecycle_action('monitors', '${fx.device}', 'mark_damaged')`,
      `select perform_bulk_action('${ids.bulkItem}', 'receive_stock', 5)`,
      `select create_bulk_item('REV Item', 'Cable', null, 3)`,
      `select commit_asset_import('monitors', 'r.xlsx', '[{"serial":"REV-IMP","name":"A","category":"B","status":"","assigned_to":"","location":""}]'::jsonb)`,
      `select commit_bulk_import('r.xlsx', '[{"name":"REV B","category":"C","quantity":1}]'::jsonb)`,
      `select commit_employee_import('r.xlsx', '[{"row":2,"action":"create","fields":{"first_name":"A","last_name":"B"},"status":"active"}]'::jsonb)`,
      `select save_employee('${fx.employee}', '{"department":"Changed"}'::jsonb)`,
      `select set_employment_status('${fx.employee}', 'inactive')`,
      `select create_employee('Someone')`,
      `select issue_equipment('${fx.employee}', 'serialized_assets', '${ids.spareInventoryLaptop}')`,
      `select return_equipment('${fx.issue}', 'returned')`,
      `select onboarding_assign_device('${fx.onboarding}', 'REV-INV-2')`,
      `select restore_user_access('${REVOKED.id}')`,
      `select revoke_user_access('${VIEWER.id}')`,
      `select restore_backup('{}'::jsonb)`,
      `update onboarding_checklists set identity_created = true`,
      `update offboarding_checklists set removed_access = true`,
      `insert into onboarding_checklists (employee_name, created_by) values ('x', '${REVOKED.id}')`,
      `update profiles set full_name = 'Changed by revoked user' where id = '${REVOKED.id}'`,
      `update profiles set role = 'admin' where id = '${REVOKED.id}'`,
      `delete from profiles where id = '${REVOKED.id}'`,
      `insert into import_events (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored) values ('${REVOKED.id}', 'x', 'fake', 1, 0, 0)`,
      `update serialized_assets set location = 'x'`,
      `update employees set department = 'x'`,
    ]
    const succeeded: string[] = []
    for (const sql of realistic) {
      await db.query('savepoint w')
      const r = await db.query(sql).then((x) => x, () => null)
      await db.query(r ? 'release savepoint w' : 'rollback to savepoint w')
      if (r && r.rowCount > 0 && !/^select/.test(sql)) succeeded.push(sql)
      if (r && /^select/.test(sql)) succeeded.push(sql)
    }
    expect(succeeded).toEqual([])
    await actAsDatabase(db)
    expect(await everything()).toEqual(before)
  }), 120_000)

  it('a session that was valid before the revoke loses access immediately (no re-login needed)', tx(async () => {
    const temp: TestUser = { id: '00000000-0000-4000-8000-00000000b003', email: 'temp-editor@example.invalid', anonymous: false }
    await actAsDatabase(db)
    await addUser(temp, 'editor')
    await actAs(db, temp) // the "existing session"
    expect(await n(`select count(*) as n from serialized_assets`)).toBeGreaterThan(0)
    expect(await rpc(db, `create_asset('monitors', 'Dell', 'Monitor', 'REV-TEMP-1')`)).toBeTruthy()
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [temp.id])
    await actAs(db, temp) // same token claims as before
    expect(await n(`select count(*) as n from serialized_assets`)).toBe(0)
    expect(await errorOf(db, `select create_asset('monitors', 'Dell', 'Monitor', 'REV-TEMP-2')`)).toMatch(/Not authorized/)
  }))

  it("the revoked person's own records and the audit trail are preserved", tx(async () => {
    await actAsDatabase(db)
    expect(await one(`select role, role_before_revoke, access_revoked_at is not null as revoked from profiles where id = $1`, [REVOKED.id])).toEqual({ role: 'viewer', role_before_revoke: 'editor', revoked: true })
    expect(await n(`select count(*) as n from monitors where id = $1`, [fx.device])).toBe(1)
    expect(await n(`select count(*) as n from monitors_history where actor_user_id = $1`, [REVOKED.id])).toBeGreaterThanOrEqual(1)
    expect(await n(`select count(*) as n from equipment_issues where id = $1 and issued_by = $2 and status = 'open'`, [fx.issue, REVOKED.id])).toBe(1)
    expect(await n(`select count(*) as n from employee_history where actor_user_id = $1`, [REVOKED.id])).toBe(1)
    expect(await n(`select count(*) as n from onboarding_checklists where created_by = $1`, [REVOKED.id])).toBe(1)
    expect(await one(`select action, role_before, reason, actor_user_id from profile_access_history where user_id = $1`, [REVOKED.id]))
      .toEqual({ action: 'revoked', role_before: 'editor', reason: 'Test: revoked', actor_user_id: ADMIN.id })
  }))
})

describe.skipIf(isStaging)('2. MFA is enforced in the database for admin powers', () => {
  it('an admin without MFA (aal1) cannot change roles, revoke or restore; with MFA (aal2) they can', tx(async () => {
    await actAsDatabase(db)
    await addUser(SECOND_ADMIN, 'admin') // so the last-admin guard isn't what refuses the self-demotion below
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect((await db.query(`update profiles set role = 'viewer' where id = $1`, [VIEWER.id])).rowCount).toBe(0)
    expect(await errorOf(db, `update profiles set role = 'viewer' where id = $1`, [ADMIN.id])).toMatch(/Only an admin can change a user role/)
    expect(await errorOf(db, `select revoke_user_access($1)`, [VIEWER.id])).toMatch(/two-factor/)
    expect(await errorOf(db, `select restore_user_access($1)`, [REVOKED.id])).toMatch(/two-factor/)
    expect(await errorOf(db, `select restore_backup('{}'::jsonb)`)).toMatch(/Only an admin/)
    await actAsDatabase(db)
    expect((await one(`select role from profiles where id = $1`, [VIEWER.id])).role).toBe('viewer')
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect((await db.query(`update profiles set role = 'editor' where id = $1`, [VIEWER.id])).rowCount).toBe(1)
    await rpc(db, `revoke_user_access($1)`, [VIEWER.id])
    await rpc(db, `restore_user_access($1)`, [VIEWER.id])
    expect(await n(`select count(*) as n from profile_access_history where user_id = $1`, [VIEWER.id])).toBe(2)
  }))

  it('an editor cannot reach admin powers by calling the functions or tables directly — even with an aal2 session', tx(async () => {
    for (const aal of ['aal1', 'aal2'] as const) {
      await actAs(db, EDITOR, { aal })
      expect(await errorOf(db, `select revoke_user_access($1)`, [VIEWER.id]), aal).toMatch(/Only an admin/)
      expect(await errorOf(db, `select restore_user_access($1)`, [REVOKED.id]), aal).toMatch(/Only an admin/)
      expect(await errorOf(db, `select restore_backup('{}'::jsonb)`), aal).toMatch(/Only an admin/)
      expect((await db.query(`update profiles set role = 'admin' where id = $1`, [VIEWER.id])).rowCount, aal).toBe(0)
      expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [EDITOR.id]), aal).toMatch(/Only an admin can change a user role/)
    }
    // The aal claim alone never grants admin: the role is read from profiles.
    await actAs(db, EDITOR, { aal: 'aal2' })
    expect((await one<{ a: boolean }>(`select is_admin() as a`)).a).toBe(false)
  }))

  it('a revoked admin with an aal2 session has no admin powers', tx(async () => {
    await actAsDatabase(db)
    await addUser(SECOND_ADMIN, 'admin')
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [SECOND_ADMIN.id])
    await actAs(db, SECOND_ADMIN, { aal: 'aal2' })
    expect((await one<{ a: boolean }>(`select is_admin() as a`)).a).toBe(false)
    expect(await errorOf(db, `select restore_user_access($1)`, [SECOND_ADMIN.id])).toMatch(/Only an admin/)
    expect(await errorOf(db, `select revoke_user_access($1)`, [ADMIN.id])).toMatch(/Only an admin/)
  }))
})

describe.skipIf(isStaging)('3. administrative access is always preserved', () => {
  it('an admin cannot revoke their own access; revoked users cannot restore themselves', tx(async () => {
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select revoke_user_access($1)`, [ADMIN.id])).toMatch(/cannot remove your own access/)
    await actAs(db, REVOKED)
    expect(await errorOf(db, `select restore_user_access($1)`, [REVOKED.id])).toMatch(/Only an admin/)
  }))

  it('the last active admin can be neither demoted nor revoked; with a second admin, demotion is allowed', tx(async () => {
    await actAs(db, ADMIN)
    expect(await errorOf(db, `update profiles set role = 'editor' where id = $1`, [ADMIN.id])).toMatch(/last active admin/)
    await actAsDatabase(db)
    await addUser(SECOND_ADMIN, 'admin')
    await actAs(db, SECOND_ADMIN)
    expect((await db.query(`update profiles set role = 'editor' where id = $1`, [ADMIN.id])).rowCount).toBe(1)
    // SECOND_ADMIN is now the last active admin.
    expect(await errorOf(db, `update profiles set role = 'editor' where id = $1`, [SECOND_ADMIN.id])).toMatch(/last active admin/)
    expect(await errorOf(db, `select revoke_user_access($1)`, [SECOND_ADMIN.id])).toMatch(/cannot remove your own access/)
    await actAsDatabase(db)
    expect(await n(`select count(*) as n from profiles where role = 'admin' and access_revoked_at is null`)).toBe(1)
    // Even a direct database update can't remove the last admin.
    expect(await errorOf(db, `update profiles set role = 'editor' where id = $1`, [SECOND_ADMIN.id])).toMatch(/last active admin/)
  }))

  it('restoration is audited, returns the previous role, and leaves every record intact', tx(async () => {
    await actAsDatabase(db)
    const before = await everything()
    await actAs(db, ADMIN)
    await rpc(db, `restore_user_access($1, 'Back on the team')`, [REVOKED.id])
    await actAsDatabase(db)
    expect(await one(`select role, access_revoked_at, role_before_revoke from profiles where id = $1`, [REVOKED.id])).toEqual({ role: 'editor', access_revoked_at: null, role_before_revoke: null })
    expect((await db.query(`select action, role_before, role_after, reason, actor_user_id from profile_access_history where user_id = $1 order by at`, [REVOKED.id])).rows).toEqual([
      { action: 'revoked', role_before: 'editor', role_after: 'viewer', reason: 'Test: revoked', actor_user_id: ADMIN.id },
      { action: 'restored', role_before: 'viewer', role_after: 'editor', reason: 'Back on the team', actor_user_id: ADMIN.id },
    ])
    const after = await everything()
    for (const t of Object.keys(before)) if (!['profiles', 'profile_access_history'].includes(t)) expect(after[t], t).toBe(before[t])
    await actAs(db, REVOKED)
    expect(await n(`select count(*) as n from employees`)).toBeGreaterThan(0)
  }))
})
