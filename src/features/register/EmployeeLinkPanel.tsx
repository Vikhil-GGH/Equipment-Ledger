import { useState } from 'react'
import { getErrorMessage } from '../../lib/errors'
import { useCreateEmployee, useEmployeesNamed, useLinkChecklistEmployee } from './api'
import { normalizeName } from './registerModel'

/**
 * Links a checklist to an employee record. Existing employees with exactly
 * the same name are offered, never chosen automatically (two people can
 * share a name); creating a new record is always an explicit click.
 */
export function EmployeeLinkPanel({
  table,
  checklistId,
  employeeName,
  canEdit,
}: {
  table: 'onboarding_checklists' | 'offboarding_checklists'
  checklistId: string
  employeeName: string
  canEdit: boolean
}) {
  const { data: matches, isLoading } = useEmployeesNamed(normalizeName(employeeName))
  const create = useCreateEmployee()
  const link = useLinkChecklistEmployee(table, checklistId)
  const [choice, setChoice] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const busy = create.isPending || link.isPending

  async function confirm() {
    setError(null)
    try {
      const id = choice === 'new' ? await create.mutateAsync(employeeName) : choice
      await link.mutateAsync(id)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not link the employee'))
    }
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
      <p className="font-medium text-neutral-900 dark:text-neutral-100">Link this checklist to an employee record</p>
      <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
        Equipment is recorded against an employee, so it can be tracked from onboarding to offboarding.
      </p>
      {isLoading && <p className="mt-2 text-xs text-neutral-500">Looking for “{employeeName}”…</p>}
      {canEdit && !isLoading && (
        <fieldset className="mt-2 space-y-1">
          <legend className="sr-only">Employee</legend>
          {matches?.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input type="radio" name={`employee-${checklistId}`} checked={choice === m.id} onChange={() => setChoice(m.id)} />
              Existing: {m.full_name}
              <span className="text-xs text-neutral-500">(added {new Date(m.created_at).toLocaleDateString()})</span>
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="radio" name={`employee-${checklistId}`} checked={choice === 'new'} onChange={() => setChoice('new')} />
            Create a new employee record for “{employeeName}”
          </label>
          {!!matches?.length && (
            <p className="text-xs text-amber-800 dark:text-amber-300">
              {matches.length === 1 ? 'An employee' : `${matches.length} employees`} with this name already exist — only
              choose one if it's the same person.
            </p>
          )}
          <button className="btn-primary mt-1" disabled={!choice || busy} onClick={() => void confirm()}>
            {busy ? 'Saving…' : 'Link employee'}
          </button>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
