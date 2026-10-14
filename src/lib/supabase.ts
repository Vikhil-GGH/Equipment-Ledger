import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database.types'
import { resolveSupabaseConfig } from './supabaseConfig'

// Staging mode reads only the VITE_STAGING_* settings and refuses to start
// if they point at production — see supabaseConfig.ts and vite.config.ts.
export const supabaseConfig = resolveSupabaseConfig(import.meta.env, __PROD_PROJECT_REF__)

export const supabase = createClient<Database>(supabaseConfig.url, supabaseConfig.anonKey)
