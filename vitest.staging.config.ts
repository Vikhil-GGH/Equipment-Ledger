import { defineConfig } from 'vitest/config'

// Checks against the STAGING project through real Supabase Auth + REST
// (supabase/tests/staging). Run with `npm run staging:verify`; the test
// loads .env.staging.local and refuses to run against production.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['supabase/tests/staging/**/*.staging.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: 'threads',
  },
})
