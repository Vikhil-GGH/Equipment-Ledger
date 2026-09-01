import type { ReactNode } from 'react'
import type { UserRole } from '../../types/database.types'
import { useAuth } from './useAuth'

/**
 * Client-side route gating for UX only — hides pages the role shouldn't
 * navigate to. It is NOT the security boundary; every table's RLS policy
 * is what actually enforces access if this is ever bypassed.
 */
export function RequireRole({
  allow,
  children,
  fallback,
}: {
  allow: UserRole[]
  children: ReactNode
  fallback?: ReactNode
}) {
  const { role } = useAuth()

  if (!role || !allow.includes(role)) {
    return (
      fallback ?? (
        <div className="flex min-h-[50vh] items-center justify-center px-6 text-center text-sm text-neutral-500">
          You don't have access to this page.
        </div>
      )
    )
  }

  return <>{children}</>
}
