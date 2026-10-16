import type { AssetStatus } from '../../types/database.types'
import { laptopTab, STATUS_LABELS, type LaptopRow } from '../laptops/laptopInventory'
import { BULK_BUCKET_LABELS } from '../../lib/bulkLifecycle'
import { GROUP_ORDER, type StatusGroup } from './statusColors'

/**
 * Everything the Overview shows, computed from the same sources the
 * inventory pages use — no numbers of its own:
 *   - laptops: the combined Laptop Inventory (both tables, one row per
 *     laptop id, so a laptop that moved tables is never counted twice),
 *     grouped with Laptop Inventory's own tabs;
 *   - monitors / other equipment: the <collection>_stats views;
 *   - bulk stock: bulk_stock_stats (unit quantities, never added to
 *     device counts) and the bulk item list.
 */

export interface StatusCount {
  status: AssetStatus
  count: number
}

export interface BulkTotals {
  available: number
  provided: number
  retained: number
  damaged: number
  decommissioned: number
}

export interface BulkItemLike {
  id: string
  name: string
  available: number
  provided: number
  retained: number
  damaged: number
  decommissioned: number
}

export interface Segment {
  group: StatusGroup
  count: number
  /** Whole-number share of the total, for labels. */
  pct: number
}

export interface Breakdown {
  total: number
  segments: Segment[]
  /** Exact statuses behind each group, e.g. Other = Retained 2 + Lost 1. */
  detail: Record<StatusGroup, { label: string; count: number }[]>
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0)

function breakdown(items: { group: StatusGroup; label: string; count: number }[]): Breakdown {
  const detail: Breakdown['detail'] = { active: [], available: [], damaged: [], other: [] }
  const sums: Record<StatusGroup, number> = { active: 0, available: 0, damaged: 0, other: 0 }
  for (const i of items) {
    if (i.count <= 0) continue
    sums[i.group] += i.count
    const existing = detail[i.group].find((d) => d.label === i.label)
    if (existing) existing.count += i.count
    else detail[i.group].push({ label: i.label, count: i.count })
  }
  const total = GROUP_ORDER.reduce((n, g) => n + sums[g], 0)
  return { total, segments: GROUP_ORDER.map((group) => ({ group, count: sums[group], pct: pct(sums[group], total) })), detail }
}

/** Serialized devices by status — the same grouping Laptop Inventory uses. */
export function statusBreakdown(stats: StatusCount[]): Breakdown {
  return breakdown(stats.map((s) => ({ group: laptopTab(s.status), label: STATUS_LABELS[s.status] ?? s.status, count: Number(s.count) })))
}

export function laptopBreakdown(rows: LaptopRow[]): Breakdown {
  const byStatus = new Map<AssetStatus, number>()
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
  return statusBreakdown([...byStatus].map(([status, count]) => ({ status, count })))
}

/** Bulk buckets in the same groups: Provided = assigned, Retained/Decommissioned = other. */
const BULK_GROUP: Record<keyof BulkTotals, StatusGroup> = {
  provided: 'active',
  available: 'available',
  damaged: 'damaged',
  retained: 'other',
  decommissioned: 'other',
}

export function bulkBreakdown(totals: BulkTotals): Breakdown {
  return breakdown(
    (Object.keys(BULK_GROUP) as (keyof BulkTotals)[]).map((b) => ({ group: BULK_GROUP[b], label: BULK_BUCKET_LABELS[b], count: Number(totals[b]) })),
  )
}

export function laptopOwnership(rows: LaptopRow[]) {
  const np = rows.filter((r) => r.scope === 'np').length
  const company = rows.length - np
  return { np, company, npPct: pct(np, rows.length), companyPct: pct(company, rows.length) }
}

export interface Kpis {
  totalLaptops: number
  availableLaptops: number
  assignedLaptops: number
  availablePct: number
  assignedPct: number
  /** Serialized devices: laptops + monitors + other equipment (each device once). */
  trackedDevices: number
  monitors: number
  otherEquipment: number
  /** Bulk Stock unit quantities — reported separately, never added to devices. */
  bulkUnits: number
  bulkItems: number
}

export function kpis(laptops: Breakdown, monitors: Breakdown, other: Breakdown, bulk: Breakdown, bulkItemCount: number): Kpis {
  const count = (b: Breakdown, g: StatusGroup) => b.segments.find((s) => s.group === g)?.count ?? 0
  return {
    totalLaptops: laptops.total,
    availableLaptops: count(laptops, 'available'),
    assignedLaptops: count(laptops, 'active'),
    availablePct: pct(count(laptops, 'available'), laptops.total),
    assignedPct: pct(count(laptops, 'active'), laptops.total),
    trackedDevices: laptops.total + monitors.total + other.total,
    monitors: monitors.total,
    otherEquipment: other.total,
    bulkUnits: bulk.total,
    bulkItems: bulkItemCount,
  }
}

export interface AttentionItem {
  id: string
  label: string
  detail: string
  count: number
  to?: string
}

/**
 * Only issues the data already records — no thresholds are invented:
 * "out of stock" means a bulk item with 0 available units.
 */
export function attentionItems(input: {
  laptops: Breakdown
  laptopRows: LaptopRow[]
  monitors: Breakdown
  other: Breakdown
  bulk: Breakdown
  bulkItems: BulkItemLike[]
  /** Open register rows of employees with an offboarding record; null = register not available. */
  pendingReturns: number | null
  offboardingNeedsReview: number
  /** Devices sharing a serial (20260901000027); null = not available. */
  duplicateSerials: number | null
  isAdmin: boolean
}): AttentionItem[] {
  const damaged = (b: Breakdown) => b.segments.find((s) => s.group === 'damaged')?.count ?? 0
  const outOfStock = input.bulkItems.filter((i) => Number(i.available) === 0)
  const mismatched = input.laptopRows.filter((r) => r.assignmentMismatch).length
  const items: AttentionItem[] = [
    { id: 'pending-returns', label: 'Equipment pending return', detail: 'Still issued to employees being offboarded', count: input.pendingReturns ?? 0, to: '/offboarding' },
    { id: 'offboarding-review', label: 'Offboarding outcomes to review', detail: 'Legacy records with more than one laptop outcome', count: input.offboardingNeedsReview, to: '/offboarding' },
    { id: 'damaged-laptops', label: 'Damaged laptops', detail: 'Waiting for repair', count: damaged(input.laptops), to: '/laptops?tab=damaged' },
    { id: 'laptop-mismatch', label: 'Laptop status / assignment mismatch', detail: 'Status and assignee disagree (flagged in Laptop Inventory)', count: mismatched, to: '/laptops' },
    { id: 'damaged-monitors', label: 'Damaged monitors', detail: 'Waiting for repair', count: damaged(input.monitors), to: '/monitors' },
    { id: 'damaged-other', label: 'Damaged other equipment', detail: 'Waiting for repair', count: damaged(input.other), to: '/other-equipment' },
    { id: 'damaged-bulk', label: 'Damaged bulk units', detail: 'Units in the Damaged bucket', count: damaged(input.bulk), to: '/bulk-stock' },
    {
      id: 'out-of-stock',
      label: 'Bulk items out of stock',
      detail: outOfStock.length ? outOfStock.map((i) => i.name).join(', ') : '0 available units',
      count: outOfStock.length,
      to: '/bulk-stock',
    },
    {
      id: 'duplicate-serials',
      label: 'Devices sharing a serial number',
      detail: 'Recorded before serial checks — for review',
      count: input.duplicateSerials ?? 0,
      to: input.isAdmin ? '/admin' : undefined,
    },
  ]
  return items.filter((i) => i.count > 0)
}
