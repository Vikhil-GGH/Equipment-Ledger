import { useState, type ReactNode } from 'react'
import { getErrorMessage } from '../../lib/errors'
import type { RequirementAnswer } from '../../types/database.types'
import {
  useBulkCandidates,
  useEmployeeIssues,
  useIssuableDevices,
  useIssueEquipment,
  useSetOnboardingEquipmentFields,
  type IssuableDevice,
} from './api'
import { EmployeeLinkPanel } from './EmployeeLinkPanel'
import { IssuedEquipmentTable } from './IssuedEquipmentTable'
import {
  REQUIREMENT_LABELS,
  REQUIREMENT_STATE_LABELS,
  isChargerIssue,
  isHeadsetIssue,
  isLaptopIssue,
  requirementState,
  type EquipmentIssue,
} from './registerModel'

export interface OnboardingEquipmentRecord {
  id: string
  employee_name: string
  employee_id?: string | null
  requested_laptop?: string | null
  charger_required?: RequirementAnswer | null
  headset_required?: RequirementAnswer | null
}

const ANSWERS: RequirementAnswer[] = ['yes', 'no', 'not_applicable']

/**
 * Onboarding → Equipment Assignment: requested laptop, the laptop(s)
 * issued, and the charger / headset questions. Answering a question only
 * saves the answer — issuing is always a separate, explicit action, and
 * changing an answer never returns anything already issued.
 */
export function OnboardingEquipmentSection({ record, canEdit }: { record: OnboardingEquipmentRecord; canEdit: boolean }) {
  const { data: issues } = useEmployeeIssues(record.employee_id)
  const all = issues ?? []
  const open = all.filter((i) => i.status === 'open')
  const laptops = open.filter(isLaptopIssue)
  const chargers = open.filter(isChargerIssue)
  const headsets = open.filter(isHeadsetIssue)

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Equipment assignment</h2>
        <p className="text-xs text-neutral-500">Tracked separately from the checklist above.</p>
      </div>

      {!record.employee_id ? (
        <EmployeeLinkPanel table="onboarding_checklists" checklistId={record.id} employeeName={record.employee_name} canEdit={canEdit} />
      ) : (
        <>
          <p className="text-xs text-neutral-600 dark:text-neutral-400" data-testid="equipment-summary">
            Laptop: {laptops.length ? `${laptops.length} issued` : 'not issued yet'} · Charger:{' '}
            {REQUIREMENT_STATE_LABELS[requirementState(record.charger_required ?? null, chargers.length)]} · Headset:{' '}
            {REQUIREMENT_STATE_LABELS[requirementState(record.headset_required ?? null, headsets.length)]}
          </p>

          <RequestedLaptop record={record} canEdit={canEdit} />

          <ItemBlock title="Laptop">
            {laptops.length > 0 && <p className="text-xs text-neutral-600 dark:text-neutral-400">Issued: {laptops.map((l) => `${l.description} (${l.serial})`).join(', ')}</p>}
            {canEdit && <IssueDevice kind="laptop" employeeId={record.employee_id} onboardingId={record.id} again={laptops.length > 0} />}
          </ItemBlock>

          <RequirementBlock
            title="Charger"
            field="charger_required"
            record={record}
            canEdit={canEdit}
            issued={chargers}
            issueControls={<IssueBulk kind="charger" employeeId={record.employee_id} onboardingId={record.id} />}
          />

          <RequirementBlock
            title="Headset"
            field="headset_required"
            record={record}
            canEdit={canEdit}
            issued={headsets}
            issueControls={<IssueHeadset employeeId={record.employee_id} onboardingId={record.id} />}
          />

          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Issued equipment</h3>
            <IssuedEquipmentTable issues={all} emptyMessage="Nothing issued to this employee yet." />
          </div>
        </>
      )}
    </div>
  )
}

function ItemBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5 border-t border-stone-100 pt-3 dark:border-neutral-800">
      <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{title}</h3>
      {children}
    </div>
  )
}

function RequestedLaptop({ record, canEdit }: { record: OnboardingEquipmentRecord; canEdit: boolean }) {
  const save = useSetOnboardingEquipmentFields(record.id)
  const [value, setValue] = useState(record.requested_laptop ?? '')
  const changed = value.trim() !== (record.requested_laptop ?? '')
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-900 dark:text-neutral-100">Requested laptop (model or specifications)</span>
      <div className="flex gap-2">
        <input
          className="input"
          value={value}
          disabled={!canEdit}
          placeholder="e.g. 14-inch, 16 GB RAM, Windows"
          onChange={(e) => setValue(e.target.value)}
        />
        {canEdit && (
          <button className="btn-secondary" disabled={!changed || save.isPending} onClick={() => save.mutate({ requested_laptop: value.trim() || null })}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </label>
  )
}

function RequirementBlock({
  title,
  field,
  record,
  canEdit,
  issued,
  issueControls,
}: {
  title: string
  field: 'charger_required' | 'headset_required'
  record: OnboardingEquipmentRecord
  canEdit: boolean
  issued: EquipmentIssue[]
  issueControls: ReactNode
}) {
  const save = useSetOnboardingEquipmentFields(record.id)
  const answer = record[field] ?? null
  return (
    <ItemBlock title={`${title} required?`}>
      <div role="radiogroup" aria-label={`${title} required`} className="flex flex-wrap gap-4 text-sm">
        {ANSWERS.map((a) => (
          <label key={a} className="flex items-center gap-1.5">
            <input
              type="radio"
              name={`${field}-${record.id}`}
              checked={answer === a}
              disabled={!canEdit || save.isPending}
              onChange={() => save.mutate({ [field]: a })}
            />
            {REQUIREMENT_LABELS[a]}
          </label>
        ))}
      </div>
      {answer === null && <p className="text-xs text-neutral-500">Not answered yet — choose Yes, No or N/A.</p>}
      {issued.length > 0 && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          Issued: {issued.map((i) => (i.quantity > 1 ? `${i.quantity} × ${i.description}` : i.description)).join(', ')}
        </p>
      )}
      {answer !== 'yes' && answer !== null && issued.length > 0 && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          A {title.toLowerCase()} is still issued to this employee. Changing the answer doesn't return it — use
          Offboarding → Equipment return if it should come back.
        </p>
      )}
      {answer === 'yes' && canEdit && issueControls}
    </ItemBlock>
  )
}

function useIssue(employeeId: string, onboardingId: string) {
  const issue = useIssueEquipment()
  const [error, setError] = useState<string | null>(null)
  async function run(input: Omit<Parameters<typeof issue.mutateAsync>[0], 'employeeId' | 'onboardingId'>) {
    setError(null)
    try {
      await issue.mutateAsync({ ...input, employeeId, onboardingId })
      return true
    } catch (err) {
      setError(getErrorMessage(err, 'Could not issue'))
      return false
    }
  }
  return { run, error, pending: issue.isPending }
}

function deviceLabel(d: IssuableDevice) {
  const scope = d.collection === 'active_laptops_np' ? 'NP-managed' : d.collection === 'serialized_assets' ? 'Company' : 'Other Equipment'
  return `${d.serial} — ${d.name} (${d.status === 'available' ? 'Available' : d.status}, ${scope})`
}

function IssueDevice({ kind, employeeId, onboardingId, again }: { kind: 'laptop' | 'headset'; employeeId: string; onboardingId: string; again?: boolean }) {
  const { data: devices, isLoading } = useIssuableDevices(kind)
  const { run, error, pending } = useIssue(employeeId, onboardingId)
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('')
  const list = (devices ?? []).filter((d) => `${d.serial} ${d.name}`.toLowerCase().includes(filter.trim().toLowerCase()))
  const chosen = devices?.find((d) => d.id === selected)
  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="input sm:w-48" placeholder={`Search ${kind}s…`} aria-label={`Search ${kind}s`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select className="input" aria-label={`Choose a ${kind}`} value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{isLoading ? 'Loading…' : list.length ? `Choose an available ${kind}…` : `No available ${kind}s`}</option>
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {deviceLabel(d)}
            </option>
          ))}
        </select>
        <button
          className="btn-primary whitespace-nowrap"
          disabled={!chosen || pending}
          onClick={() => void run({ device: { collection: chosen!.collection, id: chosen!.id } }).then((ok) => ok && setSelected(''))}
        >
          {pending ? 'Issuing…' : again ? `Issue another ${kind}` : `Issue ${kind}`}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

function IssueBulk({ kind, employeeId, onboardingId }: { kind: 'charger' | 'headset'; employeeId: string; onboardingId: string }) {
  const { data: items, isLoading } = useBulkCandidates(kind)
  const { run, error, pending } = useIssue(employeeId, onboardingId)
  const [selected, setSelected] = useState('')
  const chosen = items?.find((i) => i.id === selected)
  return (
    <div className="space-y-1.5">
      <div className="flex flex-col gap-2 sm:flex-row">
        <select className="input" aria-label={`Choose a Bulk Stock ${kind}`} value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">{isLoading ? 'Loading…' : items?.length ? `Choose a Bulk Stock ${kind}…` : `No ${kind}s in Bulk Stock`}</option>
          {items?.map((i) => (
            <option key={i.id} value={i.id} disabled={i.available < 1}>
              {i.name} — {i.available} available
            </option>
          ))}
        </select>
        <button
          className="btn-primary whitespace-nowrap"
          disabled={!chosen || chosen.available < 1 || pending}
          onClick={() => void run({ bulk: { itemId: chosen!.id, quantity: 1 } }).then((ok) => ok && setSelected(''))}
        >
          {pending ? 'Issuing…' : `Issue ${kind}`}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

function IssueHeadset({ employeeId, onboardingId }: { employeeId: string; onboardingId: string }) {
  const [source, setSource] = useState<'' | 'serialized' | 'bulk'>('')
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Headset source" className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`headset-source-${onboardingId}`} checked={source === 'serialized'} onChange={() => setSource('serialized')} />
          From Other Equipment (has a serial)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={`headset-source-${onboardingId}`} checked={source === 'bulk'} onChange={() => setSource('bulk')} />
          From Bulk Stock (by quantity)
        </label>
      </div>
      {source === 'serialized' && <IssueDevice kind="headset" employeeId={employeeId} onboardingId={onboardingId} />}
      {source === 'bulk' && <IssueBulk kind="headset" employeeId={employeeId} onboardingId={onboardingId} />}
    </div>
  )
}
