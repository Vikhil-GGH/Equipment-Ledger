import type { ReactNode } from 'react'
import { useAuth } from '../features/auth/useAuth'

/**
 * Minimal authenticated shell for Phase 2 (auth/routing only). The
 * mobile-first nav (slide-out drawer, card layouts) lands in the PWA/
 * mobile-responsive pass (build order step 7) — this just proves the
 * auth + routing skeleton end-to-end for now.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Equipment Ledger
        </span>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span>
            {profile?.email} <span className="text-neutral-400">· {profile?.role}</span>
          </span>
          <button
            onClick={() => void signOut()}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="p-4">{children}</main>
    </div>
  )
}
