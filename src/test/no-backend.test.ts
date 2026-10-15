import { describe, expect, it } from 'vitest'
import { supabaseConfig } from '../lib/supabase'

describe('unit tests have no real backend', () => {
  it('the Supabase client points at an unreachable local address, never a real project', () => {
    expect(supabaseConfig.url).toBe('http://127.0.0.1:9')
    expect(supabaseConfig.url).not.toMatch(/supabase\.co/)
  })
})
