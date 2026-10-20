import { describe, expect, it } from 'vitest'
import { classifyNewRows, isSyntheticRecord } from './classify.mjs'

const ACC = '20ce638b-a70b-425f-a54a-09a59fe28acb' // synthetic account
const ACC2 = '88dec702-8c41-485c-b2fb-40e50e2b191f' // synthetic account
const REAL = '1f5c4e8e-a7bd-461c-9b97-2db5181c9417' // existing account
const MON = '9b952067-0d48-49db-b9c1-4b4283c91350'
const base = { pk: { serial_keys: 'asset_id' }, tags: ['ZZ-ACC-1619'], syntheticIds: [ACC, ACC2], existingAccountIds: [REAL] }

describe('classifyNewRows', () => {
  it('recognises rows in tables that did not exist at the snapshot (profiles, access history) by account id', () => {
    const r = classifyNewRows({
      ...base,
      newRows: {
        profiles: [{ id: ACC, email: 'zz-acc-1619-admina@example.invalid' }],
        profile_access_history: [{ id: 'h1', user_id: ACC2, actor_user_id: ACC, reason: null }],
      },
    })
    expect(r.profiles).toMatchObject({ added: 1, synthetic: 1, unexpected: [] })
    expect(r.profile_access_history).toMatchObject({ added: 1, synthetic: 1, unexpected: [] })
  })

  it('follows children of synthetic rows (history, serial keys) and tagged rows without an employee link', () => {
    const r = classifyNewRows({
      ...base,
      newRows: {
        monitors_history: [{ id: 'mh1', asset_id: MON, action: 'created' }],
        serial_keys: [{ asset_id: MON, serial_key: 'ZZ-ACC-1619-MON' }],
        monitors: [{ id: MON, serial: 'ZZ-ACC-1619-MON' }],
        onboarding_checklists: [{ id: 'ob1', employee_name: 'zz-acc-1619 Onboarding', employee_id: null, created_by: 'someone-else' }],
      },
    })
    for (const t of ['monitors_history', 'serial_keys', 'monitors', 'onboarding_checklists']) expect(r[t].unexpected, t).toEqual([])
  })

  it('a row with no tag and no synthetic reference is unexpected', () => {
    const r = classifyNewRows({ ...base, newRows: { monitors: [{ id: 'm2', serial: 'REAL-123', created_by: REAL }] } })
    expect(r.monitors.unexpected).toHaveLength(1)
  })

  it('flags synthetic rows that reference an existing account (e.g. a synthetic admin acting on a real user)', () => {
    const r = classifyNewRows({ ...base, newRows: { profile_access_history: [{ id: 'h2', user_id: REAL, actor_user_id: ACC }] } })
    expect(r.profile_access_history.synthetic).toBe(1)
    expect(r.profile_access_history.touchesExistingAccount).toMatchObject([{ refs: [{ column: 'user_id', id: REAL }], onlyAsActor: false }])
  })

  it('an existing user acting on a synthetic account is synthetic but reported as touching an existing account', () => {
    const r = classifyNewRows({ ...base, newRows: { profile_access_history: [{ id: 'h3', user_id: ACC, actor_user_id: REAL }] } })
    expect(r.profile_access_history.unexpected).toEqual([])
    expect(r.profile_access_history.touchesExistingAccount).toMatchObject([{ refs: [{ column: 'actor_user_id', id: REAL }], onlyAsActor: true }])
  })

  it('tags match case-insensitively and inside nested JSON; other tags do not match', () => {
    const r = classifyNewRows({
      ...base,
      newRows: { import_events: [{ id: 'i1', details: { file: 'zz-acc-1619-test.xlsx' } }, { id: 'i2', filename: 'ZZ-ACC-9999.xlsx' }] },
    })
    expect(r.import_events.synthetic).toBe(1)
    expect(r.import_events.unexpected.map((x) => x.id)).toEqual(['i2'])
  })

  it('isSyntheticRecord: an existing row is synthetic by its own id (a synthetic account) or a tag — not by what it references', () => {
    const src = { tags: ['ZZ-ACC-1619'], syntheticIds: [ACC] }
    expect(isSyntheticRecord({ id: ACC, email: 'x@example.invalid' }, 'id', src)).toBe(true)
    expect(isSyntheticRecord({ id: 'ob1', employee_name: 'ZZ-ACC-1619 Onboarding' }, 'id', src)).toBe(true)
    expect(isSyntheticRecord({ id: REAL, access_revoked_by: ACC }, 'id', src)).toBe(false)
  })
})
