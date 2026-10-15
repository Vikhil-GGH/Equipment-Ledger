import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChecklistListView } from '../../components/ChecklistListView'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { useCreateEmployee, useEmployeesNamed, useRegisterAvailable } from '../register/api'
import { NewEmployeeChoice } from '../register/NewEmployeeChoice'
import { normalizeName } from '../register/registerModel'
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
  const createEmployee = useCreateEmployee()
  const [employeeName, setEmployeeName] = useState('')
  const [employeeChoice, setEmployeeChoice] = useState('')
  const [error, setError] = useState<string | null>(null)
  // With the employee register (20260901000026), every checklist is linked
  // to an employee record; a name that already exists must be confirmed.
  const { data: registerAvailable } = useRegisterAvailable()
  const nameKey = normalizeName(employeeName)
  const { data: sameName } = useEmployeesNamed(registerAvailable && nameKey ? nameKey : null)
  const mustChoose = !!registerAvailable && !!sameName?.length && !employeeChoice

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      let employeeId: string | null = null
      if (registerAvailable) {
        employeeId =
          sameName?.length && employeeChoice !== 'new' ? employeeChoice : await createEmployee.mutateAsync(employeeName.trim())
      }
      const id = await createOnboarding.mutateAsync({ employeeName: employeeName.trim(), createdBy: userId, employeeId })
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
            onChange={(e) => {
              setEmployeeName(e.target.value)
              setEmployeeChoice('')
            }}
            className="input"
          />
        </label>
        {registerAvailable && <NewEmployeeChoice name={employeeName} value={employeeChoice} onChange={setEmployeeChoice} />}
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={createOnboarding.isPending || createEmployee.isPending || mustChoose} className="btn-primary">
            {createOnboarding.isPending ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
