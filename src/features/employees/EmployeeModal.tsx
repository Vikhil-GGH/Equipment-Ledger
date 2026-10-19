import { useState, type FormEvent } from 'react'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import type { EmploymentStatus } from '../../types/database.types'
import { useEmployeeHistory, useOpenEquipmentCount, useSaveEmployee, useSetEmploymentStatus, type HistoryEntry } from './api'
import { EMPLOYMENT_LABELS, type DirectoryEmployee } from './directoryModel'
import { EMPLOYEE_COLUMNS, type EmployeeFields } from './employeeImport'

const SOURCE_LABELS: Record<string, string> = {
  manual: 'by hand',
  import: 'Excel import',
  onboarding_completed: 'onboarding completed',
  offboarding_completed: 'offboarding completed',
}

function describe(h: HistoryEntry) {
  const by = SOURCE_LABELS[h.source] ?? h.source
  switch (h.kind) {
    case 'created':
      return `Added to the directory as ${h.to_status ? EMPLOYMENT_LABELS[h.to_status] : '—'} (${by}${h.import_filename ? `: ${h.import_filename}` : ''})`
    case 'status':
      return `${h.from_status ? EMPLOYMENT_LABELS[h.from_status] : 'Not in directory'} → ${h.to_status ? EMPLOYMENT_LABELS[h.to_status] : '—'} (${by})`
    case 'reactivation_pending':
      return 'Completed a new onboarding while offboarded — awaiting reactivation'
    case 'details':
      return `Details changed (${by}): ${Object.entries(h.changes ?? {})
        .map(([k, [a, b]]) => `${EMPLOYEE_COLUMNS.find((c) => c.key === k)?.header ?? k} "${a ?? ''}" → "${b ?? ''}"`)
        .join('; ')}`
  }
}

const empty = (): EmployeeFields => ({ first_name: '', last_name: '', department: '', job_title: '', hr_status: '', manager: '', start_date: '', email: '' })

/** Add (employee = null), edit, or view an employee. Status changes are explicit actions with a confirmation. */
export function EmployeeModal({ employee, canEdit, onClose }: { employee: DirectoryEmployee | null; canEdit: boolean; onClose: () => void }) {
  const save = useSaveEmployee()
  const setStatus = useSetEmploymentStatus()
  const { data: history } = useEmployeeHistory(employee?.id)
  const { data: openItems } = useOpenEquipmentCount(employee?.id)
  const [fields, setFields] = useState<EmployeeFields>(() => {
    if (!employee) return { ...empty(), hr_status: 'Active' }
    const f = empty()
    for (const c of EMPLOYEE_COLUMNS) f[c.key] = (employee[c.key] ?? '').toString()
    return f
  })
  const [confirm, setConfirm] = useState<EmploymentStatus | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const readOnly = !canEdit

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await save.mutateAsync({ id: employee?.id ?? null, fields })
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save'))
    }
  }

  async function changeStatus(status: EmploymentStatus) {
    if (!employee) return
    setError(null)
    try {
      await setStatus.mutateAsync({ id: employee.id, status, note })
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Could not change the status'))
    }
  }

  const current = employee?.employment_status ?? null
  return (
    <Modal title={employee ? `${readOnly ? '' : 'Edit '}${employee.full_name}` : 'Add employee'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {EMPLOYEE_COLUMNS.map((c) => (
            <label key={c.key} className={`block ${c.key === 'email' ? 'sm:col-span-2' : ''}`}>
              <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-400">
                {c.header}
                {!employee && (c.key === 'first_name' || c.key === 'last_name') && <span className="text-red-500"> *</span>}
              </span>
              <input
                className="input"
                type={c.key === 'start_date' ? 'date' : c.key === 'email' ? 'email' : 'text'}
                value={fields[c.key]}
                readOnly={readOnly}
                required={!employee && (c.key === 'first_name' || c.key === 'last_name')}
                onChange={(e) => setFields((f) => ({ ...f, [c.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        {employee && (
          <p className="text-xs text-neutral-500">
            Equipment register name: <span className="font-medium">{employee.full_name}</span> (kept as is, so equipment stays linked).
          </p>
        )}

        {employee && (
          <section className="rounded-lg border border-stone-200 p-3 text-sm dark:border-neutral-800">
            <p>
              Employment: <span className="font-semibold">{EMPLOYMENT_LABELS[current ?? 'none']}</span>
              {employee.reactivation_pending && <span className="ml-1 text-amber-700 dark:text-amber-400">· rehire awaiting reactivation</span>}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              {openItems === undefined ? '…' : openItems} item{openItems === 1 ? '' : 's'} of equipment still with this employee — changing employment never returns or
              unassigns equipment.
            </p>
            {canEdit && !confirm && (
              <div className="mt-2 flex flex-wrap gap-2">
                {current !== 'active' && (
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setConfirm('active')}>
                    {current === 'inactive' ? 'Reactivate' : 'Add to Active Employees'}
                  </button>
                )}
                {current !== 'inactive' && (
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setConfirm('inactive')}>
                    Mark inactive
                  </button>
                )}
              </div>
            )}
            {confirm && (
              <div className="mt-2 space-y-2">
                <p className="text-xs font-medium">
                  {confirm === 'active' ? 'Make this employee Active?' : 'Mark this employee Inactive / Offboarded? Their records and equipment history are kept.'}
                </p>
                <input className="input" placeholder="Note (optional)" aria-label="Status change note" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex gap-2">
                  <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void changeStatus(confirm)} disabled={setStatus.isPending}>
                    Confirm
                  </button>
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button type="submit" className="btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : employee ? 'Save changes' : 'Add employee'}
            </button>
          )}
        </div>

        {employee && !!history?.length && (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">History</h3>
            <ul className="space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="tabular-nums text-neutral-400">{new Date(h.at).toLocaleString()}</span> — {describe(h)}
                  {h.note ? ` — ${h.note}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
      </form>
    </Modal>
  )
}
