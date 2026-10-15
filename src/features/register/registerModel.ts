import type { AssetCollection, EquipmentIssueStatus, RequirementAnswer } from '../../types/database.types'

/** One row of the employee equipment register (20260901000026). */
export interface EquipmentIssue {
  id: string
  employee_id: string | null
  assignee_name: string
  employee_ambiguous: boolean
  item_kind: 'serialized' | 'bulk'
  asset_collection: AssetCollection | null
  asset_id: string | null
  bulk_item_id: string | null
  quantity: number
  description: string
  serial: string | null
  issued_at: string
  onboarding_id: string | null
  status: EquipmentIssueStatus
  closed_at: string | null
  close_note: string | null
  offboarding_id: string | null
  source: string
}

export type ReturnOutcome = Extract<
  EquipmentIssueStatus,
  'returned' | 'returned_damaged' | 'decommissioned' | 'retained_authorized' | 'lost'
>

export const RETURN_OUTCOMES: ReturnOutcome[] = ['returned', 'returned_damaged', 'decommissioned', 'retained_authorized', 'lost']

/** Outcomes that must carry a written reason (also enforced by the database). */
export const OUTCOMES_REQUIRING_REASON: ReadonlySet<ReturnOutcome> = new Set(['retained_authorized', 'lost'])

export const ISSUE_STATUS_LABELS: Record<EquipmentIssueStatus, string> = {
  open: 'Pending return',
  returned: 'Returned',
  returned_damaged: 'Returned damaged',
  decommissioned: 'Decommissioned',
  retained_authorized: 'Retained — authorized',
  lost: 'Lost',
  transferred: 'Transferred to someone else',
  unassigned: 'Unassigned (outside a return)',
}

export const OUTCOME_LABELS: Record<ReturnOutcome, string> = {
  returned: 'Returned',
  returned_damaged: 'Returned damaged',
  decommissioned: 'Returned for decommission',
  retained_authorized: 'Retained — authorized',
  lost: 'Lost / not recoverable',
}

/** Exactly what the inventory will do — shown before the operator confirms. */
export function inventoryEffect(issue: Pick<EquipmentIssue, 'item_kind' | 'quantity'>, outcome: ReturnOutcome, quantity = issue.quantity): string {
  if (issue.item_kind === 'serialized') {
    switch (outcome) {
      case 'returned':
        return 'Collect: the device becomes Available and unassigned.'
      case 'returned_damaged':
        return 'Collect, then Mark damaged: the device becomes Damaged and unassigned.'
      case 'decommissioned':
        return 'Decommission: the device becomes Decommissioned and unassigned.'
      case 'retained_authorized':
        return 'No inventory change: the device stays Provided to the employee; the approval is recorded on it.'
      case 'lost':
        return 'The device becomes Lost and unassigned (final — no further actions).'
    }
  }
  const n = `${quantity}`
  switch (outcome) {
    case 'returned':
      return `Bulk Stock: ${n} moved from Provided to Available.`
    case 'returned_damaged':
      return `Bulk Stock: ${n} moved from Provided to Damaged.`
    case 'decommissioned':
      return `Bulk Stock: ${n} moved from Provided to Decommissioned.`
    case 'retained_authorized':
      return `Bulk Stock: ${n} written off from Provided (not Available, not pending).`
    case 'lost':
      return `Bulk Stock: ${n} written off from Provided as lost.`
  }
}

export function itemTypeLabel(issue: Pick<EquipmentIssue, 'item_kind' | 'asset_collection' | 'description'>): string {
  if (issue.item_kind === 'bulk') return 'Bulk Stock'
  switch (issue.asset_collection) {
    case 'serialized_assets':
    case 'active_laptops_np':
      return 'Laptop'
    case 'monitors':
      return 'Monitor'
    default:
      return /headset/i.test(issue.description) ? 'Headset' : 'Other equipment'
  }
}

/**
 * Equipment-return progress — deliberately separate from the offboarding
 * checklist's progress. Only items still with the employee are pending;
 * transferred/unassigned rows are history, not part of this offboarding.
 */
export function returnProgress(issues: Pick<EquipmentIssue, 'status'>[]) {
  const relevant = issues.filter((i) => i.status !== 'transferred' && i.status !== 'unassigned')
  const pending = relevant.filter((i) => i.status === 'open').length
  const retained = relevant.filter((i) => i.status === 'retained_authorized').length
  const lost = relevant.filter((i) => i.status === 'lost').length
  return { total: relevant.length, pending, retained, lost, processed: relevant.length - pending }
}

export const REQUIREMENT_LABELS: Record<RequirementAnswer, string> = {
  yes: 'Yes',
  no: 'No',
  not_applicable: 'N/A',
}

export type RequirementState = 'unanswered' | 'not_required' | 'needed' | 'issued'

/** Charger / headset line on the onboarding equipment summary. Never implies an automatic issue. */
export function requirementState(answer: RequirementAnswer | null, issuedCount: number): RequirementState {
  if (issuedCount > 0) return 'issued'
  if (answer === null) return 'unanswered'
  return answer === 'yes' ? 'needed' : 'not_required'
}

export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
  unanswered: 'Not answered yet',
  not_required: 'Not required',
  needed: 'Required — not issued yet',
  issued: 'Issued',
}

export function isLaptopIssue(issue: Pick<EquipmentIssue, 'item_kind' | 'asset_collection'>) {
  return issue.item_kind === 'serialized' && (issue.asset_collection === 'serialized_assets' || issue.asset_collection === 'active_laptops_np')
}
export function isHeadsetIssue(issue: Pick<EquipmentIssue, 'item_kind' | 'asset_collection' | 'description'>) {
  return /headset/i.test(issue.description) && !isLaptopIssue(issue)
}
export function isChargerIssue(issue: Pick<EquipmentIssue, 'item_kind' | 'description'>) {
  return issue.item_kind === 'bulk' && /charger|power/i.test(issue.description)
}

/** Same rule as the database's normalize_person_name: trimmed, spaces collapsed, case ignored. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}
