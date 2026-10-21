// @vitest-environment node
/**
 * READ-ONLY validation of the unified Laptop Inventory and the offboarding
 * laptop outcome against the STAGING project, through real Supabase Auth +
 * REST, signed in as the staging admin (npm run staging:verify).
 *
 * Staging policy: tests through the real API never change data. They
 * check invariants that must hold for whatever records exist — they never
 * assume seed values and never use existing (possibly hand-edited) records
 * as fixtures. Mutation tests live in supabase/tests/db/*-live.db.test.ts,
 * which create their own records inside a transaction that is always
 * rolled back. Refuses to run against production (lib.mjs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { signInReader } from './reader'
// @ts-expect-error — plain .mjs helper shared with the other staging scripts
import { loadStagingEnv } from '../../../scripts/staging/lib.mjs'
import {
  DEFAULT_LAPTOP_SORT,
  combineLaptops,
  filterLaptops,
  laptopCounts,
  type LaptopRecord,
} from '../../../src/features/laptops/laptopInventory'
import { buildLaptopWorkbook } from '../../../src/features/laptops/exportLaptops'
import { offboardingProgress } from '../../../src/features/offboarding/offboardingProgress'

const env = loadStagingEnv(['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD']) as Record<string, string>
let c: SupabaseClient


async function fetchAll(table: 'serialized_assets' | 'active_laptops_np'): Promise<LaptopRecord[]> {
  const out: LaptopRecord[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from(table).select('*').order('id').range(from, from + 999)
    if (error) throw error
    out.push(...(data as LaptopRecord[]))
    if (data.length < 1000) return out
  }
}
async function exactCount(table: string, filter?: (q: any) => any) {
  let q = c.from(table).select('*', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}
const inventory = async () => combineLaptops(await fetchAll('serialized_assets'), await fetchAll('active_laptops_np'))
const ALL = { tab: 'all', scope: 'all', search: '', sort: DEFAULT_LAPTOP_SORT } as const

beforeAll(async () => {
  ;({ c } = await signInReader(env)) // see reader.ts
}, 60_000)
afterAll(async () => {
  await c?.auth.signOut()
})

describe('Laptop Inventory on staging (read-only)', () => {
  it('All Laptops holds every laptop from both tables exactly once', async () => {
    const rows = await inventory()
    const tableTotal = (await exactCount('serialized_assets')) + (await exactCount('active_laptops_np'))
    expect(rows).toHaveLength(tableTotal)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    expect(filterLaptops(rows, ALL)).toHaveLength(tableTotal)
  })

  it('scope counts match the database: NP-managed = NP table minus laptops moved from Inventory', async () => {
    const { scopes } = laptopCounts(await inventory(), ALL)
    expect(scopes.np).toBe(await exactCount('active_laptops_np', (q) => q.eq('moved_from_inventory', false)))
    expect(scopes.company).toBe((await exactCount('serialized_assets')) + (await exactCount('active_laptops_np', (q) => q.eq('moved_from_inventory', true))))
  })

  it('tabs partition All, and Active / Assigned is exactly the provided laptops', async () => {
    const rows = await inventory()
    const { tabs } = laptopCounts(rows, ALL)
    expect(tabs.active + tabs.available + tabs.damaged + tabs.other).toBe(tabs.all)
    const provided =
      (await exactCount('serialized_assets', (q) => q.eq('status', 'provided'))) +
      (await exactCount('active_laptops_np', (q) => q.eq('status', 'provided')))
    expect(tabs.active).toBe(provided)
    expect(filterLaptops(rows, { ...ALL, tab: 'active' }).every((r) => r.status === 'provided')).toBe(true)
  })

  it('the Excel export contains exactly the filtered, sorted rows, serials as text', async () => {
    const rows = await inventory()
    for (const f of [
      { ...ALL },
      { ...ALL, tab: 'active' as const, scope: 'np' as const },
      { ...ALL, tab: 'available' as const, search: 'syn-inv', sort: { key: 'serial' as const, direction: 'desc' as const } },
    ]) {
      const expected = filterLaptops(rows, f)
      const wb = buildLaptopWorkbook(XLSX, expected, f, new Date())
      const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
      const sheet = back.Sheets.Laptops
      expect(XLSX.utils.sheet_to_json<Record<string, string>>(sheet).map((r) => r['Serial Number'])).toEqual(expected.map((r) => r.serial))
      for (let i = 1; i <= expected.length; i++) expect(sheet[XLSX.utils.encode_cell({ r: i, c: 0 })].t).toBe('s')
    }
  })
})

describe('Offboarding laptop outcome on staging (read-only invariants, migration 024)', () => {
  it('every record is consistent: a chosen outcome matches exactly one legacy flag; a conflict is flagged and nothing chosen', async () => {
    const { data, error } = await c.from('offboarding_checklists').select('*')
    expect(error).toBeNull()
    for (const r of data!) {
      const flags = [r.laptop_received, r.laptop_retained, r.laptop_decommissioned].filter(Boolean).length
      const label = r.employee_name
      if (r.laptop_outcome === 'received' || r.laptop_outcome === 'retained' || r.laptop_outcome === 'decommissioned') {
        expect({ flags, flag: r[`laptop_${r.laptop_outcome}`] }, label).toEqual({ flags: 1, flag: true })
        expect(r.outcome_needs_review, label).toBe(false)
      } else if (r.laptop_outcome === 'not_applicable') {
        expect(flags, label).toBe(0)
      } else if (flags > 1) {
        expect(r.outcome_needs_review, label).toBe(true)
      } else {
        expect(flags, label).toBe(0)
      }
      const p = offboardingProgress(r)
      expect(p.total, label).toBe(2)
      expect(p.done, label).toBe(Number(r.removed_access) + Number(!!r.laptop_outcome))
    }
  })
})
