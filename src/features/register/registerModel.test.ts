import { describe, expect, it } from 'vitest'
import {
  OUTCOMES_REQUIRING_REASON,
  inventoryEffect,
  isChargerIssue,
  isHeadsetIssue,
  isLaptopIssue,
  itemTypeLabel,
  normalizeName,
  requirementState,
  returnProgress,
} from './registerModel'

describe('register model', () => {
  it('normalizes names exactly like the database (trim, collapse spaces, ignore case) — and nothing more', () => {
    expect(normalizeName('  Test   Employee A ')).toBe('test employee a')
    expect(normalizeName('Jon Smith')).not.toBe(normalizeName('John Smith'))
  })

  it('a charger/headset answer never implies an automatic issue', () => {
    expect(requirementState(null, 0)).toBe('unanswered')
    expect(requirementState('yes', 0)).toBe('needed')
    expect(requirementState('no', 0)).toBe('not_required')
    expect(requirementState('not_applicable', 0)).toBe('not_required')
    // Something issued stays "issued" whatever the answer says now.
    expect(requirementState('no', 1)).toBe('issued')
  })

  it('return progress counts only items still relevant, and keeps retained/lost visible', () => {
    const p = returnProgress([
      { status: 'open' },
      { status: 'open' },
      { status: 'returned' },
      { status: 'retained_authorized' },
      { status: 'lost' },
      { status: 'transferred' },
      { status: 'unassigned' },
    ])
    expect(p).toEqual({ total: 5, pending: 2, retained: 1, lost: 1, processed: 3 })
  })

  it('describes the exact inventory effect of every outcome', () => {
    const device = { item_kind: 'serialized' as const, quantity: 1 }
    const bulk = { item_kind: 'bulk' as const, quantity: 3 }
    expect(inventoryEffect(device, 'returned')).toMatch(/Available and unassigned/)
    expect(inventoryEffect(device, 'returned_damaged')).toMatch(/Damaged and unassigned/)
    expect(inventoryEffect(device, 'retained_authorized')).toMatch(/No inventory change/)
    expect(inventoryEffect(device, 'lost')).toMatch(/Lost and unassigned/)
    expect(inventoryEffect(bulk, 'returned', 2)).toBe('Bulk Stock: 2 moved from Provided to Available.')
    expect(inventoryEffect(bulk, 'retained_authorized')).toBe('Bulk Stock: 3 written off from Provided (not Available, not pending).')
    expect(inventoryEffect(bulk, 'lost', 1)).toMatch(/written off from Provided as lost/)
  })

  it('reasons are required for authorized retention and loss only', () => {
    expect([...OUTCOMES_REQUIRING_REASON].sort()).toEqual(['lost', 'retained_authorized'])
  })

  it('classifies items', () => {
    const laptop = { item_kind: 'serialized' as const, asset_collection: 'active_laptops_np' as const, description: 'Dell Latitude' }
    const headsetDevice = { item_kind: 'serialized' as const, asset_collection: 'other_equipment' as const, description: 'Headset' }
    const charger = { item_kind: 'bulk' as const, asset_collection: null, description: 'USB-C Charger' }
    expect(itemTypeLabel(laptop)).toBe('Laptop')
    expect(itemTypeLabel(headsetDevice)).toBe('Headset')
    expect(itemTypeLabel(charger)).toBe('Bulk Stock')
    expect(itemTypeLabel({ ...laptop, asset_collection: 'monitors', description: 'Dell 24' })).toBe('Monitor')
    expect(isLaptopIssue(laptop) && !isLaptopIssue(headsetDevice)).toBe(true)
    expect(isHeadsetIssue(headsetDevice) && !isHeadsetIssue(laptop)).toBe(true)
    expect(isChargerIssue(charger) && !isChargerIssue(laptop)).toBe(true)
  })
})
