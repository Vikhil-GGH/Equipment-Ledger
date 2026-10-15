import type { AssetStatus } from '../../types/database.types'

/**
 * One Laptop Inventory over the two physical tables, without changing
 * either: `serialized_assets` (company laptops not currently assigned) and
 * `active_laptops_np` (Next Perimeter-managed laptops, plus company laptops
 * temporarily moved there while assigned — see
 * 20260901000021_inventory_active_laptop_moves.sql). Every row keeps its
 * source table so detail pages and lifecycle actions use the right one.
 */
export type LaptopSource = 'serialized_assets' | 'active_laptops_np'
export type ManagementScope = 'np' | 'company'
export type LaptopTab = 'all' | 'active' | 'available' | 'damaged' | 'other'
export type ScopeFilter = 'all' | ManagementScope

export interface LaptopRecord {
  id: string
  name: string
  category: string
  serial: string
  status: AssetStatus
  assigned_to: string | null
  location: string | null
  created_at: string
  updated_at: string
  moved_from_inventory?: boolean | null
}

export interface LaptopRow extends LaptopRecord {
  source: LaptopSource
  scope: ManagementScope
  tab: Exclude<LaptopTab, 'all'>
  /** Status and assignment disagree (e.g. Damaged but still assigned). */
  assignmentMismatch: boolean
  /** Another laptop has the same serial once trimmed and case-folded. */
  duplicateSerial: boolean
}

export const TAB_LABELS: Record<LaptopTab, string> = {
  all: 'All Laptops',
  active: 'Active / Assigned',
  available: 'Available',
  damaged: 'Damaged / Repair',
  other: 'Other',
}

export const SCOPE_LABELS: Record<ScopeFilter, string> = {
  all: 'All',
  np: 'NP-managed',
  company: 'Company',
}

export const STATUS_LABELS: Record<AssetStatus, string> = {
  available: 'Available',
  provided: 'Provided',
  retained: 'Retained',
  damaged: 'Damaged',
  decommissioned: 'Decommissioned',
  nonfunctional: 'Nonfunctional',
  lost: 'Lost',
}

/** Laptops the NP table holds on behalf of Inventory are company laptops. */
export function managementScope(source: LaptopSource, movedFromInventory: boolean | null | undefined): ManagementScope {
  return source === 'active_laptops_np' && !movedFromInventory ? 'np' : 'company'
}

/**
 * "Active / Assigned" means the lifecycle status says the laptop is with an
 * employee — never "it lives in the NP table". Anything not recognised
 * lands in Other, so the All tab and the four tabs always add up.
 */
export function laptopTab(status: AssetStatus | string): Exclude<LaptopTab, 'all'> {
  switch (status) {
    case 'provided':
      return 'active'
    case 'available':
      return 'available'
    case 'damaged':
      return 'damaged'
    default:
      return 'other'
  }
}

export function normalizeSerial(serial: string): string {
  return serial.trim().toLowerCase()
}

/**
 * Combines both tables into one list: one row per asset id (an asset is
 * only ever in one table, but a refetch racing a move could briefly show
 * it in both — keep the most recently updated copy), with scope, tab and
 * data-quality flags derived from the record itself.
 */
export function combineLaptops(
  inventory: LaptopRecord[] | undefined,
  activeNp: LaptopRecord[] | undefined,
): LaptopRow[] {
  const byId = new Map<string, LaptopRow>()
  const add = (records: LaptopRecord[] | undefined, source: LaptopSource) => {
    for (const r of records ?? []) {
      const existing = byId.get(r.id)
      if (existing && existing.updated_at >= r.updated_at) continue
      const tab = laptopTab(r.status)
      const assigned = !!r.assigned_to?.trim()
      byId.set(r.id, {
        ...r,
        source,
        scope: managementScope(source, r.moved_from_inventory),
        tab,
        assignmentMismatch: tab === 'active' ? !assigned : assigned,
        duplicateSerial: false,
      })
    }
  }
  add(inventory, 'serialized_assets')
  add(activeNp, 'active_laptops_np')

  const rows = [...byId.values()]
  const serialCounts = new Map<string, number>()
  for (const r of rows) serialCounts.set(normalizeSerial(r.serial), (serialCounts.get(normalizeSerial(r.serial)) ?? 0) + 1)
  for (const r of rows) r.duplicateSerial = (serialCounts.get(normalizeSerial(r.serial)) ?? 0) > 1
  return rows
}

export function matchesSearch(row: LaptopRow, term: string): boolean {
  const t = term.trim().toLowerCase()
  if (!t) return true
  return [row.serial, row.name, row.assigned_to, row.location, row.category]
    .filter(Boolean)
    .some((v) => v!.toLowerCase().includes(t))
}

export type LaptopSortKey = 'serial' | 'name' | 'assigned_to' | 'status' | 'scope' | 'updated_at'
export type SortDirection = 'asc' | 'desc'

export const DEFAULT_LAPTOP_SORT: { key: LaptopSortKey; direction: SortDirection } = {
  key: 'updated_at',
  direction: 'desc',
}

export function sortLaptops(rows: LaptopRow[], key: LaptopSortKey, direction: SortDirection): LaptopRow[] {
  const sign = direction === 'asc' ? 1 : -1
  const text = (v: string | null | undefined) => v ?? ''
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  const compare: Record<LaptopSortKey, (a: LaptopRow, b: LaptopRow) => number> = {
    serial: (a, b) => cmp(a.serial.trim(), b.serial.trim()),
    name: (a, b) => cmp(a.name, b.name),
    // Unassigned last when ascending.
    assigned_to: (a, b) =>
      !a.assigned_to === !b.assigned_to ? cmp(text(a.assigned_to), text(b.assigned_to)) : a.assigned_to ? -1 : 1,
    status: (a, b) => cmp(STATUS_LABELS[a.status] ?? a.status, STATUS_LABELS[b.status] ?? b.status),
    scope: (a, b) => cmp(SCOPE_LABELS[a.scope], SCOPE_LABELS[b.scope]),
    updated_at: (a, b) => a.updated_at.localeCompare(b.updated_at),
  }
  // Stable, deterministic ties: by serial, then id.
  return [...rows].sort(
    (a, b) => sign * compare[key](a, b) || cmp(a.serial.trim(), b.serial.trim()) || a.id.localeCompare(b.id),
  )
}

export interface LaptopFilters {
  tab: LaptopTab
  scope: ScopeFilter
  search: string
  sort: { key: LaptopSortKey; direction: SortDirection }
}

/** Every row matching the filters, sorted — exactly what the table pages through and what Export writes. */
export function filterLaptops(rows: LaptopRow[], f: LaptopFilters): LaptopRow[] {
  const filtered = rows.filter(
    (r) => (f.tab === 'all' || r.tab === f.tab) && (f.scope === 'all' || r.scope === f.scope) && matchesSearch(r, f.search),
  )
  return sortLaptops(filtered, f.sort.key, f.sort.direction)
}

/** Tab counts honour the scope filter and search; scope counts honour the tab and search. */
export function laptopCounts(rows: LaptopRow[], f: Pick<LaptopFilters, 'tab' | 'scope' | 'search'>) {
  const tabs: Record<LaptopTab, number> = { all: 0, active: 0, available: 0, damaged: 0, other: 0 }
  const scopes: Record<ScopeFilter, number> = { all: 0, np: 0, company: 0 }
  for (const r of rows) {
    if (!matchesSearch(r, f.search)) continue
    if (f.scope === 'all' || r.scope === f.scope) {
      tabs.all++
      tabs[r.tab]++
    }
    if (f.tab === 'all' || r.tab === f.tab) {
      scopes.all++
      scopes[r.scope]++
    }
  }
  return { tabs, scopes }
}
