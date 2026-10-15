/**
 * Progress for a checklist (onboarding, offboarding). Status is always
 * derived from the checklist record itself — never stored — so it can't
 * drift, and each workflow supplies its own rule for what counts as a
 * required step (Onboarding: four step columns; Offboarding: access
 * removed + one laptop outcome).
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

export interface Progress {
  done: number
  total: number
}
export type ProgressFn<T> = (record: T) => Progress

/** Progress rule for a checklist whose required steps are boolean columns. */
export function progressFromSteps<T, K extends keyof T>(steps: readonly K[]): ProgressFn<T> {
  return (record) => ({ done: countCompleted(record, steps), total: steps.length })
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

export function sortChecklistRows<T extends ChecklistRecord>(
  rows: T[],
  progressOf: ProgressFn<T>,
  key: ChecklistSortKey,
  direction: SortDirection,
): T[] {
  const sign = direction === 'asc' ? 1 : -1
  const rank = (r: T) => {
    const p = progressOf(r)
    return STATUS_RANK[checklistStatus(p.done, p.total)]
  }
  const byStarted = (a: T, b: T) => a.created_at.localeCompare(b.created_at)
  const compare: Record<ChecklistSortKey, (a: T, b: T) => number> = {
    name: (a, b) => a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base', numeric: true }),
    started: byStarted,
    progress: (a, b) => progressOf(a).done - progressOf(b).done,
    status: (a, b) => rank(a) - rank(b),
  }
  // Ties fall back to most recently started first, whatever the main order.
  return [...rows].sort((a, b) => sign * compare[key](a, b) || -byStarted(a, b))
}
