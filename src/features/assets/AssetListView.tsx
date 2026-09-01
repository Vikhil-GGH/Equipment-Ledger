import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AssetCollection } from '../../types/database.types'
import { useAuth } from '../auth/useAuth'
import { Modal } from '../../components/Modal'
import { StatusBadge } from './StatusBadge'
import { AddAssetForm } from './AddAssetForm'
import { useAssetsList } from './api'

export function AssetListView({
  collection,
  title,
  basePath,
}: {
  collection: AssetCollection
  title: string
  basePath: string
}) {
  const { role } = useAuth()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const { data: assets, isLoading, error } = useAssetsList(collection, search)

  const canAdd = role === 'admin' || role === 'editor' || role === 'scanner'
  const canImport = role === 'admin' || role === 'editor'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
        <div className="flex gap-2">
          <input
            placeholder="Search name, serial, assignee…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input sm:w-64"
          />
          {canImport && (
            <Link
              to={`/import?target=${collection}`}
              className="btn-secondary whitespace-nowrap"
            >
              Import from Excel
            </Link>
          )}
          {canAdd && (
            <button className="btn-primary whitespace-nowrap" onClick={() => setShowAdd(true)}>
              Add asset
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'Failed to load assets'}
        </p>
      )}
      {!isLoading && assets?.length === 0 && (
        <p className="text-sm text-neutral-500">No assets found.</p>
      )}

      {/* Mobile: cards */}
      <div className="grid grid-cols-1 gap-3 sm:hidden">
        {assets?.map((asset) => (
          <Link key={asset.id} to={`${basePath}/${asset.id}`} className="card block">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-neutral-900 dark:text-neutral-100">{asset.name}</p>
                <p className="font-mono text-xs text-neutral-500">{asset.serial}</p>
              </div>
              <StatusBadge status={asset.status} collection={collection} />
            </div>
            <div className="mt-2 text-sm text-neutral-500">
              {asset.assigned_to && <p>Assigned to {asset.assigned_to}</p>}
              {asset.location && <p>{asset.location}</p>}
            </div>
          </Link>
        ))}
      </div>

      {/* Desktop: table */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-neutral-500 dark:border-neutral-800">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Serial</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Assigned to</th>
              <th className="py-2 pr-4 font-medium">Location</th>
            </tr>
          </thead>
          <tbody>
            {assets?.map((asset) => (
              <tr
                key={asset.id}
                className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900"
              >
                <td className="py-2 pr-4">
                  <Link to={`${basePath}/${asset.id}`} className="font-medium hover:underline">
                    {asset.name}
                  </Link>
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-neutral-500">{asset.serial}</td>
                <td className="py-2 pr-4">
                  <StatusBadge status={asset.status} collection={collection} />
                </td>
                <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                  {asset.assigned_to ?? '—'}
                </td>
                <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                  {asset.location ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal title="Add asset" onClose={() => setShowAdd(false)}>
          <AddAssetForm collection={collection} onCreated={() => setShowAdd(false)} onCancel={() => setShowAdd(false)} />
        </Modal>
      )}
    </div>
  )
}
