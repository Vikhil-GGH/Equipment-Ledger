import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './useAuth'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return <FullScreenStatus>Loading…</FullScreenStatus>
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
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

  return <>{children}</>
}

function FullScreenStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-neutral-500">
      {children}
    </div>
  )
}
