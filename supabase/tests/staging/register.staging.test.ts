// @vitest-environment node
/**
 * READ-ONLY validation of the employee equipment register (20260901000026)
 * through real Supabase Auth + REST, signed in as the staging admin
 * (npm run staging:verify). Nothing here changes data: invariants are
 * checked on whatever records exist, and the issue/return functions are
 * called only in ways they reject BEFORE writing anything, to prove the
 * API exposes them with the right parameters.
 *
 * Issuing and returning for real (two laptops, chargers, headsets, every
 * disposition) is tested in supabase/tests/db/register-live.db.test.ts,
 * on the same staging database, inside transactions that are always
 * rolled back. Refuses to run against production (lib.mjs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { signInReader } from './reader'
// @ts-expect-error — plain .mjs helper shared with the other staging scripts
import { loadStagingEnv } from '../../../scripts/staging/lib.mjs'

const env = loadStagingEnv(['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD']) as Record<string, string>
const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000'
let c: SupabaseClient
let role = ''
let anon: SupabaseClient

beforeAll(async () => {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } }
  anon = createClient(env.VITE_STAGING_SUPABASE_URL, env.VITE_STAGING_SUPABASE_ANON_KEY, opts) // signed out
  ;({ c, role } = await signInReader(env)) // see reader.ts
}, 60_000)
afterAll(async () => {
  await c?.auth.signOut()
})

describe('employee equipment register through the real API (read-only)', () => {
  it('the new tables and views are exposed to the signed-in reader', async () => {
    for (const t of ['employees', 'equipment_issues', 'employee_possible_duplicates', 'equipment_register_mismatches']) {
      const { error } = await c.from(t).select('*', { head: true, count: 'exact' })
      expect(error, t).toBeNull()
    }
  })

  it('the functions are exposed with the right parameters — exercised only where they reject before writing', async () => {
    // A viewer (the synthetic reader) is refused before any check; an editor/admin reaches the validation.
    const viewer = role === 'viewer'
    const issue = await c.rpc('issue_equipment', { p_employee_id: NO_SUCH_ID, p_collection: 'serialized_assets', p_asset_id: NO_SUCH_ID })
    expect(issue.error?.message).toMatch(viewer ? /Not authorized/ : /Employee not found/)
    const ret = await c.rpc('return_equipment', { p_issue_id: NO_SUCH_ID, p_outcome: 'returned' })
    expect(ret.error?.message).toMatch(viewer ? /Not authorized/ : /Register entry not found/)
    const notOutcome = await c.rpc('return_equipment', { p_issue_id: NO_SUCH_ID, p_outcome: 'open' })
    expect(notOutcome.error?.message).toMatch(viewer ? /Not authorized|Not a return outcome/ : /Not a return outcome/)
    const emp = await c.rpc('create_employee', { p_full_name: '   ' })
    expect(emp.error?.message).toMatch(viewer ? /Not authorized/ : /A name is required/)
  })

  it('a signed-out visitor sees nothing and cannot call the functions', async () => {
    for (const t of ['employees', 'equipment_issues']) {
      const { data } = await anon.from(t).select('id')
      expect(data ?? [], t).toEqual([])
    }
    const { error } = await anon.rpc('create_employee', { p_full_name: 'X' })
    expect(error?.message).toMatch(/not authorized/i)
  })

  it('the register matches every device: one open row per assigned device (or an authorized retention), no mismatches', async () => {
    const { data: mismatches } = await c.from('equipment_register_mismatches').select('*')
    expect(mismatches).toEqual([])

    // Every device that is assigned to someone...
    const key = (n: string | null) => (n ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    const assigned: { id: string; who: string }[] = []
    for (const t of ['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment']) {
      const { data } = await c.from(t).select('id, assigned_to').not('assigned_to', 'is', null).neq('assigned_to', '')
      for (const d of data ?? []) assigned.push({ id: d.id as string, who: key(d.assigned_to as string) })
    }
    const { data: rows } = await c.from('equipment_issues').select('asset_id, status, assignee_name, issued_at').eq('item_kind', 'serialized')
    const byAsset = new Map<string, { status: string; assignee_name: string; issued_at: string }[]>()
    for (const r of rows ?? []) byAsset.set(r.asset_id as string, [...(byAsset.get(r.asset_id as string) ?? []), r as never])

    // ...has exactly one open row for that person, OR is under an authorized retention: its latest register
    // row is retained_authorized for the same person (the employee keeps the device with approval).
    let open = 0
    let retained = 0
    for (const d of assigned) {
      const history = (byAsset.get(d.id) ?? []).sort((x, y) => y.issued_at.localeCompare(x.issued_at))
      const opens = history.filter((r) => r.status === 'open')
      expect(opens.length, `device ${d.id}: at most one open row`).toBeLessThanOrEqual(1)
      if (opens.length === 1) {
        open++
        expect(key(opens[0].assignee_name), `device ${d.id}: open row names the assignee`).toBe(d.who)
      } else {
        expect(history[0]?.status, `device ${d.id} is assigned with no open row, so it must be under authorized retention`).toBe('retained_authorized')
        expect(key(history[0].assignee_name), `device ${d.id}: the retention is for the person it is assigned to`).toBe(d.who)
        retained++
      }
    }
    // No open row without an assigned device behind it.
    const { count: openTotal } = await c.from('equipment_issues').select('*', { head: true, count: 'exact' }).eq('status', 'open').eq('item_kind', 'serialized')
    expect(openTotal).toBe(open)
    expect(open + retained).toBe(assigned.length)
  })

  it('every closed register row is complete: retained and lost carry a reason, retained carries an approver', async () => {
    const { data, error } = await c.from('equipment_issues').select('id, status, close_note, approved_by, closed_at, quantity')
    expect(error).toBeNull()
    for (const r of data!) {
      expect(r.quantity, r.id).toBeGreaterThan(0)
      expect(r.status === 'open', r.id).toBe(r.closed_at === null)
      if (r.status === 'retained_authorized' || r.status === 'lost') expect((r.close_note ?? '').trim(), r.id).not.toBe('')
      if (r.status === 'retained_authorized') expect(r.approved_by, r.id).toBeTruthy()
    }
  })

  it('tracked bulk quantities never exceed what Bulk Stock shows as Provided', async () => {
    const { data: items } = await c.from('bulk_items').select('id, name, provided')
    const { data: open } = await c.from('equipment_issues').select('bulk_item_id, quantity').eq('status', 'open').eq('item_kind', 'bulk')
    for (const item of items!) {
      const tracked = (open ?? []).filter((o) => o.bulk_item_id === item.id).reduce((n, o) => n + o.quantity, 0)
      expect(tracked, item.name).toBeLessThanOrEqual(item.provided)
    }
  })

  it('Charger and Headset Required hold only blank, Yes, No or N/A', async () => {
    const { data } = await c.from('onboarding_checklists').select('charger_required, headset_required')
    for (const r of data!) {
      for (const v of [r.charger_required, r.headset_required]) expect([null, 'yes', 'no', 'not_applicable']).toContain(v)
    }
  })
})
