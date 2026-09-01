import { useAuth } from '../features/auth/useAuth'
import { useAssetStats } from '../features/assets/api'
import { useBulkStockStats } from '../features/bulk/api'
import { BULK_BUCKET_LABELS } from '../lib/bulkLifecycle'
import { getStatusLabel } from '../lib/lifecycle'
import type { AssetCollection } from '../types/database.types'

export function DashboardPage() {
  const { profile } = useAuth()

  return (
    <div className="space-y-4">
      <div className="card">
        <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          Welcome, {profile?.full_name ?? profile?.email}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Signed in as <span className="font-medium">{profile?.role}</span>.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatsCard collection="serialized_assets" title="Serialized Assets" />
        <StatsCard collection="active_laptops_np" title="Active Laptops (NP)" />
        <BulkStatsCard />
      </div>
    </div>
  )
}

function StatsCard({ collection, title }: { collection: AssetCollection; title: string }) {
  const { data, isLoading } = useAssetStats(collection)
  const total = data?.reduce((sum, row) => sum + row.count, 0) ?? 0

  return (
    <div className="card">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
        <span className="text-xs text-neutral-500">{total} total</span>
      </div>
      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      <ul className="grid grid-cols-2 gap-2 text-sm">
        {data?.map((row) => (
          <li key={row.status} className="flex justify-between rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800">
            <span className="text-neutral-600 dark:text-neutral-400">
              {getStatusLabel(row.status, collection)}
            </span>
            <span className="font-medium text-neutral-900 dark:text-neutral-100">{row.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BulkStatsCard() {
  const { data, isLoading } = useBulkStockStats()
  const total = data
    ? data.available + data.provided + data.retained + data.damaged + data.decommissioned
    : 0

  return (
    <div className="card">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Bulk Stock
        </h2>
        <span className="text-xs text-neutral-500">{total} total units</span>
      </div>
      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {data && (
        <ul className="grid grid-cols-2 gap-2 text-sm">
          {(Object.keys(BULK_BUCKET_LABELS) as (keyof typeof BULK_BUCKET_LABELS)[]).map((bucket) => (
            <li
              key={bucket}
              className="flex justify-between rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-800"
            >
              <span className="text-neutral-600 dark:text-neutral-400">
                {BULK_BUCKET_LABELS[bucket]}
              </span>
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                {data[bucket]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
