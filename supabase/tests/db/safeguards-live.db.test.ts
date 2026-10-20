/**
 * 20260901000029 against a LIVE database that already has it — the hosted
 * staging project (npm run staging:test-db). Own "ZZ-SAFE" records only,
 * in transactions that are always ROLLED BACK. Skipped on the disposable
 * database, where safeguards.db.test.ts covers the same ground and more.
 * The concurrency test needs two real connections.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { actAs, actAsDatabase, inRolledBackTx, isStaging, openDb, tableHash, type Db } from './harness'
import { EDITOR, rpc, seedLedger, seedUsers } from './fixtures'

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

  it('Bulk Stock: same delivery adds 0 (also renamed/reordered/re-cased); a confirmed new delivery adds and is recorded; existing stock untouched', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      const existing = await one<{ h: string }>(db, `select md5(coalesce(string_agg(row(b.*)::text, '|' order by b.id), '')) as h from bulk_items b`)
      const existingHist = (await one<{ h: string }>(db, `select md5(coalesce(string_agg(row(h.*)::text, '|' order by h.id), '')) as h from bulk_item_history h`)).h
      await actAs(db, EDITOR)
      const file = [
        { name: `${tag} Mouse`, category: 'Accessory', location: '', quantity: 10 },
        { name: `${tag} Webcam`, category: 'Accessory', location: '', quantity: 8 },
      ]
      const bulk = (rows: unknown[], f: string, confirm = false) => rpc<Record<string, any>>(db, `commit_bulk_import($1, $2::jsonb, $3)`, [f, JSON.stringify(rows), confirm])
      const avail = async (name: string) => (await one<{ a: number }>(db, `select available as a from bulk_items where name = $1`, [name])).a
      expect(await bulk(file, 'zz-1.xlsx')).toMatchObject({ created: 2 })
      expect(await avail(`${tag} Mouse`)).toBe(10)
      expect(await bulk(file, 'zz-1.xlsx')).toMatchObject({ created: 0, updated: 0, duplicate_of: { filename: 'zz-1.xlsx' } })
      const disguised = [{ ...file[1], name: `  ${tag.toLowerCase()} WEBCAM `, quantity: '8' }, { ...file[0], name: `${tag.toUpperCase()}   mouse`, category: 'accessory' }]
      expect(await bulk(disguised, 'Copy of zz-1 (2).xlsx')).toMatchObject({ created: 0, updated: 0, duplicate_of: expect.any(Object) })
      expect(await avail(`${tag} Mouse`)).toBe(10)
      const repeat = await bulk(file, 'zz-1-second-delivery.xlsx', true)
      expect(repeat).toMatchObject({ updated: 2, repeat_of: expect.any(String) })
      expect(await avail(`${tag} Mouse`)).toBe(20)
      const receipts = (await db.query(`select filename, repeat_of from bulk_import_receipts where filename like 'zz-1%' order by imported_at`)).rows
      expect(receipts.map((r) => [r.filename, !!r.repeat_of])).toEqual([['zz-1.xlsx', false], ['zz-1-second-delivery.xlsx', true]])
      expect((await one<{ n: number }>(db, `select count(*)::int as n from bulk_item_history where detail like '%zz-1-second-delivery.xlsx (confirmed as a new delivery%'`)).n).toBe(2)
      await actAsDatabase(db)
      // Pre-existing Bulk Stock rows and their history are exactly as before.
      expect((await one<{ h: string }>(db, `select md5(coalesce(string_agg(row(b.*)::text, '|' order by b.id), '')) as h from bulk_items b where name not like $1`, [`${tag}%`])).h).toBe(existing.h)
      const histNow = await one<{ h: string }>(db, `select md5(coalesce(string_agg(row(h.*)::text, '|' order by h.id), '')) as h from bulk_item_history h where item_id not in (select id from bulk_items where name like $1)`, [`${tag}%`])
      expect(histNow.h).toBe(existingHist)
    })
  })

  it('activation: Active activates; Terminated and Leave of Absence are withheld; a new hire activates; text, history and equipment are independent', async () => {
    await inRolledBackTx(db, async () => {
      await seedUsers(db)
      const ids = await seedLedger(db, tag)
      await actAs(db, EDITOR)
      const mk = async (k: string, hr: string, status?: string) => {
        const email = `${k}.${tag.toLowerCase()}@example.invalid`
        await rpc(db, `commit_employee_import('zz.xlsx', $1::jsonb)`, [JSON.stringify([{ row: 2, action: 'create', fields: { first_name: 'Zz', last_name: `${k}${tag}`, hr_status: hr, email }, ...(status ? { status } : {}) }])])
        return (await one<{ id: string }>(db, `select id from employees where email_key = $1`, [email])).id
      }
      const onboard = async (id: string) => {
        const onb = (await one<{ id: string }>(db, `insert into onboarding_checklists (employee_name, employee_id, created_by) values ('Zz', $1, $2) returning id`, [id, EDITOR.id])).id
        await db.query(`update onboarding_checklists set identity_created = true, equipment_assigned = true, required_access_provided = true, onboarding_successful = true where id = $1`, [onb])
        return onb
      }
      const state = (id: string) => one(db, `select employment_status, status_decision_required, reactivation_pending, hr_status from employees where id = $1`, [id])
      const active = await mk('active', 'Active')
      await onboard(active)
      expect(await state(active)).toMatchObject({ employment_status: 'active', status_decision_required: false, hr_status: 'Active' })
      const term = await mk('term', 'Terminated')
      await onboard(term)
      expect(await state(term)).toMatchObject({ employment_status: null, status_decision_required: true, hr_status: 'Terminated' })
      const formerInactive = await mk('former', 'Terminated', 'inactive')
      await onboard(formerInactive)
      expect(await state(formerInactive)).toMatchObject({ employment_status: 'inactive', reactivation_pending: true })
      const loa = await mk('loa', 'Leave of Absence')
      await rpc(db, `issue_equipment($1, 'serialized_assets', $2)`, [loa, ids.spareInventoryLaptop])
      const register = await tableHash(db, 'equipment_issues')
      const onbLoa = await onboard(loa)
      expect(await state(loa)).toMatchObject({ employment_status: null, status_decision_required: true, hr_status: 'Leave of Absence' })
      expect(await tableHash(db, 'equipment_issues')).toBe(register)
      expect(await one(db, `select onboarding_successful, equipment_assigned from onboarding_checklists where id = $1`, [onbLoa])).toEqual({ onboarding_successful: true, equipment_assigned: true })
      expect((await db.query(`select kind from employee_history where employee_id = $1 order by at`, [loa])).rows.map((r) => r.kind)).toEqual(['created', 'decision_required'])
      const hire = await rpc<string>(db, `create_employee($1)`, [`Zz Newhire ${tag}`])
      await onboard(hire)
      expect(await state(hire)).toMatchObject({ employment_status: 'active', status_decision_required: false })
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

  it('concurrency, both complete: two identical imports at once record one delivery; a second needs explicit confirmation', async () => {
    const rows = JSON.stringify([{ name: `${tag} Hub`, category: 'Accessory', location: '', quantity: 6 }])
    const stockB = async () => (await one<{ a: number | null }>(db2, `select (select available from bulk_items where name = $1) as a`, [`${tag} Hub`])).a
    const receiptsB = async () => (await one<{ n: number }>(db2, `select count(*)::int as n from bulk_import_receipts where filename like 'zz-conc-%'`)).n
    const bUser = { id: randomUUID(), email: `zz-conc-${tag.toLowerCase()}@example.invalid`, anonymous: false }
    await db.exec('begin')
    await db2.exec('begin')
    try {
      // Connection A: an import of this content is in progress (uncommitted, holds the lock).
      await seedUsers(db)
      await actAs(db, EDITOR)
      expect(await rpc(db, `commit_bulk_import('zz-conc-a.xlsx', $1::jsonb)`, [rows])).toMatchObject({ created: 1 })
      // Connection B: its own temporary editor (so it waits only on the import lock).
      await actAsDatabase(db2)
      await db2.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false)`, [bUser.id, bUser.email])
      await db2.query(`update profiles set role = 'editor' where id = $1`, [bUser.id])
      await actAs(db2, bUser)
      await db2.exec(`set local lock_timeout = '30s'`)
      let bDone = false
      const b = db2.query<{ r: Record<string, any> }>(`select commit_bulk_import('zz-conc-b.xlsx', $1::jsonb) as r`, [rows]).then((x) => { bDone = true; return x.rows[0].r })
      await new Promise((r) => setTimeout(r, 2500))
      expect(bDone).toBe(false) // B is waiting for A
      // A finishes (rolled back — nothing is ever committed), B then completes.
      await db.exec('rollback')
      const bResult = await b
      expect(bResult).toMatchObject({ created: 1 })
      expect(await stockB()).toBe(6) // counted once
      expect(await receiptsB()).toBe(1)
      // The same content again on B: nothing added.
      expect((await db2.query<{ r: Record<string, any> }>(`select commit_bulk_import('zz-conc-c.xlsx', $1::jsonb) as r`, [rows])).rows[0].r).toMatchObject({ created: 0, updated: 0, duplicate_of: { filename: 'zz-conc-b.xlsx' } })
      expect(await stockB()).toBe(6)
      expect(await receiptsB()).toBe(1)
      // Only an explicit confirmation records a second delivery.
      expect((await db2.query<{ r: Record<string, any> }>(`select commit_bulk_import('zz-conc-d.xlsx', $1::jsonb, true) as r`, [rows])).rows[0].r).toMatchObject({ updated: 1, repeat_of: expect.any(String) })
      expect(await stockB()).toBe(12)
      expect(await receiptsB()).toBe(2)
    } finally {
      await db2.exec('rollback').catch(() => {})
      await db.exec('rollback').catch(() => {})
    }
    await actAsDatabase(db)
    expect((await one<{ n: number }>(db, `select (select count(*) from bulk_items where name = $1)::int + (select count(*) from bulk_import_receipts where filename like 'zz-conc-%')::int + (select count(*) from auth.users where id = $2)::int as n`, [`${tag} Hub`, bUser.id])).n).toBe(0)
  })
})
