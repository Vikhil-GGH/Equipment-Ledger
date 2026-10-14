/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  // Staging mode only (`npm run dev:staging`, from .env.staging.local).
  readonly VITE_STAGING_SUPABASE_URL?: string
  readonly VITE_STAGING_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Production project ref, injected by vite.config.ts for the staging guard. */
declare const __PROD_PROJECT_REF__: string | null
