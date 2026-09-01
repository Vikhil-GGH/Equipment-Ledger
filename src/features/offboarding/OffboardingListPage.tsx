import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { useCreateOffboarding, useOffboardingList } from './api'

export function OffboardingListPage() {
  const { role, user } = useAuth()
  const [search, setSearch] = useState('')
  const [showStart, setShowStart] = useState(false)
  const { data: records, isLoading } = useOffboardingList(search)
  const canStart = role === 'admin' || role === 'editor'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Offboarding
        </h1>
        <div className="flex gap-2">
          <input
            placeholder="Search employee…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input sm:w-64"
          />
          {canStart && (
            <button className="btn-primary whitespace-nowrap" onClick={() => setShowStart(true)}>
              Start offboarding
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {!isLoading && records?.length === 0 && (
        <p className="text-sm text-neutral-500">No offboarding records yet.</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {records?.map((record) => {
          const stepsDone = [
            record.removed_access,
            record.laptop_received,
            record.laptop_retained,
            record.laptop_decommissioned,
          ].filter(Boolean).length
          return (
            <Link key={record.id} to={`/offboarding/${record.id}`} className="card block">
              <div className="flex items-center justify-between">
                <p className="font-medium text-neutral-900 dark:text-neutral-100">
                  {record.employee_name}
                </p>
                <span className="text-xs text-neutral-500">{stepsDone}/4 steps</span>
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Started {new Date(record.created_at).toLocaleDateString()}
              </p>
            </Link>
          )
        })}
      </div>

      {showStart && user && (
        <StartOffboardingModal userId={user.id} onClose={() => setShowStart(false)} />
      )}
    </div>
  )
}

function StartOffboardingModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const createOffboarding = useCreateOffboarding()
  const [employeeName, setEmployeeName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const id = await createOffboarding.mutateAsync({ employeeName, createdBy: userId })
      onClose()
      navigate(`/offboarding/${id}`)
    } catch (err) {
      console.error('create offboarding failed:', err)
      setError(getErrorMessage(err, 'Failed to start offboarding'))
    }
  }

  return (
    <Modal title="Start offboarding" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
            Employee name
          </span>
          <input
            required
            autoFocus
            value={employeeName}
            onChange={(e) => setEmployeeName(e.target.value)}
            className="input"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={createOffboarding.isPending} className="btn-primary">
            {createOffboarding.isPending ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
