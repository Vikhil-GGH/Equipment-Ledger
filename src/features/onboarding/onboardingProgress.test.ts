import { describe, expect, it } from 'vitest'
import type { OnboardingRow } from './api'
import { onboardingStatus, sortOnboardingRows, stepsCompleted } from './onboardingProgress'

function row(name: string, created: string, steps: boolean[]): OnboardingRow {
  const [identity_created, equipment_assigned, required_access_provided, onboarding_successful] = steps
  return {
    id: name,
    employee_name: name,
    identity_created,
    equipment_assigned,
    required_access_provided,
    onboarding_successful,
    assigned_asset_id: null,
    created_at: created,
    updated_at: created,
  }
}

describe('onboarding status is derived from checklist steps', () => {
  it.each([
    [[false, false, false, false], 0, 'not_started'],
    [[true, false, false, false], 1, 'pending'],
    [[false, true, false, false], 1, 'pending'],
    [[true, true, false, false], 2, 'pending'],
    [[true, true, true, false], 3, 'pending'],
    [[false, true, true, true], 3, 'pending'],
    [[true, true, true, true], 4, 'completed'],
  ] as const)('%j → %i/4, %s', (steps, count, status) => {
    const r = row('x', '2026-10-14T00:00:00Z', [...steps])
    expect(stepsCompleted(r)).toBe(count)
    expect(onboardingStatus(r)).toBe(status)
  })

  it('reopening a step moves Completed back to Pending', () => {
    const r = row('x', '2026-10-14T00:00:00Z', [true, true, true, true])
    expect(onboardingStatus(r)).toBe('completed')
    expect(onboardingStatus({ ...r, required_access_provided: false })).toBe('pending')
  })
})

describe('sortOnboardingRows', () => {
  const rows = [
    row('Test Employee 31', '2026-10-14T10:00:00Z', [true, false, false, false]),
    row('Test Employee 93', '2026-10-15T09:00:00Z', [true, true, true, true]),
    row('Test Employee 30', '2026-10-14T09:00:00Z', [false, false, false, false]),
    row('test employee 4', '2026-10-13T09:00:00Z', [true, true, false, false]),
  ]
  const names = (r: OnboardingRow[]) => r.map((x) => x.employee_name)

  it('defaults to most recently started first', () => {
    expect(names(sortOnboardingRows(rows, 'started', 'desc'))).toEqual([
      'Test Employee 93',
      'Test Employee 31',
      'Test Employee 30',
      'test employee 4',
    ])
  })

  it('sorts names case-insensitively with natural numbers', () => {
    expect(names(sortOnboardingRows(rows, 'name', 'asc'))).toEqual([
      'test employee 4',
      'Test Employee 30',
      'Test Employee 31',
      'Test Employee 93',
    ])
  })

  it('sorts by progress and by status, ties newest first', () => {
    expect(names(sortOnboardingRows(rows, 'progress', 'desc'))).toEqual([
      'Test Employee 93',
      'test employee 4',
      'Test Employee 31',
      'Test Employee 30',
    ])
    expect(names(sortOnboardingRows(rows, 'status', 'asc'))).toEqual([
      'Test Employee 30',
      'Test Employee 31',
      'test employee 4',
      'Test Employee 93',
    ])
  })

  it('does not mutate its input', () => {
    const copy = [...rows]
    sortOnboardingRows(rows, 'name', 'asc')
    expect(rows).toEqual(copy)
  })
})
