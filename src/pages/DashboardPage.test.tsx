import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { DashboardPage } from './DashboardPage'
import { useDashboardData } from '../features/dashboard/useDashboardData'
import { combineLaptops, type LaptopRecord } from '../features/laptops/laptopInventory'
import { attentionItems, bulkBreakdown, kpis, laptopBreakdown, laptopOwnership, statusBreakdown } from '../features/dashboard/dashboardModel'

vi.mock('../features/auth/useAuth', () => ({ useAuth: () => ({ profile: { email: 'admin@example.invalid', role: 'admin' }, role: 'admin' }) }))
vi.mock('../features/dashboard/useDashboardData', () => ({ useDashboardData: vi.fn() }))

const L = (id: string, status: LaptopRecord['status'], assigned_to: string | null = null): LaptopRecord => ({
  id, name: 'Laptop', category: 'Laptop', serial: `S${id}`, status, assigned_to, location: null, created_at: '', updated_at: '',
})

function model(empty = false) {
  const rows = empty ? [] : combineLaptops([L('1', 'available'), L('2', 'damaged')], [L('3', 'provided', 'Ann'), L('4', 'provided', 'Bob')])
  const l = laptopBreakdown(rows)
  const m = statusBreakdown(empty ? [] : [{ status: 'available', count: 5 }, { status: 'provided', count: 3 }])
  const o = statusBreakdown(empty ? [] : [{ status: 'available', count: 2 }])
  const b = bulkBreakdown(empty ? { available: 0, provided: 0, retained: 0, damaged: 0, decommissioned: 0 } : { available: 40, provided: 10, retained: 0, damaged: 0, decommissioned: 0 })
  return {
    laptops: l, monitors: m, other: o, bulk: b,
    ownership: laptopOwnership(rows),
    kpis: kpis(l, m, o, b, empty ? 0 : 2),
    attention: attentionItems({ laptops: l, laptopRows: rows, monitors: m, other: o, bulk: b, bulkItems: [], pendingReturns: empty ? 0 : 2, offboardingNeedsReview: 0, duplicateSerials: null, isAdmin: true }),
  }
}
const ok = { loading: false, error: null }
const sections = (s = ok) => ({ laptops: s, monitors: s, other: s, bulk: s, attention: s })

function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Overview dashboard', () => {
  it('KPI cards show the real totals and link to the filtered inventory', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(), sections: sections() } as never)
    renderPage()
    expect(screen.getByRole('link', { name: 'Total laptops: 4. Open' })).toHaveAttribute('href', '/laptops')
    expect(screen.getByRole('link', { name: 'Available laptops: 1. Open' })).toHaveAttribute('href', '/laptops?tab=available')
    expect(screen.getByRole('link', { name: 'Assigned laptops: 2. Open' })).toHaveAttribute('href', '/laptops?tab=active')
    // 4 laptops + 8 monitors + 2 other = 14 devices; bulk units are separate.
    const tracked = screen.getByText('Total tracked equipment').closest('.card')!
    expect(tracked).toHaveTextContent('14')
    expect(tracked).toHaveTextContent('plus 50 bulk units in 2 items (counted separately)')
  })

  it('donut legend and segments navigate to the matching Laptop Inventory tab (mouse and keyboard)', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(), sections: sections() } as never)
    renderPage()
    const panel = screen.getByRole('region', { name: 'Laptop Inventory' })
    expect(within(panel).getByRole('link', { name: /Damaged \/ Repair\s*1\s*25%/ })).toHaveAttribute('href', '/laptops?tab=damaged')
    const segment = within(panel).getByRole('link', { name: 'Active / Assigned: 2 (50%)' })
    fireEvent.keyDown(segment, { key: 'Enter' })
    expect(screen.getByTestId('where')).toHaveTextContent('/laptops?tab=active')
  })

  it('equipment comparison distinguishes devices from bulk units, with links per segment', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(), sections: sections() } as never)
    renderPage()
    const panel = screen.getByRole('region', { name: 'Equipment by status' })
    expect(panel).toHaveTextContent('4 devices')
    expect(panel).toHaveTextContent('8 devices')
    expect(panel).toHaveTextContent('50 units (bulk quantity)')
    expect(within(panel).getByRole('link', { name: /^Bulk Stock — Available: 40 \(80%\)/ })).toHaveAttribute('href', '/bulk-stock')
    expect(within(panel).getByRole('link', { name: /^Laptops — Damaged \/ Repair: 1 \(25%\)/ })).toHaveAttribute('href', '/laptops?tab=damaged')
  })

  it('ownership and attention items link to where they can be acted on', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(), sections: sections() } as never)
    renderPage()
    expect(screen.getByRole('link', { name: /NP-managed\s*2\s*50%/ })).toHaveAttribute('href', '/laptops?scope=np')
    expect(screen.getByRole('link', { name: /Company-owned\s*2\s*50%/ })).toHaveAttribute('href', '/laptops?scope=company')
    const attention = screen.getByRole('region', { name: 'Attention required' })
    expect(within(attention).getByRole('link', { name: /Equipment pending return: 2/ })).toHaveAttribute('href', '/offboarding')
    expect(within(attention).getByRole('link', { name: /Damaged laptops: 1/ })).toHaveAttribute('href', '/laptops?tab=damaged')
  })

  it('summary cards use accessible progress bars', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(), sections: sections() } as never)
    renderPage()
    const monitors = screen.getByRole('region', { name: 'Monitors' })
    expect(within(monitors).getByRole('progressbar', { name: 'Available' })).toHaveAttribute('aria-valuetext', '5 of 8 (63%)')
  })

  it('empty data: empty states, no errors, nothing needing attention', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(true), sections: sections() } as never)
    renderPage()
    expect(screen.getAllByText('No laptops recorded yet.')).toHaveLength(2)
    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument()
    expect(screen.getAllByText('Nothing recorded yet.')).toHaveLength(3)
  })

  it('loading and error states', () => {
    vi.mocked(useDashboardData).mockReturnValue({ model: model(true), sections: sections({ loading: true, error: null }) } as never)
    const { unmount } = renderPage()
    expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(4)
    unmount()
    vi.mocked(useDashboardData).mockReturnValue({ model: model(true), sections: sections({ loading: false, error: new Error('network down') } as never) } as never)
    renderPage()
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(3)
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('network down')
  })
})
