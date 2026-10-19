import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as XLSX from 'xlsx'
import { ActiveEmployeesPage } from './ActiveEmployeesPage'
import * as api from './api'
import { useAuth } from '../auth/useAuth'
import * as xlsxWorkbook from '../../lib/xlsxWorkbook'
import type { DirectoryEmployee } from './directoryModel'
import { EMPLOYEE_COLUMNS } from './employeeImport'

vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('./api', () => ({
  useDirectoryAvailable: vi.fn(),
  useEmployeeDirectory: vi.fn(),
  useSetEmploymentStatus: vi.fn(),
  useSaveEmployee: vi.fn(),
  useCommitEmployeeImport: vi.fn(),
  useEmployeeHistory: vi.fn(() => ({ data: [] })),
  useOpenEquipmentCount: vi.fn(() => ({ data: 1 })),
}))
vi.mock('../../lib/xlsxWorkbook', async (orig) => ({ ...(await orig<typeof import('../../lib/xlsxWorkbook')>()), saveFile: vi.fn() }))

let seq = 0
const emp = (over: Partial<DirectoryEmployee>): DirectoryEmployee => {
  seq++
  return {
    id: `e${String(seq).padStart(4, '0')}`, full_name: `${over.first_name} ${over.last_name}`, name_key: null, email: null, email_key: null,
    first_name: null, last_name: null, department: null, job_title: null, hr_status: 'Active', manager: null, start_date: null,
    employment_status: 'active', reactivation_pending: false, status_changed_at: null, updated_at: null, created_at: '', ...over,
  }
}
const mutation = () => ({ mutateAsync: vi.fn().mockResolvedValue(true), isPending: false })
let directory: DirectoryEmployee[]
let setStatus: ReturnType<typeof mutation>
let commit: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }

beforeEach(() => {
  seq = 0
  directory = [
    ...Array.from({ length: 30 }, (_, i) => emp({ first_name: `Person${String(i).padStart(2, '0')}`, last_name: 'Ops', department: 'Ops', email: `p${i}@x.invalid`, email_key: `p${i}@x.invalid` })),
    emp({ first_name: 'Ana', last_name: 'Ruiz', department: 'Finance', job_title: 'Analyst', manager: 'Kim', start_date: '2024-03-01', email: 'ana@x.invalid', email_key: 'ana@x.invalid' }),
    emp({ first_name: 'Dee', last_name: 'Old', employment_status: 'inactive', hr_status: 'Terminated', reactivation_pending: true }),
  ]
  setStatus = mutation()
  commit = { mutateAsync: vi.fn().mockResolvedValue({ created: 1, updated: 0, unchanged: 1, status_changes: 0, conflicts: [] }), isPending: false }
  vi.mocked(useAuth).mockReturnValue({ role: 'editor' } as never)
  vi.mocked(api.useDirectoryAvailable).mockReturnValue({ data: true, isLoading: false, error: null } as never)
  vi.mocked(api.useEmployeeDirectory).mockImplementation(() => ({ data: directory, isLoading: false, error: null }) as never)
  vi.mocked(api.useSetEmploymentStatus).mockReturnValue(setStatus as never)
  vi.mocked(api.useSaveEmployee).mockReturnValue(mutation() as never)
  vi.mocked(api.useCommitEmployeeImport).mockReturnValue(commit as never)
  vi.mocked(xlsxWorkbook.saveFile).mockReset()
})

const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1)

describe('Active Employees page', () => {
  it('shows the active count, the eight columns, only active employees, 25 per page', async () => {
    const user = userEvent.setup()
    render(<ActiveEmployeesPage />)
    expect(screen.getByTestId('active-count')).toHaveTextContent('31')
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent?.replace(/[▲▼↕]/g, '').trim())
    expect(headers.slice(0, 8)).toEqual(EMPLOYEE_COLUMNS.map((c) => c.header))
    expect(bodyRows()).toHaveLength(25)
    expect(screen.queryByText('Old')).not.toBeInTheDocument()
    expect(screen.getByText('Showing 1–25 of 31')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(bodyRows()).toHaveLength(6)
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
  })

  it('search, department filter, Show filter and sort work together', async () => {
    const user = userEvent.setup()
    render(<ActiveEmployeesPage />)
    await user.type(screen.getByRole('textbox', { name: 'Search employees' }), 'analyst')
    expect(bodyRows()).toHaveLength(1)
    expect(bodyRows()[0]).toHaveTextContent('Ana')
    await user.clear(screen.getByRole('textbox', { name: 'Search employees' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by department' }), 'Ops')
    expect(screen.getByText('Showing 1–25 of 30')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /First name/ })) // name ▼
    expect(bodyRows()[0]).toHaveTextContent('Person29')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by department' }), '')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'inactive')
    expect(bodyRows()).toHaveLength(1)
    expect(bodyRows()[0]).toHaveTextContent('Inactive / Offboarded')
  })

  it('Download Excel exports every matching row (not just the page) as Active_Employees_<date>.xlsx', async () => {
    const user = userEvent.setup()
    render(<ActiveEmployeesPage />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by department' }), 'Ops')
    await user.click(screen.getByRole('button', { name: /Download Excel/ }))
    await waitFor(() => expect(xlsxWorkbook.saveFile).toHaveBeenCalled())
    const [filename, bytes] = vi.mocked(xlsxWorkbook.saveFile).mock.calls[0]
    expect(filename).toMatch(/^Active_Employees_\d{4}-\d{2}-\d{2}\.xlsx$/)
    const rows = XLSX.utils.sheet_to_json(XLSX.read(bytes, { type: 'array' }).Sheets.Employees)
    expect(rows).toHaveLength(30)
    expect(screen.getByRole('status')).toHaveTextContent('Downloaded 30 employees.')
  })

  it('rehires are listed and reactivated only by an explicit click', async () => {
    const user = userEvent.setup()
    render(<ActiveEmployeesPage />)
    expect(screen.getByText('Rehires awaiting reactivation')).toBeInTheDocument()
    expect(setStatus.mutateAsync).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reactivate' }))
    expect(setStatus.mutateAsync).toHaveBeenCalledWith({ id: directory[31].id, status: 'active', note: 'Rehire reactivated' })
  })

  it('employment decisions: listed, and resolved only through an explicit, confirmed choice', async () => {
    const user = userEvent.setup()
    directory.push(emp({ first_name: 'Lia', last_name: 'Leave', employment_status: null, hr_status: 'Leave of Absence', status_decision_required: true }))
    render(<ActiveEmployeesPage />)
    const box = screen.getByRole('region', { name: 'Employment status decisions' })
    expect(box).toHaveTextContent('Lia Leave — Employee Status “Leave of Absence”')
    await user.click(within(box).getByRole('button', { name: 'Make Active' }))
    expect(setStatus.mutateAsync).not.toHaveBeenCalled() // a second, deliberate step is required
    expect(box).toHaveTextContent('Make Lia Leave Active?')
    await user.click(within(box).getByRole('button', { name: 'Confirm' }))
    expect(setStatus.mutateAsync).toHaveBeenCalledWith({ id: directory.at(-1)!.id, status: 'active', note: 'Decision: Employee Status "Leave of Absence" reviewed' })
  })

  it('viewers can browse and download, but not upload, add, edit or reactivate', () => {
    vi.mocked(useAuth).mockReturnValue({ role: 'viewer' } as never)
    render(<ActiveEmployeesPage />)
    expect(screen.getByRole('button', { name: /Download Excel/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Upload Excel/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add employee' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^View/ }).length).toBeGreaterThan(0)
  })

  it('upload: preview, review, and nothing is sent until Confirm', async () => {
    const user = userEvent.setup()
    render(<ActiveEmployeesPage />)
    await user.click(screen.getByRole('button', { name: /Upload Excel/ }))
    const sheet = XLSX.utils.aoa_to_sheet([
      EMPLOYEE_COLUMNS.map((c) => c.header),
      ['Ana', 'Ruiz', 'Finance', 'Analyst', 'Active', 'Kim', '2024-03-01', 'ANA@x.invalid'], // unchanged
      ['New', 'Person', 'IT', 'Engineer', 'Active', '', '', 'new@x.invalid'], // new
      ['Dee', 'Old', '', '', 'Active', '', '', ''], // same name, no email → possible duplicate
      ['Bad', 'Row', '', '', '', '', '', 'nope'], // invalid
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheet, 'Employees')
    const file = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'staff.xlsx')
    await user.upload(screen.getByLabelText('Employee Excel file'), file)
    const summary = await screen.findByLabelText('Preview summary')
    expect(summary).toHaveTextContent('4 rows')
    expect(summary).toHaveTextContent('1 new')
    expect(summary).toHaveTextContent('1 unchanged')
    expect(summary).toHaveTextContent('1 possible duplicates')
    expect(summary).toHaveTextContent('1 invalid')
    await user.click(screen.getByRole('button', { name: /^All rows/ }))
    expect(screen.getByText('Added as Active (Employee Status “Active”)')).toBeInTheDocument()
    expect(commit.mutateAsync).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm import (1 row)' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Confirm import (1 row)' }))
    expect(commit.mutateAsync).toHaveBeenCalledWith({ filename: 'staff.xlsx', rows: [expect.objectContaining({ row: 3, action: 'create' })] })
    expect(await screen.findByLabelText('Import summary')).toHaveTextContent('1 added')
  })
})
