import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChecklistListView } from '../../components/ChecklistListView'
import { Modal } from '../../components/Modal'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from '../auth/useAuth'
import { useCreateEmployee, useEmployeesNamed, useRegisterAvailable } from '../register/api'
import { NewEmployeeChoice } from '../register/NewEmployeeChoice'
import { normalizeName } from '../register/registerModel'
import { useCreateOffboarding, useOffboardingList } from './api'
import { offboardingFlag, offboardingProgress } from './offboardingProgress'

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
        progress={offboardingProgress}
        flag={offboardingFlag}
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
      const id = await createOffboarding.mutateAsync({ employeeName: employeeName.trim(), createdBy: userId, employeeId })
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
          <button type="submit" disabled={createOffboarding.isPending || createEmployee.isPending || mustChoose} className="btn-primary">
            {createOffboarding.isPending ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
