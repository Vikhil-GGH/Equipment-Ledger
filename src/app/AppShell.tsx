import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../features/auth/useAuth'

/**
 * Minimal authenticated shell with plain top nav for now. The mobile-first
 * pattern (slide-out drawer, card layouts) lands in the PWA/mobile pass
 * (build order step 7) — this proves routing end-to-end in the meantime.
 */
const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/serialized-assets', label: 'Serialized Assets' },
  { to: '/active-laptops-np', label: 'Active Laptops (NP)' },
  { to: '/bulk-stock', label: 'Bulk Stock' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex flex-col gap-2 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Equipment Ledger
          </span>
          <nav className="flex gap-4 text-sm">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  isActive
                    ? 'font-medium text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
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
