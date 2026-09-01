import { useState } from 'react'
import { getErrorMessage } from '../../lib/errors'
import type { UserRole } from '../../types/database.types'
import { useAuth } from '../auth/useAuth'
import { useRemoveUser, useUpdateUserRole, useUsersList, type ProfileRow } from './api'

const ROLES: UserRole[] = ['admin', 'editor', 'viewer', 'scanner']

export function AdminPage() {
  const { user } = useAuth()
  const { data: users, isLoading, error } = useUsersList()

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Admin — Users &amp; Roles
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          To add a new person, create their login in the{' '}
          <span className="font-medium">Supabase dashboard</span> (Authentication → Users → Add
          user, with "Auto Confirm User" checked), then set their role here — they'll default to
          Viewer until you do.
        </p>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : 'Failed to load users'}
        </p>
      )}

      <div className="space-y-3">
        {users?.map((row) => (
          <UserRow key={row.id} row={row} isSelf={row.id === user?.id} />
        ))}
      </div>
    </div>
  )
}

function UserRow({ row, isSelf }: { row: ProfileRow; isSelf: boolean }) {
  const updateRole = useUpdateUserRole()
  const removeUser = useRemoveUser()
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRoleChange(role: UserRole) {
    setError(null)
    try {
      await updateRole.mutateAsync({ userId: row.id, role })
    } catch (err) {
      console.error('update role failed:', err)
      setError(getErrorMessage(err, 'Failed to update role'))
    }
  }

  async function handleRemove() {
    setError(null)
    try {
      await removeUser.mutateAsync(row.id)
    } catch (err) {
      console.error('remove user failed:', err)
      setError(getErrorMessage(err, 'Failed to remove user'))
    }
  }

  return (
    <div className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium text-neutral-900 dark:text-neutral-100">
          {row.full_name ?? row.email}
          {isSelf && <span className="ml-2 text-xs text-neutral-400">(you)</span>}
        </p>
        <p className="text-xs text-neutral-500">{row.email}</p>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={row.role}
          disabled={isSelf || updateRole.isPending}
          onChange={(e) => void handleRoleChange(e.target.value as UserRole)}
          className="input w-auto"
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>

        {confirmingRemove ? (
          <div className="flex items-center gap-1">
            <button
              className="rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              disabled={removeUser.isPending}
              onClick={() => void handleRemove()}
            >
              {removeUser.isPending ? 'Removing…' : 'Confirm remove'}
            </button>
            <button className="btn-secondary text-xs" onClick={() => setConfirmingRemove(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="btn-secondary text-xs"
            disabled={isSelf}
            onClick={() => setConfirmingRemove(true)}
          >
            Remove access
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
