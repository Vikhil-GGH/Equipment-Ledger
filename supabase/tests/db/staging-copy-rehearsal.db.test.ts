/**
 * Rehearsal of 20260901000033 on a COPY of real staging data.
 *
 * Needs a snapshot taken by `npm run staging:snapshot -- save <label>` (a
 * read-only backup of every public table, in the git-ignored
 * .staging-state/). Set REHEARSAL_SNAPSHOT=<label> to run it; otherwise it is
 * skipped. The snapshot is loaded into a disposable in-process database at
 * migration 030, then 033 is applied and rolled back. Nothing touches hosted
 * staging.
 *
 *   REHEARSAL_SNAPSHOT=staging-pre-033-rehearsal npm run test:db -- staging-copy
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  actAs,
  actAsDatabase,
  applyMigration,
  applyRollback,
  errorOf,
  inCommittedTx,
  isStaging,
  loadSupabaseStub,
  migrationFiles,
  openDb,
  readAdaptation,
  tableHash,
  type Db,
} from './harness'
import { ADMIN, rpc } from './fixtures'

const LABEL = process.env.REHEARSAL_SNAPSHOT
const DIR = join(__dirname, '..', '..', '..', '.staging-state', 'snapshots', LABEL ?? '-')
const M033 = '20260901000033_reliability_fixes.sql'
const enabled = !!LABEL && !isStaging && existsSync(join(DIR, 'data.json'))

let db: Db
let data: Record<string, Record<string, unknown>[]> = {}
let tables: string[] = []
const hashes = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await tableHash(db, t)])))
const all = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows

beforeAll(async () => {
  if (!enabled) return
  data = JSON.parse(readFileSync(join(DIR, 'data.json'), 'utf8'))
  tables = Object.keys(data)
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M033) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  // Load the copy exactly as it was: every row, with triggers and foreign keys out of the way.
  await inCommittedTx(db, async () => {
    await db.exec(`set local session_replication_role = replica`)
    // Logins the profiles refer to (the snapshot holds public tables only).
    for (const p of data.profiles ?? []) {
      await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false) on conflict (id) do nothing`, [p.id, p.email ?? null])
    }
    for (const t of tables) {
      if (!data[t].length) continue
      // Stored generated columns (name_key, email_key) are recomputed by the database, not loaded.
      const cols = (await all<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`, [t])).map((r) => `"${r.c}"`).join(', ')
      await db.query(`insert into ${t} (${cols}) select ${cols} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(data[t])])
    }
  })
}, 600_000)
afterAll(async () => {
  await db?.close()
})

describe.skipIf(!enabled)(`033 on a copy of staging (${LABEL})`, () => {
  let before: Record<string, string> = {}
  let oldMismatches: unknown[] = []
  let dupes: { employee_id: string; n: number }[] = []

  it('the copy matches the snapshot row for row', async () => {
    for (const t of tables) expect((await all(`select count(*)::int as n from ${t}`))[0].n, t).toBe(data[t].length)
    before = await hashes()
    oldMismatches = await all(`select * from equipment_register_mismatches order by serial`)
    dupes = await all(`select employee_id::text, count(*)::int as n from offboarding_checklists where employee_id is not null group by 1 having count(*) > 1`)
  })

  it('applying 033 changes no existing row in any table', async () => {
    await applyMigration(db, M033)
    expect(await hashes()).toEqual(before)
  })

  it('the register mismatch list is the same before and after on real data (no discrepancy hidden or invented)', async () => {
    expect(await all(`select * from equipment_register_mismatches order by serial`)).toEqual(oldMismatches)
  })

  it('existing duplicate offboarding checklists are kept, and a new one for the same employee is refused', async () => {
    expect(dupes.length).toBeGreaterThan(0) // staging does have a legacy duplicate
    const d = dupes[0]
    expect((await all(`select count(*)::int as n from offboarding_checklists where employee_id = $1`, [d.employee_id]))[0].n).toBe(d.n)
    await db.exec('begin')
    try {
      await actAsDatabase(db)
      const name = (await all(`select employee_name from offboarding_checklists where employee_id = $1 limit 1`, [d.employee_id]))[0].employee_name
      // Only refused if one of them is still in progress; if all are complete a new one is allowed.
      const inProgress = (await all(`select count(*)::int as n from offboarding_checklists where employee_id = $1 and not (removed_access and laptop_outcome is not null)`, [d.employee_id]))[0].n
      const msg = await errorOf(db, `insert into offboarding_checklists (employee_name, employee_id) values ($1, $2)`, [name, d.employee_id])
      if (inProgress > 0) expect(msg).toMatch(/already in progress/)
      else expect(msg).toBeNull()
    } finally {
      await db.exec('rollback')
    }
  })

  it('the ambiguous names in the real data are refused on assignment, not silently unlinked', async () => {
    const shared = await all<{ name_key: string; n: number }>(`select name_key, count(*)::int as n from employees group by 1 having count(*) > 1 limit 1`)
    expect(shared.length).toBe(1)
    const monitor = (await all<{ id: string }>(`select id from monitors where status = 'available' limit 1`))[0]
    await db.exec('begin')
    try {
      await actAs(db, ADMIN)
      await db.exec(`reset role`)
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: (await all<{ id: string }>(`select id from profiles where role = 'admin' limit 1`))[0].id, role: 'authenticated', aal: 'aal2' })])
      await db.exec('set local role authenticated')
      const msg = await errorOf(db, `select perform_lifecycle_action('monitors', $1, 'provide', $2)`, [monitor.id, shared[0].name_key])
      expect(msg).toMatch(/More than one employee is named/)
    } finally {
      await db.exec('rollback')
    }
    expect((await all(`select assigned_to from monitors where id = $1`, [monitor.id]))[0].assigned_to).toBeNull()
  })

  it('the rollback restores the copy exactly', async () => {
    await applyRollback(db, '20260901000033_down.sql')
    expect(await hashes()).toEqual(before)
    expect(await all(`select * from equipment_register_mismatches order by serial`)).toEqual(oldMismatches)
    expect((await all(`select to_regprocedure('canonical_assignee(text)') as f`))[0].f).toBeNull()
    void rpc // (fixtures import kept for parity with the other suites)
  })
})
