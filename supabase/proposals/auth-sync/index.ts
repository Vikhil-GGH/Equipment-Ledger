// PROPOSAL (032) — the auth-sync Edge Function (Deno). Not deployed: it
// lives under supabase/proposals/ so no `supabase functions deploy` picks it
// up. On approval it moves to supabase/functions/auth-sync/.
//
// Secrets, server side only (Supabase function secrets — never in the app,
// the repository or the browser):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by Supabase to functions
//   SUPABASE_ANON_KEY                         to evaluate is_admin() as the caller
//   AUTH_SYNC_CRON_SECRET                     ≥ 32 random characters, for the scheduler
//
// Called by: the app right after Remove/Restore access and by the Retry
// button (admin's own two-factor token), and by a schedule every 15 minutes
// (x-auth-sync-secret header) for retries and reconciliation.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { authorizeCaller, runSync, type AuthAdmin, type SyncDb } from './sync.ts'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const db: SyncDb = {
  async reconcile() {
    const { data, error } = await service.rpc('auth_sync_reconcile')
    if (error) throw error
    return data as number
  },
  async claim(limit) {
    const { data, error } = await service.rpc('auth_sync_claim', { p_limit: limit })
    if (error) throw error
    return data ?? []
  },
  async report(userId, desired, result, banOwned, banUntilSet, err) {
    const { error } = await service.rpc('auth_sync_report', { p_user_id: userId, p_desired: desired, p_result: result, p_ban_owned: banOwned, p_ban_until_set: banUntilSet, p_error: err })
    if (error) throw error
  },
}

const auth: AuthAdmin = {
  async getBannedUntil(userId) {
    const { data, error } = await service.auth.admin.getUserById(userId)
    if (error) throw error
    return (data.user as { banned_until?: string | null }).banned_until ?? null
  },
  async setBan(userId, duration) {
    const { data, error } = await service.auth.admin.updateUserById(userId, { ban_duration: duration })
    if (error) throw error
    return (data.user as { banned_until?: string | null }).banned_until ?? null
  },
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 })
  const who = await authorizeCaller(
    { authorization: req.headers.get('authorization'), cronSecret: req.headers.get('x-auth-sync-secret') },
    {
      cronSecret: Deno.env.get('AUTH_SYNC_CRON_SECRET'),
      async validateJwt(jwt) {
        const { data, error } = await service.auth.getUser(jwt)
        return error || !data.user ? null : { id: data.user.id }
      },
      async isAdminAs(jwt) {
        const asUser = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } })
        const { data, error } = await asUser.rpc('is_admin')
        return !error && data === true
      },
    },
  )
  if (!who.ok) return new Response(JSON.stringify({ error: who.reason }), { status: who.status, headers: { 'content-type': 'application/json' } })
  try {
    const out = await runSync(db, auth)
    // Results carry ids and outcomes only — no emails, no tokens.
    return new Response(JSON.stringify({ caller: who.caller, ...out }), { headers: { 'content-type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'sync failed' }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
