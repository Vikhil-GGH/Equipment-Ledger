import type { EmploymentStatus } from '../../types/database.types'

/** One employee (employees, 20260901000026 + directory fields from 20260901000028). */
export interface DirectoryEmployee {
  id: string
  full_name: string
  name_key: string | null
  email: string | null
  email_key: string | null
  first_name: string | null
  last_name: string | null
  department: string | null
  job_title: string | null
  hr_status: string | null
  manager: string | null
  start_date: string | null
  employment_status: EmploymentStatus | null
  reactivation_pending: boolean
  status_changed_at: string | null
  updated_at: string | null
  created_at: string
}

/** Which employees the list shows. Active is the default. */
export type ShowFilter = 'active' | 'inactive' | 'not_in_directory' | 'all'
export const SHOW_LABELS: Record<ShowFilter, string> = {
  active: 'Active',
  inactive: 'Inactive / Offboarded',
  not_in_directory: 'Not in directory',
  all: 'All employees',
}

export const EMPLOYMENT_LABELS: Record<EmploymentStatus | 'none', string> = {
  active: 'Active',
  inactive: 'Inactive / Offboarded',
  none: 'Not in directory',
}

export type DirectorySortKey = 'name' | 'department' | 'start_date'
export interface DirectoryView {
  search: string
  show: ShowFilter
  department: string // '' = any
  hrStatus: string // '' = any
  sort: { key: DirectorySortKey; direction: 'asc' | 'desc' }
}
export const DEFAULT_VIEW: DirectoryView = { search: '', show: 'active', department: '', hrStatus: '', sort: { key: 'name', direction: 'asc' } }
export const PAGE_SIZES = [25, 50, 100] as const

/**
 * First / last name as recorded. Employees created before the directory
 * (by the equipment register) only have a full name — it is shown as is,
 * never split into a guessed first and last name.
 */
export function displayNames(e: Pick<DirectoryEmployee, 'first_name' | 'last_name' | 'full_name'>) {
  if (e.first_name || e.last_name) return { first: e.first_name ?? '', last: e.last_name ?? '', fullOnly: false }
  return { first: e.full_name, last: '', fullOnly: true }
}

const fold = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export function matchesShow(e: DirectoryEmployee, show: ShowFilter) {
  switch (show) {
    case 'active':
      return e.employment_status === 'active'
    case 'inactive':
      return e.employment_status === 'inactive'
    case 'not_in_directory':
      return e.employment_status === null
    case 'all':
      return true
  }
}

export function matchesSearch(e: DirectoryEmployee, term: string) {
  const t = fold(term)
  if (!t) return true
  return [e.full_name, `${e.first_name ?? ''} ${e.last_name ?? ''}`, e.email, e.department, e.job_title, e.manager].some((v) => fold(v).includes(t))
}

const sortName = (e: DirectoryEmployee) => fold(e.last_name || e.first_name ? `${e.last_name ?? ''} ${e.first_name ?? ''}` : e.full_name)

export function filterEmployees(rows: DirectoryEmployee[], view: DirectoryView): DirectoryEmployee[] {
  const out = rows.filter(
    (e) =>
      matchesShow(e, view.show) &&
      matchesSearch(e, view.search) &&
      (!view.department || (e.department ?? '') === view.department) &&
      (!view.hrStatus || (e.hr_status ?? '') === view.hrStatus),
  )
  const sign = view.sort.direction === 'asc' ? 1 : -1
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  const key: Record<DirectorySortKey, (a: DirectoryEmployee, b: DirectoryEmployee) => number> = {
    name: (a, b) => cmp(sortName(a), sortName(b)),
    department: (a, b) => {
      // Blank departments last whichever the direction.
      if (!a.department !== !b.department) return (a.department ? -1 : 1) * sign
      return cmp(a.department ?? '', b.department ?? '')
    },
    start_date: (a, b) => {
      if (!a.start_date !== !b.start_date) return (a.start_date ? -1 : 1) * sign
      return (a.start_date ?? '').localeCompare(b.start_date ?? '')
    },
  }
  // Ties: by name, then id — so the screen and the export always agree.
  return out.sort((a, b) => sign * key[view.sort.key](a, b) || cmp(sortName(a), sortName(b)) || a.id.localeCompare(b.id))
}

export function paginate<T>(rows: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const current = Math.min(Math.max(1, page), pages)
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages }
}

/** Distinct non-blank values, sorted — for the filter dropdowns. */
export function distinctValues(rows: DirectoryEmployee[], pick: (e: DirectoryEmployee) => string | null) {
  return [...new Set(rows.map(pick).filter((v): v is string => !!v && !!v.trim()))].sort((a, b) => a.localeCompare(b))
}

/**
 * Whether an imported "Employee Status" value means the person no longer
 * works here. Anything else (Active, Leave of Absence, blank, …) counts as
 * employed. The text itself is always kept as imported.
 */
export function statusFromHr(hr: string | null | undefined): EmploymentStatus {
  return /^(inactive|terminated|offboarded|former|separated|resigned|retired|deceased|left)\b/i.test((hr ?? '').trim()) ? 'inactive' : 'active'
}
