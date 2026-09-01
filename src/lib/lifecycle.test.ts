import { describe, expect, it } from 'vitest'
import {
  getAllowedActions,
  getStatusLabel,
  isActionAllowed,
  isTerminal,
  resultingStatus,
} from './lifecycle'
import type { AssetAction, AssetStatus } from '../types/database.types'

// Exact allowed-actions table from the spec. Every status/action pair not
// listed here must be disallowed — the negative assertions below enforce
// that nothing extra has crept in.
const EXPECTED: Record<AssetStatus, AssetAction[]> = {
  available: ['provide', 'retain', 'mark_damaged'],
  provided: ['collect', 'transfer', 'mark_damaged', 'decommission'],
  retained: ['provide', 'mark_damaged'],
  damaged: ['mark_repaired', 'mark_nonfunctional'],
  decommissioned: ['provide', 'retain', 'mark_damaged'],
  nonfunctional: [],
}

const ALL_ACTIONS: AssetAction[] = [
  'provide',
  'retain',
  'mark_damaged',
  'collect',
  'transfer',
  'decommission',
  'mark_repaired',
  'mark_nonfunctional',
]

describe('getAllowedActions', () => {
  for (const [status, actions] of Object.entries(EXPECTED) as [AssetStatus, AssetAction[]][]) {
    it(`returns exactly ${JSON.stringify(actions)} for '${status}'`, () => {
      expect(getAllowedActions(status).sort()).toEqual([...actions].sort())
    })
  }
})

describe('isActionAllowed', () => {
  for (const [status, allowed] of Object.entries(EXPECTED) as [AssetStatus, AssetAction[]][]) {
    for (const action of ALL_ACTIONS) {
      const shouldBeAllowed = allowed.includes(action)
      it(`${shouldBeAllowed ? 'allows' : 'rejects'} '${action}' from '${status}'`, () => {
        expect(isActionAllowed(status, action)).toBe(shouldBeAllowed)
      })
    }
  }
})

describe('decommissioned is not terminal (deliberate design decision)', () => {
  it('decommissioned still has actions available', () => {
    expect(isTerminal('decommissioned')).toBe(false)
    expect(getAllowedActions('decommissioned').length).toBeGreaterThan(0)
  })
})

describe('nonfunctional is the only terminal state', () => {
  it('nonfunctional has no actions', () => {
    expect(isTerminal('nonfunctional')).toBe(true)
    expect(getAllowedActions('nonfunctional')).toEqual([])
  })

  for (const status of Object.keys(EXPECTED) as AssetStatus[]) {
    if (status === 'nonfunctional') continue
    it(`'${status}' is not terminal`, () => {
      expect(isTerminal(status)).toBe(false)
    })
  }
})

describe('resultingStatus', () => {
  it('provide from available results in provided', () => {
    expect(resultingStatus('available', 'provide')).toBe('provided')
  })
  it('collect from provided results in available', () => {
    expect(resultingStatus('provided', 'collect')).toBe('available')
  })
  it('decommission from provided results in decommissioned', () => {
    expect(resultingStatus('provided', 'decommission')).toBe('decommissioned')
  })
  it('mark_repaired from damaged results in available (not decommissioned)', () => {
    expect(resultingStatus('damaged', 'mark_repaired')).toBe('available')
  })
  it('mark_nonfunctional from damaged results in nonfunctional (terminal)', () => {
    expect(resultingStatus('damaged', 'mark_nonfunctional')).toBe('nonfunctional')
  })
  it('disallowed transitions resolve to undefined', () => {
    expect(resultingStatus('nonfunctional', 'provide')).toBeUndefined()
    expect(resultingStatus('available', 'collect')).toBeUndefined()
    expect(resultingStatus('damaged', 'provide')).toBeUndefined()
  })
})

describe('getStatusLabel', () => {
  it('shows "Active" for provided status in active_laptops_np only', () => {
    expect(getStatusLabel('provided', 'active_laptops_np')).toBe('Active')
  })
  it('shows "Provided" for provided status in serialized_assets', () => {
    expect(getStatusLabel('provided', 'serialized_assets')).toBe('Provided')
  })
  it('does not relabel other statuses in active_laptops_np', () => {
    expect(getStatusLabel('available', 'active_laptops_np')).toBe('Available')
    expect(getStatusLabel('decommissioned', 'active_laptops_np')).toBe('Decommissioned')
  })
})
