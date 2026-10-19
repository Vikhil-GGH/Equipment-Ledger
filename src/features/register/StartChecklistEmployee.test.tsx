import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { OnboardingListPage } from '../onboarding/OnboardingListPage'
import { useCreateOnboarding, useOnboardingList } from '../onboarding/api'
import { useAuth } from '../auth/useAuth'
import * as register from './api'

vi.mock('../onboarding/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/api')>()),
  useOnboardingList: vi.fn(),
  useCreateOnboarding: vi.fn(),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('./api', () => ({
  useRegisterAvailable: vi.fn(),
  useEmployeesNamed: vi.fn(),
  useCreateEmployee: vi.fn(),
}))
// Name suggestions from the Active Employees directory (20260901000028).
vi.mock('../employees/api', () => ({
  useDirectoryAvailable: () => ({ data: true }),
  useEmployeeDirectory: () => ({
    data: [
      { id: 'd1', full_name: 'Dana Field', employment_status: 'active' },
      { id: 'd2', full_name: 'Old Timer', employment_status: 'inactive' },
    ],
  }),
}))

const createChecklist = vi.fn(async () => 'onb-new')
const createEmployee = vi.fn(async () => 'emp-new')

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingListPage />} />
        <Route path="/onboarding/:id" element={<p>Opened checklist</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({ role: 'admin', user: { id: 'u1' } } as ReturnType<typeof useAuth>)
  vi.mocked(useOnboardingList).mockReturnValue({ data: [], isLoading: false, error: null } as never)
  vi.mocked(useCreateOnboarding).mockReturnValue({ mutateAsync: createChecklist, isPending: false } as never)
  vi.mocked(register.useCreateEmployee).mockReturnValue({ mutateAsync: createEmployee, isPending: false } as never)
  vi.mocked(register.useRegisterAvailable).mockReturnValue({ data: true } as never)
  vi.mocked(register.useEmployeesNamed).mockReturnValue({ data: [], isLoading: false } as never)
})

async function start(name: string) {
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Start onboarding' }))
  await user.type(screen.getByRole('combobox', { name: 'Employee name' }), name)
  return user
}

describe('Start onboarding with the employee register', () => {
  it('suggests existing employees from the directory (onboarding: everyone, so rehires are found)', async () => {
    renderPage()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start onboarding' }))
    const list = document.getElementById(screen.getByRole('combobox', { name: 'Employee name' }).getAttribute('list')!)!
    expect([...list.querySelectorAll('option')].map((o) => o.value)).toEqual(['Dana Field', 'Old Timer'])
  })

  it('a new name creates an employee record and links the checklist to it', async () => {
    const user = await start('Test Employee 70')
    expect(screen.getByText(/A new employee record will be created/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(createEmployee).toHaveBeenCalledWith('Test Employee 70')
    expect(createChecklist).toHaveBeenCalledWith({ employeeName: 'Test Employee 70', createdBy: 'u1', employeeId: 'emp-new' })
  })

  it('an existing name must be confirmed as the same person or a different one — never guessed', async () => {
    vi.mocked(register.useEmployeesNamed).mockReturnValue({
      data: [{ id: 'emp-1', full_name: 'Test Employee 70', name_key: 'test employee 70', created_at: '2026-09-01T00:00:00Z' }],
      isLoading: false,
    } as never)
    const user = await start('Test Employee 70')
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Yes — Test Employee 70/ }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(createEmployee).not.toHaveBeenCalled()
    expect(createChecklist).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 'emp-1' }))
  })

  it('choosing "a different person" creates a separate record', async () => {
    vi.mocked(register.useEmployeesNamed).mockReturnValue({
      data: [{ id: 'emp-1', full_name: 'Test Employee 70', name_key: 'test employee 70', created_at: '2026-09-01T00:00:00Z' }],
      isLoading: false,
    } as never)
    const user = await start('Test Employee 70')
    await user.click(screen.getByRole('radio', { name: /No — a different person/ }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(createEmployee).toHaveBeenCalledWith('Test Employee 70')
    expect(createChecklist).toHaveBeenCalledWith(expect.objectContaining({ employeeId: 'emp-new' }))
  })

  it('before the register exists, starting works exactly as before (no employee record)', async () => {
    vi.mocked(register.useRegisterAvailable).mockReturnValue({ data: false } as never)
    const user = await start('Test Employee 71')
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(createEmployee).not.toHaveBeenCalled()
    expect(createChecklist).toHaveBeenCalledWith({ employeeName: 'Test Employee 71', createdBy: 'u1', employeeId: null })
  })
})
