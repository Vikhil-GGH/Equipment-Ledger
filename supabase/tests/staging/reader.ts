/**
 * Who the read-only staging checks sign in as.
 *
 * Since 20260901000031 an admin signed in with only a password sees nothing
 * (two-factor is required), and the checks never automate anyone's
 * two-factor. So reads use a dedicated SYNTHETIC viewer account,
 * STAGING_READER_EMAIL / STAGING_READER_PASSWORD in .env.staging.local
 * (staging only; a viewer can read but never change anything). Before 031
 * the staging admin is used, as before.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export async function signInReader(env: Record<string, string>): Promise<{ c: SupabaseClient; who: 'reader' | 'admin'; role: string }> {
  const c = createClient(env.VITE_STAGING_SUPABASE_URL, env.VITE_STAGING_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const reader = !!(env.STAGING_READER_EMAIL && env.STAGING_READER_PASSWORD)
  const { data, error } = await c.auth.signInWithPassword(
    reader ? { email: env.STAGING_READER_EMAIL, password: env.STAGING_READER_PASSWORD } : { email: env.STAGING_ADMIN_EMAIL, password: env.STAGING_ADMIN_PASSWORD },
  )
  if (error) throw error
  const effective = await c.rpc('session_role')
  const has031 = !effective.error
  if (!reader && has031) {
    await c.auth.signOut()
    throw new Error('031 is applied: an admin signed in with only a password sees nothing. Set STAGING_READER_EMAIL / STAGING_READER_PASSWORD (a synthetic staging viewer) for the read checks.')
  }
  const { data: me } = await c.from('profiles').select('role').eq('id', data.user.id).single()
  return { c, who: reader ? 'reader' : 'admin', role: (has031 ? effective.data : me?.role) ?? 'unknown' }
}
