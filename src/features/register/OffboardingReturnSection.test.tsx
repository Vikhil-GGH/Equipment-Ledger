import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { OffboardingReturnSection } from './OffboardingReturnSection'
import * as api from './api'
import type { EquipmentIssue } from './registerModel'

vi.mock('./api', () => ({
  useEmployee: vi.fn(),
  useEmployeeIssues: vi.fn(),
  useReturnEquipment: vi.fn(),
  useUnregisteredDevices: vi.fn(),
  useEmployeesNamed: vi.fn(() => ({ data: [], isLoading: false })),
  useCreateEmployee: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useLinkChecklistEmployee: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))

const doReturn = vi.fn(async () => 'closed')

function row(id: string, extra: Partial<EquipmentIssue>): EquipmentIssue {
  return {
    id,
    employee_id: 'emp-1',
    assignee_name: 'Test Employee 04',
    employee_ambiguous: false,
    item_kind: 'serialized',
    asset_collection: 'active_laptops_np',
    asset_id: 'a-' + id,
    bulk_item_id: null,
    quantity: 1,
    description: 'Dell Latitude 5440',
    serial: 'SYN-INV-004',
    issued_at: '2026-10-01T10:00:00Z',
    onboarding_id: null,
    status: 'open',
    closed_at: null,
    close_note: null,
    offboarding_id: null,
    source: 'backfill',
    ...extra,
  }
}

const ISSUES = [
  row('laptop1', {}),
  row('laptop2', { serial: 'SYN-INV-099', asset_id: 'a-l2' }),
  row('monitor', { asset_collection: 'monitors', description: 'Dell 24 Monitor', serial: 'SYN-MON-004' }),
  row('charger', { item_kind: 'bulk', asset_collection: null, asset_id: null, bulk_item_id: 'b1', quantity: 2, description: 'USB-C Charger', serial: null }),
  row('done', { status: 'returned', closed_at: '2026-10-10T00:00:00Z', description: 'Headset', asset_collection: 'other_equipment', serial: 'SYN-HS-1' }),
  row('moved', { status: 'transferred', closed_at: '2026-10-05T00:00:00Z', description: 'Old monitor', asset_collection: 'monitors' }),
]

function setup(issues = ISSUES, unregistered: unknown[] = []) {
  vi.mocked(api.useEmployee).mockReturnValue({ data: { id: 'emp-1', full_name: 'Test Employee 04', name_key: 'test employee 04', created_at: '' } } as never)
  vi.mocked(api.useEmployeeIssues).mockReturnValue({ data: issues, isLoading: false } as never)
  vi.mocked(api.useUnregisteredDevices).mockReturnValue({ data: unregistered } as never)
  render(
    <MemoryRouter>
      <OffboardingReturnSection canEdit record={{ id: 'off-1', employee_name: 'Test Employee 04', employee_id: 'emp-1' }} />
    </MemoryRouter>,
  )
}
const rowOf = (text: string) => screen.getAllByText(text)[0].closest('tr')!

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.useReturnEquipment).mockReturnValue({ mutateAsync: doReturn, isPending: false } as never)
})

describe('Offboarding → Equipment return', () => {
  it('lists everything issued — laptops (each separately), monitors, chargers — with type, serial, quantity, issued date and status', () => {
    setup()
    for (const [text, type] of [['SYN-INV-004', 'Laptop'], ['SYN-INV-099', 'Laptop'], ['Dell 24 Monitor', 'Monitor'], ['USB-C Charger', 'Bulk Stock']]) {
      expect(within(rowOf(text)).getByText(type)).toBeInTheDocument()
    }
    expect(within(rowOf('USB-C Charger')).getByText('2')).toBeInTheDocument()
    expect(screen.getAllByText('Pending return')).toHaveLength(4)
    // History of reassignment isn't part of this employee's return list.
    expect(screen.queryByText('Old monitor')).not.toBeInTheDocument()
  })

  it('return progress is shown on its own, separate from the checklist', () => {
    setup()
    expect(screen.getByTestId('return-progress')).toHaveTextContent('4 pending return · 1 of 5 processed')
  })

  it('each item is processed independently, with its exact inventory effect shown before confirming', async () => {
    const user = userEvent.setup()
    setup()
    const laptopRow = within(rowOf('SYN-INV-004'))
    await user.click(laptopRow.getByRole('button', { name: 'Process return' }))
    await user.click(laptopRow.getByRole('radio', { name: 'Returned damaged' }))
    expect(laptopRow.getByRole('status')).toHaveTextContent('Collect, then Mark damaged: the device becomes Damaged and unassigned.')
    await user.click(laptopRow.getByRole('button', { name: 'Confirm' }))
    expect(doReturn).toHaveBeenCalledWith({ issueId: 'laptop1', outcome: 'returned_damaged', quantity: null, note: null, offboardingId: 'off-1' })
    expect(doReturn).toHaveBeenCalledTimes(1)
  })

  it('nothing happens until an outcome is chosen', async () => {
    const user = userEvent.setup()
    setup()
    const r = within(rowOf('SYN-INV-099'))
    await user.click(r.getByRole('button', { name: 'Process return' }))
    expect(r.getAllByRole('radio').some((x) => (x as HTMLInputElement).checked)).toBe(false)
    expect(r.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })

  it('Retained — authorized and Lost need a written reason', async () => {
    const user = userEvent.setup()
    setup()
    const r = within(rowOf('SYN-INV-004'))
    await user.click(r.getByRole('button', { name: 'Process return' }))
    await user.click(r.getByRole('radio', { name: 'Retained — authorized' }))
    expect(r.getByText('Reason (required)')).toBeInTheDocument()
    expect(r.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await user.type(r.getByRole('textbox'), 'Approved by HR, contractor keeps device')
    await user.click(r.getByRole('button', { name: 'Confirm' }))
    expect(doReturn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'retained_authorized', note: 'Approved by HR, contractor keeps device' }),
    )
  })

  it('a Bulk Stock item can be returned in part', async () => {
    const user = userEvent.setup()
    setup()
    const r = within(rowOf('USB-C Charger'))
    await user.click(r.getByRole('button', { name: 'Process return' }))
    await user.click(r.getByRole('radio', { name: 'Returned' }))
    const qty = r.getByRole('spinbutton')
    await user.clear(qty)
    await user.type(qty, '1')
    expect(r.getByRole('status')).toHaveTextContent('Bulk Stock: 1 moved from Provided to Available.')
    await user.click(r.getByRole('button', { name: 'Confirm' }))
    expect(doReturn).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'charger', outcome: 'returned', quantity: 1 }))
  })

  it('processed items show as done with their status', () => {
    setup()
    const r = within(rowOf('SYN-HS-1'))
    expect(r.getByText('Returned')).toBeInTheDocument()
    expect(r.getByText('Done')).toBeInTheDocument()
  })

  it('warns about devices assigned to this name but missing from the register', () => {
    setup(ISSUES, [{ collection: 'monitors', asset_id: 'm9', serial: 'SYN-MON-099', assigned_to: 'Test Employee 04' }])
    expect(screen.getByRole('status')).toHaveTextContent(/not in the register/)
    expect(screen.getByRole('link', { name: 'SYN-MON-099' })).toHaveAttribute('href', '/monitors/m9')
  })
})
