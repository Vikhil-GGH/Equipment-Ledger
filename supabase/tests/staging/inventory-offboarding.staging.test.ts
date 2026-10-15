// @vitest-environment node
/**
 * Checks the unified Laptop Inventory and the offboarding laptop outcome
 * against the STAGING project through real Supabase Auth + REST, signed in
 * as the staging admin — the same path the browser uses. Run with
 * `npm run staging:verify`. Refuses to run against production (lib.mjs).
 *
 * It performs one lifecycle round trip (Provide, then Collect) on an
 * available synthetic laptop and toggles one offboarding outcome, then
 * restores that outcome. Both leave history rows, as in normal use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
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
async function inventory() {
  return combineLaptops(await fetchAll('serialized_assets'), await fetchAll('active_laptops_np'))
}
const ALL = { tab: 'all', scope: 'all', search: '', sort: DEFAULT_LAPTOP_SORT } as const

beforeAll(async () => {
  c = createClient(env.VITE_STAGING_SUPABASE_URL, env.VITE_STAGING_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await c.auth.signInWithPassword({ email: env.STAGING_ADMIN_EMAIL, password: env.STAGING_ADMIN_PASSWORD })
  if (error) throw error
}, 60_000)

afterAll(async () => {
  await c?.auth.signOut()
})

describe('Laptop Inventory on staging', () => {
  it('All Laptops holds every laptop from both tables exactly once', async () => {
    const rows = await inventory()
    const tableTotal = (await exactCount('serialized_assets')) + (await exactCount('active_laptops_np'))
    expect(rows).toHaveLength(tableTotal)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    expect(filterLaptops(rows, ALL)).toHaveLength(tableTotal)
    console.log(`staging laptops: ${rows.length}`)
  })

  it('scope counts match the database: NP-managed = NP table minus laptops moved from Inventory', async () => {
    const { scopes } = laptopCounts(await inventory(), ALL)
    const np = await exactCount('active_laptops_np', (q) => q.eq('moved_from_inventory', false))
    const moved = await exactCount('active_laptops_np', (q) => q.eq('moved_from_inventory', true))
    expect(scopes.np).toBe(np)
    expect(scopes.company).toBe((await exactCount('serialized_assets')) + moved)
    console.log(`scopes: ${JSON.stringify(scopes)}`)
  })

  it('tabs partition All, and Active / Assigned is exactly the provided laptops (no available NP laptop)', async () => {
    const rows = await inventory()
    const { tabs } = laptopCounts(rows, ALL)
    expect(tabs.active + tabs.available + tabs.damaged + tabs.other).toBe(tabs.all)
    const provided =
      (await exactCount('serialized_assets', (q) => q.eq('status', 'provided'))) +
      (await exactCount('active_laptops_np', (q) => q.eq('status', 'provided')))
    expect(tabs.active).toBe(provided)
    expect(filterLaptops(rows, { ...ALL, tab: 'active' }).every((r) => r.status === 'provided')).toBe(true)
    console.log(`tabs: ${JSON.stringify(tabs)}`)
  })

  it('a lifecycle round trip moves the laptop between tabs, keeping its id and history', async () => {
    const before = await inventory()
    const laptop = before.find((r) => r.source === 'serialized_assets' && r.status === 'available' && /^SYN-INV-/.test(r.serial))
    expect(laptop, 'an available synthetic Inventory laptop to test with').toBeTruthy()
    const historyBefore = await exactCount('serialized_asset_history', (q) => q.eq('asset_id', laptop!.id))

    const { data: movedTo, error: e1 } = await c.rpc('perform_lifecycle_action', {
      p_collection: 'serialized_assets', p_asset_id: laptop!.id, p_action: 'provide', p_assigned_to: 'Test Employee 97',
    })
    expect(e1).toBeNull()
    expect(movedTo).toBe('active_laptops_np')
    const during = (await inventory()).find((r) => r.id === laptop!.id)!
    expect(during).toMatchObject({ tab: 'active', scope: 'company', source: 'active_laptops_np', assigned_to: 'Test Employee 97' })
    expect((await inventory()).length).toBe(before.length) // moved, not duplicated

    const { data: back, error: e2 } = await c.rpc('perform_lifecycle_action', {
      p_collection: 'active_laptops_np', p_asset_id: laptop!.id, p_action: 'collect',
    })
    expect(e2).toBeNull()
    expect(back).toBe('serialized_assets')
    const after = (await inventory()).find((r) => r.id === laptop!.id)!
    expect(after).toMatchObject({ tab: 'available', scope: 'company', source: 'serialized_assets', assigned_to: null })
    expect(await exactCount('serialized_asset_history', (q) => q.eq('asset_id', laptop!.id))).toBe(historyBefore + 2)
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
      const serials = XLSX.utils.sheet_to_json<Record<string, string>>(sheet).map((r) => r['Serial Number'])
      expect(serials).toEqual(expected.map((r) => r.serial))
      expect(new Set(serials).size).toBeLessThanOrEqual(serials.length)
      for (let i = 1; i <= expected.length; i++) expect(sheet[XLSX.utils.encode_cell({ r: i, c: 0 })].t).toBe('s')
    }
  })
})

describe('Offboarding laptop outcome on staging (migration 024)', () => {
  it('existing records were mapped: single outcome kept, conflict flagged, nothing chosen silently', async () => {
    const { data, error } = await c.from('offboarding_checklists').select('*')
    expect(error).toBeNull()
    const conflict = data!.find((r) => r.employee_name === 'Test Employee 46 (legacy conflict)')
    expect(conflict).toMatchObject({ laptop_outcome: null, outcome_needs_review: true, laptop_received: true, laptop_retained: true })
    expect(offboardingProgress(conflict)).toEqual({ done: 1, total: 2 })
    const decom = data!.find((r) => r.laptop_decommissioned && !r.laptop_received && !r.laptop_retained)
    if (decom) expect(decom.laptop_outcome).toBe('decommissioned')
    for (const r of data!) {
      const n = Number(r.laptop_received) + Number(r.laptop_retained) + Number(r.laptop_decommissioned)
      if (n > 1) expect(r.outcome_needs_review).toBe(true)
    }
  })

  it('choosing outcomes through the API keeps exactly one, syncs the legacy flags, and touches no equipment', async () => {
    const { data: rec } = await c
      .from('offboarding_checklists')
      .select('*')
      .eq('employee_name', 'Test Employee 46 (legacy conflict)')
      .single()
    const equipmentBefore = (await inventory()).map((r) => `${r.id}:${r.status}:${r.assigned_to}`).sort()

    const set = async (laptop_outcome: string | null) => {
      const { data, error } = await c.from('offboarding_checklists').update({ laptop_outcome }).eq('id', rec!.id).select('*').single()
      expect(error).toBeNull()
      return data!
    }
    expect(await set('retained')).toMatchObject({
      laptop_outcome: 'retained', outcome_needs_review: false, laptop_received: false, laptop_retained: true, laptop_decommissioned: false,
    })
    expect(await set('not_applicable')).toMatchObject({
      laptop_outcome: 'not_applicable', laptop_received: false, laptop_retained: false, laptop_decommissioned: false,
    })
    expect(offboardingProgress(await set('not_applicable'))).toEqual({ done: 2, total: 2 })
    expect(await set(null)).toMatchObject({ laptop_outcome: null, laptop_received: false, laptop_retained: false })

    expect((await inventory()).map((r) => `${r.id}:${r.status}:${r.assigned_to}`).sort()).toEqual(equipmentBefore)

    // Put the synthetic conflict back exactly as it was, for manual testing.
    const { error } = await c
      .from('offboarding_checklists')
      .update({ laptop_received: true, laptop_retained: true })
      .eq('id', rec!.id)
    expect(error).toBeNull()
    const { data: restored } = await c.from('offboarding_checklists').select('*').eq('id', rec!.id).single()
    expect(restored).toMatchObject({ laptop_outcome: null, outcome_needs_review: true })
  })
})
