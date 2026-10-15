import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { OffboardingListPage } from './OffboardingListPage'
import { OFFBOARDING_STEPS, useOffboardingList, type OffboardingRow } from './api'
import { useAuth } from '../auth/useAuth'

// Rendering/interaction test only — the data hooks are mocked, nothing
// reaches Supabase.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useOffboardingList: vi.fn(),
  useCreateOffboarding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))

function rec(id: string, name: string, created: string, done: number): OffboardingRow {
  const steps = Object.fromEntries(OFFBOARDING_STEPS.map((s, i) => [s, i < done])) as Record<
    (typeof OFFBOARDING_STEPS)[number],
    boolean
  >
  return { id, employee_name: name, created_at: created, updated_at: created, ...steps }
}

// The examples from the request.
const RECORDS = [
  rec('a', 'Test Employee 42', '2026-10-13T09:00:00Z', 4),
  rec('b', 'Test Employee 41', '2026-10-14T09:00:00Z', 2),
  rec('c', 'Test Employee 40', '2026-10-15T09:00:00Z', 0),
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/offboarding']}>
      <Routes>
        <Route path="/offboarding" element={<OffboardingListPage />} />
        <Route path="/offboarding/:id" element={<DetailStub />} />
      </Routes>
    </MemoryRouter>,
  )
}

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
  it('uses the offboarding workflow’s real step count', () => {
    expect(OFFBOARDING_STEPS).toHaveLength(4)
    renderPage()
    expect(within(rowFor('Test Employee 41')).getByRole('progressbar')).toHaveAttribute(
      'aria-valuemax',
      String(OFFBOARDING_STEPS.length),
    )
  })

  it('shows steps and derived status for each employee', () => {
    renderPage()
    for (const [name, steps, status] of [
      ['Test Employee 40', '0/4', 'Not Started'],
      ['Test Employee 41', '2/4', 'Pending'],
      ['Test Employee 42', '4/4', 'Completed'],
    ]) {
      const row = within(rowFor(name))
      expect(row.getByText(steps)).toBeInTheDocument()
      expect(row.getByText(status)).toBeInTheDocument()
    }
  })

  it('lists the most recently started first, and sorts by name', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(namesInOrder()).toEqual(['Test Employee 40', 'Test Employee 41', 'Test Employee 42'])
    await user.click(screen.getByRole('button', { name: /Steps completed/ }))
    expect(namesInOrder()).toEqual(['Test Employee 40', 'Test Employee 41', 'Test Employee 42'])
    await user.click(screen.getByRole('button', { name: /Steps completed/ }))
    expect(namesInOrder()).toEqual(['Test Employee 42', 'Test Employee 41', 'Test Employee 40'])
  })

  it('filters by status', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'pending')
    expect(namesInOrder()).toEqual(['Test Employee 41'])
  })

  it('reopening a step turns Completed back into Pending', () => {
    const { rerender } = renderPage()
    expect(within(rowFor('Test Employee 42')).getByText('Completed')).toBeInTheDocument()
    mockList(RECORDS.map((r) => (r.id === 'a' ? { ...r, laptop_decommissioned: false } : r)))
    rerender(
      <MemoryRouter initialEntries={['/offboarding']}>
        <Routes>
          <Route path="/offboarding" element={<OffboardingListPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(within(rowFor('Test Employee 42')).getByText('3/4')).toBeInTheDocument()
    expect(within(rowFor('Test Employee 42')).getByText('Pending')).toBeInTheDocument()
  })

  it('opens the checklist from a row and from View details', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(within(rowFor('Test Employee 41')).getByRole('link', { name: 'View details' })).toHaveAttribute(
      'href',
      '/offboarding/b',
    )
    await user.click(screen.getByText('Test Employee 41'))
    expect(screen.getByText('Offboarding checklist b')).toBeInTheDocument()
  })

  it('keeps search and Start offboarding', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(screen.getByRole('button', { name: 'Start offboarding' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Search employee' }), '41')
    expect(useOffboardingList).toHaveBeenLastCalledWith('41')
  })
})
