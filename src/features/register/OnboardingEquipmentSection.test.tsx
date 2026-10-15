import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OnboardingEquipmentSection, type OnboardingEquipmentRecord } from './OnboardingEquipmentSection'
import * as api from './api'
import type { EquipmentIssue } from './registerModel'

// Hooks mocked: this tests what the screen does, not the database.
vi.mock('./api', () => ({
  useEmployeeIssues: vi.fn(),
  useIssuableDevices: vi.fn(),
  useBulkCandidates: vi.fn(),
  useIssueEquipment: vi.fn(),
  useSetOnboardingEquipmentFields: vi.fn(),
  useEmployeesNamed: vi.fn(),
  useCreateEmployee: vi.fn(),
  useLinkChecklistEmployee: vi.fn(),
}))

const issue = vi.fn(async () => 'new-issue')
const saveFields = vi.fn()
const createEmployee = vi.fn(async () => 'emp-new')
const link = vi.fn(async () => undefined)

function issueRow(extra: Partial<EquipmentIssue>): EquipmentIssue {
  return {
    id: 'i' + Math.random(),
    employee_id: 'emp-1',
    assignee_name: 'Test Employee C',
    employee_ambiguous: false,
    item_kind: 'serialized',
    asset_collection: 'active_laptops_np',
    asset_id: 'a1',
    bulk_item_id: null,
    quantity: 1,
    description: 'Dell Latitude 5440',
    serial: 'SYN-INV-021',
    issued_at: '2026-10-15T10:00:00Z',
    onboarding_id: 'onb-1',
    status: 'open',
    closed_at: null,
    close_note: null,
    offboarding_id: null,
    source: 'issue',
    ...extra,
  }
}

function setup(record: Partial<OnboardingEquipmentRecord>, issues: EquipmentIssue[] = []) {
  vi.mocked(api.useEmployeeIssues).mockReturnValue({ data: issues } as never)
  render(
    <OnboardingEquipmentSection
      canEdit
      record={{ id: 'onb-1', employee_name: 'Test Employee C', employee_id: 'emp-1', charger_required: null, headset_required: null, ...record }}
    />,
  )
}
const group = (name: RegExp) => screen.getByRole('radiogroup', { name })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.useIssuableDevices).mockImplementation(
    (kind) =>
      ({
        data:
          kind === 'laptop'
            ? [{ id: 'a9', collection: 'serialized_assets', name: 'Dell Latitude 5440', serial: 'SYN-INV-022', status: 'available', location: null }]
            : [{ id: 'h1', collection: 'other_equipment', name: 'Headset', serial: 'SYN-HS-1', status: 'available', location: null }],
        isLoading: false,
      }) as never,
  )
  vi.mocked(api.useBulkCandidates).mockImplementation(
    (kind) =>
      ({
        data: [{ id: kind === 'charger' ? 'b-ch' : 'b-hs', name: kind === 'charger' ? 'USB-C Charger' : 'Headset', category: 'x', available: 5 }],
        isLoading: false,
      }) as never,
  )
  vi.mocked(api.useIssueEquipment).mockReturnValue({ mutateAsync: issue, isPending: false } as never)
  vi.mocked(api.useSetOnboardingEquipmentFields).mockReturnValue({ mutate: saveFields, isPending: false } as never)
  vi.mocked(api.useEmployeesNamed).mockReturnValue({ data: [], isLoading: false } as never)
  vi.mocked(api.useCreateEmployee).mockReturnValue({ mutateAsync: createEmployee, isPending: false } as never)
  vi.mocked(api.useLinkChecklistEmployee).mockReturnValue({ mutateAsync: link, isPending: false } as never)
})

describe('Onboarding → Equipment assignment', () => {
  it('Charger and Headset start blank — nothing pre-selected — and say so', () => {
    setup({})
    for (const g of [group(/Charger required/), group(/Headset required/)]) {
      const radios = within(g).getAllByRole('radio')
      expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['Yes', 'No', 'N/A'])
      expect(radios.some((r) => (r as HTMLInputElement).checked)).toBe(false)
    }
    expect(screen.getAllByText(/Not answered yet — choose Yes, No or N\/A/)).toHaveLength(2)
  })

  it('choosing Yes only saves the answer — it does not issue anything', async () => {
    const user = userEvent.setup()
    setup({})
    await user.click(within(group(/Headset required/)).getByRole('radio', { name: 'Yes' }))
    expect(saveFields).toHaveBeenCalledWith({ headset_required: 'yes' })
    expect(issue).not.toHaveBeenCalled()
  })

  it('the answer can be changed later', async () => {
    const user = userEvent.setup()
    setup({ charger_required: 'yes' })
    await user.click(within(group(/Charger required/)).getByRole('radio', { name: 'N/A' }))
    expect(saveFields).toHaveBeenCalledWith({ charger_required: 'not_applicable' })
  })

  it('Issue charger appears only after Yes, and issues exactly one from Bulk Stock when clicked', async () => {
    const user = userEvent.setup()
    setup({ charger_required: 'no' })
    expect(screen.queryByRole('button', { name: 'Issue charger' })).not.toBeInTheDocument()
    cleanupAndSetup({ charger_required: 'yes' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Choose a Bulk Stock charger' }), 'b-ch')
    await user.click(screen.getByRole('button', { name: 'Issue charger' }))
    expect(issue).toHaveBeenCalledWith({ bulk: { itemId: 'b-ch', quantity: 1 }, employeeId: 'emp-1', onboardingId: 'onb-1' })
  })

  it('a headset can come from Other Equipment or Bulk Stock — the operator chooses', async () => {
    const user = userEvent.setup()
    setup({ headset_required: 'yes' })
    const source = group(/Headset source/)
    expect(within(source).getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false)
    await user.click(within(source).getByRole('radio', { name: /Other Equipment/ }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Choose a headset' }), 'h1')
    await user.click(screen.getByRole('button', { name: 'Issue headset' }))
    expect(issue).toHaveBeenCalledWith({ device: { collection: 'other_equipment', id: 'h1' }, employeeId: 'emp-1', onboardingId: 'onb-1' })
  })

  it('issues a laptop chosen from Laptop Inventory, and allows another one', async () => {
    const user = userEvent.setup()
    setup({}, [issueRow({})])
    expect(screen.getByText(/Issued: Dell Latitude 5440 \(SYN-INV-021\)/)).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Choose a laptop' }), 'a9')
    await user.click(screen.getByRole('button', { name: 'Issue another laptop' }))
    expect(issue).toHaveBeenCalledWith({ device: { collection: 'serialized_assets', id: 'a9' }, employeeId: 'emp-1', onboardingId: 'onb-1' })
  })

  it('changing the answer to No after a headset was issued keeps it issued and says so', () => {
    setup({ headset_required: 'no' }, [issueRow({ item_kind: 'bulk', asset_collection: null, asset_id: null, description: 'Headset', serial: null })])
    expect(screen.getByRole('status')).toHaveTextContent(/still issued to this employee. Changing the answer doesn't return it/)
  })

  it('shows the summary and the full issued-equipment list', () => {
    setup({ charger_required: 'yes', headset_required: 'not_applicable' }, [
      issueRow({}),
      issueRow({ status: 'returned', description: 'Old laptop', serial: 'SYN-OLD' }),
    ])
    expect(screen.getByTestId('equipment-summary')).toHaveTextContent('Laptop: 1 issued · Charger: Required — not issued yet · Headset: Not required')
    expect(screen.getByText('Old laptop')).toBeInTheDocument()
  })

  it('without an employee record, asks to link one — existing same-name employees are offered, never pre-chosen', async () => {
    const user = userEvent.setup()
    vi.mocked(api.useEmployeesNamed).mockReturnValue({
      data: [{ id: 'emp-x', full_name: 'Test Employee C', name_key: 'test employee c', created_at: '2026-10-01T00:00:00Z' }],
      isLoading: false,
    } as never)
    setup({ employee_id: null })
    const linkButton = screen.getByRole('button', { name: 'Link employee' })
    expect(linkButton).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Create a new employee record/ }))
    await user.click(linkButton)
    expect(createEmployee).toHaveBeenCalledWith('Test Employee C')
    expect(link).toHaveBeenCalledWith('emp-new')
  })
})

function cleanupAndSetup(record: Partial<OnboardingEquipmentRecord>) {
  document.body.innerHTML = ''
  setup(record)
}
