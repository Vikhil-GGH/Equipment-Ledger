import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getErrorMessage } from '../../lib/errors'
import type { UserRole } from '../../types/database.types'
import { useAuth } from '../auth/useAuth'
import { useRemoveUser, useSerialDuplicates, useUpdateUserRole, useUsersList, type ProfileRow } from './api'
import { usePossibleDuplicates, useRegisterAvailable } from '../register/api'

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

      <PossibleDuplicateEmployees />
      <SerialDuplicates />
    </div>
  )
}

/** Read-only review list (employee register, 20260901000026). Nothing is merged automatically. */
function PossibleDuplicateEmployees() {
  const { data: available } = useRegisterAvailable()
  const { data: pairs } = usePossibleDuplicates(!!available)
  if (!available) return null
  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Possible duplicate employees</h2>
      <p className="mb-2 text-xs text-neutral-500">For review only — nothing here is merged automatically.</p>
      {!pairs?.length ? (
        <p className="text-sm text-neutral-500">None found.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {pairs.map((p) => (
            <li key={`${p.employee_id}-${p.other_employee_id}`}>
              <span className="font-medium">{p.full_name}</span> and <span className="font-medium">{p.other_full_name}</span>{' '}
              <span className="text-xs text-neutral-500">— {p.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const DEVICE_PATH = {
  serialized_assets: '/serialized-assets',
  active_laptops_np: '/active-laptops-np',
  monitors: '/monitors',
  other_equipment: '/other-equipment',
} as const
const COLLECTION_LABEL = {
  serialized_assets: 'Laptop Inventory',
  active_laptops_np: 'Active Laptops',
  monitors: 'Monitors',
  other_equipment: 'Other Equipment',
} as const

/** Read-only review list (20260901000027). Nothing is merged or deleted automatically. */
function SerialDuplicates() {
  const { data: rows } = useSerialDuplicates()
  if (rows === null || rows === undefined) return null
  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Devices sharing a serial number</h2>
      <p className="mb-2 text-xs text-neutral-500">
        Recorded before serial numbers were checked. For review only — they keep working, nothing is merged or deleted,
        and no new device can take these serials.
      </p>
      {!rows.length ? (
        <p className="text-sm text-neutral-500">None found.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.asset_id}>
              <Link className="font-mono underline" to={`${DEVICE_PATH[r.collection]}/${r.asset_id}`}>
                {r.serial.trim() ? JSON.stringify(r.serial) : '(blank)'}
              </Link>{' '}
              <span className="text-xs text-neutral-500">
                — {COLLECTION_LABEL[r.collection]}, {r.status}
                {r.assigned_to ? `, ${r.assigned_to}` : ''} · {r.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
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
