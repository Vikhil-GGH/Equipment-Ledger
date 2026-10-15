import { useAuth } from '../features/auth/useAuth'
import { useAssetStats } from '../features/assets/api'
import { useBulkStockStats } from '../features/bulk/api'
import { useLaptopInventory } from '../features/laptops/api'
import { TAB_LABELS, type LaptopTab } from '../features/laptops/laptopInventory'
import { BULK_BUCKET_LABELS } from '../lib/bulkLifecycle'
import { Link } from 'react-router-dom'
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
        <LaptopInventoryCard />
        <StatsCard collection="monitors" title="Monitors" />
        <StatsCard collection="other_equipment" title="Other Equipment" />
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
          <li key={row.status} className="flex justify-between rounded bg-indigo-50/60 px-2 py-1 dark:bg-neutral-800">
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

/**
 * Both laptop tables as one inventory — each laptop counted once, whichever
 * table it currently lives in (see features/laptops/laptopInventory.ts).
 */
function LaptopInventoryCard() {
  const { rows, isLoading } = useLaptopInventory()
  const tabs: Exclude<LaptopTab, 'all'>[] = ['active', 'available', 'damaged', 'other']
  const count = (pred: (r: NonNullable<typeof rows>[number]) => boolean) => rows?.filter(pred).length ?? 0

  return (
    <div className="card">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          <Link to="/laptops" className="hover:underline">
            Laptop Inventory
          </Link>
        </h2>
        <span className="text-xs text-neutral-500">{rows?.length ?? 0} total</span>
      </div>
      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {rows && (
        <>
          <ul className="grid grid-cols-2 gap-2 text-sm">
            {tabs.map((t) => (
              <li key={t}>
                <Link
                  to={`/laptops?tab=${t}`}
                  className="flex justify-between rounded bg-indigo-50/60 px-2 py-1 hover:bg-indigo-100/70 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                >
                  <span className="text-neutral-600 dark:text-neutral-400">{TAB_LABELS[t]}</span>
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{count((r) => r.tab === t)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            {count((r) => r.scope === 'np')} NP-managed · {count((r) => r.scope === 'company')} Company
          </p>
        </>
      )}
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
              className="flex justify-between rounded bg-indigo-50/60 px-2 py-1 dark:bg-neutral-800"
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
