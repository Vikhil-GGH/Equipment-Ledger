import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ImportIssues } from './ImportWizard'
import type { AssetImportIssue } from './api'

const issues: AssetImportIssue[] = [
  { row: 1, serial: 'SYN-NP-002', kind: 'not_applied', field: 'status', current: 'provided', requested: 'available',
    collection: 'active_laptops_np', asset_id: 'a1', reason: 'Status changes need a lifecycle action on the device — not applied' },
  { row: 1, serial: 'SYN-NP-002', kind: 'not_applied', field: 'assigned_to', current: 'Test Employee 07', requested: 'Someone Else',
    collection: 'active_laptops_np', asset_id: 'a1', reason: 'Assignment changes need Provide / Transfer / Collect on the device — not applied' },
  { row: 2, serial: 'SYN-INV-203', kind: 'rejected', reason: "A new device can't be imported as assigned, Provided, Retained or Lost" },
]

describe('import result report', () => {
  it('lists differences that were not applied, with links to the device, and skipped rows — by spreadsheet row', () => {
    // Committed rows 1 and 2 were spreadsheet rows 3 and 7 (others failed the preview).
    render(
      <MemoryRouter>
        <ImportIssues issues={issues} sheetRows={[3, 7]} />
      </MemoryRouter>,
    )
    const notApplied = screen.getByRole('region', { name: /Not applied — 2 status or assignment differences/ })
    expect(within(notApplied).getByText(/Imports never change status or assignment/)).toBeInTheDocument()
    const items = within(notApplied).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Row 3 SYN-NP-002: status is "provided", sheet says "available"')
    expect(items[1]).toHaveTextContent('assigned to is "Test Employee 07", sheet says "Someone Else"')
    expect(within(items[0]).getByRole('link', { name: 'SYN-NP-002' })).toHaveAttribute('href', '/active-laptops-np/a1')

    const skipped = screen.getByRole('region', { name: 'Skipped — 1 row' })
    expect(within(skipped).getByRole('listitem')).toHaveTextContent("Row 7 SYN-INV-203: A new device can't be imported as assigned")
  })
})
