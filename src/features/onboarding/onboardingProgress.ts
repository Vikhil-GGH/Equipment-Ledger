import { ONBOARDING_STEPS, type OnboardingRow } from './api'

/**
 * Onboarding status is always derived from the four checklist booleans —
 * never stored — so it can't drift from the checklist itself.
 */
export type OnboardingStatus = 'not_started' | 'pending' | 'completed'

export const TOTAL_ONBOARDING_STEPS = ONBOARDING_STEPS.length

export const ONBOARDING_STATUS_LABELS: Record<OnboardingStatus, string> = {
  not_started: 'Not Started',
  pending: 'Pending',
  completed: 'Completed',
}

/** Sort order for the Status column: least done first. */
const STATUS_RANK: Record<OnboardingStatus, number> = { not_started: 0, pending: 1, completed: 2 }

export function stepsCompleted(record: Pick<OnboardingRow, (typeof ONBOARDING_STEPS)[number]>): number {
  return ONBOARDING_STEPS.filter((step) => record[step]).length
}

export function onboardingStatus(record: Pick<OnboardingRow, (typeof ONBOARDING_STEPS)[number]>): OnboardingStatus {
  const done = stepsCompleted(record)
  if (done === 0) return 'not_started'
  if (done === TOTAL_ONBOARDING_STEPS) return 'completed'
  return 'pending'
}

export type OnboardingSortKey = 'name' | 'started' | 'progress' | 'status'
export type SortDirection = 'asc' | 'desc'

/** Most recently started first — the page's default order. */
export const DEFAULT_ONBOARDING_SORT: { key: OnboardingSortKey; direction: SortDirection } = {
  key: 'started',
  direction: 'desc',
}

export function sortOnboardingRows(
  rows: OnboardingRow[],
  key: OnboardingSortKey,
  direction: SortDirection,
): OnboardingRow[] {
  const sign = direction === 'asc' ? 1 : -1
  const byStarted = (a: OnboardingRow, b: OnboardingRow) => a.created_at.localeCompare(b.created_at)
  const compare: Record<OnboardingSortKey, (a: OnboardingRow, b: OnboardingRow) => number> = {
    name: (a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base', numeric: true }),
    started: byStarted,
    progress: (a, b) => stepsCompleted(a) - stepsCompleted(b),
    status: (a, b) => STATUS_RANK[onboardingStatus(a)] - STATUS_RANK[onboardingStatus(b)],
  }
  // Ties fall back to most recently started first, whatever the main order.
  return [...rows].sort((a, b) => sign * compare[key](a, b) || -byStarted(a, b))
}
