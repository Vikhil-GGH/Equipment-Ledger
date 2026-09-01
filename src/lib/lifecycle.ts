import type { AssetAction, AssetCollection, AssetStatus } from '../types/database.types'

/**
 * Client-side mirror of the state machine enforced in
 * supabase/migrations/20260901000009_lifecycle_functions.sql
 * (perform_lifecycle_action). Keep both in sync — this copy drives which
 * action buttons the UI shows; the SQL function is the real gate.
 *
 * Semantic note: 'decommissioned' is NOT terminal — the device is refreshed
 * and re-enters the reissue pool (Provide/Retain/Mark damaged all resume).
 * 'nonfunctional' is the actual terminal state.
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
  },
  nonfunctional: {},
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

/** Statuses a swap replacement candidate must have. */
export const SWAP_CANDIDATE_STATUSES: AssetStatus[] = ['available', 'decommissioned']

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
