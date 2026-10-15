import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { OnboardingListPage } from './OnboardingListPage'
import { useOnboardingList, type OnboardingRow } from './api'
import { useAuth } from '../auth/useAuth'

// The real hooks talk to Supabase; this is a rendering/interaction test of
// the table only, so the data hooks are mocked.
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useOnboardingList: vi.fn(),
  useCreateOnboarding: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))

function rec(id: string, name: string, created: string, steps: [boolean, boolean, boolean, boolean]): OnboardingRow {
  return {
    id,
    employee_name: name,
    identity_created: steps[0],
    equipment_assigned: steps[1],
    required_access_provided: steps[2],
    onboarding_successful: steps[3],
    assigned_asset_id: null,
    created_at: created,
    updated_at: created,
  }
}

// The four records from the staging screenshot.
const RECORDS = [
  rec('a', 'Test Employee 30', '2026-10-14T09:00:00Z', [false, false, false, false]),
  rec('b', 'Test Employee 31', '2026-10-14T10:00:00Z', [true, false, false, false]),
  rec('c', 'Test Employee 32', '2026-10-14T11:00:00Z', [true, false, false, false]),
  rec('d', 'Test Employee 93', '2026-10-15T09:00:00Z', [true, true, true, true]),
]

function mockList(records: OnboardingRow[] | undefined, extra: Partial<ReturnType<typeof useOnboardingList>> = {}) {
  vi.mocked(useOnboardingList).mockReturnValue({ data: records, isLoading: false, error: null, ...extra } as ReturnType<
    typeof useOnboardingList
  >)
}

function DetailStub() {
  const { id } = useParams()
  return <p>Checklist {id}</p>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingListPage />} />
        <Route path="/onboarding/:id" element={<DetailStub />} />
      </Routes>
    </MemoryRouter>,
  )
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]).getAllByRole('row')
const rowFor = (name: string) => screen.getByText(name).closest('tr')!
const namesInOrder = () => bodyRows().map((r) => within(r).getAllByRole('cell')[0].textContent?.replace(/Started.*/, ''))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({ role: 'admin', user: { id: 'u1' } } as ReturnType<typeof useAuth>)
  mockList(RECORDS)
})

describe('OnboardingListPage table', () => {
  it('shows each employee with steps and a derived status', () => {
    renderPage()
    const expected: Record<string, [string, string]> = {
      'Test Employee 30': ['0/4', 'Not Started'],
      'Test Employee 31': ['1/4', 'Pending'],
      'Test Employee 32': ['1/4', 'Pending'],
      'Test Employee 93': ['4/4', 'Completed'],
    }
    for (const [name, [steps, status]] of Object.entries(expected)) {
      const row = within(rowFor(name))
      expect(row.getByText(steps)).toBeInTheDocument()
      expect(row.getByText(status)).toBeInTheDocument()
      expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', steps[0])
      expect(row.getByRole('link', { name: 'View details' })).toHaveAttribute(
        'href',
        `/onboarding/${RECORDS.find((r) => r.employee_name === name)!.id}`,
      )
    }
  })

  it('lists the most recently started first by default', () => {
    renderPage()
    expect(namesInOrder()).toEqual(['Test Employee 93', 'Test Employee 32', 'Test Employee 31', 'Test Employee 30'])
  })

  it('sorts by each column, toggling direction', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: /Employee name/ }))
    expect(namesInOrder()).toEqual(['Test Employee 30', 'Test Employee 31', 'Test Employee 32', 'Test Employee 93'])
    expect(screen.getByRole('columnheader', { name: /Employee name/ })).toHaveAttribute('aria-sort', 'ascending')
    await user.click(screen.getByRole('button', { name: /Employee name/ }))
    expect(namesInOrder()[0]).toBe('Test Employee 93')

    await user.click(screen.getByRole('button', { name: /Steps completed/ }))
    expect(namesInOrder()[0]).toBe('Test Employee 30')
    await user.click(screen.getByRole('button', { name: /Status/ }))
    expect(namesInOrder()).toEqual(['Test Employee 30', 'Test Employee 32', 'Test Employee 31', 'Test Employee 93'])

    await user.click(screen.getByRole('button', { name: /Start date/ }))
    expect(namesInOrder()[0]).toBe('Test Employee 93')
  })

  it('filters by status, with counts', async () => {
    const user = userEvent.setup()
    renderPage()
    const filter = screen.getByRole('combobox', { name: 'Filter by status' })
    expect(within(filter).getByRole('option', { name: 'Pending (2)' })).toBeInTheDocument()

    await user.selectOptions(filter, 'pending')
    expect(namesInOrder()).toEqual(['Test Employee 32', 'Test Employee 31'])
    await user.selectOptions(filter, 'completed')
    expect(namesInOrder()).toEqual(['Test Employee 93'])
    await user.selectOptions(filter, 'not_started')
    expect(namesInOrder()).toEqual(['Test Employee 30'])
    await user.selectOptions(filter, 'all')
    expect(bodyRows()).toHaveLength(4)
  })

  it('shows an empty-filter message when no row matches', async () => {
    mockList([RECORDS[0]])
    const user = userEvent.setup()
    renderPage()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'completed')
    expect(screen.getByText(/No employees with status “Completed”/)).toBeInTheDocument()
  })

  it('passes the search text to the existing list query', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByRole('textbox', { name: 'Search employee' }), '93')
    expect(useOnboardingList).toHaveBeenLastCalledWith('93')
  })

  it('opens the checklist when a row is clicked or activated with the keyboard', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByText('Test Employee 31'))
    expect(screen.getByText('Checklist b')).toBeInTheDocument()
  })

  it('opens the checklist from the keyboard', async () => {
    const user = userEvent.setup()
    renderPage()
    rowFor('Test Employee 30').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Checklist a')).toBeInTheDocument()
  })

  it('reflects a checklist change on the next data refresh', () => {
    const { rerender } = renderPage()
    expect(within(rowFor('Test Employee 30')).getByText('Not Started')).toBeInTheDocument()
    mockList(RECORDS.map((r) => (r.id === 'a' ? { ...r, identity_created: true } : r)))
    rerender(
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingListPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(within(rowFor('Test Employee 30')).getByText('1/4')).toBeInTheDocument()
    expect(within(rowFor('Test Employee 30')).getByText('Pending')).toBeInTheDocument()
  })

  it('hides Start onboarding for viewers', () => {
    vi.mocked(useAuth).mockReturnValue({ role: 'viewer', user: { id: 'u1' } } as ReturnType<typeof useAuth>)
    renderPage()
    expect(screen.queryByRole('button', { name: 'Start onboarding' })).not.toBeInTheDocument()
  })

  it('shows a load error instead of an empty table', () => {
    mockList(undefined, { error: new Error('network down') } as never)
    renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent('network down')
  })
})
