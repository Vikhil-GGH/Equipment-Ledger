/**
 * 20260901000029 against a LIVE database that already has it — the hosted
 * staging project (npm run staging:test-db). Own "ZZ-SAFE" records only,
 * in transactions that are always ROLLED BACK. Skipped on the disposable
 * database, where safeguards.db.test.ts covers the same ground and more.
 * The concurrency test needs two real connections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, inRolledBackTx, isStaging, openDb, type Db } from './harness'
import { EDITOR, rpc, seedUsers } from './fixtures'

let db: Db
let db2: Db
const tag = `ZZ-SAFE-${Date.now().toString(36).toUpperCase()}`
const one = async <T = Record<string, any>>(conn: Db, sql: string, params: unknown[] = []) => (await conn.query<T>(sql, params)).rows[0]

beforeAll(async () => {
  if (!isStaging) return
  db = await openDb()
  db2 = await openDb()
})
afterAll(async () => {
  await db?.close()
  await db2?.close()
})

describe.skipIf(!isStaging)('029 safeguards on the live staging database (rolled back)', () => {
  it('the migration is present', async () => {
    expect(await one(db, `select to_regclass('public.bulk_import_receipts') is not null as t, to_regprocedure('public.commit_bulk_import(text, jsonb, boolean)') is not null as f, to_regprocedure('public.hr_status_class(text)') is not null as h`))
      .toEqual({ t: true, f: true, h: true })
  })

  it('onboarding completion withholds activation for an unclear Employee Status', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      await actAs(db, EDITOR)
      const email = `${tag.toLowerCase()}@example.invalid`
      await rpc(db, `commit_employee_import('zz.xlsx', $1::jsonb)`, [JSON.stringify([{ row: 2, action: 'create', fields: { first_name: 'Zz', last_name: tag, hr_status: 'Leave of Absence', email } }])])
      const id = (await one<{ id: string }>(db, `select id from employees where email_key = $1`, [email])).id
      const onb = (await one<{ id: string }>(db, `insert into onboarding_checklists (employee_name, employee_id, created_by) values ($1, $2, $3) returning id`, [`Zz ${tag}`, id, EDITOR.id])).id
      await db.query(`update onboarding_checklists set identity_created = true, equipment_assigned = true, required_access_provided = true, onboarding_successful = true where id = $1`, [onb])
      expect(await one(db, `select employment_status, status_decision_required from employees where id = $1`, [id])).toEqual({ employment_status: null, status_decision_required: true })
    })
  })

  it('concurrency: while one import of some content is in progress, a second import of the same content has to wait', async () => {
    const rows = JSON.stringify([{ name: `${tag} Cable`, category: 'Cable', location: '', quantity: 4 }])
    await db.exec('begin')
    await db2.exec('begin')
    try {
      await seedUsers(db)
      await actAs(db, EDITOR)
      expect(await rpc(db, `commit_bulk_import('zz-a.xlsx', $1::jsonb)`, [rows])).toMatchObject({ created: 1 })
      const hash = (await one<{ h: string }>(db, `select content_hash as h from bulk_import_receipts where filename = 'zz-a.xlsx'`)).h
      // The second connection asks for exactly the lock commit_bulk_import
      // takes for this content — it must wait for the first to finish.
      await actAsDatabase(db2)
      await db2.exec(`set local lock_timeout = '3s'`)
      const started = Date.now()
      const second = await db2.query(`select pg_advisory_xact_lock(hashtext('commit_bulk_import'), hashtext($1))`, [hash]).then(() => 'acquired', (e: Error) => e.message)
      expect(second).toMatch(/lock timeout|canceling statement/)
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500)
    } finally {
      await db2.exec('rollback')
      await db.exec('rollback')
    }
    await actAsDatabase(db)
    expect((await one<{ n: number }>(db, `select count(*)::int as n from bulk_items where name = $1`, [`${tag} Cable`])).n).toBe(0)
  })
})
