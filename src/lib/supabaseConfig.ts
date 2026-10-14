/**
 * Picks which Supabase project the app talks to.
 *
 * Normal (development/production) mode: VITE_SUPABASE_URL / _ANON_KEY.
 * Staging mode (`npm run dev:staging`): ONLY VITE_STAGING_SUPABASE_URL /
 * _ANON_KEY from .env.staging.local — never the production variables,
 * even if the staging ones are missing — and it refuses to start if the
 * staging settings point at the production project. vite.config.ts runs
 * the same check before the dev server starts; this is the second gate.
 */
export interface SupabaseEnv {
  MODE: string
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_ANON_KEY?: string
  VITE_STAGING_SUPABASE_URL?: string
  VITE_STAGING_SUPABASE_ANON_KEY?: string
}

export interface SupabaseConfig {
  url: string
  anonKey: string
  isStaging: boolean
  projectRef: string | null
}

export function projectRefFromUrl(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url ?? '')
  return m ? m[1] : null
}

/** Legacy anon keys are JWTs carrying the project ref; publishable keys aren't. */
export function projectRefFromKey(key: string | undefined): string | null {
  const parts = (key ?? '').split('.')
  if (parts.length !== 3) return null
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    const ref = (JSON.parse(json) as { ref?: unknown }).ref
    return typeof ref === 'string' ? ref : null
  } catch {
    return null
  }
}

export function resolveSupabaseConfig(env: SupabaseEnv, productionRef: string | null): SupabaseConfig {
  if (env.MODE !== 'staging') {
    if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) {
      throw new Error(
        'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill in your Supabase project values.',
      )
    }
    return {
      url: env.VITE_SUPABASE_URL,
      anonKey: env.VITE_SUPABASE_ANON_KEY,
      isStaging: false,
      projectRef: projectRefFromUrl(env.VITE_SUPABASE_URL),
    }
  }

  const url = env.VITE_STAGING_SUPABASE_URL
  const anonKey = env.VITE_STAGING_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      'Staging mode: VITE_STAGING_SUPABASE_URL and VITE_STAGING_SUPABASE_ANON_KEY must be set in .env.staging.local. (The production settings are never used in staging mode.)',
    )
  }
  const ref = projectRefFromUrl(url)
  if (!ref) throw new Error('Staging mode: VITE_STAGING_SUPABASE_URL must look like https://<ref>.supabase.co')
  if (!productionRef) {
    throw new Error('Staging mode: the production project could not be identified, so staging cannot be told apart from it. Refusing to start.')
  }
  const keyRef = projectRefFromKey(anonKey)
  if (ref === productionRef || keyRef === productionRef) {
    throw new Error('Staging mode: the staging settings point at the PRODUCTION project. Refusing to start.')
  }
  if (keyRef && keyRef !== ref) {
    throw new Error('Staging mode: VITE_STAGING_SUPABASE_ANON_KEY belongs to a different project than VITE_STAGING_SUPABASE_URL.')
  }
  return { url, anonKey, isStaging: true, projectRef: ref }
}
