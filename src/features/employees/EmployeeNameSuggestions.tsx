import { useDirectoryAvailable, useEmployeeDirectory } from './api'

/**
 * Name suggestions from the employee directory for the Start onboarding /
 * offboarding dialogs (a <datalist> for the existing name box). Choosing a
 * suggestion fills the name; the dialog's "is it the same person?" step
 * then links the existing employee record — no new record is created.
 */
export function EmployeeNameSuggestions({ id, onlyActive = false }: { id: string; onlyActive?: boolean }) {
  const { data: available } = useDirectoryAvailable()
  const { data } = useEmployeeDirectory(!!available)
  if (!data) return null
  const names = [...new Set(data.filter((e) => !onlyActive || e.employment_status === 'active').map((e) => e.full_name))].sort((a, b) => a.localeCompare(b))
  return (
    <datalist id={id}>
      {names.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  )
}
