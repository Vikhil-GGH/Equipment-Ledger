import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AssetAction, AssetCollection } from '../../types/database.types'
import {
  ACTION_LABELS,
  ACTIONS_REQUIRING_ASSIGNEE,
  COLLECTION_BASE_PATH,
  REFRESH_CONFIRMATION_LABEL,
  canSwap,
  getAllowedActions,
  needsRefreshConfirmation,
} from '../../lib/lifecycle'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { usePerformLifecycleAction, type AssetRow } from './api'
import { SwapPanel } from './SwapPanel'

/**
 * Renders only the buttons the current status allows (getAllowedActions) —
 * UX convenience. The RPC's own state-machine check is the real guard, so
 * even a stale/bypassed UI can't push an invalid transition through.
 */
export function ActionPanel({
  collection,
  asset,
}: {
  collection: AssetCollection
  asset: AssetRow
}) {
  const { role } = useAuth()
  const navigate = useNavigate()
  const performAction = usePerformLifecycleAction(collection)
  const [pendingAction, setPendingAction] = useState<AssetAction | null>(null)
  const [showSwap, setShowSwap] = useState(false)
  const [assignedTo, setAssignedTo] = useState('')
  const [detail, setDetail] = useState('')
  const [refreshed, setRefreshed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (role === 'viewer') return null

  const allowed = getAllowedActions(asset.status)
  const visibleActions =
    role === 'scanner' ? allowed.filter((a) => a === 'provide' || a === 'collect') : allowed
  // Swap is Editor/Admin only, same boundary as the other non-basic actions.
  const canShowSwap = (role === 'admin' || role === 'editor') && canSwap(asset.status)

  if (visibleActions.length === 0 && !canShowSwap) return null

  function startAction(action: AssetAction) {
    setError(null)
    setAssignedTo(asset.assigned_to ?? '')
    setDetail('')
    setRefreshed(false)
    setPendingAction(action)
  }

  async function confirm() {
    if (!pendingAction) return
    setError(null)
    try {
      const resultCollection = await performAction.mutateAsync({
        assetId: asset.id,
        action: pendingAction,
        assignedTo: ACTIONS_REQUIRING_ASSIGNEE.has(pendingAction) ? assignedTo : null,
        detail: detail || null,
        refreshConfirmed: needsRefreshConfirmation(asset.status, pendingAction) ? refreshed : undefined,
      })
      setPendingAction(null)
      if (resultCollection !== collection) {
        navigate(`${COLLECTION_BASE_PATH[resultCollection]}/${asset.id}`, { replace: true })
      }
    } catch (err) {
      console.error('perform_lifecycle_action failed:', err)
      setError(getErrorMessage(err, 'Action failed'))
    }
  }

  if (showSwap) {
    return (
      <SwapPanel
        collection={collection}
        asset={asset}
        onDone={() => setShowSwap(false)}
        onCancel={() => setShowSwap(false)}
      />
    )
  }

  if (pendingAction) {
    const needsAssignee = ACTIONS_REQUIRING_ASSIGNEE.has(pendingAction)
    const needsRefresh = needsRefreshConfirmation(asset.status, pendingAction)
    return (
      <div className="card space-y-3">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {ACTION_LABELS[pendingAction]}
        </h3>
        {needsAssignee && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Assigned to
            </span>
            <input
              required
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              className="input"
            />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Note (optional)
          </span>
          <input value={detail} onChange={(e) => setDetail(e.target.value)} className="input" />
        </label>
        {needsRefresh && (
          <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm dark:border-amber-800 dark:bg-amber-900/20">
            <input type="checkbox" className="mt-0.5" checked={refreshed} onChange={(e) => setRefreshed(e.target.checked)} />
            <span>
              <span className="font-medium">{REFRESH_CONFIRMATION_LABEL}</span>
              <span className="block text-xs text-neutral-600 dark:text-neutral-400">
                This device is Decommissioned. The confirmation is written into its history. If it is retired for good, cancel and use “Mark non-functional” instead.
              </span>
            </span>
          </label>
        )}
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
            disabled={performAction.isPending || (needsAssignee && !assignedTo.trim()) || (needsRefresh && !refreshed)}
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
      {visibleActions.map((action) => (
        <button key={action} className="btn-secondary" onClick={() => startAction(action)}>
          {ACTION_LABELS[action]}
        </button>
      ))}
      {canShowSwap && (
        <button className="btn-secondary" onClick={() => setShowSwap(true)}>
          Swap
        </button>
      )}
    </div>
  )
}
