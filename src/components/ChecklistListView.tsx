import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getErrorMessage } from '../lib/errors'
import {
  CHECKLIST_STATUS_LABELS,
  DEFAULT_CHECKLIST_SORT,
  checklistStatus,
  sortChecklistRows,
  type ChecklistRecord,
  type ProgressFn,
  type ChecklistSortKey,
  type ChecklistStatus,
  type SortDirection,
} from '../lib/checklistProgress'

type StatusFilter = 'all' | ChecklistStatus

const STATUS_BADGE: Record<ChecklistStatus, string> = {
  not_started: 'bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700',
  pending: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800',
  completed: 'bg-green-50 text-green-800 ring-green-200 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-800',
}

const PROGRESS_FILL: Record<ChecklistStatus, string> = {
  not_started: 'bg-neutral-300 dark:bg-neutral-600',
  pending: 'bg-amber-500',
  completed: 'bg-green-600',
}

const COLUMNS: { key: ChecklistSortKey; label: string; className?: string }[] = [
  { key: 'name', label: 'Employee name' },
  { key: 'started', label: 'Start date', className: 'hidden sm:table-cell' },
  { key: 'progress', label: 'Steps completed' },
  { key: 'status', label: 'Status' },
]

/**
 * The shared list view for step checklists (Onboarding, Offboarding):
 * search, status filter with counts, sortable columns, derived status and
 * progress, and rows that open the checklist. Each page supplies its own
 * data, progress rule and "Start …" action, so the two stay identical in
 * look and behaviour without duplicating the table.
 */
export function ChecklistListView<T extends ChecklistRecord>({
  title,
  records,
  isLoading,
  error,
  search,
  onSearchChange,
  progress,
  flag,
  detailPath,
  startAction,
  progressLabel,
  emptyMessage,
  exportAction,
}: {
  title: string
  records: T[] | undefined
  isLoading: boolean
  error: unknown
  search: string
  onSearchChange: (value: string) => void
  /** The workflow's rule for required steps done / total. */
  progress: ProgressFn<T>
  /** Optional short warning shown under a row's status (e.g. "Needs review"). */
  flag?: (record: T) => string | null
  detailPath: (id: string) => string
  startAction?: ReactNode
  /** e.g. "onboarding progress" — used for the progress bar's accessible name. */
  progressLabel: string
  emptyMessage: string
  /** Optional download button; gets the current filter and sort so it exports exactly this list. */
  exportAction?: (view: { search: string; statusFilter: StatusFilter; sort: typeof DEFAULT_CHECKLIST_SORT }) => ReactNode
}) {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sort, setSort] = useState(DEFAULT_CHECKLIST_SORT)
  // Status is derived from the checklist on every render, so it changes as
  // soon as the list refetches after a step is ticked or unticked.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: 0, not_started: 0, pending: 0, completed: 0 }
    for (const r of records ?? []) {
      const p = progress(r)
      c.all++
      c[checklistStatus(p.done, p.total)]++
    }
    return c
  }, [records, progress])

  const rows = useMemo(() => {
    const filtered = (records ?? []).filter((r) => {
      const p = progress(r)
      return statusFilter === 'all' || checklistStatus(p.done, p.total) === statusFilter
    })
    return sortChecklistRows(filtered, progress, sort.key, sort.direction)
  }, [records, statusFilter, sort, progress])

  function toggleSort(key: ChecklistSortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : // Dates read best newest-first; everything else A→Z / least→most.
          { key, direction: key === 'started' ? 'desc' : 'asc' },
    )
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      navigate(detailPath(id))
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h1>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            placeholder="Search employee…"
            aria-label="Search employee"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input sm:w-64"
          />
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="input sm:w-44"
          >
            <option value="all">All statuses ({counts.all})</option>
            {(Object.keys(CHECKLIST_STATUS_LABELS) as ChecklistStatus[]).map((s) => (
              <option key={s} value={s}>
                {CHECKLIST_STATUS_LABELS[s]} ({counts[s]})
              </option>
            ))}
          </select>
          {exportAction?.({ search, statusFilter, sort })}
          {startAction}
        </div>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {!!error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(error, `Failed to load ${title.toLowerCase()} records`)}
        </p>
      )}
      {!isLoading && !error && records?.length === 0 && (
        <p className="text-sm text-neutral-500">
          {search.trim() ? 'No employees match that search.' : emptyMessage}
        </p>
      )}

      {!!records?.length && (
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
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => {
                const { done, total } = progress(record)
                const status = checklistStatus(done, total)
                const warning = flag?.(record)
                return (
                  <tr
                    key={record.id}
                    tabIndex={0}
                    onClick={() => navigate(detailPath(record.id))}
                    onKeyDown={(e) => onRowKeyDown(e, record.id)}
                    className="cursor-pointer border-t border-stone-100 transition hover:bg-teal-50/40 focus:bg-teal-50/60 focus:outline-none dark:border-neutral-800 dark:hover:bg-neutral-800/60 dark:focus:bg-neutral-800"
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-neutral-900 dark:text-neutral-100">
                        {record.employee_name}
                      </span>
                      <span className="mt-0.5 block text-xs text-neutral-500 sm:hidden">
                        Started {new Date(record.created_at).toLocaleDateString()}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-neutral-600 tabular-nums sm:table-cell dark:text-neutral-400">
                      {new Date(record.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">
                          {done}/{total}
                        </span>
                        <div
                          role="progressbar"
                          aria-label={`${record.employee_name} ${progressLabel}`}
                          aria-valuemin={0}
                          aria-valuemax={total}
                          aria-valuenow={done}
                          className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-stone-100 sm:block dark:bg-neutral-800"
                        >
                          <div
                            className={`h-full rounded-full ${PROGRESS_FILL[status]}`}
                            style={{ width: `${total ? (done / total) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_BADGE[status]}`}
                      >
                        {CHECKLIST_STATUS_LABELS[status]}
                      </span>
                      {warning && (
                        <span className="mt-1 block text-xs font-medium text-amber-700 dark:text-amber-400">
                          ⚠ {warning}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={detailPath(record.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="whitespace-nowrap text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
                      >
                        View details
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="px-4 py-6 text-center text-sm text-neutral-500">
                    No employees with status “{CHECKLIST_STATUS_LABELS[statusFilter as ChecklistStatus]}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SortIndicator({ active, direction }: { active: boolean; direction: SortDirection }) {
  return (
    <span aria-hidden="true" className={active ? 'text-teal-600 dark:text-teal-400' : 'text-neutral-300 dark:text-neutral-600'}>
      {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
    </span>
  )
}
