import { Link, useParams } from 'react-router-dom'
import { BULK_BUCKET_LABELS } from '../../lib/bulkLifecycle'
import { BulkActionPanel } from './BulkActionPanel'
import { useBulkItem, useBulkItemHistory } from './api'

const BUCKETS = ['available', 'provided', 'retained', 'damaged', 'decommissioned'] as const

export function BulkItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: item, isLoading, error } = useBulkItem(id)
  const { data: history } = useBulkItemHistory(id)

  if (isLoading) return <p className="text-sm text-neutral-500">Loading…</p>
  if (error || !item) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Item not found'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <Link to="/bulk-stock" className="text-sm text-neutral-500 hover:underline">
        ← Back
      </Link>

      <div className="card">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {item.name}
        </h1>
        <p className="text-sm text-neutral-500">
          {item.category}
          {item.location ? ` · ${item.location}` : ''}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {BUCKETS.map((bucket) => (
            <div key={bucket} className="rounded-lg bg-indigo-50/60 p-3 text-center dark:bg-neutral-800">
              <div className="text-xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
                {item[bucket]}
              </div>
              <div className="text-xs text-neutral-500">{BULK_BUCKET_LABELS[bucket]}</div>
            </div>
          ))}
        </div>
      </div>

      <BulkActionPanel item={item} />

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          History
        </h2>
        {!history?.length && <p className="text-sm text-neutral-500">No history yet.</p>}
        <ul className="space-y-3">
          {history?.map((entry) => (
            <li
              key={entry.id}
              className="border-l-2 border-neutral-200 pl-3 text-sm dark:border-neutral-800"
            >
              <p className="font-medium text-neutral-900 dark:text-neutral-100">
                {entry.action}
                <span className="ml-2 font-normal text-neutral-500">
                  qty {entry.quantity}
                  {entry.actor_email && <> · by {entry.actor_email}</>}
                </span>
              </p>
              {entry.detail && (
                <p className="text-neutral-600 dark:text-neutral-400">{entry.detail}</p>
              )}
              <p className="text-xs text-neutral-400">{new Date(entry.date).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
