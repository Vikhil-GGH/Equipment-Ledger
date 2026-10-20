import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AdminPage } from './AdminPage'
import * as adminApi from './api'

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('../register/api', () => ({ useRegisterAvailable: () => ({ data: false }), usePossibleDuplicates: () => ({ data: [] }) }))
vi.mock('./api', () => ({
  useUsersList: vi.fn(),
  useUpdateUserRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveUser: vi.fn(),
  useRestoreUser: vi.fn(),
  useSerialDuplicates: () => ({ data: null }),
}))

const revoke = vi.fn().mockResolvedValue(undefined)
const restore = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  revoke.mockClear()
  restore.mockClear()
  vi.mocked(adminApi.useRemoveUser).mockReturnValue({ mutateAsync: revoke, isPending: false } as never)
  vi.mocked(adminApi.useRestoreUser).mockReturnValue({ mutateAsync: restore, isPending: false } as never)
  vi.mocked(adminApi.useUsersList).mockReturnValue({
    data: [
      { id: 'me', email: 'admin@example.invalid', full_name: null, role: 'admin', created_at: '' },
      { id: 'u2', email: 'editor@example.invalid', full_name: null, role: 'editor', created_at: '' },
      { id: 'u3', email: 'former@example.invalid', full_name: null, role: 'viewer', created_at: '', access_revoked_at: '2026-10-19T10:00:00Z', role_before_revoke: 'editor' },
    ],
    isLoading: false,
    error: null,
  } as never)
})

const card = (email: string) => screen.getAllByText(email)[0].closest('.card') as HTMLElement
const renderPage = () => render(<MemoryRouter><AdminPage /></MemoryRouter>)

describe('Access & Roles: remove and restore access (no profile deletion)', () => {
  it('Remove access asks for confirmation (with an optional reason) and revokes — it never deletes', async () => {
    const user = userEvent.setup()
    renderPage()
    const row = within(card('editor@example.invalid'))
    await user.click(row.getByRole('button', { name: 'Remove access' }))
    expect(revoke).not.toHaveBeenCalled()
    await user.type(row.getByRole('textbox', { name: 'Reason for removing access' }), 'Left the company')
    await user.click(row.getByRole('button', { name: 'Confirm remove' }))
    expect(revoke).toHaveBeenCalledWith({ userId: 'u2', reason: 'Left the company' })
  })

  it('a removed person is shown as such, keeps their history, and can be restored; their role cannot be changed meanwhile', async () => {
    const user = userEvent.setup()
    renderPage()
    const row = within(card('former@example.invalid'))
    expect(card('former@example.invalid')).toHaveTextContent('Access removed')
    expect(card('former@example.invalid')).toHaveTextContent('was editor. Their history is kept.')
    expect(row.getByRole('combobox', { name: 'Role for former@example.invalid' })).toBeDisabled()
    await user.click(row.getByRole('button', { name: 'Restore access' }))
    expect(restore).toHaveBeenCalledWith({ userId: 'u3' })
  })

  it('you cannot remove your own access', () => {
    renderPage()
    expect(within(card('admin@example.invalid')).getByRole('button', { name: 'Remove access' })).toBeDisabled()
  })
})
