import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { LaptopInventoryPage, PAGE_SIZE } from './LaptopInventoryPage'
import { useLaptopInventory } from './api'
import { downloadLaptopExport } from './exportLaptops'
import { combineLaptops, type LaptopRecord } from './laptopInventory'
import { useAuth } from '../auth/useAuth'

// Rendering/interaction only: data, export and auth are mocked.
vi.mock('./api', () => ({ useLaptopInventory: vi.fn() }))
vi.mock('./exportLaptops', () => ({ downloadLaptopExport: vi.fn(async () => 0) }))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))
// Register not present (pre-026 database): the page must behave exactly as before.
vi.mock('../register/api', () => ({
  useRegisterAvailable: vi.fn(() => ({ data: false })),
  useRetainedDeviceIds: vi.fn(() => ({ data: undefined })),
}))
vi.mock('../assets/AddAssetForm', () => ({
  AddAssetForm: ({ collection }: { collection: string }) => <p>Add form for {collection}</p>,
}))

function rec(id: string, serial: string, status: LaptopRecord['status'], extra: Partial<LaptopRecord> = {}): LaptopRecord {
  return {
    id,
    name: 'Dell Latitude 5440',
    category: 'Laptop',
    serial,
    status,
    assigned_to: status === 'provided' ? `Employee of ${serial}` : null,
    location: null,
    created_at: '2026-10-14T00:00:00Z',
    updated_at: `2026-10-14T00:00:${id.padStart(2, '0')}Z`,
    ...extra,
  }
}

const INVENTORY = [rec('1', 'SYN-INV-012', 'available'), rec('2', 'SYN-INV-006', 'damaged'), rec('3', 'SYN-INV-009', 'nonfunctional')]
const ACTIVE_NP = [
  rec('4', 'SYN-INV-001', 'provided', { moved_from_inventory: true }),
  rec('5', 'SYN-NP-001', 'provided', { moved_from_inventory: false }),
  rec('6', 'SYN-NP-010', 'available', { moved_from_inventory: false }),
]

function mockRows(inventory = INVENTORY, activeNp = ACTIVE_NP) {
  vi.mocked(useLaptopInventory).mockReturnValue({ rows: combineLaptops(inventory, activeNp), isLoading: false, error: null })
}

function Where() {
  const loc = useLocation()
  const { id } = useParams()
  return <p>At {loc.pathname} {id}</p>
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/laptops" element={<LaptopInventoryPage />} />
        <Route path="/active-laptops-np" element={<Navigate to="/laptops?tab=active" replace />} />
        <Route path="/serialized-assets/:id" element={<Where />} />
        <Route path="/active-laptops-np/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

const serials = () =>
  within(screen.getAllByRole('rowgroup')[1])
    .queryAllByRole('row')
    .map((r) => within(r).getAllByRole('cell')[0].querySelector('a')?.textContent)
    .filter(Boolean)
const tab = (name: RegExp) => screen.getByRole('tab', { name })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useAuth).mockReturnValue({ role: 'admin' } as ReturnType<typeof useAuth>)
  mockRows()
})

describe('LaptopInventoryPage', () => {
  it('All Laptops shows every laptop from both tables, with totals', () => {
    renderAt('/laptops')
    expect(tab(/All Laptops/)).toHaveAttribute('aria-selected', 'true')
    expect(serials()).toHaveLength(6)
    expect(screen.getByText(/6 laptops in total · 2 NP-managed · 4 Company/)).toBeInTheDocument()
  })

  it('tab counts, and Active / Assigned holds only assigned laptops', async () => {
    const user = userEvent.setup()
    renderAt('/laptops')
    expect(tab(/Active \/ Assigned/)).toHaveTextContent('2')
    expect(tab(/^Available/)).toHaveTextContent('2')
    expect(tab(/Damaged/)).toHaveTextContent('1')
    expect(tab(/Other/)).toHaveTextContent('1')
    await user.click(tab(/Active \/ Assigned/))
    expect(serials().sort()).toEqual(['SYN-INV-001', 'SYN-NP-001'])
    expect(screen.queryByText('SYN-NP-010')).not.toBeInTheDocument() // available NP laptop is not "active"
  })

  it('the old Active Laptops list URL opens Laptop Inventory on Active / Assigned', () => {
    renderAt('/active-laptops-np')
    expect(tab(/Active \/ Assigned/)).toHaveAttribute('aria-selected', 'true')
    expect(serials().sort()).toEqual(['SYN-INV-001', 'SYN-NP-001'])
  })

  it('management scope filter: NP-managed vs Company (a moved Inventory laptop is Company)', async () => {
    const user = userEvent.setup()
    renderAt('/laptops')
    const scope = screen.getByRole('combobox', { name: 'Management scope' })
    await user.selectOptions(scope, 'np')
    expect(serials().sort()).toEqual(['SYN-NP-001', 'SYN-NP-010'])
    await user.selectOptions(scope, 'company')
    expect(serials().sort()).toEqual(['SYN-INV-001', 'SYN-INV-006', 'SYN-INV-009', 'SYN-INV-012'])
  })

  it('shows the actual status on every row', () => {
    renderAt('/laptops?tab=other')
    expect(serials()).toEqual(['SYN-INV-009'])
    expect(screen.getByText('Nonfunctional')).toBeInTheDocument()
  })

  it('rows open the existing detail page of the table the laptop lives in', async () => {
    const user = userEvent.setup()
    renderAt('/laptops')
    await user.click(screen.getByText('SYN-NP-001'))
    expect(screen.getByText('At /active-laptops-np/5 5')).toBeInTheDocument()
  })

  it('a company laptop currently assigned (moved) opens under its current table', async () => {
    const user = userEvent.setup()
    renderAt('/laptops')
    await user.click(screen.getByText('SYN-INV-001'))
    expect(screen.getByText('At /active-laptops-np/4 4')).toBeInTheDocument()
  })

  it('Export sends exactly the filtered, sorted rows — all of them, not one page', async () => {
    const many = Array.from({ length: PAGE_SIZE + 25 }, (_, i) => rec(String(100 + i), `SYN-BULK-${i}`, 'available'))
    mockRows(many, ACTIVE_NP)
    const user = userEvent.setup()
    renderAt('/laptops?tab=available')
    expect(serials()).toHaveLength(PAGE_SIZE)
    await user.click(screen.getByRole('button', { name: /Export to Excel \(76\)/ }))
    const [rows, filters] = vi.mocked(downloadLaptopExport).mock.calls[0]
    expect(rows).toHaveLength(PAGE_SIZE + 26)
    expect(rows.every((r) => r.tab === 'available')).toBe(true)
    expect(filters).toMatchObject({ tab: 'available', scope: 'all' })
  })

  it('paginates and resets to page 1 when the filters change', async () => {
    mockRows(Array.from({ length: PAGE_SIZE + 5 }, (_, i) => rec(String(200 + i), `SYN-P-${i}`, 'available')), [])
    const user = userEvent.setup()
    renderAt('/laptops')
    expect(screen.getByText(`Showing 1–${PAGE_SIZE} of ${PAGE_SIZE + 5}`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(serials()).toHaveLength(5)
    await user.type(screen.getByRole('textbox', { name: 'Search laptops' }), 'SYN-P')
    expect(screen.getByText(`Showing 1–${PAGE_SIZE} of ${PAGE_SIZE + 5}`)).toBeInTheDocument()
  })

  it('search filters across serial and assignee', async () => {
    const user = userEvent.setup()
    renderAt('/laptops')
    await user.type(screen.getByRole('textbox', { name: 'Search laptops' }), 'employee of syn-np')
    expect(serials()).toEqual(['SYN-NP-001'])
  })

  it('Add laptop asks for the management scope', async () => {
    const user = userEvent.setup()
    renderAt('/laptops')
    await user.click(screen.getByRole('button', { name: 'Add laptop' }))
    expect(screen.getByText('Add form for serialized_assets')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /NP-managed/ }))
    expect(screen.getByText('Add form for active_laptops_np')).toBeInTheDocument()
  })

  it('viewers get no Add / Import buttons', () => {
    vi.mocked(useAuth).mockReturnValue({ role: 'viewer' } as ReturnType<typeof useAuth>)
    renderAt('/laptops')
    expect(screen.queryByRole('button', { name: 'Add laptop' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Import from Excel' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export to Excel/ })).toBeInTheDocument()
  })
})
