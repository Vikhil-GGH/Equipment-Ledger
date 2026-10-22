import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AssetCollection } from '../../types/database.types'
import { COLLECTION_BASE_PATH, REFRESH_CONFIRMATION_LABEL } from '../../lib/lifecycle'
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
  const navigate = useNavigate()
  const { data: candidates, isLoading } = useSwapCandidates(collection, asset.id)
  const swap = useSwap(collection)
  const [newAssetId, setNewAssetId] = useState('')
  const [reason, setReason] = useState('')
  const [refreshed, setRefreshed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A Decommissioned replacement must be confirmed as refreshed (same rule as Provide).
  const needsRefresh = candidates?.find((c) => c.id === newAssetId)?.status === 'decommissioned'

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
      const resultCollection = await swap.mutateAsync({
        oldAssetId: asset.id,
        newAssetId,
        reason: reason.trim(),
        refreshConfirmed: needsRefresh ? refreshed : undefined,
      })
      onDone()
      if (resultCollection !== collection) {
        navigate(`${COLLECTION_BASE_PATH[resultCollection]}/${asset.id}`, { replace: true })
      }
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
            onChange={(e) => {
              setNewAssetId(e.target.value)
              setRefreshed(false)
            }}
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

      {needsRefresh && (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm dark:border-amber-800 dark:bg-amber-900/20">
          <input type="checkbox" className="mt-0.5" checked={refreshed} onChange={(e) => setRefreshed(e.target.checked)} />
          <span>
            <span className="font-medium">{REFRESH_CONFIRMATION_LABEL}</span>
            <span className="block text-xs text-neutral-600 dark:text-neutral-400">The replacement is Decommissioned. The confirmation is written into its history.</span>
          </span>
        </label>
      )}

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
          disabled={swap.isPending || !newAssetId || !reason.trim() || (needsRefresh && !refreshed)}
          onClick={() => void confirm()}
        >
          {swap.isPending ? 'Swapping…' : 'Confirm swap'}
        </button>
      </div>
    </div>
  )
}
