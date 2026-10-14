import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './AuthProvider'
import { RequireAuth } from './RequireAuth'
import { supabase } from '../../lib/supabase'

// The real client throws at import time without env vars, and this test
// must never reach a live backend — mock exactly the auth calls used.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      signInAnonymously: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(),
  },
}))

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<p>Login page</p>} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <p>Ledger data</p>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('AuthProvider without a session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>)
  })

  it('never creates an anonymous session', async () => {
    renderApp()
    await screen.findByText('Login page')
    expect(supabase.auth.signInAnonymously).not.toHaveBeenCalled()
  })

  it('sends the visitor to the login page instead of the app', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByText('Login page')).toBeInTheDocument())
    expect(screen.queryByText('Ledger data')).not.toBeInTheDocument()
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
