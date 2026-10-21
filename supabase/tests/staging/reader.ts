/**
 * Who the read-only staging checks sign in as: the synthetic staging viewer
 * (STAGING_READER_EMAIL / STAGING_READER_PASSWORD in .env.staging.local) when
 * configured, otherwise the staging admin. A viewer can read but never change
 * anything, and the checks never automate anyone's two-factor.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export async function signInReader(env: Record<string, string>): Promise<{ c: SupabaseClient; who: 'reader' | 'admin'; role: string }> {
  const c = createClient(env.VITE_STAGING_SUPABASE_URL, env.VITE_STAGING_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const reader = !!(env.STAGING_READER_EMAIL && env.STAGING_READER_PASSWORD)
  const { data, error } = await c.auth.signInWithPassword(
    reader ? { email: env.STAGING_READER_EMAIL, password: env.STAGING_READER_PASSWORD } : { email: env.STAGING_ADMIN_EMAIL, password: env.STAGING_ADMIN_PASSWORD },
  )
  if (error) throw error
  const { data: me } = await c.from('profiles').select('role').eq('id', data.user.id).single()
  return { c, who: reader ? 'reader' : 'admin', role: me?.role ?? 'unknown' }
}
