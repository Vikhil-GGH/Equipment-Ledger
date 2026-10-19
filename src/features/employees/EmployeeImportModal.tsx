import { useMemo, useState } from 'react'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useCommitEmployeeImport, type EmployeeImportResult } from './api'
import type { DirectoryEmployee } from './directoryModel'
import {
  EMPLOYEE_COLUMNS,
  buildPreview,
  commitPayload,
  linkRow,
  needsStatusReview,
  previewCounts,
  statusChangeLabel,
  type Decision,
  type PreviewRow,
} from './employeeImport'
import { mappingSummary } from './employeeStatusMapping'
import type { EmploymentStatus } from '../../types/database.types'

const KIND_LABEL: Record<PreviewRow['kind'], string> = {
  new: 'New',
  update: 'Existing — changes',
  unchanged: 'Existing — no changes',
  possible_duplicate: 'Possible duplicate',
  invalid: 'Invalid',
}
const KIND_TONE: Record<PreviewRow['kind'], string> = {
  new: 'bg-green-50 text-green-800 ring-green-200 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-800',
  update: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:ring-sky-800',
  unchanged: 'bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700',
  possible_duplicate: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800',
  invalid: 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-800',
}
type Tab = 'review' | 'all'
const SHOWN = 300

/**
 * Upload → review → confirm. Nothing is written until Confirm; each row's
 * action, and every status change, is visible and adjustable first.
 */
export function EmployeeImportModal({ directory, onClose }: { directory: DirectoryEmployee[]; onClose: () => void }) {
  const commit = useCommitEmployeeImport()
  const [filename, setFilename] = useState('')
  const [rows, setRows] = useState<PreviewRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('review')
  const [result, setResult] = useState<EmployeeImportResult | null>(null)
  const counts = useMemo(() => (rows ? previewCounts(rows) : null), [rows])
  const needsReview = (r: PreviewRow) => r.kind === 'possible_duplicate' || r.kind === 'invalid' || !!r.statusChange || needsStatusReview(r)
  const mapping = mappingSummary()
  const visible = (rows ?? []).filter((r) => tab === 'all' || needsReview(r))

  async function read(file: File) {
    setError(null)
    setRows(null)
    try {
      const { parseExcelFile } = await import('../../lib/excel')
      const sheets = await parseExcelFile(file)
      const sheet = sheets.find((s) => s.rows.length) ?? sheets[0]
      if (!sheet || sheet.rows.length === 0) throw new Error('No rows found in this file.')
      const preview = buildPreview(sheet.rows, sheet.headers, directory)
      setFilename(file.name)
      setRows(preview)
      setTab(preview.some(needsReview) ? 'review' : 'all')
    } catch (err) {
      setError(getErrorMessage(err, 'Could not read that file'))
    }
  }

  function change(index: number, fn: (r: PreviewRow) => void) {
    setRows((current) => {
      if (!current) return current
      const next = [...current]
      const copy = { ...next[index] }
      fn(copy)
      next[index] = copy
      return next
    })
  }

  async function confirm() {
    if (!rows) return
    setError(null)
    try {
      setResult(await commit.mutateAsync({ filename, rows: commitPayload(rows) }))
    } catch (err) {
      setError(getErrorMessage(err, 'Import failed — nothing was changed'))
    }
  }

  if (result) {
    return (
      <Modal title="Import complete" onClose={onClose}>
        <ul className="space-y-1 text-sm" aria-label="Import summary">
          <li>{result.created} added</li>
          <li>{result.updated} updated</li>
          <li>{result.status_changes} employment status change{result.status_changes === 1 ? '' : 's'}</li>
          <li>{result.unchanged} already up to date</li>
          <li>{(counts?.total ?? 0) - (counts?.toApply ?? 0)} skipped (invalid, possible duplicates not resolved, or not selected)</li>
          <li>{result.conflicts.length} conflict{result.conflicts.length === 1 ? '' : 's'}</li>
        </ul>
        {result.conflicts.length > 0 && (
          <ul className="mt-2 space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {result.conflicts.map((c, i) => (
              <li key={i}>
                Row {c.row}: {c.reason}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Upload Active Employees" onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          An .xlsx file with the columns: {EMPLOYEE_COLUMNS.map((c) => c.header).join(', ')}. Work email is used to recognise existing employees.
          Blank cells never clear anything, nobody is removed for being missing from the file, and status changes apply only where you tick them.
        </p>
        <p className="text-xs text-neutral-500" data-testid="status-mapping">
          Employee Status counted as Active: {mapping.active.join(', ')}. As Inactive: {mapping.inactive.join(', ')}. Any other value (or a blank) is
          kept as written and flagged for review — it never sets employment status by itself.
        </p>
        <input type="file" accept=".xlsx,.xls" aria-label="Employee Excel file" onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} className="text-sm" />
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {rows && counts && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Preview summary">
              <span>{counts.total} rows</span>
              <span>{counts.new} new</span>
              <span>{counts.update} with changes</span>
              <span>{counts.unchanged} unchanged</span>
              <span className="text-amber-700 dark:text-amber-400">{counts.possible_duplicate} possible duplicates</span>
              <span className="text-red-700 dark:text-red-400">{counts.invalid} invalid</span>
              <span>{counts.statusChanges} status changes</span>
              <span className="text-amber-700 dark:text-amber-400">{counts.statusReview} status to review</span>
            </div>
            <div className="flex gap-2 text-sm">
              <button type="button" className={tab === 'review' ? 'btn-primary px-2 py-1' : 'btn-secondary px-2 py-1'} onClick={() => setTab('review')}>
                Needs review ({(rows ?? []).filter(needsReview).length})
              </button>
              <button type="button" className={tab === 'all' ? 'btn-primary px-2 py-1' : 'btn-secondary px-2 py-1'} onClick={() => setTab('all')}>
                All rows
              </button>
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-lg border border-stone-200 dark:border-neutral-800">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-stone-50 text-left text-neutral-500 dark:bg-neutral-950">
                  <tr>
                    <th className="px-2 py-1.5">Row</th>
                    <th className="px-2 py-1.5">Employee</th>
                    <th className="px-2 py-1.5">Work email</th>
                    <th className="px-2 py-1.5">Found</th>
                    <th className="px-2 py-1.5">Changes</th>
                    <th className="px-2 py-1.5">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(0, SHOWN).map((r) => {
                    const index = rows.indexOf(r)
                    return (
                      <tr key={r.row} className="border-t border-stone-100 align-top dark:border-neutral-800">
                        <td className="px-2 py-1.5 tabular-nums text-neutral-400">{r.row}</td>
                        <td className="px-2 py-1.5 font-medium">
                          {r.fields.first_name} {r.fields.last_name}
                          <span className="block font-normal text-neutral-500">{[r.fields.department, r.fields.job_title].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className="px-2 py-1.5">{r.fields.email}</td>
                        <td className="px-2 py-1.5">
                          <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${KIND_TONE[r.kind]}`}>{KIND_LABEL[r.kind]}</span>
                          {r.kind === 'possible_duplicate' &&
                            r.candidates.map((c) => (
                              <span key={c.id} className="mt-0.5 block text-amber-800 dark:text-amber-300">
                                {c.full_name}: {r.candidateReasons[c.id]}
                              </span>
                            ))}
                          {r.errors.map((e) => (
                            <span key={e} className="mt-0.5 block text-red-700 dark:text-red-400">
                              {e}
                            </span>
                          ))}
                        </td>
                        <td className="px-2 py-1.5">
                          {r.changes.map(([k, a, b]) => (
                            <span key={k} className="block">
                              {EMPLOYEE_COLUMNS.find((c) => c.key === k)!.header}: <span className="text-neutral-500 line-through">{a || '—'}</span> → {b}
                            </span>
                          ))}
                          {r.kind === 'new' && r.fileStatus !== 'review' && (
                            <span className="block text-neutral-600 dark:text-neutral-400">
                              Added as {r.fileStatus === 'active' ? 'Active' : 'Inactive / Offboarded'} (Employee Status “{r.fields.hr_status}”)
                            </span>
                          )}
                          {needsStatusReview(r) && (
                            <span className="mt-1 block font-medium text-amber-800 dark:text-amber-300">
                              Employee Status “{r.fields.hr_status || 'blank'}” not recognised —{' '}
                              {r.decision === 'create' ? (
                                <label className="inline-flex items-center gap-1">
                                  add as
                                  <select
                                    aria-label={`Employment status for row ${r.row}`}
                                    className="input inline-block w-auto py-0.5 text-xs"
                                    value={r.chosenStatus ?? ''}
                                    onChange={(e) => change(index, (x) => (x.chosenStatus = (e.target.value || null) as EmploymentStatus | null))}
                                  >
                                    <option value="">Not in directory</option>
                                    <option value="active">Active</option>
                                    <option value="inactive">Inactive / Offboarded</option>
                                  </select>
                                </label>
                              ) : (
                                'employment status left unchanged'
                              )}
                            </span>
                          )}
                          {r.statusChange && (
                            <label className="mt-1 flex items-center gap-1 font-medium">
                              <input
                                type="checkbox"
                                checked={r.applyStatus}
                                onChange={(e) => change(index, (x) => (x.applyStatus = e.target.checked))}
                                disabled={r.decision !== 'update'}
                              />
                              Apply status: {statusChangeLabel(r.statusChange)}
                            </label>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {r.kind === 'invalid' ? (
                            <span className="text-neutral-500">Skipped</span>
                          ) : r.kind === 'possible_duplicate' ? (
                            <select
                              aria-label={`Action for row ${r.row}`}
                              className="input py-1 text-xs"
                              value={r.decision === 'update' ? `link:${r.linkTo}` : r.decision}
                              onChange={(e) =>
                                change(index, (x) => {
                                  const v = e.target.value
                                  if (v.startsWith('link:')) linkRow(x, x.candidates.find((c) => c.id === v.slice(5)))
                                  else {
                                    linkRow(x, undefined)
                                    x.decision = v as Decision
                                  }
                                })
                              }
                            >
                              <option value="skip">Skip (review later)</option>
                              {r.candidates.map((c) => (
                                <option key={c.id} value={`link:${c.id}`}>
                                  Same person as {c.full_name}
                                  {c.email ? ` (${c.email})` : ''} — {r.candidateReasons[c.id]}
                                </option>
                              ))}
                              <option value="create">A different person — add new</option>
                            </select>
                          ) : r.kind === 'unchanged' ? (
                            <span className="text-neutral-500">Nothing to do</span>
                          ) : (
                            <select
                              aria-label={`Action for row ${r.row}`}
                              className="input py-1 text-xs"
                              value={r.decision}
                              onChange={(e) => change(index, (x) => (x.decision = e.target.value as Decision))}
                            >
                              <option value={r.kind === 'new' ? 'create' : 'update'}>{r.kind === 'new' ? 'Add' : 'Update'}</option>
                              <option value="skip">Skip</option>
                            </select>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-2 py-4 text-center text-neutral-500">
                        Nothing needs review.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {visible.length > SHOWN && <p className="p-2 text-xs text-neutral-500">Showing the first {SHOWN} of {visible.length} rows; the rest use the actions shown in the summary.</p>}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => void confirm()} disabled={commit.isPending || counts.toApply === 0}>
                {commit.isPending ? 'Importing…' : `Confirm import (${counts.toApply} row${counts.toApply === 1 ? '' : 's'})`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
