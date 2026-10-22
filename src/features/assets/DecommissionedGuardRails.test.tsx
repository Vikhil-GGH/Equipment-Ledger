import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ActionPanel } from './ActionPanel'
import { SwapPanel } from './SwapPanel'
import * as api from './api'
import type { AssetRow } from './api'
import { useAuth } from '../auth/useAuth'
import { getAllowedActions, getStatusHint, isTerminal, needsRefreshConfirmation } from '../../lib/lifecycle'
import type { AssetStatus } from '../../types/database.types'

vi.mock('./api', () => ({
  usePerformLifecycleAction: vi.fn(),
  useSwapCandidates: vi.fn(),
  useSwap: vi.fn(),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))

const perform = vi.fn(async () => 'serialized_assets')
const swap = vi.fn(async () => 'serialized_assets')

const asset = (status: AssetStatus): AssetRow => ({
  id: 'a1', name: 'ThinkPad X1', category: 'Laptop', serial: 'SN-001', status, assigned_to: status === 'provided' ? 'Ana' : null,
  location: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
})

beforeEach(() => {
  perform.mockClear()
  swap.mockClear()
  vi.mocked(useAuth).mockReturnValue({ role: 'editor' } as never)
  vi.mocked(api.usePerformLifecycleAction).mockReturnValue({ mutateAsync: perform, isPending: false } as never)
  vi.mocked(api.useSwap).mockReturnValue({ mutateAsync: swap, isPending: false } as never)
  vi.mocked(api.useSwapCandidates).mockReturnValue({
    isLoading: false,
    data: [
      { id: 'n1', name: 'Dell', serial: 'NEW-1', status: 'available' },
      { id: 'n2', name: 'Dell', serial: 'OLD-2', status: 'decommissioned' },
    ],
  } as never)
})

const panel = (status: AssetStatus) =>
  render(
    <MemoryRouter>
      <ActionPanel collection="serialized_assets" asset={asset(status)} />
    </MemoryRouter>,
  )

describe('Decommissioned: refresh confirmation before reissue', () => {
  it('Provide asks for the confirmation: Confirm stays disabled until it is ticked, then sends refreshConfirmed', async () => {
    const user = userEvent.setup()
    panel('decommissioned')
    await user.click(screen.getByRole('button', { name: 'Provide' }))
    await user.type(screen.getByRole('textbox', { name: /assigned to/i }), 'Ana Ruiz')
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    expect(confirm).toBeDisabled()
    expect(screen.getByText(/refreshed and is fit to use/i)).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox'))
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: 'provide', assignedTo: 'Ana Ruiz', refreshConfirmed: true }))
  })

  it('Retain from Decommissioned needs it too (setting it aside is not a way around the rule)', async () => {
    const user = userEvent.setup()
    panel('decommissioned')
    await user.click(screen.getByRole('button', { name: 'Retain' }))
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: 'retain', refreshConfirmed: true }))
  })

  it('an Available or Retained device is provided exactly as before: no checkbox, nothing extra sent', async () => {
    for (const status of ['available', 'retained'] as const) {
      perform.mockClear()
      const user = userEvent.setup()
      const { unmount } = panel(status)
      await user.click(screen.getByRole('button', { name: 'Provide' }))
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      await user.type(screen.getByRole('textbox', { name: /assigned to/i }), 'Ana Ruiz')
      await user.click(screen.getByRole('button', { name: 'Confirm' }))
      expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: 'provide', refreshConfirmed: undefined }))
      unmount()
    }
  })

  it('a Decommissioned device can be retired for good with Mark non-functional (no confirmation needed)', async () => {
    const user = userEvent.setup()
    panel('decommissioned')
    await user.click(screen.getByRole('button', { name: 'Mark non-functional' }))
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: 'mark_nonfunctional' }))
  })

  it('a Non-functional device offers nothing at all: it cannot be issued again', () => {
    const { container } = panel('nonfunctional')
    expect(container).toBeEmptyDOMElement()
    expect(getAllowedActions('nonfunctional')).toEqual([])
    expect(isTerminal('nonfunctional')).toBe(true)
  })
})

describe('Swap with a Decommissioned replacement', () => {
  const swapPanel = () =>
    render(
      <MemoryRouter>
        <SwapPanel collection="serialized_assets" asset={asset('provided')} onDone={vi.fn()} onCancel={vi.fn()} />
      </MemoryRouter>,
    )

  it('an Available replacement needs no confirmation', async () => {
    const user = userEvent.setup()
    swapPanel()
    await user.selectOptions(screen.getByRole('combobox'), 'n1')
    await user.type(screen.getByPlaceholderText(/screen cracked/i), 'broken screen')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm swap' }))
    expect(swap).toHaveBeenCalledWith(expect.objectContaining({ newAssetId: 'n1', refreshConfirmed: undefined }))
  })

  it('a Decommissioned replacement needs the confirmation first', async () => {
    const user = userEvent.setup()
    swapPanel()
    await user.selectOptions(screen.getByRole('combobox'), 'n2')
    await user.type(screen.getByPlaceholderText(/screen cracked/i), 'broken screen')
    expect(screen.getByRole('button', { name: 'Confirm swap' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Confirm swap' }))
    expect(swap).toHaveBeenCalledWith(expect.objectContaining({ newAssetId: 'n2', refreshConfirmed: true }))
  })
})

describe('lifecycle helpers', () => {
  it('only leaving Decommissioned for stock, the set-aside shelf or a swap needs the confirmation', () => {
    expect(needsRefreshConfirmation('decommissioned', 'provide')).toBe(true)
    expect(needsRefreshConfirmation('decommissioned', 'retain')).toBe(true)
    expect(needsRefreshConfirmation('decommissioned', 'swap')).toBe(true)
    expect(needsRefreshConfirmation('decommissioned', 'mark_damaged')).toBe(false)
    expect(needsRefreshConfirmation('decommissioned', 'mark_nonfunctional')).toBe(false)
    for (const s of ['available', 'retained', 'provided', 'damaged'] as const) expect(needsRefreshConfirmation(s, 'provide')).toBe(false)
  })

  it('statuses say what they mean for reissuing', () => {
    expect(getStatusHint('decommissioned')).toMatch(/refreshed.*confirm/i)
    expect(getStatusHint('nonfunctional')).toMatch(/cannot be issued again/i)
    expect(getStatusHint('available')).toBeNull()
  })
})
