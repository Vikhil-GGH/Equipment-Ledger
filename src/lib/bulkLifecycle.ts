import type { BulkAction, BulkBucket } from '../types/database.types'

/**
 * Client-side mirror of the bucket mapping enforced in
 * supabase/migrations/20260901000012_bulk_stock_functions.sql
 * (perform_bulk_action). Keep both in sync.
 *
 * Only mark_damaged/decommission have an ambiguous source bucket (a unit
 * can go bad or get decommissioned from more than one place) — everything
 * else has exactly one unambiguous source, so `from` is fixed here.
 */
export const BULK_ACTION_BUCKETS: Record<
  BulkAction,
  { from: BulkBucket | null; to: BulkBucket; requiresFromBucket: boolean }
> = {
  receive_stock: { from: null, to: 'available', requiresFromBucket: false },
  issue: { from: 'available', to: 'provided', requiresFromBucket: false },
  return: { from: 'provided', to: 'available', requiresFromBucket: false },
  retain: { from: 'available', to: 'retained', requiresFromBucket: false },
  repair: { from: 'damaged', to: 'available', requiresFromBucket: false },
  mark_damaged: { from: null, to: 'damaged', requiresFromBucket: true },
  decommission: { from: null, to: 'decommissioned', requiresFromBucket: true },
}

export const BULK_ACTION_LABELS: Record<BulkAction, string> = {
  receive_stock: 'Receive stock',
  issue: 'Issue',
  return: 'Return',
  retain: 'Retain',
  mark_damaged: 'Mark damaged',
  repair: 'Repair',
  decommission: 'Decommission',
}

export const BULK_BUCKET_LABELS: Record<BulkBucket, string> = {
  available: 'Available',
  provided: 'Provided',
  retained: 'Retained',
  damaged: 'Damaged',
  decommissioned: 'Decommissioned',
}

/** Buckets a caller may pick as the source for mark_damaged/decommission. */
export const AMBIGUOUS_SOURCE_BUCKETS: Record<BulkAction, BulkBucket[]> = {
  receive_stock: [],
  issue: [],
  return: [],
  retain: [],
  repair: [],
  mark_damaged: ['available', 'provided', 'retained'],
  decommission: ['available', 'provided', 'retained', 'damaged'],
}

export function requiresFromBucket(action: BulkAction): boolean {
  return BULK_ACTION_BUCKETS[action].requiresFromBucket
}

export function resultingBuckets(
  action: BulkAction,
  fromBucket?: BulkBucket | null,
): { from: BulkBucket; to: BulkBucket } | null {
  const mapping = BULK_ACTION_BUCKETS[action]
  const from = mapping.requiresFromBucket ? (fromBucket ?? null) : mapping.from
  if (!from) return null
  return { from, to: mapping.to }
}
