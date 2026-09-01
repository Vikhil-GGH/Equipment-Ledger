import { useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../features/auth/useAuth'
import { Drawer } from './Drawer'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/scan', label: 'Scan' },
  { to: '/serialized-assets', label: 'Serialized Assets' },
  { to: '/active-laptops-np', label: 'Active Laptops (NP)' },
  { to: '/bulk-stock', label: 'Bulk Stock' },
  { to: '/onboarding', label: 'Onboarding' },
  { to: '/offboarding', label: 'Offboarding' },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { profile, role, signOut } = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const navItems = role === 'admin' ? [...NAV_ITEMS, { to: '/admin', label: 'Admin' }] : NAV_ITEMS

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive
      ? 'font-medium text-neutral-900 dark:text-neutral-100'
      : 'text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center gap-6">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="-ml-1 rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 sm:hidden dark:hover:bg-neutral-800"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Equipment Ledger
          </span>
          <nav className="hidden flex-wrap gap-4 text-sm sm:flex">
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={navLinkClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span className="hidden sm:inline">
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

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div className="mb-4 border-b border-neutral-100 pb-3 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {profile?.email}
          </p>
          <p className="text-xs text-neutral-500">{profile?.role}</p>
        </div>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            onClick={() => setDrawerOpen(false)}
            className={({ isActive }) =>
              `rounded-md px-3 py-2 text-sm ${
                isActive
                  ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                  : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800/50'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </Drawer>

      <main className="p-4 pb-24 sm:pb-4">{children}</main>

      {location.pathname !== '/scan' && (
        <Link
          to="/scan"
          aria-label="Scan a barcode"
          className="fixed bottom-6 right-6 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg transition hover:bg-emerald-700 sm:hidden"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path
              d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2M7 12h10"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      )}
    </div>
  )
}
