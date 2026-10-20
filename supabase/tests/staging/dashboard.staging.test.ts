// @vitest-environment node
/**
 * READ-ONLY check that every Overview metric matches its inventory source
 * on the real staging data (npm run staging:verify). The dashboard model is
 * fed the same sources its hooks read (both laptop tables, the stats views,
 * bulk stock), and each number is compared with an independent count taken
 * straight from the tables through the API. Nothing is written. Refuses to
 * run against production (lib.mjs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, type PagedSource } from '../../../src/lib/fetchAllRows'
import { combineLaptops, type LaptopRecord } from '../../../src/features/laptops/laptopInventory'
import { bulkBreakdown, kpis, laptopBreakdown, laptopOwnership, statusBreakdown } from '../../../src/features/dashboard/dashboardModel'
import { signInReader } from './reader'
// @ts-expect-error — plain .mjs helper shared with the other staging scripts
import { loadStagingEnv } from '../../../scripts/staging/lib.mjs'

const env = loadStagingEnv(['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD']) as Record<string, string>
let c: SupabaseClient


beforeAll(async () => {
  ;({ c } = await signInReader(env)) // a synthetic viewer once 031 is applied (reader.ts)
}, 60_000)
afterAll(async () => {
  await c?.auth.signOut()
})

const count = async (table: string, filter?: (q: any) => any) => {
  let q = c.from(table).select('*', { count: 'exact', head: true })
  if (filter) q = filter(q)
  const { count: n, error } = await q
  if (error) throw error
  return n ?? 0
}
const group = (b: ReturnType<typeof statusBreakdown>, g: string) => b.segments.find((s) => s.group === g)!.count

describe('Overview metrics match their sources on staging (read-only)', () => {
  it('laptops, monitors, other equipment, bulk stock, ownership and totals', async () => {
    const page = (t: string) => fetchAllRows<LaptopRecord>(c as unknown as PagedSource, t).then((r) => r.rows)
    const rows = combineLaptops(await page('serialized_assets'), await page('active_laptops_np'))
    const laptops = laptopBreakdown(rows)
    const stats = async (v: string) => ((await c.from(v).select('*')).data ?? []) as { status: any; count: number }[]
    const monitors = statusBreakdown(await stats('monitors_stats'))
    const other = statusBreakdown(await stats('other_equipment_stats'))
    const bulkTotals = (await c.from('bulk_stock_stats').select('*').single()).data
    const bulk = bulkBreakdown(bulkTotals)
    const items = (await c.from('bulk_items').select('*')).data ?? []
    const k = kpis(laptops, monitors, other, bulk, items.length)

    // Independent counts straight from the tables.
    const both = async (f?: (q: any) => any) => (await count('serialized_assets', f)) + (await count('active_laptops_np', f))
    const status = (s: string) => (q: any) => q.eq('status', s)
    expect(k.totalLaptops).toBe(await both())
    expect(k.availableLaptops).toBe(await both(status('available')))
    expect(k.assignedLaptops).toBe(await both(status('provided')))
    expect(group(laptops, 'damaged')).toBe(await both(status('damaged')))
    expect(group(laptops, 'other')).toBe(await both((q) => q.not('status', 'in', '(provided,available,damaged)')))
    expect(laptopOwnership(rows).np).toBe(await count('active_laptops_np', (q) => q.or('moved_from_inventory.is.null,moved_from_inventory.eq.false')))

    for (const [b, t] of [[monitors, 'monitors'], [other, 'other_equipment']] as const) {
      expect(b.total, t).toBe(await count(t))
      expect(group(b, 'active'), t).toBe(await count(t, status('provided')))
      expect(group(b, 'available'), t).toBe(await count(t, status('available')))
      expect(group(b, 'damaged'), t).toBe(await count(t, status('damaged')))
    }
    expect(k.trackedDevices).toBe((await both()) + (await count('monitors')) + (await count('other_equipment')))

    const sum = (key: string) => items.reduce((n: number, i: any) => n + Number(i[key]), 0)
    expect(group(bulk, 'available')).toBe(sum('available'))
    expect(group(bulk, 'active')).toBe(sum('provided'))
    expect(group(bulk, 'damaged')).toBe(sum('damaged'))
    expect(group(bulk, 'other')).toBe(sum('retained') + sum('decommissioned'))
    expect(k.bulkItems).toBe(await count('bulk_items'))

    // Attention: pending returns = open register rows of employees with an
    // offboarding record; duplicate serials = the 027 review view.
    const offboarded = ((await c.from('offboarding_checklists').select('employee_id').not('employee_id', 'is', null)).data ?? []).map((r: any) => r.employee_id)
    const open = (await fetchAllRows<{ id: string; employee_id: string | null; status: string }>(c as unknown as PagedSource, 'equipment_issues', { columns: 'id, employee_id, status' })).rows.filter((r) => r.status === 'open')
    const pending = open.filter((r) => r.employee_id && offboarded.includes(r.employee_id)).length
    expect(pending).toBe(offboarded.length ? await count('equipment_issues', (q) => q.eq('status', 'open').in('employee_id', [...new Set(offboarded)])) : 0)
    const duplicates = await count('serial_duplicate_candidates')

    console.log('overview metrics on staging:', JSON.stringify({
      laptops: Object.fromEntries(laptops.segments.map((s) => [s.group, s.count])),
      ownership: laptopOwnership(rows),
      monitors: monitors.total,
      other: other.total,
      tracked: k.trackedDevices,
      bulkUnits: k.bulkUnits,
      bulkItems: k.bulkItems,
      pendingReturns: pending,
      duplicateSerialDevices: duplicates,
    }))
  })
})
