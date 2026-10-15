import { Link, useParams } from 'react-router-dom'
import { StatusBadge } from '../assets/StatusBadge'
import { useAssetHistory } from '../assets/api'
import { useAuth } from '../auth/useAuth'
import type { AssetCollection, AssetStatus } from '../../types/database.types'
import {
  LAPTOP_OUTCOMES,
  useEmployeeAssets,
  useOffboarding,
  useSetLaptopOutcome,
  useUpdateOffboardingStep,
  type OffboardingRow,
} from './api'
import { OFFBOARDING_REQUIRED_STEPS, offboardingProgress } from './offboardingProgress'

const COLLECTION_LABELS: Record<AssetCollection, string> = {
  serialized_assets: 'Serialized Assets',
  active_laptops_np: 'Active Laptops (NP)',
  monitors: 'Monitors',
  other_equipment: 'Other Equipment',
}

export function OffboardingTrackPage() {
  const { id } = useParams<{ id: string }>()
  const { role } = useAuth()
  const { data: record, isLoading, error } = useOffboarding(id)
  const { data: assets } = useEmployeeAssets(record?.employee_name)
  const updateStep = useUpdateOffboardingStep(id ?? '')
  const setOutcome = useSetLaptopOutcome(id ?? '')
  const canEdit = role === 'admin' || role === 'editor'
  const saving = updateStep.isPending || setOutcome.isPending

  if (isLoading) return <p className="text-sm text-neutral-500">Loading…</p>
  if (error || !record) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Offboarding record not found'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <Link to="/offboarding" className="text-sm text-neutral-500 hover:underline">
        ← Back
      </Link>

      <div className="card">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {record.employee_name}
        </h1>
        <p className="text-sm text-neutral-500">
          Started {new Date(record.created_at).toLocaleString()}
        </p>

        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          {offboardingProgress(record).done}/{OFFBOARDING_REQUIRED_STEPS} required steps done
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            id="removed_access"
            type="checkbox"
            checked={record.removed_access}
            disabled={!canEdit || saving}
            onChange={(e) => updateStep.mutate({ step: 'removed_access', value: e.target.checked })}
            className="h-4 w-4"
          />
          <label htmlFor="removed_access" className="text-sm text-neutral-900 dark:text-neutral-100">
            Removed access
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-neutral-900 dark:text-neutral-100">Laptop outcome</legend>
          <p className="mb-2 text-xs text-neutral-500">Choose one.</p>
          {record.outcome_needs_review && <ReviewWarning record={record} />}
          <div className="space-y-1.5">
            {[...LAPTOP_OUTCOMES, { value: null, label: 'Not decided yet', hint: '' }].map((o) => (
              <label key={o.value ?? 'none'} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="laptop_outcome"
                  className="mt-0.5 h-4 w-4"
                  checked={record.laptop_outcome === o.value}
                  disabled={!canEdit || saving}
                  onChange={() => setOutcome.mutate(o.value)}
                />
                <span>
                  <span className="text-neutral-900 dark:text-neutral-100">{o.label}</span>
                  {o.hint && <span className="block text-xs text-neutral-500">{o.hint}</span>}
                </span>
              </label>
            ))}
          </div>
          {assets && assets.length === 0 && !record.laptop_outcome && (
            <p className="mt-2 text-xs text-neutral-500">
              No laptop is currently assigned to {record.employee_name} — if they never had one, choose Not applicable.
            </p>
          )}
        </fieldset>

        {(updateStep.error || setOutcome.error) && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {(updateStep.error ?? setOutcome.error) instanceof Error
              ? (updateStep.error ?? setOutcome.error)!.message
              : 'Could not save'}
          </p>
        )}
        <p className="mt-3 text-xs text-neutral-400">
          This checklist tracks the offboarding paperwork only — choosing an outcome doesn't change any
          equipment record. To actually collect or decommission a device, use the Collect / Decommission
          actions on the asset's own page below.
        </p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Assets currently assigned to {record.employee_name}
        </h2>
        {!assets?.length && (
          <p className="text-sm text-neutral-500">No assets currently assigned to this employee.</p>
        )}
        <div className="space-y-3">
          {assets?.map((asset) => (
            <EmployeeAssetCard key={`${asset.collection}-${asset.id}`} asset={asset} />
          ))}
        </div>
      </div>
    </div>
  )
}

function EmployeeAssetCard({
  asset,
}: {
  asset: { id: string; collection: AssetCollection; name: string; serial: string; status: AssetStatus }
}) {
  const { data: history } = useAssetHistory(asset.collection, asset.id)
  const basePath = asset.collection === 'serialized_assets' ? '/serialized-assets' : '/active-laptops-np'

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <Link to={`${basePath}/${asset.id}`} className="font-medium hover:underline">
            {asset.name}
          </Link>
          <p className="font-mono text-xs text-neutral-500">
            {asset.serial} · {COLLECTION_LABELS[asset.collection]}
          </p>
        </div>
        <StatusBadge status={asset.status} collection={asset.collection} />
      </div>
      {!!history?.length && (
        <ul className="mt-3 space-y-1 border-t border-neutral-100 pt-2 text-xs dark:border-neutral-800">
          {history.slice(0, 5).map((entry) => (
            <li key={entry.id} className="text-neutral-500">
              {new Date(entry.date).toLocaleDateString()} — {entry.action}
              {entry.detail ? `: ${entry.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A legacy record had more than one laptop outcome ticked — show which, and ask for one. */
function ReviewWarning({ record }: { record: OffboardingRow }) {
  const ticked = [
    record.laptop_received && 'Laptop received',
    record.laptop_retained && 'Laptop retained',
    record.laptop_decommissioned && 'Laptop decommissioned',
  ].filter(Boolean)
  return (
    <p role="status" className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
      ⚠ Needs review: this record had {ticked.length ? ticked.join(', ') : 'more than one outcome'} all ticked. They
      are alternatives — choose the one that actually happened.
    </p>
  )
}
