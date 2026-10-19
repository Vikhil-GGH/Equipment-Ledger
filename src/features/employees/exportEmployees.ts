import type * as XLSXTypes from 'xlsx'
import { buildDetailsSheet, buildSheet, dateOrNull, fileDate, writeXlsx, type Column } from '../../lib/xlsxWorkbook'
import { EMPLOYMENT_LABELS, SHOW_LABELS, type DirectoryEmployee, type DirectoryView } from './directoryModel'

/**
 * The eight directory columns (same headings the import reads, so an
 * export can be edited and uploaded again), plus the employment status the
 * app tracks. Rows are exactly the filtered, sorted list — every page.
 */
export const EXPORT_COLUMNS: Column<DirectoryEmployee>[] = [
  { header: 'First name', width: 18, value: (e) => (e.first_name || e.last_name ? e.first_name : e.full_name) },
  { header: 'Last name', width: 18, value: (e) => e.last_name },
  { header: 'Current department', width: 22, value: (e) => e.department },
  { header: 'Primary job title', width: 26, value: (e) => e.job_title },
  { header: 'Employee Status', width: 16, value: (e) => e.hr_status },
  { header: 'Manager', width: 22, value: (e) => e.manager },
  { header: 'Employee start date', width: 18, format: 'yyyy-mm-dd', value: (e) => (e.start_date ? dateOrNull(`${e.start_date}T00:00:00`) : null) },
  { header: 'Work email address', width: 30, value: (e) => e.email },
  { header: 'Employment (Ledger)', width: 20, value: (e) => EMPLOYMENT_LABELS[e.employment_status ?? 'none'] },
  { header: 'Status Changed', width: 18, format: 'yyyy-mm-dd hh:mm', value: (e) => dateOrNull(e.status_changed_at) },
]

export function buildEmployeeWorkbook(XLSX: typeof XLSXTypes, rows: DirectoryEmployee[], view: DirectoryView, exportedAt: Date) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, buildSheet(XLSX, EXPORT_COLUMNS, rows), 'Employees')
  XLSX.utils.book_append_sheet(
    wb,
    buildDetailsSheet(XLSX, [
      ['Equipment Ledger — Active Employees export', ''],
      ['Exported at', exportedAt.toLocaleString()],
      ['Showing', SHOW_LABELS[view.show]],
      ['Search', view.search.trim() || '(none)'],
      ['Department', view.department || 'All'],
      ['Employee Status', view.hrStatus || 'All'],
      ['Sorted by', `${{ name: 'Name', department: 'Department', start_date: 'Start date' }[view.sort.key]} (${view.sort.direction === 'asc' ? 'ascending' : 'descending'})`],
      ['Employees', String(rows.length)],
      ['Notes', 'Blank cells mean the value is not recorded. Employees recorded before the directory have only a full name, shown under First name.'],
    ]),
    'Export Details',
  )
  return wb
}

export const employeeExportFilename = (d: Date) => `Active_Employees_${fileDate(d)}.xlsx`

export function employeeWorkbookBytes(XLSX: typeof XLSXTypes, wb: XLSXTypes.WorkBook) {
  return writeXlsx(XLSX, wb, ['Employees'])
}
