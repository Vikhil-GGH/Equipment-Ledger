import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RequireAuth } from './RequireAuth'
import { SecurityPage } from './SecurityPage'
import { AppShell } from '../../app/AppShell'
import { useAuth } from './useAuth'
import { supabase } from '../../lib/supabase'
import { useUpdateUserRole } from '../admin/api'

vi.mock('./useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { mfa: { listFactors: vi.fn(), challengeAndVerify: vi.fn(), enroll: vi.fn(), unenroll: vi.fn() } },
    from: vi.fn(),
  },
}))

const mfa = supabase.auth.mfa as unknown as Record<string, ReturnType<typeof vi.fn>>
const refreshAal = vi.fn()
function auth(over: Record<string, unknown>) {
  vi.mocked(useAuth).mockReturnValue({
    session: { user: { id: 'u' } },
    user: { id: 'u' },
    profile: { id: 'u', email: 'a@example.invalid', full_name: null, role: 'admin' },
    role: 'admin',
    loading: false,
    signOut: vi.fn(),
    refreshAal,
    aal: { current: 'aal1', next: 'aal1' },
    ...over,
  } as never)
}
beforeEach(() => {
  Object.values(mfa).forEach((f) => f.mockReset())
  refreshAal.mockReset()
})

describe('two-factor authentication', () => {
  it('after the password, an account with a verified authenticator must enter the code before seeing anything', async () => {
    auth({ aal: { current: 'aal1', next: 'aal2' } })
    mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f1', status: 'verified' }] }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    const user = userEvent.setup()
    render(<MemoryRouter><RequireAuth><p>Ledger data</p></RequireAuth></MemoryRouter>)
    expect(screen.queryByText('Ledger data')).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Authentication code' }), '12a3456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '123456' })
    await waitFor(() => expect(refreshAal).toHaveBeenCalled())
  })

  it('a wrong code is reported and nothing opens', async () => {
    auth({ aal: { current: 'aal1', next: 'aal2' } })
    mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'f1', status: 'verified' }] }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: null, error: { message: 'Invalid TOTP code entered' } })
    const user = userEvent.setup()
    render(<MemoryRouter><RequireAuth><p>Ledger data</p></RequireAuth></MemoryRouter>)
    await user.type(screen.getByRole('textbox', { name: 'Authentication code' }), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid TOTP code entered')
    expect(refreshAal).not.toHaveBeenCalled()
    expect(screen.queryByText('Ledger data')).not.toBeInTheDocument()
  })

  it('accounts without two-factor go straight in; verified sessions too', () => {
    auth({ aal: { current: 'aal1', next: 'aal1' } })
    const { unmount } = render(<MemoryRouter><RequireAuth><p>Ledger data</p></RequireAuth></MemoryRouter>)
    expect(screen.getByText('Ledger data')).toBeInTheDocument()
    unmount()
    auth({ aal: { current: 'aal2', next: 'aal2' } })
    render(<MemoryRouter><RequireAuth><p>Ledger data</p></RequireAuth></MemoryRouter>)
    expect(screen.getByText('Ledger data')).toBeInTheDocument()
  })

  it('Security page: set up an authenticator — scan, enter the code, turned on', async () => {
    auth({})
    mfa.listFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null }).mockResolvedValue({ data: { totp: [{ id: 'f9', status: 'verified', created_at: '' }] }, error: null })
    mfa.enroll.mockResolvedValue({ data: { id: 'f9', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'ABCDEF123' } }, error: null })
    mfa.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    const user = userEvent.setup()
    render(<MemoryRouter><SecurityPage /></MemoryRouter>)
    expect(await screen.findByText(/Off\. Use an authenticator app/)).toHaveTextContent('Admin actions — roles, access, restores — need it.')
    await user.click(screen.getByRole('button', { name: 'Set up two-factor authentication' }))
    expect(mfa.enroll).toHaveBeenCalledWith(expect.objectContaining({ factorType: 'totp' }))
    expect(screen.getByRole('img', { name: 'QR code for your authenticator app' })).toHaveAttribute('src', 'data:image/svg+xml;utf-8,<svg/>')
    expect(screen.getByLabelText('Setup key')).toHaveTextContent('ABCDEF123')
    await user.type(screen.getByRole('textbox', { name: 'Authentication code' }), '654321')
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f9', code: '654321' })
    expect(await screen.findByRole('status')).toHaveTextContent('Two-factor authentication is on')
    expect(refreshAal).toHaveBeenCalled()
  })

  it('admins without a two-factor session see a banner; verified admins and other roles do not', () => {
    auth({ role: 'admin', aal: { current: 'aal1', next: 'aal1' } })
    const { unmount } = render(<MemoryRouter><AppShell><p>page</p></AppShell></MemoryRouter>)
    expect(screen.getByText(/Admin actions \(roles, access, restores\) need two-factor authentication/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set it up' })).toHaveAttribute('href', '/account/security')
    unmount()
    auth({ role: 'admin', aal: { current: 'aal2', next: 'aal2' } })
    const second = render(<MemoryRouter><AppShell><p>page</p></AppShell></MemoryRouter>)
    expect(screen.queryByText(/need two-factor authentication/)).not.toBeInTheDocument()
    second.unmount()
    auth({ role: 'editor', aal: { current: 'aal1', next: 'aal1' } })
    render(<MemoryRouter><AppShell><p>page</p></AppShell></MemoryRouter>)
    expect(screen.queryByText(/need two-factor authentication/)).not.toBeInTheDocument()
  })
})

describe('role changes report when nothing changed (e.g. no two-factor session)', () => {
  it('throws a clear error when the update matched no row', async () => {
    const select = vi.fn().mockResolvedValue({ data: [], error: null })
    vi.mocked(supabase.from).mockReturnValue({ update: () => ({ eq: () => ({ select }) }) } as never)
    let mutate!: (v: { userId: string; role: 'viewer' }) => Promise<void>
    function Probe() {
      mutate = useUpdateUserRole().mutateAsync
      return null
    }
    render(<QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>)
    await expect(mutate({ userId: 'u2', role: 'viewer' })).rejects.toThrow(/admin changes need an admin signed in with two-factor authentication/)
  })
})
