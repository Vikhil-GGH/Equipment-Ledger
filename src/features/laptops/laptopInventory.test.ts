import { describe, expect, it } from 'vitest'
import type { AssetStatus } from '../../types/database.types'
import {
  DEFAULT_LAPTOP_SORT,
  combineLaptops,
  filterLaptops,
  laptopCounts,
  laptopTab,
  managementScope,
  type LaptopRecord,
} from './laptopInventory'

let n = 0
function laptop(status: AssetStatus | string, extra: Partial<LaptopRecord> = {}): LaptopRecord {
  n++
  return {
    id: `id-${n}`,
    name: 'Dell Latitude 5440',
    category: 'Laptop',
    serial: `SYN-${n}`,
    status: status as AssetStatus,
    assigned_to: status === 'provided' ? `Test Employee ${n}` : null,
    location: 'Tampa Office',
    created_at: `2026-10-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00Z`,
    updated_at: `2026-10-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00Z`,
    ...extra,
  }
}
const many = (count: number, status: AssetStatus, extra: Partial<LaptopRecord> = {}) =>
  Array.from({ length: count }, () => laptop(status, extra))

// The exact staging composition found in Phase 1.
const inventory = [...many(15, 'available'), ...many(2, 'retained'), ...many(3, 'damaged'), ...many(1, 'nonfunctional')]
const movedFromInventory = many(5, 'provided', { moved_from_inventory: true })
const npManaged = [...many(8, 'provided', { moved_from_inventory: false }), ...many(6, 'available', { moved_from_inventory: false })]
const activeNpTable = [...movedFromInventory, ...npManaged]

const ALL = { tab: 'all', scope: 'all', search: '', sort: DEFAULT_LAPTOP_SORT } as const

describe('classification', () => {
  it('scope: only NP-table rows that were not moved from Inventory are NP-managed', () => {
    expect(managementScope('active_laptops_np', false)).toBe('np')
    expect(managementScope('active_laptops_np', null)).toBe('np')
    expect(managementScope('active_laptops_np', true)).toBe('company')
    expect(managementScope('serialized_assets', undefined)).toBe('company')
  })

  it('tabs follow the lifecycle status; anything unexpected lands in Other', () => {
    expect(laptopTab('provided')).toBe('active')
    expect(laptopTab('available')).toBe('available')
    expect(laptopTab('damaged')).toBe('damaged')
    for (const s of ['retained', 'decommissioned', 'nonfunctional', 'some_future_status']) expect(laptopTab(s)).toBe('other')
  })
})

describe('combined inventory on the staging data set', () => {
  const rows = combineLaptops(inventory, activeNpTable)

  it('contains all 40 laptops exactly once', () => {
    expect(rows).toHaveLength(40)
    expect(new Set(rows.map((r) => r.id)).size).toBe(40)
    expect(filterLaptops(rows, ALL)).toHaveLength(40)
  })

  it('splits 14 NP-managed / 26 Company', () => {
    const { scopes } = laptopCounts(rows, ALL)
    expect(scopes).toEqual({ all: 40, np: 14, company: 26 })
  })

  it('tab counts add up to All, and available NP laptops are NOT counted as active', () => {
    const { tabs } = laptopCounts(rows, ALL)
    expect(tabs).toEqual({ all: 40, active: 13, available: 21, damaged: 3, other: 3 })
    expect(tabs.active + tabs.available + tabs.damaged + tabs.other).toBe(tabs.all)
    const npAvailable = filterLaptops(rows, { ...ALL, tab: 'available', scope: 'np' })
    expect(npAvailable).toHaveLength(6)
    expect(filterLaptops(rows, { ...ALL, tab: 'active', scope: 'np' })).toHaveLength(8)
  })

  it('every row keeps its real status and source table', () => {
    for (const r of rows) expect(r.status).toBe([...inventory, ...activeNpTable].find((x) => x.id === r.id)!.status)
    expect(rows.filter((r) => r.source === 'serialized_assets')).toHaveLength(21)
  })
})

describe('no double counting, and data-quality flags', () => {
  it('an id present in both tables (a refetch racing a move) is counted once, newest copy wins', () => {
    const before = laptop('available', { updated_at: '2026-10-14T00:00:00Z' })
    const after = { ...before, status: 'provided' as AssetStatus, assigned_to: 'X', moved_from_inventory: true, updated_at: '2026-10-15T00:00:00Z' }
    const rows = combineLaptops([before], [after])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'active_laptops_np', status: 'provided', scope: 'company' })
  })

  it('flags duplicate serials (trimmed, case-insensitive) across both tables without hiding either record', () => {
    const rows = combineLaptops([laptop('available', { serial: 'SYN-DUP-C' })], [laptop('available', { serial: ' syn-dup-c ' })])
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.duplicateSerial)).toBe(true)
  })

  it('flags status/assignment mismatches', () => {
    const rows = combineLaptops(
      [laptop('damaged', { assigned_to: 'Still Assigned' }), laptop('provided', { assigned_to: null }), laptop('available')],
      [],
    )
    expect(rows.map((r) => r.assignmentMismatch)).toEqual([true, true, false])
  })
})

describe('search, filters and sorting', () => {
  const rows = combineLaptops(
    [
      laptop('available', { serial: 'B-200', name: 'HP EliteBook' }),
      laptop('provided', { serial: 'A-100', assigned_to: 'Test Employee 07' }),
    ],
    [laptop('provided', { serial: 'C-300', moved_from_inventory: false, assigned_to: 'Test Employee 01' })],
  )

  it('searches serial, model, assignee and location, case-insensitively, without special-character errors', () => {
    expect(filterLaptops(rows, { ...ALL, search: 'elitebook' }).map((r) => r.serial)).toEqual(['B-200'])
    expect(filterLaptops(rows, { ...ALL, search: 'employee 07' }).map((r) => r.serial)).toEqual(['A-100'])
    expect(filterLaptops(rows, { ...ALL, search: 'Dell, Inc' })).toEqual([])
  })

  it('combines tab, scope and search, and counts honour each other', () => {
    expect(filterLaptops(rows, { ...ALL, tab: 'active', scope: 'company' }).map((r) => r.serial)).toEqual(['A-100'])
    const c = laptopCounts(rows, { tab: 'active', scope: 'all', search: '' })
    expect(c.scopes).toEqual({ all: 2, np: 1, company: 1 })
  })

  it('sorts by serial and by assignee (unassigned last)', () => {
    expect(filterLaptops(rows, { ...ALL, sort: { key: 'serial', direction: 'asc' } }).map((r) => r.serial)).toEqual(['A-100', 'B-200', 'C-300'])
    expect(filterLaptops(rows, { ...ALL, sort: { key: 'assigned_to', direction: 'asc' } }).map((r) => r.serial)).toEqual(['C-300', 'A-100', 'B-200'])
  })
})
