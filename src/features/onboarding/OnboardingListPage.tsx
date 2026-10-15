import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChecklistListView } from '../../components/ChecklistListView'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { useCreateOnboarding, useOnboardingList } from './api'
import { onboardingProgress } from './onboardingProgress'

export function OnboardingListPage() {
  const { role, user } = useAuth()
  const [search, setSearch] = useState('')
  const [showStart, setShowStart] = useState(false)
  const { data: records, isLoading, error } = useOnboardingList(search)
  const canStart = role === 'admin' || role === 'editor'

  return (
    <>
      <ChecklistListView
        title="Onboarding"
        records={records}
        isLoading={isLoading}
        error={error}
        search={search}
        onSearchChange={setSearch}
        progress={onboardingProgress}
        detailPath={(id) => `/onboarding/${id}`}
        progressLabel="onboarding progress"
        emptyMessage="No onboarding records yet."
        startAction={
          canStart && (
            <button className="btn-primary whitespace-nowrap" onClick={() => setShowStart(true)}>
              Start onboarding
            </button>
          )
        }
      />
      {showStart && user && (
        <StartOnboardingModal userId={user.id} onClose={() => setShowStart(false)} />
      )}
    </>
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
