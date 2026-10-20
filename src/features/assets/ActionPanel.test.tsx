import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActionPanel } from './ActionPanel'
import type { AssetRow } from './api'
import { useAuth } from '../auth/useAuth'
import type { AssetStatus, UserRole } from '../../types/database.types'

// Mocked below `./api` and `../auth/useAuth` so this never touches the
// real Supabase client (which throws at import time without env vars) —
// this is a pure rendering/interaction test of the lifecycle UI, not an
// integration test against a live backend. vitest hoists vi.mock calls
// above these imports, so `useAuth` above is already the mock.
vi.mock('./api', () => ({
  usePerformLifecycleAction: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useSwapCandidates: vi.fn(() => ({ data: [], isLoading: false })),
  useSwap: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))
vi.mock('../auth/useAuth', () => ({ useAuth: vi.fn() }))

function mockRole(role: UserRole) {
  vi.mocked(useAuth).mockReturnValue({
    session: null,
    user: null,
    profile: null,
    role,
    loading: false,
    isPasswordRecovery: false,
    clearPasswordRecovery: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    aal: null,
    refreshAal: vi.fn(),
  })
}

function makeAsset(status: AssetStatus): AssetRow {
  return {
    id: 'asset-1',
    name: 'ThinkPad X1',
    category: 'Laptop',
    serial: 'SN-001',
    status,
    assigned_to: null,
    location: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function renderPanel(status: AssetStatus) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ActionPanel collection="serialized_assets" asset={makeAsset(status)} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('ActionPanel role gating', () => {
  it('renders nothing for a viewer, regardless of status', () => {
    mockRole('viewer')
    const { container } = renderPanel('provided')
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a terminal (nonfunctional) asset even as admin', () => {
    mockRole('admin')
    const { container } = renderPanel('nonfunctional')
    expect(container).toBeEmptyDOMElement()
  })

  it('shows exactly the allowed actions for an editor on an available asset', () => {
    mockRole('editor')
    renderPanel('available')
    expect(screen.getByRole('button', { name: 'Provide' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retain' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark damaged' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Collect' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument()
  })

  it('shows the Swap button for an admin on a provided asset', () => {
    mockRole('admin')
    renderPanel('provided')
    expect(screen.getByRole('button', { name: 'Swap' })).toBeInTheDocument()
  })

  it('narrows a scanner to only Provide/Collect, and hides Swap entirely', () => {
    mockRole('scanner')
    renderPanel('provided')
    // 'provided' normally allows collect/transfer/mark_damaged/decommission;
    // a scanner should see only the collect subset of that.
    expect(screen.getByRole('button', { name: 'Collect' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark damaged' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Decommission (employee left)' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Swap' })).not.toBeInTheDocument()
  })

  it('renders nothing for a scanner when the status has no provide/collect action', () => {
    mockRole('scanner')
    const { container } = renderPanel('damaged')
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ActionPanel confirm form', () => {
  it('requires an assignee before Provide can be confirmed', async () => {
    mockRole('editor')
    renderPanel('available')
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Provide' }))

    const confirmButton = screen.getByRole('button', { name: 'Confirm' })
    expect(confirmButton).toBeDisabled()

    await user.type(screen.getByLabelText('Assigned to'), 'Jane Doe')
    expect(confirmButton).toBeEnabled()
  })

  it('does not ask for an assignee on an action that does not need one', async () => {
    mockRole('editor')
    renderPanel('available')
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Retain' }))

    expect(screen.queryByLabelText('Assigned to')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  })
})
