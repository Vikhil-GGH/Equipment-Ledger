/**
 * Active Employees directory (20260901000028) against a LIVE database that
 * already has the migration — the hosted staging project
 * (npm run staging:test-db). Every test creates its own "ZZ-DIR" records
 * inside a transaction that is always ROLLED BACK; existing staging records
 * are never used as fixtures. Skipped on the disposable database, where
 * directory.db.test.ts covers the same ground and more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, errorOf, inRolledBackTx, isStaging, openDb, tableHash, type Db } from './harness'
import { EDITOR, VIEWER, rpc, seedLedger, seedUsers } from './fixtures'

let db: Db
const one = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const tag = `ZZ-DIR-${Date.now().toString(36).toUpperCase()}`

beforeAll(async () => {
  if (isStaging) db = await openDb()
})
afterAll(async () => {
  await db?.close()
})

describe.skipIf(!isStaging)('Active Employees directory on the live staging database (rolled back)', () => {
  it('the migration is present; existing employees were not put in the directory by it', async () => {
    expect(await one(`select to_regclass('public.employee_history') is not null as t, to_regprocedure('public.commit_employee_import(text, jsonb)') is not null as f`)).toEqual({ t: true, f: true })
    const r = await one<{ n: number }>(`select count(*)::int as n from employee_history where source not in ('manual', 'import', 'onboarding_completed', 'offboarding_completed')`)
    expect(r.n).toBe(0)
  })

  it('import → re-import creates nobody twice; onboarding completion activates; offboarding with a laptop pending return deactivates and leaves the laptop pending', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      const ids = await seedLedger(db, tag)
      await actAs(db, EDITOR)
      const email = `${tag.toLowerCase()}@example.invalid`
      const row = { row: 2, action: 'create', fields: { first_name: 'Zz', last_name: tag, email, department: 'Test', hr_status: 'Active' } }
      expect(await rpc(db, `commit_employee_import('zz.xlsx', $1::jsonb)`, [JSON.stringify([row])])).toMatchObject({ created: 1 })
      const again = await rpc<Record<string, any>>(db, `commit_employee_import('zz.xlsx', $1::jsonb)`, [JSON.stringify([{ ...row, fields: { ...row.fields, email: email.toUpperCase() } }])])
      expect(again).toMatchObject({ created: 0 })
      expect((await one<{ n: number }>(`select count(*)::int as n from employees where email_key = $1`, [email])).n).toBe(1)

      const person = await rpc<string>(db, `create_employee($1)`, [`ZZ Person ${tag}`])
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [person, ids.spareInventoryLaptop])
      const onb = (await one<{ id: string }>(`insert into onboarding_checklists (employee_name, employee_id, created_by) values ($1, $2, $3) returning id`, [`ZZ Person ${tag}`, person, EDITOR.id])).id
      await db.query(`update onboarding_checklists set identity_created = true, equipment_assigned = true, required_access_provided = true, onboarding_successful = true where id = $1`, [onb])
      expect((await one(`select employment_status from employees where id = $1`, [person])).employment_status).toBe('active')

      const register = await tableHash(db, 'equipment_issues')
      const off = (await one<{ id: string }>(`insert into offboarding_checklists (employee_name, employee_id, created_by) values ($1, $2, $3) returning id`, [`ZZ Person ${tag}`, person, EDITOR.id])).id
      await db.query(`update offboarding_checklists set removed_access = true, laptop_outcome = 'received' where id = $1`, [off])
      expect((await one(`select employment_status from employees where id = $1`, [person])).employment_status).toBe('inactive')
      expect(await tableHash(db, 'equipment_issues')).toBe(register)
      expect((await one<{ n: number }>(`select count(*)::int as n from equipment_issues where employee_id = $1 and status = 'open'`, [person])).n).toBe(1)
    })
  })

  it('viewers cannot write; tables are not writable directly', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await actAs(db, VIEWER)
      expect(await errorOf(db, `select save_employee(null, '{"first_name":"A","last_name":"B"}'::jsonb)`)).toMatch(/Not authorized/)
      await actAs(db, EDITOR)
      expect(await errorOf(db, `update employees set department = 'x' where false`)).toMatch(/permission denied/)
      await actAsDatabase(db)
    })
  })
})
