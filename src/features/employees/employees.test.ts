import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { DEFAULT_VIEW, displayNames, distinctValues, filterEmployees, paginate, type DirectoryEmployee } from './directoryModel'
import { HR_STATUS_MAPPING, classifyHrStatus } from './employeeStatusMapping'
import { EMPLOYEE_COLUMNS, buildPreview, commitPayload, linkRow, mapHeaders, parseDate, previewCounts } from './employeeImport'
import { buildEmployeeWorkbook, employeeExportFilename, employeeWorkbookBytes } from './exportEmployees'

let seq = 0
function emp(over: Partial<DirectoryEmployee> = {}): DirectoryEmployee {
  seq++
  const first = over.first_name ?? `First${seq}`
  const last = over.last_name ?? `Last${seq}`
  return {
    id: `e-${String(seq).padStart(5, '0')}`,
    full_name: `${first} ${last}`,
    name_key: `${first} ${last}`.toLowerCase(),
    email: null,
    email_key: null,
    first_name: first,
    last_name: last,
    department: null,
    job_title: null,
    hr_status: 'Active',
    manager: null,
    start_date: null,
    employment_status: 'active',
    reactivation_pending: false,
    status_changed_at: null,
    updated_at: null,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
    ...(over.email !== undefined ? { email_key: over.email ? over.email.trim().toLowerCase() : null } : {}),
  }
}

const HEADERS = EMPLOYEE_COLUMNS.map((c) => c.header)
const sheetRow = (v: Partial<Record<string, unknown>>) => Object.fromEntries(HEADERS.map((h) => [h, v[h] ?? '']))
const excelRow = (first: string, last: string, email: string, extra: Partial<Record<string, unknown>> = {}) =>
  sheetRow({ 'First name': first, 'Last name': last, 'Work email address': email, 'Employee Status': 'Active', ...extra })

// ----------------------------------------------------------- the list
describe('12: search, filters, sorting, pagination', () => {
  const rows = [
    emp({ first_name: 'Ana', last_name: 'Ruiz', department: 'Finance', job_title: 'Analyst', manager: 'Kim Lo', email: 'ana@x.invalid', start_date: '2024-03-01' }),
    emp({ first_name: 'Ben', last_name: 'Abel', department: 'Engineering', job_title: 'Engineer', start_date: '2025-06-01', hr_status: 'Leave of Absence' }),
    emp({ first_name: 'Cy', last_name: 'Diaz', department: null, start_date: null }),
    emp({ first_name: 'Dee', last_name: 'Old', employment_status: 'inactive', hr_status: 'Terminated', department: 'Finance' }),
    emp({ first_name: 'Eli', last_name: 'Reg', employment_status: null }),
    { ...emp(), first_name: null, last_name: null, full_name: 'Register Only', employment_status: 'active' as const },
  ]

  it('shows only Active employees by default; Inactive / Not in directory / All on request', () => {
    expect(filterEmployees(rows, DEFAULT_VIEW).map((e) => e.full_name)).toEqual(['Ben Abel', 'Cy Diaz', 'Register Only', 'Ana Ruiz'])
    expect(filterEmployees(rows, { ...DEFAULT_VIEW, show: 'inactive' }).map((e) => e.first_name)).toEqual(['Dee'])
    expect(filterEmployees(rows, { ...DEFAULT_VIEW, show: 'not_in_directory' }).map((e) => e.first_name)).toEqual(['Eli'])
    expect(filterEmployees(rows, { ...DEFAULT_VIEW, show: 'all' })).toHaveLength(6)
  })

  it('searches name, email, department, job title and manager (case and spacing ignored)', () => {
    const s = (search: string) => filterEmployees(rows, { ...DEFAULT_VIEW, search }).map((e) => e.first_name)
    expect(s('  ANA  ruiz')).toEqual(['Ana'])
    expect(s('ana@x')).toEqual(['Ana'])
    expect(s('engineering')).toEqual(['Ben'])
    expect(s('analyst')).toEqual(['Ana'])
    expect(s('kim')).toEqual(['Ana'])
    expect(s('register only')).toEqual([null])
  })

  it('filters by department and employee status', () => {
    expect(filterEmployees(rows, { ...DEFAULT_VIEW, department: 'Finance' }).map((e) => e.first_name)).toEqual(['Ana'])
    expect(filterEmployees(rows, { ...DEFAULT_VIEW, show: 'all', department: 'Finance' }).map((e) => e.first_name)).toEqual(['Dee', 'Ana'])
    expect(filterEmployees(rows, { ...DEFAULT_VIEW, hrStatus: 'Leave of Absence' }).map((e) => e.first_name)).toEqual(['Ben'])
    expect(distinctValues(rows, (e) => e.department)).toEqual(['Engineering', 'Finance'])
  })

  it('sorts by name, department and start date — blanks last, ties stable', () => {
    const order = (key: 'name' | 'department' | 'start_date', direction: 'asc' | 'desc') =>
      filterEmployees(rows, { ...DEFAULT_VIEW, sort: { key, direction } }).map((e) => e.full_name)
    expect(order('name', 'desc')).toEqual(['Ana Ruiz', 'Register Only', 'Cy Diaz', 'Ben Abel'])
    expect(order('department', 'asc')).toEqual(['Ben Abel', 'Ana Ruiz', 'Cy Diaz', 'Register Only'])
    expect(order('department', 'desc')).toEqual(['Ana Ruiz', 'Ben Abel', 'Cy Diaz', 'Register Only'])
    expect(order('start_date', 'desc')).toEqual(['Ben Abel', 'Ana Ruiz', 'Cy Diaz', 'Register Only'])
  })

  it('paginates every matching row', () => {
    const many = Array.from({ length: 2345 }, () => emp())
    const all = filterEmployees(many, DEFAULT_VIEW)
    expect(paginate(all, 1, 100).rows).toHaveLength(100)
    expect(paginate(all, 24, 100)).toMatchObject({ page: 24, pages: 24 })
    expect(paginate(all, 24, 100).rows).toHaveLength(45)
    expect(paginate(all, 99, 100).page).toBe(24)
    const seen = new Set(Array.from({ length: 24 }, (_, i) => paginate(all, i + 1, 100).rows.map((e) => e.id)).flat())
    expect(seen.size).toBe(2345)
  })

  it('names recorded before the directory are shown as recorded, never split', () => {
    expect(displayNames({ first_name: null, last_name: null, full_name: 'Mary Ann Van Dyke' })).toEqual({ first: 'Mary Ann Van Dyke', last: '', fullOnly: true })
  })

  it('Employee Status uses the explicit mapping; anything else is "review", never a guess', () => {
    for (const s of ['Active', '  ACTIVE ', 'active']) expect(classifyHrStatus(s), s).toBe('active')
    for (const s of ['Inactive', 'Terminated', 'Offboarded', 'Separated', 'Resigned', 'Retired', 'Former  Employee']) expect(classifyHrStatus(s), s).toBe('inactive')
    for (const s of ['', '   ', 'Leave of Absence', 'On Leave', 'Full-time', 'Terminated - Voluntary', 'Activ', 'Pending start', null, undefined]) expect(classifyHrStatus(s), String(s)).toBe('review')
    expect(Object.keys(HR_STATUS_MAPPING)).toEqual(['active', 'inactive', 'terminated', 'offboarded', 'separated', 'resigned', 'retired', 'former employee'])
  })
})

// ------------------------------------------------------------- import
describe('Excel import preview', () => {
  it('requires the eight columns (case and spacing ignored)', () => {
    expect(() => mapHeaders(['First name', 'Last name'])).toThrow(/missing columns: Current department, Primary job title, Employee Status, Manager, Employee start date, Work email address/)
    expect(mapHeaders(HEADERS.map((h) => ` ${h.toUpperCase()}  `)).email).toBe(' WORK EMAIL ADDRESS  ')
  })

  it('reads Excel dates (serial numbers and text)', () => {
    expect(parseDate(45658)).toBe('2025-01-01')
    expect(parseDate('2025-02-28')).toBe('2025-02-28')
    expect(parseDate('3/7/2025')).toBe('2025-03-07')
    expect(parseDate('')).toBe('')
    expect(parseDate('2025-02-30')).toBeNull()
    expect(parseDate('next week')).toBeNull()
  })

  it('1+5: new rows, invalid rows (names, email, date, repeated email) reported', () => {
    const rows = buildPreview(
      [
        excelRow('Ana', 'Ruiz', 'ana@x.invalid', { 'Employee start date': 45658, 'Current department': 'Finance' }),
        excelRow('', 'NoFirst', 'nofirst@x.invalid'),
        excelRow('Bad', 'Email', 'bad-email'),
        excelRow('Bad', 'Date', 'date@x.invalid', { 'Employee start date': 'soon' }),
        excelRow('Ana', 'Again', ' ANA@x.invalid'),
        sheetRow({}), // blank row ignored
        excelRow('No', 'Email', ''),
      ],
      HEADERS,
      [],
    )
    expect(rows.map((r) => [r.row, r.kind, r.errors])).toEqual([
      [2, 'new', []],
      [3, 'invalid', ['Missing first name']],
      [4, 'invalid', ['Invalid work email "bad-email"']],
      [5, 'invalid', ['Unreadable start date "soon" (use YYYY-MM-DD)']],
      [6, 'invalid', ['Same work email as row 2']],
      [8, 'new', []],
    ])
    expect(rows[0].fields).toMatchObject({ start_date: '2025-01-01', department: 'Finance' })
    expect(commitPayload(rows).map((r) => r.row)).toEqual([2, 8])
  })

  it('3: re-uploading the same file: every row is recognised by email and nothing is sent', () => {
    const directory = [emp({ first_name: 'Ana', last_name: 'Ruiz', email: 'Ana@X.invalid', department: 'Finance', hr_status: 'Active' })]
    const rows = buildPreview([excelRow('Ana', 'Ruiz', ' ana@x.INVALID ', { 'Current department': 'Finance' })], HEADERS, directory)
    expect(rows[0]).toMatchObject({ kind: 'unchanged', decision: 'skip' })
    expect(commitPayload(rows)).toEqual([])
  })

  it('4: blank cells never clear; only different values are listed and sent', () => {
    const directory = [emp({ first_name: 'Ana', last_name: 'Ruiz', email: 'ana@x.invalid', department: 'Finance', manager: 'Kim', job_title: 'Analyst' })]
    const rows = buildPreview([excelRow('Ana', 'Ruiz', 'ana@x.invalid', { 'Current department': 'Treasury', Manager: '', 'Primary job title': '' })], HEADERS, directory)
    expect(rows[0].kind).toBe('update')
    expect(rows[0].changes).toEqual([['department', 'Finance', 'Treasury']])
    expect(commitPayload(rows)).toEqual([{ row: 2, action: 'update', employee_id: directory[0].id, fields: { department: 'Treasury' } }])
  })

  it('6: same name without an email match is a possible duplicate — skipped until resolved; resolving either way', () => {
    const existing = emp({ first_name: 'Dana', last_name: 'Field', email: null })
    const registerOnly = { ...emp(), first_name: null, last_name: null, full_name: 'Sam Lee', name_key: 'sam lee' }
    const rows = buildPreview([excelRow('Dana', ' field', 'dana@x.invalid'), excelRow('Sam', 'Lee', '')], HEADERS, [existing, registerOnly])
    expect(rows.map((r) => [r.kind, r.decision, r.candidates.map((c) => c.id)])).toEqual([
      ['possible_duplicate', 'skip', [existing.id]],
      ['possible_duplicate', 'skip', [registerOnly.id]],
    ])
    expect(commitPayload(rows)).toEqual([])
    linkRow(rows[0], existing)
    rows[1].decision = 'create'
    expect(commitPayload(rows).map((r) => [r.action, r.employee_id])).toEqual([
      ['update', existing.id],
      ['create', undefined],
    ])
  })

  it('2: single-word names and email user names are flagged as possible matches — never merged', () => {
    const sadvi = { ...emp(), first_name: null, last_name: null, full_name: 'Sadvi', name_key: 'sadvi' }
    const ruizOld = emp({ first_name: 'Ana', last_name: 'Ruiz', email: 'ana.ruiz@old.invalid' })
    const unrelated = emp({ first_name: 'Ben', last_name: 'Abel', email: 'ben@x.invalid' })
    const rows = buildPreview(
      [
        excelRow('Sadvi', 'Reddy', 'sadvi.reddy@x.invalid'), // first name = single-word record
        excelRow('Priya', ' SADVI ', ''), // last name = single-word record
        excelRow('Anna', 'Ruiz-Lopez', 'Ana.Ruiz@new.invalid'), // same email user name, other domain
        excelRow('Cara', 'Diaz', 'cara@x.invalid'), // nothing plausible
        excelRow('Ben', 'Abel', 'ben@x.invalid'), // exact email: the existing employee, not a duplicate
      ],
      HEADERS,
      [sadvi, ruizOld, unrelated],
    )
    expect(rows.map((r) => [r.kind, r.candidates.map((c) => c.id), Object.values(r.candidateReasons)])).toEqual([
      ['possible_duplicate', [sadvi.id], ['recorded only as “Sadvi”']],
      ['possible_duplicate', [sadvi.id], ['recorded only as “SADVI”']],
      ['possible_duplicate', [ruizOld.id], ['same email user name, different domain']],
      ['new', [], []],
      ['unchanged', [], []],
    ])
    // Flagged rows are skipped until a person decides; linking keeps the existing id.
    expect(commitPayload(rows).map((r) => r.row)).toEqual([5])
    linkRow(rows[0], sadvi)
    expect(commitPayload(rows)[0]).toMatchObject({ action: 'update', employee_id: sadvi.id })
  })

  it('status changes: adding to the directory is proposed on; deactivation and re-activation need a tick', () => {
    const notInDir = emp({ email: 'a@x.invalid', employment_status: null })
    const active = emp({ email: 'b@x.invalid' })
    const offboarded = emp({ email: 'c@x.invalid', employment_status: 'inactive', hr_status: 'Terminated' })
    const rows = buildPreview(
      [
        excelRow(notInDir.first_name!, notInDir.last_name!, 'a@x.invalid'),
        excelRow(active.first_name!, active.last_name!, 'b@x.invalid', { 'Employee Status': 'Terminated' }),
        excelRow(offboarded.first_name!, offboarded.last_name!, 'c@x.invalid', { 'Employee Status': 'Active' }),
      ],
      HEADERS,
      [notInDir, active, offboarded],
    )
    expect(rows.map((r) => [r.statusChange, r.applyStatus])).toEqual([
      [{ from: null, to: 'active', reactivation: false }, true],
      [{ from: 'active', to: 'inactive', reactivation: false }, false],
      [{ from: 'inactive', to: 'active', reactivation: true }, false],
    ])
    expect(commitPayload(rows).map((r) => r.status)).toEqual(['active', undefined, undefined])
    rows[2].applyStatus = true
    expect(commitPayload(rows)[2]).toMatchObject({ employee_id: offboarded.id, status: 'active' })
  })

  it('an unrecognised Employee Status is flagged: new rows default to Not in directory, existing employees keep their status', () => {
    const active = emp({ email: 'b@x.invalid' })
    const offboarded = emp({ email: 'c@x.invalid', employment_status: 'inactive' })
    const rows = buildPreview(
      [
        excelRow('New', 'Leave', 'n@x.invalid', { 'Employee Status': 'Leave of Absence' }),
        excelRow('New', 'Blank', 'm@x.invalid', { 'Employee Status': '' }),
        excelRow(active.first_name!, active.last_name!, 'b@x.invalid', { 'Employee Status': 'Terminated - Voluntary' }),
        excelRow(offboarded.first_name!, offboarded.last_name!, 'c@x.invalid', { 'Employee Status': 'Rehired?' }),
      ],
      HEADERS,
      [active, offboarded],
    )
    expect(rows.map((r) => [r.fileStatus, r.kind, r.statusChange])).toEqual([
      ['review', 'new', undefined],
      ['review', 'new', undefined],
      ['review', 'update', undefined], // the text changes, the employment status does not
      ['review', 'update', undefined],
    ])
    expect(previewCounts(rows)).toMatchObject({ statusReview: 4, statusChanges: 0 })
    const payload = commitPayload(rows)
    expect(payload.map((p) => p.status)).toEqual([undefined, undefined, undefined, undefined])
    expect(payload[2]).toMatchObject({ fields: { hr_status: 'Terminated - Voluntary' } }) // text kept exactly
    rows[0].chosenStatus = 'active' // an explicit choice in the preview
    expect(commitPayload(rows)[0].status).toBe('active')
  })

  it('2: thousands of rows from a real .xlsx file', () => {
    const sheet = XLSX.utils.json_to_sheet(Array.from({ length: 3000 }, (_, i) => excelRow(`F${i}`, `L${i}`, `p${i}@x.invalid`, { 'Employee start date': 45000 + (i % 300) })), { header: HEADERS })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheet, 'Employees')
    const read = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' })
    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(read.Sheets.Employees, { defval: '' })
    const started = performance.now()
    const rows = buildPreview(parsed, HEADERS, Array.from({ length: 2000 }, () => emp()))
    expect(performance.now() - started).toBeLessThan(3000)
    expect(previewCounts(rows)).toMatchObject({ total: 3000, new: 3000, invalid: 0, statusReview: 0, toApply: 3000 })
  })
})

// ------------------------------------------------------------- export
describe('13: Excel export', () => {
  it('exports exactly the filtered, sorted rows — every page — with the import headings', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => emp({ department: i % 2 ? 'Ops' : 'IT', email: `p${i}@x.invalid`, start_date: '2025-01-15' }))
    const view = { ...DEFAULT_VIEW, department: 'Ops', sort: { key: 'name' as const, direction: 'desc' as const } }
    const matching = filterEmployees(rows, view)
    const wb = XLSX.read(employeeWorkbookBytes(XLSX, buildEmployeeWorkbook(XLSX, matching, view, new Date())), { type: 'array', cellDates: true })
    expect(wb.SheetNames).toEqual(['Employees', 'Export Details'])
    const out = XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets.Employees)
    expect(out).toHaveLength(600)
    expect(out.map((r) => r['Work email address'])).toEqual(matching.map((e) => e.email))
    const headerRow = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Employees, { header: 1 })[0]
    expect(headerRow.slice(0, 8)).toEqual(HEADERS)
    expect(out[0]['Employee start date']).toBeInstanceOf(Date)
    expect(out[0]['Employment (Ledger)']).toBe('Active')
    // The export can be uploaded again unchanged.
    expect(() => mapHeaders(headerRow)).not.toThrow()
    expect(employeeExportFilename(new Date(2026, 9, 19))).toBe('Active_Employees_2026-10-19.xlsx')
  })
})
