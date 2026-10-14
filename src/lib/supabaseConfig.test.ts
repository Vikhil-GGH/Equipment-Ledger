import { describe, expect, it } from 'vitest'
import { projectRefFromKey, resolveSupabaseConfig } from './supabaseConfig'

const PROD = 'prodprojectref0000001'
const STAGING = 'stagingprojectref0001'

function jwtFor(ref: string) {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', ref, role: 'anon' })}.signature`
}

const prodEnv = {
  VITE_SUPABASE_URL: `https://${PROD}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: jwtFor(PROD),
}

describe('resolveSupabaseConfig — normal mode', () => {
  it('uses the regular variables', () => {
    const cfg = resolveSupabaseConfig({ MODE: 'development', ...prodEnv }, PROD)
    expect(cfg).toMatchObject({ url: prodEnv.VITE_SUPABASE_URL, isStaging: false, projectRef: PROD })
  })

  it('throws when they are missing', () => {
    expect(() => resolveSupabaseConfig({ MODE: 'production' }, PROD)).toThrow(/Missing VITE_SUPABASE_URL/)
  })
})

describe('resolveSupabaseConfig — staging mode', () => {
  const staging = {
    VITE_STAGING_SUPABASE_URL: `https://${STAGING}.supabase.co`,
    VITE_STAGING_SUPABASE_ANON_KEY: jwtFor(STAGING),
  }

  it('uses only the staging variables', () => {
    const cfg = resolveSupabaseConfig({ MODE: 'staging', ...prodEnv, ...staging }, PROD)
    expect(cfg).toMatchObject({ url: staging.VITE_STAGING_SUPABASE_URL, isStaging: true, projectRef: STAGING })
  })

  it('never falls back to the production variables when staging ones are missing', () => {
    expect(() => resolveSupabaseConfig({ MODE: 'staging', ...prodEnv }, PROD)).toThrow(/never used in staging mode/)
  })

  it('refuses a staging URL that is the production project', () => {
    expect(() =>
      resolveSupabaseConfig(
        { MODE: 'staging', VITE_STAGING_SUPABASE_URL: prodEnv.VITE_SUPABASE_URL, VITE_STAGING_SUPABASE_ANON_KEY: jwtFor(STAGING) },
        PROD,
      ),
    ).toThrow(/PRODUCTION/)
  })

  it('refuses the production anon key under a staging URL', () => {
    expect(() =>
      resolveSupabaseConfig({ MODE: 'staging', ...staging, VITE_STAGING_SUPABASE_ANON_KEY: prodEnv.VITE_SUPABASE_ANON_KEY }, PROD),
    ).toThrow(/PRODUCTION/)
  })

  it('refuses a key from a third project', () => {
    expect(() =>
      resolveSupabaseConfig({ MODE: 'staging', ...staging, VITE_STAGING_SUPABASE_ANON_KEY: jwtFor('someotherproject0001') }, PROD),
    ).toThrow(/different project/)
  })

  it('refuses to start when production cannot be identified', () => {
    expect(() => resolveSupabaseConfig({ MODE: 'staging', ...staging }, null)).toThrow(/could not be identified/)
  })

  it('accepts a publishable (non-JWT) staging key', () => {
    const cfg = resolveSupabaseConfig(
      { MODE: 'staging', ...staging, VITE_STAGING_SUPABASE_ANON_KEY: 'sb_publishable_abc123' },
      PROD,
    )
    expect(cfg.isStaging).toBe(true)
  })
})

describe('projectRefFromKey', () => {
  it('reads the ref from a legacy JWT key and ignores anything else', () => {
    expect(projectRefFromKey(jwtFor(STAGING))).toBe(STAGING)
    expect(projectRefFromKey('sb_publishable_abc')).toBeNull()
    expect(projectRefFromKey('not.a.jwt')).toBeNull()
  })
})
