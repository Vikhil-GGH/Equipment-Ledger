import { useState } from 'react'
import type { AssetCollection } from '../../types/database.types'
import { getErrorMessage } from '../../lib/errors'
import { useSwap, useSwapCandidates, type AssetRow } from './api'

export function SwapPanel({
  collection,
  asset,
  onDone,
  onCancel,
}: {
  collection: AssetCollection
  asset: AssetRow
  onDone: () => void
  onCancel: () => void
}) {
  const { data: candidates, isLoading } = useSwapCandidates(collection, asset.id)
  const swap = useSwap(collection)
  const [newAssetId, setNewAssetId] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setError(null)
    if (!newAssetId) {
      setError('Select a replacement device')
      return
    }
    if (!reason.trim()) {
      setError('A reason is required for a swap')
      return
    }
    try {
      await swap.mutateAsync({ oldAssetId: asset.id, newAssetId, reason: reason.trim() })
      onDone()
    } catch (err) {
      console.error('perform_swap failed:', err)
      setError(getErrorMessage(err, 'Swap failed'))
    }
  }

  return (
    <div className="card space-y-3">
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        Swap {asset.name} ({asset.serial})
      </h3>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Replacement device
        </span>
        {isLoading && <p className="text-sm text-neutral-500">Loading candidates…</p>}
        {!isLoading && candidates?.length === 0 && (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            No available or decommissioned devices in this collection to swap in.
          </p>
        )}
        {!!candidates?.length && (
          <select
            required
            value={newAssetId}
            onChange={(e) => setNewAssetId(e.target.value)}
            className="input"
          >
            <option value="" disabled>
              Select a device…
            </option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} — {candidate.serial} ({candidate.status})
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Reason (required)
        </span>
        <input
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. screen cracked, won't power on…"
          className="input"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={swap.isPending || !newAssetId || !reason.trim()}
          onClick={() => void confirm()}
        >
          {swap.isPending ? 'Swapping…' : 'Confirm swap'}
        </button>
      </div>
    </div>
  )
}
