import type * as XLSXTypes from 'xlsx'
import { fetchAllRows, type PagedQuery, type PagedSource } from '../../lib/fetchAllRows'
import {
  CHECKLIST_STATUS_LABELS,
  checklistStatus,
  sortChecklistRows,
  type ChecklistSortKey,
  type ChecklistStatus,
  type ProgressFn,
  type SortDirection,
} from '../../lib/checklistProgress'
import { buildDetailsSheet, buildSheet, dateOrNull, fileDate, writeXlsx, type Column } from '../../lib/xlsxWorkbook'
import { ONBOARDING_STEPS, type OnboardingRow } from '../onboarding/api'
import { onboardingProgress } from '../onboarding/onboardingProgress'
import { LAPTOP_OUTCOMES, type OffboardingRow } from '../offboarding/api'
import { offboardingProgress } from '../offboarding/offboardingProgress'
import {
  ISSUE_STATUS_LABELS,
  REQUIREMENT_LABELS,
  isChargerIssue,
  isHeadsetIssue,
  isLaptopIssue,
  itemTypeLabel,
  returnProgress,
  type EquipmentIssue,
} from '../register/registerModel'

/**
 * Read-only Excel exports of the Onboarding and Offboarding lists.
 *
 * Rows: every checklist record matching the list's search (read page by
 * page — no 1,000-row cap), then the list's own status filter and sort
 * (the same functions ChecklistListView uses). Equipment: the employee's
 * register rows, exactly as the record's page lists them (all rows for
 * the linked employee; Offboarding leaves out rows that moved to someone
 * else / were unassigned outside a return, as its page does). Nothing
 * is invented: a value the database doesn't hold stays blank.
 */

export type StatusFilter = 'all' | ChecklistStatus
export interface ListView {
  search: string
  statusFilter: StatusFilter
  sort: { key: ChecklistSortKey; direction: SortDirection }
}

export interface EmployeeLite {
  id: string
  full_name: string
  email: string | null
}

export interface ExportData<T> {
  records: T[]
  employees: Map<string, EmployeeLite>
  /** Register rows per employee id (empty when the register isn't available). */
  issuesByEmployee: Map<string, EquipmentIssue[]>
  registerAvailable: boolean
}

const MISSING_TABLE = new Set(['PGRST205', '42P01'])

/** Same rows and order as the list on screen, but every matching record. */
export function applyListView<T extends { id: string; employee_name: string; created_at: string }>(
  rows: T[],
  view: ListView,
  progress: ProgressFn<T>,
): T[] {
  const filtered = rows.filter((r) => {
    const p = progress(r)
    return view.statusFilter === 'all' || checklistStatus(p.done, p.total) === view.statusFilter
  })
  return sortChecklistRows(filtered, progress, view.sort.key, view.sort.direction)
}

export async function loadExportData<T extends { id: string; employee_name: string; created_at: string; employee_id?: string | null }>(
  client: PagedSource,
  table: 'onboarding_checklists' | 'offboarding_checklists',
  view: ListView,
  progress: ProgressFn<T>,
): Promise<ExportData<T>> {
  const term = view.search.trim()
  // The same server-side search as the list (ilike on employee_name).
  const filter = term ? (q: PagedQuery) => q.ilike!('employee_name', `%${term}%`) : undefined
  const { rows } = await fetchAllRows<T>(client, table, { filter })
  const records = applyListView(rows, view, progress)

  const employees = new Map<string, EmployeeLite>()
  const issuesByEmployee = new Map<string, EquipmentIssue[]>()
  let registerAvailable = true
  try {
    for (const e of (await fetchAllRows<EmployeeLite>(client, 'employees', { columns: 'id, full_name, email' })).rows) employees.set(e.id, e)
    const wanted = new Set(records.map((r) => r.employee_id).filter((id): id is string => !!id))
    for (const issue of (await fetchAllRows<EquipmentIssue>(client, 'equipment_issues')).rows) {
      if (!issue.employee_id || !wanted.has(issue.employee_id)) continue
      const list = issuesByEmployee.get(issue.employee_id) ?? []
      list.push(issue)
      issuesByEmployee.set(issue.employee_id, list)
    }
    for (const list of issuesByEmployee.values()) list.sort((a, b) => a.issued_at.localeCompare(b.issued_at) || a.id.localeCompare(b.id))
  } catch (err) {
    // A database before the employee register (20260901000026).
    if (!MISSING_TABLE.has((err as { code?: string }).code ?? '')) throw err
    registerAvailable = false
  }
  return { records, employees, issuesByEmployee, registerAvailable }
}

// ------------------------------------------------------------ helpers
const yesNo = (b: boolean) => (b ? 'Done' : 'Not done')
const requirement = (a: OnboardingRow['charger_required']) => (a ? REQUIREMENT_LABELS[a] : '')
const pct = (done: number, total: number) => (total > 0 ? done / total : 0)
const PCT = '0%'
const DATE = 'yyyy-mm-dd'
const DATETIME = 'yyyy-mm-dd hh:mm'

function tally(issues: EquipmentIssue[]) {
  const counts = new Map<string, number>()
  for (const i of issues) {
    const label = i.item_kind === 'bulk' ? i.description : itemTypeLabel(i)
    counts.set(label, (counts.get(label) ?? 0) + i.quantity)
  }
  return [...counts].map(([label, n]) => `${label} ×${n}`).join(', ')
}
function equipmentFor<T extends { employee_id?: string | null }>(data: ExportData<T>, r: T) {
  return r.employee_id ? (data.issuesByEmployee.get(r.employee_id) ?? []) : []
}

/**
 * Each register row is listed once: under the checklist it was issued /
 * returned in when that record is exported, otherwise under the
 * employee's most recent exported record.
 */
function assignIssuesToRecords<T extends { id: string; employee_id?: string | null; created_at: string }>(
  data: ExportData<T>,
  linkOf: (i: EquipmentIssue) => string | null,
  include: (i: EquipmentIssue) => boolean,
) {
  const byId = new Map(data.records.map((r) => [r.id, r]))
  const latestFor = new Map<string, T>()
  for (const r of data.records) {
    if (!r.employee_id) continue
    const cur = latestFor.get(r.employee_id)
    if (!cur || r.created_at > cur.created_at) latestFor.set(r.employee_id, r)
  }
  const out: { record: T; issue: EquipmentIssue; linked: boolean }[] = []
  for (const [employeeId, issues] of data.issuesByEmployee) {
    for (const issue of issues) {
      if (!include(issue)) continue
      const link = linkOf(issue)
      const linkedRecord = link ? byId.get(link) : undefined
      const record = linkedRecord && linkedRecord.employee_id === employeeId ? linkedRecord : latestFor.get(employeeId)
      if (record) out.push({ record, issue, linked: !!linkedRecord })
    }
  }
  const order = new Map(data.records.map((r, i) => [r.id, i]))
  return out.sort((a, b) => order.get(a.record.id)! - order.get(b.record.id)! || a.issue.issued_at.localeCompare(b.issue.issued_at))
}

const employeeColumns = <T extends { employee_name: string; employee_id?: string | null }>(data: ExportData<T>): Column<T>[] => [
  { header: 'Employee Name', width: 26, value: (r) => r.employee_name },
  { header: 'Employee Record', width: 26, value: (r) => (r.employee_id ? data.employees.get(r.employee_id)?.full_name : '') },
  { header: 'Employee Email', width: 28, value: (r) => (r.employee_id ? data.employees.get(r.employee_id)?.email : '') },
]

// ------------------------------------------------------------ onboarding
const ONBOARDING_STEP_LABELS: Record<(typeof ONBOARDING_STEPS)[number], string> = {
  identity_created: 'Identity Created',
  equipment_assigned: 'Equipment Assigned',
  required_access_provided: 'Required Access Provided',
  onboarding_successful: 'Onboarding Successful',
}

export function onboardingSummaryColumns(data: ExportData<OnboardingRow>): Column<OnboardingRow>[] {
  const laptops = (r: OnboardingRow) => equipmentFor(data, r).filter((i) => isLaptopIssue(i) && i.status === 'open')
  return [
    ...employeeColumns(data),
    { header: 'Onboarding Status', width: 16, value: (r) => CHECKLIST_STATUS_LABELS[statusOf(onboardingProgress, r)] },
    { header: 'Steps Completed', width: 15, value: (r) => `${onboardingProgress(r).done}/${onboardingProgress(r).total}` },
    { header: 'Checklist Completion', width: 18, format: PCT, value: (r) => pct(onboardingProgress(r).done, onboardingProgress(r).total) },
    ...ONBOARDING_STEPS.map((s) => ({ header: ONBOARDING_STEP_LABELS[s], width: 22, value: (r: OnboardingRow) => yesNo(r[s]) })),
    { header: 'Requested Laptop', width: 24, value: (r) => r.requested_laptop },
    { header: 'Charger Required', width: 16, value: (r) => requirement(r.charger_required ?? null) },
    { header: 'Headset Required', width: 16, value: (r) => requirement(r.headset_required ?? null) },
    { header: 'Laptops Assigned Now', width: 20, value: (r) => (r.employee_id && data.registerAvailable ? laptops(r).length : '') },
    { header: 'Assigned Laptop Models', width: 34, value: (r) => laptops(r).map((i) => i.description).join('; ') },
    { header: 'Assigned Laptop Serials', width: 30, value: (r) => laptops(r).map((i) => i.serial ?? '').join('; ') },
    { header: 'Equipment With Employee', width: 40, value: (r) => tally(equipmentFor(data, r).filter((i) => i.status === 'open')) },
    { header: 'Equipment Returned / Closed', width: 22, value: (r) => (r.employee_id && data.registerAvailable ? equipmentFor(data, r).filter((i) => i.status !== 'open').length : '') },
    { header: 'Onboarding Started', width: 18, format: DATE, value: (r) => dateOrNull(r.created_at) },
    { header: 'Last Updated', width: 18, format: DATETIME, value: (r) => dateOrNull(r.updated_at) },
  ]
}

type Placed<T> = { record: T; issue: EquipmentIssue; linked: boolean }

const issueColumns = <T extends { employee_name: string; created_at: string }>(startedHeader: string, linkedHeader: string): Column<Placed<T>>[] => [
  { header: 'Employee Name', width: 26, value: (x) => x.record.employee_name },
  { header: startedHeader, width: 18, format: DATE, value: (x) => dateOrNull(x.record.created_at) },
  { header: linkedHeader, width: 20, value: (x) => (x.linked ? 'Yes' : 'No') },
  { header: 'Item Type', width: 16, value: (x) => itemTypeLabel(x.issue) },
  { header: 'Item', width: 30, value: (x) => x.issue.description },
  { header: 'Serial Number', width: 22, value: (x) => x.issue.serial },
  { header: 'Quantity', width: 10, value: (x) => x.issue.quantity },
  { header: 'Issued At', width: 18, format: DATETIME, value: (x) => dateOrNull(x.issue.issued_at) },
]

export function onboardingIssueColumns(): Column<Placed<OnboardingRow>>[] {
  return [
    ...issueColumns<OnboardingRow>('Onboarding Started', 'Issued In This Onboarding'),
    { header: 'Status', width: 26, value: (x) => ISSUE_STATUS_LABELS[x.issue.status] },
    { header: 'With Employee Now', width: 18, value: (x) => (x.issue.status === 'open' ? 'Yes' : 'No') },
    { header: 'Closed At', width: 18, format: DATETIME, value: (x) => dateOrNull(x.issue.closed_at) },
    { header: 'Note', width: 30, value: (x) => x.issue.close_note },
  ]
}

function statusOf<T>(progress: ProgressFn<T>, r: T) {
  const p = progress(r)
  return checklistStatus(p.done, p.total)
}

// ----------------------------------------------------------- offboarding
const outcomeLabel = (o: OffboardingRow['laptop_outcome']) => (o ? (LAPTOP_OUTCOMES.find((x) => x.value === o)?.label ?? o) : '')
/** Rows the Offboarding page lists as this employee's equipment. */
export const isReturnRow = (i: EquipmentIssue) => i.status !== 'transferred' && i.status !== 'unassigned'

function outcomes(issues: EquipmentIssue[]) {
  return issues
    .map((i) => `${i.serial ?? i.description}${i.quantity > 1 ? ` ×${i.quantity}` : ''}: ${ISSUE_STATUS_LABELS[i.status]}`)
    .join('; ')
}

export function offboardingSummaryColumns(data: ExportData<OffboardingRow>): Column<OffboardingRow>[] {
  const rowsOf = (r: OffboardingRow) => equipmentFor(data, r).filter(isReturnRow)
  const has = (r: OffboardingRow) => !!r.employee_id && data.registerAvailable
  const prog = (r: OffboardingRow) => returnProgress(rowsOf(r))
  const kind = (r: OffboardingRow, pred: (i: EquipmentIssue) => boolean) => outcomes(rowsOf(r).filter(pred))
  const isMonitor = (i: EquipmentIssue) => i.item_kind === 'serialized' && i.asset_collection === 'monitors'
  const isOther = (i: EquipmentIssue) => !isLaptopIssue(i) && !isChargerIssue(i) && !isHeadsetIssue(i) && !isMonitor(i)
  return [
    ...employeeColumns(data),
    { header: 'Offboarding Status', width: 16, value: (r) => CHECKLIST_STATUS_LABELS[statusOf(offboardingProgress, r)] },
    { header: 'Steps Completed', width: 15, value: (r) => `${offboardingProgress(r).done}/${offboardingProgress(r).total}` },
    { header: 'Checklist Completion', width: 18, format: PCT, value: (r) => pct(offboardingProgress(r).done, offboardingProgress(r).total) },
    { header: 'Removed Access', width: 16, value: (r) => yesNo(r.removed_access) },
    { header: 'Laptop Outcome (Checklist)', width: 24, value: (r) => outcomeLabel(r.laptop_outcome) },
    { header: 'Outcome Needs Review', width: 20, value: (r) => (r.outcome_needs_review ? 'Yes' : '') },
    { header: 'Equipment Items', width: 15, value: (r) => (has(r) ? prog(r).total : '') },
    { header: 'Items Processed', width: 15, value: (r) => (has(r) ? prog(r).processed : '') },
    { header: 'Pending Return', width: 15, value: (r) => (has(r) ? prog(r).pending : '') },
    { header: 'Return Progress', width: 15, format: PCT, value: (r) => (has(r) && prog(r).total ? prog(r).processed / prog(r).total : '') },
    { header: 'Retained (Authorized)', width: 20, value: (r) => (has(r) ? prog(r).retained : '') },
    { header: 'Lost', width: 8, value: (r) => (has(r) ? prog(r).lost : '') },
    { header: 'Laptop Returns', width: 40, value: (r) => kind(r, isLaptopIssue) },
    { header: 'Charger Returns', width: 30, value: (r) => kind(r, isChargerIssue) },
    { header: 'Headset Returns', width: 30, value: (r) => kind(r, isHeadsetIssue) },
    { header: 'Monitor Returns', width: 30, value: (r) => kind(r, isMonitor) },
    { header: 'Other Equipment Returns', width: 30, value: (r) => kind(r, isOther) },
    { header: 'Offboarding Started', width: 18, format: DATE, value: (r) => dateOrNull(r.created_at) },
    { header: 'Last Updated', width: 18, format: DATETIME, value: (r) => dateOrNull(r.updated_at) },
  ]
}

export function offboardingReturnColumns(): Column<Placed<OffboardingRow>>[] {
  return [
    ...issueColumns<OffboardingRow>('Offboarding Started', 'Processed In This Offboarding'),
    { header: 'Return Outcome', width: 26, value: (x) => ISSUE_STATUS_LABELS[x.issue.status] },
    { header: 'Pending', width: 10, value: (x) => (x.issue.status === 'open' ? 'Yes' : 'No') },
    { header: 'Processed At', width: 18, format: DATETIME, value: (x) => dateOrNull(x.issue.closed_at) },
    { header: 'Reason / Note', width: 30, value: (x) => x.issue.close_note },
  ]
}

// -------------------------------------------------------------- workbooks
function details(kind: string, view: ListView, records: number, items: number, itemLabel: string, exportedAt: Date, registerAvailable: boolean): [string, string][] {
  return [
    [`Equipment Ledger — ${kind} export`, ''],
    ['Exported at', exportedAt.toLocaleString()],
    ['Search', view.search.trim() || '(none)'],
    ['Status filter', view.statusFilter === 'all' ? 'All statuses' : CHECKLIST_STATUS_LABELS[view.statusFilter]],
    ['Sorted by', `${{ name: 'Employee name', started: 'Start date', progress: 'Steps completed', status: 'Status' }[view.sort.key]} (${view.sort.direction === 'asc' ? 'ascending' : 'descending'})`],
    [`${kind} records`, String(records)],
    [itemLabel, String(items)],
    ['Notes', 'Dates are in local time. Blank cells mean the value is not recorded. "Started" is when the record was created (no separate employee start date is stored). Laptops are identified by model and serial number (the ledger has no asset tags).'],
    ...(registerAvailable ? [] : ([['Equipment', 'Not available: this database has no employee equipment register.']] as [string, string][])),
  ]
}

export function buildOnboardingWorkbook(XLSX: typeof XLSXTypes, data: ExportData<OnboardingRow>, view: ListView, exportedAt: Date) {
  const placed = assignIssuesToRecords(data, (i) => i.onboarding_id, () => true)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, onboardingSummaryColumns(data), data.records), 'Onboarding Summary')
  XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, onboardingIssueColumns(), placed), 'Issued Equipment')
  XLSX.utils.book_append_sheet(wb, buildDetailsSheet(XLSX, details('Onboarding', view, data.records.length, placed.length, 'Issued equipment rows', exportedAt, data.registerAvailable)), 'Export Details')
  return { wb, records: data.records.length, items: placed.length }
}

export function buildOffboardingWorkbook(XLSX: typeof XLSXTypes, data: ExportData<OffboardingRow>, view: ListView, exportedAt: Date) {
  const placed = assignIssuesToRecords(data, (i) => i.offboarding_id, isReturnRow)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, offboardingSummaryColumns(data), data.records), 'Offboarding Summary')
  XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, offboardingReturnColumns(), placed), 'Equipment Returns')
  XLSX.utils.book_append_sheet(wb, buildDetailsSheet(XLSX, details('Offboarding', view, data.records.length, placed.length, 'Equipment rows', exportedAt, data.registerAvailable)), 'Export Details')
  return { wb, records: data.records.length, items: placed.length }
}

export const exportFilename = (kind: 'Onboarding' | 'Offboarding', d: Date) => `${kind}_${fileDate(d)}.xlsx`

/** Workbook bytes with frozen header rows on the two data sheets. */
export function workbookBytes(XLSX: typeof XLSXTypes, wb: XLSXTypes.WorkBook) {
  return writeXlsx(XLSX, wb, wb.SheetNames.slice(0, 2))
}
