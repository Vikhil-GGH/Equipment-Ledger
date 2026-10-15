import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { useAsset } from '../assets/api'
import { useRegisterAvailable } from '../register/api'
import { OnboardingEquipmentSection } from '../register/OnboardingEquipmentSection'
import {
  useAssignOnboardingDevice,
  useOnboarding,
  useUpdateOnboardingStep,
  type OnboardingStep,
} from './api'

const STEPS: { key: OnboardingStep; label: string }[] = [
  { key: 'identity_created', label: 'Identity created' },
  { key: 'equipment_assigned', label: 'Equipment assigned' },
  { key: 'required_access_provided', label: 'Required access provided' },
  { key: 'onboarding_successful', label: 'Onboarding successful' },
]

export function OnboardingDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { role } = useAuth()
  const { data: record, isLoading, error } = useOnboarding(id)
  const updateStep = useUpdateOnboardingStep(id ?? '')
  // The equipment register (20260901000026) replaces the single-device
  // form once it exists; until then this page works exactly as before.
  const { data: registerAvailable } = useRegisterAvailable()
  const canEdit = role === 'admin' || role === 'editor'

  if (isLoading) return <p className="text-sm text-neutral-500">Loading…</p>
  if (error || !record) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Onboarding record not found'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <Link to="/onboarding" className="text-sm text-neutral-500 hover:underline">
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
          {STEPS.map((step) => {
            const checked = record[step.key]
            const isEquipmentStep = step.key === 'equipment_assigned'
            return (
              <li key={step.key} className="flex items-center gap-2">
                <input
                  id={step.key}
                  type="checkbox"
                  checked={checked}
                  disabled={!canEdit || isEquipmentStep || updateStep.isPending}
                  onChange={(e) => updateStep.mutate({ step: step.key, value: e.target.checked })}
                  className="h-4 w-4"
                />
                <label htmlFor={step.key} className="text-sm text-neutral-900 dark:text-neutral-100">
                  {step.label}
                </label>
                {isEquipmentStep && (
                  <span className="text-xs text-neutral-400">(set automatically below)</span>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {registerAvailable ? (
        <OnboardingEquipmentSection record={record} canEdit={canEdit} />
      ) : record.assigned_asset_id ? (
        <AssignedDeviceSummary assetId={record.assigned_asset_id} />
      ) : (
        canEdit && <AssignDeviceForm onboardingId={record.id} />
      )}
    </div>
  )
}

function AssignedDeviceSummary({ assetId }: { assetId: string }) {
  const { data: asset } = useAsset('active_laptops_np', assetId)
  if (!asset) return null
  return (
    <div className="card">
      <h2 className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        Assigned device
      </h2>
      <Link to={`/active-laptops-np/${asset.id}`} className="text-sm hover:underline">
        {asset.name} — <span className="font-mono">{asset.serial}</span>
      </Link>
    </div>
  )
}

function AssignDeviceForm({ onboardingId }: { onboardingId: string }) {
  const assignDevice = useAssignOnboardingDevice(onboardingId)
  const [serial, setSerial] = useState('')
  const [needsNewDevice, setNeedsNewDevice] = useState(false)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await assignDevice.mutateAsync({
        serial,
        name: needsNewDevice ? name : null,
        category: needsNewDevice ? category : null,
      })
    } catch (err) {
      console.error('onboarding_assign_device failed:', err)
      const message = getErrorMessage(err, 'Failed to assign device')
      // The RPC raises this specific message when the serial isn't found
      // and no name/category were supplied — prompt for them inline rather
      // than asking the user to guess why it failed.
      if (message.includes('are required to add a new device')) {
        setNeedsNewDevice(true)
        setError('That serial isn\'t in Active Laptops (NP) yet — enter its details to add it.')
      } else {
        setError(message)
      }
    }
  }

  return (
    <div className="card">
      <h2 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        Assign equipment
      </h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Serial number
          </span>
          <input
            required
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            className="input font-mono"
          />
        </label>

        {needsNewDevice && (
          <>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Device name
              </span>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
                Category
              </span>
              <input
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="input"
              />
            </label>
          </>
        )}

        {error && (
          <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
            {error}
          </p>
        )}

        <button type="submit" disabled={assignDevice.isPending} className="btn-primary">
          {assignDevice.isPending ? 'Assigning…' : 'Assign device'}
        </button>
      </form>
    </div>
  )
}
