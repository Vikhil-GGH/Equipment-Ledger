/**
 * Tests for 20260901000024_offboarding_laptop_outcome.sql on a fresh
 * disposable database: mapping of existing checklists, the outcome <->
 * legacy-flag sync, backup/restore, and exact rollback. PGlite only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actAs,
  actAsDatabase,
  applyMigration,
  applyRollback,
  errorOf,
  inCommittedTx,
  inRolledBackTx,
  isStaging,
  loadSupabaseStub,
  migrationFiles,
  openDb,
  readAdaptation,
  tableHash,
  type Db,
} from './harness'
import { ADMIN, VIEWER, rpc, seedUsers } from './fixtures'

const M024 = '20260901000024_offboarding_laptop_outcome.sql'
let db: Db
const ids: Record<string, string> = {}
const before: Record<string, unknown> = {}

// Legacy combinations: [removed_access, received, retained, decommissioned]
const LEGACY: Record<string, [boolean, boolean, boolean, boolean]> = {
  none: [false, false, false, false],
  accessOnly: [true, false, false, false],
  received: [true, true, false, false],
  retained: [false, false, true, false],
  decommissioned: [true, false, false, true],
  conflictTwo: [true, true, true, false],
  conflictAll: [true, true, true, true],
}

const ORIGINAL_COLUMNS_HASH = `select md5(coalesce(string_agg(row(id, employee_name, removed_access, laptop_received,
  laptop_retained, laptop_decommissioned, created_by, created_at, updated_at)::text, '|' order by id), '')) as h
  from offboarding_checklists`

async function restoreBackupDef() {
  const { rows } = await db.query<{ d: string }>(`select pg_get_functiondef('public.restore_backup'::regproc) as d`)
  return rows[0].d
}

beforeAll(async () => {
  if (isStaging) return
  db = await openDb()
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (file >= M024) break
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    for (const [key, [access, rec, ret, dec]] of Object.entries(LEGACY)) {
      const { rows } = await db.query<{ id: string }>(
        `insert into offboarding_checklists (employee_name, removed_access, laptop_received, laptop_retained, laptop_decommissioned, created_by, updated_at)
         values ($1, $2, $3, $4, $5, $6, '2026-10-01T12:00:00.123456Z') returning id`,
        [`Test Employee ${key}`, access, rec, ret, dec, ADMIN.id],
      )
      ids[key] = rows[0].id
    }
  })
  before.hash = await tableHash(db, 'offboarding_checklists')
  before.originalColumns = (await db.query<{ h: string }>(ORIGINAL_COLUMNS_HASH)).rows[0].h
  before.restoreDef = await restoreBackupDef()
  await applyMigration(db, M024)
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe.skipIf(isStaging)('024: mapping existing checklists', () => {
  it('maps each legacy combination conservatively', async () => {
    const { rows } = await db.query<{ id: string; laptop_outcome: string | null; outcome_needs_review: boolean }>(
      `select id, laptop_outcome, outcome_needs_review from offboarding_checklists`,
    )
    const byKey = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, rows.find((r) => r.id === id)!]))
    expect(byKey.none).toMatchObject({ laptop_outcome: null, outcome_needs_review: false })
    expect(byKey.accessOnly).toMatchObject({ laptop_outcome: null, outcome_needs_review: false })
    expect(byKey.received).toMatchObject({ laptop_outcome: 'received', outcome_needs_review: false })
    expect(byKey.retained).toMatchObject({ laptop_outcome: 'retained', outcome_needs_review: false })
    expect(byKey.decommissioned).toMatchObject({ laptop_outcome: 'decommissioned', outcome_needs_review: false })
    // Conflicts are never resolved silently.
    expect(byKey.conflictTwo).toMatchObject({ laptop_outcome: null, outcome_needs_review: true })
    expect(byKey.conflictAll).toMatchObject({ laptop_outcome: null, outcome_needs_review: true })
  })

  it('leaves every original column — including updated_at — untouched', async () => {
    // Every pre-024 column of every row, compared with the fingerprint
    // taken before the migration ran.
    const { rows } = await db.query<{ h: string }>(ORIGINAL_COLUMNS_HASH)
    expect(rows[0].h).toBe(before.originalColumns)
    const { rows: ts } = await db.query<{ n: number }>(
      `select count(*)::int as n from offboarding_checklists where updated_at <> '2026-10-01T12:00:00.123456Z'`,
    )
    expect(ts[0].n).toBe(0)
  })
})

describe.skipIf(isStaging)('024: choosing an outcome (as the admin, through RLS)', () => {
  async function row(id: string) {
    const { rows } = await db.query(
      `select laptop_outcome, outcome_needs_review, laptop_received, laptop_retained, laptop_decommissioned, removed_access
       from offboarding_checklists where id = $1`,
      [id],
    )
    return rows[0]
  }

  it('one outcome at a time: the legacy flags follow it', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set laptop_outcome = 'retained' where id = $1`, [ids.received])
      expect(await row(ids.received)).toMatchObject({
        laptop_outcome: 'retained',
        laptop_received: false,
        laptop_retained: true,
        laptop_decommissioned: false,
      })
    })
  })

  it('Not applicable clears all three legacy flags', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set laptop_outcome = 'not_applicable' where id = $1`, [ids.decommissioned])
      expect(await row(ids.decommissioned)).toMatchObject({
        laptop_outcome: 'not_applicable',
        laptop_received: false,
        laptop_retained: false,
        laptop_decommissioned: false,
      })
    })
  })

  it('choosing an outcome resolves a flagged conflict', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set laptop_outcome = 'received' where id = $1`, [ids.conflictAll])
      expect(await row(ids.conflictAll)).toMatchObject({
        laptop_outcome: 'received',
        outcome_needs_review: false,
        laptop_received: true,
        laptop_retained: false,
        laptop_decommissioned: false,
      })
    })
  })

  it('ticking Removed access never changes the laptop outcome', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set removed_access = false where id = $1`, [ids.received])
      expect(await row(ids.received)).toMatchObject({ laptop_outcome: 'received', laptop_received: true, removed_access: false })
    })
  })

  it('a write through the old flags (older app build) still derives a consistent outcome', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set laptop_received = true where id = $1`, [ids.none])
      expect(await row(ids.none)).toMatchObject({ laptop_outcome: 'received', outcome_needs_review: false })
      await db.query(`update offboarding_checklists set laptop_retained = true where id = $1`, [ids.none])
      expect(await row(ids.none)).toMatchObject({ laptop_outcome: null, outcome_needs_review: true })
    })
  })

  it('choosing an outcome changes no equipment record', async () => {
    await inRolledBackTx(db, async () => {
      const assetHashes = async () => {
        await actAsDatabase(db)
        const h: string[] = []
        for (const t of ['serialized_assets', 'active_laptops_np', 'serialized_asset_history', 'active_laptops_np_history']) {
          h.push(await tableHash(db, t))
        }
        return h
      }
      const pre = await assetHashes()
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set laptop_outcome = 'decommissioned' where id = $1`, [ids.none])
      expect(await assetHashes()).toEqual(pre)
    })
  })

  it('viewers cannot change the outcome', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, VIEWER)
      const r = await db.query(`update offboarding_checklists set laptop_outcome = 'received' where id = $1`, [ids.none])
      expect(r.rowCount).toBe(0)
    })
  })

  it('rejects values that are not a valid outcome', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      expect(await errorOf(db, `update offboarding_checklists set laptop_outcome = 'lost' where id = $1`, [ids.none])).toMatch(
        /invalid input value for enum/,
      )
    })
  })
})

describe.skipIf(isStaging)('024: backup and restore', () => {
  async function exportPayload() {
    const payload: Record<string, unknown> = {}
    for (const t of ['offboarding_checklists', 'onboarding_checklists', 'import_events', 'serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items']) {
      const { rows } = await db.query<{ rows: unknown }>(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from ${t} t`)
      payload[t] = rows[0].rows
    }
    return payload
  }

  it('a new backup round-trips outcomes, Not applicable and review flags exactly', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      await db.query(`update offboarding_checklists set laptop_outcome = 'not_applicable' where id = $1`, [ids.accessOnly])
      const hash = await tableHash(db, 'offboarding_checklists')
      const payload = await exportPayload()
      await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(payload)])
      expect(await tableHash(db, 'offboarding_checklists')).toBe(hash)
    })
  })

  it('a backup from before 024 restores with outcomes derived from the old flags', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ADMIN)
      const payload = await exportPayload()
      payload.offboarding_checklists = (payload.offboarding_checklists as Record<string, unknown>[]).map(
        ({ laptop_outcome: _o, outcome_needs_review: _r, ...legacy }) => legacy,
      )
      await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(payload)])
      const { rows } = await db.query<{ id: string; laptop_outcome: string | null; outcome_needs_review: boolean }>(
        `select id, laptop_outcome, outcome_needs_review from offboarding_checklists`,
      )
      const get = (k: string) => rows.find((r) => r.id === ids[k])!
      expect(get('received').laptop_outcome).toBe('received')
      expect(get('conflictTwo')).toMatchObject({ laptop_outcome: null, outcome_needs_review: true })
      expect(get('none')).toMatchObject({ laptop_outcome: null, outcome_needs_review: false })
    })
  })
})

describe.skipIf(isStaging)('024: rollback', () => {
  it('the rollback removes 024 exactly and keeps the legacy data', async () => {
    await applyRollback(db, '20260901000024_down.sql')
    expect(await tableHash(db, 'offboarding_checklists')).toBe(before.hash)
    expect(await restoreBackupDef()).toBe(before.restoreDef)
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns where table_name = 'offboarding_checklists' and column_name in ('laptop_outcome', 'outcome_needs_review')`,
    )
    expect(rows[0].n).toBe(0)
  })

  it('024 re-applies cleanly after the rollback', async () => {
    await applyMigration(db, M024)
    const { rows } = await db.query<{ laptop_outcome: string | null }>(
      `select laptop_outcome from offboarding_checklists where id = $1`,
      [ids.retained],
    )
    expect(rows[0].laptop_outcome).toBe('retained')
  })
})
