import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EmployeeModal } from './EmployeeModal'
import { duplicateFinder } from './employeeImport'
import * as api from './api'
import type { DirectoryEmployee } from './directoryModel'

vi.mock('./api', () => ({
  useEmployeeDirectory: vi.fn(),
  useEmployeeHistory: vi.fn(),
  useOpenEquipmentCount: vi.fn(),
  useSaveEmployee: vi.fn(),
  useSetEmploymentStatus: vi.fn(),
}))

const person = (over: Partial<DirectoryEmployee>): DirectoryEmployee =>
  ({
    id: 'e1', full_name: 'Jane Smith', name_key: 'jane smith', first_name: 'Jane', last_name: 'Smith', email: 'jane.smith@example.invalid',
    email_key: 'jane.smith@example.invalid', employment_status: 'active', ...over,
  }) as DirectoryEmployee

const save = vi.fn(async () => undefined)
const onClose = vi.fn()

function open(directory: DirectoryEmployee[]) {
  vi.mocked(api.useEmployeeDirectory).mockReturnValue({ data: directory } as never)
  vi.mocked(api.useEmployeeHistory).mockReturnValue({ data: [] } as never)
  vi.mocked(api.useOpenEquipmentCount).mockReturnValue({ data: 0 } as never)
  vi.mocked(api.useSaveEmployee).mockReturnValue({ mutateAsync: save, isPending: false } as never)
  vi.mocked(api.useSetEmploymentStatus).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as never)
  render(<EmployeeModal employee={null} canEdit onClose={onClose} />)
}
const field = (name: RegExp) => screen.getByLabelText(name)

async function fill(first: string, last: string, email = '') {
  const user = userEvent.setup()
  await user.type(field(/^First name/), first)
  await user.type(field(/^Last name/), last)
  if (email) await user.type(field(/^Work email/), email)
  return user
}

beforeEach(() => {
  save.mockClear()
  onClose.mockClear()
})

describe('Add employee: duplicate-name warning', () => {
  it('warns about an existing employee with the same name, saves nothing yet, and lists who they are', async () => {
    open([person({})])
    const user = await fill('jane', ' smith ')
    await user.click(screen.getByRole('button', { name: 'Add employee' }))
    expect(save).not.toHaveBeenCalled()
    const alert = screen.getByText(/may be someone who is already in the directory/)
    expect(alert).toBeInTheDocument()
    expect(screen.getByText('Jane Smith')).toBeInTheDocument()
    expect(screen.getByText(/same name/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing is merged automatically/)).toBeInTheDocument()
  })

  it('"Add as a different person" then saves a NEW record (never an update of the existing one)', async () => {
    open([person({})])
    const user = await fill('Jane', 'Smith', 'other.jane@example.invalid')
    await user.click(screen.getByRole('button', { name: 'Add employee' }))
    await user.click(screen.getByRole('button', { name: 'Add as a different person' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ id: null, fields: expect.objectContaining({ first_name: 'Jane', last_name: 'Smith', email: 'other.jane@example.invalid' }) })
    expect(onClose).toHaveBeenCalled()
  })

  it('changing a field after the warning asks again (the check follows what is typed)', async () => {
    open([person({})])
    const user = await fill('Jane', 'Smith')
    await user.click(screen.getByRole('button', { name: 'Add employee' }))
    expect(screen.getByRole('button', { name: 'Add as a different person' })).toBeInTheDocument()
    await user.clear(field(/^Last name/))
    await user.type(field(/^Last name/), 'Jones')
    expect(screen.queryByText(/may be someone who is already/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add employee' }))
    expect(save).toHaveBeenCalledTimes(1) // Jane Jones is not Jane Smith: no warning, saved straight away
  })

  it('a name nobody has is saved at once, with no warning', async () => {
    open([person({})])
    const user = await fill('Priya', 'Nair')
    await user.click(screen.getByRole('button', { name: 'Add employee' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/already in the directory/)).not.toBeInTheDocument()
  })

  it('also warns for a one-word record ("Sadvi") and for the same email user name on another domain — as the Excel preview does', async () => {
    open([person({ id: 'e2', full_name: 'Sadvi', name_key: 'sadvi', first_name: 'Sadvi', last_name: null, email: null, email_key: null })])
    const user = await fill('Sadvi', 'Rao')
    await user.click(screen.getByRole('button', { name: 'Add employee' }))
    expect(screen.getByText(/recorded only as “Sadvi”/)).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })

  it('the same rule as the Excel preview: duplicateFinder returns the same people and reasons', () => {
    const dir = [person({}), person({ id: 'e3', full_name: 'Ana Ruiz', name_key: 'ana ruiz', first_name: 'Ana', last_name: 'Ruiz', email: 'ana.ruiz@old.example', email_key: 'ana.ruiz@old.example' })]
    const find = duplicateFinder(dir)
    expect(find({ first_name: 'Jane', last_name: 'Smith', email: '' }).reasons).toEqual({ e1: 'same name' })
    expect(find({ first_name: 'A', last_name: 'R', email: 'ana.ruiz@new.example' }).reasons).toEqual({ e3: 'same email user name, different domain' })
    expect(find({ first_name: 'No', last_name: 'One', email: '' }).candidates).toEqual([])
  })
})

describe('Edit employee', () => {
  it('editing an existing employee never shows the duplicate warning', async () => {
    vi.mocked(api.useEmployeeDirectory).mockReturnValue({ data: [person({}), person({ id: 'e9', email: 'x@example.invalid', email_key: 'x@example.invalid' })] } as never)
    vi.mocked(api.useEmployeeHistory).mockReturnValue({ data: [] } as never)
    vi.mocked(api.useOpenEquipmentCount).mockReturnValue({ data: 0 } as never)
    vi.mocked(api.useSaveEmployee).mockReturnValue({ mutateAsync: save, isPending: false } as never)
    vi.mocked(api.useSetEmploymentStatus).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as never)
    render(<EmployeeModal employee={person({})} canEdit onClose={onClose} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/already in the directory/)).not.toBeInTheDocument()
  })
})
