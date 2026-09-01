import { describe, expect, it } from 'vitest'
import { BULK_ACTION_BUCKETS, requiresFromBucket, resultingBuckets } from './bulkLifecycle'
import type { BulkAction } from '../types/database.types'

const ALL_ACTIONS: BulkAction[] = [
  'receive_stock',
  'issue',
  'return',
  'retain',
  'mark_damaged',
  'repair',
  'decommission',
]

describe('BULK_ACTION_BUCKETS mapping (mirrors perform_bulk_action SQL)', () => {
  it('receive_stock has no source bucket and lands in available', () => {
    expect(BULK_ACTION_BUCKETS.receive_stock.from).toBeNull()
    expect(BULK_ACTION_BUCKETS.receive_stock.to).toBe('available')
  })
  it('issue moves available -> provided', () => {
    expect(BULK_ACTION_BUCKETS.issue).toEqual({
      from: 'available',
      to: 'provided',
      requiresFromBucket: false,
    })
  })
  it('return moves provided -> available', () => {
    expect(BULK_ACTION_BUCKETS.return).toEqual({
      from: 'provided',
      to: 'available',
      requiresFromBucket: false,
    })
  })
  it('retain moves available -> retained', () => {
    expect(BULK_ACTION_BUCKETS.retain).toEqual({
      from: 'available',
      to: 'retained',
      requiresFromBucket: false,
    })
  })
  it('repair moves damaged -> available', () => {
    expect(BULK_ACTION_BUCKETS.repair).toEqual({
      from: 'damaged',
      to: 'available',
      requiresFromBucket: false,
    })
  })
  it('mark_damaged and decommission require an explicit source bucket', () => {
    expect(requiresFromBucket('mark_damaged')).toBe(true)
    expect(requiresFromBucket('decommission')).toBe(true)
  })
  it('every other action has a fixed, unambiguous source', () => {
    for (const action of ALL_ACTIONS) {
      if (action === 'mark_damaged' || action === 'decommission') continue
      expect(requiresFromBucket(action)).toBe(false)
    }
  })
})

describe('resultingBuckets', () => {
  it('resolves fixed-source actions without needing a fromBucket argument', () => {
    expect(resultingBuckets('issue')).toEqual({ from: 'available', to: 'provided' })
    expect(resultingBuckets('repair')).toEqual({ from: 'damaged', to: 'available' })
  })
  it('resolves mark_damaged using the caller-supplied source bucket', () => {
    expect(resultingBuckets('mark_damaged', 'retained')).toEqual({
      from: 'retained',
      to: 'damaged',
    })
  })
  it('resolves decommission using the caller-supplied source bucket', () => {
    expect(resultingBuckets('decommission', 'provided')).toEqual({
      from: 'provided',
      to: 'decommissioned',
    })
  })
  it('returns null when an ambiguous action has no source bucket supplied', () => {
    expect(resultingBuckets('mark_damaged')).toBeNull()
    expect(resultingBuckets('decommission', null)).toBeNull()
  })
  it('receive_stock has no meaningful "from" and resolves to null', () => {
    expect(resultingBuckets('receive_stock')).toBeNull()
  })
})
