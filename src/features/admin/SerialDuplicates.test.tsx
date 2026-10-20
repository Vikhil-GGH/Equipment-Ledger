import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AdminPage } from './AdminPage'
import * as adminApi from './api'

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('../register/api', () => ({
  useRegisterAvailable: () => ({ data: false }),
  usePossibleDuplicates: () => ({ data: [] }),
}))
vi.mock('./api', () => ({
  useUsersList: () => ({ data: [], isLoading: false, error: null }),
  useUpdateUserRole: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveUser: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRestoreUser: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSerialDuplicates: vi.fn(),
}))

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminPage />
    </MemoryRouter>,
  )

describe('devices sharing a serial number (admin review list)', () => {
  it('lists each existing duplicate with a link, read-only', () => {
    vi.mocked(adminApi.useSerialDuplicates).mockReturnValue({
      data: [
        { serial_key: 'SYN-DUP-C', collection: 'active_laptops_np', asset_id: 'c1', serial: 'SYN-DUP-C', status: 'available', assigned_to: null, reason: 'Same serial as another device' },
        { serial_key: 'SYN-DUP-C', collection: 'active_laptops_np', asset_id: 'c2', serial: ' SYN-DUP-C', status: 'available', assigned_to: null, reason: 'Same serial as another device' },
      ],
    } as never)
    renderPage()
    expect(screen.getByRole('heading', { name: 'Devices sharing a serial number' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '" SYN-DUP-C"' })).toHaveAttribute('href', '/active-laptops-np/c2')
    expect(screen.queryByRole('button', { name: /merge|delete/i })).not.toBeInTheDocument()
  })

  it('says none found, and is hidden on a database without serial checks', () => {
    vi.mocked(adminApi.useSerialDuplicates).mockReturnValue({ data: [] } as never)
    const { unmount } = renderPage()
    expect(screen.getByText('Devices sharing a serial number').closest('.card')).toHaveTextContent('None found.')
    unmount()
    vi.mocked(adminApi.useSerialDuplicates).mockReturnValue({ data: null } as never)
    renderPage()
    expect(screen.queryByText('Devices sharing a serial number')).not.toBeInTheDocument()
  })
})
