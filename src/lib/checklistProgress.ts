/**
 * Progress for a step checklist (onboarding, offboarding). Status is always
 * derived from the checklist's own boolean step columns — never stored —
 * so it can't drift from the checklist, and the step count comes from the
 * workflow's step list rather than being assumed.
 */
export type ChecklistStatus = 'not_started' | 'pending' | 'completed'

export const CHECKLIST_STATUS_LABELS: Record<ChecklistStatus, string> = {
  not_started: 'Not Started',
  pending: 'Pending',
  completed: 'Completed',
}

/** Sort order for a Status column: least done first. */
const STATUS_RANK: Record<ChecklistStatus, number> = { not_started: 0, pending: 1, completed: 2 }

export interface ChecklistRecord {
  id: string
  employee_name: string
  created_at: string
}

export function countCompleted<T, K extends keyof T>(record: T, steps: readonly K[]): number {
  return steps.filter((step) => record[step] === true).length
}

export function checklistStatus(done: number, total: number): ChecklistStatus {
  if (done <= 0) return 'not_started'
  if (done >= total) return 'completed'
  return 'pending'
}

export type ChecklistSortKey = 'name' | 'started' | 'progress' | 'status'
export type SortDirection = 'asc' | 'desc'

/** Most recently started first — the default order for checklist lists. */
export const DEFAULT_CHECKLIST_SORT: { key: ChecklistSortKey; direction: SortDirection } = {
  key: 'started',
  direction: 'desc',
}

export function sortChecklistRows<T extends ChecklistRecord, K extends keyof T>(
  rows: T[],
  steps: readonly K[],
  key: ChecklistSortKey,
  direction: SortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  const done = (r: T) => countCompleted(r, steps)
  const byStarted = (a: T, b: T) => a.created_at.localeCompare(b.created_at)
  const compare: Record<ChecklistSortKey, (a: T, b: T) => number> = {
    name: (a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base', numeric: true }),
    started: byStarted,
    progress: (a, b) => done(a) - done(b),
    status: (a, b) =>
      STATUS_RANK[checklistStatus(done(a), steps.length)] - STATUS_RANK[checklistStatus(done(b), steps.length)],
  }
  // Ties fall back to most recently started first, whatever the main order.
  return [...rows].sort((a, b) => sign * compare[key](a, b) || -byStarted(a, b))
}
