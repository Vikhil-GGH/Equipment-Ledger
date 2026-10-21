// @vitest-environment node
/**
 * READ-ONLY check of the paged backup reader (src/lib/fetchAllRows.ts)
 * through the real Supabase API, signed in as the staging admin
 * (npm run staging:verify). Staging tables are smaller than the API's
 * 1,000-row page, so each table is also read in small pages to exercise
 * real multi-page reads. Nothing is written. Refuses to run against
 * production (lib.mjs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, type PagedSource } from '../../../src/lib/fetchAllRows'
import { BACKUP_TABLES, OPTIONAL_BACKUP_TABLES } from '../../../src/features/data/backupFile'
import { signInReader } from './reader'
// @ts-expect-error — plain .mjs helper shared with the other staging scripts
import { loadStagingEnv } from '../../../scripts/staging/lib.mjs'

const env = loadStagingEnv(['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD']) as Record<string, string>
let c: SupabaseClient


beforeAll(async () => {
  ;({ c } = await signInReader(env)) // see reader.ts
}, 60_000)
afterAll(async () => {
  await c?.auth.signOut()
})

describe('paged backup reads through the real API (read-only)', () => {
  it('every backup table, read 7 rows per page, returns exactly the server count with no row twice — same as one 1,000-row page', async () => {
    for (const table of [...BACKUP_TABLES, ...OPTIONAL_BACKUP_TABLES]) {
      const { count } = await c.from(table).select('*', { count: 'exact', head: true })
      const small = await fetchAllRows<{ id: string }>(c as unknown as PagedSource, table, { pageSize: 7 })
      const big = await fetchAllRows<{ id: string }>(c as unknown as PagedSource, table)
      expect(small.count, table).toBe(count)
      expect(small.rows.map((r) => r.id), table).toEqual(big.rows.map((r) => r.id))
    }
  })
})
