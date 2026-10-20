/**
 * Tests for 20260901000030_access_controls.sql on a fresh disposable
 * database (PGlite only): import-log writes, access revocation (instead of
 * deleting profiles), MFA (aal2) for admin powers, preservation, rollback.
 * Every test runs in a transaction that is rolled back.
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
import { ADMIN, EDITOR, VIEWER, rpc, seedLedger, seedUsers, type LedgerIds } from './fixtures'

const M030 = '20260901000030_access_controls.sql'
let db: Db
let ids: LedgerIds
const pre: Record<string, string> = {}
let defsBefore: { proname: string; def: string }[]
const TABLES = ['profiles', 'serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items', 'serialized_asset_history',
  'bulk_item_history', 'import_events', 'onboarding_checklists', 'offboarding_checklists', 'employees', 'equipment_issues', 'employee_history']
const PROFILE_COLS = 'id, email, full_name, role, created_at'

const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
const definitions = async () =>
  (await db.query<{ proname: string; def: string }>(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' order by 1, 2`)).rows
const norm = (d: string) => d.replace(/\r\n/g, '\n')
const sameDefs = (a: { proname: string; def: string }[], b: { proname: string; def: string }[]) => {
  const key = (x: { proname: string; def: string }) => `${x.proname}\n${norm(x.def)}`
  return { missing: a.filter((x) => !b.some((y) => key(y) === key(x))).map((x) => x.proname), extra: b.filter((x) => !a.some((y) => key(y) === key(x))).map((x) => x.proname) }
}
const profile = (id: string) => one(`select role, access_revoked_at is not null as revoked, role_before_revoke from profiles where id = $1`, [id])
const profilesHash = async () => (await one<{ h: string }>(`select md5(coalesce(string_agg(row(${PROFILE_COLS})::text, '|' order by id), '')) as h from profiles`)).h

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M030) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  ids = await inCommittedTx(db, async () => {
    await seedUsers(db)
    const l = await seedLedger(db, 'ACC')
    await actAsDatabase(db)
    return l
  })
  for (const t of TABLES) pre[t] = t === 'profiles' ? await profilesHash() : await tableHash(db, t)
  defsBefore = await definitions()
  await applyMigration(db, M030)
}, 240_000)

afterAll(async () => {
  await db?.close()
})

const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('030 applied to existing data', () => {
  it('changes no existing row or value', async () => {
    for (const t of TABLES) expect(t === 'profiles' ? await profilesHash() : await tableHash(db, t), t).toBe(pre[t])
    expect(await n(`select count(*) as n from profiles where access_revoked_at is not null`)).toBe(0)
  })
})

describe.skipIf(isStaging)('2. Import History is written only by the import functions', () => {
  it('an editor (or admin) cannot insert, change or delete log rows directly', tx(async () => {
    for (const user of [EDITOR, ADMIN]) {
      await actAs(db, user)
      expect(await errorOf(db, `insert into import_events (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored) values ($1, 'monitors', 'fake.xlsx', 99, 0, 0)`, [user.id]), user.email!).toMatch(/permission denied|row-level security/)
      expect(await errorOf(db, `update import_events set rows_created = 0`)).toMatch(/permission denied/)
      expect(await errorOf(db, `delete from import_events`)).toMatch(/permission denied/)
    }
  }))

  it('real imports still log themselves', tx(async () => {
    await actAs(db, EDITOR)
    await rpc(db, `commit_asset_import('monitors', 'real.xlsx', $1::jsonb)`, [JSON.stringify([{ serial: 'ACC-MON-NEW', name: 'Dell 24', category: 'Monitor', status: '', assigned_to: '', location: '' }])])
    await rpc(db, `commit_bulk_import('real-bulk.xlsx', $1::jsonb)`, [JSON.stringify([{ name: 'ACC Cable', category: 'Cable', location: '', quantity: 2 }])])
    expect((await db.query(`select filename from import_events where filename like 'real%' order by filename`)).rows.map((r) => r.filename)).toEqual(['real-bulk.xlsx', 'real.xlsx'])
  }))
})

describe.skipIf(isStaging)('3. Remove access keeps the identity and the audit trail', () => {
  it('revoking: role becomes viewer (previous kept), the person reads nothing and can change nothing; history still names them', tx(async () => {
    await actAs(db, EDITOR)
    await rpc(db, `create_asset('monitors', 'Dell 24', 'Monitor', 'ACC-MON-EDITOR')`) // authored by the editor
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1, 'Left the company')`, [EDITOR.id])
    expect(await profile(EDITOR.id)).toMatchObject({ role: 'viewer', revoked: true, role_before_revoke: 'editor' })
    expect(await one(`select action, role_before, role_after, reason, actor_user_id from profile_access_history where user_id = $1`, [EDITOR.id]))
      .toEqual({ action: 'revoked', role_before: 'editor', role_after: 'viewer', reason: 'Left the company', actor_user_id: ADMIN.id })
    await actAs(db, EDITOR)
    expect(await n(`select count(*) as n from serialized_assets`)).toBe(0)
    expect(await n(`select count(*) as n from profiles`)).toBe(0)
    expect(await errorOf(db, `select create_asset('monitors', 'Dell 24', 'Monitor', 'ACC-MON-X')`)).toMatch(/Not authorized/)
    expect(await errorOf(db, `select commit_bulk_import('x.xlsx', '[{"name":"A","category":"B","quantity":1}]'::jsonb)`)).toMatch(/Not authorized/)
    await actAsDatabase(db)
    expect(await n(`select count(*) as n from monitors_history where actor_user_id = $1`, [EDITOR.id])).toBe(1)
  }))

  it('restoring puts the previous role back; the person can work again', tx(async () => {
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await rpc(db, `restore_user_access($1, 'Rehired')`, [EDITOR.id])
    expect(await profile(EDITOR.id)).toMatchObject({ role: 'editor', revoked: false, role_before_revoke: null })
    expect((await db.query(`select action from profile_access_history where user_id = $1 order by at`, [EDITOR.id])).rows.map((r) => r.action)).toEqual(['revoked', 'restored'])
    await actAs(db, EDITOR)
    expect(await rpc(db, `create_asset('monitors', 'Dell 24', 'Monitor', 'ACC-MON-BACK')`)).toBeTruthy()
  }))

  it('safeguards: not yourself; an admin always remains; no role raise or flag edits while revoked; no profile deletes', tx(async () => {
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select revoke_user_access($1)`, [ADMIN.id])).toMatch(/cannot remove your own access/)
    // A second admin can remove the first — the remover is still an active admin.
    await actAsDatabase(db)
    await db.query(`insert into auth.users (id, email, is_anonymous) values ('00000000-0000-4000-8000-00000000a009', 'second-admin@example.invalid', false)`)
    await db.query(`update profiles set role = 'admin' where id = '00000000-0000-4000-8000-00000000a009'`)
    const second = { id: '00000000-0000-4000-8000-00000000a009', email: 'second-admin@example.invalid', anonymous: false }
    await actAs(db, second)
    await rpc(db, `revoke_user_access($1)`, [ADMIN.id])
    expect(await n(`select count(*) as n from profiles where role = 'admin' and access_revoked_at is null`)).toBe(1)
    // ...and the revoked admin can no longer act as one.
    await actAs(db, ADMIN)
    expect(await errorOf(db, `select revoke_user_access($1)`, [second.id])).toMatch(/Only an admin/)
    expect(await n(`select count(*) as n from profiles`)).toBe(0)
    // While revoked, the role can't be raised and the access fields can't be edited directly.
    await actAs(db, second)
    expect(await errorOf(db, `update profiles set role = 'admin' where id = $1`, [ADMIN.id])).toMatch(/access is removed — restore access first/)
    expect(await errorOf(db, `update profiles set access_revoked_at = null where id = $1`, [ADMIN.id])).toMatch(/Use Remove access \/ Restore access/)
    expect(await errorOf(db, `delete from profiles where id = $1`, [VIEWER.id])).toMatch(/permission denied/)
    // Restoring brings the admin role back.
    await rpc(db, `restore_user_access($1)`, [ADMIN.id])
    expect(await profile(ADMIN.id)).toMatchObject({ role: 'admin', revoked: false })
  }))

  it('editors and viewers cannot revoke or restore anyone', tx(async () => {
    for (const user of [EDITOR, VIEWER]) {
      await actAs(db, user)
      expect(await errorOf(db, `select revoke_user_access($1)`, [ADMIN.id]), user.email!).toMatch(/Only an admin/)
      expect(await errorOf(db, `select restore_user_access($1)`, [ADMIN.id]), user.email!).toMatch(/Only an admin/)
    }
  }))
})

describe.skipIf(isStaging)('4. MFA (aal2) is required for admin powers', () => {
  it('an admin with a password-only session (aal1) cannot use admin powers, but keeps editor-level work', tx(async () => {
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect((await one<{ a: boolean }>(`select is_admin() as a`)).a).toBe(false)
    expect(await errorOf(db, `select revoke_user_access($1)`, [EDITOR.id])).toMatch(/two-factor/)
    expect(await errorOf(db, `select restore_backup('{}'::jsonb)`)).toMatch(/Only an admin/)
    // Row-level security hides other people's profiles from a non-admin update: 0 rows change.
    const r = await db.query(`update profiles set role = 'viewer' where id = $1`, [EDITOR.id])
    expect(r.rowCount).toBe(0)
    await actAsDatabase(db)
    expect((await profile(EDITOR.id)).role).toBe('editor')
    await actAs(db, ADMIN, { aal: 'aal1' })
    expect(await rpc(db, `create_asset('monitors', 'Dell 24', 'Monitor', 'ACC-MON-AAL1')`)).toBeTruthy()
    await actAs(db, ADMIN, { aal: 'aal2' })
    expect((await one<{ a: boolean }>(`select is_admin() as a`)).a).toBe(true)
    await db.query(`update profiles set role = 'viewer' where id = $1`, [EDITOR.id])
    expect((await profile(EDITOR.id)).role).toBe('viewer')
  }))

  it('a missing aal claim counts as password-only', tx(async () => {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ADMIN.id, role: 'authenticated' })])
    await db.exec('set local role authenticated')
    expect((await one<{ a: boolean }>(`select is_admin() as a`)).a).toBe(false)
  }))

  it('viewers and editors are unaffected by the MFA rule', tx(async () => {
    await actAs(db, EDITOR, { aal: 'aal1' })
    expect(await rpc(db, `create_asset('monitors', 'Dell 24', 'Monitor', 'ACC-MON-ED1')`)).toBeTruthy()
    await actAs(db, VIEWER, { aal: 'aal1' })
    expect(await n(`select count(*) as n from serialized_assets`)).toBeGreaterThan(0)
    expect(ids.monitor).toBeTruthy()
  }))
})

describe.skipIf(isStaging)('030 rollback', () => {
  it('refuses while any access is revoked; otherwise restores the 022/007 definitions exactly and 030 re-applies', async () => {
    await inCommittedTx(db, async () => {
      await actAs(db, ADMIN)
      await rpc(db, `revoke_user_access($1)`, [VIEWER.id])
      await actAsDatabase(db)
    })
    await expect(applyRollback(db, '20260901000030_down.sql')).rejects.toThrow(/Rollback stopped: 1 account\(s\) have access removed/)
    await inCommittedTx(db, async () => {
      await actAs(db, ADMIN)
      await rpc(db, `restore_user_access($1)`, [VIEWER.id])
      await actAsDatabase(db)
    })
    await applyRollback(db, '20260901000030_down.sql')
    expect(sameDefs(defsBefore, await definitions())).toEqual({ missing: [], extra: [] })
    expect(await n(`select count(*) as n from private.profile_access_history_backup_030`)).toBe(2)
    expect((await db.query(`select policyname from pg_policies where tablename in ('import_events', 'profiles') order by 1`)).rows.map((r) => r.policyname)).toEqual(
      expect.arrayContaining(['import_events_insert_editor', 'profiles_delete_admin']),
    )
    expect(await profilesHash()).toBe(pre.profiles)
    await applyMigration(db, M030)
  })
})
