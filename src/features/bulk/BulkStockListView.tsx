import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { Modal } from '../../components/Modal'
import { AddBulkItemForm } from './AddBulkItemForm'
import { useBulkItemsList, type BulkItemRow } from './api'

const BUCKETS: (keyof Pick<
  BulkItemRow,
  'available' | 'provided' | 'retained' | 'damaged' | 'decommissioned'
>)[] = ['available', 'provided', 'retained', 'damaged', 'decommissioned']

export function BulkStockListView() {
  const { role } = useAuth()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const { data: items, isLoading, error } = useBulkItemsList(search)

  const canAdd = role === 'admin' || role === 'editor'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Bulk Stock
        </h1>
        <div className="flex gap-2">
          <input
            placeholder="Search name, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input sm:w-64"
          />
          {canAdd && (
            <Link to="/import?target=bulk_items" className="btn-secondary whitespace-nowrap">
              Import from Excel
            </Link>
          )}
          {canAdd && (
            <button className="btn-primary whitespace-nowrap" onClick={() => setShowAdd(true)}>
              Add item
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'Failed to load bulk stock'}
        </p>
      )}
      {!isLoading && items?.length === 0 && (
        <p className="text-sm text-neutral-500">No bulk stock items found.</p>
      )}

      {/* Mobile: cards */}
      <div className="grid grid-cols-1 gap-3 sm:hidden">
        {items?.map((item) => (
          <Link key={item.id} to={`/bulk-stock/${item.id}`} className="card block">
            <p className="font-medium text-neutral-900 dark:text-neutral-100">{item.name}</p>
            <p className="text-xs text-neutral-500">
              {item.category}
              {item.location ? ` · ${item.location}` : ''}
            </p>
            <div className="mt-2 grid grid-cols-5 gap-1 text-center text-xs">
              {BUCKETS.map((bucket) => (
                <div key={bucket} className="rounded bg-indigo-50/60 py-1 dark:bg-neutral-800">
                  <div className="font-medium text-neutral-900 dark:text-neutral-100">
                    {item[bucket]}
                  </div>
                  <div className="capitalize text-neutral-500">{bucket.slice(0, 4)}</div>
                </div>
              ))}
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
              <th className="py-2 pr-4 font-medium">Category</th>
              <th className="py-2 pr-4 font-medium">Location</th>
              {BUCKETS.map((bucket) => (
                <th key={bucket} className="py-2 pr-4 text-right font-medium capitalize">
                  {bucket}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items?.map((item) => (
              <tr
                key={item.id}
                className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900"
              >
                <td className="py-2 pr-4">
                  <Link to={`/bulk-stock/${item.id}`} className="font-medium hover:underline">
                    {item.name}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                  {item.category}
                </td>
                <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                  {item.location ?? '—'}
                </td>
                {BUCKETS.map((bucket) => (
                  <td
                    key={bucket}
                    className="py-2 pr-4 text-right font-medium text-neutral-900 tabular-nums dark:text-neutral-100"
                  >
                    {item[bucket]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal title="Add bulk stock item" onClose={() => setShowAdd(false)}>
          <AddBulkItemForm onCreated={() => setShowAdd(false)} onCancel={() => setShowAdd(false)} />
        </Modal>
      )}
    </div>
  )
}
