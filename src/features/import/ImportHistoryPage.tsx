import { Link } from 'react-router-dom'
import { useImportHistory } from './api'

const COLLECTION_LABELS: Record<string, string> = {
  serialized_assets: 'Serialized Assets',
  active_laptops_np: 'Active Laptops (NP)',
  monitors: 'Monitors',
  other_equipment: 'Other Equipment',
  bulk_items: 'Bulk Stock',
}

export function ImportHistoryPage() {
  const { data: events, isLoading, error } = useImportHistory()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Import History
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Every Excel import committed to the ledger, most recent first.
          </p>
        </div>
        <Link to="/import" className="btn-primary shrink-0">
          New import
        </Link>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'Failed to load import history'}
        </p>
      )}

      {events && events.length === 0 && (
        <p className="text-sm text-neutral-500">No imports have been committed yet.</p>
      )}

      <div className="space-y-2">
        {events?.map((event) => (
          <div key={event.id} className="card">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                {event.filename}
              </span>
              <span className="shrink-0 text-xs text-neutral-500">
                {new Date(event.imported_at).toLocaleString()}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-500">
              <span>{COLLECTION_LABELS[event.target_collection] ?? event.target_collection}</span>
              <span>{event.rows_created} created</span>
              <span>{event.rows_updated} updated</span>
              {event.rows_errored > 0 && (
                <span className="text-red-600 dark:text-red-400">{event.rows_errored} errored</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
