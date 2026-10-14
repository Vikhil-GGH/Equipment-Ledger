import { Link, useParams } from 'react-router-dom'
import { StatusBadge } from '../assets/StatusBadge'
import { useAssetHistory } from '../assets/api'
import { useAuth } from '../auth/useAuth'
import type { AssetCollection, AssetStatus } from '../../types/database.types'
import { useEmployeeAssets, useOffboarding, useUpdateOffboardingStep, type OffboardingStep } from './api'

const STEPS: { key: OffboardingStep; label: string }[] = [
  { key: 'removed_access', label: 'Removed access' },
  { key: 'laptop_received', label: 'Laptop received' },
  { key: 'laptop_retained', label: 'Laptop retained' },
  { key: 'laptop_decommissioned', label: 'Laptop decommissioned' },
]

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
  const canEdit = role === 'admin' || role === 'editor'

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

        <ul className="mt-4 space-y-2">
          {STEPS.map((step) => (
            <li key={step.key} className="flex items-center gap-2">
              <input
                id={step.key}
                type="checkbox"
                checked={record[step.key]}
                disabled={!canEdit || updateStep.isPending}
                onChange={(e) => updateStep.mutate({ step: step.key, value: e.target.checked })}
                className="h-4 w-4"
              />
              <label htmlFor={step.key} className="text-sm text-neutral-900 dark:text-neutral-100">
                {step.label}
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-neutral-400">
          This checklist tracks the offboarding paperwork. To actually collect or decommission a
          device, use the Collect / Decommission actions on the asset's own page below.
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
