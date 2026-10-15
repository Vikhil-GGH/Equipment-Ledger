import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChecklistListView } from '../../components/ChecklistListView'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { OFFBOARDING_STEPS, useCreateOffboarding, useOffboardingList } from './api'

export function OffboardingListPage() {
  const { role, user } = useAuth()
  const [search, setSearch] = useState('')
  const [showStart, setShowStart] = useState(false)
  const { data: records, isLoading, error } = useOffboardingList(search)
  const canStart = role === 'admin' || role === 'editor'

  // Same table as Onboarding. Ticking checklist steps here only tracks the
  // paperwork — it never collects equipment (that stays an explicit action
  // on each asset, from the employee's checklist page).
  return (
    <>
      <ChecklistListView
        title="Offboarding"
        records={records}
        isLoading={isLoading}
        error={error}
        search={search}
        onSearchChange={setSearch}
        steps={OFFBOARDING_STEPS}
        detailPath={(id) => `/offboarding/${id}`}
        progressLabel="offboarding progress"
        emptyMessage="No offboarding records yet."
        startAction={
          canStart && (
            <button className="btn-primary whitespace-nowrap" onClick={() => setShowStart(true)}>
              Start offboarding
            </button>
          )
        }
      />
      {showStart && user && (
        <StartOffboardingModal userId={user.id} onClose={() => setShowStart(false)} />
      )}
    </>
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
