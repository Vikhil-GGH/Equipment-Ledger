/**
 * Tests the PROPOSED 032 (supabase/proposals/032_auth_block_on_revoke.sql,
 * not a migration): Remove access also blocks Supabase Auth sign-in, in the
 * same transaction, with failure handling and audit. PGlite only, with the
 * Auth columns/tables it touches stubbed; every test is rolled back.
 * (Whether Supabase Auth honours banned_until is a staging check, not this.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, applyMigration, errorOf, inCommittedTx, inRolledBackTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, type Db } from './harness'
import { ADMIN, EDITOR, VIEWER, rpc, seedLedger, seedUsers } from './fixtures'

const PROPOSALS = join(__dirname, '..', '..', 'proposals')
let db: Db
let defs030: Record<string, string> = {}
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)
const norm = (s: string) => s.replace(/\r\n/g, '\n').trim()
const defsOf = async (names: string[]) => {
  const out: Record<string, string> = {}
  for (const name of names) out[name] = norm((await one<{ d: string }>(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = $1`, [name])).d)
  return out
}
const authState = (id: string) => one(`select banned_until > now() + interval '99 years' as blocked, banned_until is null as unbanned,
  (select count(*)::int from auth.sessions where user_id = $1) as sessions,
  (select count(*)::int from auth.refresh_tokens t join auth.sessions s on s.id = t.session_id where s.user_id = $1) as tokens from auth.users where id = $1`, [id])
const lastHistory = (id: string) => one(`select action, auth_block, auth_error from profile_access_history where user_id = $1 order by at desc limit 1`, [id])
const breakAuthUsers = () => db.exec(`create function pg_temp.no_auth_writes() returns trigger language plpgsql as $$ begin raise exception 'auth schema is read-only now'; end $$;
  create trigger no_auth_writes before update on auth.users for each row execute function pg_temp.no_auth_writes();`)
const fixAuthUsers = () => db.exec(`drop trigger no_auth_writes on auth.users`)

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  await db.exec(`alter table auth.users add column banned_until timestamptz;
    create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade);
    create table auth.refresh_tokens (id bigserial primary key, session_id uuid references auth.sessions on delete cascade);`)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    await seedLedger(db, 'P32')
    await actAsDatabase(db)
    for (const u of [EDITOR, VIEWER]) for (let i = 0; i < 2; i++) {
      const s = await one<{ id: string }>(`insert into auth.sessions (user_id) values ($1) returning id`, [u.id])
      await db.query(`insert into auth.refresh_tokens (session_id) values ($1)`, [s.id])
    }
  })
  defs030 = await defsOf(['revoke_user_access', 'restore_user_access', 'keep_revoked_profile_viewer'])
  await inCommittedTx(db, () => db.exec(readFileSync(join(PROPOSALS, '032_auth_block_on_revoke.sql'), 'utf8')))
}, 300_000)
afterAll(async () => {
  await db?.close()
})
const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('proposed 032: Remove access also blocks sign-in', () => {
  it('revoke blocks sign-in, ends every session (refresh tokens too) and records it; data access is removed as before', tx(async () => {
    await actAs(db, ADMIN)
    expect(await rpc(db, `revoke_user_access($1, 'left')`, [EDITOR.id])).toEqual({ sign_in_blocked: true, auth_block: 'applied' })
    await actAsDatabase(db)
    expect(await authState(EDITOR.id)).toEqual({ blocked: true, unbanned: false, sessions: 0, tokens: 0 })
    expect(await lastHistory(EDITOR.id)).toEqual({ action: 'revoked', auth_block: 'applied', auth_error: null })
    expect(await n(`select count(*) as n from auth.sessions where user_id = $1`, [VIEWER.id])).toBe(2) // nobody else signed out
    await actAs(db, EDITOR)
    expect(await n(`select count(*) as n from serialized_assets`)).toBe(0)
  }))

  it('restore lifts the block it set, and records it', tx(async () => {
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    expect(await rpc(db, `restore_user_access($1)`, [EDITOR.id])).toEqual({ sign_in_unblocked: true, auth_block: 'lifted' })
    await actAsDatabase(db)
    expect(await authState(EDITOR.id)).toMatchObject({ unbanned: true })
    expect(await one(`select role, auth_blocked_by_revoke from profiles where id = $1`, [EDITOR.id])).toEqual({ role: 'editor', auth_blocked_by_revoke: false })
    expect(await lastHistory(EDITOR.id)).toEqual({ action: 'restored', auth_block: 'lifted', auth_error: null })
  }))

  it('a ban applied separately (dashboard) is never overwritten or lifted', tx(async () => {
    await actAsDatabase(db)
    await db.query(`update auth.users set banned_until = '2030-01-01' where id = $1`, [EDITOR.id])
    await actAs(db, ADMIN)
    expect(await rpc(db, `revoke_user_access($1)`, [EDITOR.id])).toEqual({ sign_in_blocked: true, auth_block: 'not_ours' })
    await actAsDatabase(db)
    expect((await one(`select banned_until::date::text as d from auth.users where id = $1`, [EDITOR.id])).d).toBe('2030-01-01')
    expect(await n(`select count(*) as n from auth.sessions where user_id = $1`, [EDITOR.id])).toBe(0)
    await actAs(db, ADMIN)
    expect(await rpc(db, `restore_user_access($1)`, [EDITOR.id])).toEqual({ sign_in_unblocked: false, auth_block: 'not_ours' })
    await actAsDatabase(db)
    expect((await one(`select banned_until::date::text as d from auth.users where id = $1`, [EDITOR.id])).d).toBe('2030-01-01')
  }))

  it('if blocking sign-in fails, access is STILL removed, the failure is recorded and listed, and a retry fixes it', tx(async () => {
    await actAsDatabase(db)
    await breakAuthUsers()
    await actAs(db, ADMIN)
    expect(await rpc(db, `revoke_user_access($1)`, [EDITOR.id])).toEqual({ sign_in_blocked: false, auth_block: 'failed' })
    await actAsDatabase(db)
    expect(await one(`select access_revoked_at is not null as revoked, role, auth_blocked_by_revoke from profiles where id = $1`, [EDITOR.id])).toEqual({ revoked: true, role: 'viewer', auth_blocked_by_revoke: false })
    expect(await lastHistory(EDITOR.id)).toEqual({ action: 'revoked', auth_block: 'failed', auth_error: 'auth schema is read-only now' })
    expect(await authState(EDITOR.id)).toMatchObject({ unbanned: true, sessions: 2 }) // the failed step changed nothing in Auth
    await actAs(db, ADMIN)
    expect((await db.query(`select problem from auth_block_mismatches()`)).rows).toEqual([{ problem: 'access removed, but can still sign in' }])
    await actAsDatabase(db)
    await fixAuthUsers()
    await actAs(db, ADMIN)
    expect(await rpc(db, `retry_auth_sync($1)`, [EDITOR.id])).toEqual({ auth_block: 'applied' })
    expect((await db.query(`select * from auth_block_mismatches()`)).rows).toEqual([])
    await actAsDatabase(db)
    expect(await authState(EDITOR.id)).toEqual({ blocked: true, unbanned: false, sessions: 0, tokens: 0 })
    expect(await lastHistory(EDITOR.id)).toEqual({ action: 'auth_sync_retried', auth_block: 'applied', auth_error: null })
  }))

  it('if lifting the block fails on restore, access is restored, the failure is recorded, and a retry lifts it', tx(async () => {
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await actAsDatabase(db)
    await breakAuthUsers()
    await actAs(db, ADMIN)
    expect(await rpc(db, `restore_user_access($1)`, [EDITOR.id])).toEqual({ sign_in_unblocked: false, auth_block: 'failed' })
    expect((await db.query(`select problem from auth_block_mismatches()`)).rows).toEqual([{ problem: 'access restored, but sign-in is still blocked' }])
    await actAsDatabase(db)
    await fixAuthUsers()
    await actAs(db, ADMIN)
    expect(await rpc(db, `retry_auth_sync($1)`, [EDITOR.id])).toEqual({ auth_block: 'lifted' })
    await actAsDatabase(db)
    expect(await authState(EDITOR.id)).toMatchObject({ unbanned: true })
    expect(await one(`select role, auth_blocked_by_revoke from profiles where id = $1`, [EDITOR.id])).toEqual({ role: 'editor', auth_blocked_by_revoke: false })
  }))

  it('only an admin with two-factor can retry or list mismatches; nobody can call the Auth helpers directly or flip the flag', tx(async () => {
    for (const [user, aal] of [[EDITOR, 'aal2'], [ADMIN, 'aal1']] as const) {
      await actAs(db, user, { aal })
      expect(await errorOf(db, `select retry_auth_sync($1)`, [VIEWER.id])).toMatch(/Only an admin/)
      expect((await db.query(`select * from auth_block_mismatches()`)).rows).toEqual([])
      expect(await errorOf(db, `select apply_auth_block($1)`, [VIEWER.id])).toMatch(/permission denied/)
      expect(await errorOf(db, `select lift_auth_block($1)`, [VIEWER.id])).toMatch(/permission denied/)
    }
    await actAs(db, ADMIN)
    expect(await errorOf(db, `update profiles set auth_blocked_by_revoke = true where id = $1`, [VIEWER.id])).toMatch(/Remove access/)
  }))

  it('rollback restores the 030 functions exactly and keeps every block and the audit trail', tx(async () => {
    await actAs(db, ADMIN)
    await rpc(db, `revoke_user_access($1)`, [EDITOR.id])
    await actAsDatabase(db)
    await db.exec(readFileSync(join(PROPOSALS, '032_down.sql'), 'utf8'))
    expect(await defsOf(Object.keys(defs030))).toEqual(defs030)
    expect(await authState(EDITOR.id)).toMatchObject({ blocked: true })
    expect(await lastHistory(EDITOR.id)).toMatchObject({ action: 'revoked', auth_block: 'applied' })
  }))
})
