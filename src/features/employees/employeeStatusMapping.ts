import type { EmploymentStatus } from '../../types/database.types'

/**
 * How the Excel "Employee Status" text is read — an explicit list, nothing
 * guessed. The text itself is always stored exactly as imported.
 *
 * Comparison ignores capitalisation, surrounding spaces and repeated
 * spaces only ("  ACTIVE " = "Active"). Anything not listed — including a
 * blank cell and values such as "Leave of Absence" or "Terminated -
 * Voluntary" — is "review": it is flagged in the import preview, a new
 * employee is added as "Not in directory" unless you choose a status, and
 * an existing employee's employment status is left unchanged.
 *
 * To recognise another HR value, add it here (and to the tests).
 */
export const HR_STATUS_MAPPING: Record<string, EmploymentStatus> = {
  active: 'active',
  inactive: 'inactive',
  terminated: 'inactive',
  offboarded: 'inactive',
  separated: 'inactive',
  resigned: 'inactive',
  retired: 'inactive',
  'former employee': 'inactive',
}

export type HrClassification = EmploymentStatus | 'review'

export function normalizeHrStatus(text: string | null | undefined) {
  return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function classifyHrStatus(text: string | null | undefined): HrClassification {
  return HR_STATUS_MAPPING[normalizeHrStatus(text)] ?? 'review'
}

/** For display in the import dialog. */
export function mappingSummary() {
  const by = (s: EmploymentStatus) =>
    Object.entries(HR_STATUS_MAPPING)
      .filter(([, v]) => v === s)
      .map(([k]) => k.replace(/\b\w/g, (c) => c.toUpperCase()))
  return { active: by('active'), inactive: by('inactive') }
}
