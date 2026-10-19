import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { OnboardingListPage } from '../onboarding/OnboardingListPage'
import { OffboardingListPage } from '../offboarding/OffboardingListPage'
import { useOnboardingList, type OnboardingRow } from '../onboarding/api'
import { useOffboardingList } from '../offboarding/api'
import { useAuth } from '../auth/useAuth'
import * as exporter from './checklistExport'
import * as xlsxWorkbook from '../../lib/xlsxWorkbook'

vi.mock('../onboarding/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/api')>()),
  useOnboardingList: vi.fn(),
  useCreateOnboarding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))
vi.mock('../offboarding/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offboarding/api')>()),
  useOffboardingList: vi.fn(),
  useCreateOffboarding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('../register/api', () => ({ useRegisterAvailable: () => ({ data: false }), useEmployeesNamed: () => ({ data: [] }), useCreateEmployee: () => ({ mutateAsync: vi.fn(), isPending: false }) }))
vi.mock('./checklistExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./checklistExport')>()),
  loadExportData: vi.fn(),
}))
vi.mock('../../lib/xlsxWorkbook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/xlsxWorkbook')>()),
  saveFile: vi.fn(),
}))

const rec = (id: string, name: string, done: number): OnboardingRow => ({
  id,
  employee_name: name,
  identity_created: done > 0,
  equipment_assigned: done > 1,
  required_access_provided: done > 2,
  onboarding_successful: done > 3,
  assigned_asset_id: null,
  created_at: '2026-10-14T09:00:00Z',
  updated_at: '2026-10-14T09:00:00Z',
})

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ role: 'viewer', user: { id: 'u' } } as never)
  vi.mocked(useOnboardingList).mockReturnValue({ data: [rec('a', 'Ann', 1), rec('b', 'Bob', 4)], isLoading: false, error: null } as never)
  vi.mocked(useOffboardingList).mockReturnValue({ data: [], isLoading: false, error: null } as never)
  vi.mocked(exporter.loadExportData).mockReset()
  vi.mocked(xlsxWorkbook.saveFile).mockReset()
})

describe('Download Excel on the checklist lists', () => {
  it('is on both lists, visible to every role (read-only)', () => {
    render(<MemoryRouter><OnboardingListPage /></MemoryRouter>)
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled()
    render(<MemoryRouter><OffboardingListPage /></MemoryRouter>)
    expect(screen.getAllByRole('button', { name: 'Download Excel' })).toHaveLength(2)
  })

  it('exports with the current search, status filter and sort, then saves Onboarding_<date>.xlsx', async () => {
    const user = userEvent.setup()
    let resolve!: (v: unknown) => void
    vi.mocked(exporter.loadExportData).mockReturnValue(new Promise((r) => (resolve = r)) as never)
    render(<MemoryRouter><OnboardingListPage /></MemoryRouter>)
    await user.type(screen.getByRole('textbox', { name: 'Search employee' }), 'an')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'pending')
    await user.click(screen.getByRole('button', { name: /Employee name/ }))
    await user.click(screen.getByRole('button', { name: 'Download Excel' }))

    expect(await screen.findByRole('button', { name: 'Preparing…' })).toBeDisabled()
    expect(exporter.loadExportData).toHaveBeenCalledWith(expect.anything(), 'onboarding_checklists', {
      search: 'an',
      statusFilter: 'pending',
      sort: { key: 'name', direction: 'asc' },
    }, expect.any(Function))

    resolve({ records: [rec('a', 'Ann', 1)], employees: new Map(), issuesByEmployee: new Map(), registerAvailable: true })
    await waitFor(() => expect(xlsxWorkbook.saveFile).toHaveBeenCalled())
    const [filename, bytes] = vi.mocked(xlsxWorkbook.saveFile).mock.calls[0]
    expect(filename).toMatch(/^Onboarding_\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)
    expect(await screen.findByRole('status')).toHaveTextContent('Downloaded 1 record, 0 equipment rows.')
  })

  it('shows an error and saves nothing when loading fails part-way', async () => {
    const user = userEvent.setup()
    vi.mocked(exporter.loadExportData).mockRejectedValue(new Error('Could not read all of equipment_issues: network error'))
    render(<MemoryRouter><OffboardingListPage /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Download Excel' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read all of equipment_issues: network error')
    expect(xlsxWorkbook.saveFile).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled()
  })
})
