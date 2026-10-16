import { describe, expect, it } from 'vitest'
import { combineLaptops, type LaptopRecord } from '../laptops/laptopInventory'
import { attentionItems, bulkBreakdown, kpis, laptopBreakdown, laptopOwnership, statusBreakdown } from './dashboardModel'

const laptop = (id: string, status: LaptopRecord['status'], assigned_to: string | null = null, extra: Partial<LaptopRecord> = {}): LaptopRecord => ({
  id,
  name: 'Dell Latitude 5440',
  category: 'Laptop',
  serial: `SN-${id}`,
  status,
  assigned_to,
  location: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...extra,
})

const inventory = [laptop('1', 'available'), laptop('2', 'available'), laptop('3', 'damaged'), laptop('4', 'retained'), laptop('5', 'lost')]
const np = [
  laptop('6', 'provided', 'Ann'),
  laptop('7', 'provided', 'Bob', { moved_from_inventory: true }),
  laptop('8', 'decommissioned'),
  laptop('9', 'provided', null), // status/assignee mismatch
]
const rows = combineLaptops(inventory, np)

describe('laptops — same grouping as Laptop Inventory, every laptop once', () => {
  it('donut segments are the Laptop Inventory tabs and add up to the total', () => {
    const b = laptopBreakdown(rows)
    expect(b.total).toBe(9)
    expect(Object.fromEntries(b.segments.map((s) => [s.group, s.count]))).toEqual({ active: 3, available: 2, damaged: 1, other: 3 })
    expect(b.segments.reduce((n, s) => n + s.count, 0)).toBe(b.total)
    expect(b.segments.find((s) => s.group === 'active')!.pct).toBe(33)
    expect(b.detail.other).toEqual([
      { label: 'Retained', count: 1 },
      { label: 'Lost', count: 1 },
      { label: 'Decommissioned', count: 1 },
    ])
  })

  it('a laptop that briefly appears in both tables (during a move) is counted once', () => {
    const moving = laptop('1', 'provided', 'Ann', { updated_at: '2026-02-01T00:00:00Z', moved_from_inventory: true })
    const b = laptopBreakdown(combineLaptops(inventory, [...np, moving]))
    expect(b.total).toBe(9)
    expect(b.segments.find((s) => s.group === 'active')!.count).toBe(4)
  })

  it('ownership: NP-managed vs Company (company laptops moved into the NP table stay Company)', () => {
    expect(laptopOwnership(rows)).toEqual({ np: 3, company: 6, npPct: 33, companyPct: 67 })
  })
})

describe('totals', () => {
  const monitors = statusBreakdown([
    { status: 'available', count: 10 },
    { status: 'provided', count: 4 },
    { status: 'nonfunctional', count: 1 },
  ])
  const other = statusBreakdown([])
  const bulk = bulkBreakdown({ available: 150, provided: 50, retained: 2, damaged: 3, decommissioned: 1 })

  it('tracked equipment counts devices only; bulk units are separate and never added', () => {
    const k = kpis(laptopBreakdown(rows), monitors, other, bulk, 9)
    expect(k).toMatchObject({ totalLaptops: 9, availableLaptops: 2, assignedLaptops: 3, trackedDevices: 9 + 15 + 0, bulkUnits: 206, bulkItems: 9 })
    expect(k.availablePct).toBe(22)
  })

  it('bulk buckets map onto the same four groups', () => {
    expect(Object.fromEntries(bulk.segments.map((s) => [s.group, s.count]))).toEqual({ active: 50, available: 150, damaged: 3, other: 3 })
    expect(bulk.detail.other).toEqual([
      { label: 'Retained', count: 2 },
      { label: 'Decommissioned', count: 1 },
    ])
  })

  it('stats counts arriving as strings (bigint) are still added as numbers', () => {
    expect(statusBreakdown([{ status: 'available', count: '7' as unknown as number }]).total).toBe(7)
  })

  it('empty data: zero totals and 0% — no division by zero', () => {
    const b = laptopBreakdown([])
    expect(b.total).toBe(0)
    expect(b.segments.every((s) => s.count === 0 && s.pct === 0)).toBe(true)
  })
})

describe('attention required — only what the data records', () => {
  const base = {
    laptops: laptopBreakdown(rows),
    laptopRows: rows,
    monitors: statusBreakdown([{ status: 'damaged', count: 2 }]),
    other: statusBreakdown([{ status: 'available', count: 3 }]),
    bulk: bulkBreakdown({ available: 5, provided: 0, retained: 0, damaged: 0, decommissioned: 0 }),
    bulkItems: [
      { id: 'b1', name: 'Headset', available: 0, provided: 4, retained: 0, damaged: 0, decommissioned: 0 },
      { id: 'b2', name: 'Mouse', available: 5, provided: 0, retained: 0, damaged: 0, decommissioned: 0 },
    ],
    pendingReturns: 3,
    offboardingNeedsReview: 0,
    duplicateSerials: 6,
    isAdmin: true,
  }

  it('lists each non-zero issue with its count and destination, and hides zero ones', () => {
    const items = attentionItems(base)
    expect(items.map((i) => [i.id, i.count, i.to])).toEqual([
      ['pending-returns', 3, '/offboarding'],
      ['damaged-laptops', 1, '/laptops?tab=damaged'],
      ['laptop-mismatch', 1, '/laptops'],
      ['damaged-monitors', 2, '/monitors'],
      ['out-of-stock', 1, '/bulk-stock'],
      ['duplicate-serials', 6, '/admin'],
    ])
    expect(items.find((i) => i.id === 'out-of-stock')!.detail).toBe('Headset')
  })

  it('no register → no pending-returns item; non-admins get no link to Access & Roles', () => {
    const items = attentionItems({ ...base, pendingReturns: null, isAdmin: false })
    expect(items.find((i) => i.id === 'pending-returns')).toBeUndefined()
    expect(items.find((i) => i.id === 'duplicate-serials')!.to).toBeUndefined()
  })

  it('nothing to report → empty list', () => {
    expect(
      attentionItems({
        ...base,
        laptops: laptopBreakdown([]),
        laptopRows: [],
        monitors: statusBreakdown([]),
        bulkItems: [],
        pendingReturns: 0,
        duplicateSerials: null,
      }),
    ).toEqual([])
  })
})
