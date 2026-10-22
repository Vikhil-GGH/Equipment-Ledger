import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs module
import { parseOldExports, reconcile, normSerial } from './reconcile-core.mjs'

const exp = (data: Record<string, unknown>) => ({ name: 'e.json', json: { format: 'eqledger-localstorage-export-1', data } })
const dev = (serial: string, status = 'provided', assigned = 'Ann', extra = {}) => ({ id: serial, name: 'Dell ' + serial, category: 'Laptop', serial, status, assigned, location: 'Tampa Office', history: [], ...extra })

describe('reconcile old app vs database', () => {
  it('classifies same, changed, only-old, only-new, duplicates and no-serial without touching inputs', () => {
    const old = parseOldExports([exp({
      assets: [dev('ab 1'), dev('B2', 'available', ''), dev('C3'), dev('D4'), dev('D4'), dev('')],
      monitorAssets: [dev('M1')],
      bulkItems: [{ name: 'Cable', category: 'Misc', buckets: { available: 4 } }],
      onboardingCases: [{ employeeName: 'Zed', steps: {} }],
    })])
    const data = {
      serialized_assets: [
        { id: 'r1', serial: 'AB  1', status: 'provided', assigned_to: 'ann', location: 'tampa office', name: 'x', category: 'Laptop' },
        { id: 'r2', serial: 'B2', status: 'provided', assigned_to: 'Bob', location: '', name: 'x', category: 'Laptop' },
        { id: 'r4', serial: 'D4', status: 'available', assigned_to: '', location: '', name: 'x', category: 'Laptop' },
        { id: 'r5', serial: 'ONLYDB', status: 'available', assigned_to: '', location: '', name: 'x', category: 'Laptop' },
      ],
      monitors: [], bulk_items: [], onboarding_checklists: [],
    }
    const snap = JSON.stringify([old, data])
    const r = reconcile(old, data)
    expect(JSON.stringify([old, data])).toBe(snap)
    const l = r.families.laptops
    expect(l.same.map((x: any) => x.key)).toEqual(['AB 1'])
    expect(l.changed.map((x: any) => x.key)).toEqual(['B2'])
    expect(Object.keys(l.changed[0].diffs).sort()).toEqual(['assigned', 'location', 'status'])
    expect(l.onlyOld.map((x: any) => x.key)).toEqual(['C3'])
    expect(l.onlyNew.map((x: any) => x.key)).toEqual(['ONLYDB'])
    expect(l.duplicate.map((x: any) => x.key)).toEqual(['D4'])
    expect(l.noSerialOld).toHaveLength(1)
    expect(r.families.monitors.onlyOld).toHaveLength(1)
    expect(r.bulk.onlyOld).toHaveLength(1)
    expect(r.onboarding.open).toHaveLength(1)
  })

  it('normalises serials like the database and rejects foreign files', () => {
    expect(normSerial('  ab  12 ')).toBe('AB 12')
    expect(parseOldExports([{ name: 'x', json: { nope: 1 } }]).problems).toHaveLength(1)
  })
})
