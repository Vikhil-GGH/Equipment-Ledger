import { useState } from 'react'
import type { BulkAction, BulkBucket } from '../../types/database.types'
import {
  AMBIGUOUS_SOURCE_BUCKETS,
  BULK_ACTION_LABELS,
  BULK_BUCKET_LABELS,
  requiresFromBucket,
} from '../../lib/bulkLifecycle'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { usePerformBulkAction, type BulkItemRow } from './api'

const ALL_ACTIONS: BulkAction[] = [
  'receive_stock',
  'issue',
  'return',
  'retain',
  'mark_damaged',
  'repair',
  'decommission',
]

export function BulkActionPanel({ item }: { item: BulkItemRow }) {
  const { role } = useAuth()
  const performAction = usePerformBulkAction()
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [fromBucket, setFromBucket] = useState<BulkBucket | ''>('')
  const [detail, setDetail] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (role !== 'admin' && role !== 'editor') return null

  function startAction(action: BulkAction) {
    setError(null)
    setQuantity('1')
    setFromBucket('')
    setDetail('')
    setPendingAction(action)
  }

  async function confirm() {
    if (!pendingAction) return
    setError(null)
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Quantity must be a positive whole number')
      return
    }
    try {
      await performAction.mutateAsync({
        itemId: item.id,
        action: pendingAction,
        quantity: qty,
        fromBucket: fromBucket || null,
        detail: detail || null,
      })
      setPendingAction(null)
    } catch (err) {
      console.error('perform_bulk_action failed:', err)
      setError(getErrorMessage(err, 'Action failed'))
    }
  }

  if (pendingAction) {
    const needsFromBucket = requiresFromBucket(pendingAction)
    const sourceOptions = AMBIGUOUS_SOURCE_BUCKETS[pendingAction]
    return (
      <div className="card space-y-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {BULK_ACTION_LABELS[pendingAction]}
        </h3>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Quantity
          </span>
          <input
            type="number"
            min={1}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="input"
          />
        </label>
        {needsFromBucket && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              From bucket
            </span>
            <select
              required
              value={fromBucket}
              onChange={(e) => setFromBucket(e.target.value as BulkBucket)}
              className="input"
            >
              <option value="" disabled>
                Select a bucket…
              </option>
              {sourceOptions.map((bucket) => (
                <option key={bucket} value={bucket}>
                  {BULK_BUCKET_LABELS[bucket]} ({item[bucket]} available)
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Note (optional)
          </span>
          <input value={detail} onChange={(e) => setDetail(e.target.value)} className="input" />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setPendingAction(null)}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={performAction.isPending || (needsFromBucket && !fromBucket)}
            onClick={() => void confirm()}
          >
            {performAction.isPending ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {ALL_ACTIONS.map((action) => (
        <button key={action} className="btn-secondary" onClick={() => startAction(action)}>
          {BULK_ACTION_LABELS[action]}
        </button>
      ))}
    </div>
  )
}
