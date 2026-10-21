import type { EmploymentStatus } from '../../types/database.types'
import { EMPLOYMENT_LABELS, type DirectoryEmployee } from './directoryModel'
import { classifyHrStatus, type HrClassification } from './employeeStatusMapping'

/**
 * Active Employees Excel import: reads the sheet, validates it, and
 * proposes what to do with each row — for the user to review. Nothing is
 * decided silently:
 *  - work email (trimmed, lower-cased) is the matching key: same email ->
 *    the existing employee (update only what differs; blank cells never
 *    clear anything);
 *  - no email match but a plausible one -> "possible duplicate", skipped
 *    unless the user links it to an employee or creates a new one. Plausible:
 *    the same normalised name; an employee recorded under a single word
 *    (e.g. "Sadvi") that equals the row's first or last name; or the same
 *    email user name at another domain. Never merged automatically;
 *  - "Employee Status" is read with the explicit list in
 *    employeeStatusMapping.ts; an unrecognised value is flagged for review
 *    and never turned into a status;
 *  - a status change from the file (incl. re-activating an offboarded
 *    employee) is applied only when ticked;
 *  - employees not in the file are never touched.
 */

export const EMPLOYEE_COLUMNS = [
  { key: 'first_name', header: 'First name' },
  { key: 'last_name', header: 'Last name' },
  { key: 'department', header: 'Current department' },
  { key: 'job_title', header: 'Primary job title' },
  { key: 'hr_status', header: 'Employee Status' },
  { key: 'manager', header: 'Manager' },
  { key: 'start_date', header: 'Employee start date' },
  { key: 'email', header: 'Work email address' },
] as const
export type EmployeeField = (typeof EMPLOYEE_COLUMNS)[number]['key']
export type EmployeeFields = Record<EmployeeField, string>

const headerKey = (h: string) => h.trim().replace(/\s+/g, ' ').toLowerCase()
const emailKey = (e: string) => e.trim().toLowerCase()
const nameKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Maps the eight required headers (case and spacing ignored). Throws listing any that are missing. */
export function mapHeaders(headers: string[]): Record<EmployeeField, string> {
  const byKey = new Map(headers.map((h) => [headerKey(h), h]))
  const missing = EMPLOYEE_COLUMNS.filter((c) => !byKey.has(headerKey(c.header))).map((c) => c.header)
  if (missing.length) throw new Error(`The file is missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`)
  return Object.fromEntries(EMPLOYEE_COLUMNS.map((c) => [c.key, byKey.get(headerKey(c.header))!])) as Record<EmployeeField, string>
}

/** An Excel date (serial number or text) -> YYYY-MM-DD, '' if blank, null if unreadable. */
export function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return ''
  const iso = (d: Date) => (Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10))
  if (typeof v === 'number') return v > 0 && v < 100000 ? iso(new Date(Math.round((v - 25569) * 86_400_000))) : null
  if (v instanceof Date) return iso(new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())))
  const s = String(v).trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return valid(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s) // US: month/day/year
  if (m) return valid(+m[3], +m[1], +m[2])
  return null
  function valid(y: number, mo: number, d: number) {
    const dt = new Date(Date.UTC(y, mo - 1, d))
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null
  }
}

export type RowKind = 'new' | 'update' | 'unchanged' | 'possible_duplicate' | 'invalid'
export type Decision = 'create' | 'update' | 'skip'

export interface PreviewRow {
  row: number // spreadsheet row number
  fields: EmployeeFields
  errors: string[]
  kind: RowKind
  /** The employee this row matched by work email. */
  match?: DirectoryEmployee
  /** Plausible matches when there was no email match (never merged automatically). */
  candidates: DirectoryEmployee[]
  /** Why each candidate was suggested, by employee id. */
  candidateReasons: Record<string, string>
  /** Non-blank values that differ from the matched employee: [field, current, new]. */
  changes: [EmployeeField, string, string][]
  /** Employment status the file's "Employee Status" maps to, or 'review' if not recognised. */
  fileStatus: HrClassification
  /** New rows with an unrecognised status: what to add them as (null = Not in directory). */
  chosenStatus: EmploymentStatus | null
  /** Status change the user may approve (current -> file). */
  statusChange?: { from: EmploymentStatus | null; to: EmploymentStatus; reactivation: boolean }
  // ---- the user's choices (defaults set by buildPreview)
  decision: Decision
  linkTo?: string
  applyStatus: boolean
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim()

export interface DuplicateMatches {
  candidates: DirectoryEmployee[]
  /** employee id -> why they might be the same person */
  reasons: Record<string, string>
}

/**
 * Who in the directory might be the same person as these fields: the one
 * rule used by the Excel preview ("possible duplicate") and by the Add
 * employee form. Nothing is ever merged automatically; this only finds people.
 * Matches: same first + last name, an employee recorded under one word that
 * is this first or last name, or the same email user name on another domain.
 */
export function duplicateFinder(directory: DirectoryEmployee[]) {
  const byName = new Map<string, DirectoryEmployee[]>()
  // Employees recorded under one word only (e.g. "Sadvi"), by that word.
  const bySingleWord = new Map<string, DirectoryEmployee[]>()
  // Email user name ("ana.ruiz" of ana.ruiz@old.example) -> employees.
  const byEmailUser = new Map<string, DirectoryEmployee[]>()
  const add = (m: Map<string, DirectoryEmployee[]>, k: string, e: DirectoryEmployee) => m.set(k, [...(m.get(k) ?? []), e])
  for (const e of directory) {
    const keys = new Set([e.name_key, e.first_name || e.last_name ? nameKey(`${e.first_name ?? ''} ${e.last_name ?? ''}`) : null])
    for (const k of keys) if (k) add(byName, k, e)
    for (const k of keys) if (k && !k.includes(' ')) add(bySingleWord, k, e)
    if (e.email_key?.includes('@')) add(byEmailUser, e.email_key.split('@')[0], e)
  }
  return (fields: Pick<EmployeeFields, 'first_name' | 'last_name' | 'email'>): DuplicateMatches => {
    const reasons: Record<string, string> = {}
    const suggest = (list: DirectoryEmployee[] | undefined, reason: string) => {
      for (const c of list ?? []) if (!reasons[c.id]) reasons[c.id] = reason
    }
    suggest(byName.get(nameKey(`${fields.first_name} ${fields.last_name}`)), 'same name')
    suggest(bySingleWord.get(nameKey(fields.first_name)), `recorded only as “${fields.first_name.trim()}”`)
    suggest(bySingleWord.get(nameKey(fields.last_name)), `recorded only as “${fields.last_name.trim()}”`)
    const key = fields.email ? emailKey(fields.email) : ''
    if (key.includes('@')) {
      const [user, domain] = key.split('@')
      suggest(byEmailUser.get(user)?.filter((c) => c.email_key?.split('@')[1] !== domain), 'same email user name, different domain')
    }
    return { candidates: directory.filter((c) => reasons[c.id]), reasons }
  }
}

export function buildPreview(sheetRows: Record<string, unknown>[], headers: string[], directory: DirectoryEmployee[]): PreviewRow[] {
  const map = mapHeaders(headers)
  const byEmail = new Map<string, DirectoryEmployee>()
  for (const e of directory) if (e.email_key) byEmail.set(e.email_key, e)
  const findDuplicates = duplicateFinder(directory)
  const seenEmails = new Map<string, number>()
  const out: PreviewRow[] = []
  sheetRows.forEach((raw, i) => {
    const fields = Object.fromEntries(EMPLOYEE_COLUMNS.map((c) => [c.key, c.key === 'start_date' ? '' : text(raw[map[c.key]])])) as EmployeeFields
    if (EMPLOYEE_COLUMNS.every((c) => c.key === 'start_date' || !fields[c.key]) && !text(raw[map.start_date])) return // blank row
    const errors: string[] = []
    const date = parseDate(raw[map.start_date])
    if (date === null) errors.push(`Unreadable start date "${text(raw[map.start_date])}" (use YYYY-MM-DD)`)
    fields.start_date = date ?? ''
    if (!fields.first_name) errors.push('Missing first name')
    if (!fields.last_name) errors.push('Missing last name')
    if (fields.email && !EMAIL.test(fields.email)) errors.push(`Invalid work email "${fields.email}"`)
    const key = fields.email ? emailKey(fields.email) : ''
    if (key && seenEmails.has(key)) errors.push(`Same work email as row ${seenEmails.get(key)}`)
    if (key && !seenEmails.has(key)) seenEmails.set(key, i + 2)

    const fileStatus = classifyHrStatus(fields.hr_status)
    const row: PreviewRow = { row: i + 2, fields, errors, kind: 'invalid', candidates: [], candidateReasons: {}, changes: [], fileStatus, chosenStatus: null, decision: 'skip', applyStatus: false }
    if (errors.length) return void out.push(row)

    const match = key ? byEmail.get(key) : undefined
    if (match) {
      describeUpdate(row, match)
    } else {
      const { candidates, reasons } = findDuplicates(fields)
      if (candidates.length) {
        row.kind = 'possible_duplicate'
        row.candidates = candidates
        row.candidateReasons = reasons
      } else {
        row.kind = 'new'
        row.decision = 'create'
      }
    }
    out.push(row)
  })
  return out
}

/** Fills changes / status proposal for a row matched (or linked) to an employee. */
export function describeUpdate(row: PreviewRow, e: DirectoryEmployee) {
  row.match = e
  row.changes = EMPLOYEE_COLUMNS.flatMap((c): [EmployeeField, string, string][] => {
    const next = row.fields[c.key]
    const cur = (e[c.key] ?? '').toString()
    if (!next) return [] // blank never clears
    // Emails are the same address whatever their capitalisation.
    const same = c.key === 'email' ? emailKey(cur) === emailKey(next) : cur.trim() === next.trim()
    return same ? [] : [[c.key, cur, next]]
  })
  const current = e.employment_status
  const to = row.fileStatus
  // An unrecognised Employee Status never proposes a status change.
  row.statusChange = to === 'review' || current === to ? undefined : { from: current, to, reactivation: current === 'inactive' && to === 'active' }
  // Adding someone to the directory (no status yet) is what the file is for;
  // anything else — deactivating or re-activating — must be ticked.
  row.applyStatus = !!row.statusChange && current === null
  row.kind = row.changes.length || row.statusChange ? 'update' : 'unchanged'
  row.decision = row.kind === 'update' ? 'update' : 'skip'
}

export function linkRow(row: PreviewRow, employee: DirectoryEmployee | undefined) {
  if (!employee) {
    row.match = undefined
    row.linkTo = undefined
    row.changes = []
    row.statusChange = undefined
    row.applyStatus = false
    return
  }
  row.linkTo = employee.id
  const kind = row.kind
  describeUpdate(row, employee)
  row.kind = kind // stays "possible duplicate" for display
  row.decision = 'update'
}

export interface CommitRow {
  row: number
  action: 'create' | 'update'
  employee_id?: string
  fields: Partial<EmployeeFields>
  status?: EmploymentStatus
}

/** What commit_employee_import receives: only the rows the user chose to apply. */
export function commitPayload(rows: PreviewRow[]): CommitRow[] {
  return rows.flatMap((r): CommitRow[] => {
    if (r.errors.length || r.decision === 'skip') return []
    if (r.decision === 'create') {
      const status = r.fileStatus === 'review' ? r.chosenStatus : r.fileStatus
      // No status = added as "Not in directory".
      return [{ row: r.row, action: 'create', fields: r.fields, ...(status ? { status } : {}) }]
    }
    const id = r.linkTo ?? r.match?.id
    if (!id) return []
    // Only what differs is sent: untouched values can't be rewritten.
    const fields = Object.fromEntries(r.changes.map(([k, , next]) => [k, next])) as Partial<EmployeeFields>
    return [{ row: r.row, action: 'update', employee_id: id, fields, ...(r.applyStatus && r.statusChange ? { status: r.statusChange.to } : {}) }]
  })
}

export function previewCounts(rows: PreviewRow[]) {
  const c = { total: rows.length, new: 0, update: 0, unchanged: 0, possible_duplicate: 0, invalid: 0, statusChanges: 0, statusReview: 0, toApply: commitPayload(rows).length }
  for (const r of rows) {
    c[r.kind]++
    if (r.statusChange) c.statusChanges++
    if (needsStatusReview(r)) c.statusReview++
  }
  return c
}

export const statusChangeLabel = (s: NonNullable<PreviewRow['statusChange']>) =>
  `${s.from ? EMPLOYMENT_LABELS[s.from] : 'Not in directory'} → ${EMPLOYMENT_LABELS[s.to]}${s.reactivation ? ' (re-activation)' : ''}`

/** A valid row whose Employee Status isn't in the mapping. */
export const needsStatusReview = (r: PreviewRow) => r.errors.length === 0 && r.fileStatus === 'review'
