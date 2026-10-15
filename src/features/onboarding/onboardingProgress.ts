import {
  CHECKLIST_STATUS_LABELS,
  DEFAULT_CHECKLIST_SORT,
  checklistStatus,
  countCompleted,
  sortChecklistRows,
  type ChecklistSortKey,
  type ChecklistStatus,
  type SortDirection,
} from '../../lib/checklistProgress'
import { ONBOARDING_STEPS, type OnboardingRow } from './api'

/** Onboarding's view of the shared checklist progress rules (src/lib/checklistProgress.ts). */
export type OnboardingStatus = ChecklistStatus
export type OnboardingSortKey = ChecklistSortKey
export type { SortDirection }

export const TOTAL_ONBOARDING_STEPS = ONBOARDING_STEPS.length
export const ONBOARDING_STATUS_LABELS = CHECKLIST_STATUS_LABELS
export const DEFAULT_ONBOARDING_SORT = DEFAULT_CHECKLIST_SORT

type StepFields = Pick<OnboardingRow, (typeof ONBOARDING_STEPS)[number]>

export function stepsCompleted(record: StepFields): number {
  return countCompleted(record, ONBOARDING_STEPS)
}

export function onboardingStatus(record: StepFields): OnboardingStatus {
  return checklistStatus(stepsCompleted(record), TOTAL_ONBOARDING_STEPS)
}

export function sortOnboardingRows(
  rows: OnboardingRow[],
  key: OnboardingSortKey,
  direction: SortDirection,
): OnboardingRow[] {
  return sortChecklistRows(rows, ONBOARDING_STEPS, key, direction)
}
