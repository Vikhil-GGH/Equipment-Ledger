import type { AssetCollection, AssetStatus } from '../../types/database.types'
import { getStatusLabel } from '../../lib/lifecycle'

const COLORS: Record<AssetStatus, string> = {
  available: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  provided: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  retained: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  damaged: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  decommissioned: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  nonfunctional: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
}

export function StatusBadge({
  status,
  collection,
}: {
  status: AssetStatus
  collection: AssetCollection
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${COLORS[status]}`}
    >
      {getStatusLabel(status, collection)}
    </span>
  )
}
