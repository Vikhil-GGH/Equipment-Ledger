import { describe, expect, it } from 'vitest'
import { checklistStatus, countCompleted, progressFromSteps, sortChecklistRows } from './checklistProgress'

describe('checklist progress uses the workflow’s own step count', () => {
  const steps3 = ['a', 'b', 'c'] as const
  const steps5 = ['a', 'b', 'c', 'd', 'e'] as const
  const rec = { a: true, b: true, c: true, d: false, e: false }

  it('counts only the listed step columns', () => {
    expect(countCompleted(rec, steps3)).toBe(3)
    expect(countCompleted(rec, steps5)).toBe(3)
  })

  it('3/3 is Completed but 3/5 is Pending', () => {
    expect(checklistStatus(countCompleted(rec, steps3), steps3.length)).toBe('completed')
    expect(checklistStatus(countCompleted(rec, steps5), steps5.length)).toBe('pending')
  })

  it('ignores non-boolean truthy values', () => {
    expect(countCompleted({ a: 'yes', b: 1, c: true } as Record<string, unknown>, ['a', 'b', 'c'])).toBe(1)
  })

  it.each([
    [0, 4, 'not_started'],
    [1, 4, 'pending'],
    [3, 4, 'pending'],
    [4, 4, 'completed'],
    [0, 1, 'not_started'],
    [1, 1, 'completed'],
  ] as const)('%i of %i → %s', (done, total, status) => {
    expect(checklistStatus(done, total)).toBe(status)
  })

  it('sorts by progress against the given steps', () => {
    const rows = [
      { id: '1', employee_name: 'A', created_at: '2026-10-13', a: true, b: false, c: false },
      { id: '2', employee_name: 'B', created_at: '2026-10-14', a: true, b: true, c: true },
      { id: '3', employee_name: 'C', created_at: '2026-10-15', a: false, b: false, c: false },
    ]
    const progress = progressFromSteps<(typeof rows)[number], 'a' | 'b' | 'c'>(steps3)
    expect(sortChecklistRows(rows, progress, 'progress', 'asc').map((r) => r.id)).toEqual(['3', '1', '2'])
    expect(sortChecklistRows(rows, progress, 'status', 'desc').map((r) => r.id)).toEqual(['2', '1', '3'])
  })
})
