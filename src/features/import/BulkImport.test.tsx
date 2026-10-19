import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ImportWizard } from './ImportWizard'
import * as api from './api'
import { parseExcelFile } from '../../lib/excel'

vi.mock('../../lib/excel', async (orig) => ({ ...(await orig<typeof import('../../lib/excel')>()), parseExcelFile: vi.fn() }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  useExistingSerials: () => ({ data: new Set() }),
  useExistingBulkItemKeys: () => ({ data: new Set(['wireless mouse|||accessory']) }),
  useCommitAssetImport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCommitBulkImport: vi.fn(),
}))

const commit = vi.fn()
beforeEach(() => {
  commit.mockReset()
  vi.mocked(api.useCommitBulkImport).mockReturnValue({ mutateAsync: commit, isPending: false } as never)
})

async function preview(rows: Record<string, unknown>[]) {
  vi.mocked(parseExcelFile).mockResolvedValue([{ sheetName: 'Stock', headers: ['Name', 'Category', 'Location', 'Quantity'], rows }])
  const user = userEvent.setup()
  render(
    <MemoryRouter>
      <ImportWizard target="bulk_items" />
    </MemoryRouter>,
  )
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, new File(['x'], 'delivery.xlsx'))
  for (const f of ['Name', 'Category', 'Location', 'Quantity']) await user.selectOptions(screen.getByRole('combobox', { name: new RegExp(`^${f === 'Quantity' ? 'Quantity received' : f}`) }), f)
  await user.click(screen.getByRole('button', { name: 'Preview' }))
  return user
}

describe('3: Bulk Stock import — deliveries, never counted twice', () => {
  it('explains that quantities are deliveries, recognises existing items with any spacing/case, and flags an item listed twice', async () => {
    await preview([
      { Name: ' Wireless  MOUSE ', Category: 'accessory', Location: '', Quantity: 10 },
      { Name: 'Webcam', Category: 'Accessory', Location: '', Quantity: 8 },
      { Name: 'webcam', Category: 'ACCESSORY', Location: '', Quantity: 2 },
    ])
    expect(screen.getByText(/Each row is a delivery: its Quantity received is added to Available\. It is not the stock total/)).toBeInTheDocument()
    expect(screen.getByText('Same item as row 3 — combine them into one row')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit 2 rows' })).toBeEnabled()
    expect(screen.getAllByText('Update')).toHaveLength(1) // the mouse already exists
  })

  it('the same delivery again: nothing is added, and adding it again needs a deliberate confirmation', async () => {
    commit
      .mockResolvedValueOnce({ created: 0, updated: 0, unchanged: 0, duplicate_of: { filename: 'delivery.xlsx', imported_at: '2026-10-19T10:00:00Z', imported_by: 'admin@example.invalid' } })
      .mockResolvedValueOnce({ created: 0, updated: 1, unchanged: 0, repeat_of: 'r1' })
    const user = await preview([{ Name: 'Wireless Mouse', Category: 'Accessory', Location: '', Quantity: 10 }])
    await user.click(screen.getByRole('button', { name: 'Commit 1 row' }))
    expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ confirmRepeat: false }))
    const box = await screen.findByRole('region', { name: 'Already imported' })
    expect(box).toHaveTextContent('Nothing was added')
    expect(box).toHaveTextContent('same items and quantities as delivery.xlsx')
    expect(box).toHaveTextContent('Bulk Stock is unchanged')
    const again = screen.getByRole('button', { name: 'Add as a new delivery' })
    expect(again).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /this is a new delivery/ }))
    await user.click(again)
    expect(commit).toHaveBeenLastCalledWith(expect.objectContaining({ confirmRepeat: true }))
    expect(await screen.findByText(/0 created, 1 updated/)).toBeInTheDocument()
  })
})
