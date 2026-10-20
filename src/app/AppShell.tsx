import { useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../features/auth/useAuth'
import { Drawer } from './Drawer'

interface NavItem {
  to: string
  label: string
}

interface NavGroup {
  heading: string
  items: NavItem[]
}

const WORKSPACE_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview' },
  { to: '/scan', label: 'Scan' },
  { to: '/laptops', label: 'Laptop Inventory' },
  { to: '/onboarding', label: 'Onboarding' },
  { to: '/offboarding', label: 'Offboarding' },
  { to: '/employees', label: 'Active Employees' },
  { to: '/monitors', label: 'Monitors' },
  { to: '/other-equipment', label: 'Other Equipment' },
  { to: '/bulk-stock', label: 'Bulk Stock' },
]

function useNavGroups(): NavGroup[] {
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const isAdminOrEditor = role === 'admin' || role === 'editor'

  const groups: NavGroup[] = [{ heading: 'Workspace', items: WORKSPACE_ITEMS }]

  const adminItems: NavItem[] = []
  if (isAdmin) adminItems.push({ to: '/admin', label: 'Access & Roles' })
  if (isAdminOrEditor) adminItems.push({ to: '/import-history', label: 'Import History' })
  if (adminItems.length > 0) groups.push({ heading: 'Administration', items: adminItems })

  if (isAdmin) {
    groups.push({
      heading: 'Data',
      items: [
        { to: '/data', label: 'Export backup' },
        { to: '/data', label: 'Import backup' },
      ],
    })
  }

  return groups
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-1.5 text-sm transition ${
    isActive
      ? 'bg-teal-500/15 font-medium text-teal-300'
      : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-100'
  }`

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500 text-white">
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          <path
            d="M12 3a9 9 0 1 0 9 9"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path d="M12 8a4 4 0 1 0 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-white">GroundGame Health</p>
        <p className="text-xs text-neutral-400">Equipment Ledger</p>
      </div>
    </div>
  )
}

function NavGroups({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.heading}>
          <p className="mb-1.5 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            {group.heading}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.to === '/'}
                onClick={onNavigate}
                className={navLinkClass}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}

/** Admin powers need a two-factor session (20260901000030). */
function AdminMfaBanner() {
  const { role, aal } = useAuth()
  if (role !== 'admin' || !aal || aal.current === 'aal2') return null
  return (
    <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
      Admin actions (roles, access, restores) need two-factor authentication.{' '}
      <NavLink to="/account/security" className="font-medium underline">
        {aal.next === 'aal2' ? 'Verify this session' : 'Set it up'}
      </NavLink>
    </div>
  )
}

function SidebarFooter() {
  const { profile, signOut, aal } = useAuth()
  return (
    <div className="border-t border-white/10 px-3 py-3">
      <p className="truncate text-xs text-neutral-300">{profile?.email}</p>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-neutral-500">
          {profile?.role}
          {aal?.current === 'aal2' && <span title="Signed in with two-factor authentication"> · 2FA</span>}
        </span>
        <NavLink to="/account/security" className="text-xs font-medium text-neutral-400 hover:text-neutral-100">
          Security
        </NavLink>
        <button
          onClick={() => void signOut()}
          className="text-xs font-medium text-neutral-400 hover:text-neutral-100"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()
  const groups = useNavGroups()

  return (
    <div className="min-h-screen sm:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col justify-between bg-neutral-950 sm:flex">
        <div className="flex flex-col gap-6 overflow-y-auto px-3 py-4">
          <Brand />
          <NavGroups groups={groups} />
        </div>
        <SidebarFooter />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-stone-100 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900 sm:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="-ml-1 rounded-md p-1.5 text-neutral-500 hover:bg-stone-100 dark:hover:bg-neutral-800"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-teal-700 dark:text-teal-400">
            Equipment Ledger
          </span>
        </header>

        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
          <div className="flex h-full flex-col justify-between gap-6 overflow-y-auto bg-neutral-950 px-3 py-4">
            <div className="flex flex-col gap-6">
              <Brand />
              <NavGroups groups={groups} onNavigate={() => setDrawerOpen(false)} />
            </div>
            <SidebarFooter />
          </div>
        </Drawer>

        <main className="flex-1 p-4 pb-24 sm:pb-4">
          <AdminMfaBanner />
          {children}
        </main>

        {location.pathname !== '/scan' && (
          <Link
            to="/scan"
            aria-label="Scan a barcode"
            className="fixed bottom-6 right-6 flex h-14 w-14 items-center justify-center rounded-full bg-teal-600 text-white shadow-lg transition hover:bg-teal-700 sm:hidden"
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
    </div>
  )
}
