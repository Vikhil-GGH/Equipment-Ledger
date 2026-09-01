import { useAuth } from '../features/auth/useAuth'

export function DashboardPage() {
  const { profile } = useAuth()

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
      <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        Welcome, {profile?.full_name ?? profile?.email}
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        Signed in as <span className="font-medium">{profile?.role}</span>. Ledger views,
        Bulk Stock, and the admin panel land in the next build phases.
      </p>
    </div>
  )
}
