import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppShell } from './AppShell'
import { useAuth } from '../features/auth/useAuth'

vi.mock('../features/auth/useAuth', () => ({ useAuth: vi.fn() }))

function renderShell(role: 'admin' | 'editor' | 'viewer') {
  vi.mocked(useAuth).mockReturnValue({ role, profile: { email: 'x@example.invalid', role }, signOut: vi.fn() } as never)
  render(
    <MemoryRouter>
      <AppShell>
        <p>page</p>
      </AppShell>
    </MemoryRouter>,
  )
  // The desktop sidebar (the mobile drawer holds the same links).
  return within(screen.getAllByRole('navigation')[0])
}

describe('sidebar', () => {
  it('keeps Onboarding and Offboarding as two separate sections, and one Laptop Inventory', () => {
    const nav = renderShell('admin')
    expect(nav.getByRole('link', { name: 'Onboarding' })).toHaveAttribute('href', '/onboarding')
    expect(nav.getByRole('link', { name: 'Offboarding' })).toHaveAttribute('href', '/offboarding')
    expect(nav.getByRole('link', { name: 'Laptop Inventory' })).toHaveAttribute('href', '/laptops')
    expect(nav.queryByRole('link', { name: /Active Laptops/ })).not.toBeInTheDocument()
    expect(nav.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Overview',
      'Scan',
      'Laptop Inventory',
      'Onboarding',
      'Offboarding',
      'Monitors',
      'Other Equipment',
      'Bulk Stock',
      'Access & Roles',
      'Import History',
      'Export backup',
      'Import backup',
    ])
  })

  it('viewers see the workspace sections only', () => {
    const nav = renderShell('viewer')
    expect(nav.getByRole('link', { name: 'Onboarding' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'Offboarding' })).toBeInTheDocument()
    expect(nav.queryByRole('link', { name: 'Access & Roles' })).not.toBeInTheDocument()
  })
})
