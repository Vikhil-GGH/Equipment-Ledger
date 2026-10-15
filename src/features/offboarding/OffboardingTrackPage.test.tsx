import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { OffboardingTrackPage } from './OffboardingTrackPage'
import { useEmployeeAssets, useOffboarding, useSetLaptopOutcome, useUpdateOffboardingStep, type OffboardingRow } from './api'
import { usePerformLifecycleAction } from '../assets/api'
import { useAuth } from '../auth/useAuth'

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useOffboarding: vi.fn(),
  useEmployeeAssets: vi.fn(),
  useUpdateOffboardingStep: vi.fn(),
  useSetLaptopOutcome: vi.fn(),
}))
vi.mock('../assets/api', () => ({
  useAssetHistory: vi.fn(() => ({ data: [] })),
  usePerformLifecycleAction: vi.fn(),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))
// Register not present (pre-026 database): the checklist must behave exactly as before.
vi.mock('../register/api', () => ({ useRegisterAvailable: vi.fn(() => ({ data: false })) }))

const setOutcome = vi.fn()
const updateStep = vi.fn()

function record(extra: Partial<OffboardingRow> = {}): OffboardingRow {
  return {
    id: 'o1',
    employee_name: 'Test Employee 01',
    removed_access: false,
    laptop_received: false,
    laptop_retained: false,
    laptop_decommissioned: false,
    laptop_outcome: null,
    outcome_needs_review: false,
    created_at: '2026-10-14T00:00:00Z',
    updated_at: '2026-10-14T00:00:00Z',
    ...extra,
  }
}

function setup(rec: OffboardingRow, assets: unknown[] = []) {
  vi.mocked(useOffboarding).mockReturnValue({ data: rec, isLoading: false, error: null } as ReturnType<typeof useOffboarding>)
  vi.mocked(useEmployeeAssets).mockReturnValue({ data: assets } as ReturnType<typeof useEmployeeAssets>)
  render(
    <MemoryRouter initialEntries={['/offboarding/o1']}>
      <Routes>
        <Route path="/offboarding/:id" element={<OffboardingTrackPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({ role: 'admin' } as ReturnType<typeof useAuth>)
  vi.mocked(useSetLaptopOutcome).mockReturnValue({ mutate: setOutcome, isPending: false, error: null } as never)
  vi.mocked(useUpdateOffboardingStep).mockReturnValue({ mutate: updateStep, isPending: false, error: null } as never)
})

describe('OffboardingTrackPage checklist', () => {
  it('shows Removed access plus ONE laptop outcome (radio buttons), and 0/2 progress', () => {
    setup(record())
    expect(screen.getByRole('checkbox', { name: 'Removed access' })).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual([
      expect.stringContaining('Laptop received'),
      expect.stringContaining('Laptop retained'),
      expect.stringContaining('Laptop decommissioned'),
      expect.stringContaining('Not applicable'),
      expect.stringContaining('Not decided yet'),
    ])
    expect(screen.getByRole('radio', { name: /Not decided yet/ })).toBeChecked()
    expect(screen.getByText('0/2 required steps done')).toBeInTheDocument()
  })

  it('only one outcome can be selected at a time', () => {
    setup(record({ laptop_outcome: 'retained', laptop_retained: true, removed_access: true }))
    expect(screen.getByRole('radio', { name: /Laptop retained/ })).toBeChecked()
    expect(screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1)
    expect(screen.getByText('2/2 required steps done')).toBeInTheDocument()
  })

  it('choosing an outcome saves just that outcome — and never touches equipment', async () => {
    const user = userEvent.setup()
    setup(record(), [{ id: 'a1', collection: 'active_laptops_np', name: 'Dell', serial: 'SYN-INV-001', status: 'provided' }])
    await user.click(screen.getByRole('radio', { name: /Laptop received/ }))
    expect(setOutcome).toHaveBeenCalledWith('received')
    expect(setOutcome).toHaveBeenCalledTimes(1)
    expect(usePerformLifecycleAction).not.toHaveBeenCalled()
  })

  it('an outcome can be cleared back to Not decided yet', async () => {
    const user = userEvent.setup()
    setup(record({ laptop_outcome: 'decommissioned', laptop_decommissioned: true }))
    await user.click(screen.getByRole('radio', { name: /Not decided yet/ }))
    expect(setOutcome).toHaveBeenCalledWith(null)
  })

  it('offers Not applicable, and suggests it when no laptop is assigned', async () => {
    const user = userEvent.setup()
    setup(record(), [])
    expect(screen.getByText(/No laptop is currently assigned to Test Employee 01/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /Not applicable/ }))
    expect(setOutcome).toHaveBeenCalledWith('not_applicable')
  })

  it('a conflicting legacy record is flagged, with nothing pre-selected', () => {
    setup(record({ removed_access: true, laptop_received: true, laptop_retained: true, outcome_needs_review: true }))
    expect(screen.getByRole('status')).toHaveTextContent('Needs review: this record had Laptop received, Laptop retained all ticked')
    expect(screen.getByRole('radio', { name: /Not decided yet/ })).toBeChecked()
    expect(screen.getByText('1/2 required steps done')).toBeInTheDocument()
  })

  it('Removed access is still its own tick box', async () => {
    const user = userEvent.setup()
    setup(record())
    await user.click(screen.getByRole('checkbox', { name: 'Removed access' }))
    expect(updateStep).toHaveBeenCalledWith({ step: 'removed_access', value: true })
  })

  it('viewers see the checklist but cannot change it', () => {
    vi.mocked(useAuth).mockReturnValue({ role: 'viewer' } as ReturnType<typeof useAuth>)
    setup(record())
    expect(screen.getByRole('checkbox', { name: 'Removed access' })).toBeDisabled()
    for (const r of screen.getAllByRole('radio')) expect(r).toBeDisabled()
  })
})
