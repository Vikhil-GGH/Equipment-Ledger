import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { AssetCollection } from '../../types/database.types'
import { ImportWizard } from './ImportWizard'

type ImportTarget = AssetCollection | 'bulk_items'

const OPTIONS: { value: ImportTarget; label: string }[] = [
  { value: 'serialized_assets', label: 'Serialized Assets' },
  { value: 'active_laptops_np', label: 'Active Laptops (NP)' },
  { value: 'monitors', label: 'Monitors' },
  { value: 'other_equipment', label: 'Other Equipment' },
  { value: 'bulk_items', label: 'Bulk Stock' },
]

/**
 * General/admin-level importer for mixed sheets — same as the per-collection
 * "Import from Excel" buttons, just with an explicit target picker up
 * front instead of the target being implied by which list page you're on.
 */
export function ImportPage() {
  const [searchParams] = useSearchParams()
  const fromQuery = searchParams.get('target') as ImportTarget | null
  const [target, setTarget] = useState<ImportTarget | null>(
    fromQuery && OPTIONS.some((o) => o.value === fromQuery) ? fromQuery : null,
  )

  if (!target) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Import from Excel
        </h1>
        <p className="text-sm text-neutral-500">What are you importing?</p>
        <div className="flex flex-col gap-2">
          {OPTIONS.map((o) => (
            <button key={o.value} className="btn-primary" onClick={() => setTarget(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return <ImportWizard target={target} />
}
