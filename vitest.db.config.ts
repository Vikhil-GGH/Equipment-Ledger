import { defineConfig } from 'vitest/config'

// SQL-layer tests (RLS + SECURITY DEFINER functions) against a disposable
// in-process PostgreSQL, or a staging project via STAGING_DB_URL — see
// supabase/tests/db/harness.ts. Run with `npm run test:db`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['supabase/tests/db/**/*.db.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // One database, ordered stages — never run these files or tests in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
