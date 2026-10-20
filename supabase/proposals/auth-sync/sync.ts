/**
 * PROPOSAL (032) — the logic of the auth-sync Edge Function, free of Deno
 * and network code so it is unit-tested (supabase/tests/db/auth-sync.db.test.ts).
 * index.ts wires it to Supabase: the database through the service-role
 * client (auth_sync_* functions), Auth through the supported Admin API.
 *
 * Never changes profiles: data access is decided by the database alone.
 */

/** Long enough to mean "until access is restored" (what Supabase's own ban uses). */
export const BAN_DURATION = '876000h'

export interface SyncDb {
  reconcile(): Promise<number>
  claim(limit: number): Promise<{ user_id: string; desired: 'blocked' | 'unblocked'; ban_owned: boolean; ban_until_set: string | null; attempts: number }[]>
  report(userId: string, desired: string, result: SyncResult, banOwned: boolean, banUntilSet: string | null, error: string | null): Promise<void>
}
export interface AuthAdmin {
  /** banned_until as Supabase Auth reports it (null = not banned). */
  getBannedUntil(userId: string): Promise<string | null>
  /** Admin API updateUserById({ ban_duration }); returns the new banned_until. */
  setBan(userId: string, duration: typeof BAN_DURATION | 'none'): Promise<string | null>
}
export type SyncResult = 'blocked' | 'unblocked' | 'already' | 'not_ours' | 'failed'

const activeBan = (until: string | null, now: Date) => !!until && new Date(until).getTime() > now.getTime()
const sameInstant = (a: string | null, b: string | null) => !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1000

/** One account: bring Auth in line with what the database says it should be. */
export async function syncOne(
  auth: AuthAdmin,
  item: { user_id: string; desired: 'blocked' | 'unblocked'; ban_owned: boolean; ban_until_set: string | null },
  now = new Date(),
): Promise<{ result: SyncResult; banOwned: boolean; banUntilSet: string | null; error: string | null }> {
  try {
    const current = await auth.getBannedUntil(item.user_id)
    const ours = item.ban_owned && sameInstant(current, item.ban_until_set)
    if (item.desired === 'blocked') {
      if (activeBan(current, now)) {
        // Already banned: by this sync (keep it) or by someone else (never touch it).
        return ours ? { result: 'already', banOwned: true, banUntilSet: item.ban_until_set, error: null } : { result: 'not_ours', banOwned: false, banUntilSet: null, error: null }
      }
      const until = await auth.setBan(item.user_id, BAN_DURATION)
      if (!activeBan(until, now)) throw new Error('Auth did not report the ban as applied')
      return { result: 'blocked', banOwned: true, banUntilSet: until, error: null }
    }
    // desired: unblocked
    if (!activeBan(current, now)) return { result: 'unblocked', banOwned: false, banUntilSet: null, error: null }
    // Lift only a ban this sync applied, and only if it is still exactly as set.
    if (!ours) return { result: 'not_ours', banOwned: false, banUntilSet: null, error: null }
    const until = await auth.setBan(item.user_id, 'none')
    if (activeBan(until, now)) throw new Error('Auth still reports the account as banned')
    return { result: 'unblocked', banOwned: false, banUntilSet: null, error: null }
  } catch (err) {
    // Ownership is left as it was (report() ignores it for failures).
    return { result: 'failed', banOwned: item.ban_owned, banUntilSet: item.ban_until_set, error: err instanceof Error ? err.message : String(err) }
  }
}

/** One run: reconcile, then sync every claimed account. Idempotent. */
export async function runSync(db: SyncDb, auth: AuthAdmin, limit = 25) {
  const reconciled = await db.reconcile()
  const claimed = await db.claim(limit)
  const results: { user_id: string; result: SyncResult; error: string | null }[] = []
  for (const item of claimed) {
    const r = await syncOne(auth, item)
    await db.report(item.user_id, item.desired, r.result, r.banOwned, r.banUntilSet, r.error)
    results.push({ user_id: item.user_id, result: r.result, error: r.error })
  }
  return { reconciled, results }
}

/** Constant-time string comparison (for the scheduler's shared secret). */
export function safeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

function jwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))
    return JSON.parse(json)
  } catch {
    return null
  }
}

export interface CallerDeps {
  cronSecret: string | undefined
  /** Supabase Auth getUser(jwt): validates the token; null if invalid. */
  validateJwt(jwt: string): Promise<{ id: string } | null>
  /** The database's is_admin() evaluated AS that user (their JWT). */
  isAdminAs(jwt: string): Promise<boolean>
}

/**
 * Who may trigger a run: the scheduler (shared secret), or an admin signed in
 * with two-factor (their own token, checked by Auth AND by the database).
 */
export async function authorizeCaller(headers: { authorization?: string | null; cronSecret?: string | null }, deps: CallerDeps) {
  if (headers.cronSecret != null) {
    if (deps.cronSecret && deps.cronSecret.length >= 32 && safeEqual(headers.cronSecret, deps.cronSecret)) return { ok: true as const, caller: 'scheduler' }
    return { ok: false as const, status: 401, reason: 'bad scheduler secret' }
  }
  const jwt = headers.authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!jwt) return { ok: false as const, status: 401, reason: 'not signed in' }
  const user = await deps.validateJwt(jwt)
  if (!user) return { ok: false as const, status: 401, reason: 'invalid session' }
  if (jwtClaims(jwt)?.aal !== 'aal2') return { ok: false as const, status: 403, reason: 'two-factor session required' }
  if (!(await deps.isAdminAs(jwt))) return { ok: false as const, status: 403, reason: 'admins only' }
  return { ok: true as const, caller: `admin ${user.id}` }
}
