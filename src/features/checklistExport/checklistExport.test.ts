import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { PagedQuery, PagedSource } from '../../lib/fetchAllRows'
import { sortChecklistRows } from '../../lib/checklistProgress'
import type { OnboardingRow } from '../onboarding/api'
import type { OffboardingRow } from '../offboarding/api'
import { onboardingProgress } from '../onboarding/onboardingProgress'
import { offboardingProgress } from '../offboarding/offboardingProgress'
import type { EquipmentIssue } from '../register/registerModel'
import {
  buildOffboardingWorkbook,
  buildOnboardingWorkbook,
  exportFilename,
  loadExportData,
  workbookBytes,
  type ListView,
} from './checklistExport'

// ----------------------------------------------------------------- fakes
type Row = { id: string; [k: string]: unknown }

/** PostgREST-like: ordered ranges, exact count, 1,000-row cap, ilike. Read-only: no write methods exist. */
function fakeApi(input: Record<string, object[]>, opts: { missing?: string[] } = {}) {
  const tables = input as unknown as Record<string, Row[]>
  const calls: string[] = []
  const api: PagedSource = {
    from: (table) => ({
      select: () => {
        const filters: ((r: Row) => boolean)[] = []
        const q: PagedQuery = {
          ilike: (col, pattern) => {
            const needle = pattern.replace(/^%|%$/g, '').toLowerCase()
            filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle))
            return q
          },
          order: () => ({
            range: async (from, to) => {
              calls.push(`${table}[${from}]`)
              if (opts.missing?.includes(table)) return { data: null, count: null, error: { message: 'missing', code: 'PGRST205' } }
              const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).sort((a, b) => a.id.localeCompare(b.id))
              return { data: rows.slice(from, Math.min(to + 1, from + 1000)), count: rows.length, error: null }
            },
          }),
        }
        return q
      },
    }),
  }
  return { api, calls }
}

const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`
const ts = (day: number) => new Date(Date.UTC(2026, 8, day, 12)).toISOString()

function onboarding(n: number, over: Partial<OnboardingRow> = {}): OnboardingRow {
  return {
    id: id('onb', n),
    employee_name: `Employee ${n}`,
    identity_created: false,
    equipment_assigned: false,
    required_access_provided: false,
    onboarding_successful: false,
    assigned_asset_id: null,
    employee_id: null,
    requested_laptop: null,
    charger_required: null,
    headset_required: null,
    created_at: ts((n % 28) + 1),
    updated_at: ts((n % 28) + 1),
    ...over,
  }
}
function offboarding(n: number, over: Partial<OffboardingRow> = {}): OffboardingRow {
  return {
    id: id('off', n),
    employee_name: `Employee ${n}`,
    removed_access: false,
    laptop_received: false,
    laptop_retained: false,
    laptop_decommissioned: false,
    laptop_outcome: null,
    outcome_needs_review: false,
    employee_id: null,
    created_at: ts((n % 28) + 1),
    updated_at: ts((n % 28) + 1),
    ...over,
  }
}
let seq = 0
function issue(employee_id: string, over: Partial<EquipmentIssue>): EquipmentIssue {
  seq++
  return {
    id: id('iss', seq),
    employee_id,
    assignee_name: 'x',
    employee_ambiguous: false,
    item_kind: 'serialized',
    asset_collection: 'active_laptops_np',
    asset_id: id('asset', seq),
    bulk_item_id: null,
    quantity: 1,
    description: 'Dell Latitude 5440',
    serial: `SN-${seq}`,
    issued_at: ts(2 + (seq % 20)),
    onboarding_id: null,
    status: 'open',
    closed_at: null,
    close_note: null,
    offboarding_id: null,
    source: 'issue',
    ...over,
  }
}

const VIEW: ListView = { search: '', statusFilter: 'all', sort: { key: 'started', direction: 'desc' } }
const sheetRows = (wb: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: '' })
const headers = (wb: XLSX.WorkBook, name: string) => (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1 })[0] as string[])
/** Write to real .xlsx bytes and read back — what Excel would open. */
const roundTrip = (wb: XLSX.WorkBook) => XLSX.read(workbookBytes(XLSX, wb), { type: 'array', cellFormula: true, cellNF: true })

// ------------------------------------------------------------- the tests
describe('Onboarding export', () => {
  it('pagination: every matching record (2,500), not just the first 1,000', async () => {
    const records = Array.from({ length: 2500 }, (_, i) => onboarding(i))
    const { api, calls } = fakeApi({ onboarding_checklists: records, employees: [], equipment_issues: [] })
    const data = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress)
    expect(data.records).toHaveLength(2500)
    expect(calls.filter((c) => c.startsWith('onboarding_checklists'))).toHaveLength(3)
    const { wb } = buildOnboardingWorkbook(XLSX, data, VIEW, new Date())
    expect(sheetRows(roundTrip(wb), 'Onboarding Summary')).toHaveLength(2500)
  })

  it('search, status filter and sort match the list on screen', async () => {
    const records = [
      onboarding(1, { employee_name: 'Ann Lee', identity_created: true }),
      onboarding(2, { employee_name: 'Bob Annis' }),
      onboarding(3, { employee_name: 'Cara Diaz', identity_created: true }),
      onboarding(4, { employee_name: 'Joanne Kim', identity_created: true, equipment_assigned: true, required_access_provided: true, onboarding_successful: true }),
      onboarding(5, { employee_name: 'Hannah Ng', identity_created: true, equipment_assigned: true }),
    ]
    const { api } = fakeApi({ onboarding_checklists: records, employees: [], equipment_issues: [] })
    const view: ListView = { search: 'ann', statusFilter: 'pending', sort: { key: 'name', direction: 'asc' } }
    const data = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', view, onboardingProgress)
    // "ann" matches Ann Lee, Bob Annis, Joanne Kim, Hannah Ng; Pending removes Bob (not started) and Joanne (completed).
    expect(data.records.map((r) => r.employee_name)).toEqual(['Ann Lee', 'Hannah Ng'])
    const expected = sortChecklistRows(records, onboardingProgress, 'progress', 'desc').map((r) => r.id)
    const all = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', { ...VIEW, sort: { key: 'progress', direction: 'desc' } }, onboardingProgress)
    expect(all.records.map((r) => r.id)).toEqual(expected)
    // The summary sheet keeps that order and says which filters applied.
    const { wb } = buildOnboardingWorkbook(XLSX, data, view, new Date())
    expect(sheetRows(wb, 'Onboarding Summary').map((r) => r['Employee Name'])).toEqual(['Ann Lee', 'Hannah Ng'])
    const details = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Export Details'], { header: 1 })
    expect(details).toEqual(expect.arrayContaining([['Search', 'ann'], ['Status filter', 'Pending'], ['Sorted by', 'Employee name (ascending)']]))
  })

  it('records started in the same instant come out in the same order as the list: by name, then id', async () => {
    const same = '2026-10-15T15:20:33.788Z'
    // Fetched in id order (as the export pages), which differs from the name order.
    const records = [
      onboarding(1, { id: 'onb-a', employee_name: 'Test Employee 32', created_at: same }),
      onboarding(2, { id: 'onb-b', employee_name: 'Test Employee 30', created_at: same }),
      onboarding(3, { id: 'onb-c', employee_name: 'Test Employee 31', created_at: same }),
      onboarding(4, { id: 'onb-d', employee_name: 'Later', created_at: '2026-10-16T09:00:00Z' }),
    ]
    const { api } = fakeApi({ onboarding_checklists: records, employees: [], equipment_issues: [] })
    const data = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress)
    const exported = sheetRows(buildOnboardingWorkbook(XLSX, data, VIEW, new Date()).wb, 'Onboarding Summary').map((r) => r['Employee Name'])
    expect(exported).toEqual(['Later', 'Test Employee 30', 'Test Employee 31', 'Test Employee 32'])
    expect(exported).toEqual(sortChecklistRows([...records].reverse(), onboardingProgress, 'started', 'desc').map((r) => r.employee_name))
  })

  it('multiple laptops and accessories: one summary row, one issued-equipment row per item, history kept as history', async () => {
    const emp = 'emp-1'
    const rec = onboarding(1, { employee_id: emp, requested_laptop: '14-inch, 16 GB', charger_required: 'yes', headset_required: 'not_applicable', identity_created: true, equipment_assigned: true })
    const issues = [
      issue(emp, { onboarding_id: rec.id, serial: 'LAP-A', description: 'Dell Latitude 5440' }),
      issue(emp, { onboarding_id: rec.id, serial: 'LAP-B', description: 'Lenovo ThinkPad T14' }),
      issue(emp, { serial: 'LAP-OLD', status: 'returned', closed_at: ts(20) }),
      issue(emp, { item_kind: 'bulk', asset_collection: null, asset_id: null, bulk_item_id: 'b1', description: 'USB-C Charger', serial: null, quantity: 1, onboarding_id: rec.id }),
    ]
    const { api } = fakeApi({ onboarding_checklists: [rec, onboarding(2)], employees: [{ id: emp, full_name: 'Employee One', email: null }], equipment_issues: issues })
    const data = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress)
    const { wb, items } = buildOnboardingWorkbook(XLSX, data, VIEW, new Date())
    const read = roundTrip(wb)
    const summary = sheetRows(read, 'Onboarding Summary').find((r) => r['Employee Name'] === 'Employee 1')!
    expect(summary).toMatchObject({
      'Employee Record': 'Employee One',
      'Onboarding Status': 'Pending',
      'Steps Completed': '2/4',
      'Checklist Completion': 0.5,
      'Identity Created': 'Done',
      'Required Access Provided': 'Not done',
      'Requested Laptop': '14-inch, 16 GB',
      'Charger Required': 'Yes',
      'Headset Required': 'N/A',
      'Laptops Assigned Now': 2,
      'Assigned Laptop Models': 'Dell Latitude 5440; Lenovo ThinkPad T14',
      'Assigned Laptop Serials': 'LAP-A; LAP-B',
      'Equipment With Employee': 'Laptop ×2, USB-C Charger ×1',
      'Equipment Returned / Closed': 1,
    })
    expect(items).toBe(4)
    const issued = sheetRows(read, 'Issued Equipment')
    expect(issued).toHaveLength(4)
    const old = issued.find((r) => r['Serial Number'] === 'LAP-OLD')!
    expect(old).toMatchObject({ Status: 'Returned', 'With Employee Now': 'No', 'Issued In This Onboarding': 'No' })
    expect(issued.filter((r) => r['With Employee Now'] === 'Yes')).toHaveLength(3)
    // A record with no linked employee stays blank, not zero.
    const other = sheetRows(read, 'Onboarding Summary').find((r) => r['Employee Name'] === 'Employee 2')!
    expect(other).toMatchObject({ 'Laptops Assigned Now': '', 'Requested Laptop': '', 'Charger Required': '', 'Equipment With Employee': '' })
  })

  it('an issue is listed once even when the employee has two onboarding records', async () => {
    const emp = 'emp-2'
    const first = onboarding(1, { employee_id: emp, created_at: ts(1) })
    const second = onboarding(2, { employee_id: emp, created_at: ts(10) })
    const issues = [issue(emp, { onboarding_id: first.id }), issue(emp, {})]
    const { api } = fakeApi({ onboarding_checklists: [first, second], employees: [], equipment_issues: issues })
    const data = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress)
    const issued = sheetRows(buildOnboardingWorkbook(XLSX, data, VIEW, new Date()).wb, 'Issued Equipment')
    expect(issued).toHaveLength(2)
    expect(issued.map((r) => r['Issued In This Onboarding']).sort()).toEqual(['No', 'Yes'])
  })
})

describe('Offboarding export', () => {
  it('return outcomes per item, return progress separate from checklist progress, pending count', async () => {
    const emp = 'emp-9'
    const rec = offboarding(1, { employee_id: emp, removed_access: true, laptop_outcome: 'received' })
    const issues = [
      issue(emp, { serial: 'LAP-1', status: 'returned', closed_at: ts(21), offboarding_id: rec.id }),
      issue(emp, { serial: 'LAP-2' }), // still pending
      issue(emp, { item_kind: 'bulk', asset_collection: null, asset_id: null, description: 'USB-C Charger', serial: null, status: 'retained_authorized', close_note: 'Approved by HR', offboarding_id: rec.id }),
      issue(emp, { asset_collection: 'other_equipment', description: 'Jabra Headset', serial: 'HS-1', status: 'returned_damaged', offboarding_id: rec.id }),
      issue(emp, { asset_collection: 'monitors', description: 'Dell 24 Monitor', serial: 'MON-1', status: 'lost', close_note: 'left in taxi', offboarding_id: rec.id }),
      issue(emp, { asset_collection: 'other_equipment', description: 'USB-C Dock', serial: 'DOCK-1', status: 'transferred' }), // not part of this return
    ]
    const { api } = fakeApi({ offboarding_checklists: [rec], employees: [{ id: emp, full_name: 'Nine', email: 'nine@example.invalid' }], equipment_issues: issues })
    const data = await loadExportData<OffboardingRow>(api, 'offboarding_checklists', VIEW, offboardingProgress)
    const { wb } = buildOffboardingWorkbook(XLSX, data, VIEW, new Date())
    const read = roundTrip(wb)
    const s = sheetRows(read, 'Offboarding Summary')[0]
    expect(s).toMatchObject({
      'Employee Email': 'nine@example.invalid',
      'Offboarding Status': 'Completed', // checklist: access removed + laptop outcome
      'Checklist Completion': 1,
      'Removed Access': 'Done',
      'Laptop Outcome (Checklist)': 'Laptop received',
      'Equipment Items': 5,
      'Items Processed': 4,
      'Pending Return': 1, // ...while equipment is still pending
      'Return Progress': 0.8,
      'Retained (Authorized)': 1,
      Lost: 1,
      'Laptop Returns': 'LAP-1: Returned; LAP-2: Pending return',
      'Charger Returns': 'USB-C Charger: Retained — authorized',
      'Headset Returns': 'HS-1: Returned damaged',
      'Monitor Returns': 'MON-1: Lost',
      'Other Equipment Returns': '',
    })
    const returns = sheetRows(read, 'Equipment Returns')
    expect(returns).toHaveLength(5)
    expect(returns.find((r) => r['Serial Number'] === 'LAP-2')).toMatchObject({ 'Return Outcome': 'Pending return', Pending: 'Yes', 'Processed At': '' })
    expect(returns.find((r) => r['Serial Number'] === 'MON-1')).toMatchObject({ 'Return Outcome': 'Lost', 'Reason / Note': 'left in taxi', 'Processed In This Offboarding': 'Yes' })
    expect(returns.find((r) => r['Serial Number'] === 'DOCK-1')).toBeUndefined()
  })

  it('Equipment History: every closed entry incl. transferred/unassigned, labelled historical, never counted as pending', async () => {
    const emp = 'emp-h'
    const rec = offboarding(1, { employee_id: emp, removed_access: true })
    const issues = [
      issue(emp, { serial: 'LAP-NOW' }), // open → Equipment Returns only
      issue(emp, { serial: 'LAP-RET', status: 'returned', closed_at: ts(15), offboarding_id: rec.id }),
      issue(emp, { serial: 'LAP-DMG', status: 'returned_damaged', closed_at: ts(15), offboarding_id: rec.id }),
      issue(emp, { item_kind: 'bulk', asset_collection: null, asset_id: null, description: 'Headset', serial: null, quantity: 2, status: 'retained_authorized', close_note: 'Approved', closed_at: ts(15) }),
      issue(emp, { asset_collection: 'monitors', description: 'Dell 24 Monitor', serial: 'MON-L', status: 'lost', closed_at: ts(16) }),
      issue(emp, { serial: 'LAP-DEC', status: 'decommissioned', closed_at: ts(16) }),
      issue(emp, { serial: 'LAP-TRF', status: 'transferred', closed_at: ts(9) }), // went to someone else
      issue(emp, { asset_collection: 'other_equipment', description: 'USB-C Dock', serial: 'DOCK-U', status: 'unassigned', closed_at: ts(8) }),
    ]
    // Rows the register could not tie to one employee have no employee_id: never attached.
    const ambiguous = { ...issue('x', { serial: 'AMBIG-1', status: 'returned', closed_at: ts(5) }), employee_id: null, employee_ambiguous: true }
    const { api } = fakeApi({ offboarding_checklists: [rec], employees: [], equipment_issues: [...issues, ambiguous] })
    const data = await loadExportData<OffboardingRow>(api, 'offboarding_checklists', VIEW, offboardingProgress)
    const built = buildOffboardingWorkbook(XLSX, data, VIEW, new Date())
    const read = roundTrip(built.wb)
    const history = sheetRows(read, 'Equipment History')
    expect(built.history).toBe(7)
    expect(history.map((r) => r['Serial Number'] || r.Item).sort()).toEqual(['DOCK-U', 'Headset', 'LAP-DEC', 'LAP-DMG', 'LAP-RET', 'LAP-TRF', 'MON-L'])
    expect(history.every((r) => r['Record Type'] === 'Historical record')).toBe(true)
    expect(history.find((r) => r['Serial Number'] === 'LAP-TRF')).toMatchObject({ 'Final Outcome': 'Transferred to someone else', 'Shown On Offboarding Page': 'No — history only', 'Closed In This Offboarding': 'No' })
    expect(history.find((r) => r['Serial Number'] === 'DOCK-U')).toMatchObject({ 'Item Type': 'Other equipment', 'Final Outcome': 'Unassigned (outside a return)' })
    expect(history.find((r) => r.Item === 'Headset')).toMatchObject({ Quantity: 2, 'Final Outcome': 'Retained — authorized', 'Reason / Note': 'Approved' })
    expect(history.find((r) => r['Serial Number'] === 'LAP-RET')).toMatchObject({ 'Closed In This Offboarding': 'Yes', 'Shown On Offboarding Page': 'Yes' })
    const closedAt = history.find((r) => r['Serial Number'] === 'LAP-TRF')!['Closed At']
    expect(closedAt instanceof Date || typeof closedAt === 'number').toBe(true) // a real Excel date, not text
    expect(history.some((r) => r['Serial Number'] === 'AMBIG-1')).toBe(false)
    expect(history.some((r) => r['Serial Number'] === 'LAP-NOW')).toBe(false)

    // Counts and progress are exactly as without the history sheet.
    const s = sheetRows(read, 'Offboarding Summary')[0]
    expect(s).toMatchObject({ 'Equipment Items': 6, 'Items Processed': 5, 'Pending Return': 1, 'Steps Completed': '1/2', 'Checklist Completion': 0.5 })
    expect(sheetRows(read, 'Equipment Returns')).toHaveLength(6)
    expect(sheetRows(read, 'Equipment Returns').some((r) => ['LAP-TRF', 'DOCK-U'].includes(r['Serial Number'] as string))).toBe(false)
  })

  it('an employee with two offboarding records: equipment is counted once, so the total agrees with the dashboard', async () => {
    // The dashboard counts each employee's open items once (open items of every employee that has an offboarding record).
    const dashboardPending = (issues: EquipmentIssue[], records: OffboardingRow[]) => {
      const people = new Set(records.map((r) => r.employee_id).filter(Boolean))
      return issues.filter((i) => i.status === 'open' && i.employee_id && people.has(i.employee_id)).length
    }
    const records = [
      offboarding(1, { employee_name: 'Ann Lee', employee_id: 'emp-ann', created_at: ts(3) }), // older duplicate
      offboarding(2, { employee_name: 'Ann Lee', employee_id: 'emp-ann', created_at: ts(9) }), // newest: owns the equipment
      offboarding(3, { employee_name: 'Bo Chan', employee_id: 'emp-bo', created_at: ts(5) }),
    ]
    const issues = [
      issue('emp-ann', { description: 'Laptop A', serial: 'A-1' }),
      issue('emp-ann', { description: 'Monitor A', serial: 'A-2', asset_collection: 'monitors' }),
      issue('emp-ann', { description: 'Dock A', serial: 'A-3', asset_collection: 'other_equipment' }),
      issue('emp-ann', { description: 'Old laptop', serial: 'A-0', status: 'returned', closed_at: ts(4) }),
      issue('emp-bo', { description: 'Laptop B', serial: 'B-1' }),
    ]
    const { api } = fakeApi({
      offboarding_checklists: records,
      employees: [{ id: 'emp-ann', full_name: 'Ann Lee', email: null }, { id: 'emp-bo', full_name: 'Bo Chan', email: null }],
      equipment_issues: issues,
    })
    const data = await loadExportData<OffboardingRow>(api, 'offboarding_checklists', VIEW, offboardingProgress)
    const { wb } = buildOffboardingWorkbook(XLSX, data, VIEW, new Date())
    const rows = sheetRows(roundTrip(wb), 'Offboarding Summary')
    const num = (v: unknown) => (typeof v === 'number' ? v : 0)
    expect(rows).toHaveLength(3)
    expect(rows.reduce((n, r) => n + num(r['Pending Return']), 0)).toBe(4) // Ann 3 + Bo 1 — not 7
    expect(rows.reduce((n, r) => n + num(r['Pending Return']), 0)).toBe(dashboardPending(issues, records))
    const ann = rows.filter((r) => r['Employee Name'] === 'Ann Lee')
    expect(ann.filter((r) => r['Pending Return'] === 3)).toHaveLength(1)
    expect(ann.filter((r) => r['Equipment Items'] === '')).toHaveLength(1) // the older record is blank, not zero
    expect(XLSX.utils.sheet_to_json<string[]>(roundTrip(wb).Sheets['Export Details'], { header: 1 })).toEqual(
      expect.arrayContaining([[expect.stringMatching(/Equipment counts/), expect.stringMatching(/counted once/)]]),
    )
  })

  it('a database without the employee register: records export, equipment columns stay blank', async () => {
    const { api } = fakeApi({ offboarding_checklists: [offboarding(1)] }, { missing: ['employees', 'equipment_issues'] })
    const data = await loadExportData<OffboardingRow>(api, 'offboarding_checklists', VIEW, offboardingProgress)
    expect(data.registerAvailable).toBe(false)
    const { wb } = buildOffboardingWorkbook(XLSX, data, VIEW, new Date())
    expect(sheetRows(wb, 'Offboarding Summary')[0]).toMatchObject({ 'Equipment Items': '', 'Pending Return': '' })
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Export Details'], { header: 1 })).toEqual(
      expect.arrayContaining([['Equipment', 'Not available: this database has no employee equipment register.']]),
    )
  })
})

describe('workbook format and safety', () => {
  it('structure: sheet names, headers, frozen header rows, filters, column widths, filenames', async () => {
    const { api } = fakeApi({ onboarding_checklists: [onboarding(1)], offboarding_checklists: [offboarding(1)], employees: [], equipment_issues: [] })
    const on = buildOnboardingWorkbook(XLSX, await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress), VIEW, new Date()).wb
    const off = buildOffboardingWorkbook(XLSX, await loadExportData<OffboardingRow>(api, 'offboarding_checklists', VIEW, offboardingProgress), VIEW, new Date()).wb
    expect(on.SheetNames).toEqual(['Onboarding Summary', 'Issued Equipment', 'Export Details'])
    expect(off.SheetNames).toEqual(['Offboarding Summary', 'Equipment Returns', 'Equipment History', 'Export Details'])
    expect(headers(on, 'Onboarding Summary').slice(0, 6)).toEqual(['Employee Name', 'Employee Record', 'Employee Email', 'Onboarding Status', 'Steps Completed', 'Checklist Completion'])
    expect(headers(off, 'Equipment Returns')).toContain('Return Outcome')

    for (const wb of [on, off]) {
      const bytes = workbookBytes(XLSX, wb)
      const zip = XLSX.CFB.read(bytes, { type: 'array' })
      const xml = (n: number) => new TextDecoder().decode(XLSX.CFB.find(zip, `/xl/worksheets/sheet${n}.xml`)!.content as Uint8Array)
      expect(xml(1)).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
      expect(xml(2)).toContain('state="frozen"')
      const detailsSheet = wb.SheetNames.indexOf('Export Details') + 1
      expect(xml(detailsSheet)).not.toContain('state="frozen"')
      if (wb.SheetNames.includes('Equipment History')) expect(xml(3)).toContain('state="frozen"')
      expect(xml(1)).toMatch(/<autoFilter ref="A1:[A-Z]+2"\/>/)
      expect(xml(1)).toMatch(/<col [^>]*width="2[0-9.]+"/)
      // Still a valid workbook after the patch.
      expect(XLSX.read(bytes, { type: 'array' }).SheetNames).toEqual(wb.SheetNames)
    }
    const d = new Date(2026, 9, 16, 9, 30)
    expect(exportFilename('Onboarding', d)).toBe('Onboarding_2026-10-16.xlsx')
    expect(exportFilename('Offboarding', d)).toBe('Offboarding_2026-10-16.xlsx')
  })

  it('employee names that look like formulas are stored as plain text, never formulas', async () => {
    const evil = ['=HYPERLINK("http://x.invalid","click")', '+cmd|" /C calc"!A0', '-2+3', '@SUM(1,1)']
    const { api } = fakeApi({ onboarding_checklists: evil.map((name, i) => onboarding(i, { employee_name: name, requested_laptop: '=1+1' })), employees: [], equipment_issues: [] })
    const data = await loadExportData<OnboardingRow>(api, 'onboarding_checklists', { ...VIEW, sort: { key: 'name', direction: 'asc' } }, onboardingProgress)
    const read = roundTrip(buildOnboardingWorkbook(XLSX, data, VIEW, new Date()).wb)
    const sheet = read.Sheets['Onboarding Summary']
    for (const [ref, cell] of Object.entries(sheet)) {
      if (ref.startsWith('!')) continue
      expect((cell as XLSX.CellObject).f, ref).toBeUndefined()
    }
    expect(sheetRows(read, 'Onboarding Summary').map((r) => r['Employee Name']).sort()).toEqual([...evil].sort())
    expect(sheetRows(read, 'Onboarding Summary')[0]['Requested Laptop']).toBe('=1+1')
  })

  it('dates are real Excel dates; blanks stay blank', async () => {
    const rec = onboarding(1, { created_at: '2026-09-02T12:00:00Z' })
    const { api } = fakeApi({ onboarding_checklists: [rec], employees: [], equipment_issues: [] })
    const read = roundTrip(buildOnboardingWorkbook(XLSX, await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress), VIEW, new Date()).wb)
    const sheet = read.Sheets['Onboarding Summary']
    const col = headers(read, 'Onboarding Summary').indexOf('Onboarding Started')
    const cell = sheet[XLSX.utils.encode_cell({ r: 1, c: col })] as XLSX.CellObject
    expect(cell.t).toBe('n')
    expect(cell.z).toBe('yyyy-mm-dd')
    const d = XLSX.SSF.parse_date_code(cell.v as number)
    const local = new Date('2026-09-02T12:00:00Z')
    expect([d.y, d.m, d.d]).toEqual([local.getFullYear(), local.getMonth() + 1, local.getDate()])
    const blank = headers(read, 'Onboarding Summary').indexOf('Requested Laptop')
    expect(sheet[XLSX.utils.encode_cell({ r: 1, c: blank })]).toBeUndefined()
  })

  it('empty data: a valid workbook with header rows only', async () => {
    const { api } = fakeApi({ onboarding_checklists: [], employees: [], equipment_issues: [] })
    const built = buildOnboardingWorkbook(XLSX, await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress), VIEW, new Date())
    expect(built.records).toBe(0)
    const read = roundTrip(built.wb)
    expect(sheetRows(read, 'Onboarding Summary')).toEqual([])
    expect(headers(read, 'Issued Equipment')).toContain('Serial Number')
  })

  it('read-only: the export uses only select queries', async () => {
    const { api, calls } = fakeApi({ onboarding_checklists: [onboarding(1)], employees: [], equipment_issues: [] })
    await loadExportData<OnboardingRow>(api, 'onboarding_checklists', VIEW, onboardingProgress)
    // The fake has no insert/update/delete/rpc at all — any write would throw.
    expect(calls.map((c) => c.replace(/\[\d+\]/, ''))).toEqual(['onboarding_checklists', 'employees', 'equipment_issues'])
  })
})
