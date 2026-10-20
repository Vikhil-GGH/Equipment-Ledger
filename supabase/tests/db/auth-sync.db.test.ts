/**
 * PROPOSED 032 (supabase/proposals/032_auth_sign_in_sync.sql + the auth-sync
 * Edge Function logic in supabase/proposals/auth-sync/sync.ts), end to end on
 * a disposable database with a FAKE Supabase Auth Admin API. PGlite only;
 * every test is rolled back. (Real Supabase Auth behaviour — sign-in and
 * refresh refused for a banned user — is a staging check.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BAN_DURATION, authorizeCaller, runSync, type AuthAdmin, type SyncDb } from '../../proposals/auth-sync/sync'
import { actAs, actAsDatabase, applyMigration, errorOf, inCommittedTx, inRolledBackTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, tableHash, type Db } from './harness'
import { ADMIN, EDITOR, VIEWER, rpc, seedLedger, seedUsers } from './fixtures'

let db: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const n = async (sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(sql, params)).n)

/** The service side: the Edge Function's database calls, as service_role (no user JWT). */
async function asService<T>(fn: () => Promise<T>) {
  await actAsDatabase(db)
  await db.exec('set local role service_role')
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}
const syncDb: SyncDb = {
  reconcile: () => asService(async () => Number((await one<{ n: number }>(`select auth_sync_reconcile() as n`)).n)),
  claim: (limit) => asService(async () => (await db.query<any>(`select user_id, desired, ban_owned, ban_until_set::text, attempts from auth_sync_claim($1)`, [limit])).rows),
  report: (u, d, r, o, s, e) => asService(async () => void (await db.query(`select auth_sync_report($1, $2, $3, $4, $5, $6)`, [u, d, r, o, s, e]))),
}

/** A fake Supabase Auth: banned_until per user, with failure injection and a call log. */
function fakeAuth(initial: Record<string, string | null> = {}) {
  const bans = new Map<string, string | null>(Object.entries(initial))
  const calls: string[] = []
  let failing: string | null = null
  const api: AuthAdmin = {
    async getBannedUntil(id) {
      calls.push(`get ${id}`)
      if (failing === 'get') throw new Error('Auth API unavailable')
      return bans.get(id) ?? null
    },
    async setBan(id, duration) {
      calls.push(`ban ${id} ${duration}`)
      if (failing === 'set') throw new Error('Auth API unavailable')
      const until = duration === 'none' ? null : new Date(Date.now() + 876000 * 3600_000).toISOString()
      bans.set(id, until)
      return until
    },
  }
  return { api, bans, calls, fail: (what: string | null) => (failing = what) }
}
const state = (id: string) => one(`select status, ban_owned, synced_state, attempts, last_error from auth_sync_state where user_id = $1`, [id])
const events = async (id: string) => (await db.query<{ kind: string }>(`select kind from auth_sync_events where user_id = $1 order by at`, [id])).rows.map((r) => r.kind)
const revoke = async (id: string) => {
  await actAs(db, ADMIN)
  await rpc(db, `revoke_user_access($1, 'test')`, [id])
  await actAsDatabase(db)
}
const restore = async (id: string) => {
  await actAs(db, ADMIN)
  await rpc(db, `restore_user_access($1)`, [id])
  await actAsDatabase(db)
}
/** Let the failure backoff pass without waiting. */
const backoffPassed = (id: string) => db.query(`update auth_sync_state set last_attempt_at = now() - interval '2 hours' where user_id = $1`, [id])

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    await seedLedger(db, 'A32')
    await actAsDatabase(db)
  })
  await inCommittedTx(db, () => db.exec(readFileSync(join(__dirname, '..', '..', 'proposals', '032_auth_sign_in_sync.sql'), 'utf8')))
}, 300_000)
afterAll(async () => {
  await db?.close()
})
const tx = (fn: () => Promise<void>) => () => inRolledBackTx(db, fn)

describe.skipIf(isStaging)('032: database access is revoked at once, whatever happens to Auth', () => {
  it('revoke removes data access immediately and queues a sign-in block; nothing calls Auth inside the transaction', tx(async () => {
    await revoke(EDITOR.id)
    await actAs(db, EDITOR)
    expect(await n(`select count(*) as n from serialized_assets`)).toBe(0)
    await actAsDatabase(db)
    expect(await state(EDITOR.id)).toMatchObject({ status: 'pending', ban_owned: false })
    expect(await events(EDITOR.id)).toEqual(['requested'])
  }))

  it('the sync blocks sign-in through the Admin API, records it, and a second run changes nothing (idempotent)', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    const out = await runSync(syncDb, auth.api)
    expect(out.results).toEqual([{ user_id: EDITOR.id, result: 'blocked', error: null }])
    expect(auth.calls).toEqual([`get ${EDITOR.id}`, `ban ${EDITOR.id} ${BAN_DURATION}`])
    expect(await state(EDITOR.id)).toMatchObject({ status: 'synced', ban_owned: true, synced_state: 'blocked' })
    auth.calls.length = 0
    expect((await runSync(syncDb, auth.api)).results).toEqual([])
    expect(auth.calls).toEqual([])
  }))

  it('restore re-enables data access at once; the sync then lifts the ban it applied', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    await runSync(syncDb, auth.api)
    await restore(EDITOR.id)
    await actAs(db, EDITOR)
    expect(await n(`select count(*) as n from serialized_assets`)).toBeGreaterThan(0)
    await actAsDatabase(db)
    expect((await runSync(syncDb, auth.api)).results).toEqual([{ user_id: EDITOR.id, result: 'unblocked', error: null }])
    expect(auth.bans.get(EDITOR.id)).toBeNull()
    expect(await state(EDITOR.id)).toMatchObject({ status: 'synced', ban_owned: false, synced_state: 'unblocked' })
    expect(await events(EDITOR.id)).toEqual(['requested', 'blocked', 'requested', 'unblocked'])
  }))
})

describe.skipIf(isStaging)('032: never removes a ban it did not apply', () => {
  it('an existing (dashboard) ban is left exactly as it is on revoke and on restore', tx(async () => {
    const auth = fakeAuth({ [EDITOR.id]: '2030-01-01T00:00:00.000Z' })
    await revoke(EDITOR.id)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('not_ours')
    await restore(EDITOR.id)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('not_ours')
    expect(auth.bans.get(EDITOR.id)).toBe('2030-01-01T00:00:00.000Z')
    expect(auth.calls.filter((c) => c.startsWith('ban'))).toEqual([])
  }))

  it('a ban it applied but someone then changed (e.g. extended in the dashboard) is not lifted', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    await runSync(syncDb, auth.api)
    auth.bans.set(EDITOR.id, '2099-12-31T00:00:00.000Z')
    await restore(EDITOR.id)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('not_ours')
    expect(auth.bans.get(EDITOR.id)).toBe('2099-12-31T00:00:00.000Z')
    expect(await state(EDITOR.id)).toMatchObject({ status: 'not_ours', ban_owned: false })
  }))
})

describe.skipIf(isStaging)('032: failures are recorded, retried and can never grant data access', () => {
  it('a failed ban: access stays removed, the error is recorded, retried after backoff, then applied', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    auth.fail('set')
    expect((await runSync(syncDb, auth.api)).results[0]).toMatchObject({ result: 'failed', error: 'Auth API unavailable' })
    expect(await state(EDITOR.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'Auth API unavailable' })
    await actAs(db, EDITOR)
    expect(await n(`select count(*) as n from employees`)).toBe(0)
    await actAsDatabase(db)
    auth.fail(null)
    expect((await runSync(syncDb, auth.api)).results).toEqual([]) // backoff not passed yet
    await backoffPassed(EDITOR.id)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('blocked')
    expect(await events(EDITOR.id)).toEqual(['requested', 'failed', 'blocked'])
  }))

  it('a failed unban fails closed: data access is restored as the admin decided, sign-in stays blocked until the retry succeeds', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    await runSync(syncDb, auth.api)
    await restore(EDITOR.id)
    auth.fail('get')
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('failed')
    expect(auth.bans.get(EDITOR.id)).not.toBeNull()
    auth.fail(null)
    await backoffPassed(EDITOR.id)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('unblocked')
  }))

  it('no sync outcome — success or any failure — changes profiles or any business data', tx(async () => {
    await actAsDatabase(db)
    await revoke(EDITOR.id)
    await revoke(VIEWER.id)
    const tables = ['profiles', 'profile_access_history', 'serialized_assets', 'employees', 'equipment_issues']
    const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await tableHash(db, t)])))
    const auth = fakeAuth()
    for (const f of ['set', 'get', null]) {
      auth.fail(f)
      await runSync(syncDb, auth.api)
      await backoffPassed(EDITOR.id)
      await backoffPassed(VIEWER.id)
    }
    await actAsDatabase(db)
    for (const t of tables) expect(await tableHash(db, t), t).toBe(before[t])
  }))
})

describe.skipIf(isStaging)('032: races and reconciliation', () => {
  it('revoked then restored before the sync ran: the desired state comes from the database, so no ban is applied at all', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    await restore(EDITOR.id)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('unblocked')
    expect(auth.calls.filter((c) => c.startsWith('ban'))).toEqual([])
  }))

  it('access changes while the worker is busy: its outcome is recorded and the account is queued again', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    const [item] = await syncDb.claim(10)
    await restore(EDITOR.id) // admin restores meanwhile
    await syncDb.report(item.user_id, item.desired, 'blocked', true, new Date(Date.now() + 3e12).toISOString(), null)
    expect(await state(EDITOR.id)).toMatchObject({ status: 'pending', ban_owned: true })
    expect((await events(EDITOR.id)).slice(-2)).toEqual(['blocked', 'superseded'])
    auth.bans.set(EDITOR.id, (await one(`select ban_until_set::text as t from auth_sync_state where user_id = $1`, [EDITOR.id])).t)
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('unblocked') // the ban it applied is lifted
  }))

  it('reconciliation catches a revoked account with no sync record (e.g. revoked before 032) and a ban lifted in the dashboard', tx(async () => {
    const auth = fakeAuth()
    await revoke(EDITOR.id)
    await db.exec(`delete from auth_sync_state; delete from auth_sync_events`) // as if revoked before 032 existed
    expect((await runSync(syncDb, auth.api)).results[0]).toMatchObject({ user_id: EDITOR.id, result: 'blocked' })
    auth.bans.set(EDITOR.id, null) // someone unbans in the dashboard…
    await db.query(`update auth_sync_state set synced_at = now() - interval '2 days' where user_id = $1`, [EDITOR.id]) // …the daily re-check
    expect((await runSync(syncDb, auth.api)).results[0].result).toBe('blocked')
  }))
})

describe.skipIf(isStaging)('032: who can do what', () => {
  it('the service functions are service_role only; retry needs an admin with two-factor; the tables are read-only and admin-only', tx(async () => {
    for (const [user, aal] of [[EDITOR, 'aal2'], [ADMIN, 'aal1'], [ADMIN, 'aal2']] as const) {
      await actAs(db, user, { aal })
      for (const sql of [`select auth_sync_reconcile()`, `select * from auth_sync_claim(1)`, `select auth_sync_report($1, 'blocked', 'blocked', true, now(), null)`])
        expect(await errorOf(db, sql, sql.includes('$1') ? [VIEWER.id] : []), `${user.email} ${aal}: ${sql}`).toMatch(/permission denied/)
      expect(await errorOf(db, `insert into auth_sync_events (user_id, kind) values ($1, 'blocked')`, [VIEWER.id])).toMatch(/permission denied/)
      expect(await errorOf(db, `update auth_sync_state set ban_owned = true`)).toMatch(/permission denied/)
    }
    await actAs(db, EDITOR)
    expect(await errorOf(db, `select request_auth_sync_retry($1)`, [VIEWER.id])).toMatch(/Only an admin/)
    expect(await n(`select count(*) as n from auth_sync_events`)).toBe(0)
    await actAs(db, ADMIN, { aal: 'aal2' })
    await rpc(db, `request_auth_sync_retry($1)`, [VIEWER.id])
    expect(await n(`select count(*) as n from auth_sync_events`)).toBe(1)
  }))

  it('the Edge Function accepts only the scheduler secret or an admin with a two-factor session', async () => {
    const tok = (aal: string) => `x.${Buffer.from(JSON.stringify({ sub: 'u', aal })).toString('base64url')}.sig`
    const deps = (over = {}) => ({ cronSecret: 's'.repeat(40), validateJwt: async () => ({ id: 'u' }), isAdminAs: async () => true, ...over })
    expect(await authorizeCaller({ cronSecret: 's'.repeat(40) }, deps())).toMatchObject({ ok: true, caller: 'scheduler' })
    expect(await authorizeCaller({ cronSecret: 'wrong' }, deps())).toMatchObject({ ok: false, status: 401 })
    expect(await authorizeCaller({ cronSecret: 'short' }, deps({ cronSecret: 'short' }))).toMatchObject({ ok: false }) // too short to be accepted
    expect(await authorizeCaller({}, deps())).toMatchObject({ ok: false, status: 401 })
    expect(await authorizeCaller({ authorization: `Bearer ${tok('aal2')}` }, deps({ validateJwt: async () => null }))).toMatchObject({ ok: false, status: 401 })
    expect(await authorizeCaller({ authorization: `Bearer ${tok('aal1')}` }, deps())).toMatchObject({ ok: false, status: 403, reason: 'two-factor session required' })
    expect(await authorizeCaller({ authorization: `Bearer ${tok('aal2')}` }, deps({ isAdminAs: async () => false }))).toMatchObject({ ok: false, status: 403, reason: 'admins only' })
    expect(await authorizeCaller({ authorization: `Bearer ${tok('aal2')}` }, deps())).toMatchObject({ ok: true })
  })
})

describe.skipIf(isStaging)('032: rollback', () => {
  it('stops queuing and removes the functions; keeps the audit trail', tx(async () => {
    await revoke(EDITOR.id)
    await db.exec(readFileSync(join(__dirname, '..', '..', 'proposals', '032_down.sql'), 'utf8'))
    expect(await n(`select count(*) as n from auth_sync_events`)).toBe(1)
    await restore(EDITOR.id)
    expect(await n(`select count(*) as n from auth_sync_events`)).toBe(1)
    expect(await one(`select to_regprocedure('public.auth_sync_claim(int)') is null as gone`)).toEqual({ gone: true })
  }))
})
