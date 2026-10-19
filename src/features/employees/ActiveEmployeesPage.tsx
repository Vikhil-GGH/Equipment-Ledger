import { useMemo, useState } from 'react'
import { getErrorMessage } from '../../lib/errors'
import { saveFile } from '../../lib/xlsxWorkbook'
import { useAuth } from '../auth/useAuth'
import { useDirectoryAvailable, useEmployeeDirectory, useSetEmploymentStatus } from './api'
import {
  DEFAULT_VIEW,
  EMPLOYMENT_LABELS,
  PAGE_SIZES,
  SHOW_LABELS,
  displayNames,
  distinctValues,
  filterEmployees,
  paginate,
  type DirectoryEmployee,
  type DirectorySortKey,
  type DirectoryView,
  type ShowFilter,
} from './directoryModel'
import { EmployeeModal } from './EmployeeModal'
import { EmployeeImportModal } from './EmployeeImportModal'

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
    </svg>
  )
}
function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V9m0 0-4 4m4-4 4 4M5 4h14" />
    </svg>
  )
}

const COLUMNS: { label: string; sort?: DirectorySortKey; className?: string }[] = [
  { label: 'First name', sort: 'name' },
  { label: 'Last name', sort: 'name' },
  { label: 'Current department', sort: 'department' },
  { label: 'Primary job title', className: 'hidden lg:table-cell' },
  { label: 'Employee Status' },
  { label: 'Manager', className: 'hidden lg:table-cell' },
  { label: 'Employee start date', sort: 'start_date', className: 'hidden md:table-cell' },
  { label: 'Work email address', className: 'hidden md:table-cell' },
]

export function ActiveEmployeesPage() {
  const { role } = useAuth()
  const canEdit = role === 'admin' || role === 'editor'
  const available = useDirectoryAvailable()
  const directory = useEmployeeDirectory(!!available.data)
  const setStatus = useSetEmploymentStatus()
  const [view, setView] = useState<DirectoryView>(DEFAULT_VIEW)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  const [editing, setEditing] = useState<DirectoryEmployee | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null)

  const all = directory.data
  const activeCount = useMemo(() => (all ?? []).filter((e) => e.employment_status === 'active').length, [all])
  const rehires = useMemo(() => (all ?? []).filter((e) => e.reactivation_pending), [all])
  const decisions = useMemo(() => (all ?? []).filter((e) => e.status_decision_required && !e.reactivation_pending), [all])
  const [deciding, setDeciding] = useState<{ id: string; status: 'active' | 'inactive' } | null>(null)
  const departments = useMemo(() => distinctValues(all ?? [], (e) => e.department), [all])
  const hrStatuses = useMemo(() => distinctValues(all ?? [], (e) => e.hr_status), [all])
  const matching = useMemo(() => (all ? filterEmployees(all, view) : []), [all, view])
  const pageInfo = paginate(matching, page, pageSize)

  const update = (patch: Partial<DirectoryView>) => {
    setView((v) => ({ ...v, ...patch }))
    setPage(1)
  }
  function toggleSort(key: DirectorySortKey) {
    update({ sort: view.sort.key === key ? { key, direction: view.sort.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: key === 'start_date' ? 'desc' : 'asc' } })
  }

  async function download() {
    setExporting(true)
    setMessage(null)
    try {
      const XLSX = await import('xlsx')
      const { buildEmployeeWorkbook, employeeExportFilename, employeeWorkbookBytes } = await import('./exportEmployees')
      const now = new Date()
      saveFile(employeeExportFilename(now), employeeWorkbookBytes(XLSX, buildEmployeeWorkbook(XLSX, matching, view, now)))
      setMessage({ kind: 'status', text: `Downloaded ${matching.length} employee${matching.length === 1 ? '' : 's'}.` })
    } catch (err) {
      setMessage({ kind: 'error', text: getErrorMessage(err, 'Download failed') })
    } finally {
      setExporting(false)
    }
  }

  async function reactivate(e: DirectoryEmployee) {
    setMessage(null)
    try {
      await setStatus.mutateAsync({ id: e.id, status: 'active', note: 'Rehire reactivated' })
      setMessage({ kind: 'status', text: `${e.full_name} is Active again.` })
    } catch (err) {
      setMessage({ kind: 'error', text: getErrorMessage(err, 'Could not reactivate') })
    }
  }

  async function decide(e: DirectoryEmployee, status: 'active' | 'inactive') {
    setMessage(null)
    try {
      await setStatus.mutateAsync({ id: e.id, status, note: `Decision: Employee Status "${e.hr_status ?? ''}" reviewed` })
      setDeciding(null)
      setMessage({ kind: 'status', text: `${e.full_name} is now ${status === 'active' ? 'Active' : 'Inactive / Offboarded'}.` })
    } catch (err) {
      setMessage({ kind: 'error', text: getErrorMessage(err, 'Could not change the status') })
    }
  }

  if (available.data === false) {
    return (
      <div className="space-y-2">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Active Employees</h1>
        <p className="text-sm text-neutral-500">This database doesn&apos;t have the employee directory yet (migration 20260901000028).</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Active Employees</h1>
          <p className="text-sm text-neutral-500">
            <span className="font-semibold tabular-nums text-neutral-800 dark:text-neutral-200" data-testid="active-count">
              {all ? activeCount : '…'}
            </span>{' '}
            active employee{activeCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" className="btn-secondary inline-flex items-center justify-center gap-1.5 whitespace-nowrap" onClick={() => void download()} disabled={exporting || !all}>
            <DownloadIcon /> {exporting ? 'Preparing…' : 'Download Excel'}
          </button>
          {canEdit && (
            <>
              <button type="button" className="btn-secondary inline-flex items-center justify-center gap-1.5 whitespace-nowrap" onClick={() => setImporting(true)} disabled={!all}>
                <UploadIcon /> Upload Excel
              </button>
              <button type="button" className="btn-primary whitespace-nowrap" onClick={() => setEditing('new')}>
                Add employee
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <input
          placeholder="Search name, email, department, title, manager…"
          aria-label="Search employees"
          value={view.search}
          onChange={(e) => update({ search: e.target.value })}
          className="input sm:w-80"
        />
        <select aria-label="Show" value={view.show} onChange={(e) => update({ show: e.target.value as ShowFilter })} className="input sm:w-48">
          {(Object.keys(SHOW_LABELS) as ShowFilter[]).map((s) => (
            <option key={s} value={s}>
              {SHOW_LABELS[s]}
            </option>
          ))}
        </select>
        <select aria-label="Filter by department" value={view.department} onChange={(e) => update({ department: e.target.value })} className="input sm:w-48">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select aria-label="Filter by employee status" value={view.hrStatus} onChange={(e) => update({ hrStatus: e.target.value })} className="input sm:w-48">
          <option value="">All employee statuses</option>
          {hrStatuses.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </div>

      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-teal-700 dark:text-teal-400'}`}>
          {message.text}
        </p>
      )}

      {rehires.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
          <p className="font-medium text-amber-900 dark:text-amber-200">Rehires awaiting reactivation</p>
          <p className="text-xs text-amber-800/80 dark:text-amber-300/80">They completed a new onboarding after being offboarded. They stay inactive until reactivated.</p>
          <ul className="mt-2 space-y-1">
            {rehires.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <span>{e.full_name}</span>
                {canEdit && (
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void reactivate(e)} disabled={setStatus.isPending}>
                    Reactivate
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {decisions.length > 0 && (
        <section aria-label="Employment status decisions" className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
          <p className="font-medium text-amber-900 dark:text-amber-200">Employment status needs a decision</p>
          <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
            Their Employee Status doesn&apos;t say Active, so onboarding didn&apos;t activate them. Nothing happens until you decide; equipment is never affected.
          </p>
          <ul className="mt-2 space-y-1">
            {decisions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {e.full_name} <span className="text-xs text-neutral-500">— Employee Status “{e.hr_status || 'blank'}”</span>
                </span>
                {canEdit &&
                  (deciding?.id === e.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-medium">Make {e.full_name} {deciding.status === 'active' ? 'Active' : 'Inactive / Offboarded'}?</span>
                      <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void decide(e, deciding.status)} disabled={setStatus.isPending}>
                        Confirm
                      </button>
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setDeciding(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="flex gap-2">
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setDeciding({ id: e.id, status: 'active' })}>
                        Make Active
                      </button>
                      <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setDeciding({ id: e.id, status: 'inactive' })}>
                        Mark Inactive
                      </button>
                    </span>
                  ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(available.isLoading || directory.isLoading) && <p className="text-sm text-neutral-500">Loading…</p>}
      {(available.error || directory.error) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(available.error ?? directory.error, 'Failed to load employees')}
        </p>
      )}

      {all && (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
              <tr>
                {COLUMNS.map((c) => {
                  const active = !!c.sort && view.sort.key === c.sort
                  return (
                    <th
                      key={c.label}
                      scope="col"
                      aria-sort={active ? (view.sort.direction === 'asc' ? 'ascending' : 'descending') : c.sort ? 'none' : undefined}
                      className={`px-4 py-2.5 font-medium ${c.className ?? ''}`}
                    >
                      {c.sort ? (
                        <button type="button" onClick={() => toggleSort(c.sort!)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-neutral-800 dark:hover:text-neutral-200">
                          {c.label}
                          <span aria-hidden="true" className={active ? 'text-teal-600 dark:text-teal-400' : 'text-neutral-300 dark:text-neutral-600'}>
                            {active ? (view.sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  )
                })}
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pageInfo.rows.map((e) => {
                const names = displayNames(e)
                return (
                  <tr key={e.id} className="border-t border-stone-100 dark:border-neutral-800">
                    <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-100">
                      {names.first}
                      {names.fullOnly && <span className="block text-xs font-normal text-neutral-500">full name only</span>}
                      <span className="mt-0.5 block text-xs font-normal text-neutral-500 md:hidden">{e.email}</span>
                    </td>
                    <td className="px-4 py-3 text-neutral-900 dark:text-neutral-100">{names.last}</td>
                    <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">{e.department}</td>
                    <td className="hidden px-4 py-3 text-neutral-700 lg:table-cell dark:text-neutral-300">{e.job_title}</td>
                    <td className="px-4 py-3">
                      <span className="text-neutral-700 dark:text-neutral-300">{e.hr_status}</span>
                      {e.employment_status !== 'active' && (
                        <span className="mt-0.5 block whitespace-nowrap text-xs font-medium text-neutral-500">{EMPLOYMENT_LABELS[e.employment_status ?? 'none']}</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-neutral-700 lg:table-cell dark:text-neutral-300">{e.manager}</td>
                    <td className="hidden px-4 py-3 tabular-nums text-neutral-700 md:table-cell dark:text-neutral-300">{e.start_date}</td>
                    <td className="hidden px-4 py-3 text-neutral-700 md:table-cell dark:text-neutral-300">{e.email}</td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => setEditing(e)} className="whitespace-nowrap text-sm font-medium text-teal-700 hover:underline dark:text-teal-400">
                        {canEdit ? 'Edit' : 'View'}
                        <span className="sr-only"> {e.full_name}</span>
                      </button>
                    </td>
                  </tr>
                )
              })}
              {matching.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="px-4 py-6 text-center text-sm text-neutral-500">
                    {all.length === 0 ? 'No employees yet — upload an Excel list or add one.' : 'No employees match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {all && matching.length > 0 && (
        <nav aria-label="Pagination" className="flex flex-col items-center justify-between gap-2 text-sm text-neutral-600 sm:flex-row dark:text-neutral-400">
          <span>
            Showing {(pageInfo.page - 1) * pageSize + 1}–{Math.min(pageInfo.page * pageSize, matching.length)} of {matching.length}
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="sr-only">Rows per page</span>
              <select aria-label="Rows per page" className="input w-20 py-1" value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))}>
                {PAGE_SIZES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn-secondary px-2 py-1" disabled={pageInfo.page <= 1} onClick={() => setPage(pageInfo.page - 1)}>
              Previous
            </button>
            <span className="tabular-nums">
              Page {pageInfo.page} of {pageInfo.pages}
            </span>
            <button type="button" className="btn-secondary px-2 py-1" disabled={pageInfo.page >= pageInfo.pages} onClick={() => setPage(pageInfo.page + 1)}>
              Next
            </button>
          </div>
        </nav>
      )}

      {editing && <EmployeeModal employee={editing === 'new' ? null : editing} canEdit={canEdit} onClose={() => setEditing(null)} />}
      {importing && all && <EmployeeImportModal directory={all} onClose={() => setImporting(false)} />}
    </div>
  )
}
