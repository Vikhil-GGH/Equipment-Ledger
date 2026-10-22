import type { AssetAction, AssetCollection, AssetStatus } from '../types/database.types'

/**
 * Client-side mirror of the state machine enforced in
 * supabase/migrations/20260901000009_lifecycle_functions.sql
 * (perform_lifecycle_action). Keep both in sync — this copy drives which
 * action buttons the UI shows; the SQL function is the real gate.
 *
 * Semantic note: 'decommissioned' is NOT terminal — the device is refreshed
 * and re-enters the reissue pool (Provide/Retain/Mark damaged all resume),
 * but only after an explicit "refreshed and fit to use" confirmation
 * (needsRefreshConfirmation, 20260901000035). It can also be retired directly
 * with Mark non-functional. 'nonfunctional' is the actual terminal state — it
 * can never be issued again — and so is 'lost' (20260901000025), which only
 * offboarding's return_equipment can set.
 */
export const TRANSITIONS: Record<AssetStatus, Partial<Record<AssetAction, AssetStatus>>> = {
  available: {
    provide: 'provided',
    retain: 'retained',
    mark_damaged: 'damaged',
  },
  provided: {
    collect: 'available',
    transfer: 'provided',
    mark_damaged: 'damaged',
    decommission: 'decommissioned',
    // 'swap' is handled by a separate atomic two-row transaction, not here.
  },
  retained: {
    provide: 'provided',
    mark_damaged: 'damaged',
  },
  damaged: {
    mark_repaired: 'available',
    mark_nonfunctional: 'nonfunctional',
  },
  decommissioned: {
    provide: 'provided',
    retain: 'retained',
    mark_damaged: 'damaged',
    mark_nonfunctional: 'nonfunctional',
  },
  nonfunctional: {},
  lost: {},
}

export const ACTION_LABELS: Record<AssetAction, string> = {
  provide: 'Provide',
  retain: 'Retain',
  mark_damaged: 'Mark damaged',
  collect: 'Collect',
  transfer: 'Transfer',
  decommission: 'Decommission (employee left)',
  mark_repaired: 'Mark repaired',
  mark_nonfunctional: 'Mark non-functional',
}

/** Actions that require an assignee name (assigned_to) to be provided. */
export const ACTIONS_REQUIRING_ASSIGNEE: ReadonlySet<AssetAction> = new Set([
  'provide',
  'transfer',
])

export function getAllowedActions(status: AssetStatus): AssetAction[] {
  return Object.keys(TRANSITIONS[status]) as AssetAction[]
}

export function isActionAllowed(status: AssetStatus, action: AssetAction): boolean {
  return TRANSITIONS[status][action] !== undefined
}

export function resultingStatus(
  status: AssetStatus,
  action: AssetAction,
): AssetStatus | undefined {
  return TRANSITIONS[status][action]
}

export function isTerminal(status: AssetStatus): boolean {
  return getAllowedActions(status).length === 0
}

/**
 * Swap is deliberately not in TRANSITIONS/AssetAction — it mutates two rows
 * atomically (perform_swap) rather than a single status transition — but it
 * shares the same "only from provided" gate as Collect/Transfer/Decommission.
 */
export function canSwap(status: AssetStatus): boolean {
  return status === 'provided'
}

/**
 * A Decommissioned device re-enters stock (Provide), the set-aside shelf (Retain) or an employee's hands (Swap in)
 * only after the user confirms it has been refreshed. The database enforces the same rule.
 */
export function needsRefreshConfirmation(status: AssetStatus, action: AssetAction | 'swap'): boolean {
  return status === 'decommissioned' && (action === 'provide' || action === 'retain' || action === 'swap')
}

export const REFRESH_CONFIRMATION_LABEL = 'I confirm this device has been refreshed and is fit to use.'

/** One line that says what a status means for reissuing, shown beside the status. */
export function getStatusHint(status: AssetStatus): string | null {
  if (status === 'decommissioned') return 'Decommissioned: it must be refreshed, and you must confirm that, before it is issued again.'
  if (status === 'nonfunctional') return 'Non-functional: retired for good. It cannot be issued again.'
  return null
}

/** Statuses a swap replacement candidate must have. */
export const SWAP_CANDIDATE_STATUSES: AssetStatus[] = ['available', 'decommissioned']

/**
 * A laptop can change collections (Laptop Inventory <-> Active Laptops
 * (NP), see 20260901000021_inventory_active_laptop_moves.sql) while
 * keeping its id, so a page keyed by the old collection's path needs to
 * redirect to the new one after a move.
 */
export const COLLECTION_BASE_PATH: Record<AssetCollection, string> = {
  serialized_assets: '/serialized-assets',
  active_laptops_np: '/active-laptops-np',
  monitors: '/monitors',
  other_equipment: '/other-equipment',
}

/**
 * Active Laptops (NP) displays 'provided' as "Active" in its UI only — the
 * underlying enum value is unchanged. Every other status/collection uses
 * the plain capitalized enum value.
 */
export function getStatusLabel(status: AssetStatus, collection: AssetCollection): string {
  if (collection === 'active_laptops_np' && status === 'provided') {
    return 'Active'
  }
  return status.charAt(0).toUpperCase() + status.slice(1)
}
