import type { Progress } from '../../lib/checklistProgress'
import type { OffboardingRow } from './api'

/**
 * Offboarding is complete when access is removed AND one laptop outcome is
 * recorded (Received, Retained, Decommissioned — or Not applicable when the
 * employee had no laptop). The three outcomes are alternatives, so they
 * count as one required step, never three.
 */
export const OFFBOARDING_REQUIRED_STEPS = 2

export function offboardingProgress(
  record: Pick<OffboardingRow, 'removed_access' | 'laptop_outcome'>,
): Progress {
  return {
    done: (record.removed_access ? 1 : 0) + (record.laptop_outcome ? 1 : 0),
    total: OFFBOARDING_REQUIRED_STEPS,
  }
}

/** Legacy records that had several laptop outcomes ticked are never resolved silently. */
export function offboardingFlag(record: Pick<OffboardingRow, 'outcome_needs_review'>): string | null {
  return record.outcome_needs_review ? 'Laptop outcome needs review' : null
}
