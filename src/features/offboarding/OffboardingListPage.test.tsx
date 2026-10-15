import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { OffboardingListPage } from './OffboardingListPage'
import { useOffboardingList, type OffboardingRow } from './api'
import { OFFBOARDING_REQUIRED_STEPS } from './offboardingProgress'
import { useAuth } from '../auth/useAuth'

// Rendering/interaction test only — the data hooks are mocked, nothing
// reaches Supabase.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useOffboardingList: vi.fn(),
  useCreateOffboarding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))

function rec(id: string, name: string, created: string, extra: Partial<OffboardingRow> = {}): OffboardingRow {
  return {
    id,
    employee_name: name,
    removed_access: false,
    laptop_received: false,
    laptop_retained: false,
    laptop_decommissioned: false,
    laptop_outcome: null,
    outcome_needs_review: false,
    created_at: created,
    updated_at: created,
    ...extra,
  }
}

const RECORDS = [
  rec('a', 'Test Employee 42', '2026-10-13T09:00:00Z', { removed_access: true, laptop_outcome: 'received', laptop_received: true }),
  rec('b', 'Test Employee 41', '2026-10-14T09:00:00Z', { removed_access: true }),
  rec('c', 'Test Employee 40', '2026-10-15T09:00:00Z'),
  rec('d', 'Test Employee 43', '2026-10-12T09:00:00Z', { removed_access: true, laptop_outcome: 'not_applicable' }),
  rec('e', 'Test Employee 44', '2026-10-11T09:00:00Z', { laptop_outcome: 'retained', laptop_retained: true }),
  rec('f', 'Test Employee 45', '2026-10-10T09:00:00Z', {
    removed_access: true,
    laptop_received: true,
    laptop_retained: true,
    outcome_needs_review: true,
  }),
]

function mockList(records: OffboardingRow[]) {
  vi.mocked(useOffboardingList).mockReturnValue({ data: records, isLoading: false, error: null } as ReturnType<
    typeof useOffboardingList
  >)
}

function DetailStub() {
  const { id } = useParams()
  return <p>Offboarding checklist {id}</p>
}

// A fresh element each time, so rerender() really re-renders with new data.
const tree = () => (
  <MemoryRouter initialEntries={['/offboarding']}>
    <Routes>
      <Route path="/offboarding" element={<OffboardingListPage />} />
      <Route path="/offboarding/:id" element={<DetailStub />} />
    </Routes>
  </MemoryRouter>
)

const rowFor = (name: string) => screen.getByText(name).closest('tr')!
const namesInOrder = () =>
  within(screen.getAllByRole('rowgroup')[1])
    .getAllByRole('row')
    .map((r) => within(r).getAllByRole('cell')[0].textContent?.replace(/Started.*/, ''))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({ role: 'admin', user: { id: 'u1' } } as ReturnType<typeof useAuth>)
  mockList(RECORDS)
})

describe('OffboardingListPage table', () => {
  it('counts the new required steps: access removed + one laptop outcome', () => {
    expect(OFFBOARDING_REQUIRED_STEPS).toBe(2)
    render(tree())
    expect(within(rowFor('Test Employee 41')).getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2')
  })

  it.each([
    ['Test Employee 40', '0/2', 'Not Started'],
    ['Test Employee 41', '1/2', 'Pending'],
    ['Test Employee 42', '2/2', 'Completed'],
    ['Test Employee 43', '2/2', 'Completed'], // Not applicable counts as an outcome
    ['Test Employee 44', '1/2', 'Pending'], // outcome chosen, access not yet removed
    ['Test Employee 45', '1/2', 'Pending'], // conflicting legacy outcomes: not resolved
  ])('%s → %s %s', (name, steps, status) => {
    render(tree())
    const row = within(rowFor(name))
    expect(row.getByText(steps)).toBeInTheDocument()
    expect(row.getByText(status)).toBeInTheDocument()
  })

  it('flags legacy records with conflicting outcomes for review', () => {
    render(tree())
    expect(within(rowFor('Test Employee 45')).getByText(/Laptop outcome needs review/)).toBeInTheDocument()
    expect(within(rowFor('Test Employee 42')).queryByText(/needs review/)).not.toBeInTheDocument()
  })

  it('newest first by default; sorting and filtering by status', async () => {
    const user = userEvent.setup()
    render(tree())
    expect(namesInOrder()[0]).toBe('Test Employee 40')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'completed')
    expect(namesInOrder()).toEqual(['Test Employee 42', 'Test Employee 43'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'all')
    await user.click(screen.getByRole('button', { name: /Steps completed/ }))
    expect(namesInOrder()[0]).toBe('Test Employee 40')
  })

  it('a reopened step moves Completed back to Pending', () => {
    const { rerender } = render(tree())
    expect(within(rowFor('Test Employee 42')).getByText('Completed')).toBeInTheDocument()
    mockList(RECORDS.map((r) => (r.id === 'a' ? { ...r, laptop_outcome: null, laptop_received: false } : r)))
    rerender(tree())
    expect(within(rowFor('Test Employee 42')).getByText('1/2')).toBeInTheDocument()
    expect(within(rowFor('Test Employee 42')).getByText('Pending')).toBeInTheDocument()
  })

  it('opens the checklist from a row; keeps search and Start offboarding', async () => {
    const user = userEvent.setup()
    render(tree())
    expect(screen.getByRole('button', { name: 'Start offboarding' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Search employee' }), '41')
    expect(useOffboardingList).toHaveBeenLastCalledWith('41')
    await user.click(screen.getByText('Test Employee 41'))
    expect(screen.getByText('Offboarding checklist b')).toBeInTheDocument()
  })
})
