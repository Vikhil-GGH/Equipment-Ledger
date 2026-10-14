import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AssetCollection } from '../../types/database.types'
import { getErrorMessage } from '../../lib/errors'
import { AddAssetForm } from '../assets/AddAssetForm'
import { BarcodeScanner } from './BarcodeScanner'
import { useSerialLookup } from './api'

type Stage =
  | { name: 'scanning' }
  | { name: 'looking-up'; serial: string }
  | { name: 'not-found'; serial: string }
  | { name: 'adding'; serial: string; collection: AssetCollection }

const COLLECTION_PATH: Record<AssetCollection, string> = {
  serialized_assets: '/serialized-assets',
  active_laptops_np: '/active-laptops-np',
  monitors: '/monitors',
  other_equipment: '/other-equipment',
}

const COLLECTION_LABEL: Record<AssetCollection, string> = {
  serialized_assets: 'Serialized Asset',
  active_laptops_np: 'Active Laptop (NP)',
  monitors: 'Monitor',
  other_equipment: 'Other Equipment',
}

export function ScanPage() {
  const navigate = useNavigate()
  const lookup = useSerialLookup()
  const [stage, setStage] = useState<Stage>({ name: 'scanning' })
  const [manualSerial, setManualSerial] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleDetected(serial: string) {
    if (!serial) return
    setError(null)
    setStage({ name: 'looking-up', serial })
    try {
      const result = await lookup.mutateAsync(serial)
      if (result) {
        // Found — jump straight to the asset's detail view, zero extra taps.
        navigate(`${COLLECTION_PATH[result.collection]}/${result.id}`)
      } else {
        // Not found — only now do we ask the user anything.
        setStage({ name: 'not-found', serial })
      }
    } catch (err) {
      console.error('serial lookup failed:', err)
      setError(getErrorMessage(err, 'Lookup failed'))
      setStage({ name: 'scanning' })
    }
  }

  function handleManualSubmit(e: FormEvent) {
    e.preventDefault()
    if (manualSerial.trim()) void handleDetected(manualSerial.trim())
  }

  if (stage.name === 'adding') {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Add {COLLECTION_LABEL[stage.collection]}
        </h1>
        <div className="card">
          <AddAssetForm
            collection={stage.collection}
            initialSerial={stage.serial}
            onCreated={(id) => navigate(`${COLLECTION_PATH[stage.collection]}/${id}`)}
            onCancel={() => setStage({ name: 'scanning' })}
          />
        </div>
      </div>
    )
  }

  if (stage.name === 'not-found') {
    return (
      <div className="mx-auto max-w-md space-y-4 text-center">
        <p className="text-sm text-neutral-500">
          No asset found for serial <span className="font-mono">{stage.serial}</span>.
        </p>
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          What kind of equipment is this?
        </h1>
        <div className="flex flex-col gap-2">
          <button
            className="btn-primary"
            onClick={() => setStage({ name: 'adding', serial: stage.serial, collection: 'serialized_assets' })}
          >
            Serialized Asset
          </button>
          <button
            className="btn-primary"
            onClick={() => setStage({ name: 'adding', serial: stage.serial, collection: 'active_laptops_np' })}
          >
            Active Laptop (NP)
          </button>
          <button
            className="btn-primary"
            onClick={() => setStage({ name: 'adding', serial: stage.serial, collection: 'monitors' })}
          >
            Monitor
          </button>
          <button
            className="btn-primary"
            onClick={() =>
              setStage({ name: 'adding', serial: stage.serial, collection: 'other_equipment' })
            }
          >
            Other Equipment
          </button>
          <button className="btn-secondary" onClick={() => setStage({ name: 'scanning' })}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const isLookingUp = stage.name === 'looking-up'

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Scan</h1>
      <p className="text-sm text-neutral-500">
        Point the camera at an asset's barcode or QR tag.
      </p>

      {isLookingUp ? (
        <div className="card text-center text-sm text-neutral-500">
          Looking up <span className="font-mono">{stage.serial}</span>…
        </div>
      ) : (
        <BarcodeScanner onDetected={(v) => void handleDetected(v)} />
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <form onSubmit={handleManualSubmit} className="card space-y-2">
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Or enter serial manually
        </label>
        <div className="flex gap-2">
          <input
            value={manualSerial}
            onChange={(e) => setManualSerial(e.target.value)}
            className="input font-mono"
            placeholder="Serial number"
          />
          <button type="submit" className="btn-secondary whitespace-nowrap" disabled={isLookingUp}>
            Look up
          </button>
        </div>
      </form>
    </div>
  )
}
