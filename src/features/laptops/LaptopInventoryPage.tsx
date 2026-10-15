import { useMemo, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { COLLECTION_BASE_PATH } from '../../lib/lifecycle'
import { useAuth } from '../auth/useAuth'
import { AddAssetForm } from '../assets/AddAssetForm'
import { StatusBadge } from '../assets/StatusBadge'
import { useLaptopInventory } from './api'
import { useRegisterAvailable, useRetainedDeviceIds } from '../register/api'
import { downloadLaptopExport } from './exportLaptops'
import {
  DEFAULT_LAPTOP_SORT,
  SCOPE_LABELS,
  TAB_LABELS,
  filterLaptops,
  laptopCounts,
  type LaptopSortKey,
  type LaptopTab,
  type ManagementScope,
  type ScopeFilter,
  type SortDirection,
} from './laptopInventory'

export const PAGE_SIZE = 50
const TABS = Object.keys(TAB_LABELS) as LaptopTab[]
const SCOPES = Object.keys(SCOPE_LABELS) as ScopeFilter[]

const COLUMNS: { key: LaptopSortKey; label: string; className?: string }[] = [
  { key: 'serial', label: 'Serial number' },
  { key: 'name', label: 'Model', className: 'hidden md:table-cell' },
  { key: 'assigned_to', label: 'Assigned to' },
  { key: 'status', label: 'Status' },
  { key: 'scope', label: 'Scope', className: 'hidden sm:table-cell' },
  { key: 'updated_at', label: 'Updated', className: 'hidden lg:table-cell' },
]

const SCOPE_BADGE: Record<ManagementScope, string> = {
  np: 'bg-indigo-50 text-indigo-800 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:ring-indigo-800',
  company: 'bg-stone-100 text-stone-700 ring-stone-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700',
}

function readTab(v: string | null): LaptopTab {
  return TABS.includes(v as LaptopTab) ? (v as LaptopTab) : 'all'
}
function readScope(v: string | null): ScopeFilter {
  return SCOPES.includes(v as ScopeFilter) ? (v as ScopeFilter) : 'all'
}

export function LaptopInventoryPage() {
  const { role } = useAuth()
  const navigate = useNavigate()
  // Tab and scope live in the URL so old links (e.g. Active Laptops ->
  // ?tab=active) and bookmarks open the right view.
  const [params, setParams] = useSearchParams()
  const tab = readTab(params.get('tab'))
  const scope = readScope(params.get('scope'))
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState(DEFAULT_LAPTOP_SORT)
  const [showAdd, setShowAdd] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const { rows: all, isLoading, error } = useLaptopInventory()
  // Laptops a former employee keeps with approval (employee register,
  // 20260901000026) are still Provided — label them so they aren't
  // mistaken for laptops pending return.
  const { data: registerAvailable } = useRegisterAvailable()
  const { data: retained } = useRetainedDeviceIds(!!registerAvailable)
  const retainedBy = useMemo(() => new Map((retained ?? []).map((r) => [r.asset_id, r.assignee_name])), [retained])
  const canAdd = role === 'admin' || role === 'editor' || role === 'scanner'
  const canImport = role === 'admin' || role === 'editor'

  const filters = useMemo(() => ({ tab, scope, search, sort }), [tab, scope, search, sort])
  const matching = useMemo(() => (all ? filterLaptops(all, filters) : []), [all, filters])
  const counts = useMemo(() => laptopCounts(all ?? [], filters), [all, filters])

  // The page number belongs to one combination of filters: change any of
  // them and the table starts again at page 1.
  const filterKey = `${tab}|${scope}|${search}|${sort.key}|${sort.direction}`
  const [pageState, setPageState] = useState({ key: filterKey, page: 0 })
  const page = pageState.key === filterKey ? pageState.page : 0
  const setPage = (p: number) => setPageState({ key: filterKey, page: p })
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = matching.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  function setParam(key: 'tab' | 'scope', value: string) {
    const next = new URLSearchParams(params)
    if (value === 'all') next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  function toggleSort(key: LaptopSortKey) {
    setSort((s) =>
      s.key === key
        ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: key === 'updated_at' ? 'desc' : 'asc' },
    )
  }

  async function handleExport() {
    setExportError(null)
    setExporting(true)
    try {
      await downloadLaptopExport(matching, filters)
    } catch (err) {
      console.error('laptop export failed:', err)
      setExportError(getErrorMessage(err, 'Export failed'))
    } finally {
      setExporting(false)
    }
  }

  const detailPath = (r: { source: keyof typeof COLLECTION_BASE_PATH; id: string }) =>
    `${COLLECTION_BASE_PATH[r.source]}/${r.id}`

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, path: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      navigate(path)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Laptop Inventory</h1>
          {all && (
            <p className="text-sm text-neutral-500">
              {all.length} laptops in total · {all.filter((r) => r.scope === 'np').length} NP-managed ·{' '}
              {all.filter((r) => r.scope === 'company').length} Company
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            placeholder="Search serial, model, assignee…"
            aria-label="Search laptops"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input sm:w-64"
          />
          <select
            aria-label="Management scope"
            value={scope}
            onChange={(e) => setParam('scope', e.target.value)}
            className="input sm:w-44"
          >
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All scopes' : SCOPE_LABELS[s]} ({counts.scopes[s]})
              </option>
            ))}
          </select>
          <button
            className="btn-secondary whitespace-nowrap"
            onClick={() => void handleExport()}
            disabled={exporting || matching.length === 0}
          >
            {exporting ? 'Exporting…' : `Export to Excel (${matching.length})`}
          </button>
          {canImport && (
            <Link to="/import" className="btn-secondary whitespace-nowrap text-center">
              Import from Excel
            </Link>
          )}
          {canAdd && (
            <button className="btn-primary whitespace-nowrap" onClick={() => setShowAdd(true)}>
              Add laptop
            </button>
          )}
        </div>
      </div>

      <div role="tablist" aria-label="Laptop status" className="flex gap-1 overflow-x-auto border-b border-stone-200 dark:border-neutral-800">
        {TABS.map((t) => {
          const selected = t === tab
          return (
            <button
              key={t}
              role="tab"
              aria-selected={selected}
              onClick={() => setParam('tab', t)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition ${
                selected
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
              }`}
            >
              {TAB_LABELS[t]}{' '}
              <span className="ml-1 rounded-full bg-stone-100 px-1.5 py-0.5 text-xs tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                {counts.tabs[t]}
              </span>
            </button>
          )
        })}
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {!!error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(error, 'Failed to load laptops')}
        </p>
      )}
      {exportError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {exportError}
        </p>
      )}

      {all && (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                {COLUMNS.map((col) => {
                  const active = sort.key === col.key
                  return (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={`px-4 py-2.5 font-medium ${col.className ?? ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-neutral-800 dark:hover:text-neutral-200"
                      >
                        {col.label}
                        <SortIndicator active={active} direction={sort.direction} />
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const path = detailPath(r)
                return (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() => navigate(path)}
                    onKeyDown={(e) => onRowKeyDown(e, path)}
                    className="cursor-pointer border-t border-stone-100 transition hover:bg-teal-50/40 focus:bg-teal-50/60 focus:outline-none dark:border-neutral-800 dark:hover:bg-neutral-800/60 dark:focus:bg-neutral-800"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={path}
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-xs font-medium text-neutral-900 hover:underline dark:text-neutral-100"
                      >
                        {r.serial}
                      </Link>
                      <span className="mt-0.5 block text-xs text-neutral-500 md:hidden">{r.name}</span>
                      {r.duplicateSerial && (
                        <span className="mt-1 block text-xs font-medium text-red-700 dark:text-red-400">
                          ⚠ Duplicate serial
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-neutral-700 md:table-cell dark:text-neutral-300">{r.name}</td>
                    <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">
                      {r.assigned_to ?? <span className="text-neutral-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} collection="serialized_assets" />
                      {r.status === 'provided' && retainedBy.get(r.id) === r.assigned_to?.trim() && (
                        <span className="mt-1 block text-xs font-medium text-indigo-700 dark:text-indigo-300">
                          Retained by former employee (authorized)
                        </span>
                      )}
                      {r.assignmentMismatch && (
                        <span className="mt-1 block text-xs font-medium text-amber-700 dark:text-amber-400">
                          ⚠ Check assignment
                        </span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span
                        className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${SCOPE_BADGE[r.scope]}`}
                      >
                        {SCOPE_LABELS[r.scope]}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums text-neutral-500 lg:table-cell">
                      {new Date(r.updated_at).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
              {matching.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-4 py-6 text-center text-sm text-neutral-500">
                    No laptops match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {matching.length > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-neutral-500">
          <span>
            Showing {safePage * PAGE_SIZE + 1}–{Math.min(matching.length, (safePage + 1) * PAGE_SIZE)} of{' '}
            {matching.length}
          </span>
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              Previous
            </button>
            <button
              className="btn-secondary"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {showAdd && <AddLaptopModal onClose={() => setShowAdd(false)} />}
    </div>
  )
}

/** Adding a laptop still means choosing which table it belongs to — expressed as its management scope. */
function AddLaptopModal({ onClose }: { onClose: () => void }) {
  const [scope, setScope] = useState<ManagementScope>('company')
  const collection = scope === 'np' ? 'active_laptops_np' : 'serialized_assets'
  return (
    <Modal title="Add laptop" onClose={onClose}>
      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium text-neutral-700 dark:text-neutral-300">Management scope</legend>
        <div className="flex gap-4 text-sm">
          {(['company', 'np'] as const).map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="radio" name="scope" value={s} checked={scope === s} onChange={() => setScope(s)} />
              {s === 'company' ? 'Company (Laptop Inventory)' : 'NP-managed (Next Perimeter)'}
            </label>
          ))}
        </div>
      </fieldset>
      <AddAssetForm key={collection} collection={collection} onCreated={onClose} onCancel={onClose} />
    </Modal>
  )
}

function SortIndicator({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <span aria-hidden="true" className={active ? 'text-teal-600 dark:text-teal-400' : 'text-neutral-300 dark:text-neutral-600'}>
      {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
    </span>
  )
}
