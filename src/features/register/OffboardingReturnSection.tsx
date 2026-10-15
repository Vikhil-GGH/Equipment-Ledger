import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getErrorMessage } from '../../lib/errors'
import { COLLECTION_BASE_PATH } from '../../lib/lifecycle'
import { useEmployee, useEmployeeIssues, useReturnEquipment, useUnregisteredDevices } from './api'
import { EmployeeLinkPanel } from './EmployeeLinkPanel'
import { IssuedEquipmentTable } from './IssuedEquipmentTable'
import {
  OUTCOMES_REQUIRING_REASON,
  OUTCOME_LABELS,
  RETURN_OUTCOMES,
  inventoryEffect,
  returnProgress,
  type EquipmentIssue,
  type ReturnOutcome,
} from './registerModel'

/**
 * Offboarding → Equipment return: everything issued to the employee
 * (laptops, chargers, headsets, monitors, other devices), each processed on
 * its own through return_equipment, which updates the real inventory in
 * the same transaction. Its progress is separate from the checklist above.
 */
export function OffboardingReturnSection({
  record,
  canEdit,
}: {
  record: { id: string; employee_name: string; employee_id?: string | null }
  canEdit: boolean
}) {
  const { data: employee } = useEmployee(record.employee_id)
  const { data: issues, isLoading } = useEmployeeIssues(record.employee_id)
  const { data: unregistered } = useUnregisteredDevices(employee?.name_key, !!record.employee_id)
  const progress = returnProgress(issues ?? [])

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Equipment return</h2>
        <p className="text-xs text-neutral-500">Tracked separately from the checklist above.</p>
      </div>

      {!record.employee_id ? (
        <EmployeeLinkPanel table="offboarding_checklists" checklistId={record.id} employeeName={record.employee_name} canEdit={canEdit} />
      ) : (
        <>
          {issues && progress.total > 0 && (
            <p className="text-sm text-neutral-700 dark:text-neutral-300" data-testid="return-progress">
              {progress.pending === 0 ? 'All items processed' : `${progress.pending} pending return`} · {progress.processed} of{' '}
              {progress.total} processed
              {progress.retained > 0 && ` · ${progress.retained} retained (authorized)`}
              {progress.lost > 0 && ` · ${progress.lost} lost`}
            </p>
          )}
          {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
          {issues && (
            <IssuedEquipmentTable
              issues={issues.filter((i) => i.status !== 'transferred' && i.status !== 'unassigned')}
              emptyMessage={`Nothing is recorded as issued to ${record.employee_name}.`}
              action={(issue) =>
                issue.status === 'open' ? (
                  canEdit ? <ReturnControls issue={issue} offboardingId={record.id} /> : <span className="text-xs text-neutral-500">Pending</span>
                ) : (
                  <span className="text-xs text-neutral-500">Done</span>
                )
              }
            />
          )}
          {!!unregistered?.length && (
            <div role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
              ⚠ Assigned to “{record.employee_name}” but not in the register — check and process from the device page:
              <ul className="mt-1 list-disc pl-5">
                {unregistered.map((d) => (
                  <li key={d.asset_id}>
                    <Link className="underline" to={`${COLLECTION_BASE_PATH[d.collection]}/${d.asset_id}`}>
                      {d.serial}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ReturnControls({ issue, offboardingId }: { issue: EquipmentIssue; offboardingId: string }) {
  const ret = useReturnEquipment()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<ReturnOutcome | ''>('')
  const [note, setNote] = useState('')
  const [quantity, setQuantity] = useState(issue.quantity)
  const [error, setError] = useState<string | null>(null)
  const needsReason = outcome !== '' && OUTCOMES_REQUIRING_REASON.has(outcome)
  const validQty = issue.item_kind === 'serialized' || (Number.isInteger(quantity) && quantity >= 1 && quantity <= issue.quantity)
  const canConfirm = outcome !== '' && (!needsReason || note.trim() !== '') && validQty && !ret.isPending

  async function confirm() {
    if (outcome === '') return
    setError(null)
    try {
      await ret.mutateAsync({
        issueId: issue.id,
        outcome,
        quantity: issue.item_kind === 'bulk' ? quantity : null,
        note: note.trim() || null,
        offboardingId,
      })
      setOpen(false)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not process the return'))
    }
  }

  if (!open) {
    return (
      <button className="btn-secondary whitespace-nowrap text-xs" onClick={() => setOpen(true)}>
        Process return
      </button>
    )
  }
  return (
    <div className="min-w-[16rem] space-y-2 text-xs">
      <fieldset className="space-y-1">
        <legend className="sr-only">Outcome for {issue.description}</legend>
        {RETURN_OUTCOMES.map((o) => (
          <label key={o} className="flex items-center gap-1.5">
            <input type="radio" name={`outcome-${issue.id}`} checked={outcome === o} onChange={() => setOutcome(o)} />
            {OUTCOME_LABELS[o]}
          </label>
        ))}
      </fieldset>
      {issue.item_kind === 'bulk' && issue.quantity > 1 && (
        <label className="block">
          Quantity (of {issue.quantity})
          <input
            type="number"
            min={1}
            max={issue.quantity}
            className="input mt-0.5"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
      )}
      <label className="block">
        {needsReason ? 'Reason (required)' : 'Note (optional)'}
        <input className="input mt-0.5" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {outcome !== '' && (
        <p role="status" className="rounded bg-stone-50 px-2 py-1 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {inventoryEffect(issue, outcome, issue.item_kind === 'bulk' ? quantity : 1)}
        </p>
      )}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary text-xs" disabled={!canConfirm} onClick={() => void confirm()}>
          {ret.isPending ? 'Saving…' : 'Confirm'}
        </button>
        <button className="btn-secondary text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  )
}
