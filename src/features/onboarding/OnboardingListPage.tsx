import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { useCreateOnboarding, useOnboardingList } from './api'

export function OnboardingListPage() {
  const { role, user } = useAuth()
  const [search, setSearch] = useState('')
  const [showStart, setShowStart] = useState(false)
  const { data: records, isLoading } = useOnboardingList(search)
  const canStart = role === 'admin' || role === 'editor'

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          Onboarding
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
              Start onboarding
            </button>
          )}
        </div>
      </div>

      {isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
      {!isLoading && records?.length === 0 && (
        <p className="text-sm text-neutral-500">No onboarding records yet.</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {records?.map((record) => {
          const stepsDone = [
            record.identity_created,
            record.equipment_assigned,
            record.required_access_provided,
            record.onboarding_successful,
          ].filter(Boolean).length
          return (
            <Link key={record.id} to={`/onboarding/${record.id}`} className="card block">
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
        <StartOnboardingModal userId={user.id} onClose={() => setShowStart(false)} />
      )}
    </div>
  )
}

function StartOnboardingModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const navigate = useNavigate()
  const createOnboarding = useCreateOnboarding()
  const [employeeName, setEmployeeName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const id = await createOnboarding.mutateAsync({ employeeName, createdBy: userId })
      onClose()
      navigate(`/onboarding/${id}`)
    } catch (err) {
      console.error('create onboarding failed:', err)
      setError(getErrorMessage(err, 'Failed to start onboarding'))
    }
  }

  return (
    <Modal title="Start onboarding" onClose={onClose}>
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
          <button type="submit" disabled={createOnboarding.isPending} className="btn-primary">
            {createOnboarding.isPending ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
