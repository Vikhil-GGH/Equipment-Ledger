import { useEmployeesNamed } from './api'
import { normalizeName } from './registerModel'

/**
 * Shown in the Start onboarding / offboarding dialogs once the register
 * exists. If employees with exactly this name already exist, the operator
 * must say whether it's one of them or a new person — never guessed.
 * value: an employee id, 'new', or '' (not chosen yet).
 */
export function NewEmployeeChoice({
  name,
  value,
  onChange,
}: {
  name: string
  value: string
  onChange: (value: string) => void
}) {
  const key = normalizeName(name)
  const { data: matches, isLoading } = useEmployeesNamed(key || null)
  if (!key) return null
  if (isLoading) return <p className="text-xs text-neutral-500">Checking for existing employees…</p>
  if (!matches?.length) {
    return <p className="text-xs text-neutral-500">A new employee record will be created for “{name.trim()}”.</p>
  }
  return (
    <fieldset className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/60 p-2 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
      <legend className="px-1 text-xs font-medium text-amber-900 dark:text-amber-200">
        {matches.length === 1 ? 'An employee' : `${matches.length} employees`} with this name already exist — is it the same person?
      </legend>
      {matches.map((m) => (
        <label key={m.id} className="flex items-center gap-2">
          <input type="radio" name="employee-choice" checked={value === m.id} onChange={() => onChange(m.id)} />
          Yes — {m.full_name} <span className="text-xs text-neutral-500">(added {new Date(m.created_at).toLocaleDateString()})</span>
        </label>
      ))}
      <label className="flex items-center gap-2">
        <input type="radio" name="employee-choice" checked={value === 'new'} onChange={() => onChange('new')} />
        No — a different person (create a new record)
      </label>
    </fieldset>
  )
}
