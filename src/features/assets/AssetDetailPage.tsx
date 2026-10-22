import { Link, useParams } from 'react-router-dom'
import type { AssetCollection } from '../../types/database.types'
import { StatusBadge } from './StatusBadge'
import { ActionPanel } from './ActionPanel'
import { getStatusHint } from '../../lib/lifecycle'
import { useAsset, useAssetHistory } from './api'

export function AssetDetailPage({
  collection,
  basePath,
}: {
  collection: AssetCollection
  basePath: string
}) {
  const { id } = useParams<{ id: string }>()
  const { data: asset, isLoading, error } = useAsset(collection, id)
  const { data: history } = useAssetHistory(collection, id)

  if (isLoading) return <p className="text-sm text-neutral-500">Loading…</p>
  if (error || !asset) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Asset not found'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <Link to={basePath} className="text-sm text-neutral-500 hover:underline">
        ← Back
      </Link>

      <div className="card">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {asset.name}
            </h1>
            <p className="font-mono text-sm text-neutral-500">{asset.serial}</p>
          </div>
          <StatusBadge status={asset.status} collection={collection} />
        </div>
        {getStatusHint(asset.status) && <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{getStatusHint(asset.status)}</p>}

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-neutral-500">Category</dt>
            <dd className="text-neutral-900 dark:text-neutral-100">{asset.category}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Assigned to</dt>
            <dd className="text-neutral-900 dark:text-neutral-100">
              {asset.assigned_to ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">Location</dt>
            <dd className="text-neutral-900 dark:text-neutral-100">{asset.location ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Updated</dt>
            <dd className="text-neutral-900 dark:text-neutral-100">
              {new Date(asset.updated_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      </div>

      <ActionPanel collection={collection} asset={asset} />

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          History
        </h2>
        {!history?.length && <p className="text-sm text-neutral-500">No history yet.</p>}
        <ul className="space-y-3">
          {history?.map((entry) => (
            <li key={entry.id} className="border-l-2 border-neutral-200 pl-3 text-sm dark:border-neutral-800">
              <p className="font-medium text-neutral-900 dark:text-neutral-100">
                {entry.action}
                {entry.actor_email && (
                  <span className="ml-2 font-normal text-neutral-500">by {entry.actor_email}</span>
                )}
              </p>
              {entry.detail && <p className="text-neutral-600 dark:text-neutral-400">{entry.detail}</p>}
              <p className="text-xs text-neutral-400">{new Date(entry.date).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
