import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './useAuth'
import { MfaChallenge } from './MfaChallenge'
import { SecurityPage } from './SecurityPage'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading, aal } = useAuth()
  const location = useLocation()

  if (loading) {
    return <FullScreenStatus>Loading…</FullScreenStatus>
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  // The account has two-factor set up: the code is needed before anything else.
  if (aal?.next === 'aal2' && aal.current !== 'aal2') {
    return <MfaChallenge />
  }

  if (!profile) {
    // Session exists but no profile row yet resolved (or the account has no
    // role assigned) — never fall back to a default role here; block instead.
    return (
      <FullScreenStatus>
        Your account isn't fully set up yet. Ask an admin to check your access.
      </FullScreenStatus>
    )
  }

  // 20260901000031: an admin has no access at all without a two-factor
  // session. Not enrolled yet (or the level is unknown): set it up first —
  // the Security page is all the database lets them use.
  if (profile.role === 'admin' && aal?.current !== 'aal2') {
    return <AdminTwoFactorSetup />
  }

  return <>{children}</>
}

function AdminTwoFactorSetup() {
  const { signOut } = useAuth()
  return (
    <div className="min-h-screen px-6 py-10">
      <div className="mx-auto mb-4 max-w-xl space-y-2">
        <p className="text-sm text-neutral-700 dark:text-neutral-300" role="status">
          Admin accounts need two-factor authentication before they can see or change anything. Set it up below — it takes a minute.
        </p>
        <button type="button" className="btn-secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <SecurityPage />
    </div>
  )
}

function FullScreenStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-neutral-500">
      {children}
    </div>
  )
}
