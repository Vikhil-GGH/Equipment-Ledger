// Runs the SQL-layer test suite (supabase/tests/db) against the STAGING
// database. Every test runs inside a transaction that is rolled back, so
// staging's data is unchanged afterwards. Refuses to run against
// production (see lib.mjs).
//
//   npm run staging:test-db
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, loadStagingEnv } from './lib.mjs'

const env = loadStagingEnv(['STAGING_DB_URL'])
const result = spawnSync('npx', ['vitest', 'run', '--config', 'vitest.db.config.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    STAGING_DB_URL: env.STAGING_DB_URL,
    ...(env.STAGING_DB_SSL_CA ? { STAGING_DB_SSL_CA: join(ROOT, env.STAGING_DB_SSL_CA) } : {}),
  },
})
process.exit(result.status ?? 1)
