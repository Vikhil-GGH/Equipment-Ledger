/**
 * Concurrency of the one-in-progress-offboarding guard (033), with TWO real
 * database connections. Only a real PostgreSQL can show this (the disposable
 * in-process database has a single connection), so it runs on hosted staging
 * and only when asked:
 *
 *   RACE_TEST=1 npm run staging:test-db -- offboarding-race-live
 *
 * Zero persistent test data: every scenario but one is rolled back. The one
 * that must COMMIT (to prove the second request is rejected after the first
 * commits) uses throwaway UNLINKED names ("ZZ-RACE-<stamp>-…"), touches no
 * employee, and removes exactly those rows afterwards; the test then checks
 * that none remain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isStaging, openDb, type Db } from './harness'

const enabled = isStaging && process.env.RACE_TEST === '1'
const STAMP = `ZZ-RACE-${Date.now()}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let a: Db, b: Db, admin: Db

const insert = (c: Db, name: string, employeeId: string | null = null) =>
  c.query(`insert into offboarding_checklists (employee_name, employee_id) values ($1, $2) returning id`, [name, employeeId])
/** Waits up to ms; 'pending' means the statement is still blocked (waiting for a lock). */
async function outcome(p: Promise<unknown>, ms = 1500) {
  return Promise.race([p.then(() => 'ok' as const, (e: Error) => `error: ${e.message}`), sleep(ms).then(() => 'pending' as const)])
}
const leftovers = async () => (await admin.query<{ n: number }>(`select count(*)::int as n from offboarding_checklists where employee_name like $1`, [STAMP + '%'])).rows[0].n

beforeAll(async () => {
  if (!enabled) return
  a = await openDb()
  b = await openDb()
  admin = await openDb()
  const has = (await admin.query<{ f: boolean }>(`select to_regprocedure('canonical_assignee(text)') is not null as f`)).rows[0].f
  if (!has) throw new Error('Migration 033 is not applied here, so the guard does not exist yet.')
})
afterAll(async () => {
  if (!enabled) return
  for (const c of [a, b]) await c.exec('rollback').catch(() => undefined)
  await admin.query(`delete from offboarding_checklists where employee_name like $1`, [STAMP + '%']) // only this run's throwaway rows
  expect(await leftovers()).toBe(0)
  for (const c of [a, b, admin]) await c.close()
})

describe.skipIf(!enabled)('offboarding guard with two simultaneous connections (hosted staging)', () => {
  it('same person, first COMMITS: the second waits, then is rejected', async () => {
    const name = `${STAMP}-commit`
    await a.exec('begin')
    await b.exec('begin')
    await insert(a, name)
    const second = insert(b, ` ${name.toLowerCase()} `) // same person, typed differently
    expect(await outcome(second)).toBe('pending') // waiting for the first, not racing past it
    await a.exec('commit')
    expect(await outcome(second, 5000)).toMatch(/error: .*already in progress/)
    await b.exec('rollback')
    expect(await leftovers()).toBe(1) // only the first one exists
  })

  it('same person, first ROLLS BACK: the second waits, then succeeds', async () => {
    const name = `${STAMP}-rollback`
    await a.exec('begin')
    await b.exec('begin')
    await insert(a, name)
    const second = insert(b, name)
    expect(await outcome(second)).toBe('pending')
    await a.exec('rollback')
    expect(await outcome(second, 5000)).toBe('ok')
    await b.exec('rollback') // nothing is kept
    expect(await leftovers()).toBe(1) // still just the committed row from the first test
  })

  it('different people do not wait for each other', async () => {
    await a.exec('begin')
    await b.exec('begin')
    await insert(a, `${STAMP}-person-one`)
    expect(await outcome(insert(b, `${STAMP}-person-two`))).toBe('ok')
    await a.exec('rollback')
    await b.exec('rollback')
  })

  it('a linked record and an unlinked one for the same person also serialise (the identity forms share locks)', async () => {
    // An existing synthetic employee with no offboarding in progress; nothing is committed.
    const emp = (await admin.query<{ id: string; full_name: string }>(
      `select e.id, e.full_name from employees e
        where e.full_name like 'ZZ%' and e.name_key = lower(e.full_name)
          and not exists (select 1 from offboarding_checklists o where o.employee_id = e.id and not (o.removed_access and o.laptop_outcome is not null))
          and (select count(*) from employees x where x.name_key = e.name_key) = 1
        order by e.full_name limit 1`,
    )).rows[0]
    expect(emp, 'a synthetic employee to use').toBeDefined()
    await a.exec('begin')
    await b.exec('begin')
    await insert(a, `${STAMP}-nickname`, emp.id) // linked, typed with a different label
    const second = insert(b, emp.full_name.toUpperCase()) // unlinked, typed as the employee record's name
    expect(await outcome(second)).toBe('pending')
    await a.exec('rollback')
    expect(await outcome(second, 5000)).toBe('ok')
    await b.exec('rollback')
  })

  it('the employee_id UPDATE path is guarded too: linking while another request holds that person waits', async () => {
    const name = `${STAMP}-link`
    const loose = (await insert(admin, `${STAMP}-unlinked-label`)).rows[0] as { id: string }
    const emp = (await admin.query<{ id: string }>(
      `select e.id from employees e where e.full_name like 'ZZ%'
         and not exists (select 1 from offboarding_checklists o where o.employee_id = e.id and not (o.removed_access and o.laptop_outcome is not null))
         order by e.full_name limit 1`,
    )).rows[0]
    await a.exec('begin')
    await b.exec('begin')
    await insert(a, name, emp.id)
    const link = b.query(`update offboarding_checklists set employee_id = $2 where id = $1`, [loose.id, emp.id])
    expect(await outcome(link)).toBe('pending')
    await a.exec('rollback')
    expect(await outcome(link, 5000)).toBe('ok')
    await b.exec('rollback')
  })
})
